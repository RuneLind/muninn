/**
 * Shared SSE streaming lifecycle for research-style cited Q&A (`/api/research/ask`
 * and the wiki reader's `/api/wiki/ask`). Both routes retrieve → synthesize via
 * `streamResearchAnswer` and stream the same event names over a plain
 * `EventSource`; only their param parsing + preflight validation differ. This
 * helper owns the shared plumbing: the keep-alive heartbeat, abort cleanup, the
 * citation-enrichment hook (which must never break the answer), the EventSource
 * `error`→`app_error` masking, the terminal `end` sentinel, and the `finally`
 * teardown. Callers pass their already-resolved config and an optional `enrich`.
 */

import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";
import { streamResearchAnswer } from "../../research/ask.ts";
import type { Citation, ResearchTurn } from "../../research/answer.ts";
import { getLog } from "../../logging.ts";

const log = getLog("dashboard", "research-sse");

export interface ResearchSseOptions {
  question: string;
  config: Config;
  /** The synthesizing bot. `null` ⇒ the helper emits the "no bots" app_error. */
  botConfig: BotConfig | null;
  history: ResearchTurn[];
  collections: string[];
  /** Optional citation enricher (e.g. wiki-page linking). Wrapped in try/catch so
   *  a thrown enrichment degrades to the raw citations instead of failing the turn. */
  enrich?: (citations: Citation[]) => Promise<Citation[]>;
  /** Route-computed preflight error (unknown wiki, no collection, …). When set,
   *  the helper emits it as an `app_error` and skips retrieval/synthesis. */
  preflightError?: string | null;
}

/**
 * Run the whole SSE streaming lifecycle for one research/ask request. Never
 * throws (`streamResearchAnswer` reports failures as an `error` event, remapped
 * to `app_error` on the wire); always emits a terminal `end` sentinel so the
 * client can close deterministically.
 */
export function streamResearchSSE(c: Context, opts: ResearchSseOptions): Response {
  return streamSSE(c, async (stream) => {
    // Retrieval (≤30s) and a slow first synthesis token can leave a long gap with
    // no events; a heartbeat keeps the connection alive through any proxy with a
    // shorter idle window. The clients have no 'heartbeat' listener, so these are
    // silently ignored.
    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) return;
      stream.writeSSE({ event: "heartbeat", data: "{}" }).catch(() => { alive = false; });
    }, 30_000);
    stream.onAbort(() => { alive = false; clearInterval(heartbeat); });

    const appError = (message: string) =>
      stream.writeSSE({ event: "app_error", data: JSON.stringify({ type: "error", message }) });

    try {
      if (opts.preflightError) {
        await appError(opts.preflightError);
      } else if (!opts.botConfig) {
        await appError("No bots configured to synthesize an answer.");
      } else {
        await streamResearchAnswer(
          {
            question: opts.question,
            config: opts.config,
            botConfig: opts.botConfig,
            history: opts.history,
            collections: opts.collections,
          },
          async (event) => {
            let out: typeof event = event;
            if (event.type === "sources" && opts.enrich) {
              // Enrichment must never break the answer: on a throw, log and emit
              // the raw un-enriched citations rather than failing the whole turn.
              try {
                out = { ...event, citations: await opts.enrich(event.citations) };
              } catch (err) {
                log.warn("Citation enrichment failed — emitting raw citations: {error}", {
                  error: err instanceof Error ? err.message : String(err),
                });
                out = event;
              }
            }
            // EventSource reserves the "error" event for connection-level failures
            // (it also fires onerror), so a same-named app event gets masked as
            // "Connection lost" on the client. Emit app errors under a distinct
            // name; the payload still carries {type:"error", message}.
            const wireEvent = out.type === "error" ? "app_error" : out.type;
            await stream.writeSSE({ event: wireEvent, data: JSON.stringify(out) });
          },
        );
      }
      // Final sentinel so the client can close the EventSource deterministically.
      await stream.writeSSE({ event: "end", data: "{}" });
    } finally {
      alive = false;
      clearInterval(heartbeat);
    }
  });
}
