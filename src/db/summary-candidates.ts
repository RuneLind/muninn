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
 * vertical); `x-post` tags a long-form X tweet, `x-link` a pointer tweet whose
 * value is the external link it points at (summarized from the linked content).
 */
export type SummaryCandidateKind = "commit" | "release" | "doc" | "blog" | "x-post" | "x-link";

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
  /**
   * Why a dismissed row was dismissed: 'manual' (human clicked Dismiss), 'expired'
   * (auto-dismissed stale by expireStaleCandidates), or NULL — both non-dismissed
   * rows and pre-051 dismissals ("unknown"). Drives the calibration acceptance metric.
   */
  dismissedReason: string | null;
  /** Capture-time kind — drives the inbox filter chips. NULL for pre-migration rows. */
  kind: SummaryCandidateKind | null;
  /**
   * Normalized (lowercased, bare) X handle for X candidates — the huginn author-scores
   * key. NULL for anthropic rows and for X rows whose heading had no handle ("unknown").
   */
  author: string | null;
  /**
   * Capture-time snapshot of the author's huginn ranking score (0–1), or NULL. A snapshot,
   * not live — the /summaries page compares it against CURRENT percentile thresholds, so
   * a boundary tier can drift slightly as huginn regenerates the ranking.
   */
  authorScore: number | null;
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
  /** Normalized (lowercased, bare) X handle — null for anthropic / "unknown". */
  author?: string | null;
  /** Capture-time huginn author ranking score (0–1) — null when unknown/unavailable. */
  authorScore?: number | null;
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
    INSERT INTO summary_candidates (source, url, title, candidate_src, score, why, kind, author, author_score, source_doc_id, watcher_id, bot_name)
    VALUES (
      ${p.source}, ${p.url}, ${p.title}, ${p.candidateSrc ?? null},
      ${p.score}, ${p.why ?? null}, ${p.kind ?? null}, ${p.author ?? null}, ${p.authorScore ?? null}, ${p.sourceDocId ?? null}, ${p.watcherId ?? null}, ${p.botName ?? null}
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
          -- author / author_score are identity-derived (a property of the tweet's
          -- handle, not the score). Prefer the NEWEST non-null so a backfilled row picks
          -- up a score on its next re-capture; never overwrite a stored value with null.
          author = COALESCE(EXCLUDED.author, summary_candidates.author),
          author_score = COALESCE(EXCLUDED.author_score, summary_candidates.author_score),
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
    SET status = 'dismissed', dismissed_reason = 'expired', updated_at = now()
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
 * pass null (the default) to leave any existing doc_id untouched. `dismissedReason`
 * labels a manual dismissal ('manual') so the calibration aggregation can tell it
 * apart from an auto-expired row ('expired', set by expireStaleCandidates) — pass
 * null (the default) to leave any existing reason untouched.
 */
export async function setCandidateStatus(
  id: string,
  status: SummaryCandidateStatus,
  docId: string | null = null,
  dismissedReason: string | null = null,
): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE summary_candidates
    SET status = ${status},
        doc_id = COALESCE(${docId}, doc_id),
        dismissed_reason = COALESCE(${dismissedReason}, dismissed_reason),
        updated_at = now()
    WHERE id = ${id}
  `;
}

// ============================================================================
// Gate-outcome calibration (display-only)
//
// summary_candidates is a labeled dataset of capture-gate quality: each row carries
// the gate `score`, its `kind`, and a terminal `status` (summarized = a human/auto
// judged it worth a summary; dismissed = not). `candidateOutcomeStats` aggregates
// acceptance rates per (source, kind) and per 0.1-wide score band, and derives a
// suggested per-kind capture floor — surfaced on the /summaries "Calibration" tab so
// the operator can hand-tune `candidateMinScoreByKind`. It NEVER writes watcher config.
// ============================================================================

/** Acceptance rate the suggested-floor heuristic targets. */
const ACCEPTANCE_TARGET = 0.5;

const round3 = (x: number): number => Math.round(x * 1000) / 1000;
/** Snap a 0.1-band boundary to 1 decimal, shedding REAL/float noise (0.7000001 → 0.7). */
const round1 = (x: number): number => Math.round(x * 10) / 10;

/** Aggregate outcome counts + the derived human accept-vs-reject rate. */
export interface OutcomeCounts {
  /** Rows that reached a scored outcome (summarized + dismissed + error). Excludes
   *  still-pending new/summarizing rows. */
  total: number;
  summarized: number;
  /** Dismissed by a human clicking Dismiss (dismissed_reason = 'manual'). */
  dismissedManual: number;
  /** Auto-dismissed stale (dismissed_reason = 'expired') — NOT a quality judgement. */
  dismissedExpired: number;
  /** Dismissed before migration 051 (dismissed_reason NULL) — origin unknown. */
  dismissedUnknown: number;
  error: number;
  /**
   * summarized / (summarized + dismissedManual). Expired + unknown dismissals and
   * errors are deliberately OUT of the denominator (they aren't accept/reject
   * judgements). null when the denominator is 0 (no labeled decisions yet).
   */
  acceptanceRate: number | null;
}

export interface KindOutcomeStats extends OutcomeCounts {
  source: string;
  kind: string | null;
}

export interface ScoreBandOutcomeStats extends OutcomeCounts {
  /** Lower bound of the 0.1-wide band, e.g. 0.7 covers scores in [0.70, 0.80). */
  band: number;
}

export interface KindFloorSuggestion {
  kind: string;
  /**
   * Suggested per-kind capture floor (heuristic): the LOWEST score-band lower-bound
   * at/above which the cumulative acceptance rate — over every candidate with score
   * ≥ that bound — is ≥ 0.5. In plain terms: "put the floor where at least half of
   * what you'd still capture turned out worth summarizing." Simple + explainable, not
   * an optimizer. null when no band clears 0.5 (or the kind has no labeled decisions).
   */
  suggestedFloor: number | null;
}

export interface CandidateOutcomeStats {
  /** Per (source, kind) acceptance breakdown. */
  byKind: KindOutcomeStats[];
  /** Global 0.1-wide score-band histogram of outcomes. */
  byBand: ScoreBandOutcomeStats[];
  /** Suggested per-kind capture floor (see KindFloorSuggestion). */
  suggestedFloors: KindFloorSuggestion[];
}

interface RawCell {
  source: string;
  kind: string | null;
  band: number;
  summarized: number;
  dismissedManual: number;
  dismissedExpired: number;
  dismissedUnknown: number;
  error: number;
}

function emptyCounts(): OutcomeCounts {
  return {
    total: 0,
    summarized: 0,
    dismissedManual: 0,
    dismissedExpired: 0,
    dismissedUnknown: 0,
    error: 0,
    acceptanceRate: null,
  };
}

function accumulate(acc: OutcomeCounts, c: RawCell): void {
  acc.summarized += c.summarized;
  acc.dismissedManual += c.dismissedManual;
  acc.dismissedExpired += c.dismissedExpired;
  acc.dismissedUnknown += c.dismissedUnknown;
  acc.error += c.error;
}

function finalize(acc: OutcomeCounts): void {
  acc.total =
    acc.summarized + acc.dismissedManual + acc.dismissedExpired + acc.dismissedUnknown + acc.error;
  const denom = acc.summarized + acc.dismissedManual;
  acc.acceptanceRate = denom > 0 ? round3(acc.summarized / denom) : null;
}

/**
 * Aggregate the labeled capture-gate dataset for the Calibration tab. Read-only —
 * pure aggregation, no writes. Groups outcomes per (source, kind) and per 0.1-wide
 * score band, and derives a suggested per-kind floor. Only rows in a scored terminal
 * status (summarized / dismissed / error) are counted; new + summarizing are pending.
 */
export async function candidateOutcomeStats(): Promise<CandidateOutcomeStats> {
  const sql = getDb();
  const rows = await sql`
    SELECT
      source,
      kind,
      -- Round the REAL to 4 dp before binning: score is float4, so 0.7 is stored as
      -- 0.69999998 and a naive floor(0.7*10) lands in band 0.6. round(…,4) collapses
      -- that float error so a 0.1 band boundary bins where the displayed score says.
      floor(round(score::numeric, 4) * 10) / 10 AS band,
      count(*) FILTER (WHERE status = 'summarized')::int AS summarized,
      count(*) FILTER (WHERE status = 'dismissed' AND dismissed_reason = 'manual')::int AS dismissed_manual,
      count(*) FILTER (WHERE status = 'dismissed' AND dismissed_reason = 'expired')::int AS dismissed_expired,
      count(*) FILTER (WHERE status = 'dismissed' AND dismissed_reason IS NULL)::int AS dismissed_unknown,
      count(*) FILTER (WHERE status = 'error')::int AS error
    FROM summary_candidates
    WHERE status IN ('summarized', 'dismissed', 'error')
    GROUP BY source, kind, floor(round(score::numeric, 4) * 10) / 10
  `;

  const cells: RawCell[] = rows.map((r: Record<string, any>) => ({
    source: r.source,
    kind: r.kind ?? null,
    band: round1(Number(r.band)),
    summarized: Number(r.summarized),
    dismissedManual: Number(r.dismissed_manual),
    dismissedExpired: Number(r.dismissed_expired),
    dismissedUnknown: Number(r.dismissed_unknown),
    error: Number(r.error),
  }));

  // --- byKind: group by (source, kind) ---
  const kindMap = new Map<string, KindOutcomeStats>();
  for (const c of cells) {
    const key = `${c.source}\x00${c.kind ?? ""}`;
    let entry = kindMap.get(key);
    if (!entry) {
      entry = { source: c.source, kind: c.kind, ...emptyCounts() };
      kindMap.set(key, entry);
    }
    accumulate(entry, c);
  }
  const byKind = [...kindMap.values()];
  byKind.forEach(finalize);
  byKind.sort(
    (a, b) => a.source.localeCompare(b.source) || (a.kind ?? "").localeCompare(b.kind ?? ""),
  );

  // --- byBand: global 0.1-wide histogram ---
  const bandMap = new Map<number, ScoreBandOutcomeStats>();
  for (const c of cells) {
    let entry = bandMap.get(c.band);
    if (!entry) {
      entry = { band: c.band, ...emptyCounts() };
      bandMap.set(c.band, entry);
    }
    accumulate(entry, c);
  }
  const byBand = [...bandMap.values()];
  byBand.forEach(finalize);
  byBand.sort((a, b) => a.band - b.band);

  // --- suggestedFloors: per-kind heuristic ---
  // Floors are keyed by kind (the config field candidateMinScoreByKind), not source —
  // x-post maps to source 'x', the anthropic kinds to source 'anthropic'. A NULL-kind
  // row can't get a per-kind floor, so it's skipped here (still counted in byKind).
  const cellsByKind = new Map<string, RawCell[]>();
  for (const c of cells) {
    if (c.kind == null) continue;
    const arr = cellsByKind.get(c.kind);
    if (arr) arr.push(c);
    else cellsByKind.set(c.kind, [c]);
  }
  const suggestedFloors: KindFloorSuggestion[] = [];
  for (const [kind, cs] of cellsByKind) {
    const bands = [...new Set(cs.map((c) => c.band))].sort((a, b) => a - b);
    let suggested: number | null = null;
    // Ascending → the first (lowest) floor whose at-or-above set clears the target is
    // the most generous floor that still keeps acceptance ≥ 0.5.
    for (const floorBand of bands) {
      let cumSummarized = 0;
      let cumManual = 0;
      for (const c of cs) {
        if (c.band >= floorBand - 1e-9) {
          cumSummarized += c.summarized;
          cumManual += c.dismissedManual;
        }
      }
      const denom = cumSummarized + cumManual;
      if (denom > 0 && cumSummarized / denom >= ACCEPTANCE_TARGET) {
        suggested = floorBand;
        break;
      }
    }
    suggestedFloors.push({ kind, suggestedFloor: suggested });
  }
  suggestedFloors.sort((a, b) => a.kind.localeCompare(b.kind));

  return { byKind, byBand, suggestedFloors };
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
    dismissedReason: r.dismissed_reason ?? null,
    kind: (r.kind ?? null) as SummaryCandidateKind | null,
    author: r.author ?? null,
    authorScore: r.author_score == null ? null : Number(r.author_score),
    docId: r.doc_id ?? null,
    sourceDocId: r.source_doc_id ?? null,
    watcherId: r.watcher_id ?? null,
    botName: r.bot_name ?? null,
    createdAt: new Date(r.created_at).getTime(),
    updatedAt: new Date(r.updated_at).getTime(),
  };
}
