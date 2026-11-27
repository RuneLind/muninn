/**
 * `wiki_discuss_turns` (migration 090): the Discuss wiki agent's turns, one row
 * per turn, grouped by `discussion_id` and keyed by wiki and page (mimir plan
 * muninn-wiki-discuss, D7). A turn is inserted `running` before the model is
 * called and finished with how it ended, whether or not its reader is still
 * there. While it runs its process touches `heartbeat_at`; a `running` turn
 * whose heartbeat is older than the caller's bound belongs to a process that
 * died, and is closed as `abandoned` ({@link closeAbandonedDiscussTurns}).
 *
 * Discuss v2 (migration 094): a turn of a wiki thread carries `thread_id`
 * (the discussion id is the thread id) and the two `messages` rows it stored
 * on the thread (`user_message_id`, `assistant_message_id`, `source 'wiki'`).
 * The ledger stays the history the prompt reads; the messages are /chat's
 * mirror of it. Deleting the thread deletes its turns (CASCADE).
 */
import type postgres from "postgres";
import { getDb } from "./client.ts";

// TransactionSql loses its call signatures (src/db/CLAUDE.md): the house cast.
type Sql = postgres.Sql;

export type DiscussEndState = "running" | "done" | "error" | "timeout" | "abandoned";

export interface DiscussToolCall {
  name: string;
  /** The tool input, abbreviated. */
  input: string;
}

export interface DiscussTurnStart {
  discussionId: string;
  wiki: string;
  /** The page; null for a trace turn (PR 6), which carries `traceKey`. */
  relPath: string | null;
  pageHash: string | null;
  traceKey?: string | null;
  /** The wiki thread the turn runs on (its id is `discussionId`). */
  threadId?: string | null;
  /** The thread's user message, stored in the insert's transaction (a
   *  refused insert stores nothing). Needs `threadId`. */
  userMessage?: { userId: string; botName: string; username?: string | null; content: string } | null;
  selection: string | null;
  question: string;
  location: unknown;
  botName: string;
  connector: string;
  model: string | null;
  /** What the turn could read (snapshot keys, repos, tools). */
  surface: unknown;
}

export interface DiscussTurnFinish {
  endState: Exclude<DiscussEndState, "running" | "abandoned">;
  answer: string;
  error?: string | null;
  card?: string | null;
  toolCalls?: DiscussToolCall[];
  proposedEdit?: unknown;
  costUsd?: number | null;
  durationMs?: number | null;
}

export interface DiscussTurn {
  id: string;
  discussionId: string;
  seq: number;
  wiki: string;
  /** Null for a trace turn (PR 6): Apply refuses it, Continue names no page. */
  relPath: string | null;
  pageHash: string | null;
  traceKey: string | null;
  threadId: string | null;
  userMessageId: string | null;
  assistantMessageId: string | null;
  selection: string | null;
  question: string;
  location: unknown;
  answer: string;
  endState: DiscussEndState;
  error: string | null;
  readerLeft: boolean;
  botName: string;
  connector: string;
  model: string | null;
  surface: unknown;
  card: string | null;
  toolCalls: DiscussToolCall[];
  proposedEdit: unknown;
  costUsd: number | null;
  durationMs: number | null;
  createdAt: number;
  heartbeatAt: number;
  finishedAt: number | null;
  /** When the reader took the turn on to Claude Code (migration 091); null until then. */
  handedOverAt: number | null;
  /** When the turn's proposed edit was applied to the page (P4: `proposed_edit.appliedAt`); null until then. */
  editAppliedAt: number | null;
}

/** The discussion already has a live turn: a `running` row whose heartbeat
 *  is within the stale bound, or a concurrent insert that took the same sequence number. */
export class DiscussTurnConflict extends Error {
  constructor(discussionId: string, why: "running" | "seq" = "seq") {
    super(
      why === "running"
        ? `the discussion's last turn is still running (discussion ${discussionId})`
        : `another turn of discussion ${discussionId} started at the same time`,
    );
    this.name = "DiscussTurnConflict";
  }
}

function mapRow(r: Record<string, unknown>): DiscussTurn {
  return {
    id: r.id as string,
    discussionId: r.discussion_id as string,
    seq: Number(r.seq),
    wiki: r.wiki as string,
    relPath: (r.rel_path as string | null) ?? null,
    pageHash: (r.page_hash as string | null) ?? null,
    traceKey: (r.trace_key as string | null) ?? null,
    threadId: (r.thread_id as string | null) ?? null,
    userMessageId: (r.user_message_id as string | null) ?? null,
    assistantMessageId: (r.assistant_message_id as string | null) ?? null,
    selection: (r.selection as string | null) ?? null,
    question: r.question as string,
    location: r.location ?? null,
    answer: r.answer as string,
    endState: r.end_state as DiscussEndState,
    error: (r.error as string | null) ?? null,
    readerLeft: r.reader_left === true,
    botName: r.bot_name as string,
    connector: r.connector as string,
    model: (r.model as string | null) ?? null,
    surface: r.surface ?? {},
    card: (r.card as string | null) ?? null,
    toolCalls: (r.tool_calls as DiscussToolCall[] | null) ?? [],
    proposedEdit: r.proposed_edit ?? null,
    costUsd: r.cost_usd === null || r.cost_usd === undefined ? null : Number(r.cost_usd),
    durationMs: r.duration_ms === null || r.duration_ms === undefined ? null : Number(r.duration_ms),
    createdAt: new Date(r.created_at as string).getTime(),
    heartbeatAt: new Date((r.heartbeat_at ?? r.created_at) as string).getTime(),
    finishedAt: r.finished_at ? new Date(r.finished_at as string).getTime() : null,
    handedOverAt: r.handed_over_at ? new Date(r.handed_over_at as string).getTime() : null,
    editAppliedAt: appliedAtOf(r.proposed_edit),
  };
}

/** `proposed_edit.appliedAt` as epoch ms, or null. */
function appliedAtOf(edit: unknown): number | null {
  const at = edit && typeof edit === "object" ? (edit as { appliedAt?: unknown }).appliedAt : undefined;
  if (typeof at !== "string") return null;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

const ABANDONED_ERROR = "the turn's process stopped before it ended (no heartbeat)";

/** Close every `running` turn whose heartbeat is older than `staleRunningMs`
 *  as `abandoned`, with `finished_at` set; one discussion's when
 *  `discussionId` is given. Returns the closed turns' ids. A live turn touches
 *  its heartbeat far more often than the bound, so a closed turn is one whose
 *  process is gone or stalled past the bound (the laptop slept mid-turn, say).
 *  A stalled one may still finish later: `finishDiscussTurn` then stores the
 *  end state it is given (`done`, or `timeout`/`error` once past the route's
 *  deadline), possibly after a newer turn of the same discussion. */
export async function closeAbandonedDiscussTurns(staleRunningMs: number, discussionId?: string): Promise<string[]> {
  return getDb().begin((tx) => closeAbandoned(tx as unknown as Sql, staleRunningMs, discussionId));
}

/** The words a thread's assistant message ends with when its turn did not end done. */
export const UNFINISHED_MARK = "(unfinished)";

/** A thread turn's assistant message text when the turn did not end done. */
export function unfinishedMessage(answer: string): string {
  return answer.trim() ? `${answer.trimEnd()}\n\n${UNFINISHED_MARK}` : UNFINISHED_MARK;
}

/**
 * Lock order, everywhere a thread turn and its thread are both locked: the
 * thread row first, then the turn row. The delete takes the thread `FOR UPDATE`
 * (`src/db/threads.ts`, `cascadeDeleteThread`) before its message delete locks
 * turn rows (their message ids go `SET NULL`); a turn path takes the thread
 * `FOR KEY SHARE` before it locks or inserts a turn row or inserts a message.
 * So a message is stored either before the delete, which then deletes it, or
 * not at all (the thread is gone), never after the message delete, where the
 * thread's `ON DELETE SET NULL` would leave it with no thread. `KEY SHARE` is
 * what the message's foreign key takes anyway: it waits only on a delete.
 * Returns the ids of the threads that still exist.
 */
async function lockThreads(sql: Sql, threadIds: string[]): Promise<string[]> {
  if (threadIds.length === 0) return [];
  const rows = await sql`SELECT id FROM threads WHERE id = ANY(${threadIds}::uuid[]) ORDER BY id FOR KEY SHARE`;
  return rows.map((r) => r.id as string);
}

async function closeAbandoned(sql: Sql, staleRunningMs: number, discussionId?: string): Promise<string[]> {
  const stale = sql`end_state = 'running'
      AND heartbeat_at < now() - ${staleRunningMs}::double precision * interval '1 millisecond'
      ${discussionId === undefined ? sql`` : sql`AND discussion_id = ${discussionId}`}`;
  // The threads first (lock order above); a turn whose thread is gone is left
  // to the delete's CASCADE.
  const candidates = await sql`SELECT DISTINCT thread_id FROM wiki_discuss_turns WHERE ${stale} AND thread_id IS NOT NULL`;
  const threads = await lockThreads(sql, candidates.map((r) => r.thread_id as string));
  const rows = await sql`
    UPDATE wiki_discuss_turns SET end_state = 'abandoned', error = ${ABANDONED_ERROR}, finished_at = now()
    WHERE ${stale} AND (thread_id IS NULL OR thread_id = ANY(${threads}::uuid[]))
    RETURNING id, thread_id, answer, assistant_message_id`;
  // A thread turn gets its «(unfinished)» assistant message, so /chat shows
  // the turn ended; a turn that comes back later rewrites that message. It is
  // dated at the turn's last heartbeat, so it reads before the next turn's
  // question even when that turn's start is the transaction sweeping it.
  for (const r of rows) {
    if (r.thread_id && !r.assistant_message_id) {
      await writeAssistantMessage(sql, r.id as string, unfinishedMessage((r.answer as string) ?? ""), {}, { atHeartbeat: true });
    }
  }
  return rows.map((r) => r.id as string);
}

export interface AssistantMessageMeta {
  model?: string | null;
  costUsd?: number | null;
  durationMs?: number | null;
}

/** Insert the turn's assistant message on its thread, or rewrite the one it
 *  has; sets `assistant_message_id`. Null when the turn has no thread (or the
 *  thread, and with it the turn, is gone). Call inside a transaction; it
 *  locks the thread, then the turn row (the lock order above).
 *  `atHeartbeat` dates a new message at the turn's last heartbeat. */
async function writeAssistantMessage(
  sql: Sql,
  turnId: string,
  content: string,
  meta: AssistantMessageMeta,
  opts: { atHeartbeat?: boolean } = {},
): Promise<string | null> {
  const [ref] = await sql`SELECT thread_id FROM wiki_discuss_turns WHERE id = ${turnId}`;
  if (!ref?.thread_id) return null;
  if ((await lockThreads(sql, [ref.thread_id as string])).length === 0) return null;
  const [turn] = await sql`
    SELECT w.assistant_message_id, w.thread_id, t.user_id, t.bot_name
    FROM wiki_discuss_turns w JOIN threads t ON t.id = w.thread_id
    WHERE w.id = ${turnId}
    FOR UPDATE OF w`;
  if (!turn) return null;
  if (turn.assistant_message_id) {
    const [updated] = await sql`
      UPDATE messages SET content = ${content}, model = COALESCE(${meta.model ?? null}, model),
        cost_usd = COALESCE(${meta.costUsd ?? null}, cost_usd), duration_ms = COALESCE(${meta.durationMs ?? null}, duration_ms)
      WHERE id = ${turn.assistant_message_id as string}
      RETURNING id`;
    if (updated) return updated.id as string;
  }
  const [msg] = await sql`
    INSERT INTO messages (user_id, bot_name, role, content, model, cost_usd, duration_ms, source, platform, thread_id, created_at)
    SELECT ${turn.user_id as string}, ${turn.bot_name as string}, 'assistant', ${content}, ${meta.model ?? null},
           ${meta.costUsd ?? null}, ${meta.durationMs ?? null}, 'wiki', 'web', ${turn.thread_id as string},
           ${opts.atHeartbeat ? sql`w.heartbeat_at` : sql`now()`}
    FROM wiki_discuss_turns w WHERE w.id = ${turnId}
    RETURNING id`;
  await sql`UPDATE wiki_discuss_turns SET assistant_message_id = ${msg!.id as string} WHERE id = ${turnId}`;
  return msg!.id as string;
}

/** Store a thread turn's assistant message (the answer, its edit block
 *  replaced by the marker, «(unfinished)» when it did not end done). One
 *  transaction over the turn row, so the sweep's unfinished message and the
 *  turn's own never both land. Returns the message id, or null. */
export async function storeDiscussAssistantMessage(turnId: string, content: string, meta: AssistantMessageMeta = {}): Promise<string | null> {
  return getDb().begin((tx) => writeAssistantMessage(tx as unknown as Sql, turnId, content, meta));
}

/** Insert a `running` turn as the discussion's next one. One transaction:
 *  first close the discussion's turns whose heartbeat is older than
 *  `staleRunningMs` (their process died), then insert in ONE statement that
 *  refuses while the discussion still has a `running` turn. Throws
 *  {@link DiscussTurnConflict} on that refusal, and when a concurrent insert
 *  took the same number: two inserts either see each other's row or compute
 *  the same `MAX(seq) + 1` and collide on `UNIQUE (discussion_id, seq)`. */
export async function startDiscussTurn(input: DiscussTurnStart, opts: { staleRunningMs: number }): Promise<{ id: string; seq: number; userMessageId: string | null }> {
  const sql = getDb();
  try {
    const row = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as Sql;
      // The thread first (lock order above). A thread deleted meanwhile is
      // not locked, and the turn's insert then fails on its foreign key.
      if (input.threadId) await lockThreads(tx, [input.threadId]);
      await closeAbandoned(tx, opts.staleRunningMs, input.discussionId);
      const [inserted] = await tx`
        INSERT INTO wiki_discuss_turns
          (discussion_id, seq, wiki, rel_path, page_hash, trace_key, thread_id, selection, question, location, bot_name, connector, model, surface)
        SELECT ${input.discussionId}, COALESCE(MAX(seq), 0) + 1, ${input.wiki}, ${input.relPath}, ${input.pageHash},
               ${input.traceKey ?? null}, ${input.threadId ?? null},
               ${input.selection}, ${input.question}, ${input.location === null || input.location === undefined ? null : tx.json(input.location as never)},
               ${input.botName}, ${input.connector}, ${input.model}, ${tx.json((input.surface ?? {}) as never)}
        FROM wiki_discuss_turns WHERE discussion_id = ${input.discussionId}
        HAVING NOT (bool_or(end_state = 'running') IS TRUE)
        RETURNING id, seq`;
      if (!inserted) return null;
      let userMessageId: string | null = null;
      const um = input.userMessage;
      if (um && input.threadId) {
        const [msg] = await tx`
          INSERT INTO messages (user_id, bot_name, username, role, content, source, platform, thread_id)
          VALUES (${um.userId}, ${um.botName}, ${um.username ?? null}, 'user', ${um.content}, 'wiki', 'web', ${input.threadId})
          RETURNING id`;
        userMessageId = msg!.id as string;
        await tx`UPDATE wiki_discuss_turns SET user_message_id = ${userMessageId} WHERE id = ${inserted.id as string}`;
      }
      return { id: inserted.id as string, seq: Number(inserted.seq), userMessageId };
    });
    if (!row) throw new DiscussTurnConflict(input.discussionId, "running");
    return row;
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new DiscussTurnConflict(input.discussionId);
    throw err;
  }
}

/** The running turn is alive: move its heartbeat to now. */
export async function touchDiscussTurn(id: string): Promise<void> {
  await getDb()`UPDATE wiki_discuss_turns SET heartbeat_at = now() WHERE id = ${id} AND end_state = 'running'`;
}

/** Record how a turn ended. Only a `running` turn is finished, or an
 *  `abandoned` one: a turn whose process stalled past the bound and came back
 *  still stores its result. Returns whether the row was finished. */
export async function finishDiscussTurn(id: string, f: DiscussTurnFinish): Promise<boolean> {
  const sql = getDb();
  const rows = await sql`
    UPDATE wiki_discuss_turns SET
      end_state = ${f.endState},
      answer = ${f.answer},
      error = ${f.error ?? null},
      card = COALESCE(${f.card ?? null}, card),
      tool_calls = ${sql.json((f.toolCalls ?? []) as never)},
      proposed_edit = ${f.proposedEdit === null || f.proposedEdit === undefined ? null : sql.json(f.proposedEdit as never)},
      cost_usd = ${f.costUsd ?? null},
      duration_ms = ${f.durationMs ?? null},
      finished_at = now()
    WHERE id = ${id} AND end_state IN ('running', 'abandoned')
    RETURNING id`;
  return rows.length > 0;
}

/** The turn's reader closed the stream before the turn ended. */
export async function markDiscussReaderLeft(id: string): Promise<void> {
  await getDb()`UPDATE wiki_discuss_turns SET reader_left = true WHERE id = ${id}`;
}

/** Store the card a turn's pack carried, as soon as it is built, so a later
 *  turn on the same page hash reuses it even when this turn fails. */
export async function setDiscussTurnCard(id: string, card: string): Promise<void> {
  await getDb()`UPDATE wiki_discuss_turns SET card = ${card} WHERE id = ${id}`;
}

/** A discussion's turns, oldest first. */
export async function listDiscussTurns(discussionId: string): Promise<DiscussTurn[]> {
  const rows = await getDb()`SELECT * FROM wiki_discuss_turns WHERE discussion_id = ${discussionId} ORDER BY seq`;
  return rows.map(mapRow);
}

export async function getDiscussTurn(id: string): Promise<DiscussTurn | null> {
  const [row] = await getDb()`SELECT * FROM wiki_discuss_turns WHERE id = ${id}`;
  return row ? mapRow(row) : null;
}

/** The reader took the turn on to Claude Code («Continue in Claude Code»,
 *  P3). Sets `handed_over_at` the first time only: a second hand-over keeps
 *  the first moment. Returns the turn, or null when there is no such turn. */
export async function markDiscussTurnHandedOver(id: string): Promise<DiscussTurn | null> {
  const [row] = await getDb()`
    UPDATE wiki_discuss_turns SET handed_over_at = COALESCE(handed_over_at, now())
    WHERE id = ${id}
    RETURNING *`;
  return row ? mapRow(row) : null;
}

/** The turn's proposed edit is claimed for the page (P4's Apply, inside the
 *  wiki's write section, before the write: the conditional update is what
 *  lets one turn's edit be written at most once). Recorded in
 *  the edit itself, as `proposed_edit.appliedAt` (no column of its own: the
 *  use count reads it beside `handed_over_at`), the first time only. Returns
 *  the turn, or null when there is no such turn or it carries no edit. */
export async function markDiscussEditApplied(id: string): Promise<DiscussTurn | null> {
  const [row] = await getDb()`
    UPDATE wiki_discuss_turns
    SET proposed_edit = proposed_edit || jsonb_build_object('appliedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    WHERE id = ${id} AND proposed_edit IS NOT NULL AND jsonb_typeof(proposed_edit) = 'object' AND NOT (proposed_edit ? 'appliedAt')
    RETURNING *`;
  return row ? mapRow(row) : null;
}

/** Undo {@link markDiscussEditApplied} when the write it claimed the turn for
 *  did not happen. Only the claim stamped `appliedAt` is removed, so a later
 *  claim is never undone. True when the claim was released. */
export async function releaseDiscussEditClaim(id: string, appliedAt: string): Promise<boolean> {
  const rows = await getDb()`
    UPDATE wiki_discuss_turns SET proposed_edit = proposed_edit - 'appliedAt'
    WHERE id = ${id} AND jsonb_typeof(proposed_edit) = 'object' AND proposed_edit->>'appliedAt' = ${appliedAt}
    RETURNING id`;
  return rows.length > 0;
}

/** A page's old one-shot turns (v1, `thread_id IS NULL`), oldest first: read-only history. */
export async function listPageOneShotTurns(wiki: string, relPath: string): Promise<DiscussTurn[]> {
  const rows = await getDb()`
    SELECT * FROM wiki_discuss_turns
    WHERE wiki = ${wiki} AND rel_path = ${relPath} AND thread_id IS NULL
    ORDER BY created_at, seq`;
  return rows.map(mapRow);
}

export interface ThreadMessageWithTurn {
  id: string;
  role: "user" | "assistant" | "peer";
  content: string;
  createdAt: number;
  /** The stored message's model (an answer's: the one the connector reported); null for none. */
  model: string | null;
  /** The stored message's duration in ms; null for none. */
  durationMs: number | null;
  /** The ledger row this message mirrors (its edit card keys on `turn.id`); null for none. */
  turn: DiscussTurn | null;
}

/** A closed thread's messages as «Earlier discussions» shows them: no ledger row. */
export interface ClosedThreadMessage {
  id: string;
  role: "user" | "assistant" | "peer";
  content: string;
  createdAt: number;
}

/** The first `perThread` messages of each of `threadIds`, in the order
 *  {@link listThreadMessagesWithTurns} gives them, and each thread's total
 *  count, in one query. A thread with no messages maps to none and total 0. */
export async function listClosedThreadMessages(threadIds: string[], perThread: number): Promise<Map<string, { messages: ClosedThreadMessage[]; total: number }>> {
  const out = new Map<string, { messages: ClosedThreadMessage[]; total: number }>();
  for (const id of threadIds) out.set(id, { messages: [], total: 0 });
  if (threadIds.length === 0) return out;
  const rows = await getDb()`
    SELECT thread_id, id, role, content, created_at, total FROM (
      SELECT m.thread_id, m.id, m.role, m.content, m.created_at,
        row_number() OVER (PARTITION BY m.thread_id ORDER BY w.seq NULLS LAST, (m.role = 'user') DESC, m.created_at, m.id) AS rn,
        count(*) OVER (PARTITION BY m.thread_id) AS total
      FROM messages m
      LEFT JOIN wiki_discuss_turns w ON w.thread_id = m.thread_id AND (w.user_message_id = m.id OR w.assistant_message_id = m.id)
      WHERE m.thread_id = ANY(${threadIds}::uuid[])
    ) x
    WHERE rn <= ${perThread}
    ORDER BY thread_id, rn`;
  for (const r of rows) {
    const slot = out.get(r.thread_id as string);
    if (!slot) continue;
    slot.total = Number(r.total);
    slot.messages.push({ id: r.id as string, role: r.role as ClosedThreadMessage["role"], content: r.content as string, createdAt: new Date(r.created_at as string).getTime() });
  }
  return out;
}

/** A wiki thread's messages, oldest first, each joined to its ledger row:
 *  in turn order, a turn's question before its answer (a sweep's message and
 *  the next question can share a time); a message with no turn last. */
export async function listThreadMessagesWithTurns(threadId: string): Promise<ThreadMessageWithTurn[]> {
  const rows = await getDb()`
    SELECT m.id AS m_id, m.role AS m_role, m.content AS m_content, m.created_at AS m_created_at, m.model AS m_model, m.duration_ms AS m_duration_ms, w.*
    FROM messages m
    LEFT JOIN wiki_discuss_turns w ON w.thread_id = m.thread_id AND (w.user_message_id = m.id OR w.assistant_message_id = m.id)
    WHERE m.thread_id = ${threadId}
    ORDER BY w.seq NULLS LAST, (m.role = 'user') DESC, m.created_at, m.id`;
  return rows.map((r) => ({
    id: r.m_id as string,
    role: r.m_role as ThreadMessageWithTurn["role"],
    content: r.m_content as string,
    createdAt: new Date(r.m_created_at as string).getTime(),
    model: (r.m_model as string | null) ?? null,
    durationMs: r.m_duration_ms === null || r.m_duration_ms === undefined ? null : Number(r.m_duration_ms),
    turn: r.id ? mapRow(r) : null,
  }));
}
