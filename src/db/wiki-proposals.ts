import { getDb } from "./client.ts";

/**
 * Wiki-gardener proposals — drafted knowledge-wiki pages awaiting review.
 *
 * The gardener watcher clusters recently-ingested summaries and drafts a
 * concept/entity page (or an update to an existing one) per cluster, persisting
 * each as a row here in status `draft`. PR 1 is the proposal pipeline only —
 * proposals accumulate and are inspectable via psql; the web review gate + apply
 * step land in PR 2. Status walks draft → approved → applied | rejected | stale
 * | error.
 *
 * Dedup model (see the plan):
 *  - a partial unique index on (bot_name, topic_key) WHERE status IN
 *    ('draft','approved') prevents concurrent duplicate live proposals;
 *  - `rejected` rows form a topic skip-list (negative memory) at cluster time;
 *  - `source_docs` of `applied` rows form the consumed-doc set at harvest time.
 */

/** One source summary a proposal drew from. Stored in the `source_docs` JSONB array. */
export interface WikiProposalSourceDoc {
  collection: string;
  docId: string;
  title: string;
  url: string;
}

export type WikiProposalKind = "concept" | "entity";
export type WikiProposalMode = "create" | "update";
export type WikiProposalStatus =
  | "draft"
  | "approved"
  | "applied"
  | "rejected"
  | "stale"
  | "error";

export interface WikiProposal {
  id: string;
  botName: string;
  topicKey: string;
  kind: WikiProposalKind;
  mode: WikiProposalMode;
  targetPath: string;
  baseHash: string | null;
  draft: string;
  sourceDocs: WikiProposalSourceDoc[];
  rationale: string | null;
  status: WikiProposalStatus;
  createdAt: number;
  resolvedAt: number | null;
}

export interface InsertWikiProposalParams {
  botName: string;
  topicKey: string;
  kind: WikiProposalKind;
  mode: WikiProposalMode;
  targetPath: string;
  baseHash?: string | null;
  draft: string;
  sourceDocs: WikiProposalSourceDoc[];
  rationale?: string | null;
  status?: WikiProposalStatus;
}

/**
 * Insert a new proposal. Uses `ON CONFLICT DO NOTHING` against the partial unique
 * index (Postgres index-inference: the target columns + the same WHERE predicate),
 * so a concurrent run drafting the same live topic is a harmless no-op rather than
 * a duplicate-key error. Returns the inserted row, or `null` when the insert was
 * skipped by the conflict.
 */
export async function insertWikiProposal(
  params: InsertWikiProposalParams,
): Promise<WikiProposal | null> {
  const sql = getDb();
  const [row] = await sql`
    INSERT INTO wiki_proposals (
      bot_name, topic_key, kind, mode, target_path, base_hash, draft, source_docs, rationale, status
    ) VALUES (
      ${params.botName},
      ${params.topicKey},
      ${params.kind},
      ${params.mode},
      ${params.targetPath},
      ${params.baseHash ?? null},
      ${params.draft},
      ${sql.json(params.sourceDocs as any)},
      ${params.rationale ?? null},
      ${params.status ?? "draft"}
    )
    ON CONFLICT (bot_name, topic_key) WHERE status IN ('draft', 'approved') DO NOTHING
    RETURNING *
  `;
  return row ? mapRow(row) : null;
}

/** List a bot's proposals in a given status, newest first. */
export async function listWikiProposalsByStatus(
  botName: string,
  status: WikiProposalStatus,
): Promise<WikiProposal[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT * FROM wiki_proposals
    WHERE bot_name = ${botName} AND status = ${status}
    ORDER BY created_at DESC
  `;
  return rows.map(mapRow);
}

export async function getWikiProposalById(id: string): Promise<WikiProposal | null> {
  const sql = getDb();
  const [row] = await sql`SELECT * FROM wiki_proposals WHERE id = ${id}`;
  return row ? mapRow(row) : null;
}

/** All of a bot's proposals (every status), newest first — backs the review page. */
export async function listAllWikiProposals(botName: string): Promise<WikiProposal[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT * FROM wiki_proposals
    WHERE bot_name = ${botName}
    ORDER BY created_at DESC
  `;
  return rows.map(mapRow);
}

/** Count of a bot's proposals still awaiting review (status `draft`) — the /wiki header badge. */
export async function countDraftWikiProposals(botName: string): Promise<number> {
  const sql = getDb();
  const [row] = await sql`
    SELECT COUNT(*)::int AS n FROM wiki_proposals
    WHERE bot_name = ${botName} AND status = 'draft'
  `;
  return row ? (row.n as number) : 0;
}

/**
 * CAS the given proposal `draft → approved`. Mirrors the dev_runs claim pattern:
 * the `WHERE … AND status = 'draft'` predicate makes concurrent approvers race
 * cleanly — exactly one wins the row, the loser gets `null` (surfaced as 409).
 */
export async function approveWikiProposal(id: string): Promise<WikiProposal | null> {
  const sql = getDb();
  const [row] = await sql`
    UPDATE wiki_proposals SET status = 'approved'
    WHERE id = ${id} AND status = 'draft'
    RETURNING *
  `;
  return row ? mapRow(row) : null;
}

/** CAS `draft → rejected` (+ resolved_at). A lost race returns `null` (409). */
export async function rejectWikiProposal(id: string): Promise<WikiProposal | null> {
  const sql = getDb();
  const [row] = await sql`
    UPDATE wiki_proposals SET status = 'rejected', resolved_at = now()
    WHERE id = ${id} AND status = 'draft'
    RETURNING *
  `;
  return row ? mapRow(row) : null;
}

/**
 * CAS `approved → applied` (+ resolved_at) — the terminal transition after the
 * apply step wrote the file successfully. Only an `approved` row (the one this
 * process just claimed) can flip, so a stray double-apply is a no-op.
 */
export async function markWikiProposalApplied(id: string): Promise<WikiProposal | null> {
  const sql = getDb();
  const [row] = await sql`
    UPDATE wiki_proposals SET status = 'applied', resolved_at = now()
    WHERE id = ${id} AND status = 'approved'
    RETURNING *
  `;
  return row ? mapRow(row) : null;
}

/**
 * CAS `approved → stale` (+ resolved_at) — the target changed since drafting
 * (update-mode hash mismatch, or a create-mode path that now exists), so nothing
 * was written and the topic becomes eligible again on the next weekly run.
 */
export async function markWikiProposalStale(id: string): Promise<WikiProposal | null> {
  const sql = getDb();
  const [row] = await sql`
    UPDATE wiki_proposals SET status = 'stale', resolved_at = now()
    WHERE id = ${id} AND status = 'approved'
    RETURNING *
  `;
  return row ? mapRow(row) : null;
}

/** CAS `approved → error` (+ resolved_at) — the apply step failed unexpectedly. */
export async function markWikiProposalError(id: string): Promise<WikiProposal | null> {
  const sql = getDb();
  const [row] = await sql`
    UPDATE wiki_proposals SET status = 'error', resolved_at = now()
    WHERE id = ${id} AND status = 'approved'
    RETURNING *
  `;
  return row ? mapRow(row) : null;
}

/**
 * TopicKeys with a live (draft/approved) proposal for this bot — the cluster-time
 * skip list guarding "one topic = at most one live proposal".
 */
export async function getLiveTopicKeys(botName: string): Promise<string[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT DISTINCT topic_key FROM wiki_proposals
    WHERE bot_name = ${botName} AND status IN ('draft', 'approved')
  `;
  return rows.map((r) => r.topic_key as string);
}

/**
 * TopicKeys previously rejected for this bot — the negative-memory skip list
 * (never re-propose a rejected topic).
 */
export async function getRejectedTopicKeys(botName: string): Promise<string[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT DISTINCT topic_key FROM wiki_proposals
    WHERE bot_name = ${botName} AND status = 'rejected'
  `;
  return rows.map((r) => r.topic_key as string);
}

/**
 * Doc ids consumed by `applied` proposals — the harvest-time exclusion set, keyed
 * as `<collection>/<docId>` to match how the gardener tags window docs.
 */
export async function getConsumedDocIds(botName: string): Promise<Set<string>> {
  const sql = getDb();
  const rows = await sql`
    SELECT source_docs FROM wiki_proposals
    WHERE bot_name = ${botName} AND status = 'applied'
  `;
  const consumed = new Set<string>();
  for (const row of rows) {
    const docs = (row.source_docs ?? []) as WikiProposalSourceDoc[];
    for (const d of docs) {
      if (d?.collection && d?.docId) consumed.add(`${d.collection}/${d.docId}`);
    }
  }
  return consumed;
}

function mapRow(r: Record<string, any>): WikiProposal {
  return {
    id: r.id,
    botName: r.bot_name,
    topicKey: r.topic_key,
    kind: r.kind as WikiProposalKind,
    mode: r.mode as WikiProposalMode,
    targetPath: r.target_path,
    baseHash: r.base_hash ?? null,
    draft: r.draft,
    sourceDocs: Array.isArray(r.source_docs) ? r.source_docs : [],
    rationale: r.rationale ?? null,
    status: r.status as WikiProposalStatus,
    createdAt: new Date(r.created_at).getTime(),
    resolvedAt: r.resolved_at ? new Date(r.resolved_at).getTime() : null,
  };
}
