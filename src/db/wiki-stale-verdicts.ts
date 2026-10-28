import { getDb } from "./client.ts";
import { assertRetentionWindow, deleteInBatches, type BatchedDeleteOption } from "./batched-delete.ts";

/**
 * CRUD for `wiki_stale_verdicts` (migration 085): the Stale check's verdicts.
 * One row per `(wiki, kind, key_hash)`, written by upsert, so a re-check or a
 * reader's Still true replaces the earlier verdict. The key hash is content
 * only (D22, `src/wiki/stale-confirm.ts`); this module never computes one.
 *
 * A reader's verdict (A5, D7) holds until its key changes: a model write on
 * a reader row's key is a no-op, and the age cleanup skips reader rows.
 */

export const STALE_VERDICT_KINDS = ["status-line", "passage", "fixed"] as const;
export type StaleVerdictKind = (typeof STALE_VERDICT_KINDS)[number];

export const STALE_VERDICTS = ["stale", "unsure", "true", "not-status", "fixed"] as const;
export type StaleVerdictValue = (typeof STALE_VERDICTS)[number];

/** The model's drafted fix (D8): update the text, or point to the home. */
export interface StaleEdit {
  old: string;
  new: string;
  /** The point-to-the-home variant: the copied status deleted, the link kept. */
  home?: string;
}

export interface StaleVerdictRow {
  wiki: string;
  kind: StaleVerdictKind;
  page: string;
  keyHash: string;
  verdict: StaleVerdictValue;
  reason: string;
  edit: StaleEdit | null;
  /** Epoch ms. */
  checkedAt: number;
  /** `model:<bot>` for a model verdict, `reader` for a Still true / Not a status. */
  checkedBy: string;
}

export type StaleVerdictInput = Omit<StaleVerdictRow, "checkedAt">;

/** Days a verdict row is kept (`retention-cleanup`). */
export const STALE_VERDICT_RETENTION_DAYS = 90;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRow(r: any): StaleVerdictRow {
  return {
    wiki: r.wiki,
    kind: r.kind,
    page: r.page,
    keyHash: r.key_hash,
    verdict: r.verdict,
    reason: r.reason ?? "",
    edit: r.edit ?? null,
    checkedAt: new Date(r.checked_at).getTime(),
    checkedBy: r.checked_by,
  };
}

export const READER_CHECKED_BY = "reader";

/** Insert or replace the verdict on `(wiki, kind, key_hash)`; `checked_at`
 *  moves to now. A model write on a reader's row changes nothing and returns
 *  the reader's row (A5). */
export async function upsertStaleVerdict(v: StaleVerdictInput): Promise<StaleVerdictRow> {
  const sql = getDb();
  const edit = v.edit ? sql.json(v.edit as never) : null;
  const [row] = await sql`
    INSERT INTO wiki_stale_verdicts (wiki, kind, page, key_hash, verdict, reason, edit, checked_by)
    VALUES (${v.wiki}, ${v.kind}, ${v.page}, ${v.keyHash}, ${v.verdict}, ${v.reason}, ${edit}, ${v.checkedBy})
    ON CONFLICT (wiki, kind, key_hash) DO UPDATE SET
      page = EXCLUDED.page,
      verdict = EXCLUDED.verdict,
      reason = EXCLUDED.reason,
      edit = EXCLUDED.edit,
      checked_by = EXCLUDED.checked_by,
      checked_at = now()
    WHERE wiki_stale_verdicts.checked_by <> ${READER_CHECKED_BY} OR EXCLUDED.checked_by = ${READER_CHECKED_BY}
    RETURNING *
  `;
  if (row) return toRow(row);
  const [kept] = await sql`SELECT * FROM wiki_stale_verdicts WHERE wiki = ${v.wiki} AND kind = ${v.kind} AND key_hash = ${v.keyHash}`;
  return toRow(kept);
}

/** The verdicts for these keys, keyed by `key_hash`. An empty key list reads nothing. */
export async function getStaleVerdicts(
  wiki: string,
  kind: StaleVerdictKind,
  keyHashes: readonly string[],
): Promise<Map<string, StaleVerdictRow>> {
  const out = new Map<string, StaleVerdictRow>();
  if (keyHashes.length === 0) return out;
  const rows = await getDb()`
    SELECT * FROM wiki_stale_verdicts
    WHERE wiki = ${wiki} AND kind = ${kind} AND key_hash = ANY(${keyHashes as string[]}::text[])
  `;
  for (const r of rows) out.set(r.key_hash, toRow(r));
  return out;
}

/** The pages that carry at least one row of `kind`: a cheap pre-check before
 *  computing keys (PR 3 reads it for `fixed`). */
export async function getStaleVerdictPages(wiki: string, kind: StaleVerdictKind): Promise<Set<string>> {
  const rows = await getDb()`SELECT DISTINCT page FROM wiki_stale_verdicts WHERE wiki = ${wiki} AND kind = ${kind}`;
  return new Set(rows.map((r) => r.page as string));
}

/** Model rows checked more than `retentionDays` ago, batched, oldest first,
 *  on `idx_wiki_stale_verdicts_checked`. A reader's row is never aged out
 *  (A5): its key changes when what it judged does, so a row whose key no page
 *  produces any more is dead weight, one row per reader click. */
export async function cleanupOldStaleVerdicts(
  retentionDays: number = STALE_VERDICT_RETENTION_DAYS,
  opts: BatchedDeleteOption = {},
): Promise<number> {
  assertRetentionWindow("cleanupOldStaleVerdicts", retentionDays);
  return deleteInBatches(opts, (sql, limit) => sql`
    DELETE FROM wiki_stale_verdicts WHERE id IN (
      SELECT id FROM wiki_stale_verdicts
      WHERE checked_at < NOW() - make_interval(days => ${retentionDays}) AND checked_by <> ${READER_CHECKED_BY}
      ORDER BY checked_at
      LIMIT ${limit}
    )
  `);
}
