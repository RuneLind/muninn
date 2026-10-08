import { getDb } from "./client.ts";

/**
 * The answer store for wiki `<Question>` cards (migration 082): one row per
 * VERSION of an answer. Append-only by construction — this module has an
 * insert, reads, and ONE update: {@link markWikiAnswersExported}, which sets
 * `exported_at` and nothing else. The only other column ever set after insert
 * is `redacted_at` (an admin redact, PR 5).
 */

export interface WikiAnswerAuthor {
  /** `users.id`; null with `MUNINN_AUTH=off`, where the author is the owner's name. */
  userId: string | null;
  oid: string | null;
  navIdent: string | null;
  name: string;
}

export interface WikiAnswerVersionInput {
  answerId: string;
  version: number;
  wiki: string;
  relPath: string;
  questionId: string;
  author: WikiAnswerAuthor;
  choice: string | null;
  body: string;
  questionHash: string;
}

export interface WikiAnswerVersion extends WikiAnswerVersionInput {
  /** Epoch ms. */
  createdAt: number;
  exportedAt: number | null;
  redactedAt: number | null;
}

/** The latest version of one answer, plus how many versions it has. */
export interface LatestWikiAnswer extends WikiAnswerVersion {
  versionCount: number;
  /** Epoch ms of version 1. */
  firstCreatedAt: number;
}

/** A concurrent writer already inserted this `(answer_id, version)`. */
export class WikiAnswerVersionConflict extends Error {
  constructor(readonly answerId: string, readonly version: number) {
    super(`answer ${answerId} already has a version ${version}`);
  }
}

const ms = (v: unknown): number | null => (v == null ? null : new Date(v as string).getTime());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToVersion(r: any): WikiAnswerVersion {
  return {
    answerId: r.answer_id,
    version: r.version,
    wiki: r.wiki,
    relPath: r.rel_path,
    questionId: r.question_id,
    author: { userId: r.author_user_id, oid: r.author_oid, navIdent: r.author_nav_ident, name: r.author_name },
    choice: r.choice,
    body: r.body,
    questionHash: r.question_hash,
    createdAt: ms(r.created_at)!,
    exportedAt: ms(r.exported_at),
    redactedAt: ms(r.redacted_at),
  };
}

/**
 * Insert one version. A unique violation on `(answer_id, version)` — a second
 * writer got there first with the same next version — throws
 * {@link WikiAnswerVersionConflict}, which the route answers 409.
 */
export async function insertWikiAnswerVersion(input: WikiAnswerVersionInput): Promise<WikiAnswerVersion> {
  const sql = getDb();
  try {
    const rows = await sql`
      INSERT INTO wiki_answers (
        answer_id, version, wiki, rel_path, question_id,
        author_user_id, author_oid, author_nav_ident, author_name,
        choice, body, question_hash
      ) VALUES (
        ${input.answerId}, ${input.version}, ${input.wiki}, ${input.relPath}, ${input.questionId},
        ${input.author.userId}, ${input.author.oid}, ${input.author.navIdent}, ${input.author.name},
        ${input.choice}, ${input.body}, ${input.questionHash}
      )
      RETURNING *
    `;
    return rowToVersion(rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new WikiAnswerVersionConflict(input.answerId, input.version);
    throw err;
  }
}

/** The newest version of one answer, or null when the id names none. */
export async function getLatestWikiAnswerVersion(answerId: string): Promise<WikiAnswerVersion | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT * FROM wiki_answers WHERE answer_id = ${answerId} ORDER BY version DESC LIMIT 1
  `;
  return rows[0] ? rowToVersion(rows[0]) : null;
}

/** The latest version of every answer on one page, oldest answer first. */
export async function listLatestWikiAnswers(wiki: string, relPath: string): Promise<LatestWikiAnswer[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT * FROM (
      SELECT DISTINCT ON (answer_id)
        *,
        count(*) OVER (PARTITION BY answer_id) AS version_count,
        min(created_at) OVER (PARTITION BY answer_id) AS first_created_at
      FROM wiki_answers
      WHERE wiki = ${wiki} AND rel_path = ${relPath}
      ORDER BY answer_id, version DESC
    ) latest
    ORDER BY first_created_at, answer_id
  `;
  return rows.map((r) => ({
    ...rowToVersion(r),
    versionCount: Number(r.version_count),
    firstCreatedAt: ms(r.first_created_at)!,
  }));
}

/** Every version of the given answers, newest first within each. */
export async function listWikiAnswerVersions(answerIds: readonly string[]): Promise<WikiAnswerVersion[]> {
  if (answerIds.length === 0) return [];
  const sql = getDb();
  const rows = await sql`
    SELECT * FROM wiki_answers WHERE answer_id = ANY(${answerIds as string[]}::uuid[]) ORDER BY answer_id, version DESC
  `;
  return rows.map(rowToVersion);
}

/** The last export batch of one page: the rows of its latest `exported_at`,
 *  the newest version per answer among them, oldest answer first (the order
 *  {@link listLatestWikiAnswers} uses, so a re-copy reads like the copy). Empty when
 *  nothing on the page was ever exported. */
export async function listLastExportedWikiAnswers(wiki: string, relPath: string): Promise<WikiAnswerVersion[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT * FROM (
      SELECT DISTINCT ON (answer_id) *
      FROM wiki_answers
      WHERE wiki = ${wiki} AND rel_path = ${relPath}
        AND exported_at = (
          SELECT max(exported_at) FROM wiki_answers WHERE wiki = ${wiki} AND rel_path = ${relPath}
        )
      ORDER BY answer_id, version DESC
    ) batch
    ORDER BY (SELECT min(created_at) FROM wiki_answers f WHERE f.answer_id = batch.answer_id), answer_id
  `;
  return rows.map(rowToVersion);
}

/** One answer of a wiki, by where it points: the orphan check's input. */
export interface WikiAnswerLocation {
  answerId: string;
  relPath: string;
  questionId: string;
  authorName: string;
  /** Epoch ms of the latest version. */
  createdAt: number;
}

/** Every answer in one wiki (latest version), for the orphan check. */
export async function listWikiAnswerLocations(wiki: string): Promise<WikiAnswerLocation[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT DISTINCT ON (answer_id) answer_id, rel_path, question_id, author_name, created_at
    FROM wiki_answers WHERE wiki = ${wiki}
    ORDER BY answer_id, version DESC
  `;
  return rows.map((r) => ({
    answerId: r.answer_id,
    relPath: r.rel_path,
    questionId: r.question_id,
    authorName: r.author_name,
    createdAt: ms(r.created_at)!,
  }));
}

/**
 * Mark an export as copied: in ONE statement, set `exported_at = now()` on
 * every listed `(answer_id, version)` and on that answer's earlier versions,
 * where it is still null. `now()` is the transaction's start time, so every
 * row of one confirm shares one timestamp — the batch `again=1` finds again.
 * A version saved after the export was read is not listed and stays
 * unexported; a retried confirm marks nothing. Returns how many rows it set.
 */
export async function markWikiAnswersExported(rows: readonly (readonly [string, number])[]): Promise<number> {
  if (rows.length === 0) return 0;
  const sql = getDb();
  const ids = rows.map((r) => r[0]);
  const versions = rows.map((r) => r[1]);
  const updated = await sql`
    UPDATE wiki_answers w SET exported_at = now()
    FROM unnest(${ids as string[]}::uuid[], ${versions as number[]}::int[]) AS l(answer_id, version)
    WHERE w.answer_id = l.answer_id AND w.version <= l.version AND w.exported_at IS NULL
  `;
  return updated.count;
}
