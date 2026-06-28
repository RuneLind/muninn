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

export interface SummaryCandidate {
  id: string;
  /** Source vertical (e.g. "anthropic"). */
  source: string;
  /** Canonical item URL — candidate identity together with `source`. */
  url: string;
  title: string;
  /** Where it came from inside the source ("Recent Commits to …", "Docs (llms.txt)", "News"). */
  candidateSrc: string | null;
  /** Gate score 0–1. */
  score: number;
  why: string | null;
  status: SummaryCandidateStatus;
  /** Resulting anthropic-summaries doc id once summarized (Phase C/D). */
  docId: string | null;
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
    INSERT INTO summary_candidates (source, url, title, candidate_src, score, why, watcher_id, bot_name)
    VALUES (
      ${p.source}, ${p.url}, ${p.title}, ${p.candidateSrc ?? null},
      ${p.score}, ${p.why ?? null}, ${p.watcherId ?? null}, ${p.botName ?? null}
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
          updated_at = now()
      WHERE summary_candidates.status = 'new'
  `;
}

export async function listCandidates(
  opts: {
    source?: string;
    status?: SummaryCandidateStatus | SummaryCandidateStatus[];
    botName?: string;
    limit?: number;
  } = {},
): Promise<SummaryCandidate[]> {
  const sql = getDb();
  const statuses =
    opts.status == null ? null : Array.isArray(opts.status) ? opts.status : [opts.status];
  const rows = await sql`
    SELECT * FROM summary_candidates
    WHERE (${opts.source ?? null}::text IS NULL OR source = ${opts.source ?? null})
      AND (${opts.botName ?? null}::text IS NULL OR bot_name = ${opts.botName ?? null})
      AND (${statuses}::text[] IS NULL OR status = ANY(${statuses}))
    ORDER BY score DESC, created_at DESC
    LIMIT ${opts.limit ?? 200}
  `;
  return rows.map(mapRow);
}

export async function getCandidateById(id: string): Promise<SummaryCandidate | null> {
  const sql = getDb();
  const [row] = await sql`SELECT * FROM summary_candidates WHERE id = ${id}`;
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
    docId: r.doc_id ?? null,
    watcherId: r.watcher_id ?? null,
    botName: r.bot_name ?? null,
    createdAt: new Date(r.created_at).getTime(),
    updatedAt: new Date(r.updated_at).getTime(),
  };
}
