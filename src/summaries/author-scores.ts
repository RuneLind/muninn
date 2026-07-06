/**
 * X-feed author ranking — read side.
 *
 * Huginn regenerates `x-feed-author-scores.json` daily (a graph PageRank + engagement
 * blend over the tracked X network). It is a flat map keyed by the LOWERCASED, BARE
 * handle (no `@`), pre-sorted by `author_score` descending. Muninn carries a candidate's
 * handle as `@Handle` (or the literal `"unknown"` when the doc heading had none), so both
 * the capture path (src/watchers/x.ts) and the dashboard render (percentile thresholds)
 * normalize through {@link normalizeHandle} before looking a handle up here.
 *
 * The absolute scores are useless as fixed thresholds — the distribution shifts daily and
 * only a handful of authors ever clear 0.5 — so tiering is PERCENTILE-based
 * ({@link getAuthorTierThresholds}): the cut for the top 1% / top 5% of ranked authors,
 * recomputed from the current file.
 *
 * The loader is mtime-cached (the file regenerates once a day) and degrades to null on a
 * missing/unparseable file — author signal is transparency-only, never load-bearing, so a
 * wrong path just NULLs every author rather than breaking capture or the page. That
 * failure is logged ONCE (not per candidate) so a misconfigured path is still visible.
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import { getLog } from "../logging.ts";

const log = getLog("summaries", "author-scores");

/** One author's ranking record (shape mirrors huginn's generator output). */
export interface AuthorScoreEntry {
  pagerank: number;
  pagerank_norm: number;
  community: number;
  avg_engagement: number;
  tweet_count: number;
  author_score: number;
}

/** Percentile cuts on `author_score`, recomputed from the current file. */
export interface AuthorTierThresholds {
  /** author_score at/above which an author is in the top 1% of the ranked set. */
  top1: number;
  /** author_score at/above which an author is in the top 5%. */
  top5: number;
}

/**
 * Default path: `<muninn repo root>/../huginn/huginn-jarvis/data/x-feed-author-scores.json`
 * (huginn is a sibling checkout of muninn). Override with `X_AUTHOR_SCORES_PATH`.
 */
const DEFAULT_REL_PATH = "../huginn/huginn-jarvis/data/x-feed-author-scores.json";

function resolveScoresPath(): string {
  const override = process.env.X_AUTHOR_SCORES_PATH;
  if (override && override.trim()) return override.trim();
  // import.meta.dir = <root>/src/summaries → repo root is two levels up.
  const repoRoot = path.resolve(import.meta.dir, "../../");
  return path.resolve(repoRoot, DEFAULT_REL_PATH);
}

interface ScoreCache {
  mtimeMs: number;
  map: Record<string, AuthorScoreEntry>;
  thresholds: AuthorTierThresholds | null;
}

let cache: ScoreCache | null = null;
/** Gate so a missing/broken file warns once, not once per candidate. */
let warnedDegraded = false;

/**
 * Below this many ranked authors the percentile cuts degenerate (both collapse onto the
 * max score and every top-scored author would read ★ top 1%) — the signature of a
 * truncated/partial file. Treated like a missing file: no tiers.
 */
const MIN_AUTHORS_FOR_TIERS = 20;

function computeThresholds(map: Record<string, AuthorScoreEntry>): AuthorTierThresholds | null {
  const scores = Object.values(map)
    .map((e) => e?.author_score)
    .filter((s): s is number => typeof s === "number")
    .sort((a, b) => b - a);
  if (scores.length < MIN_AUTHORS_FOR_TIERS) return null;
  // Cut admitting exactly the top ceil(p*N) authors: the LAST admitted score in the DESC
  // list, index ceil(p*N) - 1. (A floor(p*N) index paired with a >= test would admit one
  // extra author per tier — e.g. TWO authors clearing "top 1%" of 100.)
  // Math.fround: author_score round-trips through a REAL (float4) column, so the cut must
  // live in float4 space too — otherwise the author DEFINING a cut could fail her own
  // >= comparison after storage rounding.
  const at = (p: number) =>
    Math.fround(scores[Math.max(0, Math.ceil(p * scores.length) - 1)]!);
  return { top1: at(0.01), top5: at(0.05) };
}

/**
 * Load + cache the score map, re-reading only when the file's mtime changes. Returns null
 * (and logs once) when the file is missing or unparseable.
 */
async function loadScores(): Promise<ScoreCache | null> {
  const scoresPath = resolveScoresPath();

  let mtimeMs: number;
  try {
    mtimeMs = (await stat(scoresPath)).mtimeMs;
  } catch (err) {
    if (!warnedDegraded) {
      log.warn("X author scores file not readable at {path} — author tiers disabled: {error}", {
        path: scoresPath,
        error: err instanceof Error ? err.message : String(err),
      });
      warnedDegraded = true;
    }
    cache = null;
    return null;
  }

  if (cache && cache.mtimeMs === mtimeMs) return cache;

  try {
    const map = (await Bun.file(scoresPath).json()) as Record<string, AuthorScoreEntry>;
    // Shape guard: valid JSON of the WRONG shape (e.g. huginn someday wraps entries under
    // a metadata key) would otherwise silently NULL every lookup with zero log signal.
    // Same degradation path as a parse failure.
    if (!isAuthorScoreMap(map)) throw new Error("unexpected shape (not a map of {author_score} entries)");
    cache = { mtimeMs, map, thresholds: computeThresholds(map) };
    warnedDegraded = false; // a good load re-arms the one-shot warning
    return cache;
  } catch (err) {
    if (!warnedDegraded) {
      log.warn("X author scores file at {path} is unusable — author tiers disabled: {error}", {
        path: scoresPath,
        error: err instanceof Error ? err.message : String(err),
      });
      warnedDegraded = true;
    }
    cache = null;
    return null;
  }
}

/**
 * True when `v` looks like the expected flat handle→entry map: a non-empty plain object
 * whose entries (a small sample — the file is ~2.4k entries) carry a numeric author_score.
 */
function isAuthorScoreMap(v: unknown): v is Record<string, AuthorScoreEntry> {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return false;
  const values = Object.values(v);
  if (values.length === 0) return false;
  const sample = values.slice(0, 5);
  return sample.every(
    (e) => e != null && typeof e === "object" && typeof (e as AuthorScoreEntry).author_score === "number",
  );
}

/**
 * Normalize a muninn-carried handle to the JSON's key form: strip a leading `@`, lowercase,
 * and treat empty / the literal `"unknown"` (any case) as no author → null.
 */
export function normalizeHandle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const bare = raw.trim().replace(/^@+/, "").toLowerCase();
  if (!bare || bare === "unknown") return null;
  return bare;
}

/** Author ranking score for a handle, or null (unknown handle / no file / not ranked). */
export async function getAuthorScore(handle: string | null | undefined): Promise<number | null> {
  const norm = normalizeHandle(handle);
  if (!norm) return null;
  const loaded = await loadScores();
  if (!loaded) return null;
  const entry = loaded.map[norm];
  return entry && typeof entry.author_score === "number" ? entry.author_score : null;
}

/** Percentile tier cuts on the current file, or null when the file is unavailable/empty. */
export async function getAuthorTierThresholds(): Promise<AuthorTierThresholds | null> {
  const loaded = await loadScores();
  return loaded ? loaded.thresholds : null;
}

/** Test-only: drop the mtime cache + re-arm the one-shot warning between cases. */
export function __resetAuthorScoresCacheForTest(): void {
  cache = null;
  warnedDegraded = false;
}
