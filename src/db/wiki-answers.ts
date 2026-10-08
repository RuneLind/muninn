import type { Sql } from "postgres";
import { getDb } from "./client.ts";

/**
 * The answer store for wiki `<Question>` cards (migration 082): one row per
 * VERSION of an answer. Append-only by construction — this module has an
 * insert, reads, and two updates: {@link markWikiAnswersExported}, which sets
 * `exported_at` and nothing else, and {@link redactWikiAnswer} (an admin
 * redact, PR 5), which empties `body` and `choice` and sets `redacted_at`.
 * Rows leave only through {@link sweepWikiAnswerRetention} (D17), which
 * deletes whole answers.
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

/** The answer was redacted before this edit could be stored (PR 5). */
export class WikiAnswerRedacted extends Error {
  constructor(readonly answerId: string) {
    super(`answer ${answerId} was redacted`);
  }
}

/**
 * Take the per-answer write lock for the rest of the transaction. Both the
 * edit insert and the redact take it in a statement of its OWN, before any
 * read or write of the answer: under READ COMMITTED every later statement
 * takes a fresh snapshot, so the statement after the lock sees whatever the
 * other writer committed while this one waited. An UPDATE that took the lock
 * inside itself would run on a snapshot from before the wait and miss a
 * version inserted meanwhile.
 */
async function lockAnswer(tx: Sql, answerId: string): Promise<void> {
  // Hashed in the uuid's canonical text form, so `ABC…` and `abc…` — one row
  // set to every WHERE here — take one lock.
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${answerId}::uuid::text, 0))`;
}

/** A test seam: runs inside the write's transaction, after its last
 *  statement and before the commit, so a test can hold the transaction open. */
export interface WikiAnswerWriteHooks {
  beforeCommit?: () => Promise<void>;
}

/**
 * Insert one version. A unique violation on `(answer_id, version)` — a second
 * writer got there first with the same next version — throws
 * {@link WikiAnswerVersionConflict}, which the route answers 409.
 */
export async function insertWikiAnswerVersion(
  input: WikiAnswerVersionInput,
  hooks: WikiAnswerWriteHooks = {},
): Promise<WikiAnswerVersion> {
  const sql = getDb();
  try {
    return await sql.begin(async (_tx) => {
      const tx = _tx as unknown as Sql;
      await lockAnswer(tx, input.answerId);
      // Inside the lock: a redact that committed while this edit waited is seen here.
      const redacted = await tx`
        SELECT 1 FROM wiki_answers WHERE answer_id = ${input.answerId} AND redacted_at IS NOT NULL LIMIT 1
      `;
      if (redacted.length > 0) throw new WikiAnswerRedacted(input.answerId);
      // Inside the lock too: a retention sweep that deleted the answer while
      // this edit waited leaves no base version, and an edit stored then would
      // be a lone later version with its history gone.
      if (input.version > 1) {
        const base = await tx`
          SELECT 1 FROM wiki_answers WHERE answer_id = ${input.answerId} AND version = ${input.version - 1}
        `;
        if (base.length === 0) throw new WikiAnswerVersionConflict(input.answerId, input.version);
      }
      const rows = await tx`
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
      await hooks.beforeCommit?.();
      return rowToVersion(rows[0]);
    });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new WikiAnswerVersionConflict(input.answerId, input.version);
    throw err;
  }
}

/** What a redact did: how many versions the answer has, and whether every one
 *  of them was already redacted before this call. */
export interface WikiAnswerRedaction {
  versions: number;
  alreadyRedacted: boolean;
  /** Epoch ms of the answer's redaction (the first one, on a repeat). */
  redactedAt: number;
}

/**
 * Redact an answer (PR 5): empty `body`, NULL `choice` and set `redacted_at`
 * on EVERY version, keeping a first `redacted_at`. Null when the id names no
 * answer.
 */
export async function redactWikiAnswer(
  answerId: string,
  hooks: WikiAnswerWriteHooks = {},
): Promise<WikiAnswerRedaction | null> {
  const sql = getDb();
  return sql.begin(async (_tx) => {
    const tx = _tx as unknown as Sql;
    await lockAnswer(tx, answerId);
    const [before] = await tx`
      SELECT count(*)::int AS n, count(*) FILTER (WHERE redacted_at IS NULL)::int AS live
      FROM wiki_answers WHERE answer_id = ${answerId}
    `;
    if (!before || before.n === 0) return null;
    const rows = await tx`
      UPDATE wiki_answers SET body = '', choice = NULL, redacted_at = COALESCE(redacted_at, now())
      WHERE answer_id = ${answerId}
      RETURNING redacted_at
    `;
    await hooks.beforeCommit?.();
    const at = Math.min(...rows.map((r) => ms(r.redacted_at)!));
    return { versions: rows.length, alreadyRedacted: before.live === 0, redactedAt: at };
  });
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

/** One answer of a wiki whose latest version has not reached the agent yet:
 *  the orphan check's input. */
export interface WikiAnswerLocation {
  answerId: string;
  relPath: string;
  questionId: string;
  authorName: string;
  /** The latest version. */
  version: number;
  /** Epoch ms of the latest version. */
  createdAt: number;
  choice: string | null;
  body: string;
}

/**
 * Every answer in one wiki whose LATEST version is neither exported nor
 * redacted, for the orphan check. An exported answer already reached the agent
 * and a redacted one has nothing left to copy, so neither can be an orphan:
 * without this rule a plan moved to `archive/` keeps every answer it ever had
 * counted as orphaned, and the count only grows.
 */
export async function listWikiAnswerLocations(wiki: string): Promise<WikiAnswerLocation[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT * FROM (
      SELECT DISTINCT ON (answer_id) answer_id, version, rel_path, question_id, author_name, created_at,
        choice, body, exported_at, redacted_at
      FROM wiki_answers WHERE wiki = ${wiki}
      ORDER BY answer_id, version DESC
    ) latest
    WHERE exported_at IS NULL AND redacted_at IS NULL
  `;
  return rows.map((r) => ({
    answerId: r.answer_id,
    relPath: r.rel_path,
    questionId: r.question_id,
    authorName: r.author_name,
    version: r.version,
    createdAt: ms(r.created_at)!,
    choice: r.choice,
    body: r.body,
  }));
}

/**
 * Mark an export as copied: in ONE statement, set `exported_at = now()` on
 * every listed `(answer_id, version)` and on that answer's earlier versions,
 * where it is still null — but only on rows of the given page, and only for a
 * listed pair that exists there. A pair naming a version the answer does not
 * have, or an answer on another page, marks nothing. `now()` is the
 * transaction's start time, so every row of one confirm shares one timestamp —
 * the batch `again=1` finds again. A version saved after the export was read
 * is not listed and stays unexported; a retried confirm marks nothing. Returns
 * how many rows it set. Both confirms run {@link markExported}.
 */
export async function markWikiAnswersExported(
  wiki: string,
  relPath: string,
  rows: readonly (readonly [string, number])[],
): Promise<number> {
  return markExported(
    wiki,
    rows.map(([id, version]) => [id, version, relPath] as const),
  );
}

/**
 * The orphan copy's confirm: {@link markWikiAnswersExported} with each row on
 * its own page — `[answerId, version, relPath]`, the relPath the orphan check
 * reported. The caller passes only rows it verified are orphans of `wiki` right
 * now. One statement, so the whole copy shares one `exported_at`.
 */
export async function markWikiOrphanAnswersExported(
  wiki: string,
  rows: readonly (readonly [string, number, string])[],
): Promise<number> {
  return markExported(wiki, rows);
}

async function markExported(wiki: string, rows: readonly (readonly [string, number, string])[]): Promise<number> {
  if (rows.length === 0) return 0;
  const sql = getDb();
  const ids = rows.map((r) => r[0]);
  const versions = rows.map((r) => r[1]);
  const rels = rows.map((r) => r[2]);
  const updated = await sql`
    UPDATE wiki_answers w SET exported_at = now()
    FROM unnest(${ids as string[]}::uuid[], ${versions as number[]}::int[], ${rels as string[]}::text[])
      AS l(answer_id, version, rel_path)
    WHERE w.answer_id = l.answer_id AND w.version <= l.version AND w.exported_at IS NULL
      AND w.wiki = ${wiki} AND w.rel_path = l.rel_path
      AND EXISTS (
        SELECT 1 FROM wiki_answers x
        WHERE x.answer_id = l.answer_id AND x.version = l.version
          AND x.wiki = ${wiki} AND x.rel_path = l.rel_path
      )
  `;
  return updated.count;
}

/** Retention windows in days (decision D17); null ⇒ that rule is off. */
export interface WikiAnswerRetentionWindows {
  exportedDays: number | null;
  unexportedDays: number | null;
}

/** Answers deleted, per rule. An answer counts under one rule: redacted first. */
export interface WikiAnswerRetentionCounts {
  exported: number;
  unexported: number;
  redacted: number;
}

type RetentionRule = keyof WikiAnswerRetentionCounts;

export interface WikiAnswerRetentionHooks {
  /** Runs inside a per-answer transaction after its delete, before the commit. */
  beforeCommit?: () => Promise<void>;
}

const DAY_MS = 86_400_000;

/**
 * Which answers a retention rule matches, judged on the LATEST version (an
 * answer exported and then edited is unexported), and redacted when any
 * version is. `only` restricts it to one answer, for the re-check under lock.
 */
async function retentionCandidates(
  q: Sql,
  windows: WikiAnswerRetentionWindows,
  now: number,
  only: string | null,
): Promise<{ answerId: string; rule: RetentionRule }[]> {
  const exportedBefore = windows.exportedDays == null ? null : new Date(now - windows.exportedDays * DAY_MS);
  const createdBefore = windows.unexportedDays == null ? null : new Date(now - windows.unexportedDays * DAY_MS);
  const rows = await q`
    SELECT answer_id, CASE
        WHEN redacted THEN 'redacted'
        WHEN exported_at IS NOT NULL THEN 'exported'
        ELSE 'unexported'
      END AS rule
    FROM (
      SELECT DISTINCT ON (answer_id) answer_id, exported_at, created_at,
        bool_or(redacted_at IS NOT NULL) OVER (PARTITION BY answer_id) AS redacted
      FROM wiki_answers
      WHERE ${only}::uuid IS NULL OR answer_id = ${only}::uuid
      ORDER BY answer_id, version DESC
    ) latest
    WHERE redacted
      OR (exported_at < ${exportedBefore}::timestamptz)
      OR (exported_at IS NULL AND created_at < ${createdBefore}::timestamptz)
  `;
  return rows.map((r) => ({ answerId: r.answer_id, rule: r.rule as RetentionRule }));
}

/**
 * The retention sweep (D17): `wiki_answers` is a transit buffer, the page and
 * its git history are the record. Deletes every version of an answer whose
 * latest version was exported more than `exportedDays` ago, or never exported
 * and saved more than `unexportedDays` ago, and of every redacted answer. Each
 * age rule runs only when its window is set; the redacted rule when either is;
 * both null ⇒ nothing. Page-blind, so an orphaned answer (its page removed)
 * falls under the same rules.
 *
 * One transaction per answer, under {@link lockAnswer}, re-checking the rule
 * there: a single `DELETE … WHERE answer_id IN (SELECT …)` misses a version an
 * edit commits meanwhile and leaves it alone with its history gone.
 */
export async function sweepWikiAnswerRetention(
  windows: WikiAnswerRetentionWindows,
  now: number = Date.now(),
  hooks: WikiAnswerRetentionHooks = {},
): Promise<WikiAnswerRetentionCounts> {
  const counts: WikiAnswerRetentionCounts = { exported: 0, unexported: 0, redacted: 0 };
  if (windows.exportedDays == null && windows.unexportedDays == null) return counts;
  const sql = getDb();
  const candidates = await retentionCandidates(sql as unknown as Sql, windows, now, null);
  for (const { answerId } of candidates) {
    const rule = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as Sql;
      await lockAnswer(tx, answerId);
      const [still] = await retentionCandidates(tx, windows, now, answerId);
      if (!still) return null;
      await tx`DELETE FROM wiki_answers WHERE answer_id = ${answerId}`;
      await hooks.beforeCommit?.();
      return still.rule;
    });
    if (rule) counts[rule]++;
  }
  return counts;
}
