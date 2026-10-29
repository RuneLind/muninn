import type { Sql } from "postgres";
import { getDb } from "./client.ts";
import type { LintMeta } from "../gardener/lint-markers.ts";
import type { StaleFixEdit } from "../wiki/stale-fix.ts";
import {
  recordSourceDraftAttemptIn,
  type RecordSourceDraftAttemptParams,
} from "./source-draft-attempts.ts";

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
 *  - a partial unique index on (COALESCE(wiki_name, bot_name), topic_key) WHERE
 *    status IN ('draft','approved') prevents concurrent duplicate live proposals;
 *    legacy bot-keyed rows leave wiki_name NULL so the COALESCE collapses to
 *    bot_name (byte-identical to the old (bot_name, topic_key) index);
 *  - `rejected` rows form a topic skip-list (negative memory) at cluster time;
 *  - `source_docs` of `applied` rows form the consumed-doc set at harvest time.
 */

/** One source summary a proposal drew from. Stored in the `source_docs` JSONB array. */
export interface WikiProposalSourceDoc {
  collection: string;
  docId: string;
  title: string;
  url: string;
  /** sha256 of the saved summary fact-check's `answer` this draft was built
   *  with (`factcheckAnswerSha256`); absent when the doc had no check then. */
  factcheckSha256?: string;
}

/**
 * Body-link containment report (JSONB `contained_links`): the unresolvable body
 * `[[wikilinks]]` the persist-time guard de-linked to plain text. Stored so the
 * review gate can render an informational "N links auto-de-linked" note instead of
 * re-scanning at read time. NULL on legacy rows drafted before containment.
 */
export interface WikiProposalContainedLinks {
  delinked: string[];
}

/**
 * One existing wiki page the runner's `searchRelated` seam surfaced as related to
 * a cluster (stored in the `related_pages` JSONB array). The apply-time wire stage
 * adds an inbound `## See also` link from each still-resolving page back to the
 * newly-created page. `relPath` is resolved against the index at insert time where
 * possible (absent when the title didn't resolve at draft time). NULL column on
 * legacy rows drafted before this feature.
 */
export interface WikiProposalRelatedPage {
  title: string;
  relPath?: string;
}

/**
 * `lint` is the odd one out: it is not a DRAFTED page but a mechanical edit the
 * wiki linter computed (`src/gardener/lint-proposals.ts`) — always `update`
 * mode, always `source_docs: []`, never cataloged and never wired, because it IS
 * the wire. Its rows come in GROUPS (`group_key`).
 *
 * `stale-check` is the Stale check's fix (plan muninn-wiki-drift-check, PR 3,
 * `src/gardener/stale-proposals.ts`): drafted edits the reader sent from the
 * STALE tab, one row per page they write, grouped per changed page. Mechanical
 * like `lint` — never cataloged, never wired, no containment — but its own
 * kind and group scheme (D9, D19).
 */
export type WikiProposalKind = "concept" | "entity" | "source" | "synthesis" | "lint" | "stale-check";

/** `stale-check` rows only (`stale_meta`, migration 086): the changed page the
 *  card is about, the edits this row's draft applies (each re-applied to the
 *  page's live bytes when a later Send redrafts the group, D20), and the group
 *  this one replaced. */
export interface StaleCheckMeta {
  changed: string;
  edits: StaleFixEdit[];
  supersedes?: string | null;
}
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
  /**
   * The standalone wiki this proposal is keyed to, or NULL for a legacy bot-keyed
   * row. Consolidation-gardener `synthesis` proposals set this to the wiki name
   * (e.g. "mimir") while `botName` stays the truthful synthesis bot that drafted
   * them; every legacy flow leaves it NULL and reads only bot-keyed rows.
   */
  wikiName: string | null;
  topicKey: string;
  /**
   * The id the rows of ONE lint finding share — `lint:<check>:<12 hex>`, a
   * sha256 prefix over the check id, the sub-rule and the sorted member paths,
   * so a re-run over an unchanged wiki reproduces it. NULL on every
   * single-row proposal, which is every kind but `lint`.
   */
  groupKey: string | null;
  /** `lint` rows only: who seeded the row and which page the finding was filed
   *  against. NULL on every other kind, and on lint rows written before
   *  migration 078 — both readers degrade, see `src/gardener/lint-markers.ts`. */
  lintMeta: LintMeta | null;
  /** `stale-check` rows only; NULL (or absent) on every other kind. */
  staleMeta?: StaleCheckMeta | null;
  kind: WikiProposalKind;
  mode: WikiProposalMode;
  targetPath: string;
  baseHash: string | null;
  draft: string;
  sourceDocs: WikiProposalSourceDoc[];
  rationale: string | null;
  containedLinks: WikiProposalContainedLinks | null;
  relatedPages: WikiProposalRelatedPage[] | null;
  status: WikiProposalStatus;
  createdAt: number;
  resolvedAt: number | null;
}

export interface InsertWikiProposalParams {
  botName: string;
  /** Standalone wiki key for consolidation `synthesis` proposals; omit/NULL for
   *  legacy bot-keyed rows (see {@link WikiProposal.wikiName}). */
  wikiName?: string | null;
  topicKey: string;
  /** See {@link WikiProposal.groupKey}; omit for a single-row proposal. */
  groupKey?: string | null;
  /** See {@link WikiProposal.lintMeta}; omit for every kind but `lint`. */
  lintMeta?: LintMeta | null;
  /** See {@link WikiProposal.staleMeta}; omit for every kind but `stale-check`. */
  staleMeta?: StaleCheckMeta | null;
  kind: WikiProposalKind;
  mode: WikiProposalMode;
  targetPath: string;
  baseHash?: string | null;
  draft: string;
  sourceDocs: WikiProposalSourceDoc[];
  rationale?: string | null;
  containedLinks?: WikiProposalContainedLinks | null;
  relatedPages?: WikiProposalRelatedPage[] | null;
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
  return insertWikiProposalWith(getDb(), params);
}

async function insertWikiProposalWith(
  sql: Sql,
  params: InsertWikiProposalParams,
): Promise<WikiProposal | null> {
  const [row] = await sql`
    INSERT INTO wiki_proposals (
      bot_name, wiki_name, topic_key, group_key, lint_meta, stale_meta, kind, mode, target_path, base_hash, draft, source_docs, rationale, contained_links, related_pages, status
    ) VALUES (
      ${params.botName},
      ${params.wikiName ?? null},
      ${params.topicKey},
      ${params.groupKey ?? null},
      ${params.lintMeta ? sql.json(params.lintMeta as any) : null},
      ${params.staleMeta ? sql.json(params.staleMeta as any) : null},
      ${params.kind},
      ${params.mode},
      ${params.targetPath},
      ${params.baseHash ?? null},
      ${params.draft},
      ${sql.json(params.sourceDocs as any)},
      ${params.rationale ?? null},
      ${params.containedLinks ? sql.json(params.containedLinks as any) : null},
      ${params.relatedPages ? sql.json(params.relatedPages as any) : null},
      ${params.status ?? "draft"}
    )
    ON CONFLICT (COALESCE(wiki_name, bot_name), topic_key) WHERE status IN ('draft', 'approved') DO NOTHING
    RETURNING *
  `;
  return row ? mapRow(row) : null;
}

/** What {@link replaceDraftProposal}'s one transaction did. */
export type ReplaceDraftOutcome =
  | { outcome: "drafted"; row: WikiProposal }
  /** The old row was no longer a draft (approved, rejected, applied or already
   *  replaced meanwhile): rolled back, nothing changed. */
  | { outcome: "superseded_meanwhile" }
  /** Another live row holds the new row's key: rolled back, nothing changed.
   *  Unreachable today, kept as a defence: Redraft recomputes the key with
   *  `sourceTopicKey`, unchanged since the drafter shipped (#310), so the new
   *  key is the old row's, and while that row is a draft the partial unique
   *  index refuses any same-key competitor before it can exist. */
  | { outcome: "covered" };

class RollbackReplace extends Error {
  constructor(readonly outcome: "superseded_meanwhile" | "covered") {
    super(outcome);
  }
}

/**
 * Redraft's persist (D6): ONE transaction, because the partial unique index on
 * live rows rejects the new row while the old one is still a draft. CAS the old
 * row `draft → stale`, insert the new row, and point the doc's attempt row at
 * it. A 0-row CAS or an insert conflict rolls the whole transaction back.
 * The old row's `resolved_at` and the new row's `created_at` are the same
 * `now()`, which is how the gate tells a replaced row from a stale one
 * (`redraftReplacements`).
 */
export async function replaceDraftProposal(
  oldId: string,
  params: InsertWikiProposalParams,
  attempt: (newProposalId: string) => RecordSourceDraftAttemptParams,
): Promise<ReplaceDraftOutcome> {
  try {
    return await getDb().begin(async (_tx) => {
      const tx = _tx as unknown as Sql;
      const staled = await tx`
        UPDATE wiki_proposals SET status = 'stale', resolved_at = now()
        WHERE id = ${oldId} AND status = 'draft'
        RETURNING id
      `;
      if (staled.length !== 1) throw new RollbackReplace("superseded_meanwhile");
      const row = await insertWikiProposalWith(tx, params);
      if (!row) throw new RollbackReplace("covered");
      await recordSourceDraftAttemptIn(tx, attempt(row.id));
      return { outcome: "drafted" as const, row };
    });
  } catch (err) {
    if (err instanceof RollbackReplace) return { outcome: err.outcome };
    throw err;
  }
}

/**
 * List a bot's LEGACY (bot-keyed) proposals in a given status, newest first.
 * `AND wiki_name IS NULL` excludes consolidation `synthesis` rows that carry this
 * bot as their (truthful) synthesis bot — those surface only via the wiki-scoped
 * reads below, so a wiki-keyed draft never contaminates a bot's own flows.
 */
export async function listWikiProposalsByStatus(
  botName: string,
  status: WikiProposalStatus,
): Promise<WikiProposal[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT * FROM wiki_proposals
    WHERE bot_name = ${botName} AND wiki_name IS NULL AND status = ${status}
    ORDER BY created_at DESC
  `;
  return rows.map(mapRow);
}

export async function getWikiProposalById(id: string): Promise<WikiProposal | null> {
  const sql = getDb();
  const [row] = await sql`SELECT * FROM wiki_proposals WHERE id = ${id}`;
  return row ? mapRow(row) : null;
}

/** All of a bot's LEGACY (bot-keyed) proposals (every status), newest first —
 *  backs the bot-wiki review page. Wiki-keyed rows are excluded (see
 *  {@link listAllWikiProposalsByWiki}). */
export async function listAllWikiProposals(botName: string): Promise<WikiProposal[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT * FROM wiki_proposals
    WHERE bot_name = ${botName} AND wiki_name IS NULL
    ORDER BY created_at DESC
  `;
  return rows.map(mapRow);
}

/** Count of a bot's LEGACY proposals still awaiting review (status `draft`) — the
 *  /wiki header badge. Wiki-keyed drafts are counted per-wiki, not here. */
export async function countDraftWikiProposals(botName: string): Promise<number> {
  const sql = getDb();
  const [row] = await sql`
    SELECT COUNT(*)::int AS n FROM wiki_proposals
    WHERE bot_name = ${botName} AND wiki_name IS NULL AND status = 'draft'
  `;
  return row ? (row.n as number) : 0;
}

/** All of a standalone wiki's proposals (every status), newest first — backs the
 *  wiki-keyed review gate. The consolidation-gardener analogue of
 *  {@link listAllWikiProposals}. */
export async function listAllWikiProposalsByWiki(wikiName: string): Promise<WikiProposal[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT * FROM wiki_proposals
    WHERE wiki_name = ${wikiName}
    ORDER BY created_at DESC
  `;
  return rows.map(mapRow);
}

/** Count of a standalone wiki's proposals still awaiting review (status `draft`) —
 *  the wiki-keyed gate badge. Wiki-scoped analogue of
 *  {@link countDraftWikiProposals}. */
export async function countDraftWikiProposalsByWiki(wikiName: string): Promise<number> {
  const sql = getDb();
  const [row] = await sql`
    SELECT COUNT(*)::int AS n FROM wiki_proposals
    WHERE wiki_name = ${wikiName} AND status = 'draft'
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

/**
 * CAS `approved → draft` — the apply step REFUSED on policy (a stem collision it
 * re-checked inside the write queue), so nothing was written and the row must go
 * back to being reviewable.
 *
 * The odd one out among the terminal transitions above, deliberately: it does NOT
 * stamp `resolved_at`, because the row is not resolved — it is a draft again, with
 * Approve/Reject rendered on it and a remedy (rename one of the two pages) the
 * reviewer can act on. Leaving it `approved` strands it where the gate offers no
 * verb; flipping it to `error` burns a perfectly good draft on a policy answer.
 * `approve` never sets `resolved_at`, so there is nothing to clear here.
 */
export async function revertWikiProposalToDraft(id: string): Promise<WikiProposal | null> {
  const sql = getDb();
  const [row] = await sql`
    UPDATE wiki_proposals SET status = 'draft'
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
export async function getLiveTopicKeys(botName: string, excludeId?: string): Promise<string[]> {
  const sql = getDb();
  // `excludeId`: Redraft's pre-model check ignores ONLY the row it replaces.
  const rows = await sql`
    SELECT DISTINCT topic_key FROM wiki_proposals
    WHERE bot_name = ${botName} AND wiki_name IS NULL AND status IN ('draft', 'approved')
      ${excludeId ? sql`AND id <> ${excludeId}` : sql``}
  `;
  return rows.map((r) => r.topic_key as string);
}

/**
 * TopicKeys with a LIVE (draft/approved) proposal for this standalone wiki — the
 * consolidation gardener's cluster-time skip list. Wiki-scoped analogue of
 * {@link getLiveTopicKeys}.
 */
export async function getLiveTopicKeysByWiki(wikiName: string): Promise<string[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT DISTINCT topic_key FROM wiki_proposals
    WHERE wiki_name = ${wikiName} AND status IN ('draft', 'approved')
  `;
  return rows.map((r) => r.topic_key as string);
}

/**
 * TopicKeys with a live OR already-applied proposal for this standalone wiki —
 * the consolidation gardener's PRIMARY dedup skip list. Unlike the weekly
 * gardener (whose applied-doc harvest window retires re-proposals), the
 * consolidation gardener re-clusters PERMANENT wiki pages every run and has no
 * consumption window, so `applied` topic keys must be skipped EXPLICITLY or an
 * already-synthesized cluster would be re-proposed forever. No bot-keyed query
 * returns `applied` topic keys — this is the new query PR 3's dedup depends on.
 */
export async function getLiveOrAppliedTopicKeysByWiki(wikiName: string): Promise<string[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT DISTINCT topic_key FROM wiki_proposals
    WHERE wiki_name = ${wikiName} AND status IN ('draft', 'approved', 'applied')
  `;
  return rows.map((r) => r.topic_key as string);
}

/**
 * Public source URLs referenced by this bot's LIVE (draft/approved) `source`
 * proposals — the cross-vertical URL-dedup set for the source drafter. Since #325
 * one X URL can be captured by two verticals (extension → `x-articles`; anthropic
 * shelf's x-link species → `anthropic-summaries`) under collection-namespaced
 * `topic_key`s, so the topic-key guard alone can't catch it. Returns raw URLs (the
 * caller normalizes); empty/absent urls are dropped.
 */
export async function getLiveSourceDocUrls(botName: string, excludeId?: string): Promise<string[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT source_docs FROM wiki_proposals
    WHERE bot_name = ${botName} AND wiki_name IS NULL AND kind = 'source' AND status IN ('draft', 'approved')
      ${excludeId ? sql`AND id <> ${excludeId}` : sql``}
  `;
  const urls: string[] = [];
  for (const row of rows) {
    const docs = (row.source_docs ?? []) as WikiProposalSourceDoc[];
    for (const d of docs) {
      if (d?.url) urls.push(d.url);
    }
  }
  return urls;
}

/**
 * TopicKeys EVER rejected for this bot — the full negative-memory set. Feeds the
 * cluster-prompt HINT only (so the model can reuse a rejected topicKey instead of
 * coining a near-synonym), NOT the skip set: the skip set is TTL'd via
 * {@link getRecentlyRejectedTopicKeys}. Keep this query unfiltered — TTL-filtering
 * it would silently strip the hint of expired rejections too (informed re-try, not
 * amnesia).
 */
export async function getRejectedTopicKeys(botName: string): Promise<string[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT DISTINCT topic_key FROM wiki_proposals
    WHERE bot_name = ${botName} AND wiki_name IS NULL AND status = 'rejected'
  `;
  return rows.map((r) => r.topic_key as string);
}

/**
 * TopicKeys rejected WITHIN the last `days` — the TTL'd cluster-time SKIP set. A
 * rejection is a verdict on one draft, not a permanent verdict on the topic, so
 * only recent rejections suppress re-proposal; older ones age out and the topic
 * becomes re-proposable (a healthy 6-doc cluster no longer dies on a week-old
 * rejection every run). The cluster-prompt hint still sees ALL rejections via
 * {@link getRejectedTopicKeys}.
 *
 * NULL `resolved_at` is INTENTIONALLY excluded (SQL NULL comparison ⇒ not in the
 * skip set ⇒ treated as expired / re-tryable). `rejectWikiProposal` always stamps
 * `resolved_at`, but ad-hoc ops rows may not — the natural NULL-excludes behavior
 * is the intended one; do NOT "fix" it.
 */
export async function getRecentlyRejectedTopicKeys(
  botName: string,
  days: number,
): Promise<string[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT DISTINCT topic_key FROM wiki_proposals
    WHERE bot_name = ${botName}
      AND wiki_name IS NULL
      AND status = 'rejected'
      AND resolved_at > now() - make_interval(days => ${days})
  `;
  return rows.map((r) => r.topic_key as string);
}

/**
 * TopicKeys rejected WITHIN the last `days` for this standalone wiki — the
 * consolidation gardener's TTL'd cluster-time SKIP set. Wiki-scoped analogue of
 * {@link getRecentlyRejectedTopicKeys} (same NULL-`resolved_at`-excludes semantics).
 */
export async function getRecentlyRejectedTopicKeysByWiki(
  wikiName: string,
  days: number,
): Promise<string[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT DISTINCT topic_key FROM wiki_proposals
    WHERE wiki_name = ${wikiName}
      AND status = 'rejected'
      AND resolved_at > now() - make_interval(days => ${days})
  `;
  return rows.map((r) => r.topic_key as string);
}

/**
 * Doc ids consumed by `applied` proposals — the harvest-time exclusion set, keyed
 * as `<collection>/<docId>` to match how the gardener tags window docs.
 *
 * `kinds` (optional) narrows the scan to those proposal kinds via `kind = ANY(…)`.
 * The **weekly gardener** passes `["concept", "entity"]` so a doc that only ever
 * became an `applied` **source** page is NOT excluded from harvest — it stays
 * eligible for concept/entity synthesis (a source page and a concept page about
 * the same video are complementary, not duplicates). The backlog-crediting caller
 * (`DEFAULT_COVERAGE_DEPS`) passes NO filter, so a source-paged doc still counts
 * as covered/ingested and drops out of the ingest-backlog "queued" tail.
 */
export async function getConsumedDocIds(
  botName: string,
  kinds?: WikiProposalKind[],
): Promise<Set<string>> {
  const sql = getDb();
  const rows =
    kinds && kinds.length > 0
      ? await sql`
          SELECT source_docs FROM wiki_proposals
          WHERE bot_name = ${botName} AND wiki_name IS NULL AND status = 'applied' AND kind = ANY(${kinds})
        `
      : await sql`
          SELECT source_docs FROM wiki_proposals
          WHERE bot_name = ${botName} AND wiki_name IS NULL AND status = 'applied'
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

/**
 * Doc ids referenced by `draft` or `approved` proposals — the "pending review"
 * set for the summaries Stats coverage view. Keyed as `<collection>/<docId>` to
 * match {@link getConsumedDocIds}. A doc in this set has been clustered into a
 * live proposal but not yet applied (so it isn't consumed yet, but also isn't
 * "never clustered").
 */
export async function getPendingDocIds(botName: string): Promise<Set<string>> {
  const sql = getDb();
  const rows = await sql`
    SELECT source_docs FROM wiki_proposals
    WHERE bot_name = ${botName} AND wiki_name IS NULL AND status IN ('draft', 'approved')
  `;
  const pending = new Set<string>();
  for (const row of rows) {
    const docs = (row.source_docs ?? []) as WikiProposalSourceDoc[];
    for (const d of docs) {
      if (d?.collection && d?.docId) pending.add(`${d.collection}/${d.docId}`);
    }
  }
  return pending;
}

/**
 * Injectable consumed/pending lookups — the shared deps shape for routes that
 * partition summary docs against the proposals table (summaries Stats coverage,
 * wiki ingest backlog), so their tests can drive the sets without a DB.
 */
export interface CoverageDeps {
  getConsumed: (botName: string) => Promise<Set<string>>;
  getPending: (botName: string) => Promise<Set<string>>;
}

/** The real DB-backed {@link CoverageDeps}. */
export const DEFAULT_COVERAGE_DEPS: CoverageDeps = {
  getConsumed: getConsumedDocIds,
  getPending: getPendingDocIds,
};

/**
 * Every row of one lint group, in a STABLE order — `target_path` ASC — whatever
 * status each is in. The group endpoints' one read, and the order
 * `applyWikiProposalGroup` writes the files in, so a group that stops halfway
 * stops at the same row on every re-run.
 *
 * ⚠️ That is NOT the order the GATE renders the diffs in. The card is built from
 * `/api/wiki/proposals`, which orders by `created_at` DESC and which the client
 * then groups by key — so the reviewer reads the rows newest-first and the apply
 * writes them path-first. Nothing depends on the two agreeing (each row carries
 * its own path label and its own CAS); what would break is a reader assuming
 * "the first diff is the first file written", which is why this says so.
 *
 * **Scoped by WIKI as well as by group key**, like its two CAS siblings. A group
 * key is a hash over a check id, a sub-rule and a list of wiki-RELATIVE paths —
 * it carries no wiki identity at all, so two wikis holding `plans/a.mdx` and
 * `plans/b.mdx` mint the same key for the same finding, and a key-only verb
 * would apply one wiki's card against the other's rows. The scope is
 * `COALESCE(wiki_name, bot_name)` — the same expression the seeder writes both
 * columns from, and the one that still resolves a legacy bot-keyed row.
 */
export async function listWikiProposalsByGroup(
  wikiName: string,
  groupKey: string,
): Promise<WikiProposal[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT * FROM wiki_proposals
    WHERE COALESCE(wiki_name, bot_name) = ${wikiName} AND group_key = ${groupKey}
    ORDER BY target_path ASC
  `;
  return rows.map(mapRow);
}

/**
 * CAS every `draft` row of a group to `approved`, in one statement.
 *
 * ONE statement rather than a loop of {@link approveWikiProposal}, for the same
 * reason the single-row version is a CAS: two reviewers clicking Accept on one
 * card must not each claim half the group. The loser gets the rows the winner
 * did not take, which is `[]` — and a partial result is not a lost race but the
 * ordinary re-run shape (a group whose apply stopped mid-way leaves earlier rows
 * `applied` and later ones `approved`), so the caller re-reads the group rather
 * than reading a count.
 */
export async function approveWikiProposalGroup(
  wikiName: string,
  groupKey: string,
): Promise<WikiProposal[]> {
  const sql = getDb();
  const rows = await sql`
    UPDATE wiki_proposals SET status = 'approved'
    WHERE COALESCE(wiki_name, bot_name) = ${wikiName}
      AND group_key = ${groupKey} AND status = 'draft'
    RETURNING *
  `;
  return rows.map(mapRow);
}

/** CAS every `draft` row of a group to `rejected` (+ resolved_at). The rejected
 *  rows are what makes the group's key a SKIP LIST: `lint-proposals.ts` refuses
 *  to re-propose a group any row of which exists in any status, so a dismissal
 *  is remembered by leaving these rows in place. */
export async function rejectWikiProposalGroup(
  wikiName: string,
  groupKey: string,
): Promise<WikiProposal[]> {
  const sql = getDb();
  const rows = await sql`
    UPDATE wiki_proposals SET status = 'rejected', resolved_at = now()
    WHERE COALESCE(wiki_name, bot_name) = ${wikiName}
      AND group_key = ${groupKey} AND status = 'draft'
    RETURNING *
  `;
  return rows.map(mapRow);
}

/** One lint row, reduced to what the seeder decides with: which group it is in,
 *  which page it holds, and what state it is in. */
export interface LintGroupRow {
  groupKey: string;
  targetPath: string;
  status: WikiProposalStatus;
  /** The row's kind. The seeder's self-heal and blocked keys read `lint` rows
   *  only; its page claims read every kind (D19), so a lint run never retires a
   *  Stale check card and skips a page one holds. Absent reads as `lint`. */
  kind?: WikiProposalKind;
}

/**
 * Every GROUPED row this wiki holds (lint and Stale check), in every status,
 * with its kind — the seeder's whole input for
 * "what may I propose".
 *
 * It returns ROWS rather than a set of keys because the seeder now asks three
 * different questions of them and only one is answerable from a key:
 *
 *  - **which group keys are blocked** — a `rejected` row (Dismiss is durable, no
 *    TTL: the concept gardener's skip list ages out so a model can draft a better
 *    page next week, while a lint finding is deterministic and would come back
 *    identical forever) or a LIVE row (`draft`/`approved`, which a re-seed would
 *    duplicate). `applied`/`stale`/`error` block nothing: the remaining pages get
 *    fresh rows with fresh hashes, and the partial unique index covers live rows
 *    only, so `topic_key` cannot collide;
 *  - **which PAGES are claimed** — the `target_path` of every live row. One page
 *    may be in one live group at a time, or applying either group stales the
 *    other forever;
 *  - **which live DRAFT groups no longer match a finding** — the self-heal's
 *    input (see `seedLintProposals`).
 */
export async function listLintGroupRowsByWiki(wikiName: string): Promise<LintGroupRow[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT group_key, target_path, status, kind FROM wiki_proposals
    WHERE COALESCE(wiki_name, bot_name) = ${wikiName} AND group_key IS NOT NULL
  `;
  return rows.map((r) => ({
    groupKey: r.group_key as string,
    targetPath: r.target_path as string,
    status: r.status as WikiProposalStatus,
    kind: r.kind as WikiProposalKind,
  }));
}

export type InsertLintGroupOutcome =
  | { outcome: "inserted"; inserted: number }
  /** A live grouped row committed on a target page since the seeder's read. Nothing was written. */
  | { outcome: "held"; targetPath: string; groupKey: string };

/**
 * The lint seeder's insert of ONE finding's rows: one transaction under the
 * page-claims lock (`lockWikiPageClaims`, the lock Send's supersede takes). It
 * re-checks lint's own claim rule — any live GROUPED row on a target page,
 * the rule `seedLintProposals` read before it built the rows — and inserts
 * nothing when one holds a page, so a Send that committed after the seeder's
 * read cannot end with two live groups on one page. A row whose topic key is
 * already live is skipped as before (`ON CONFLICT DO NOTHING`).
 */
export async function insertLintGroupRows(wikiName: string, rows: readonly InsertWikiProposalParams[]): Promise<InsertLintGroupOutcome> {
  if (!rows.length) return { outcome: "inserted", inserted: 0 };
  return getDb().begin(async (_tx) => {
    const tx = _tx as unknown as Sql;
    await lockWikiPageClaims(tx, wikiName);
    const [held] = await tx`
      SELECT group_key, target_path FROM wiki_proposals
      WHERE COALESCE(wiki_name, bot_name) = ${wikiName} AND group_key IS NOT NULL
        AND status IN ('draft', 'approved') AND target_path = ANY(${rows.map((r) => r.targetPath)}::text[])
      LIMIT 1
    `;
    if (held) return { outcome: "held" as const, targetPath: held.target_path as string, groupKey: held.group_key as string };
    let inserted = 0;
    for (const r of rows) if (await insertWikiProposalWith(tx, r)) inserted += 1;
    return { outcome: "inserted" as const, inserted };
  });
}

/**
 * Retire every `draft` row of one lint group — the self-heal's write.
 *
 * `stale` rather than `rejected`: the reviewer said nothing, the FINDING changed
 * shape under the card (the cluster grew a member after a sibling fix applied),
 * and `stale` is the status this table already uses for "the draft no longer
 * describes the wiki". A `rejected` row would silence the successor group too,
 * since a dismissal is by group key and the key is what moved.
 *
 * `approved` rows are left alone: they are mid-apply, and the apply's own
 * terminal CAS owns them.
 */
export async function markLintGroupStale(wikiName: string, groupKey: string): Promise<number> {
  const sql = getDb();
  const rows = await sql`
    UPDATE wiki_proposals SET status = 'stale', resolved_at = now()
    WHERE COALESCE(wiki_name, bot_name) = ${wikiName}
      AND group_key = ${groupKey} AND status = 'draft'
    RETURNING id
  `;
  return rows.length;
}

// ── Stale check proposals (kind `stale-check`, PR 3 of muninn-wiki-drift-check) ──

/** Every `stale-check` row about one changed page, in every status, oldest
 *  first. Send reads the live group off it, and the group number. */
export async function listStaleCheckRowsByChanged(wikiName: string, changed: string): Promise<WikiProposal[]> {
  const rows = await getDb()`
    SELECT * FROM wiki_proposals
    WHERE COALESCE(wiki_name, bot_name) = ${wikiName} AND kind = 'stale-check' AND stale_meta->>'changed' = ${changed}
    ORDER BY created_at ASC, target_path ASC
  `;
  return rows.map(mapRow);
}

/** Every live (`draft`/`approved`) `stale-check` row of a wiki: the ⧗ «in
 *  review» states read them (D31). */
export async function listLiveStaleCheckRows(wikiName: string): Promise<WikiProposal[]> {
  const rows = await getDb()`
    SELECT * FROM wiki_proposals
    WHERE COALESCE(wiki_name, bot_name) = ${wikiName} AND kind = 'stale-check' AND status IN ('draft', 'approved')
    ORDER BY created_at ASC, target_path ASC
  `;
  return rows.map(mapRow);
}

/**
 * One live row that holds its page for Send and Apply: a grouped row of any
 * kind (lint, Stale check), or an ungrouped `update` row (a wiki-gardener
 * concept/entity update, a consolidation update). A write to the page would
 * stale either one, and a second live row on it would race its CAS. Ungrouped
 * `create` rows hold nothing: they name a page that does not exist yet.
 */
export interface LivePageHolder {
  id: string;
  /** Null for an ungrouped `update` row. */
  groupKey: string | null;
  topicKey: string;
  targetPath: string;
  kind: WikiProposalKind;
  status: WikiProposalStatus;
}

function mapHolder(r: Record<string, unknown>): LivePageHolder {
  return {
    id: r.id as string,
    groupKey: (r.group_key as string | null) ?? null,
    topicKey: r.topic_key as string,
    targetPath: r.target_path as string,
    kind: r.kind as WikiProposalKind,
    status: r.status as WikiProposalStatus,
  };
}

/** Every live page holder of a wiki: the page claim Send and Apply read. The
 *  lint seeder reads its own claims (`listLintGroupRowsByWiki`, grouped rows only). */
export async function listLivePageHolders(wikiName: string): Promise<LivePageHolder[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT id, group_key, topic_key, target_path, kind, status FROM wiki_proposals
    WHERE COALESCE(wiki_name, bot_name) = ${wikiName} AND status IN ('draft', 'approved') AND (group_key IS NOT NULL OR mode = 'update')
  `;
  return rows.map(mapHolder);
}

/**
 * The per-wiki lock the two writers that put grouped rows on pages take inside
 * their transaction: Send's supersede and the lint seeder's insert. Each
 * re-checks the page claims under it, so neither can insert over a row the
 * other committed after its first read. Transaction-scoped: released at
 * commit, never held across a model or network call.
 */
async function lockWikiPageClaims(tx: Sql, wikiName: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${"wiki-page-claims:" + wikiName}))`;
}

/** The group number in a `stale-check:<changed>:<n>` key, or 0. */
export function staleCheckGroupNumber(groupKey: string | null | undefined): number {
  const m = /:(\d+)$/.exec(groupKey ?? "");
  return m ? Number(m[1]) : 0;
}

export type SupersedeStaleCheckOutcome =
  | { outcome: "sent"; groupKey: string; inserted: WikiProposal[]; retired: number }
  /** The live group is not the one the redraft read: another Send or an
   *  Accept moved it. Nothing was written. */
  | { outcome: "conflict"; reason: string }
  /** A page another live holder ({@link LivePageHolder}) holds. Nothing was written. */
  | { outcome: "held"; targetPath: string; groupKey: string | null; topicKey: string; kind: WikiProposalKind };

/**
 * D20, in ONE transaction: retire the live group n (status `stale`, D28) and
 * insert group n+1 with `rows`. Send never edits an open group.
 *
 * Serialized per wiki on the page-claims lock ({@link lockWikiPageClaims}), so
 * two Sends cannot both mint group n+1 and a lint seed cannot insert on a page
 * between this check and the commit. Inside it: the live rows for `changed`
 * must be exactly `expectedLiveIds`, all `draft` (`conflict` otherwise), and no
 * target page may be held by a live page holder outside that set (`held`). `n` is one past the
 * highest group number ever used for `changed`, whatever its status, so a key
 * never names two groups.
 */
export async function supersedeStaleCheckGroup(params: {
  wikiName: string;
  changed: string;
  expectedLiveIds: readonly string[];
  rows: readonly Omit<InsertWikiProposalParams, "groupKey">[];
}): Promise<SupersedeStaleCheckOutcome> {
  const sql = getDb();
  return sql.begin(async (_tx) => {
    const tx = _tx as unknown as Sql;
    await lockWikiPageClaims(tx, params.wikiName);
    const mine = await tx`
      SELECT id, group_key, status FROM wiki_proposals
      WHERE COALESCE(wiki_name, bot_name) = ${params.wikiName} AND kind = 'stale-check' AND stale_meta->>'changed' = ${params.changed}
      FOR UPDATE
    `;
    const live = mine.filter((r) => r.status === "draft" || r.status === "approved");
    const expected = new Set(params.expectedLiveIds);
    if (live.length !== expected.size || live.some((r) => !expected.has(r.id as string) || r.status !== "draft")) {
      return { outcome: "conflict" as const, reason: "the Stale check card for this page changed meanwhile; reload and send again" };
    }
    const targets = params.rows.map((r) => r.targetPath);
    if (targets.length) {
      const holders = await tx`
        SELECT id, group_key, topic_key, target_path, kind, status FROM wiki_proposals
        WHERE COALESCE(wiki_name, bot_name) = ${params.wikiName} -- the LivePageHolder predicate, as listLivePageHolders reads it
          AND status IN ('draft', 'approved') AND (group_key IS NOT NULL OR mode = 'update')
          AND target_path = ANY(${targets as string[]}::text[])
      `;
      const held = holders.map(mapHolder).find((h) => !expected.has(h.id));
      if (held) return { outcome: "held" as const, targetPath: held.targetPath, groupKey: held.groupKey, topicKey: held.topicKey, kind: held.kind };
    }
    const n = Math.max(0, ...mine.map((r) => staleCheckGroupNumber(r.group_key as string))) + 1;
    const groupKey = `stale-check:${params.changed}:${n}`;
    const retired = live.length
      ? await tx`UPDATE wiki_proposals SET status = 'stale', resolved_at = now() WHERE id = ANY(${[...expected]}::uuid[]) AND status = 'draft' RETURNING id`
      : [];
    const inserted: WikiProposal[] = [];
    for (const r of params.rows) {
      const row = await insertWikiProposalWith(tx, { ...r, groupKey });
      if (!row) throw new Error(`stale-check insert collided on ${r.topicKey}`);
      inserted.push(row);
    }
    return { outcome: "sent" as const, groupKey, inserted, retired: retired.length };
  });
}

function mapRow(r: Record<string, any>): WikiProposal {
  return {
    id: r.id,
    botName: r.bot_name,
    wikiName: r.wiki_name ?? null,
    topicKey: r.topic_key,
    groupKey: r.group_key ?? null,
    lintMeta: (r.lint_meta ?? null) as LintMeta | null,
    staleMeta: r.stale_meta && typeof r.stale_meta.changed === "string" && Array.isArray(r.stale_meta.edits) ? (r.stale_meta as StaleCheckMeta) : null,
    kind: r.kind as WikiProposalKind,
    mode: r.mode as WikiProposalMode,
    targetPath: r.target_path,
    baseHash: r.base_hash ?? null,
    draft: r.draft,
    sourceDocs: Array.isArray(r.source_docs) ? r.source_docs : [],
    rationale: r.rationale ?? null,
    containedLinks:
      r.contained_links && Array.isArray(r.contained_links.delinked)
        ? { delinked: r.contained_links.delinked as string[] }
        : null,
    relatedPages: Array.isArray(r.related_pages)
      ? (r.related_pages as any[])
          .filter((x) => x && typeof x.title === "string")
          .map((x) => ({
            title: x.title as string,
            ...(typeof x.relPath === "string" ? { relPath: x.relPath as string } : {}),
          }))
      : null,
    status: r.status as WikiProposalStatus,
    createdAt: new Date(r.created_at).getTime(),
    resolvedAt: r.resolved_at ? new Date(r.resolved_at).getTime() : null,
  };
}

/**
 * The WHERE fragment both doc helpers below share: a bot-level (`wiki_name IS
 * NULL`) `source` proposal whose `source_docs` contains `{collection, docId}`.
 */
function sourceProposalsForDoc(collection: string, docId: string) {
  const sql = getDb();
  return sql`wiki_name IS NULL AND kind = 'source' AND source_docs @> ${sql.json([{ collection, docId }] as any)}`;
}

/** One proposal row a doc delete touched — enough for the client to name it. */
export interface DeletedSourceProposal {
  id: string;
  targetPath: string;
  status: WikiProposalStatus;
}

/**
 * The proposal side of deleting a captured doc: drop every `source` proposal this
 * bot drafted FROM that doc (`draft`, `approved`, and the terminal `rejected`/`stale`/
 * `error` rows — the doc is gone, so a rejection's negative memory has nothing left to
 * suppress), and report the `applied` ones we deliberately KEEP — an applied row is the
 * provenance of a wiki page that still exists on disk, and deleting the row would only
 * turn that page's source into an unexplained gap in the coverage view.
 *
 * Matched through `source_docs @> [{collection, docId}]` — array containment, so a
 * row naming the doc under a DIFFERENT collection does not match (probed: two
 * elements `{A,X}`,`{B,Y}` do not contain `{A,Y}`). `kind = 'source'` only: a weekly
 * gardener `concept`/`entity` draft that clustered this doc among others is left
 * alone — it is a synthesis over several sources, not a page about this one.
 */
export async function deleteSourceProposalsForDoc(
  botName: string,
  collection: string,
  docId: string,
): Promise<{ deleted: DeletedSourceProposal[]; kept: DeletedSourceProposal[] }> {
  const sql = getDb();
  const toRow = (r: Record<string, unknown>): DeletedSourceProposal => ({
    id: r.id as string,
    targetPath: r.target_path as string,
    status: r.status as WikiProposalStatus,
  });
  const kept = await sql`
    SELECT id, target_path, status FROM wiki_proposals
    WHERE bot_name = ${botName} AND status = 'applied' AND ${sourceProposalsForDoc(collection, docId)}
  `;
  const deleted = await sql`
    DELETE FROM wiki_proposals
    WHERE bot_name = ${botName} AND status <> 'applied' AND ${sourceProposalsForDoc(collection, docId)}
    RETURNING id, target_path, status
  `;
  return { deleted: deleted.map(toRow), kept: kept.map(toRow) };
}

/** One `source` proposal drafted from a captured doc, on any bot. */
export interface SourceProposalForDoc extends DeletedSourceProposal {
  bot: string;
}

/**
 * Every bot's `source` proposal drafted from one captured doc, newest first —
 * the read half of {@link deleteSourceProposalsForDoc}'s match, without its
 * bot filter.
 */
export async function getSourceProposalsForDoc(collection: string, docId: string): Promise<SourceProposalForDoc[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT id, bot_name, target_path, status FROM wiki_proposals
    WHERE ${sourceProposalsForDoc(collection, docId)}
    ORDER BY created_at DESC, id
  `;
  return rows.map((r) => ({
    id: r.id as string,
    bot: r.bot_name as string,
    targetPath: r.target_path as string,
    status: r.status as WikiProposalStatus,
  }));
}
