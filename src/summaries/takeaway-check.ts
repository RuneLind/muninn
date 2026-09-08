/**
 * The closing-takeaway grounding check — the second half of the 2026-09-08
 * takeaway fix (the first is the closer line in `summary-structure.ts`).
 *
 * The reader often reads ONLY the closing `> 💬 **Takeaway:**` line, and on a
 * talk captured with the opus model and full thinking that line overstated two
 * points and inverted a third while the body above it was right on all three.
 * The prompt line was the cause and is rewritten; this module is the proof
 * that the rewrite held on THIS capture: a Haiku-tier call is handed the summary
 * body and the closer — never the transcript, because the body is what the
 * reader can check and every measured defect was body-contradicted — and asked
 * whether each clause of the closer restates something the body says. An
 * ungrounded closer is replaced by the call's own rewrite, built from the
 * `## Key takeaways` bullets.
 *
 * The pure half (split, prompt, parse, splice) is exported for tests and for
 * `scripts/eval-takeaway.ts`; the IO half (`groundTakeaway`) runs through the
 * Haiku router so the bot's own backend answers and the `haiku_usage` row joins
 * the capture trace. Every failure — no closer found, the call throwing, an
 * unparseable answer — keeps the ORIGINAL text and says so on the outcome, so a
 * check outage can never cost a summary its closer.
 */

import { callHaikuWithFallback, type HaikuBackend } from "../ai/haiku-direct.ts";
import { extractJson } from "../ai/json-extract.ts";
import type { ConnectorType } from "../bots/config.ts";
import type { Tracer } from "../tracing/tracer.ts";
import { getLog } from "../logging.ts";

const log = getLog("summaries", "takeaway-check");

/**
 * The model the check REQUESTS. Measured 2026-09-08 on the Drolshammer talk:
 * Haiku and Sonnet both flag all three defects, but Haiku's rewrite ran to
 * three sentences that read as a list, while Sonnet's was two sentences the
 * body would sign — and the rewrite is what the reader reads. The request is
 * honoured by the anthropic and CLI backends and passed through on copilot
 * (where the router's non-Haiku warn line fires — accepted, the summarizer bot
 * is not a copilot bot); the vertex backend ignores it and runs its own model.
 */
export const TAKEAWAY_CHECK_MODEL = "claude-sonnet-4-6";

/** The closer marker every capture prompt asks for (`summary-structure.ts`). */
export const TAKEAWAY_MARKER = "> 💬 **Takeaway:**";

export interface SplitTakeaway {
  /** Everything before the closer block, trailing whitespace kept as is. */
  readonly before: string;
  /** The closer's TEXT after the marker, `>` continuation lines joined with spaces. */
  readonly takeaway: string;
  /** Whatever followed the closer block (usually nothing, or a trailing newline). */
  readonly after: string;
}

/**
 * Find the LAST closer block — the marker line plus any `>` continuation lines
 * directly under it — in raw model text. Last, not first: a summary that quotes
 * the marker in prose (rare, but a body ABOUT summaries could) still ends with
 * the real one. `null` when there is none, which is also what the YouTube
 * selection pass and any prompt without the closer rule produce.
 */
export function splitClosingTakeaway(text: string): SplitTakeaway | null {
  const lines = text.split("\n");
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trimStart().startsWith(TAKEAWAY_MARKER)) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && lines[end]!.trimStart().startsWith(">")) end++;
  const first = lines[start]!.trimStart().slice(TAKEAWAY_MARKER.length).trim();
  const rest = lines
    .slice(start + 1, end)
    .map((l) => l.trimStart().replace(/^>\s?/, "").trim())
    .filter((l) => l !== "");
  return {
    before: lines.slice(0, start).join("\n"),
    takeaway: [first, ...rest].join(" ").trim(),
    after: lines.slice(end).join("\n"),
  };
}

/** Put a (new) closer text back where the old one was, single-line. */
export function spliceClosingTakeaway(split: SplitTakeaway, takeaway: string): string {
  const closer = `${TAKEAWAY_MARKER} ${takeaway.replace(/\s*\n\s*/g, " ").trim()}`;
  const after = split.after === "" ? "" : `\n${split.after}`;
  return `${split.before}\n${closer}${after}`;
}

export interface TakeawayVerdict {
  readonly verdict: "grounded" | "ungrounded";
  /** One line per clause the body does not support; empty when grounded. */
  readonly issues: readonly string[];
  /** The corrected closer, present only when ungrounded. */
  readonly rewrite: string | null;
}

/**
 * The check prompt. It names the three defect classes the 2026-09-08 review
 * found by name — an added cause, an added ranking, a reversal — because a
 * generic "is this accurate" let a model wave through the clever inversion as
 * a fair paraphrase. The rewrite must be built from the body alone and in the
 * closer's own language, and it must not be "punchier": the whole point is a
 * line the body would sign.
 */
export function buildTakeawayCheckPrompt(body: string, takeaway: string): string {
  return `You are checking the closing takeaway of a summary against the summary's own body. The reader often reads ONLY the takeaway, so it must not say anything the body does not.

Go through the takeaway clause by clause. A clause is UNSUPPORTED when the body does not state it, including these cases:
- a CAUSE or EFFECT the body does not state (the body says X delayed one part; the takeaway says X delayed the whole)
- a RANKING or SUPERLATIVE the body does not state ("the biggest obstacle was…" when the body ranks nothing)
- a REVERSAL or clever inversion of the body's point ("the most valuable project was the one that was cancelled" when the body says cancelling it was healthy and the value came from something else)
- a number, name or date the body does not carry
Emphasis and compression are fine; a claim is not.

Answer with ONE JSON object and nothing else:
{"verdict": "grounded" | "ungrounded", "issues": ["<one line per unsupported clause, in English, quoting the clause>"], "rewrite": <string or null>}

If ungrounded, "rewrite" is a replacement takeaway: at most two sentences and about 50 words, in the SAME LANGUAGE as the original takeaway, built ONLY from the body (its Key takeaways bullets first), restating the source's own conclusion in its own emphasis — not made more memorable, and not a list of everything the body says. No markdown, no "Takeaway:" prefix. If grounded, "issues" is [] and "rewrite" is null.

<body>
${body}
</body>

<takeaway>
${takeaway}
</takeaway>`;
}

/** Parse the model's answer; throws on a shape that is not a verdict. */
export function parseTakeawayVerdict(text: string): TakeawayVerdict {
  const raw = extractJson<Record<string, unknown>>(text);
  const verdict = raw.verdict;
  if (verdict !== "grounded" && verdict !== "ungrounded") {
    throw new Error(`takeaway check: verdict is ${JSON.stringify(verdict)}`);
  }
  const issues = Array.isArray(raw.issues) ? raw.issues.filter((i): i is string => typeof i === "string") : [];
  const rewrite = typeof raw.rewrite === "string" && raw.rewrite.trim() !== "" ? raw.rewrite.trim() : null;
  if (verdict === "ungrounded" && rewrite === null) {
    throw new Error("takeaway check: ungrounded verdict without a rewrite");
  }
  return { verdict, issues, rewrite: verdict === "ungrounded" ? rewrite : null };
}

export type TakeawayOutcome =
  /** The closer restates the body; text unchanged. */
  | "grounded"
  /** The closer was replaced by the check's rewrite. */
  | "rewritten"
  /** No closer block in the text (a selection pass, a prompt without the rule). */
  | "no-takeaway"
  /** The call or the parse failed; text unchanged. */
  | "check-failed";

export interface GroundTakeawayResult {
  readonly text: string;
  readonly outcome: TakeawayOutcome;
  readonly issues: readonly string[];
  /** The closer as the model wrote it, when one was found. */
  readonly original?: string;
  /** Usage of the check call, when one ran. */
  readonly usage?: { model: string; inputTokens: number; outputTokens: number; backend?: HaikuBackend };
}

export interface GroundTakeawayOptions {
  readonly botName: string;
  readonly connector?: ConnectorType;
  readonly haikuBackend?: HaikuBackend;
  /** Joins the `haiku_usage` row to the capture trace. */
  readonly tracer?: Tracer;
  /** Names the caller on the `haiku_usage` row, e.g. `capture:vimeo`. */
  readonly entrypoint?: string;
  readonly timeoutMs?: number;
  /** The model to request; defaults to {@link TAKEAWAY_CHECK_MODEL}. */
  readonly model?: string;
  /** Test seam: replaces the router call. */
  readonly call?: (prompt: string) => Promise<{ result: string; model: string; inputTokens: number; outputTokens: number; backend?: HaikuBackend }>;
}

/**
 * Check the closer of raw model text against the text above it and rewrite it
 * when it is not grounded. The text may still carry the `CATEGORY:` /
 * `SUMMARY:` envelope — the closer is at the end either way, and the parser
 * that strips the envelope runs after this.
 */
export async function groundTakeaway(text: string, opts: GroundTakeawayOptions): Promise<GroundTakeawayResult> {
  const split = splitClosingTakeaway(text);
  if (!split) return { text, outcome: "no-takeaway", issues: [] };
  const prompt = buildTakeawayCheckPrompt(split.before, split.takeaway);
  try {
    const call =
      opts.call ??
      ((p: string) =>
        callHaikuWithFallback(p, {
          source: "takeaway-check",
          entrypoint: opts.entrypoint ?? "capture-takeaway-check",
          botName: opts.botName,
          connector: opts.connector,
          haikuBackend: opts.haikuBackend,
          tracer: opts.tracer,
          model: opts.model ?? TAKEAWAY_CHECK_MODEL,
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        }));
    const answer = await call(prompt);
    const usage = {
      model: answer.model,
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
      ...(answer.backend ? { backend: answer.backend } : {}),
    };
    const verdict = parseTakeawayVerdict(answer.result);
    if (verdict.verdict === "grounded") {
      return { text, outcome: "grounded", issues: [], original: split.takeaway, usage };
    }
    log.info("Capture takeaway rewritten for {botName}: {count} unsupported clause(s): {issues}", {
      botName: opts.botName,
      count: verdict.issues.length,
      issues: verdict.issues.join(" | "),
    });
    return {
      text: spliceClosingTakeaway(split, verdict.rewrite!),
      outcome: "rewritten",
      issues: verdict.issues,
      original: split.takeaway,
      usage,
    };
  } catch (err) {
    log.warn("Capture takeaway check failed for {botName}, keeping the closer as written: {error}", {
      botName: opts.botName,
      error: err instanceof Error ? err.message : String(err),
    });
    return { text, outcome: "check-failed", issues: [], original: split.takeaway };
  }
}
