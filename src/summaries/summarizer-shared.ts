import { getLog } from "../logging.ts";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { ClaudeExecResult } from "../ai/executor.ts";
import type { StreamProgressCallback } from "../ai/stream-parser.ts";
import { executeOneShot, connectorCapabilities } from "../ai/one-shot.ts";
import { Tracer } from "../tracing/tracer.ts";
import { tracedOneShot } from "../core/traced-one-shot.ts";
import { getConnectorLabel } from "../observability/agent-status.ts";
import type { RunMeta, SimilarArticle } from "./job-store.ts";
import { groundTakeaway, splitClosingTakeaway, type GroundTakeawayOptions } from "./takeaway-check.ts";

const log = getLog("summaries", "ingest");
const captureLog = getLog("summaries", "capture");

/**
 * Thinking budget for a capture summarization.
 *
 * A capture job inherits its bot's CHAT thinking budget (jarvis: 40k), which on
 * a batch transform is spent as silent dead-air before the first streamed token.
 * Measured against a real 2.3k-word YouTube transcript on jarvis/claude-sdk:
 *
 *   40k thinking → 9.5s to first token, 23.8s total
 *    8k thinking → 2.5s to first token, 17.2s total
 *    0  thinking → 2.5s to first token, 17.4s total
 *
 * 8k is the knee: it buys back the dead-air (identical to disabling thinking
 * outright) while leaving headroom for a messy transcript — and it matches the
 * cap the gardener already puts on its drafts.
 */
export const CAPTURE_THINKING_MAX_TOKENS = 8000;

/**
 * The floor every capture's summarize call is given, before the per-frame term
 * {@link summarizeTimeoutFor} adds on top of it.
 *
 * 600 s is what that function gives a 30-frame TikTok, and it is the right
 * floor for a transcript-only capture too: the whole input is one transcript,
 * and a 3-hour talk's is ~200 KB of text — large for a prompt, but nothing like
 * multi-turn image reading. It bounds a background job nothing waits on.
 *
 * ONE constant, in the seam both video verticals already import: Vimeo and
 * YouTube each declared their own `600_000` with the same paragraph over it,
 * which is exactly the two-literals shape `src/video/media.ts` documents for the
 * frame budget — where a raised ceiling stayed inert behind the second copy.
 */
export const CAPTURE_SUMMARIZE_TIMEOUT_FLOOR_MS = 600_000;

/**
 * The rider a capture adds when its transcript came back WINDOWED — huginn's
 * `### [HH:MM:SS]`-headed buckets, the shape both video verticals ingest.
 *
 * A slide can only be placed beside its passage if the model knows the headings
 * are positions rather than speech. The two verticals carried the same sentence
 * twice, differing in one noun; `noun` is that word ("talk" for a conference
 * recording, "video" for anything else), and nothing else about the sentence is
 * per-vertical.
 */
export function windowedTranscriptRider(noun: "talk" | "video"): string {
  return (
    "The transcript is grouped into windows, each opened by a `### [HH:MM:SS]` heading " +
    `carrying its absolute position in the ${noun}; those headings are positions, not content — ` +
    "never quote one as if it were speech."
  );
}

export interface CaptureOneShotOptions {
  /** Vertical id — names the trace root span, e.g. `capture:youtube`. */
  source: string;
  jobId: string;
  /** Job subject — stamped on the trace so `/traces` rows are readable. */
  title: string;
  url: string;
  prompt: string;
  systemPrompt: string;
  config: Config;
  botConfig: BotConfig;
  /** The vertical's job-store `attachRun` — late-binds telemetry onto the run. */
  attachRun: (jobId: string, meta: RunMeta) => void;
  onProgress?: StreamProgressCallback;
  timeoutMs?: number;
  extraDirs?: string[];
  /**
   * Thinking budget. Defaults to {@link CAPTURE_THINKING_MAX_TOKENS}; pass
   * `null` to inherit the bot's own budget (TikTok does — its multi-turn frame
   * reading is genuine visual reasoning, and as a ~10-min background job it has
   * no first-token latency to protect).
   */
  thinkingMaxTokens?: number | null;
  /**
   * Extra string attributes stamped onto the `claude` span (alongside model /
   * tokens), for vertical-specific observability — e.g. the X path records its
   * link-enrichment outcome (`enrichment: youtube|article|none|failed`). Other
   * verticals pass nothing and are unaffected.
   */
  extraTraceAttrs?: Record<string, string>;
  /**
   * The label of the model span this call opens. Defaults to `claude`, which is
   * the label every read-side fast path keys off — `/models`' observed-model
   * query and `src/db/traces.ts` both join on `c.name = 'claude'` — so a caller
   * that makes TWO calls under one root labels only the SECONDARY one
   * (`claude:select`) and leaves the summary call as `claude`. Two spans sharing
   * a label would also clobber each other: `Tracer` keys its spans by label.
   */
  pass?: string;
  /**
   * The closing-takeaway grounding check (`takeaway-check.ts`), on by default:
   * after the model call, the closer is checked against the text above it and
   * rewritten when it asserts what the body does not. It runs where the
   * result carries a `> 💬 **Takeaway:**` block, which is every summary pass
   * and never the YouTube selection pass. `false` skips it; a function
   * replaces the Haiku-router call (tests, the eval harness).
   */
  takeawayCheck?: boolean | GroundTakeawayOptions["call"];
  /**
   * A trace root the CALLER owns, for a job that makes more than one model call.
   *
   * With one set, this seam opens no root of its own and — the load-bearing half
   * — calls no `tracer.finish`: `Tracer.finish` has no idempotence guard, so a
   * root finished by both the seam and its caller is written twice, and the
   * second write is whichever finished last rather than whichever is true. The
   * caller then owns the root on EVERY exit path, success and failure alike.
   *
   * Passed ONLY on a genuinely multi-pass path. A frames-off capture, a
   * cadence capture and every other vertical stay single-pass and keep the
   * seam's own root — two trace-ownership paths, by design, because the
   * alternative is every single-pass caller growing a `finish` it cannot forget.
   */
  parentTracer?: Tracer;
  /**
   * Handed the in-flight prompt-snapshot write, synchronously, right after it
   * is started.
   *
   * The write is deliberately NOT awaited (see `saveCapturePromptSnapshot`), so
   * a test that reads the row straight after this function resolves would be
   * racing the insert. This is the only handle on it; production callers pass
   * nothing, and the promise never rejects — the writer catches and warns.
   */
  onSnapshotSettled?: (pending: Promise<void>) => void;
  /** Test seams — production callers pass neither. */
  oneShot?: typeof executeOneShot;
  tracer?: Tracer;
}

/**
 * The trace root a capture job runs under — the name and the attributes spelled
 * ONCE, so a two-pass caller that has to build its own root cannot build a
 * differently-shaped one than {@link runCaptureOneShot} would have.
 */
export function createCaptureTracer(source: string, botConfig: BotConfig): Tracer {
  return new Tracer(captureTraceName(source), {
    botName: botConfig.name,
    platform: "capture",
  });
}

/**
 * The trace-root NAME for a capture vertical. Its own function because a
 * `Tracer` does not expose the name it was built with, so this is the only
 * place the string is checkable — and it is what `/traces` rows are read by.
 */
export function captureTraceName(source: string): string {
  return `capture:${source}`;
}

/**
 * Run a capture vertical's model call with observability attached.
 *
 * The capture summarizers (youtube / x-article / tiktok / anthropic / article)
 * used to call `executeOneShot` bare: no `Tracer`, so a user-triggered summarize left
 * NOTHING on `/traces`, and its `/agents` row carried no bot, model, tokens or
 * trace link. This is the one seam they all route through, so a capture job now
 * traces like a chat turn does — a `capture:<source>` root with a `claude` child
 * span carrying model + tokens + cost, tool child spans underneath it (TikTok's
 * frame Reads), and the same telemetry mirrored onto the `/agents` card.
 *
 * Fail-soft by construction: the trace is stamped `error` and re-thrown, so the
 * caller's existing `failJob` path is unchanged.
 */
export async function runCaptureOneShot(opts: CaptureOneShotOptions): Promise<ClaudeExecResult> {
  const { source, jobId, title, url, config, botConfig, attachRun } = opts;

  // `parentTracer` first: a caller that owns the root has already opened it, and
  // the test seam (`tracer`) is the single-pass shape. Whether this seam FINISHES
  // the root is the same question, asked once here.
  const tracer = opts.parentTracer ?? opts.tracer ?? createCaptureTracer(source, botConfig);
  const ownsRoot = opts.parentTracer === undefined;

  const connectorLabel = getConnectorLabel(botConfig.connector ?? "claude-cli");
  // Bind what's already known so the *in-flight* card is truthful; the model
  // string is the configured one here and is overwritten below with what the
  // connector actually reported. The trace link is only offered when tracing is
  // on — a Tracer still mints a traceId with TRACING_ENABLED=false, and stamping
  // that would give the /agents card a "Trace" link to a trace nobody wrote.
  attachRun(jobId, {
    botName: botConfig.name,
    connectorLabel,
    ...(botConfig.model ? { model: botConfig.model } : {}),
    ...(config.tracingEnabled ? { traceId: tracer.traceId } : {}),
  });

  // Only cap thinking where the field IS a thinking budget: on openai-compat it
  // is the request's max_tokens, so overriding it would clamp the summary's
  // length instead (and there is no thinking dead-air there to buy back).
  const thinking = !connectorCapabilities(botConfig).supportsThinkingBudget
    ? null
    : opts.thinkingMaxTokens === undefined
      ? CAPTURE_THINKING_MAX_TOKENS
      : opts.thinkingMaxTokens;

  try {
    // The `claude` span (start/end + tool child spans) is owned by the shared
    // seam; this wrapper keeps only the capture-specific parts — the thinking cap
    // above, the job-store `attachRun` mirror, and the trace-root finish.
    const result = await tracedOneShot(tracer, opts.pass ?? "claude", opts.prompt, config, botConfig, {
      systemPrompt: opts.systemPrompt,
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.extraDirs ? { extraDirs: opts.extraDirs } : {}),
      ...(thinking !== null ? { thinkingMaxTokens: thinking } : {}),
      ...(opts.oneShot ? { oneShot: opts.oneShot } : {}),
      startAttrs: {
        source,
        title,
        url,
        ...(thinking !== null ? { thinkingMaxTokens: thinking } : {}),
        ...(opts.extraTraceAttrs ?? {}),
      },
    });

    // Started, never awaited — see `saveCapturePromptSnapshot`. The call is on
    // its OWN line rather than inside `opts.onSnapshotSettled?.(…)`: optional
    // CALL short-circuits its arguments, so the inline form would skip the
    // write entirely whenever the seam is absent, which is every production
    // caller.
    const snapshotWrite = saveCapturePromptSnapshot(tracer.traceId, opts);
    opts.onSnapshotSettled?.(snapshotWrite);

    const usage = {
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      numTurns: result.numTurns,
      toolCount: result.toolCalls?.length ?? 0,
      costUsd: result.costUsd,
    };

    attachRun(jobId, usage);

    // The closer check, a child span of the capture. It rewrites the RAW text
    // (the envelope parser runs after this in every vertical), so an
    // ungrounded closer never reaches the store, the ingest or the card. A
    // failed check keeps the text and stamps the outcome; it never fails the
    // capture. A result with no closer opens no span: the selection pass never
    // has one, so it is silent there, while the SUMMARY pass records the
    // absence as an event — a marker the model has drifted away from would
    // otherwise look, on /traces, exactly like a check that passed everywhere.
    // It runs AFTER the summary call and OUTSIDE the YouTube two-pass budget,
    // bounded by the router's own timeout (and its CLI fallback); the usage is
    // accumulated onto the run, since the run's spend fields are the whole job.
    let text = result.result;
    if (opts.takeawayCheck !== false && splitClosingTakeaway(text) === null) {
      if (opts.pass === undefined) tracer.event("claude:takeaway-check", { takeaway: "no-takeaway" });
    } else if (opts.takeawayCheck !== false) {
      const spanLabel = `${opts.pass ?? "claude"}:takeaway-check`;
      tracer.start(spanLabel, { source });
      const checked = await groundTakeaway(text, {
        botName: botConfig.name,
        connector: botConfig.connector,
        haikuBackend: botConfig.haikuBackend,
        tracer,
        entrypoint: `capture:${source}`,
        ...(typeof opts.takeawayCheck === "function" ? { call: opts.takeawayCheck } : {}),
      });
      tracer.end(spanLabel, {
        takeaway: checked.outcome,
        ...(checked.issues.length > 0 ? { takeawayIssues: checked.issues.join(" | ") } : {}),
        ...(checked.usage ?? {}),
      });
      // Spend only: the run's model/connector identity is the summary call's.
      if (checked.usage) attachRun(jobId, { inputTokens: checked.usage.inputTokens, outputTokens: checked.usage.outputTokens });
      if (checked.outcome === "rewritten" || checked.outcome === "removed") {
        captureLog.info("Capture {source} job {jobId}: closing takeaway {outcome} ({count} unsupported clause(s))", {
          outcome: checked.outcome,
          source,
          jobId,
          count: checked.issues.length,
        });
      }
      text = checked.text;
    }

    if (ownsRoot) tracer.finish("ok", { source, ...usage });

    return text === result.result ? result : { ...result, result: text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (ownsRoot) tracer.finish("error", { source, error: message });
    captureLog.warn("Capture summarize failed for {source} job {jobId}: {error}", {
      source,
      jobId,
      error: message,
    });
    throw err;
  }
}

/**
 * Store what this pass was actually sent, keyed on (trace, pass).
 *
 * AFTER the model call rather than before it, so a snapshot exists only for a
 * pass that ran — and per PASS, because a YouTube dense-scan capture runs this
 * seam twice under one trace root and the two prompts are different questions
 * (which frames to look at; how to summarize what came back).
 *
 * **NOT awaited by the caller.** The summary is already produced by the time
 * this runs; a Postgres that is slow, locked or gone must not hold a capture job
 * open behind a debugging artefact — every capture, on every pass. The chat
 * caller has always worked this way (`src/core/prompt-assembly.ts` calls
 * `savePromptSnapshot(…).catch(…)`), and the warn below is this path's version
 * of that `.catch`. `CaptureOneShotOptions.onSnapshotSettled` is how a TEST gets
 * hold of the in-flight promise; production callers pass nothing.
 *
 * Gated on tracing, because the row is keyed on a trace id: a `Tracer` mints one
 * even with `TRACING_ENABLED=false`, and a snapshot under an id no trace was
 * ever written for is unreachable from every reader that starts at `/traces`.
 * The by-url lookup would still find it, which is exactly the confusion — an
 * instance with tracing off would grow prompt rows nothing can place.
 *
 * Fail-soft, like the ingest below it: a capture that summarized correctly must
 * not fail because a debugging artefact could not be stored.
 *
 * The import is LAZY so this seam — which every vertical and most of their unit
 * tests load — does not pull `db/client.ts` and the postgres driver into its
 * import graph for the sake of one optional write.
 */
async function saveCapturePromptSnapshot(traceId: string, opts: CaptureOneShotOptions): Promise<void> {
  if (!opts.config.tracingEnabled) {
    log.debug("Tracing off — no prompt snapshot for {source} job {jobId}", {
      source: opts.source,
      jobId: opts.jobId,
    });
    return;
  }
  try {
    const { savePromptSnapshot } = await import("../db/prompt-snapshots.ts");
    await savePromptSnapshot({
      traceId,
      pass: opts.pass ?? "claude",
      systemPrompt: opts.systemPrompt,
      userPrompt: opts.prompt,
      kind: "capture",
      sourceUrl: opts.url,
    });
  } catch (err) {
    captureLog.warn("Prompt snapshot failed for {source} job {jobId}: {error}", {
      source: opts.source,
      jobId: opts.jobId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * `SUMMARY_STRUCTURE_BULLETS` lives in the dependency-free `summary-structure.ts`
 * leaf now (the capture presets interpolate it and must stay IO-free); it is
 * re-exported here because every vertical imports it by this path.
 */
export { SUMMARY_STRUCTURE_BULLETS } from "./summary-structure.ts";
import { SUMMARY_STRUCTURE_BULLETS } from "./summary-structure.ts";

/**
 * Build the shared CATEGORY:/SUMMARY: system-prompt scaffold used by the
 * youtube / x-article / anthropic / article summarizers. Only the intro sentence and the
 * category allowlist vary; the CATEGORY-line + blank-line + SUMMARY-line
 * contract is identical so the shared `parseSummaryResponse` parser works
 * unchanged. (TikTok's prompt is a bespoke multi-turn frame-reading variant
 * and doesn't use this — it interpolates {@link SUMMARY_STRUCTURE_BULLETS}
 * inline instead.)
 */
export function buildSummarySystemPrompt(
  intro: string,
  categories: readonly string[],
  /**
   * The structure bullets, one per line — a capture KIND's instruction
   * (`src/summaries/presets.ts`). Defaults to the shared rules, so every
   * vertical that has no kind picker is unchanged.
   */
  structure: string = SUMMARY_STRUCTURE_BULLETS.join("\n"),
): string {
  return `${intro}

Instructions:
1. Start your response with EXACTLY this line: CATEGORY: <category>
   Choose from: ${categories.join(", ")}
2. Then add a blank line, then SUMMARY: on its own line
3. Then write a structured summary with:
   ${structure.trim().split("\n").join("\n   ")}`;
}

/** How long an ingest of a body this size may take. */
const INGEST_TIMEOUT_FLOOR_MS = 15_000;
/** One extra second per this many bytes of body. */
const INGEST_TIMEOUT_BYTES_PER_SECOND = 64 * 1024;
/** The ceiling: past here the ingest is hung, not slow. */
const INGEST_TIMEOUT_MAX_MS = 120_000;

/**
 * The abort budget for one ingest POST, sized from the body it is posting.
 *
 * 15 s is a fine budget for the 6 KB summary this endpoint was written for and
 * a coin flip for the 2 MiB one a windowed `## Transcript` produces: huginn
 * writes the document and reindexes before it answers, and an abort that drops
 * the RESPONSE loses the stored doc id — the only place it ever appears, and
 * what the verticals' reindex-window dedup maps are keyed on. The document is
 * written either way, so the timeout does not undo the ingest; it just makes
 * this process forget that it happened.
 *
 * A rate, not a curve: one second per 64 KiB (a 2 MiB body gets 47 s), floored
 * at today's 15 s so every small caller is byte-identical, and capped at 120 s
 * because past that the far end is hung rather than slow.
 */
export function ingestTimeoutFor(bodyBytes: number): number {
  const bytes = Number.isFinite(bodyBytes) ? Math.max(0, bodyBytes) : 0;
  const scaled = INGEST_TIMEOUT_FLOOR_MS + Math.floor(bytes / INGEST_TIMEOUT_BYTES_PER_SECOND) * 1_000;
  return Math.min(INGEST_TIMEOUT_MAX_MS, scaled);
}

/**
 * Best-effort POST of a finished summary to a Huginn `<vertical>/ingest`
 * endpoint, shared by the youtube / x-article / tiktok / article summarizers. A failure
 * here never fails the job (the summary already streamed to the client) — it
 * logs a warn and skips the "similar" enrichment. On success, any returned
 * `similar` articles are handed back via `onSimilar`.
 *
 * (anthropic's ingest is intentionally NOT routed through this: it's blocking,
 * fails the job on a non-ok response, and returns a doc `file_path`.)
 */
export async function ingestSummary(opts: {
  knowledgeApiUrl: string;
  /** Ingest path, e.g. "/api/youtube/ingest". */
  ingestPath: string;
  /** JSON body — the caller assembles title/url/summary/category/date (+author). */
  body: Record<string, unknown>;
  /** Called with the returned similar articles when the ingest succeeds. */
  onSimilar: (similar: SimilarArticle[]) => void;
  /**
   * Called on a successful ingest with the stored doc's `file_path` — huginn's
   * wiki-relative doc id (`<category>/<title-slug>.md`), the SAME id the run-now
   * source drafter lists as `newest.id`. The auto source-drafter threads this so
   * both entry points key their proposal off the identical doc id (no duplicate
   * proposal, and the consumed-set crediting `<collection>/<docId>` matches).
   * `undefined` when the response omits it (older huginn).
   */
  onIngested?: (info: { filePath?: string }) => void;
  /** Abort timeout. Absent ⇒ {@link ingestTimeoutFor} over the serialized body. */
  timeoutMs?: number;
}): Promise<void> {
  const payload = JSON.stringify(opts.body);
  // BYTES, not code units: the budget bounds what goes on the WIRE, and a
  // windowed `## Transcript` of a Japanese or Norwegian talk is mostly
  // multi-byte — `.length` would hand a 3 MB POST the budget of a 1 MB one.
  const payloadBytes = Buffer.byteLength(payload);
  const timeoutMs = opts.timeoutMs ?? ingestTimeoutFor(payloadBytes);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  // Debug rather than info: one line per capture, and the only place the
  // resolved budget is visible (an AbortSignal does not report its deadline).
  log.debug("Ingesting {bytes} bytes into {path} with a {timeoutMs} ms budget", {
    bytes: payloadBytes,
    path: opts.ingestPath,
    timeoutMs,
  });
  try {
    const res = await fetch(`${opts.knowledgeApiUrl}${opts.ingestPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      const data = (await res.json()) as { similar?: SimilarArticle[]; file_path?: string };
      if (data.similar && data.similar.length > 0) {
        opts.onSimilar(data.similar);
      }
      if (opts.onIngested) {
        opts.onIngested({
          filePath: typeof data.file_path === "string" ? data.file_path : undefined,
        });
      }
    } else {
      log.warn("Knowledge API ingest returned {status}", { status: res.status });
    }
  } catch (err) {
    clearTimeout(timeout);
    log.warn("Knowledge API ingest failed: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
