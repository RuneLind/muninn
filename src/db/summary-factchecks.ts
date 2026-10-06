import { getDb } from "./client.ts";
import { normalizeFactVerdict } from "../format/markdown-ast.ts";

/**
 * CRUD for `summary_factchecks` — the saved result of the `/summaries` doc
 * panel's ✓ Fact check (migration 079). One row per document, keyed by
 * huginn's doc id: a re-check REPLACES the row, and only a run that reached
 * `done` writes one (the route's `onDone`), so a failed or aborted re-check
 * leaves the earlier result in place.
 */

/** One claim as saved — what the engine's `claims` + `claim_result` events carry. */
export interface SavedFactcheckClaim {
  index: number;
  title: string;
  quote?: string;
  /** ✅ / ⚠️ / ❌ / ❓ */
  verdict: string;
  /** `verified` | `unverifiable` | `timeout` | `error` | `skipped` */
  outcome: string;
  confidence?: number;
  sources: string[];
}

export interface SummaryFactcheck {
  collection: string;
  docId: string;
  url: string | null;
  bodySha256: string;
  answer: string;
  claims: SavedFactcheckClaim[];
  botName: string;
  /** Epoch ms. */
  createdAt: number;
}

export type SummaryFactcheckInput = Omit<SummaryFactcheck, "createdAt">;

/** The Latest-rail badge for one checked document. */
export interface SummaryFactcheckBadge {
  collection: string;
  docId: string;
  /** Claims with a ❌ verdict. */
  bad: number;
  /** Claims saved in total. */
  total: number;
}

interface Row {
  collection: string;
  doc_id: string;
  url: string | null;
  body_sha256: string;
  answer: string;
  claims: SavedFactcheckClaim[] | null;
  bot_name: string;
  created_at: Date | string;
}

function mapRow(r: Row): SummaryFactcheck {
  return {
    collection: r.collection,
    docId: r.doc_id,
    url: r.url,
    bodySha256: r.body_sha256,
    answer: r.answer,
    claims: Array.isArray(r.claims) ? r.claims : [],
    botName: r.bot_name,
    createdAt: new Date(r.created_at).getTime(),
  };
}

/** Insert, or replace the document's earlier result. Returns the saved row. */
export async function upsertSummaryFactcheck(input: SummaryFactcheckInput): Promise<SummaryFactcheck> {
  const sql = getDb();
  const rows = await sql<Row[]>`
    INSERT INTO summary_factchecks
      (collection, doc_id, url, body_sha256, answer, claims, bot_name, created_at)
    VALUES
      (${input.collection}, ${input.docId}, ${input.url}, ${input.bodySha256},
       ${input.answer}, ${sql.json(input.claims as never)}, ${input.botName}, now())
    ON CONFLICT (collection, doc_id) DO UPDATE SET
      url = EXCLUDED.url,
      body_sha256 = EXCLUDED.body_sha256,
      answer = EXCLUDED.answer,
      claims = EXCLUDED.claims,
      bot_name = EXCLUDED.bot_name,
      created_at = EXCLUDED.created_at
    RETURNING *
  `;
  return mapRow(rows[0]!);
}

export async function getSummaryFactcheck(collection: string, docId: string): Promise<SummaryFactcheck | null> {
  const sql = getDb();
  const rows = await sql<Row[]>`
    SELECT * FROM summary_factchecks WHERE collection = ${collection} AND doc_id = ${docId}
  `;
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Every checked document's badge, in ONE query (the table holds only
 *  hand-started checks, so it stays small). */
export async function listSummaryFactcheckBadges(): Promise<SummaryFactcheckBadge[]> {
  const sql = getDb();
  const rows = await sql<{ collection: string; doc_id: string; bad: number; total: number }[]>`
    SELECT collection, doc_id,
           (SELECT count(*) FROM jsonb_array_elements(claims) c WHERE c->>'verdict' = '❌')::int AS bad,
           jsonb_array_length(claims)::int AS total
    FROM summary_factchecks
  `;
  return rows.map((r) => ({ collection: r.collection, docId: r.doc_id, bad: r.bad, total: r.total }));
}

/**
 * The ONE definition of a correctable claim: a saved claim whose verdict is
 * ❌ (`bad`) or ⚠️ (`warn`). The gate's counts and the drafter's rider both use
 * it, so a claim the rider carries is a claim the gate counted. Takes `unknown`
 * because a JSONB value is not guaranteed to be the array it was written as.
 */
export function correctableVerdict(claim: unknown): "bad" | "warn" | null {
  if (!claim || typeof claim !== "object") return null;
  const verdict = (claim as { verdict?: unknown }).verdict;
  if (typeof verdict !== "string") return null;
  const v = normalizeFactVerdict(verdict);
  return v === "bad" || v === "warn" ? v : null;
}

/** ❌ and ⚠️ counts over a saved `claims` value; anything but an array counts nothing. */
export function countCorrectableClaims(claims: unknown): { bad: number; warn: number } {
  const counts = { bad: 0, warn: 0 };
  if (!Array.isArray(claims)) return counts;
  for (const c of claims) {
    const v = correctableVerdict(c);
    if (v) counts[v]++;
  }
  return counts;
}

/** What the `/wiki/gardener` gate needs to know about one checked document. */
export interface SummaryFactcheckMark {
  collection: string;
  docId: string;
  /** Epoch ms of the saved check. */
  checkedAt: number;
  /** Claims with a ❌ verdict. */
  bad: number;
  /** Claims with a ⚠️ verdict. */
  warn: number;
  /** sha256 hex of the saved `answer` — which check a draft was built with. */
  answerSha256: string;
}

/**
 * Every checked document's date, ❌/⚠️ counts and answer digest, in ONE query —
 * the gate's "needs a redraft" flag. The counting runs here rather than in SQL
 * so it is {@link countCorrectableClaims}, and so one malformed `claims` value
 * costs its own row's counts instead of failing the query for every row.
 */
export async function listSummaryFactcheckMarks(): Promise<SummaryFactcheckMark[]> {
  const sql = getDb();
  const rows = await sql<{ collection: string; doc_id: string; created_at: Date | string; claims: unknown; answer_sha256: string }[]>`
    SELECT collection, doc_id, created_at, claims,
           encode(sha256(convert_to(answer, 'UTF8')), 'hex') AS answer_sha256
    FROM summary_factchecks
  `;
  return rows.map((r) => ({
    collection: r.collection,
    docId: r.doc_id,
    checkedAt: new Date(r.created_at).getTime(),
    ...countCorrectableClaims(r.claims),
    answerSha256: r.answer_sha256,
  }));
}
