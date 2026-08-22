/**
 * SSE lifecycle for the **single-claim re-verify** endpoint
 * (`GET /api/wiki/factcheck/claim`) — the server half of the reader's ↻ affordance
 * on a claim that timed out, was skipped, or crashed. The client half now exists:
 * `applyRetryAffordances` in `wiki-browser.ts` injects the ↻ rows and
 * `wiki-claim-retry.ts` owns the answer surgery, so "the ↻ row" below names a real
 * button. NB it consumes this stream via `fetch` + a ReadableStream rather than an
 * EventSource, precisely so the single-flight 409's body is readable.
 *
 * It is deliberately NOT a second whole-article pipeline: there is no extraction
 * phase (the claim text is client-supplied, see below), no fan-out, and no
 * compose. One tool-enabled `tracedOneShot` verifies ONE claim and emits ONE
 * verdict block. It shares the outer SSE scaffold with `factcheck-sse.ts`
 * (`streamFactcheckScaffold` — heartbeat, `app_error` masking, terminal `end`), so
 * the client consumes a wire shape it already knows.
 *
 * **Why the claim text is client-supplied.** Re-extraction is not an option:
 * extraction is a model call and non-deterministic, so "claim 2" on a re-extract
 * need not be the claim that timed out — a retry would silently re-verify a
 * DIFFERENT statement and splice its verdict under the old claim's index. The
 * client therefore echoes the claim's `title`/`quote` from the turn it holds, and
 * every field is bounded here. This is loopback-only and no worse than the
 * existing `POST /api/wiki/factcheck/integrate`, which accepts a whole
 * client-posted answer; a caller that can send one can send the other. Bounding is
 * for accident and payload size, not trust.
 *
 * **What a failure does NOT do.** When the retry itself fails (timeout, empty
 * result, a reply that missed the `### <emoji> Claim n/m` heading contract, a
 * connector error) the route emits `app_error` and NO `claim_result`: the
 * persisted answer, its outcome map and the rendered pane stay byte-untouched, the
 * message surfaces on the ↻ row, and the affordance stays live. Emitting a fresh
 * synthetic ❓ would splice one hole over another and rewrite the reason text of a
 * claim nobody re-verified.
 */

import type { Context } from "hono";
import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";
import type { executeOneShot } from "../../ai/one-shot.ts";
import { agentStatus, setConnectorInfo } from "../../observability/agent-status.ts";
import { Tracer } from "../../tracing/tracer.ts";
import { tracedOneShot } from "../../core/traced-one-shot.ts";
import { buildClaimVerifyPrompt, type Claim } from "../../wiki/factcheck-context.ts";
import { truncateUnits } from "../../wiki/ask-chat.ts";
import {
  classifyClaimFailure,
  isClaimVerdictBlock,
  linkifySourcesLines,
  makeClaimToolForwarder,
  makeSafeWrite,
  parseConfidence,
  realOutcome,
  rebuildToolSpansAfterFailure,
  shortFailureReason,
  streamFactcheckScaffold,
  verdictOf,
  type ClaimFailure,
  type ClientState,
  type SseStream,
  type StampedToolEvent,
} from "./factcheck-sse.ts";
import { getLog } from "../../logging.ts";

const log = getLog("dashboard", "factcheck-retry-sse");

/**
 * Budget for one re-verified claim. Deliberately far above the fan-out's
 * {@link import("./factcheck-sse.ts").FACTCHECK_CLAIM_TIMEOUT_MS} (110s): a retry
 * runs ALONE — no compose reserve to protect, no sibling claims to starve, and no
 * launch deadline above it — so the only ceiling is the per-response idleTimeout
 * (255s), which the 30s heartbeat holds open anyway. A claim that timed out at
 * 110s under contention is exactly the one worth giving a longer run.
 */
export const FACTCHECK_RETRY_TIMEOUT_MS = 180_000;

/**
 * Cap on the client-echoed claim `title` (chars). The extraction prompt asks for
 * ≤80, so this is a bound and not a budget — a real title never reaches it. Over
 * the cap the title is TRUNCATED rather than rejected: it is presentation only
 * (it renders in the block heading), unlike `quote`, which is dropped over-cap
 * because a truncated quote can point the model at a different span than the one
 * the claim was drawn from (the `claimsEventPayload` rule).
 */
export const CLAIM_TITLE_MAX = 200;

/**
 * Ceiling on the `index`/`total` pair. Deliberately NOT `FACTCHECK_MAX_CLAIMS`:
 * the pair comes off a PERSISTED turn, so a turn produced while the cap was
 * higher must still be retryable after the cap is lowered. This is only here to
 * keep an absurd value out of the prompt's `Claim <n>/<total>` heading.
 */
export const CLAIM_INDEX_MAX = 99;

/**
 * The `app_error` prose for a retry the budget killed. Deliberately NOT the
 * fan-out's `claimTimeoutReason`: that helper falls back to
 * `FACTCHECK_CLAIM_TIMEOUT_MS` when the connector's message named no budget, and
 * a retry ran against {@link FACTCHECK_RETRY_TIMEOUT_MS} instead — reusing it
 * would report 110s for a call that had 180s. So the figure here is only ever the
 * one the MESSAGE carried; a message that named none (or named an implausible
 * one, which `classifyClaimFailure` rejects to `ms: null`) gets figure-free prose
 * rather than a constant dressed up as a measurement.
 */
export function retryTimeoutReason(failure: ClaimFailure): string {
  if (failure.ms === null) return "The re-check timed out — the claim was not re-verified.";
  return `The re-check timed out after ${Math.round(failure.ms / 1000)}s — the claim was not re-verified.`;
}

/**
 * Shape-neutralize a client-echoed field before it reaches the verify prompt.
 *
 * Distinct from the LENGTH bounds above, and the distinction is the point:
 * bounding is for accident and payload size (a stated non-trust decision — this
 * route is loopback-only), whereas this protects the prompt's DELIMITER CONTRACT.
 * `buildClaimVerifyPrompt` fences the source passage between `"""` lines, so a
 * field carrying its own `"""` can close the block early and have whatever follows
 * read as instructions rather than as quoted wiki text.
 *
 * The treatment mirrors `neutralizeFactcheckSentinels` (the integrate route's
 * injected-sentinel fix): keep the readable content, destroy the structural
 * marker. A run of three or more `"` collapses to one — idempotent, since the
 * result no longer matches.
 *
 * The implementation now lives in the dependency-free `src/utils/prompt-fence.ts`
 * (share and the Jira composer carried their own copies of it); this stays a
 * re-export because `wiki-routes.ts` imports the name from here.
 */
import { neutralizePromptFence } from "../../utils/prompt-fence.ts";
export { neutralizePromptFence };

/**
 * Flatten a client-echoed claim `title` to ONE line.
 *
 * `buildClaimVerifyPrompt` writes it as a single `CLAIM (n/m): <title>` line, and
 * it is also the `/agents` run name — a raw newline therefore both breaks the
 * single-line prompt field (letting an injected line read as its own instruction)
 * and renders the run card multi-line. `quote` gets the fence neutralization only:
 * it is written INTO a `"""` block, where newlines are legitimate content.
 */
export function shapeClaimTitle(title: string): string {
  return neutralizePromptFence(title).replace(/\s+/g, " ").trim();
}

/**
 * Slack added on top of {@link FACTCHECK_RETRY_TIMEOUT_MS} when sizing a slot's
 * expiry. The constraint it satisfies, stated: the one-shot's own 180s budget
 * starts AFTER the slot is acquired (the route still has the page read + the
 * excerpt locate to do), and the run's teardown — the failure-path tool-span
 * rebuild, the final SSE writes, the scaffold's `finally` — runs after that budget
 * expires. Sized to exactly the budget, the slot therefore frees itself while the
 * holder is still tearing down, and a second GET arriving on that boundary starts
 * a concurrent 180s tool-enabled run. The slot must outlive the whole run, so the
 * expiry is `acquire + budget + this`. It only ever delays the LAZY heal of a slot
 * whose `finally` never ran (a killed process) — the ordinary path releases
 * explicitly and never waits for expiry.
 */
export const CLAIM_RETRY_SLOT_SLACK_MS = 30_000;

/** One in-flight retry for a page, with the deadline a caller's 409 reports. */
interface RetryFlight {
  startedAt: number;
  expiresAt: number;
}

/**
 * Per-page single-flight registry for claim retries.
 *
 * This EXTENDS the atlas draft-synthesis precedent (`synthesisInFlight` in
 * `wiki-routes.ts`), which keeps a bare `Set<string>` and answers
 * `{state, topicKey}`. Two deliberate differences:
 *
 *  - the value carries `expiresAt`, so a route whose `finally` never ran (a
 *    process that was killed mid-stream, a `streamSSE` that threw before the
 *    scaffold's teardown) cannot wedge a page forever. Expiry is evaluated
 *    LAZILY on the next hit — no sweeper, no timer to leak;
 *  - the 409 body carries `expiresAtMs`, because the client's cancel/"try again
 *    in…" copy needs a deadline to render, and having the server answer it here
 *    is what keeps the UI PR from having to reopen this route.
 *
 * Bounding the inputs is not bounding the RATE: one GET buys a tool-enabled 180s
 * one-shot, so a page-scoped single flight is the actual spend guard.
 */
const claimRetryFlights = new Map<string, RetryFlight>();

/** Registry key — per page, scoped by wiki (two wikis can hold the same relPath). */
export function claimRetryKey(wiki: string, page: string): string {
  return `${wiki}\u0000${page}`;
}

/** Result of {@link acquireClaimRetry}: the release fn, or the holder's deadline. */
export type ClaimRetryAcquisition =
  | { ok: true; release: () => void }
  | { ok: false; expiresAtMs: number };

/**
 * Claim the single-flight slot for `key`, treating an EXPIRED holder as free.
 * `release` is identity-checked, so a late release from a run whose entry already
 * expired and was re-taken cannot free the newer holder's slot.
 */
export function acquireClaimRetry(key: string, now: number = Date.now()): ClaimRetryAcquisition {
  const held = claimRetryFlights.get(key);
  if (held && held.expiresAt > now) return { ok: false, expiresAtMs: held.expiresAt };
  const entry: RetryFlight = {
    startedAt: now,
    expiresAt: now + FACTCHECK_RETRY_TIMEOUT_MS + CLAIM_RETRY_SLOT_SLACK_MS,
  };
  claimRetryFlights.set(key, entry);
  return {
    ok: true,
    release: () => {
      if (claimRetryFlights.get(key) === entry) claimRetryFlights.delete(key);
    },
  };
}

/** Test-only: drop every in-flight entry (the `__setSynthesisDraftDepsForTest`
 *  reset precedent — a test that hangs a retry must not leak its key). */
export function __resetClaimRetryFlightsForTest(): void {
  claimRetryFlights.clear();
}

export interface FactcheckRetryOptions {
  config: Config;
  /** The verifying bot. `null` ⇒ the scaffold emits the "no bots" app_error. */
  botConfig: BotConfig | null;
  /** Route-computed preflight error; when set, emitted as an `app_error`. */
  preflightError?: string | null;
  /** The claim being re-verified — client-echoed, bounded by the route. */
  claim: Claim & { index: number; total: number };
  /** Page metadata for framing the prompt + the `/agents` run name. */
  meta: { title: string };
  wikiName: string;
  mode: "sel" | "article";
  /**
   * The located surrounding excerpt (`sel` mode). BEST-EFFORT by construction:
   * the route re-reads the page as it is NOW and re-locates the persisted
   * selection, so a page edited since the original check can have moved or lost
   * the passage — in which case the locator's fallback (or nothing) rides along.
   * That is acceptable because the prompt frames this block as "reference only";
   * the CLAIM is what gets verified, and it comes from the turn, not the page.
   */
  excerpt?: string;
  /** Nearest-heading hint for the selection (`sel` mode only). */
  ctx?: string;
  /** Test seam — production callers omit it (forwarded into `tracedOneShot`). */
  oneShot?: typeof executeOneShot;
  /** Fired on every terminal path — the route releases its single-flight slot. */
  onSettled?: () => void;
}

/**
 * Run the SSE lifecycle for one claim retry. Never throws; always emits a terminal
 * `end`. Emits `tool` events (the Consulting chips + tool log work exactly as in a
 * normal run), then either ONE `claim_result` + `done`, or an `app_error`.
 */
export function streamFactcheckRetrySSE(c: Context, opts: FactcheckRetryOptions): Response {
  return streamFactcheckScaffold(c, {
    botConfig: opts.botConfig,
    preflightError: opts.preflightError,
    noBotMessage: "No bots configured to re-check this claim.",
    run: (stream, botConfig, clientState) => runClaimRetry(stream, opts, botConfig, clientState),
    ...(opts.onSettled ? { onSettled: opts.onSettled } : {}),
  });
}

/** The `/agents` run name (+ display label) for one retry. */
function retryRunName(opts: FactcheckRetryOptions): string {
  return `Re-check claim ${opts.claim.index}/${opts.claim.total}: ${opts.claim.title}`;
}

/**
 * The single-claim verify, wrapped in its OWN `factcheck-retry` trace root and its
 * OWN `/agents` run. Both are owned here rather than by `tracedOneShot`, which
 * deliberately owns neither — a one-shot with no registered run is invisible on
 * `/agents`, and a route that borrowed the article run's id would report a second
 * claim under a finished run.
 */
async function runClaimRetry(
  stream: SseStream,
  opts: FactcheckRetryOptions,
  botConfig: BotConfig,
  clientState: ClientState,
): Promise<void> {
  const { config, claim } = opts;
  const runName = retryRunName(opts);
  const reqId = agentStatus.startRequest(botConfig.name, "verifying_claims", undefined, {
    kind: "factcheck",
    // Surrogate-safe: the name ends in a client-echoed title, and a bare `slice`
    // through an astral character stores a U+FFFD on the run card (the reason
    // `truncateUnits` exists — see `src/wiki/ask-chat.ts`).
    name: runName.length > 60 ? `${truncateUnits(runName, 57)}…` : runName,
  });
  setConnectorInfo(reqId, botConfig, config.claudeModel);

  const tracer = new Tracer("factcheck-retry", { botName: botConfig.name, platform: "factcheck" });
  const traceId: string | undefined = tracer.traceId;
  let inputTokens = 0;
  let outputTokens = 0;
  let numTurns = 0;
  let costUsd: number | undefined;
  let status: "ok" | "error" = "ok";
  // What the trace root's `error` attribute reports. Held here (rather than
  // finished at each failure site) so the `finally` can close the root on EVERY
  // terminal path exactly once — see its comment.
  let failureMessage: string | undefined;

  const safeWrite = makeSafeWrite(stream, clientState);

  // 1-BASED, matching the `Claim n/m` heading contract the client retries against.
  // The in-run fan-out's labels are `claude:claim-<i>` with a 0-BASED `i` — the
  // numbering is deliberately different, because that label indexes a worker slot
  // while this one names the claim a reader clicked ↻ on.
  const label = `claude:claim-retry-${claim.index}`;
  // Every tool event this call emits, stamped on arrival. Fed to `pairToolEvents`
  // on the FAILURE path only (a throw loses the connector's own `toolCalls`).
  const toolEvents: StampedToolEvent[] = [];
  // The SHARED forwarder — same accumulate-before-the-gone-guard rule and the same
  // `tool` payload the client's Consulting chips read, so the retry and the article
  // fan-out cannot drift on either contract.
  const onProgress = makeClaimToolForwarder({
    clientState,
    safeWrite,
    claimIndex: claim.index,
    toolEvents,
  });

  try {
    const { systemPrompt, userPrompt } = buildClaimVerifyPrompt(claim, {
      index: claim.index,
      total: claim.total,
      pageTitle: opts.meta.title,
      wikiName: opts.wikiName,
      mode: opts.mode,
      ...(opts.excerpt ? { excerpt: opts.excerpt } : {}),
      ...(opts.ctx ? { heading: opts.ctx } : {}),
    });

    const claude = await tracedOneShot(tracer, label, userPrompt, config, botConfig, {
      systemPrompt,
      onProgress,
      timeoutMs: FACTCHECK_RETRY_TIMEOUT_MS,
      startAttrs: { claimIndex: claim.index },
      ...(opts.oneShot ? { oneShot: opts.oneShot } : {}),
    });
    inputTokens = claude.inputTokens ?? 0;
    outputTokens = claude.outputTokens ?? 0;
    numTurns = claude.numTurns ?? 0;
    if (typeof claude.costUsd === "number") costUsd = claude.costUsd;
    if (claude.model) agentStatus.setModel(reqId, claude.model);

    const result = (claude.result ?? "").trim();
    if (!result) {
      // An empty result is a FAILED retry, not an unverifiable claim: no verdict
      // came back to rule with. It gets the same treatment as a timeout — the
      // stored answer stays untouched and the ↻ row reports why.
      status = "error";
      failureMessage = "the verifier returned no verdict";
      log.warn("Claim retry returned no verdict bot={bot} claim={index}", {
        bot: botConfig.name,
        index: claim.index,
      });
      safeWrite("app_error", {
        type: "error",
        message: "The verifier returned no verdict for this claim — nothing was changed.",
      });
      return;
    }

    // Linkify BEFORE emitting. On a normal run `Sources:` lines are linkified once
    // at assembly (`assembleFactcheckAnswer`); a raw retried block spliced into the
    // answer would keep bare URLs, and `web-format.ts` has NO bare-URL autolinker —
    // they would render as plain text in the pane, in `answer_html`, and in any
    // later ➕/integrate write. The helper is server-side, so the client cannot fix
    // it after the fact; it is idempotent, so applying it per block is safe.
    const block = linkifySourcesLines(result);

    // A retried block is SPLICED over a well-formed one, so it must carry the
    // anchor everything downstream reads: without the `### <emoji> Claim n/m —
    // <title>` heading, `parseFactcheckClaims` stops seeing the claim, and with it
    // go `correctableClaims`, the integrate route's edit anchors and the client's
    // per-claim splice — a reply that merely drifted off format would silently
    // DESTROY a claim that was previously intact. So a non-conforming reply takes
    // the app_error-and-no-claim_result path, exactly like a timeout: the persisted
    // answer stays byte-untouched and the ↻ affordance stays live.
    if (!isClaimVerdictBlock(block)) {
      status = "error";
      failureMessage = "the verifier's reply was not a verdict block";
      log.warn("Claim retry returned a non-verdict block bot={bot} claim={index} head={head}", {
        bot: botConfig.name,
        index: claim.index,
        head: block.slice(0, 120),
      });
      safeWrite("app_error", {
        type: "error",
        message:
          "The model's reply did not come back as a verdict block — the claim was not re-verified.",
      });
      return;
    }

    const confidence = parseConfidence(block);
    const verdict = verdictOf(block);

    safeWrite("claim_result", {
      type: "claim_result",
      index: claim.index,
      verdict,
      outcome: realOutcome(block),
      ...(typeof confidence === "number" ? { confidence } : {}),
      markdown: block,
    });

    log.info("Claim retry done bot={bot} claim={index}/{total} verdict={verdict}", {
      bot: botConfig.name,
      index: claim.index,
      total: claim.total,
      verdict,
    });

    await stream.writeSSE({
      event: "done",
      data: JSON.stringify({ type: "done", index: claim.index }),
    });
  } catch (err) {
    status = "error";
    const message = err instanceof Error ? err.message : String(err);
    failureMessage = message;
    const failure = classifyClaimFailure(message);
    // The seam already ended the span with `{ error }`, but never reached
    // `attachToolSpans` (success path only), so the span has no tool children —
    // exactly the run you most want to inspect. The SHARED rebuild owns the offset
    // origin + the fail-soft contract; this call keeps its own log line.
    await rebuildToolSpansAfterFailure({
      tracer,
      label,
      toolEvents,
      captureToolOutputs: !!config.tracingCaptureToolOutputs,
      onError: (error) =>
        log.warn("Claim retry bot={bot} claim={index}: rebuilding tool spans failed (ignoring): {error}", {
          bot: botConfig.name,
          index: claim.index,
          error,
        }),
    });
    log.warn("Claim retry failed bot={bot} claim={index} timeout={timeout} error={error}", {
      bot: botConfig.name,
      index: claim.index,
      timeout: failure.isTimeout,
      error: message,
    });
    // No `claim_result` — see the module header. The reason prose is the same
    // vocabulary the fan-out's synthetic block uses, minus the ❓ heading.
    await stream.writeSSE({
      event: "app_error",
      data: JSON.stringify({
        type: "error",
        message: failure.isTimeout
          ? retryTimeoutReason(failure)
          : `Verification failed: ${shortFailureReason(message)}`,
      }),
    });
  } finally {
    // The trace root is closed HERE, on every terminal path, exactly once. It used
    // to be finished in the catch and in an `ok`-only branch below, which left the
    // two mid-`try` `return`s (empty result, non-verdict block) closing NEITHER —
    // and an unfinished root renders as perpetually running on `/traces` forever,
    // since nothing ever revisits it. Keying the single call on `status` is what
    // makes "every path" and "exactly once" both hold by construction.
    if (status === "ok") tracer.finish("ok", { inputTokens, outputTokens, numTurns, costUsd });
    else tracer.finish("error", { error: failureMessage ?? "the claim retry failed" });
    agentStatus.completeRequest(reqId, {
      inputTokens,
      outputTokens,
      numTurns,
      costUsd,
      ...(config.tracingEnabled ? { traceId } : {}),
    });
  }
}
