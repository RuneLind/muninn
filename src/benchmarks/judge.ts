import { readFile } from "node:fs/promises";
import { mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";
import { extractJson } from "../ai/json-extract.ts";
import { parseClaudeOutput } from "../ai/result-parser.ts";
import { StreamParser, type StreamProgressCallback } from "../ai/stream-parser.ts";
import { getLog } from "../logging.ts";
import { Tracer } from "../tracing/index.ts";
import type { TraceContext } from "../tracing/tracer.ts";
import type { ClaudeResult } from "../types.ts";
import type { BenchmarkManifest, JudgeResult, JudgeStats, GoldClaim } from "./types.ts";

const log = getLog("benchmarks", "judge");

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n?/;

/**
 * Parse YAML frontmatter from the top of a markdown file. Returns an object
 * keyed by frontmatter field, or an empty object if no frontmatter is present.
 *
 * Used to pull `analysis_trace_id` from candidate reports so the benchmark
 * can link a run back to the original muninn analysis trace.
 */
export function parseReportFrontmatter(text: string): Record<string, unknown> {
  const match = text.match(FRONTMATTER_REGEX);
  if (!match || !match[1]) return {};
  try {
    const parsed = parseYaml(match[1]) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function stripReportFrontmatter(text: string): string {
  return text.replace(FRONTMATTER_REGEX, "");
}

// Alias — resolves to whatever the current Sonnet 4.6 snapshot is.
// Phase 0.3 captures the actual snapshot from the response so we can
// pin properly for reproducibility in Phase 1+.
export const JUDGE_MODEL_DEFAULT = "claude-sonnet-4-6";
export const JUDGE_TIMEOUT_MS = 1_800_000; // 30 min — raised from 900s after multiple claude-sdk runs on MELOSYS-7588 hit the cap (one prior copilot-sdk run already brushed 876s, so 900s was operating without headroom)

/**
 * Find the highest-versioned judge prompt in benchmarks/judge-prompts/.
 * Shared between the score-report CLI, the re-judge helper, and any future
 * caller that needs "the current judge prompt". Throws if the directory is
 * empty or missing — callers should catch and fall back or surface to the UI.
 */
export function findHighestJudgePromptVersion(
  dir: string = "benchmarks/judge-prompts",
): string {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch (err) {
    throw new Error(
      `Judge prompt directory unreadable (${dir}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const candidates = files
    .filter((f) => /^v\d+\.md$/.test(f))
    .sort((a, b) => {
      const va = parseInt(a.match(/^v(\d+)/)?.[1] ?? "0", 10);
      const vb = parseInt(b.match(/^v(\d+)/)?.[1] ?? "0", 10);
      return vb - va;
    });
  const top = candidates[0];
  if (!top) throw new Error(`No judge prompts (vN.md) found in ${dir}`);
  return resolvePath(dir, top);
}

export interface RunJudgeOptions {
  manifest: BenchmarkManifest;
  candidatePath: string;
  judgePromptPath: string;
  /** Override the default Sonnet snapshot if needed */
  model?: string;
  /** Timeout for the underlying CLI call */
  timeoutMs?: number;
  /**
   * Optional stream progress callback. Receives `text_delta` events as the
   * judge generates its JSON, plus `tool_start`/`tool_end` (the judge has no
   * MCP tools so these never fire today, but the type is kept aligned with
   * the main stream parser). Use this from the score-report CLI to show
   * live progress on stderr; leave undefined to run silently.
   */
  onProgress?: StreamProgressCallback;
  /**
   * When set, the judge's `benchmark_judge` span attaches as a child of the
   * provided trace+parent instead of starting its own root trace. Used by
   * the cell runner so the live-page waterfall shows judge spans inline with
   * the analysis. Leave undefined to keep the historical standalone-trace
   * behaviour (used by the rejudge flow and the score-report CLI).
   */
  parentTrace?: TraceContext;
}

export interface RunJudgeResult {
  result: JudgeResult;
  inputTokens: number;
  outputTokens: number;
  wallclockMs: number;
  goldContentHash: string;
  judgeModel: string;
  judgePromptVersion: string;
  /** Trace ID of the judge call itself */
  traceId: string;
  /** Trace ID of the original analysis (parsed from report frontmatter, may be null for historical reports) */
  analysisTraceId: string | null;
}

/**
 * Run the judge on one (manifest, candidate) pair.
 *
 * Spawns Claude CLI with the configured Sonnet snapshot. The CLI inherits
 * auth from the user's existing claude session — no API key plumbing.
 * Output is JSON via --output-format json.
 */
export async function runJudge(opts: RunJudgeOptions): Promise<RunJudgeResult> {
  const { manifest, candidatePath, judgePromptPath } = opts;
  const model = opts.model ?? JUDGE_MODEL_DEFAULT;
  const timeoutMs = opts.timeoutMs ?? JUDGE_TIMEOUT_MS;

  const [judgePromptText, goldText, candidateText] = await Promise.all([
    readFile(judgePromptPath, "utf8"),
    readFile(manifest.gold.path, "utf8"),
    readFile(candidatePath, "utf8"),
  ]);

  const goldContentHash = createHash("sha256").update(goldText).digest("hex").slice(0, 16);
  const judgePromptVersion = extractJudgePromptVersion(judgePromptPath, judgePromptText);

  // Look for analysis_trace_id in the candidate's YAML frontmatter — present
  // for reports written by the muninn report writer after this feature shipped,
  // null for older historical reports.
  const candidateFrontmatter = parseReportFrontmatter(candidateText);
  const analysisTraceId =
    typeof candidateFrontmatter.analysis_trace_id === "string"
      ? candidateFrontmatter.analysis_trace_id
      : null;

  // Highlighted claims from the manifest are injected into the prompt as a
  // canonical list — the judge uses these as pre-populated highlighted items
  // rather than re-deciding what's highlighted.
  const highlightedSection = formatHighlightedClaims(manifest);

  const fullPrompt = [
    judgePromptText.trim(),
    "",
    "## Manifest — pre-populated highlighted claims",
    "",
    highlightedSection,
    "",
    "## Gold (reviewed analysis)",
    "",
    "```markdown",
    goldText.trim(),
    "```",
    "",
    "## Candidate (first-pass analysis to score)",
    "",
    "```markdown",
    candidateText.trim(),
    "```",
    "",
    "Now produce the JSON output. Remember: ONLY JSON, no prose, no code fence.",
  ].join("\n");

  log.info("Running judge for {issueKey} on {candidate}", {
    botName: "benchmarks",
    issueKey: manifest.issueKey,
    candidate: candidatePath,
    model,
    promptChars: fullPrompt.length,
  });

  // Wrap the whole judge call in a Tracer span so it shows up in the
  // existing traces dashboard alongside every other AI call in muninn.
  // When parentTrace is supplied, attach as a child of that trace (so the
  // cell runner's live waterfall shows judge spans inline with analysis).
  // Otherwise start a fresh root trace as before (rejudge / CLI score-report).
  const tracer = new Tracer("benchmark_judge", {
    botName: "benchmarks",
    ...(opts.parentTrace
      ? { traceId: opts.parentTrace.traceId, parentId: opts.parentTrace.parentId }
      : {}),
  });
  const traceId = tracer.traceId;

  tracer.start("claude-cli-call", {
    issueKey: manifest.issueKey,
    candidatePath,
    goldPath: manifest.gold.path,
    judgeModel: model,
    judgePromptVersion,
    promptChars: fullPrompt.length,
  });

  // Wrap the caller's onProgress so we emit tracer events as the judge text
  // streams in. Sampled (every ~500 chars) so a long judge response doesn't
  // produce thousands of point-in-time events. Lets the trace detail page
  // visualise progression even when the live-page subprocess log isn't
  // available (e.g. for rejudge runs).
  let streamedChars = 0;
  let lastEventChars = 0;
  const TRACE_EVENT_EVERY_CHARS = 500;
  const wrappedOnProgress: StreamProgressCallback = (ev) => {
    if (ev.type === "text_delta" && ev.text) {
      streamedChars += ev.text.length;
      if (streamedChars - lastEventChars >= TRACE_EVENT_EVERY_CHARS) {
        tracer.event("judge_text", { chars: streamedChars });
        lastEventChars = streamedChars;
      }
    }
    opts.onProgress?.(ev);
  };

  const startedAt = Date.now();

  type AttemptOk = {
    ok: true;
    stdoutText: string;
    cliResult: ClaudeResult;
    result: JudgeResult;
  };
  type AttemptFail = {
    ok: false;
    error: Error;
    stdoutText?: string;
    cliResult?: ClaudeResult;
  };

  const runOneJudgeAttempt = async (): Promise<AttemptOk | AttemptFail> => {
    let stdoutText: string;
    let cliResult: ClaudeResult;
    try {
      const out = await spawnSonnetStreaming(fullPrompt, model, timeoutMs, wrappedOnProgress);
      stdoutText = out.stdoutText;
      cliResult = out.cliResult;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
    }
    try {
      const judgeResultRaw = extractJson<unknown>(cliResult.result);
      const result = normaliseJudgeResult(judgeResultRaw);
      return { ok: true, stdoutText, cliResult, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err : new Error(String(err)), stdoutText, cliResult };
    }
  };

  // Bug 8 — Claude CLI truncates the envelope `result` field to just the tail
  // of long JSON responses. Sonnet at temp=0 still varies across prompt-cache
  // states, so a retry usually produces a parseable response. Skip the retry
  // on spawn-side timeouts: a stuck CLI doubles wall time for no benefit.
  const attempt = await (async (): Promise<AttemptOk> => {
    const first = await runOneJudgeAttempt();
    if (first.ok) return first;
    if (first.error.message.startsWith("Judge timed out")) {
      tracer.end("claude-cli-call", { status: "error", error: first.error.message });
      tracer.error(first.error);
      throw first.error;
    }
    log.warn("Judge attempt 1 failed, retrying once: {error}", {
      botName: "benchmarks",
      error: first.error.message,
    });
    const second = await runOneJudgeAttempt();
    if (second.ok) return second;
    const debugDir = `/tmp/benchmark-judge-debug-${Date.now()}`;
    mkdirSync(debugDir, { recursive: true });
    if (second.stdoutText) writeFileSync(`${debugDir}/raw-stdout.json`, second.stdoutText);
    if (second.cliResult) writeFileSync(`${debugDir}/parsed-result-field.txt`, second.cliResult.result ?? "<null>");
    writeFileSync(
      `${debugDir}/error.txt`,
      `attempt 1: ${first.error.message}\n\nattempt 2: ${second.error.message}\n${second.error.stack ?? ""}`,
    );
    log.error("Judge failed on both attempts — debug dump written to {dir}", {
      botName: "benchmarks",
      dir: debugDir,
    });
    tracer.end("claude-cli-call", { status: "error", error: second.error.message });
    tracer.error(second.error);
    throw second.error;
  })();
  const { cliResult, result } = attempt;
  const wallclockMs = Date.now() - startedAt;

  const inputTokens = cliResult.inputTokens;
  const outputTokens = cliResult.outputTokens;
  // Prefer the resolved snapshot from the envelope over the alias we passed in
  const resolvedModel = cliResult.model !== "unknown" ? cliResult.model : model;

  // Final flush so the chars-streamed timeline includes the tail beyond the
  // last sampled event.
  if (streamedChars > lastEventChars) {
    tracer.event("judge_text", { chars: streamedChars, final: true });
  }

  tracer.end("claude-cli-call", {
    inputTokens,
    outputTokens,
    wallclockMs,
    totalClaims: result.stats.totalClaims,
    resolvedModel,
  });

  tracer.finish("ok", {
    issueKey: manifest.issueKey,
    judgeModel: resolvedModel,
    judgePromptVersion,
    hitRate: result.stats.hitRate,
    highlightedRate: result.stats.highlightedRate,
    found: result.stats.found,
    partial: result.stats.partial,
    missing: result.stats.missing,
    inputTokens,
    outputTokens,
    wallclockMs,
  });

  log.info("Judge complete for {issueKey}: {hitRate}% hit rate ({found}/{total})", {
    botName: "benchmarks",
    issueKey: manifest.issueKey,
    hitRate: Math.round(result.stats.hitRate * 100),
    found: result.stats.found,
    total: result.stats.totalClaims,
    wallclockMs,
    inputTokens,
    outputTokens,
    traceId,
    resolvedModel,
  });

  return {
    result,
    inputTokens,
    outputTokens,
    wallclockMs,
    goldContentHash,
    judgeModel: resolvedModel,
    judgePromptVersion,
    traceId,
    analysisTraceId,
  };
}

interface SpawnSonnetResult {
  /** Raw NDJSON stdout joined with newlines — kept for debug dumps on parse failure. */
  stdoutText: string;
  /** Parsed envelope (text + tokens + cost + model). */
  cliResult: ClaudeResult;
}

/**
 * Spawn Claude CLI in stream-json mode and parse output line-by-line so the
 * caller can observe progress in real time via `onProgress`.
 *
 * Mirrors the executor.ts pattern: StreamParser is the primary path; if the
 * CLI somehow doesn't emit a final result event, fall back to the legacy
 * single-envelope parser on the joined raw lines (rarely hit, kept for parity
 * with the main bot path).
 */
async function spawnSonnetStreaming(
  prompt: string,
  model: string,
  timeoutMs: number,
  onProgress?: StreamProgressCallback,
): Promise<SpawnSonnetResult> {
  // Run from /tmp so Claude CLI doesn't auto-discover muninn's .mcp.json
  // and waste startup time loading MCP servers we don't need for judging.
  const proc = Bun.spawn(
    [
      "claude",
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model", model,
      "--", prompt,
    ],
    {
      cwd: "/tmp",
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "benchmark-judge" },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    },
  );

  const stderrPromise = new Response(proc.stderr).text().catch(() => "");

  let timeoutTimer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => {
      log.error("Judge process timed out after {timeoutMs}ms — killing PID {pid}", {
        botName: "benchmarks",
        timeoutMs,
        pid: proc.pid,
      });
      proc.kill();
      reject(new Error(`Judge timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  const refTimestamp = performance.now();
  const parser = new StreamParser(refTimestamp, onProgress);
  const rawLines: string[] = [];

  const drainPromise = (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.trim()) {
            rawLines.push(line);
            try { parser.parseLine(line, performance.now()); } catch { /* keep raw line for fallback */ }
          }
        }
      }
      if (buffer.trim()) {
        rawLines.push(buffer);
        try { parser.parseLine(buffer, performance.now()); } catch { /* keep raw line for fallback */ }
      }
    } finally {
      reader.releaseLock();
    }
  })();

  try {
    // Race drain against the timeout so a stuck CLI doesn't hang here forever.
    // When the timeout fires it kills the proc, which closes stdout, which
    // lets drainPromise resolve too — but the rejection from timeoutPromise
    // wins the race and surfaces as the error.
    await Promise.race([drainPromise, timeoutPromise]);
    const exitCode = await Promise.race([proc.exited, timeoutPromise]);
    if (exitCode !== 0) {
      const stderr = await stderrPromise;
      throw new Error(`claude exited with code ${exitCode}: ${stderr.slice(0, 500)}`);
    }
  } finally {
    clearTimeout(timeoutTimer!);
  }

  const stdoutText = rawLines.join("\n");
  if (parser.complete) {
    return { stdoutText, cliResult: parser.getResult() };
  }
  // Fallback: stream parser didn't see a result event — try the legacy
  // envelope parser on the joined output. This matches executor.ts's
  // recovery path for the known CLI bug where the result event is missed.
  log.warn("Judge stream parser missed result event, falling back ({lineCount} lines)", {
    botName: "benchmarks",
    lineCount: rawLines.length,
  });
  return { stdoutText, cliResult: parseClaudeOutput(stdoutText) };
}

function formatHighlightedClaims(manifest: BenchmarkManifest): string {
  if (manifest.highlightedClaims.length === 0) {
    return "(none — judge should not produce any highlighted claims)";
  }
  return manifest.highlightedClaims
    .map((c) => `- **${c.id}** (highlighted: true): ${c.claim.trim()}`)
    .join("\n");
}

function extractJudgePromptVersion(path: string, text: string): string {
  // First try: filename like "v0.md" or "v1.md"
  const filenameMatch = path.match(/v(\d+)\.md$/);
  if (filenameMatch && filenameMatch[1]) return `v${filenameMatch[1]}`;
  // Fallback: header like "# ... — Judge Prompt v0"
  const headerMatch = text.match(/Judge Prompt (v\d+)/);
  if (headerMatch && headerMatch[1]) return headerMatch[1];
  return "unknown";
}

/**
 * Normalise the raw judge JSON into our typed shape. The judge produces
 * snake_case keys per the prompt; we convert to camelCase and validate.
 */
function normaliseJudgeResult(raw: unknown): JudgeResult {
  if (!raw || typeof raw !== "object") {
    throw new Error("Judge result is not an object");
  }
  const r = raw as { gold_claims?: unknown[]; stats?: Record<string, number> };

  if (!Array.isArray(r.gold_claims)) {
    throw new Error("Judge result missing gold_claims array");
  }

  const goldClaims: GoldClaim[] = r.gold_claims.map((c, idx) => {
    const obj = c as Record<string, unknown>;
    const verdict = obj.verdict as string;
    if (verdict !== "found" && verdict !== "partial" && verdict !== "missing") {
      throw new Error(`Judge claim ${idx} has invalid verdict: ${verdict}`);
    }
    return {
      id: String(obj.id ?? `claim_${String(idx + 1).padStart(3, "0")}`),
      claim: String(obj.claim ?? ""),
      section: typeof obj.section === "string" ? obj.section : null,
      highlighted: Boolean(obj.highlighted),
      verdict,
      evidenceQuote: typeof obj.evidence_quote === "string" ? obj.evidence_quote : null,
      notes: typeof obj.notes === "string" ? obj.notes : null,
    };
  });

  // Recompute stats from goldClaims rather than trusting the judge's arithmetic
  const stats = computeStats(goldClaims);
  return { goldClaims, stats };
}

function computeStats(claims: GoldClaim[]): JudgeStats {
  let found = 0;
  let partial = 0;
  let missing = 0;
  let hFound = 0;
  let hPartial = 0;
  let hMissing = 0;

  for (const c of claims) {
    if (c.verdict === "found") found++;
    else if (c.verdict === "partial") partial++;
    else missing++;
    if (c.highlighted) {
      if (c.verdict === "found") hFound++;
      else if (c.verdict === "partial") hPartial++;
      else hMissing++;
    }
  }

  const total = claims.length;
  const hTotal = hFound + hPartial + hMissing;
  const hitRate = total === 0 ? 0 : (found + 0.5 * partial) / total;
  const highlightedRate = hTotal === 0 ? 0 : (hFound + 0.5 * hPartial) / hTotal;

  return {
    totalClaims: total,
    found,
    partial,
    missing,
    highlightedTotal: hTotal,
    highlightedFound: hFound,
    highlightedPartial: hPartial,
    highlightedMissing: hMissing,
    hitRate,
    highlightedRate,
  };
}
