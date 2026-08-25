/**
 * Persisting what a CHAT TURN retrieved, against the thread it retrieved it in.
 *
 * **Why the table needs this at all.** The trace's tool-span outputs are
 * truncated to a `_truncated` head, so after a refinement discussion the hits the
 * conversation actually saw are unrecoverable from the trace. `research_citations`
 * rows keyed by `thread_id` are the record, and they are what the Jira composer
 * seeds its hit set from when the draft is a turn in a conversation rather than a
 * product of pasted notes.
 *
 * **Two retrieval paths write here, and the second is the common one.** muninn's
 * own `research_knowledge` MCP tool holds decoded hits and calls
 * {@link persistThreadCitations} from its handler. But the melosys bot also
 * carries huginn's `knowledge` stdio server, and for an ordinary single-topic
 * lookup the model picks its `search_knowledge` — measured on a real thread, that
 * is what it chose, and the draft then reported «Samtalen hentet ingen kilder»
 * because nothing on that path wrote a row. {@link captureKnowledgeToolCitations}
 * closes it from the tool-RESULT seam, which every connector already funnels
 * through, so the coverage is per-connector rather than per-tool.
 *
 * **Which turn a hit belongs to is resolved, not guessed.** It used to be
 * `peekActiveTurn(botName)` — a per-BOT LIFO — on both paths, so two people
 * chatting one bot concurrently had one turn's hits written DURABLY into the
 * other's thread, later seeding the wrong Jira draft. That was accepted for a
 * single-user instance and does not survive two. {@link resolveTurnThread} now
 * takes them in order of certainty:
 *
 *  1. **The async binding** (`currentActiveTurn`) — exact. The tool-result seam
 *     runs inside the turn's own async chain, and that is the common path.
 *  2. **The per-bot stack, only when unambiguous** — for the out-of-band caller:
 *     muninn's `research_knowledge` MCP tool is served by a separate
 *     `Bun.serve` listener answering the model subprocess, so it inherits no
 *     context. With exactly one turn in flight for the bot there is nothing to
 *     be wrong about.
 *  3. **Nothing.** Two turns in flight and no binding ⇒ the row is DROPPED and
 *     logged. A missing citation costs the composer a source it can be told
 *     about; a mis-attributed one puts a colleague's search into someone else's
 *     conversation. Not writing is the cheaper error.
 *
 * Fire-and-forget in every direction. A DB failure, a parse failure or a missing
 * turn must never turn a successful retrieval into a failed tool result, and must
 * never touch the span or the turn that produced it.
 */

import { getLog } from "../logging.ts";
import { activeTurnCount, currentActiveTurn, peekActiveTurn } from "../hivemind/active-turn.ts";
import {
  insertResearchCitations,
  type ResearchCitationInsert,
} from "../db/research-citations.ts";
import { isHuginnSearchTool, parseHuginnHits } from "./huginn-hits.ts";

const log = getLog("research", "thread-citations");

/** The minimum a retrieval path must know about a hit to file it. */
export interface ThreadCitationHit {
  docId: string;
  collection: string;
  url?: string | null;
  title?: string | null;
  relevance?: number | null;
}

export interface ThreadCitationInput {
  botName: string;
  /** What was searched — nullable, and null on the tool-result path (see below). */
  question?: string | null;
  /**
   * MUNINN's own root span id when the caller has one.
   *
   * `research_knowledge` passes its own `result.traceId` — never huginn's, which
   * lives on `subSearches[].traceId`. The column is a UUID and ours is one.
   */
  traceId?: string | null;
  hits: ThreadCitationHit[];
}

/**
 * The row shaping, split out so it is testable without a DB or a live turn.
 *
 * `cited` is FALSE for every row and derived later: the assistant's reply does
 * not exist yet at this point, and unlike `/research` there are no `[n]` markers
 * to read back — a chat turn names its sources in prose, which is what
 * `seedThreadCitations` reads.
 */
export function threadCitationRows(
  input: ThreadCitationInput & { threadId: string | null },
): ResearchCitationInsert[] {
  if (!input.threadId) return [];
  return input.hits.map((hit) => ({
    botName: input.botName,
    threadId: input.threadId,
    traceId: input.traceId ?? null,
    question: input.question ?? null,
    docId: hit.docId,
    collection: hit.collection,
    url: hit.url ?? null,
    title: hit.title ?? null,
    relevance: hit.relevance ?? null,
    cited: false,
  }));
}

/**
 * Which thread these hits belong to — see the header for the ordering.
 *
 * Exported for the regression suite: the whole point is that concurrency
 * produces *no* row rather than a wrong one, and that is not observable from
 * `persistThreadCitations`, which is fire-and-forget by design.
 */
export function resolveTurnThread(botName: string): string | null {
  const bound = currentActiveTurn();
  // The bot guard is not paranoia: a bound context from a DIFFERENT bot's turn
  // would be exactly as wrong as the stack race this replaces.
  if (bound && bound.botName === botName) return bound.threadId;

  const inFlight = activeTurnCount(botName);
  if (inFlight > 1) {
    log.info(
      "Dropping thread citations: {count} turns in flight for {botName} and no bound turn",
      { botName, count: inFlight },
    );
    return null;
  }
  return peekActiveTurn(botName);
}

/** Shape + write, against the turn these hits were actually retrieved in. */
export function persistThreadCitations(input: ThreadCitationInput): void {
  const rows = threadCitationRows({ ...input, threadId: resolveTurnThread(input.botName) });
  if (rows.length === 0) return;
  void insertResearchCitations(rows).catch((err) => {
    log.warn("Failed to persist thread citations botName={botName} error={error}", {
      botName: input.botName,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * The tool-result seam: file whatever huginn's `knowledge` server just returned.
 *
 * Called from the shared connector tail (`ai/connectors/tool-span.ts`) and from
 * the claude-cli stream parser, in both cases with the FULL tool text — before
 * `truncateOutput`, which would otherwise cut the tail of a large result set in
 * half mid-block.
 *
 * `question` is deliberately null here. The seam sees only the abbreviated tool
 * input (`abbreviateInput` caps it at 500 chars and can cut mid-string), and
 * nothing on the thread path reads the column — the composer renders its
 * "searched for" line from the draft row's own `retrieval_question`. Storing a
 * possibly-truncated query as if it were the question the row was retrieved for
 * would be worse than storing nothing.
 *
 * Total by construction: an unknown tool, an unparsable result, no active turn
 * and a dead database are all the same silent no-op.
 */
export function captureKnowledgeToolCitations(
  botName: string | undefined,
  toolName: string | undefined,
  text: string | undefined,
): void {
  try {
    if (!botName || !toolName || !text) return;
    if (!isHuginnSearchTool(toolName)) return;
    const hits = parseHuginnHits(text);
    if (hits.length === 0) return;
    persistThreadCitations({ botName, hits });
  } catch (err) {
    // Never let this reach the connector — it runs inside the span-assembly tail
    // of every tool call in every chat turn.
    log.warn("Failed to capture knowledge tool citations botName={botName} error={error}", {
      botName: botName ?? "unknown",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
