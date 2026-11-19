/**
 * `wiki_discuss_turns` (migration 090): the Discuss wiki agent's turns, one row
 * per turn, grouped by `discussion_id` and keyed by wiki and page (mimir plan
 * muninn-wiki-discuss, D7). A turn is inserted `running` before the model is
 * called and finished with how it ended, whether or not its reader is still
 * there. While it runs its process touches `heartbeat_at`; a `running` turn
 * whose heartbeat is older than the caller's bound belongs to a process that
 * died, and is closed as `abandoned` ({@link closeAbandonedDiscussTurns}).
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
  relPath: string;
  pageHash: string;
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
  relPath: string;
  pageHash: string;
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
    relPath: r.rel_path as string,
    pageHash: r.page_hash as string,
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
  };
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
  return closeAbandoned(getDb(), staleRunningMs, discussionId);
}

async function closeAbandoned(sql: Sql, staleRunningMs: number, discussionId?: string): Promise<string[]> {
  const rows = await sql`
    UPDATE wiki_discuss_turns SET end_state = 'abandoned', error = ${ABANDONED_ERROR}, finished_at = now()
    WHERE end_state = 'running'
      AND heartbeat_at < now() - ${staleRunningMs}::double precision * interval '1 millisecond'
      ${discussionId === undefined ? sql`` : sql`AND discussion_id = ${discussionId}`}
    RETURNING id`;
  return rows.map((r) => r.id as string);
}

/** Insert a `running` turn as the discussion's next one. One transaction:
 *  first close the discussion's turns whose heartbeat is older than
 *  `staleRunningMs` (their process died), then insert in ONE statement that
 *  refuses while the discussion still has a `running` turn. Throws
 *  {@link DiscussTurnConflict} on that refusal, and when a concurrent insert
 *  took the same number: two inserts either see each other's row or compute
 *  the same `MAX(seq) + 1` and collide on `UNIQUE (discussion_id, seq)`. */
export async function startDiscussTurn(input: DiscussTurnStart, opts: { staleRunningMs: number }): Promise<{ id: string; seq: number }> {
  const sql = getDb();
  try {
    const row = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as Sql;
      await closeAbandoned(tx, opts.staleRunningMs, input.discussionId);
      const [inserted] = await tx`
        INSERT INTO wiki_discuss_turns
          (discussion_id, seq, wiki, rel_path, page_hash, selection, question, location, bot_name, connector, model, surface)
        SELECT ${input.discussionId}, COALESCE(MAX(seq), 0) + 1, ${input.wiki}, ${input.relPath}, ${input.pageHash},
               ${input.selection}, ${input.question}, ${input.location === null || input.location === undefined ? null : tx.json(input.location as never)},
               ${input.botName}, ${input.connector}, ${input.model}, ${tx.json((input.surface ?? {}) as never)}
        FROM wiki_discuss_turns WHERE discussion_id = ${input.discussionId}
        HAVING NOT (bool_or(end_state = 'running') IS TRUE)
        RETURNING id, seq`;
      return inserted;
    });
    if (!row) throw new DiscussTurnConflict(input.discussionId, "running");
    return { id: row.id as string, seq: Number(row.seq) };
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
