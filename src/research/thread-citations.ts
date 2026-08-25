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
 * **Which turn a hit belongs to is resolved, not guessed**, and the two paths
 * resolve it differently because only one of them can be exact. It used to be
 * `peekActiveTurn(botName)` — a per-BOT LIFO — on both, so two people chatting
 * one bot concurrently had one turn's hits written DURABLY into the other's
 * thread, later seeding the wrong Jira draft. That was accepted for a
 * single-user instance and does not survive two.
 *
 * **In-band (the common path): the turn is CAPTURED, not looked up.** The
 * connector reads `currentActiveTurn()` once at entry — which is inside the
 * turn's own async chain, so it is right by construction — and hands the binding
 * down to {@link captureKnowledgeToolCitations}. Reading the async store at the
 * point of USE instead would be a trap on any connector with a shared,
 * long-lived transport: `copilot-sdk` keeps ONE client for the process, and a
 * handler dispatched from a read loop created inside the FIRST turn's scope
 * reads that turn's store, not its own. Measured in Bun — a listener registered
 * in turn B, invoked from a loop created in turn A, sees A — so every later
 * turn's hits would have been filed against the first turn's thread, with full
 * confidence and past the ambiguity guard below. That is worse than the LIFO it
 * replaced.
 *
 * **Out-of-band: `resolveActiveTurn`, best effort.** muninn's own
 * `research_knowledge` MCP tool is served by a separate `Bun.serve` listener
 * answering the model's subprocess, so there is no context to capture and no
 * binding to inherit. It falls back to the per-bot stack while that is
 * unambiguous, and otherwise writes **nothing** — a missing citation costs the
 * composer a source it can be told about; a mis-attributed one puts a
 * colleague's search into someone else's conversation. Not writing is the
 * cheaper error.
 *
 * Fire-and-forget in every direction. A DB failure, a parse failure or a missing
 * turn must never turn a successful retrieval into a failed tool result, and must
 * never touch the span or the turn that produced it.
 */

import { getLog } from "../logging.ts";
import { resolveActiveTurn, type ActiveTurnBinding } from "../hivemind/active-turn.ts";
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
 * Which thread an OUT-OF-BAND caller's hits belong to — see the header.
 *
 * Exported for the regression suite: the whole point is that concurrency
 * produces *no* row rather than a wrong one, and that is not observable from
 * `persistThreadCitations`, which is fire-and-forget by design.
 */
export function resolveTurnThread(botName: string): string | null {
  const { threadId, ambiguous } = resolveActiveTurn(botName);
  if (ambiguous) {
    log.warn(
      "Dropping thread citations: more than one thread in flight for {botName} and no captured turn",
      { botName },
    );
  }
  return threadId;
}

/**
 * Shape + write against a thread the caller already KNOWS — the in-band path.
 *
 * A `null` thread is an answer, not a miss: a turn with no thread of its own
 * files nothing, rather than falling through to a neighbour's.
 */
export function persistThreadCitationsFor(threadId: string | null, input: ThreadCitationInput): void {
  const rows = threadCitationRows({ ...input, threadId });
  if (rows.length === 0) return;
  void insertResearchCitations(rows).catch((err) => {
    log.warn("Failed to persist thread citations botName={botName} error={error}", {
      botName: input.botName,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * Shape + write for a caller with no way to know its turn — the out-of-band
 * path, which resolves best-effort and drops the row when it cannot be sure.
 */
export function persistThreadCitations(input: ThreadCitationInput): void {
  persistThreadCitationsFor(resolveTurnThread(input.botName), input);
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
  turn: ActiveTurnBinding | null,
): void {
  try {
    if (!botName || !toolName || !text) return;
    if (!isHuginnSearchTool(toolName)) return;
    const hits = parseHuginnHits(text);
    if (hits.length === 0) return;
    // The captured binding decides, and a binding for a DIFFERENT bot decides
    // "no thread" rather than deferring to the stack — that would be exactly as
    // wrong as the race this replaces.
    const threadId = turn && turn.botName === botName ? turn.threadId : null;
    persistThreadCitationsFor(threadId, { botName, hits });
  } catch (err) {
    // Never let this reach the connector — it runs inside the span-assembly tail
    // of every tool call in every chat turn.
    log.warn("Failed to capture knowledge tool citations botName={botName} error={error}", {
      botName: botName ?? "unknown",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
