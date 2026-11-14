import { getDb } from "./client.ts";

/**
 * The Discover page's store (migration 088, plan muninn-youtube-discovery PR 2):
 * one `youtube_discover_runs` row per seed searched, one `youtube_discover_hits`
 * row per video that run showed.
 *
 * A video's `state` and `details` belong to the VIDEO, not the run: a write sets
 * them on every hit row of that id, and a new run's hit copies them from the
 * newest row that id already has. So a video dismissed on one shelf is dismissed
 * on all of them, and a probe runs once per video.
 */

export const DISCOVER_HIT_STATES = ["new", "later", "dismissed", "queued"] as const;
export type DiscoverHitState = (typeof DISCOVER_HIT_STATES)[number];
export const DISCOVER_RUN_ORIGINS = ["reader", "page", "watcher"] as const;
export type DiscoverRunOrigin = (typeof DISCOVER_RUN_ORIGINS)[number];

/** States whose video is never suggested again (the known set). */
export const DISCOVER_KNOWN_STATES: readonly DiscoverHitState[] = ["dismissed", "queued"];

export function isDiscoverHitState(v: unknown): v is DiscoverHitState {
  return typeof v === "string" && (DISCOVER_HIT_STATES as readonly string[]).includes(v);
}

export interface DiscoverChapter {
  start: number;
  title: string;
}

/** The details probe's answer, cached on the hit rows. */
export interface DiscoverVideoDetails {
  description: string | null;
  chapters: DiscoverChapter[];
  likeCount: number | null;
  viewCount: number | null;
  /** `YYYYMMDD`, as yt-dlp gives it. */
  uploadDate: string | null;
  channelFollowerCount: number | null;
  tags: string[];
}

export interface DiscoverRunInput {
  seedSource?: string;
  seedDocId: string;
  seedTitle: string;
  seedVideoId: string | null;
  seedCategory: string | null;
  seedDate: string | null;
  queries: { query: string; why: string }[];
  searched: number;
  known: number;
  origin: DiscoverRunOrigin;
  botName: string | null;
}

export interface DiscoverHitInput {
  videoId: string;
  title: string;
  channel: string | null;
  durationSec: number | null;
  viewCount: number | null;
  score: number;
  why: string;
  query: string;
}

export interface DiscoverHit extends DiscoverHitInput {
  rank: number;
  state: DiscoverHitState;
  details: DiscoverVideoDetails | null;
}

export interface DiscoverShelf {
  runId: string;
  seedSource: string;
  seedDocId: string;
  seedTitle: string;
  seedVideoId: string | null;
  seedCategory: string | null;
  seedDate: string | null;
  queries: { query: string; why: string }[];
  searched: number;
  known: number;
  origin: DiscoverRunOrigin;
  /** Epoch ms. */
  createdAt: number;
  hits: DiscoverHit[];
}

type Tx = ReturnType<typeof getDb>;

/**
 * Serialize writers of the same videos: a state write that ran while another
 * seed's save was open could not see that save's uncommitted row, which kept
 * the old state (measured). Ids sorted so two saves cannot deadlock.
 */
async function lockVideos(sql: Tx, videoIds: readonly string[]): Promise<void> {
  for (const id of [...new Set(videoIds)].sort()) {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`youtube-discover:${id}`}, 0))`;
  }
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toHit(r: Record<string, unknown>): DiscoverHit {
  return {
    videoId: r.video_id as string,
    title: r.title as string,
    channel: (r.channel as string | null) ?? null,
    durationSec: num(r.duration_sec),
    viewCount: num(r.view_count),
    score: Number(r.score),
    why: (r.why as string | null) ?? "",
    query: (r.query as string | null) ?? "",
    rank: Number(r.rank),
    state: r.state as DiscoverHitState,
    details: (r.details as DiscoverVideoDetails | null) ?? null,
  };
}

/**
 * Store one run and its hits in one transaction; returns the run id. Each hit
 * takes the state and details its video already has on an earlier row.
 */
export async function saveDiscoverRun(
  run: DiscoverRunInput,
  hits: readonly DiscoverHitInput[],
  /** Test seam: runs inside the transaction after every row is written, before the commit. */
  opts: { beforeCommit?: () => Promise<void> } = {},
): Promise<string> {
  return getDb().begin(async (sql) => {
    const [row] = await sql`
      INSERT INTO youtube_discover_runs
        (seed_source, seed_doc_id, seed_title, seed_video_id, seed_category, seed_date, queries, searched, known, origin, bot_name)
      VALUES
        (${run.seedSource ?? "youtube"}, ${run.seedDocId}, ${run.seedTitle}, ${run.seedVideoId}, ${run.seedCategory},
         ${run.seedDate}, ${sql.json(run.queries as never)}, ${run.searched}, ${run.known}, ${run.origin}, ${run.botName})
      RETURNING id
    `;
    const runId = row!.id as string;
    await lockVideos(sql as unknown as Tx, hits.map((h) => h.videoId));
    let rank = 0;
    for (const h of hits) {
      rank++;
      await sql`
        INSERT INTO youtube_discover_hits
          (run_id, video_id, title, channel, duration_sec, view_count, score, why, query, rank, state, details, details_at)
        SELECT ${runId}, ${h.videoId}, ${h.title}, ${h.channel}, ${h.durationSec === null ? null : Math.round(h.durationSec)},
               ${h.viewCount === null ? null : Math.round(h.viewCount)}, ${h.score}, ${h.why}, ${h.query}, ${rank},
               COALESCE(prev.state, 'new'), prev.details, prev.details_at
        FROM (SELECT 1) AS one
        LEFT JOIN LATERAL (
          SELECT state, details, details_at FROM youtube_discover_hits
          WHERE video_id = ${h.videoId} ORDER BY updated_at DESC LIMIT 1
        ) AS prev ON TRUE
        ON CONFLICT (run_id, video_id) DO NOTHING
      `;
    }
    await opts.beforeCommit?.();
    return runId;
  });
}

/** The newest run of each seed, newest first, with its hits in rank order. */
export async function listDiscoverShelves(limit = 40): Promise<DiscoverShelf[]> {
  const sql = getDb();
  const runs = await sql`
    SELECT * FROM (
      SELECT DISTINCT ON (seed_source, seed_doc_id) *
      FROM youtube_discover_runs
      ORDER BY seed_source, seed_doc_id, created_at DESC
    ) newest
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  if (runs.length === 0) return [];
  const ids = runs.map((r) => r.id as string);
  const hits = await sql`
    SELECT * FROM youtube_discover_hits WHERE run_id = ANY(${ids}::uuid[]) ORDER BY rank
  `;
  const byRun = new Map<string, DiscoverHit[]>();
  for (const h of hits) {
    const list = byRun.get(h.run_id as string) ?? [];
    list.push(toHit(h));
    byRun.set(h.run_id as string, list);
  }
  return runs.map((r) => ({
    runId: r.id as string,
    seedSource: r.seed_source as string,
    seedDocId: r.seed_doc_id as string,
    seedTitle: r.seed_title as string,
    seedVideoId: (r.seed_video_id as string | null) ?? null,
    seedCategory: (r.seed_category as string | null) ?? null,
    seedDate: (r.seed_date as string | null) ?? null,
    queries: (r.queries as { query: string; why: string }[]) ?? [],
    searched: Number(r.searched),
    known: Number(r.known),
    origin: r.origin as DiscoverRunOrigin,
    createdAt: new Date(r.created_at as string).getTime(),
    hits: byRun.get(r.id as string) ?? [],
  }));
}

/** Set a video's state on every hit row it has; returns how many rows changed (0 = no such video). */
export async function setDiscoverVideoState(videoId: string, state: DiscoverHitState): Promise<number> {
  return getDb().begin(async (tx) => {
    const sql = tx as unknown as Tx;
    await lockVideos(sql, [videoId]);
    const res = await sql`
      UPDATE youtube_discover_hits SET state = ${state}, updated_at = now() WHERE video_id = ${videoId}
    `;
    return res.count;
  });
}

/** The video ids never to suggest again: dismissed or queued. */
export async function getDiscoverKnownVideoIds(): Promise<Set<string>> {
  const rows = await getDb()`
    SELECT DISTINCT video_id FROM youtube_discover_hits WHERE state = ANY(${DISCOVER_KNOWN_STATES as string[]}::text[])
  `;
  return new Set(rows.map((r) => r.video_id as string));
}

/**
 * A stored video's cached details: `undefined` when no hit row has this id,
 * `null` when it has one but no probe has answered yet.
 */
export async function getDiscoverVideoDetails(videoId: string): Promise<DiscoverVideoDetails | null | undefined> {
  const [row] = await getDb()`
    SELECT details FROM youtube_discover_hits WHERE video_id = ${videoId}
    ORDER BY (details IS NULL), updated_at DESC LIMIT 1
  `;
  if (!row) return undefined;
  return (row.details as DiscoverVideoDetails | null) ?? null;
}

/** Cache a probe's answer on every hit row of the video. */
export async function saveDiscoverVideoDetails(videoId: string, details: DiscoverVideoDetails): Promise<void> {
  await getDb().begin(async (tx) => {
    const sql = tx as unknown as Tx;
    await lockVideos(sql, [videoId]);
    await sql`
      UPDATE youtube_discover_hits SET details = ${sql.json(details as never)}, details_at = now() WHERE video_id = ${videoId}
    `;
  });
}
