/**
 * Dedicated SSE streaming lifecycle for the wiki reader's **Fact check** feature
 * (`GET /api/wiki/factcheck`). A sibling of `research-sse.ts`, but deliberately
 * NOT built on `streamResearchAnswer`: fact-check does no huginn retrieval and no
 * coverage gate. It runs a THREE-phase pipeline:
 *
 *   1. **Extraction** (Haiku, fast) — pull the checkable claims out of the page
 *      (article mode) or the selected passage (sel mode) as JSON.
 *   2. **Verification** — a bounded-parallel fan-out (`FACTCHECK_CLAIM_CONCURRENCY`)
 *      of tool-enabled `executeOneShot` calls, one per claim, each verifying its
 *      claim against the LIVE web (WebFetch) and emitting one verdict block.
 *   3. **Compose** (multi-claim only) — a small call (`thinkingMaxTokens: 0`) that
 *      writes the overall-assessment lede; the server assembles `lede + blocks`.
 *      Tools remain available (they are NOT disabled) — a tool excursion here just
 *      burns the 30s compose budget and degrades to the neutral header (the catch
 *      handles it). For a single claim the lone verify block IS the answer (no
 *      compose, no latency regress).
 *
 * It reuses the outer SSE scaffold shape (heartbeat, `app_error` masking, terminal
 * `end`, `finally` teardown) so the wire contract matches Ask/Explain — the
 * client's shared `runAskStream` consumes `delta`/`done`/`answer_html`/`app_error`/
 * `end` unchanged, plus the new `claims`/`claim_result`/`tool` events (fact-check
 * only). `streamResearchSSE`/`streamResearchAnswer` are left byte-untouched.
 */

import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";
import type { StreamProgressEvent } from "../../ai/stream-parser.ts";
import { callHaikuWithFallback } from "../../ai/haiku-direct.ts";
import { getToolProgress, rawUrlField } from "../../ai/tool-status.ts";
import { agentStatus, setConnectorInfo } from "../../observability/agent-status.ts";
import { Tracer } from "../../tracing/tracer.ts";
import { tracedOneShot } from "../../core/traced-one-shot.ts";
import { attachToolSpans } from "../../core/tool-spans.ts";
import type { executeOneShot } from "../../ai/one-shot.ts";
import type { ToolCall } from "../../types.ts";
import { locateExcerpt } from "../../wiki/explain-context.ts";
import { stripFactWrappers } from "../../format/markdown-ast.ts";
import { promptMaskBody } from "../../wiki/integrate-edits.ts";
import {
  stripFactcheckBlock,
  buildClaimExtractionPrompt,
  parseClaimList,
  buildClaimVerifyPrompt,
  buildComposePrompt,
  FACTCHECK_ARTICLE_BODY_MAX,
  FACTCHECK_MAX_CLAIMS,
  type Claim,
} from "../../wiki/factcheck-context.ts";
import { CLAIM_QUOTE_MAX, parseFactcheckClaims } from "../views/components/wiki-integrate.ts";
import { getLog } from "../../logging.ts";

const log = getLog("dashboard", "factcheck-sse");

/**
 * Raised timeout for the WHOLE fact-check run. The default `CLAUDE_TIMEOUT_MS`
 * (120s) would intermittently kill a multi-claim check. 280s leaves headroom for
 * the `FACTCHECK_MAX_CLAIMS` (8) cap under bounded concurrency while staying inside
 * the plan's 240–300s budget. The claim fan-out enforces this as a launch deadline
 * (below) rather than an executeOneShot-level abort (the one-shot has none).
 */
export const FACTCHECK_TIMEOUT_MS = 280_000;

/**
 * Per-claim verify timeout. A hung claim yields one ❓ "verification timed out"
 * block, not a dead run. Must stay generous enough that a claim still genuinely
 * fetching is not killed — task 0 measured ~15s/web-verified-claim, and 90s was
 * already cutting real fetches short.
 *
 * **The bound on raising it, stated:** the fan-out enforces
 * {@link FACTCHECK_TIMEOUT_MS} as a LAUNCH deadline, not an abort, so an in-flight
 * claim may overrun it by up to this budget — bounded by one claim per worker, so
 * worst-case run wall-clock is `FACTCHECK_TIMEOUT_MS + this`. That fits inside the
 * 255s-per-response idleTimeout only because the 30s heartbeat holds the stream
 * open; a value large enough to break that arithmetic is not safe here.
 */
export const FACTCHECK_CLAIM_TIMEOUT_MS = 110_000;

/** Max claims verified concurrently in the fan-out (bounded worker pool). */
export const FACTCHECK_CLAIM_CONCURRENCY = 2;

/** Time reserved at the tail for the compose call — the fan-out stops launching
 *  new claims once `deadline = start + FACTCHECK_TIMEOUT_MS − COMPOSE_BUDGET_MS`
 *  passes, so compose always has room. Also the compose call's own timeout. */
export const COMPOSE_BUDGET_MS = 30_000;

export interface FactcheckSseOptions {
  config: Config;
  /** The synthesizing bot. `null` ⇒ the helper emits the "no bots" app_error. */
  botConfig: BotConfig | null;
  /** Route-computed preflight error (unknown wiki, no page, non-web connector, …).
   *  When set, emitted as an `app_error`; no model call. */
  preflightError?: string | null;
  /** Page body — raw markdown, or `htmlToText(explainer)` for explainer pages.
   *  Prior fact-check blocks are stripped inside the SSE (runtime prompt-build). */
  body: string;
  /** Page metadata for framing the prompts + the `/agents` run name. */
  meta: { title: string; tags: string[]; type: string };
  wikiName: string;
  mode: "sel" | "article";
  /** The reader-selected passage (`sel` mode only). */
  sel?: string;
  /** Nearest-heading hint for the selection (`sel` mode only). */
  ctx?: string;
  /** Claim cap (defaults to {@link FACTCHECK_MAX_CLAIMS}). */
  maxClaims?: number;
  /**
   * Whether the checked page is `.mdx` — the argument {@link claimExtractionText}
   * hands `promptMaskBody`, deciding whether BLOCK-component tag markup is masked
   * alongside the fences (prose inside a `<Callout>` stays visible either way).
   *
   * Derived server-side from the resolved page path, like {@link annotatable}, and
   * deliberately NOT that field: `annotatable` is a POLICY answer ("should this page
   * carry inline `<Fact>` wrappers"), this one is a SYNTAX answer ("does the
   * renderer read component tags here"). They agree today and are one
   * `isAnnotatablePage` term away from disagreeing. Absent ⇒ plain markdown.
   */
  isMdx?: boolean;
  /** sha256 of the checked page's on-disk content — round-tripped on `done` so
   *  the ➕ POST can detect a drifted page. */
  baseHash: string;
  /**
   * The checked page's measured body length, round-tripped on `done` so the
   * "Integrate into article" client can size its edit budget against the SAME
   * number the integrate route enforces. Computed via the one pinned referent
   * `integrateBodyLen` (`src/wiki/integrate-edits.ts`) — never a bespoke
   * sentinel-only measure, which diverges by kilobytes on a code-heavy page.
   *
   * OMITTED for explainer pages: they are HTML on disk and cannot be integrated
   * at all, so any number here would be an HTML byte count the integrate route
   * never enforces. Absent ⇒ the client shows no budget rather than a fiction.
   */
  bodyLen?: number;
  /**
   * Whether the checked page SHOULD carry INLINE fact-check annotations — i.e. its
   * resolved file extension is `.mdx` (`isAnnotatablePage` in `wiki-routes.ts`).
   * This is a POLICY restriction, not a capability one: `renderWikiHtml` is
   * extension-agnostic and would render the `<Fact>`/`<FactCheck>` pair from a
   * `.md` page too, but `.md` pages are read raw outside the reader (GitHub),
   * where the tags would show as literal text — so they keep the blockquote
   * callout form and get no wrappers.
   *
   * Derived SERVER-SIDE from the resolved page path (the client never sees the
   * path and must not guess from a display name) and round-tripped on `done` so
   * later PRs can relax the integrate gate on it. Absent ⇒ not annotatable.
   */
  annotatable?: boolean;
  /** Final-render hook: markdown answer → reader HTML, emitted as a trailing
   *  `answer_html` (same shape as Ask/Explain). A throw is swallowed — the
   *  streamed plain text stands. */
  renderAnswerHtml?: (answer: string) => string;
  /**
   * Test seam — production callers omit it (defaults to `executeOneShot`). Forwarded
   * verbatim into `tracedOneShot`'s own `oneShot` option for BOTH the per-claim
   * verify calls and the compose call.
   *
   * This is the ONLY way to force a claim failure from a test: the per-claim budget
   * is enforced INSIDE each connector (four separate `setTimeout`s — see
   * {@link classifyClaimFailure}), so shortening {@link FACTCHECK_CLAIM_TIMEOUT_MS}
   * forces nothing without a real model call to outlast it.
   */
  oneShot?: typeof executeOneShot;
}

/** Shared liveness flag: the client-abort handler (registered on the outer stream)
 *  flips `gone`, and both the launch-gate and every write-guard read it. */
export interface ClientState {
  gone: boolean;
}

/** The four verdict markers, for parsing a block's leading verdict emoji. The
 *  VS16 (U+FE0F) on ⚠️ is optional — models routinely emit the bare ⚠ (U+26A0)
 *  without it; the captured verdict is normalized to the VS16 form below. */
const VERDICT_RE = /^###\s*(✅|⚠️?|❌|❓)/mu;

/** Extract a block's leading verdict emoji, defaulting to ❓ when absent. A bare
 *  ⚠ (no VS16) is normalized to ⚠️ so the client always receives the VS16 form. */
export function verdictOf(block: string): string {
  const m = block.match(VERDICT_RE);
  if (!m) return "❓";
  return m[1] === "⚠" ? "⚠️" : m[1]!;
}

/**
 * Build the `claims` SSE event's per-claim payload. The extractor's verbatim
 * supporting passage rides ALONG with the title — it is what a later PR anchors an
 * inline `<Fact>` wrapper on, and this event is the only place it ever exists
 * (nothing re-derives it). Two rules:
 *
 * - An ABSENT quote stays absent ("Omit it if the claim is implicit" —
 *   `buildClaimExtractionPrompt`), so a missing quote never becomes `""`.
 * - An over-cap quote is **dropped, never truncated**: the propose route rejects
 *   anything over {@link CLAIM_QUOTE_MAX}, and a truncated quote may resolve to a
 *   DIFFERENT span than the model meant. Dropping here keeps the value that
 *   survives extraction identical to the value that survives propose.
 *
 * The length test is on the TRIMMED quote, matching `validateClaimQuotes` (which
 * trims before capping); the emitted value stays the extractor's own string.
 */
export function claimsEventPayload(
  claims: { title: string; quote?: string }[],
): { index: number; title: string; quote?: string }[] {
  return claims.map((c, i) => {
    const trimmed = (c.quote ?? "").trim();
    return {
      index: i + 1,
      title: c.title,
      ...(trimmed && trimmed.length <= CLAIM_QUOTE_MAX ? { quote: c.quote as string } : {}),
    };
  });
}

/** A synthetic ❓ block for a claim we could not verify (skipped / timed out).
 *  Excluded from the final claim count (only real verify blocks are counted). */
function synthBlock(index: number, total: number, title: string, reason: string): string {
  return `### ❓ Claim ${index}/${total} — ${title}\n\n${reason}`;
}

/**
 * Plausibility window for a budget parsed out of a timeout message. Deliberately
 * an ABSOLUTE range, not a ratio against {@link FACTCHECK_CLAIM_TIMEOUT_MS} — a
 * ratio would reject the very numbers a test that shortens the budget produces.
 * 1 hour is far above any per-claim budget this route will ever set, and nothing
 * legitimate lands above it.
 *
 * Honest note on what this guards: NOT a nested timeout message today. The two
 * other `timed out after <n>ms` producers a verify call could plausibly wrap
 * (`mcp-tool-caller.ts`, `mcp-status.ts`) are unreachable on this path —
 * `mcp-status` swallows its own rejections, and `mcp-tool-caller`'s only connector
 * consumer is `openai-compat`, which the fact-check route preflights out on
 * `supportsWebTools`. So this is a guard against a hypothetical future wrapper
 * whose own budget rides in the same string, not against a live failure mode.
 */
const CLAIM_BUDGET_MS_MAX = 3_600_000;

/**
 * A connector's timeout clause AND its budget in ONE anchored pattern. The figure
 * must sit adjacent to the phrase, because the message is otherwise arbitrary text
 * a model or an upstream chose: a free-floating `(\d+)\s*ms` also matches a `ms`
 * token inside a fetched URL (`?delay=250ms`), and `String.match` takes the FIRST
 * hit, so an earlier token wins over the real budget and the reason renders a
 * figure nothing measured. Case-insensitive as ONE pattern so the phrase and its
 * unit can't disagree about casing (a `TIMED OUT AFTER 110000MS` matched the
 * phrase but not a case-sensitive unit ⇒ `isTimeout` true, budget silently lost).
 *
 * On a wrapped message carrying two clauses the FIRST (outermost) wins — the
 * budget the caller we are reporting on actually set.
 */
const CLAIM_TIMEOUT_MS_RE = /timed out after\s*(\d+)\s*ms/i;

/**
 * A connector crash passed through verbatim — `ai/executor.ts` throws
 * `Claude exited with code <n>: <stderr>`, and stderr is whatever the child wrote,
 * including an upstream's own `timed out after <n>ms`. A crash reported as ⏱️
 * "timed out after Ns" states a budget this route never set and hides that the
 * process died, so the crash shape wins over the phrase wherever both appear.
 */
const CRASH_PASSTHROUGH_RE = /exited with code \d+:/i;

/** What a failed claim verification was, read off the connector's thrown message. */
export interface ClaimFailure {
  /**
   * Did the per-claim budget kill it? Every connector spells its own timeout
   * differently but all four share `timed out after`:
   * `Claude Agent SDK timed out after <n>ms` (`ai/connectors/claude-sdk.ts`),
   * `Claude timed out after <n>ms` (`ai/executor.ts`),
   * `Copilot SDK timed out after <n>ms` (`ai/connectors/copilot-sdk.ts`),
   * `OpenAI-compat request timed out after <n>ms` (`ai/connectors/openai-compat-stream.ts`).
   */
  isTimeout: boolean;
  /**
   * The budget it died against, when the message named a PLAUSIBLE one. Preferred
   * over {@link FACTCHECK_CLAIM_TIMEOUT_MS}, so the reason reports the number that
   * actually applied rather than the current constant — a constant bump must not
   * make an older or foreign caller's reason lie.
   */
  ms: number | null;
  /**
   * A figure WAS present next to the phrase and was rejected as implausible. This
   * is what separates `ms: null` meaning "the message named no budget" (⇒ the
   * constant is the honest best guess) from "the message named one we don't
   * believe" (⇒ say nothing about seconds at all — substituting the constant there
   * would print a measured-looking figure over a number we just refused).
   */
  msRejected: boolean;
}

/**
 * Classify a failed claim verification from the connector's thrown message.
 * `isTimeout` and the budget are separate questions with separate consumers; only
 * the timeout arm of the reason consumes `ms`/`msRejected`.
 */
export function classifyClaimFailure(message: string): ClaimFailure {
  if (CRASH_PASSTHROUGH_RE.test(message)) return { isTimeout: false, ms: null, msRejected: false };
  const isTimeout = /timed out after/i.test(message);
  const m = message.match(CLAIM_TIMEOUT_MS_RE);
  if (!m) return { isTimeout, ms: null, msRejected: false };
  const n = Number(m[1]);
  const plausible = Number.isFinite(n) && n > 0 && n <= CLAIM_BUDGET_MS_MAX;
  return { isTimeout, ms: plausible ? n : null, msRejected: !plausible };
}

/**
 * The ❓ block's prose for a timed-out claim. Figure-free when the message named a
 * budget we rejected — the seconds figure must always be something the message
 * itself carried or the constant standing in for a message that carried nothing,
 * never a constant dressed up as a measurement.
 */
export function claimTimeoutReason(failure: Pick<ClaimFailure, "ms" | "msRejected">): string {
  if (failure.ms === null && failure.msRejected) {
    return "Verification timed out — the claim was not checked.";
  }
  const ms = failure.ms ?? FACTCHECK_CLAIM_TIMEOUT_MS;
  return `Verification timed out after ${Math.round(ms / 1000)}s — the claim was not checked.`;
}

/** Longest connector message we inline into a user-facing failure reason. Past
 *  this it is a stack-ish blob, not a reason. */
const FAILURE_REASON_MAX = 200;

/**
 * Reduce a connector's thrown message to one bounded, single-line, sentence-ended
 * clause for the ❓ block's prose. Never parsed by anything — presentation only.
 *
 * Deliberately does NOT escape or strip markup, even though the input is RAW
 * connector stderr: the output is markdown, and every sink that renders it escapes
 * plain text itself (`formatWebHtml` → `&lt;script&gt;`). Escaping here would
 * double-escape in the reader and still not cover a sink that doesn't. If a new
 * sink renders this unescaped, fix the sink.
 */
export function shortFailureReason(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  if (!flat) return "the verifier reported no reason.";
  const clipped = flat.length > FAILURE_REASON_MAX
    ? `${flat.slice(0, FAILURE_REASON_MAX - 1)}…`
    : flat;
  return /[.!?…]$/.test(clipped) ? clipped : `${clipped}.`;
}

/** A `tool_start`/`tool_end` progress event with the arrival instant the consumer
 *  stamped on it. {@link StreamProgressEvent} carries no timestamp of its own — the
 *  connectors emit into a synchronous callback and never say when. */
export interface StampedToolEvent {
  event: StreamProgressEvent;
  atMs: number;
}

/**
 * Rebuild {@link ToolCall}s from the tool progress events a dead model call emitted,
 * so a timed-out claim's span still gets its tool children. On the SUCCESS path the
 * connector hands back a `toolCalls` array and this is never used; on the throw path
 * that array is lost with the call, and the progress channel is the only surviving
 * record of what the claim was doing.
 *
 * Pairing is by the event's `id` (the connector's own tool-call id — see
 * {@link StreamProgressEvent}), so two in-flight tools sharing a `displayName` —
 * routine for parallel WebFetch — can't swap durations.
 *
 * Rules:
 *   - paired start+end ⇒ a normal completed call;
 *   - **unpaired start ⇒ a call running to `failedAtMs`, flagged `unterminated`.**
 *     That one is the point of the whole function: the tool still in flight IS what
 *     the claim was doing when it hung, so dropping it would attach exactly the
 *     tools that were never the problem;
 *   - unpaired end (an end whose start we never saw) ⇒ dropped, since there is no
 *     start instant to place or measure it from.
 *
 * **`id` is typed required but is not trusted here.** Three of the four emit sites
 * read it off untyped runtime JSON (`block.id`, `t.id`, `tc.id`), so a connector
 * that stops sending one makes every event carry `undefined` — and a Map keyed on
 * that collapses every in-flight call onto ONE entry, silently deleting the
 * earlier ones. This function's whole job is to be the last surviving record of a
 * dead call, so an id problem must degrade the PAIRING and never the record: a
 * falsy id gets a synthetic per-start key (unpairable ⇒ the call shows as
 * unterminated), and a genuinely duplicated id flushes the displaced open call as
 * unterminated instead of dropping it.
 *
 * `startedAtMs` is the span-start instant — `attachToolSpans` anchors each child at
 * `parentSpan.startedAt + startOffsetMs`, so offsets must be relative to it.
 * Output is in start order.
 */
export function pairToolEvents(
  stamped: StampedToolEvent[],
  startedAtMs: number,
  failedAtMs: number,
): ToolCall[] {
  interface Open {
    idx: number;
    id: string;
    name: string;
    displayName: string;
    input?: string;
    atMs: number;
  }
  const open = new Map<string, Open>();
  const out: (ToolCall & { _idx: number })[] = [];
  let seq = 0;
  let fallbackKeys = 0;

  const build = (o: Open, endMs: number, unterminated: boolean): ToolCall & { _idx: number } => ({
    _idx: o.idx,
    id: o.id,
    name: o.name,
    displayName: o.displayName,
    durationMs: Math.max(0, Math.round(endMs - o.atMs)),
    startOffsetMs: Math.max(0, Math.round(o.atMs - startedAtMs)),
    ...(o.input !== undefined ? { input: o.input } : {}),
    ...(unterminated ? { unterminated: true } : {}),
  });

  for (const { event, atMs } of stamped) {
    if (event.type === "tool_start") {
      // A falsy id gets a key no end can ever match, which is the honest outcome:
      // the call is recorded, and unpairable ⇒ unterminated.
      const key = event.id || `${event.displayName}#${fallbackKeys++}`;
      // A repeated id means the connector reused one. The LATEST start is the only
      // one a later end could belong to, so it takes the key — but the displaced
      // call still happened, so it is flushed as unterminated rather than dropped.
      const displaced = open.get(key);
      if (displaced) out.push(build(displaced, failedAtMs, true));
      open.set(key, {
        idx: seq++,
        id: key,
        name: event.name,
        displayName: event.displayName,
        input: event.input,
        atMs,
      });
    } else if (event.type === "tool_end") {
      // An end with no id can't name a start; treat it like an unpaired end.
      if (!event.id) continue;
      const o = open.get(event.id);
      if (!o) continue; // unpaired end — no start instant to anchor it to
      open.delete(event.id);
      out.push(build(o, atMs, false));
    }
  }
  for (const o of open.values()) out.push(build(o, failedAtMs, true));

  out.sort((a, b) => a._idx - b._idx);
  return out.map(({ _idx, ...tc }) => tc);
}

/**
 * Rebuild a failed model call's tool child spans onto its (already-ended) span.
 *
 * Shared by the article fan-out and the claim retry because it encodes trace
 * invariants that must not drift between them: `tracedOneShot` reaches
 * `attachToolSpans` on the SUCCESS path only, so a claim that threw would
 * otherwise be the one span on `/traces` with zero children — exactly the run you
 * most want to inspect. `tracer.end` does NOT drop the label→span entry, so
 * `addChildSpan` still resolves `label` to the real parent.
 *
 * Two details are load-bearing and are why this is one function rather than two
 * copies: the offset origin must be the SAME instant `addChildSpan` adds
 * `startOffsetMs` to — the parent span's own `startedAt` (`src/core/tool-spans.ts`
 * uses `spanStartedAt` for exactly this) — or every child is pushed right by
 * however long elapsed between the two reads; and the whole thing is fail-SOFT,
 * because pure trace ornamentation must never turn a reported failure into a
 * thrown one. `onError` lets each caller keep its own log line.
 */
export async function rebuildToolSpansAfterFailure(opts: {
  tracer: Tracer;
  label: string;
  toolEvents: StampedToolEvent[];
  captureToolOutputs: boolean;
  onError: (message: string) => void;
}): Promise<void> {
  const failedAtMs = Date.now();
  // The label is registered by `tracedOneShot` before its first await, so the
  // fallbacks are unreachable in practice and only cost precision.
  const spanStartMs =
    opts.tracer.spanStartedAt(opts.label)?.getTime() ?? opts.toolEvents[0]?.atMs ?? failedAtMs;
  try {
    await attachToolSpans(
      opts.tracer,
      pairToolEvents(opts.toolEvents, spanStartMs, failedAtMs),
      opts.captureToolOutputs,
      opts.label,
    );
  } catch (spanErr) {
    opts.onError(spanErr instanceof Error ? spanErr.message : String(spanErr));
  }
}

/** A gone-guarded SSE writer: skips once the client is gone, and flips
 *  `clientState.gone` on the first failed write (the one-shot keeps producing
 *  events after a client abort — stop writing then). Shared verbatim by both
 *  fact-check runners so the abort contract has ONE implementation. */
export function makeSafeWrite(
  stream: SseStream,
  clientState: ClientState,
): (event: string, data: unknown) => void {
  return (event, data) => {
    if (clientState.gone) return;
    stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => { clientState.gone = true; });
  };
}

/**
 * The per-claim `onProgress` forwarder: accumulates every tool event for the
 * failure-path span rebuild AND forwards `tool_start`/`tool_end` to the client as
 * `tool` SSE events stamped with `claimIndex`.
 *
 * Shared by the article fan-out and the claim retry because it carries a LIVE
 * client contract — the client's `tool` listener drives the status line and builds
 * the "Consulting: host · host" chip row from `detail`/`url` — and one
 * load-bearing ordering rule: the accumulation happens **BEFORE** the
 * `clientState.gone` guard, which wraps the WRITES only. A reader who navigates
 * away from a claim that then times out must still get its tool spans; the trace
 * outlives the stream.
 *
 * Text deltas are deliberately NOT forwarded (index-less parallel deltas would
 * interleave into garbage in the fan-out, and the retry keeps the same wire shape).
 */
export function makeClaimToolForwarder(opts: {
  clientState: ClientState;
  safeWrite: (event: string, data: unknown) => void;
  /** 1-based claim index stamped onto every emitted `tool` payload. */
  claimIndex: number;
  /** Mutated in place — the failure path's only surviving record of the call. */
  toolEvents: StampedToolEvent[];
}): (event: StreamProgressEvent) => void {
  return (event) => {
    if (event.type === "tool_start" || event.type === "tool_end") {
      opts.toolEvents.push({ event, atMs: Date.now() });
    }
    if (opts.clientState.gone) return;
    if (event.type === "tool_start") {
      const prog = getToolProgress(event.name, event.input);
      // Full URL alongside the hostname `detail` — the client keeps the first one
      // seen per host to build the Consulting chip's href (hostname stays the dedup
      // key + label). Only forwarded when present.
      const url = rawUrlField(event.input);
      opts.safeWrite("tool", {
        type: "tool",
        state: "start",
        name: event.displayName,
        label: prog?.label ?? event.displayName,
        detail: prog?.detail,
        ...(url ? { url } : {}),
        claimIndex: opts.claimIndex,
      });
    } else if (event.type === "tool_end") {
      opts.safeWrite("tool", {
        type: "tool",
        state: "end",
        name: event.displayName,
        claimIndex: opts.claimIndex,
      });
    }
  };
}

/**
 * Does `block` OPEN with a well-formed `### <emoji> Claim n/m — <title>` heading?
 *
 * The heading is a fixed prompt contract and the anchor everything downstream
 * depends on (`parseFactcheckClaims` → `correctableClaims` → the integrate route's
 * edit anchors, and the client's per-claim splice). This runs the contract's ONE
 * implementation over the block's first non-blank line rather than re-spelling the
 * regex — a second copy is exactly how the two would drift.
 *
 * Deliberately does NOT check that `n`/`m` match the requested pair: the model is
 * told the numbering in the prompt, but a reply that renumbered while otherwise
 * being a perfectly good verdict block is a formatting wobble, not a wrong claim,
 * and rejecting it would turn a usable retry into a failure.
 */
export function isClaimVerdictBlock(block: string): boolean {
  const first = block.split("\n").find((line) => line.trim() !== "");
  if (first === undefined) return false;
  return parseFactcheckClaims(first).length === 1;
}

/** Per-claim live-UI outcome. Distinct from the block's ❓ markdown vocabulary
 *  (which stays unchanged in the persisted answer) — the disambiguation between
 *  "the web genuinely doesn't know" (`unverifiable`) and "we ran out of time /
 *  crashed" (`timeout`/`skipped`/`error`) lives here, in the SSE `claim_result`
 *  event, so the client can label + tally honestly. `verified` = any real
 *  model ruling (✅/⚠️/❌, or a model-chosen ❓ counts as `unverifiable`). */
export type ClaimOutcome = "verified" | "unverifiable" | "timeout" | "error" | "skipped";

/** Confidence line — evidence-strength score the model emits after the reasoning
 *  paragraph (`Confidence: NN/100`), independent of the verdict emoji. */
const CONFIDENCE_RE = /^Confidence:\s*(\d{1,3})\/100/im;

/** Parse a block's `Confidence: NN/100` line → a 0–100 int (clamped), or
 *  undefined when the line is absent/malformed. Never derives the verdict; the
 *  emoji is semantic, the score is evidence strength. */
export function parseConfidence(block: string): number | undefined {
  const m = block.match(CONFIDENCE_RE);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(100, Math.trunc(n)));
}

/** Classify a REAL (non-synthetic) model verify block into its live outcome: a
 *  model-chosen ❓ verdict means the web genuinely couldn't confirm it
 *  (`unverifiable`); any other verdict is a real ruling (`verified`). */
export function realOutcome(block: string): ClaimOutcome {
  return verdictOf(block) === "❓" ? "unverifiable" : "verified";
}

/** One claim's verdict outcome. `real` distinguishes a genuine model verdict
 *  (counted) from a synthetic ❓ skip/timeout block (excluded from the count);
 *  `outcome` carries the finer live-UI classification and `confidence` the
 *  parsed evidence-strength score (synthetic blocks carry none). */
export interface ClaimVerifyOutcome {
  block: string;
  real: boolean;
  outcome: ClaimOutcome;
  confidence?: number;
}

/**
 * Bounded-concurrency worker pool over `total` claims (pure — the caller injects
 * `verify`/`onSkip`/`onDone`/`shouldSkip`, so the ordering + launch-gate + skip
 * behaviour unit-test without any real model call). At most `concurrency` verifies
 * are in flight. BEFORE launching each claim the pool checks `shouldSkip()`
 * (client gone / past the deadline) — a skipped claim gets `onSkip(i)`'s synthetic
 * block instead of a verify. Returns outcomes in CLAIM ORDER; `onDone(i, outcome)`
 * fires per completion (in completion order) for SSE emission + progress.
 */
export async function runClaimPool(opts: {
  total: number;
  concurrency: number;
  shouldSkip: () => boolean;
  verify: (i: number) => Promise<ClaimVerifyOutcome>;
  onSkip: (i: number) => ClaimVerifyOutcome;
  onDone: (i: number, outcome: ClaimVerifyOutcome) => void;
}): Promise<ClaimVerifyOutcome[]> {
  const outcomes: ClaimVerifyOutcome[] = new Array(opts.total);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++; // atomic between awaits (single-threaded event loop)
      if (i >= opts.total) return;
      const outcome = opts.shouldSkip() ? opts.onSkip(i) : await opts.verify(i);
      outcomes[i] = outcome;
      opts.onDone(i, outcome);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(opts.concurrency, opts.total)) }, () => worker()),
  );
  return outcomes;
}

/** An existing markdown link `[text](http(s)://…)` (group 1 = text, group 2 = the
 *  href — the href group allows one level of balanced parens so a Wikipedia-style
 *  `…/Foo_(bar)` disambiguator survives) OR a bare http(s) URL (group 3). Bare
 *  URLs now allow `(`/`)` in the body (only whitespace/angle-brackets stop them);
 *  an UNMATCHED trailing `)` is peeled back off by {@link splitTrailingUrl} (the
 *  standard balanced-paren autolinker heuristic). Matching a markdown link first
 *  is what stops a bare-URL double-wrap. */
const SOURCES_URL_RE =
  /\[([^\]]*)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))*)\)|(https?:\/\/[^\s<>]+)/gi;

/** Percent-encode literal parens in a URL so the SHARED `web-format.ts`
 *  markdown-link parser (`\[..\]\(([^)]+)\)`, which we must NOT touch — global
 *  blast radius) doesn't stop the href at the first `)`. `%28`/`%29` carry no
 *  literal parens, so re-running this is a no-op (idempotent — never `%2528`). */
function encodeParens(url: string): string {
  return url.replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** Peel trailing text a model routinely writes right after a bare URL off the
 *  URL so it stays OUTSIDE the generated link's href: plain punctuation
 *  (comma/period/…) AND an UNBALANCED trailing `)` (a wrapper paren like
 *  `(see https://x.com/a)` — more `)` than `(` in the URL). A BALANCED paren
 *  (Wikipedia's `…/Foo_(bar)`) is kept. Peels alternately from the right so
 *  `…/a).` splits both. */
function splitTrailingUrl(input: string): [string, string] {
  let url = input;
  let trailing = "";
  while (url.length > 0) {
    const p = url.match(/[.,;:!?'"\]]+$/);
    if (p) {
      trailing = p[0] + trailing;
      url = url.slice(0, url.length - p[0].length);
      continue;
    }
    if (url.endsWith(")")) {
      const opens = (url.match(/\(/g) ?? []).length;
      const closes = (url.match(/\)/g) ?? []).length;
      if (closes > opens) {
        trailing = ")" + trailing;
        url = url.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return [url, trailing];
}

/**
 * Fact-check-scoped fallback linkifier (belt-and-suspenders to the markdown-link
 * `Sources:` prompt contract): on every line starting with `Sources:`, wrap any
 * BARE http(s) URL into a `[hostname](url)` markdown link so the reader/web
 * pipeline renders it clickable (`formatWebHtml` linkifies markdown links but has
 * no bare-URL autolinker). Pure + deterministic + idempotent + factcheck-only —
 * deliberately NOT a global autolinker on the shared web-format.
 *
 * Parens handling (FIX 1): both a newly-wrapped bare URL AND an already-present
 * markdown link have literal `(`/`)` percent-encoded in the emitted HREF
 * (`encodeParens`, link text untouched) so the shared `web-format.ts` parser —
 * which stops an href at the first `)` and which we must NOT modify — resolves
 * the full URL. Bare URLs keep BALANCED parens (Wikipedia disambig) but shed a
 * wrapper `)` (`splitTrailingUrl`). Existing markdown links are normalized in
 * place (an intentional scope extension); the encoding is idempotent so a second
 * pass is a no-op. Leaves non-`Sources:` lines and non-http(s) URLs untouched.
 */
export function linkifySourcesLines(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => {
      if (!/^Sources:/.test(line)) return line;
      return line.replace(
        SOURCES_URL_RE,
        (match: string, mdText?: string, mdHref?: string, bareUrl?: string) => {
          if (typeof mdHref === "string") {
            // An existing markdown link — normalize parens in the href in place
            // (idempotent), leave the link text as-is.
            return `[${mdText ?? ""}](${encodeParens(mdHref)})`;
          }
          if (typeof bareUrl !== "string") return match;
          const [url, trailing] = splitTrailingUrl(bareUrl);
          let host: string;
          try {
            host = new URL(url).hostname.replace(/^www\./, "") || url;
          } catch {
            return match; // unparseable — leave the bare URL untouched
          }
          return `[${host}](${encodeParens(url)})${trailing}`;
        },
      );
    })
    .join("\n");
}

/** Assemble the final fact-check markdown: for a multi-claim check, the compose
 *  `lede` on top of the verdict blocks; for a single claim, the lone block IS the
 *  answer (no lede). Blocks are always in claim order. `Sources:` lines are
 *  linkified (bare URL → `[hostname](url)`) so they render clickable everywhere the
 *  markdown lands (streamed answer, `answer_html`, the appended `> [!factcheck]`). */
export function assembleFactcheckAnswer(lede: string, blocks: string[]): string {
  const answer = blocks.length > 1
    ? `${lede}\n\n${blocks.join("\n\n")}`.trim()
    : (blocks[0] ?? "").trim();
  return linkifySourcesLines(answer);
}

export type SseStream = { writeSSE: (m: { event: string; data: string }) => Promise<void> };

/** The body of a fact-check-family SSE run: everything between the preflight
 *  checks and the terminal `end`. Must never throw — a model failure is the
 *  runner's own `app_error`, not an exception the scaffold has to mask. */
export type FactcheckRunner = (
  stream: SseStream,
  botConfig: BotConfig,
  clientState: ClientState,
) => Promise<void>;

export interface FactcheckScaffoldOptions {
  /** `null` ⇒ the scaffold emits {@link noBotMessage} and runs nothing. */
  botConfig: BotConfig | null;
  /** Route-computed preflight error. When set, emitted as an `app_error`; no run. */
  preflightError?: string | null;
  /** The bot-less app_error message (the retry route words it per-claim). */
  noBotMessage?: string;
  /** The pipeline this stream runs. */
  run: FactcheckRunner;
  /**
   * Fired in the scaffold's `finally`, on EVERY terminal path (done, app_error,
   * client abort). The claim-retry route releases its per-page single-flight
   * entry here — the route hands back a `Response` the instant `streamSSE`
   * returns, so this callback is the only place that knows the run is over.
   */
  onSettled?: () => void;
}

/**
 * The shared fact-check SSE scaffold: heartbeat, `app_error` masking of the
 * preflight/bot-less cases, the terminal `end` sentinel, and the `finally`
 * teardown. Extracted from {@link streamFactcheckSSE} so the whole-article run and
 * the single-claim retry (`factcheck-retry-sse.ts`) share ONE implementation of
 * the wire contract the client's `runAskStream` consumes — two copies would drift
 * on the next heartbeat/abort change, and the abort flag is load-bearing on both
 * (it gates every write).
 *
 * Never throws: the runner owns its own error reporting, and the terminal `end`
 * is emitted on the same path it always was.
 */
export function streamFactcheckScaffold(c: Context, opts: FactcheckScaffoldOptions): Response {
  return streamSSE(c, async (stream) => {
    // A web-verification pass can leave a long gap with no client-visible events
    // (the model is fetching pages); a heartbeat keeps the connection alive
    // through any proxy with a shorter idle window. Clients have no 'heartbeat'
    // listener, so these are silently ignored.
    let alive = true;
    const clientState: ClientState = { gone: false };
    const heartbeat = setInterval(() => {
      if (!alive) return;
      stream.writeSSE({ event: "heartbeat", data: "{}" }).catch(() => { alive = false; });
    }, 30_000);
    // onAbort must set `clientState.gone` (not just clear the heartbeat) — the
    // claim launch-gate reads it to stop launching new verifies for a gone client.
    stream.onAbort(() => { alive = false; clientState.gone = true; clearInterval(heartbeat); });

    const appError = (message: string) =>
      stream.writeSSE({ event: "app_error", data: JSON.stringify({ type: "error", message }) });

    try {
      if (opts.preflightError) {
        await appError(opts.preflightError);
      } else if (!opts.botConfig) {
        await appError(opts.noBotMessage ?? "No bots configured to run a fact check.");
      } else {
        await opts.run(stream, opts.botConfig, clientState);
      }
      // Terminal sentinel so the client closes the EventSource deterministically.
      await stream.writeSSE({ event: "end", data: "{}" });
    } finally {
      alive = false;
      clientState.gone = true;
      clearInterval(heartbeat);
      opts.onSettled?.();
    }
  });
}

/**
 * Run the whole SSE lifecycle for one fact-check request. Never throws (a model
 * failure is reported as an `app_error` event); always emits a terminal `end`
 * sentinel so the client can close deterministically.
 */
export function streamFactcheckSSE(c: Context, opts: FactcheckSseOptions): Response {
  return streamFactcheckScaffold(c, {
    botConfig: opts.botConfig,
    preflightError: opts.preflightError,
    run: (stream, botConfig, clientState) => runFactcheck(stream, opts, botConfig, clientState),
  });
}

/** Aggregate usage across the extraction + verify + compose calls, for the
 *  completed `/agents` run + the trace finish. */
interface Usage {
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
  costUsd: number;
}

/** The multi-phase fact-check pipeline (Phase 1 extract → Phase 2 fan-out → Phase 3
 *  compose), wrapped in a `factcheck` trace + an `/agents` run. */
/**
 * The text claim extraction READS — the article body behind the same mask the
 * integrate pass resolves against, or, in `sel` mode, the reader's selection.
 *
 * Extraction used to run over the raw stripped body while `annotateEdits` resolves
 * every anchor against a MASKED one, and the gap between the two is a claim class
 * that can be checked and can never be marked: the extractor quotes a mermaid node
 * or a code comment, the annotator answers "no longer found in the page", and the
 * reviewer sees a verdict with no passage. Measured on `life/sources/Neurochemical
 * Focus Stack…mdx` — one of eight claims came out of the diagram, and the prose
 * sentence two lines under it states the same thing and marks cleanly. Reading the
 * same masked text is what makes the extractor anchor there instead.
 *
 * `promptMaskBody` is the right mask and `matchMaskBody` is not: this text goes into
 * a PROMPT, so the zones must collapse to something readable and argv-safe, and no
 * offset math is done on it. It is the exact function the integrate one-shot's own
 * body goes through, which is the property that matters — one mask, two readers.
 *
 * Two consequences are deliberate:
 *
 *  - **The cap is applied AFTER the mask**, so `FACTCHECK_ARTICLE_BODY_MAX` counts
 *    prose rather than fences. On a code-heavy page that is strictly more checkable
 *    content, not less.
 *  - **`sel` mode is NOT masked.** A selection is a FRAGMENT — its fences need not be
 *    balanced, so `findExclusionZones` over one is guesswork — and a reader who
 *    selected a code block asked about that code. The sel-mode claim is anchored by
 *    the selection the reader made, not by a body scan, so the mismatch this function
 *    exists to close does not arise there.
 */
export function claimExtractionText(opts: {
  mode: "sel" | "article";
  sel: string;
  strippedBody: string;
  isMdx: boolean;
  max?: number;
}): string {
  if (opts.mode === "sel") return opts.sel;
  return promptMaskBody(opts.strippedBody, opts.isMdx).slice(
    0,
    opts.max ?? FACTCHECK_ARTICLE_BODY_MAX,
  );
}

async function runFactcheck(
  stream: SseStream,
  opts: FactcheckSseOptions,
  botConfig: BotConfig,
  clientState: ClientState,
): Promise<void> {
  const { config } = opts;
  const maxClaims = opts.maxClaims ?? FACTCHECK_MAX_CLAIMS;
  const runName = factcheckRunName(opts);

  // /agents registry mirror. Kind `factcheck`; settled in the `finally` so it
  // closes on the done path AND every error path (mirrors ask.ts).
  const reqId = agentStatus.startRequest(botConfig.name, "extracting_claims", undefined, {
    kind: "factcheck",
    name: runName.length > 60 ? `${runName.slice(0, 57)}…` : runName,
  });
  setConnectorInfo(reqId, botConfig, config.claudeModel);

  const tracer = new Tracer("factcheck", { botName: botConfig.name, platform: "factcheck" });
  const traceId: string | undefined = tracer.traceId;
  const usage: Usage = { inputTokens: 0, outputTokens: 0, numTurns: 0, costUsd: 0 };
  let status: "ok" | "error" = "ok";
  let seenModel: string | undefined;
  // Tracks whether the current `/agents` model label came from the Phase-1
  // extraction Haiku. A later verify/compose model (sonnet) is allowed to
  // overwrite an extraction-only label so the card ends up showing the
  // verification model, not the fast extraction Haiku.
  let modelFromExtraction = false;
  // Preserve the costUsd unknown-vs-zero distinction: CLI/direct-SDK Haiku leave
  // it undefined (⇒ the /agents Recent cost column should dash, not show $0.00),
  // whereas a subscription connector returns an explicit 0.
  let sawCost = false;

  const addUsage = (
    r: { inputTokens?: number; outputTokens?: number; numTurns?: number; costUsd?: number; model?: string },
    phase: "extract" | "verify" | "compose" = "verify",
  ) => {
    usage.inputTokens += r.inputTokens ?? 0;
    usage.outputTokens += r.outputTokens ?? 0;
    usage.numTurns += r.numTurns ?? 0;
    if (typeof r.costUsd === "number") { usage.costUsd += r.costUsd; sawCost = true; }
    if (r.model) {
      const fromExtraction = phase === "extract";
      // Set on first sight; otherwise let a later, different, non-extraction
      // model replace a label that only reflects the extraction Haiku.
      const overwrite = seenModel !== r.model && modelFromExtraction && !fromExtraction;
      if (!seenModel || overwrite) {
        seenModel = r.model;
        modelFromExtraction = fromExtraction;
        agentStatus.setModel(reqId, r.model);
      }
    }
  };

  // Write helper that flips `clientState.gone` on the first failed write (the
  // one-shot keeps producing events after a client abort — stop writing then).
  const safeWrite = makeSafeWrite(stream, clientState);

  const runStart = Date.now();
  const deadline = runStart + FACTCHECK_TIMEOUT_MS - COMPOSE_BUDGET_MS;

  try {
    // ── Phase 1: claim extraction (Haiku) ──────────────────────────────────
    // Strip any prior fact-check block ONCE. The article cap applies to the
    // EXTRACTION body only; sel-mode locateExcerpt runs over the FULL stripped
    // body (capping would break excerpt location for tail selections on >12k pages).
    // Strip the prior fact-check block AND any prior inline `<Fact>` wrappers ONCE.
    // Without the wrapper strip a re-check extracts claims from prose interleaved
    // with `<Fact n="4" v="bad">` markup, and the quotes it returns carry that
    // markup — which then resolves against nothing in the (stripped) integrate body.
    const strippedBody = stripFactWrappers(stripFactcheckBlock(opts.body));
    const sel = (opts.sel ?? "").trim();
    const extractionText = claimExtractionText({
      mode: opts.mode,
      sel,
      strippedBody,
      isMdx: opts.isMdx ?? false,
    });

    tracer.start("extract", { mode: opts.mode });
    let extraction: Awaited<ReturnType<typeof callHaikuWithFallback>>;
    try {
      extraction = await callHaikuWithFallback(
        buildClaimExtractionPrompt(extractionText, opts.meta.title, maxClaims),
        {
          source: "factcheck-extract",
          entrypoint: "factcheck",
          botName: botConfig.name,
          connector: botConfig.connector,
          haikuBackend: botConfig.haikuBackend,
          tracer,
        },
      );
    } catch (err) {
      // End the extract span on the throw path (the outer catch only finishes
      // the trace root) so it pairs on all paths like verify/compose.
      tracer.end("extract", { error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    addUsage(extraction, "extract");
    tracer.end("extract", {
      inputTokens: extraction.inputTokens,
      outputTokens: extraction.outputTokens,
      model: extraction.model,
      // The ACTUAL Haiku backend under a DISTINCT `haikuBackend` attr — NOT
      // `connector`. This extract span is co-resident with the claim/compose
      // spans, which carry the bot's `connector` (claude-sdk). getRecentTraces'
      // walk collapses DISTINCT `connector` values to 'mixed', so stamping the
      // router backend as a second `connector` here would flip the whole factcheck
      // row to connector='mixed'. `haikuBackend` is invisible to that collapse
      // (the walk only reads `connector`/`model`), so the row keeps showing the
      // verify connector while the waterfall label still surfaces the backend
      // (aiSpanLabel falls back to `haikuBackend` when `connector` is absent).
      ...(extraction.backend ? { haikuBackend: extraction.backend } : {}),
    });

    const parsed = parseClaimList(extraction.result ?? "");
    if (!parsed) {
      // Clean app_error, not a crash — the run still finishes (finally settles).
      log.info("Fact check: no claims extracted bot={bot} mode={mode}", {
        bot: botConfig.name,
        mode: opts.mode,
      });
      await stream.writeSSE({
        event: "app_error",
        data: JSON.stringify({
          type: "error",
          message: "Couldn't extract any checkable claims from this page.",
        }),
      });
      return;
    }
    const claims: Claim[] = parsed.slice(0, maxClaims);
    const total = claims.length;

    // The extractor's verbatim supporting passages ride ALONG with the titles —
    // see `claimsEventPayload` for the absent-stays-absent + drop-over-cap rules.
    safeWrite("claims", { type: "claims", claims: claimsEventPayload(claims) });
    agentStatus.updatePhase(reqId, "verifying_claims");

    // sel-mode surrounding excerpt (located over the FULL stripped body).
    const excerpt = opts.mode === "sel" ? locateExcerpt(strippedBody, sel, opts.ctx) : undefined;

    // ── Phase 2: bounded-parallel per-claim verification ───────────────────
    let doneCount = 0;

    // One claim's verification: a tool-enabled one-shot on the web-tools bot,
    // traced under its own indexed span so concurrent verifies don't clobber a
    // shared `claude` label. Returns the verdict block + whether it's a genuine
    // model verdict (a synthetic ❓ on empty/timeout/error is `real:false`).
    const verify = async (i: number): Promise<ClaimVerifyOutcome> => {
      const claim = claims[i]!;
      const index = i + 1;
      const label = `claude:claim-${i}`;
      // Every tool event this claim emits, stamped with its arrival instant. Fed to
      // `pairToolEvents` on the FAILURE path only — a throw loses the connector's
      // own `toolCalls` array, and without this the claim you most want to inspect
      // is the one span on `/traces` with zero children.
      const toolEvents: StampedToolEvent[] = [];
      // Per-claim tool progress — the SHARED forwarder (accumulate-before-the-gone-
      // guard + the `tool` event payload the client's Consulting chips read), so the
      // retry route and this fan-out can't drift on either contract.
      const onProgress = makeClaimToolForwarder({
        clientState,
        safeWrite,
        claimIndex: index,
        toolEvents,
      });

      const { systemPrompt, userPrompt } = buildClaimVerifyPrompt(claim, {
        index,
        total,
        pageTitle: opts.meta.title,
        wikiName: opts.wikiName,
        mode: opts.mode,
        excerpt,
        heading: opts.ctx,
      });

      try {
        // The shared seam owns the `claude:claim-<i>` span (start + end + tool
        // child spans under `label`). These spans are named claude:claim-<i>
        // (never "claude"), so they deliberately fall through the getRecentTraces
        // fast path to the walk aggregate, which sums their tokens + collapses
        // model/connector. Because the seam stamps `requestedModel` at start and
        // `model` only on a resolved end, an errored claim carries NO `model` attr
        // and so can no longer flip the /traces row to `model='mixed'`.
        const claude = await tracedOneShot(tracer, label, userPrompt, config, botConfig, {
          systemPrompt,
          onProgress,
          timeoutMs: FACTCHECK_CLAIM_TIMEOUT_MS,
          startAttrs: { claimIndex: index },
          ...(opts.oneShot ? { oneShot: opts.oneShot } : {}),
        });
        addUsage(claude);
        const result = (claude.result ?? "").trim();
        return result
          // A genuine model verdict (even a model-chosen ❓ ⇒ `unverifiable`).
          ? { block: result, real: true, outcome: realOutcome(result), confidence: parseConfidence(result) }
          // Empty result — no parseable verdict came back (an `error` outcome).
          : { block: synthBlock(index, total, claim.title, "The verifier returned no verdict for this claim."), real: false, outcome: "error" };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const failure = classifyClaimFailure(message);
        const isTimeout = failure.isTimeout;
        // The seam already ended the claim span with `{ error }` — but it never
        // reached `attachToolSpans` (success path only), so the claim span has no
        // tool children. The SHARED rebuild owns the offset origin + the fail-soft
        // contract (see `rebuildToolSpansAfterFailure`); this call keeps its own
        // log line.
        await rebuildToolSpansAfterFailure({
          tracer,
          label,
          toolEvents,
          captureToolOutputs: !!config.tracingCaptureToolOutputs,
          onError: (error) =>
            log.warn("Fact check bot={bot} claim={index}: rebuilding tool spans failed (ignoring): {error}", {
              bot: botConfig.name,
              index,
              error,
            }),
        });
        log.warn("Fact check claim failed bot={bot} claim={index} timeout={timeout} error={error}", {
          bot: botConfig.name,
          index,
          timeout: isTimeout,
          error: message,
        });
        // The reason names the CAUSE; the ❓ emoji must not change with it — the
        // verdict vocabulary is a PARSED contract (`verdictOf`,
        // `correctableClaims`) while the reason prose is parsed by nothing.
        // Any seconds figure comes from the message itself (see
        // {@link claimTimeoutReason}), never a literal.
        const reason = isTimeout
          ? claimTimeoutReason(failure)
          : `Verification failed: ${shortFailureReason(message)}`;
        return {
          block: synthBlock(index, total, claim.title, reason),
          real: false,
          // Both values are in `tallyClaimOutcomes`' five-value enum and the client
          // renders them apart (`factcheckRowMarkdown`: ⏱️ "timed out" vs ⚠️
          // "verification failed"), so a cause split here needs no client change —
          // this path just stops reporting a crash as a timeout.
          outcome: isTimeout ? "timeout" : "error",
        };
      }
    };

    const outcomes = await runClaimPool({
      total,
      concurrency: FACTCHECK_CLAIM_CONCURRENCY,
      // Launch-gate: stop launching for a gone client or past the deadline
      // (in-flight claims drain on their own timeout; the heartbeat keeps the
      // stream alive). Not-launched claims get a synthetic ❓ "skipped" block.
      shouldSkip: () => clientState.gone || Date.now() > deadline,
      verify,
      onSkip: (i) => ({
        block: synthBlock(i + 1, total, claims[i]!.title, "Skipped — the fact check ran out of time before this claim could be verified."),
        real: false,
        outcome: "skipped",
      }),
      onDone: (i, outcome) => {
        safeWrite("claim_result", {
          type: "claim_result",
          index: i + 1,
          verdict: verdictOf(outcome.block),
          outcome: outcome.outcome,
          ...(typeof outcome.confidence === "number" ? { confidence: outcome.confidence } : {}),
          markdown: outcome.block,
        });
        doneCount++;
        agentStatus.updateProgress(reqId, { done: doneCount, total, currentItem: claims[i]!.title });
      },
    });
    const blocks = outcomes.map((o) => o.block);

    // ── Phase 3: compose (multi-claim only) ────────────────────────────────
    let lede = "";
    if (total > 1) {
      try {
        const composePrompts = buildComposePrompt({
          title: opts.meta.title,
          wikiName: opts.wikiName,
          blocks,
        });
        // Compose deltas DO stream via the index-less `delta` path — nothing else
        // is running, so there's no interleave risk. The client accumulates them
        // as the lede above the blocks.
        const composeProgress = (event: StreamProgressEvent) => {
          if (event.type === "text_delta") safeWrite("delta", { type: "delta", text: event.text });
        };
        // The shared seam owns the `compose` span (connector + requestedModel at
        // start, model/tokens at end, `{ error }` on throw). It's named `compose`
        // (never "claude"), so it too falls through to the walk aggregate alongside
        // the claim spans. Only thinking is disabled (`thinkingMaxTokens: 0`); tools
        // stay available — the compose prompt steers away from tool use, but a stray
        // tool excursion just burns the COMPOSE_BUDGET_MS window and degrades to the
        // neutral header below (we deliberately don't hard-disable tools here).
        const compose = await tracedOneShot(tracer, "compose", composePrompts.userPrompt, config, botConfig, {
          systemPrompt: composePrompts.systemPrompt,
          thinkingMaxTokens: 0,
          timeoutMs: COMPOSE_BUDGET_MS,
          onProgress: composeProgress,
          ...(opts.oneShot ? { oneShot: opts.oneShot } : {}),
        });
        addUsage(compose, "compose");
        lede = (compose.result ?? "").trim();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // The seam already ended the compose span with `{ error }`.
        log.warn("Fact check compose failed bot={bot} error={error} — degrading to header", {
          bot: botConfig.name,
          error: message,
        });
        // Degrade to a neutral one-line header; never fail the run.
        lede = "Fact-check results:";
      }
    }

    const answer = assembleFactcheckAnswer(lede, blocks);
    // Count ONLY claims that produced a real verify block (skipped/timed-out
    // synthetic ❓ blocks excluded).
    const claimCount = outcomes.filter((o) => o.real).length;

    log.info("Fact check done bot={bot} mode={mode} claims={claims}/{total} tokens={tokens}", {
      bot: botConfig.name,
      mode: opts.mode,
      claims: claimCount,
      total,
      tokens: usage.outputTokens,
    });

    await stream.writeSSE({
      event: "done",
      data: JSON.stringify({
        type: "done",
        answer,
        cited: [],
        noHits: false,
        lowConfidence: false,
        claimCount,
        baseHash: opts.baseHash,
        bodyLen: opts.bodyLen,
        // Always a boolean (unlike `bodyLen`, whose absence is meaningful): a
        // non-.mdx page is definitively NOT annotatable, and the client should
        // never have to distinguish "false" from "an older server".
        annotatable: opts.annotatable === true,
        mode: opts.mode,
      }),
    });

    // Trailing server-rendered HTML (same pipeline as Ask/Explain). A throw here
    // is swallowed — the streamed plain text stands.
    if (opts.renderAnswerHtml) {
      try {
        const html = opts.renderAnswerHtml(answer);
        await stream.writeSSE({ event: "answer_html", data: JSON.stringify({ html, cited: [] }) });
      } catch (err) {
        log.warn("Fact check answer_html render failed — keeping streamed text: {error}", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    status = "error";
    const message = err instanceof Error ? err.message : String(err);
    tracer.finish("error", { error: message });
    log.error("Fact check failed bot={bot} error={error}", { bot: botConfig.name, error: message });
    await stream.writeSSE({ event: "app_error", data: JSON.stringify({ type: "error", message }) });
  } finally {
    const costUsd = sawCost ? usage.costUsd : undefined;
    if (status === "ok") tracer.finish("ok", { ...usage, costUsd });
    agentStatus.completeRequest(reqId, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      numTurns: usage.numTurns,
      costUsd,
      ...(config.tracingEnabled ? { traceId } : {}),
    });
  }
}

/** The `/agents` run name (+ display label): mode + title / truncated selection. */
function factcheckRunName(opts: FactcheckSseOptions): string {
  if (opts.mode === "sel") {
    const sel = (opts.sel ?? "").trim().replace(/\s+/g, " ");
    const snippet = sel.length > 48 ? `${sel.slice(0, 45)}…` : sel;
    return `Fact check: "${snippet}"`;
  }
  return `Fact check: ${opts.meta.title}`;
}
