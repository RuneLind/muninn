/**
 * SSE lifecycle for **share** (`POST /api/wiki/share`) — the server half of the
 * reader's 📤 Share dialog. One fenced one-shot turns a wiki page into a post, its
 * markdown streams to the dialog as it is written, and on completion the server
 * renders the per-platform strings the tabs show.
 *
 * **Why the fact-check scaffold and not `streamResearchSSE`.** Research brings
 * retrieval, a coverage gate and cited synthesis; share has a single source
 * document already in hand and cites nothing. What it needs from the family is the
 * outer shape — heartbeat, `app_error` masking, abort-guarded writes, terminal
 * `end` — which is exactly `streamFactcheckScaffold`, byte-shared with the article
 * fact-check and the claim retry.
 *
 * **Why the render happens HERE and not in the browser.** `formatSlackMrkdwn` and
 * `formatEmailHtml` are the same renderers Telegram/Slack delivery uses; a second
 * client-side implementation of either is a second thing to drift. The client gets
 * three finished strings and only decides which one to show and copy.
 *
 * **First POST in this route family.** The two existing scaffold callers are GETs,
 * and the ordering that buys is a requirement, not a detail: every body check runs
 * in the ROUTE, before this function is called, because once `streamSSE` commits a
 * 200 a validation failure can only be an `app_error` inside a successful
 * response. See the route in `wiki-routes.ts`.
 */

import type { Context } from "hono";
import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";
import type { executeOneShot } from "../../ai/one-shot.ts";
import { runFencedOneShot, FENCED_EXCLUDED_TOOLS } from "../../core/fenced-one-shot.ts";
import { formatSlackMrkdwn } from "../../slack/slack-format.ts";
import { formatEmailHtml } from "../../format/email-format.ts";
import { stripWrappingFence, SHARE_EXCLUDED_TOOLS } from "../../share/prompt.ts";
import type { ShareDonePayload } from "../../share/wire.ts";
import { truncateUnits } from "../../wiki/ask-chat.ts";
import {
  makeSafeWrite,
  streamFactcheckScaffold,
  type ClientState,
  type SseStream,
} from "./factcheck-sse.ts";
import { getLog } from "../../logging.ts";

const log = getLog("dashboard", "share-sse");

/**
 * Budget for one share generation.
 *
 * No tools (the web pair is fenced off — see {@link SHARE_EXCLUDED_TOOLS}) and a
 * body capped at `SHARE_BODY_MAX` (24k), so this is a single bounded completion:
 * the measured shape is tens of seconds, not minutes. 120s leaves room for a cold
 * CLI spawn plus a long post without approaching the 255s per-response
 * `idleTimeout` the 30s heartbeat holds open.
 */
export const SHARE_TIMEOUT_MS = 120_000;

/**
 * Slack added to the slot's expiry on top of the budget — same reason as the
 * claim retry's `CLAIM_RETRY_SLOT_SLACK_MS`: the one-shot's budget starts AFTER
 * the slot is taken (the route still has the page read and the body prep to do),
 * and the render + the final SSE writes + the scaffold's `finally` run after it
 * expires. Sized to exactly the budget, a slot frees itself while its holder is
 * still tearing down and a click on that boundary starts a concurrent run.
 */
export const SHARE_SLOT_SLACK_MS = 30_000;

/** One in-flight share for a page, with the deadline a caller's 409 reports. */
interface ShareFlight {
  startedAt: number;
  expiresAt: number;
}

/**
 * Per-page single-flight registry.
 *
 * The claim-retry precedent, for the same reason: bounding the INPUTS is not
 * bounding the RATE. One POST buys a whole-page summarization — measured floor
 * tens of thousands of input tokens — and a double-click, a reload mid-stream or a
 * second open tab all buy another one. This is the only mitigation that survives
 * all three, and the `expiresAt` on the value is what stops a process killed
 * mid-stream from wedging the page forever (evaluated lazily on the next hit: no
 * sweeper, no timer to leak).
 */
const shareFlights = new Map<string, ShareFlight>();

/** Registry key — per page, scoped by wiki (two wikis can hold one relPath). */
export function shareFlightKey(wiki: string, page: string): string {
  return `${wiki}\u0000${page}`;
}

/** Result of {@link acquireShareFlight}: the release fn, or the holder's deadline. */
export type ShareAcquisition =
  | { ok: true; release: () => void }
  | { ok: false; expiresAtMs: number };

/**
 * Claim the slot for `key`, treating an EXPIRED holder as free. `release` is
 * identity-checked, so a late release from a run whose entry already expired and
 * was re-taken cannot free the newer holder's slot.
 */
export function acquireShareFlight(key: string, now: number = Date.now()): ShareAcquisition {
  const held = shareFlights.get(key);
  if (held && held.expiresAt > now) return { ok: false, expiresAtMs: held.expiresAt };
  const entry: ShareFlight = {
    startedAt: now,
    expiresAt: now + SHARE_TIMEOUT_MS + SHARE_SLOT_SLACK_MS,
  };
  shareFlights.set(key, entry);
  return {
    ok: true,
    release: () => {
      if (shareFlights.get(key) === entry) shareFlights.delete(key);
    },
  };
}

/** Test-only: drop every in-flight entry (a test that hangs a share must not leak
 *  its key into the next one). */
export function __resetShareFlightsForTest(): void {
  shareFlights.clear();
}

export interface ShareSseOptions {
  config: Config;
  /** The generating bot. `null` ⇒ the scaffold emits the "no bots" app_error. */
  botConfig: BotConfig | null;
  /** Route-computed preflight error; when set, emitted as an `app_error`. */
  preflightError?: string | null;
  systemPrompt: string;
  userPrompt: string;
  /** `/agents` card name — truncated here, so callers don't each re-do it. */
  runName: string;
  /** Test seam — production callers omit it (forwarded into `runFencedOneShot`). */
  oneShot?: typeof executeOneShot;
  /** Fired on every terminal path — the route releases its single-flight slot. */
  onSettled?: () => void;
}

/**
 * Render the three per-platform strings from one markdown post.
 *
 * Exported because it is the whole `done` payload and the only place the tab set
 * is decided: **Slack · email · markdown**. Telegram is deliberately absent (v1
 * product decision) rather than shipped as a fourth string nothing renders.
 */
export function renderSharePayload(markdown: string): ShareDonePayload {
  return {
    markdown,
    slack: formatSlackMrkdwn(markdown),
    mailHtml: formatEmailHtml(markdown),
  };
}

/** Run the SSE lifecycle for one share generation. Never throws; always emits a
 *  terminal `end`. Emits `delta`s while the post is written, then `done`. */
export function streamShareSSE(c: Context, opts: ShareSseOptions): Response {
  return streamFactcheckScaffold(c, {
    botConfig: opts.botConfig,
    preflightError: opts.preflightError,
    noBotMessage: "No bots configured to write a share summary for this wiki.",
    run: (stream, botConfig, clientState) => runShare(stream, opts, botConfig, clientState),
    ...(opts.onSettled ? { onSettled: opts.onSettled } : {}),
  });
}

async function runShare(
  stream: SseStream,
  opts: ShareSseOptions,
  botConfig: BotConfig,
  clientState: ClientState,
): Promise<void> {
  const safeWrite = makeSafeWrite(stream, clientState);
  try {
    const result = await runFencedOneShot({
      traceName: "share",
      platform: "share",
      kind: "capture",
      phase: "calling_claude",
      // Surrogate-safe: the name ends in a page title, and a bare `slice` through
      // an astral character stores a U+FFFD on the run card.
      runName:
        opts.runName.length > 60 ? `${truncateUnits(opts.runName, 57)}…` : opts.runName,
      sourcePage: "/wiki",
      source: "share",
      prompt: opts.userPrompt,
      systemPrompt: opts.systemPrompt,
      config: opts.config,
      botConfig: {
        ...botConfig,
        // The share-specific half of the fence, unioned onto the runner's own
        // list. `runFencedOneShot` unions FENCED_EXCLUDED_TOOLS on top of whatever
        // the bot config carries, so passing them here is additive, not a
        // replacement — the union is spelled out rather than assumed.
        excludedTools: [
          ...new Set([
            ...(botConfig.excludedTools ?? []),
            ...FENCED_EXCLUDED_TOOLS,
            ...SHARE_EXCLUDED_TOOLS,
          ]),
        ],
      },
      timeoutMs: SHARE_TIMEOUT_MS,
      // The point of the whole passthrough: the reader watches the post being
      // written. Only text deltas are forwarded — there are no tools to report.
      onProgress: (event) => {
        if (event.type === "text_delta") safeWrite("delta", { type: "delta", text: event.text });
      },
      ...(opts.oneShot ? { oneShot: opts.oneShot } : {}),
    });

    const markdown = stripWrappingFence(result.result ?? "");
    if (!markdown) {
      // An empty result is a FAILED generation, not an empty post: there is
      // nothing to copy and nothing to render three ways.
      log.warn("Share returned no post bot={bot}", { bot: botConfig.name });
      safeWrite("app_error", {
        type: "error",
        message: "The model returned no post — nothing was generated.",
      });
      return;
    }

    log.info("Share done bot={bot} chars={chars}", {
      bot: botConfig.name,
      chars: markdown.length,
    });
    // The payload is EXACTLY the three tab strings — see `renderSharePayload`.
    //
    // Through `safeWrite`, like every other write in this runner. NOT because a
    // raw write would throw: Hono's `StreamingApi.write` wraps the writer in a
    // bare `try {} catch {}`, so `stream.writeSSE` to a departed client is a
    // silent no-op that resolves. The guard buys CONSISTENCY of the gone-client
    // discipline — one rule for every write in the family, checked against the
    // same `clientState.gone` flag `onAbort` sets, so a reader who navigated away
    // costs no render and no write rather than each site deciding for itself.
    // Ordering with the scaffold's `end` holds either way: every write goes
    // through the same underlying writable stream, which delivers chunks in call
    // order.
    safeWrite("done", renderSharePayload(markdown));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("Share failed bot={bot} error={error}", { bot: botConfig.name, error: message });
    safeWrite("app_error", {
      type: "error",
      message: `Could not write the post: ${message}`,
    });
  }
}
