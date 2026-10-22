/**
 * SSE lifecycle for «Walk me through» (`POST /api/wiki/walkthrough`).
 *
 * Share's shape (`share-sse.ts`): the fact-check scaffold for the heartbeat, the
 * `app_error` masking, the abort-guarded writes and the terminal `end`, around ONE
 * fenced, tool-less one-shot. Unlike share nothing streams: the reply is JSON that
 * has to be parsed and quote-checked whole before any of it may be shown, so the
 * stream carries one `done` or one `app_error`.
 *
 * Every page and section check runs in the ROUTE, before this is called — after
 * `streamSSE` commits a 200 a bad request can only be an `app_error`.
 */

import type { Context } from "hono";
import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";
import type { executeOneShot } from "../../ai/one-shot.ts";
import { runFencedOneShot, FENCED_EXCLUDED_TOOLS } from "../../core/fenced-one-shot.ts";
import { SHARE_EXCLUDED_TOOLS } from "../../share/prompt.ts";
import { truncateUnits } from "../../wiki/ask-chat.ts";
import { checkQuotes, parseWalkthroughReply } from "../../wiki/walkthrough.ts";
import {
  WALKTHROUGH_ALL_DROPPED,
  WALKTHROUGH_PARSE_FAILED,
  type WalkthroughDonePayload,
} from "../../wiki/walkthrough-wire.ts";
import { makeSafeWrite, streamFactcheckScaffold, type ClientState, type SseStream } from "./factcheck-sse.ts";
import { getLog } from "../../logging.ts";

const log = getLog("dashboard", "walkthrough-sse");

/** Budget for one walkthrough: no tools and a section capped at
 *  `WALKTHROUGH_SECTION_MAX`, so one bounded completion. Share's figure. */
export const WALKTHROUGH_TIMEOUT_MS = 120_000;

/** How many walkthroughs may run at once for one page. A closed panel aborts the
 *  client but not the model call, so switching sections quickly would otherwise
 *  buy one call per click with nothing bounding it. */
export const WALKTHROUGH_MAX_INFLIGHT_PER_PAGE = 3;

/** Slack on each slot's expiry, so a process killed mid-run cannot hold a page's
 *  slots forever. Share's `SHARE_SLOT_SLACK_MS` reasoning. */
const SLOT_SLACK_MS = 30_000;

const flights = new Map<string, { id: number; expiresAt: number }[]>();
let nextFlightId = 0;

export function walkthroughFlightKey(wiki: string, relPath: string): string {
  return `${wiki}\u0000${relPath}`;
}

export type WalkthroughAcquisition = { ok: true; release: () => void } | { ok: false; expiresAtMs: number };

/** Take one of the page's slots, expired ones counted free. */
export function acquireWalkthroughFlight(key: string, now: number = Date.now()): WalkthroughAcquisition {
  const live = (flights.get(key) ?? []).filter((f) => f.expiresAt > now);
  if (live.length >= WALKTHROUGH_MAX_INFLIGHT_PER_PAGE) {
    return { ok: false, expiresAtMs: Math.min(...live.map((f) => f.expiresAt)) };
  }
  const entry = { id: nextFlightId++, expiresAt: now + WALKTHROUGH_TIMEOUT_MS + SLOT_SLACK_MS };
  flights.set(key, [...live, entry]);
  return {
    ok: true,
    release: () => {
      const rest = (flights.get(key) ?? []).filter((f) => f.id !== entry.id);
      if (rest.length) flights.set(key, rest);
      else flights.delete(key);
    },
  };
}

/** Test-only. */
export function __resetWalkthroughFlightsForTest(): void {
  flights.clear();
}

export interface WalkthroughSseOptions {
  config: Config;
  botConfig: BotConfig | null;
  systemPrompt: string;
  userPrompt: string;
  /** The section as the model saw it — what quotes are checked against. */
  sectionText: string;
  heading: string;
  runName: string;
  oneShot?: typeof executeOneShot;
  onSettled?: () => void;
}

export function streamWalkthroughSSE(c: Context, opts: WalkthroughSseOptions): Response {
  return streamFactcheckScaffold(c, {
    botConfig: opts.botConfig,
    noBotMessage: "No bots configured to write a walkthrough for this wiki.",
    run: (stream, botConfig, clientState) => runWalkthrough(stream, opts, botConfig, clientState),
    ...(opts.onSettled ? { onSettled: opts.onSettled } : {}),
  });
}

async function runWalkthrough(
  stream: SseStream,
  opts: WalkthroughSseOptions,
  botConfig: BotConfig,
  clientState: ClientState,
): Promise<void> {
  const safeWrite = makeSafeWrite(stream, clientState);
  try {
    const result = await runFencedOneShot({
      traceName: "walkthrough",
      platform: "walkthrough",
      kind: "capture",
      phase: "calling_claude",
      runName: opts.runName.length > 60 ? `${truncateUnits(opts.runName, 57)}…` : opts.runName,
      sourcePage: "/wiki",
      source: "walkthrough",
      prompt: opts.userPrompt,
      systemPrompt: opts.systemPrompt,
      config: opts.config,
      botConfig: {
        ...botConfig,
        excludedTools: [
          ...new Set([...(botConfig.excludedTools ?? []), ...FENCED_EXCLUDED_TOOLS, ...SHARE_EXCLUDED_TOOLS]),
        ],
      },
      timeoutMs: WALKTHROUGH_TIMEOUT_MS,
      ...(opts.oneShot ? { oneShot: opts.oneShot } : {}),
    });

    const parsed = parseWalkthroughReply(result.result ?? "");
    if (!parsed) {
      log.warn("Walkthrough reply was not the JSON shape bot={bot}", { bot: botConfig.name });
      safeWrite("app_error", {
        type: "error",
        code: WALKTHROUGH_PARSE_FAILED,
        message: "The model's answer could not be read — nothing to show. Try again.",
      });
      return;
    }
    const kept = checkQuotes(parsed, opts.sectionText);
    log.info("Walkthrough done bot={bot} steps={steps} quiz={quiz} dropped={dropped}", {
      bot: botConfig.name,
      steps: kept.steps.length,
      quiz: kept.quiz.length,
      dropped: kept.dropped.length,
    });
    if (kept.steps.length === 0) {
      safeWrite("app_error", {
        type: "error",
        code: WALKTHROUGH_ALL_DROPPED,
        message:
          "The model wrote steps that do not quote this section, so none of them is shown. Try again.",
      });
      return;
    }
    const payload: WalkthroughDonePayload = {
      heading: opts.heading,
      steps: kept.steps,
      quiz: kept.quiz,
      dropped: kept.dropped,
    };
    safeWrite("done", payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("Walkthrough failed bot={bot} error={error}", { bot: botConfig.name, error: message });
    safeWrite("app_error", { type: "error", message: `Could not write the walkthrough: ${message}` });
  }
}
