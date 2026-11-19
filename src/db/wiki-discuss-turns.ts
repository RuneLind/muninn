/**
 * `wiki_discuss_turns` (migration 090): the Discuss wiki agent's turns, one row
 * per turn, grouped by `discussion_id` and keyed by wiki and page (mimir plan
 * muninn-wiki-discuss, D7). A turn is inserted `running` before the model is
 * called and finished with how it ended, whether or not its reader is still
 * there.
 */
import { getDb } from "./client.ts";

export type DiscussEndState = "running" | "done" | "error" | "timeout";

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
  endState: Exclude<DiscussEndState, "running">;
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
  finishedAt: number | null;
}

/** Another turn of the discussion took the same sequence number first. */
export class DiscussTurnConflict extends Error {
  constructor(discussionId: string) {
    super(`another turn of discussion ${discussionId} started at the same time`);
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
    finishedAt: r.finished_at ? new Date(r.finished_at as string).getTime() : null,
  };
}

/** Insert a `running` turn as the discussion's next one. Throws
 *  {@link DiscussTurnConflict} when a concurrent insert took that number. */
export async function startDiscussTurn(input: DiscussTurnStart): Promise<{ id: string; seq: number }> {
  const sql = getDb();
  try {
    const [row] = await sql`
      INSERT INTO wiki_discuss_turns
        (discussion_id, seq, wiki, rel_path, page_hash, selection, question, location, bot_name, connector, model, surface)
      SELECT ${input.discussionId}, COALESCE(MAX(seq), 0) + 1, ${input.wiki}, ${input.relPath}, ${input.pageHash},
             ${input.selection}, ${input.question}, ${input.location === null || input.location === undefined ? null : sql.json(input.location as never)},
             ${input.botName}, ${input.connector}, ${input.model}, ${sql.json((input.surface ?? {}) as never)}
      FROM wiki_discuss_turns WHERE discussion_id = ${input.discussionId}
      RETURNING id, seq`;
    return { id: row!.id as string, seq: Number(row!.seq) };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new DiscussTurnConflict(input.discussionId);
    throw err;
  }
}

/** Record how a turn ended. Only a `running` turn is finished; returns whether it was. */
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
    WHERE id = ${id} AND end_state = 'running'
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
