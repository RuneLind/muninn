import { getLog } from "../logging.ts";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { ClaudeExecResult } from "../ai/executor.ts";
import type { StreamProgressCallback } from "../ai/stream-parser.ts";
import { executeOneShot, connectorCapabilities } from "../ai/one-shot.ts";
import { Tracer } from "../tracing/tracer.ts";
import { attachToolSpans } from "../core/tool-spans.ts";
import { getConnectorLabel } from "../observability/agent-status.ts";
import type { RunMeta, SimilarArticle } from "./job-store.ts";

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
  /** Test seams — production callers pass neither. */
  oneShot?: typeof executeOneShot;
  tracer?: Tracer;
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

  const tracer = opts.tracer ?? new Tracer(`capture:${source}`, {
    botName: botConfig.name,
    platform: "capture",
  });
  const oneShot = opts.oneShot ?? executeOneShot;

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

  tracer.start("claude", {
    source,
    title,
    url,
    connector: botConfig.connector ?? "claude-cli",
    model: botConfig.model,
    ...(thinking !== null ? { thinkingMaxTokens: thinking } : {}),
  });

  try {
    const result = await oneShot(opts.prompt, config, botConfig, {
      systemPrompt: opts.systemPrompt,
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.extraDirs ? { extraDirs: opts.extraDirs } : {}),
      ...(thinking !== null ? { thinkingMaxTokens: thinking } : {}),
    });

    const usage = {
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      numTurns: result.numTurns,
      toolCount: result.toolCalls?.length ?? 0,
      costUsd: result.costUsd,
    };

    tracer.end("claude", { ...usage, durationMs: result.durationMs });
    // Tool child spans hang off the `claude` span, exactly as on the chat path.
    await attachToolSpans(tracer, result.toolCalls, !!config.tracingCaptureToolOutputs);
    attachRun(jobId, usage);
    tracer.finish("ok", { source, ...usage });

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    tracer.end("claude", { error: message });
    tracer.finish("error", { source, error: message });
    captureLog.warn("Capture summarize failed for {source} job {jobId}: {error}", {
      source,
      jobId,
      error: message,
    });
    throw err;
  }
}

/**
 * Shared structured-summary rules used by every capture vertical (youtube /
 * x-article / anthropic / article via {@link buildSummarySystemPrompt}, and tiktok inline).
 *
 * The contract is deliberately uniform so stored summaries read consistently on
 * /summaries AND make clean drafter input downstream: a `## Key takeaways`
 * section leads every summary, `##`-level headings structure the body, tables
 * appear only for genuinely comparative content, and the output is PLAIN
 * markdown — no block components (Callout/Verdict/Pill/etc.), a stated non-goal
 * for stored summaries.
 */
export const SUMMARY_STRUCTURE_BULLETS = [
  "- Open with a `## Key takeaways` section FIRST — 3–6 tight bullet points, one line each, capturing the most important points.",
  "- Then `##`-level section headers for each major topic; use `###` only for sub-sections. Keep the heading hierarchy consistent.",
  "- Use a markdown table when the content is genuinely comparative (options side by side, before/after, feature or tradeoff matrices) — don't force a table onto non-comparative content.",
  "- **Bold** for key terms; bullet lists for enumerations, prefixed with a fitting emoji (as in `- 🧪 Evals catch…`).",
  "- Plain markdown only — no HTML and no custom block components (no callouts, cards, verdicts, or pills).",
  "- Keep it concise but comprehensive.",
];

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
): string {
  return `${intro}

Instructions:
1. Start your response with EXACTLY this line: CATEGORY: <category>
   Choose from: ${categories.join(", ")}
2. Then add a blank line, then SUMMARY: on its own line
3. Then write a structured summary with:
   ${SUMMARY_STRUCTURE_BULLETS.join("\n   ")}`;
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
  /** Abort timeout (default 15s). */
  timeoutMs?: number;
}): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetch(`${opts.knowledgeApiUrl}${opts.ingestPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts.body),
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
