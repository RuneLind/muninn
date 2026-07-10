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
  /** Optional final-render hook. When set, after the terminal `done` event the
   *  helper renders the final answer markdown to HTML (via this fn, using the
   *  enriched citations seen on the `sources` event) and emits it as a trailing
   *  `answer_html` event. The wiki reader sets it so the answer shows as a
   *  formatted article in the main pane; `/research` leaves it unset (it renders
   *  client-side). A throw here is swallowed — the streamed plain text stands. */
  renderAnswerHtml?: (answer: string, citations: Citation[]) => string;
  /** Synthesis system prompt override (per-wiki framing). Unset ⇒ the research
   *  default (`SYNTHESIS_SYSTEM_PROMPT`); `/research` leaves it unset. */
  systemPrompt?: string;
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
        // Latest enriched citations from the `sources` event — reused by the
        // optional `answer_html` final render so its `[n]` markers link to the
        // same pages the `sources` payload advertised.
        let lastCitations: Citation[] = [];
        await streamResearchAnswer(
          {
            question: opts.question,
            config: opts.config,
            botConfig: opts.botConfig,
            history: opts.history,
            collections: opts.collections,
            systemPrompt: opts.systemPrompt,
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
            if (out.type === "sources") lastCitations = out.citations;
            // EventSource reserves the "error" event for connection-level failures
            // (it also fires onerror), so a same-named app event gets masked as
            // "Connection lost" on the client. Emit app errors under a distinct
            // name; the payload still carries {type:"error", message}.
            const wireEvent = out.type === "error" ? "app_error" : out.type;
            await stream.writeSSE({ event: wireEvent, data: JSON.stringify(out) });
            // After the terminal `done`, optionally emit a server-rendered
            // `answer_html` so the client can swap its streamed plain text for a
            // formatted article. Rendering must never break the turn — on a throw
            // the streamed text stands and the `end` sentinel still fires.
            if (out.type === "done" && opts.renderAnswerHtml) {
              try {
                const html = opts.renderAnswerHtml(out.answer, lastCitations);
                await stream.writeSSE({
                  event: "answer_html",
                  data: JSON.stringify({ html, cited: out.cited }),
                });
              } catch (err) {
                log.warn("answer_html render failed — keeping streamed text: {error}", {
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
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
