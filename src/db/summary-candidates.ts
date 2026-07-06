import { getDb } from "./client.ts";

/**
 * The Candidates → Summaries inbox (Claude Learning Center, Phase B).
 *
 * The anthropic watcher discovers + scores + writes a "why" for every new item;
 * with `config.captureCandidates` on it persists each gated candidate here instead
 * of discarding it after alerting, forming a ranked, pre-annotated reading queue
 * surfaced on /summaries. status walks new → summarizing → summarized | dismissed
 * | error; `docId` links the resulting anthropic-summaries doc once summarized.
 */

export type SummaryCandidateStatus =
  | "new"
  | "summarizing"
  | "summarized"
  | "dismissed"
  | "error";

/**
 * Capture-time classification, stored so the inbox can filter one uniform column.
 * `commit`/`release`/`doc`/`blog` mirror `candidateKind()` (URL shape, anthropic
 * vertical); `x-post` tags every X candidate.
 */
export type SummaryCandidateKind = "commit" | "release" | "doc" | "blog" | "x-post";

export interface SummaryCandidate {
  id: string;
  /** Source vertical (e.g. "anthropic", "x"). */
  source: string;
  /** Canonical item URL — candidate identity together with `source`. */
  url: string;
  title: string;
  /** Where it came from inside the source ("Recent Commits to …", "Docs (llms.txt)", "X (@handle)"). */
  candidateSrc: string | null;
  /** Gate score 0–1. */
  score: number;
  why: string | null;
  status: SummaryCandidateStatus;
  /** Capture-time kind — drives the inbox filter chips. NULL for pre-migration rows. */
  kind: SummaryCandidateKind | null;
  /** Resulting anthropic-summaries doc id once summarized (Phase C/D). */
  docId: string | null;
  /**
   * Origin doc id in the source's knowledge collection — set for X (the huginn
   * `x-feed` doc id, which the summarizer fetches for content), NULL for anthropic
   * (whose summarizer resolves content by exact-URL match instead).
   */
  sourceDocId: string | null;
  /** Watcher that captured it (provenance; ON DELETE SET NULL). */
  watcherId: string | null;
  botName: string | null;
  createdAt: number;
  updatedAt: number;
}

interface UpsertCandidateParams {
  source: string;
  url: string;
  title: string;
  candidateSrc?: string | null;
  score: number;
  why?: string | null;
  /** Capture-time kind (commit/release/doc/blog for anthropic, x-post for X). */
  kind?: SummaryCandidateKind | null;
  /** Origin doc id in the source collection (x-feed doc id for X; null for anthropic). */
  sourceDocId?: string | null;
  watcherId?: string | null;
  botName?: string | null;
}

/**
 * Insert a candidate, or refresh it if a still-`new` row for the same (source,url)
 * already exists. Keeps the HIGHEST score across captures, and never resurrects a
 * row that's already been summarized/dismissed/errored (the `WHERE status = 'new'`
 * on the conflict path makes the upsert a no-op for those).
 */
export async function upsertCandidate(p: UpsertCandidateParams): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO summary_candidates (source, url, title, candidate_src, score, why, kind, source_doc_id, watcher_id, bot_name)
    VALUES (
      ${p.source}, ${p.url}, ${p.title}, ${p.candidateSrc ?? null},
      ${p.score}, ${p.why ?? null}, ${p.kind ?? null}, ${p.sourceDocId ?? null}, ${p.watcherId ?? null}, ${p.botName ?? null}
    )
    ON CONFLICT (source, url) DO UPDATE
      SET score = GREATEST(summary_candidates.score, EXCLUDED.score),
          -- Keep why/title/candidate_src paired with the WINNING (higher) score, so a
          -- later lower-score capture (an item that rolled out of last_notified_ids and
          -- re-surfaced, or a Tier-1/Tier-2 URL collision in one run) can't leave a high
          -- score wearing a low-score rationale.
          why = CASE WHEN EXCLUDED.score >= summary_candidates.score THEN EXCLUDED.why ELSE summary_candidates.why END,
          title = CASE WHEN EXCLUDED.score >= summary_candidates.score THEN EXCLUDED.title ELSE summary_candidates.title END,
          candidate_src = CASE WHEN EXCLUDED.score >= summary_candidates.score THEN EXCLUDED.candidate_src ELSE summary_candidates.candidate_src END,
          -- source_doc_id is identity-derived (a property of (source,url), not the
          -- score). Prefer the NEWEST non-null: huginn can re-index a tweet under a
          -- fresh dated doc id while the old one is evicted (x-feed caps at 5000
          -- docs), so a re-capture's id is at least as resolvable as the stored one.
          -- Never overwrite with a null.
          source_doc_id = COALESCE(EXCLUDED.source_doc_id, summary_candidates.source_doc_id),
          -- kind is identity-derived (a property of (source,url), not the score). Prefer
          -- a non-null capture value; never overwrite a stored kind with a null.
          kind = COALESCE(EXCLUDED.kind, summary_candidates.kind),
          updated_at = now()
      WHERE summary_candidates.status = 'new'
  `;
}

export async function listCandidates(
  opts: {
    /** One source ("anthropic") or several (["anthropic","x"]) — mirrors `status`. */
    source?: string | string[];
    status?: SummaryCandidateStatus | SummaryCandidateStatus[];
    botName?: string;
    limit?: number;
    /**
     * Recency cut applied ONLY to `summarized` rows: when set, drop summarized
     * rows last touched more than N days ago. Other statuses are unaffected. Off
     * by default so every other caller keeps the honest full-history contract —
     * the inbox route opts in so its 200-row cap (ordered score DESC) can't let
     * high-scoring old shelf rows crowd out low-scoring fresh `new` ones.
     */
    summarizedWithinDays?: number;
  } = {},
): Promise<SummaryCandidate[]> {
  const sql = getDb();
  const statuses =
    opts.status == null ? null : Array.isArray(opts.status) ? opts.status : [opts.status];
  const sources =
    opts.source == null ? null : Array.isArray(opts.source) ? opts.source : [opts.source];
  const rows = await sql`
    SELECT * FROM summary_candidates
    WHERE (${sources}::text[] IS NULL OR source = ANY(${sources}))
      AND (${opts.botName ?? null}::text IS NULL OR bot_name = ${opts.botName ?? null})
      AND (${statuses}::text[] IS NULL OR status = ANY(${statuses}))
      AND (
        ${opts.summarizedWithinDays ?? null}::int IS NULL
        OR status <> 'summarized'
        OR updated_at >= now() - make_interval(days => ${opts.summarizedWithinDays ?? null}::int)
      )
    ORDER BY score DESC, created_at DESC
    LIMIT ${opts.limit ?? 200}
  `;
  return rows.map(mapRow);
}

/**
 * Auto-dismiss stale non-terminal rows: `new`/`error`/`summarizing` candidates
 * with no activity for `days` are flipped to `dismissed`. Staleness is measured
 * from the LAST activity (GREATEST of created_at/updated_at), not first-seen —
 * an old capture the user just retried (fresh updated_at) must not vanish.
 * `summarizing` is included so a row wedged mid-job by a process crash (which
 * the summarize route would otherwise 409 forever) eventually clears too. One
 * cheap indexed UPDATE, run on inbox load so the backlog stays bounded
 * regardless of whether the watcher's capture cycle is currently enabled.
 * Returns the number expired.
 */
export async function expireStaleCandidates(days = 14): Promise<number> {
  const sql = getDb();
  const rows = await sql`
    UPDATE summary_candidates
    SET status = 'dismissed', updated_at = now()
    WHERE status IN ('new', 'error', 'summarizing')
      AND GREATEST(created_at, updated_at) < now() - make_interval(days => ${days})
    RETURNING id
  `;
  return rows.length;
}

export async function getCandidateById(id: string): Promise<SummaryCandidate | null> {
  const sql = getDb();
  const [row] = await sql`SELECT * FROM summary_candidates WHERE id = ${id}`;
  return row ? mapRow(row) : null;
}

/**
 * Look a candidate up by its identity `(source, url)` — the table's UNIQUE key, so
 * at most one row. Used by the watcher's auto-promote path to resolve a freshly
 * captured candidate to its persisted id + current status (the upsert returns void).
 */
export async function getCandidateBySourceUrl(
  source: string,
  url: string,
): Promise<SummaryCandidate | null> {
  const sql = getDb();
  const [row] = await sql`
    SELECT * FROM summary_candidates WHERE source = ${source} AND url = ${url}
  `;
  return row ? mapRow(row) : null;
}

/**
 * Advance a candidate's status. `docId` is recorded when summarization completes;
 * pass null (the default) to leave any existing doc_id untouched.
 */
export async function setCandidateStatus(
  id: string,
  status: SummaryCandidateStatus,
  docId: string | null = null,
): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE summary_candidates
    SET status = ${status},
        doc_id = COALESCE(${docId}, doc_id),
        updated_at = now()
    WHERE id = ${id}
  `;
}

function mapRow(r: Record<string, any>): SummaryCandidate {
  return {
    id: r.id,
    source: r.source,
    url: r.url,
    title: r.title,
    candidateSrc: r.candidate_src ?? null,
    score: typeof r.score === "number" ? r.score : Number(r.score),
    why: r.why ?? null,
    status: r.status as SummaryCandidateStatus,
    kind: (r.kind ?? null) as SummaryCandidateKind | null,
    docId: r.doc_id ?? null,
    sourceDocId: r.source_doc_id ?? null,
    watcherId: r.watcher_id ?? null,
    botName: r.bot_name ?? null,
    createdAt: new Date(r.created_at).getTime(),
    updatedAt: new Date(r.updated_at).getTime(),
  };
}
