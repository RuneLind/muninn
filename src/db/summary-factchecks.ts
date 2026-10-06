import { getDb } from "./client.ts";
import { normalizeFactVerdict } from "../format/markdown-ast.ts";
import { parseSavedTranscriptCheck, type SavedTranscriptCheck } from "../summaries/transcript-check-saved.ts";
import { getLog } from "../logging.ts";

const log = getLog("db", "summary-factchecks");

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
  /** The transcript check over these claims (migration 081); `null` when none ran since the web check. */
  transcript: SavedTranscriptCheck | null;
  /** sha256 of the transcript that check read. */
  transcriptSha256: string | null;
}

export type SummaryFactcheckInput = Omit<SummaryFactcheck, "createdAt" | "transcript" | "transcriptSha256">;

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
  /** Absent on a database without migration 081. */
  transcript_claims?: unknown;
  transcript_sha256?: string | null;
}

function mapRow(r: Row): SummaryFactcheck {
  // A stored value the renderer cannot read is dropped with a warn, so the web
  // check on the same row still renders.
  const raw = r.transcript_claims ?? null;
  const transcript = raw === null ? null : parseSavedTranscriptCheck(raw);
  if (raw !== null && transcript === null) {
    log.warn("summary_factchecks.transcript_claims has an unreadable shape; ignoring it collection={collection} doc={doc}", {
      collection: r.collection,
      doc: r.doc_id,
    });
  }
  return {
    collection: r.collection,
    docId: r.doc_id,
    url: r.url,
    bodySha256: r.body_sha256,
    answer: r.answer,
    claims: Array.isArray(r.claims) ? r.claims : [],
    botName: r.bot_name,
    createdAt: new Date(r.created_at).getTime(),
    transcript,
    transcriptSha256: transcript ? (r.transcript_sha256 ?? null) : null,
  };
}

/**
 * Whether migration 081's two columns exist. Asked on every call rather than
 * cached, so applying the migration takes effect without a restart; the table
 * holds only hand-started checks, so the extra query is per click.
 */
export async function summaryFactcheckTranscriptColumnsPresent(): Promise<boolean> {
  const sql = getDb();
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'summary_factchecks'
      AND column_name IN ('transcript_claims', 'transcript_sha256')
  `;
  return rows[0]?.n === 2;
}

/**
 * Insert, or replace the document's earlier result. Returns the saved row.
 *
 * A replacement is a NEW claim set, so it sets the transcript check back to
 * NULL: its verdicts join by index and would pair with claims they never saw.
 * On a database without migration 081 there is nothing to clear.
 */
export async function upsertSummaryFactcheck(input: SummaryFactcheckInput): Promise<SummaryFactcheck> {
  const sql = getDb();
  const clearTranscript = await summaryFactcheckTranscriptColumnsPresent();
  const rows = clearTranscript
    ? await sql<Row[]>`
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
      created_at = EXCLUDED.created_at,
      transcript_claims = NULL,
      transcript_sha256 = NULL
    RETURNING *
  `
    : await sql<Row[]>`
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

/**
 * Save a transcript check onto the row whose claims it read. `expectClaims` is
 * that claim set: a web re-check that replaced it while the call ran makes the
 * update match nothing, and the answer is `false` rather than verdicts filed
 * against claims they were not given.
 */
export async function saveSummaryTranscriptCheck(input: {
  collection: string;
  docId: string;
  expectClaims: SavedFactcheckClaim[];
  check: SavedTranscriptCheck;
  transcriptSha256: string;
}): Promise<boolean> {
  const sql = getDb();
  const rows = await sql`
    UPDATE summary_factchecks
    SET transcript_claims = ${sql.json(input.check as never)},
        transcript_sha256 = ${input.transcriptSha256}
    WHERE collection = ${input.collection} AND doc_id = ${input.docId}
      AND claims = ${sql.json(input.expectClaims as never)}
    RETURNING doc_id
  `;
  return rows.length === 1;
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
