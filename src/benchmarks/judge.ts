import { readFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { extractJson } from "../ai/json-extract.ts";
import { parseClaudeOutput } from "../ai/result-parser.ts";
import { getLog } from "../logging.ts";
import { Tracer } from "../tracing/index.ts";
import type { BenchmarkManifest, JudgeResult, JudgeStats, GoldClaim } from "./types.ts";

const log = getLog("benchmarks", "judge");

/**
 * Parse YAML frontmatter from the top of a markdown file. Returns an object
 * keyed by frontmatter field, or an empty object if no frontmatter is present.
 *
 * Used to pull `analysis_trace_id` from candidate reports so the benchmark
 * can link a run back to the original muninn analysis trace.
 */
export function parseReportFrontmatter(text: string): Record<string, unknown> {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match || !match[1]) return {};
  try {
    const parsed = parseYaml(match[1]) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// Alias — resolves to whatever the current Sonnet 4.6 snapshot is.
// Phase 0.3 captures the actual snapshot from the response so we can
// pin properly for reproducibility in Phase 1+.
export const JUDGE_MODEL_DEFAULT = "claude-sonnet-4-6";
export const JUDGE_TIMEOUT_MS = 600_000; // 10 min — judge inputs are large and Sonnet is producing structured output

export interface RunJudgeOptions {
  manifest: BenchmarkManifest;
  candidatePath: string;
  judgePromptPath: string;
  /** Override the default Sonnet snapshot if needed */
  model?: string;
  /** Timeout for the underlying CLI call */
  timeoutMs?: number;
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
  const tracer = new Tracer("benchmark_judge", { botName: "benchmarks" });
  const traceId = tracer.traceId;

  tracer.start("claude-cli-call", {
    issueKey: manifest.issueKey,
    candidatePath,
    goldPath: manifest.gold.path,
    judgeModel: model,
    judgePromptVersion,
    promptChars: fullPrompt.length,
  });

  const startedAt = Date.now();
  let stdoutText: string;
  try {
    stdoutText = await spawnSonnet(fullPrompt, model, timeoutMs);
  } catch (err) {
    tracer.end("claude-cli-call", { status: "error", error: err instanceof Error ? err.message : String(err) });
    tracer.error(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
  const wallclockMs = Date.now() - startedAt;

  // Parse the Claude CLI envelope via muninn's canonical parser. This sums
  // usage.input_tokens + cache_creation + cache_read (so cached prompt content
  // is counted correctly) and extracts the resolved model snapshot from
  // modelUsage keys — both of which my original bespoke parser got wrong
  // (input tokens reported as 3, model reported as the alias).
  let cliResult: ReturnType<typeof parseClaudeOutput>;
  try {
    cliResult = parseClaudeOutput(stdoutText);
  } catch (err) {
    tracer.end("claude-cli-call", { status: "error", error: err instanceof Error ? err.message : String(err) });
    tracer.error(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }

  const inputTokens = cliResult.inputTokens;
  const outputTokens = cliResult.outputTokens;
  // Prefer the resolved snapshot from the envelope over the alias we passed in
  const resolvedModel = cliResult.model !== "unknown" ? cliResult.model : model;

  // The model's response is itself JSON (the judge result)
  let result: JudgeResult;
  try {
    const judgeResultRaw = extractJson<unknown>(cliResult.result);
    result = normaliseJudgeResult(judgeResultRaw);
  } catch (err) {
    // Dump the raw CLI stdout and the parsed result field so Bug 8 can be
    // diagnosed on the next occurrence without re-spending tokens. See
    // benchmarks/known-bugs.md Bug 8.
    const debugDir = `/tmp/benchmark-judge-debug-${Date.now()}`;
    mkdirSync(debugDir, { recursive: true });
    writeFileSync(`${debugDir}/raw-stdout.json`, stdoutText);
    writeFileSync(`${debugDir}/parsed-result-field.txt`, cliResult.result ?? "<null>");
    writeFileSync(`${debugDir}/error.txt`, err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
    log.error("Judge parse failure — debug dump written to {dir}", {
      botName: "benchmarks",
      dir: debugDir,
      stdoutLength: stdoutText.length,
      resultFieldLength: cliResult.result?.length ?? 0,
    });
    tracer.end("claude-cli-call", { status: "error", error: err instanceof Error ? err.message : String(err) });
    tracer.error(err instanceof Error ? err : new Error(String(err)));
    throw err;
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

async function spawnSonnet(
  prompt: string,
  model: string,
  timeoutMs: number,
): Promise<string> {
  // Run from /tmp so Claude CLI doesn't auto-discover muninn's .mcp.json
  // and waste startup time loading MCP servers we don't need for judging.
  const proc = Bun.spawn(
    ["claude", "-p", prompt, "--output-format", "json", "--model", model],
    {
      cwd: "/tmp",
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "benchmark-judge" },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    },
  );

  const stdoutPromise = new Response(proc.stdout).text().catch(() => "");
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

  try {
    const exitCode = await Promise.race([proc.exited, timeoutPromise]);
    if (exitCode !== 0) {
      const stderr = await stderrPromise;
      throw new Error(`claude exited with code ${exitCode}: ${stderr.slice(0, 500)}`);
    }
  } finally {
    clearTimeout(timeoutTimer!);
  }

  return await stdoutPromise;
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
