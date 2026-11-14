/**
 * One discovery run from one seed summary (plan muninn-youtube-discovery): the
 * pipeline PR 1 ran inside its route, lifted out so the route and PR 3's
 * weekly watcher run the same steps.
 *
 * read the stored summary → one Haiku call writes 3–5 queries → one yt-dlp
 * search per query → union by id → drop the seed and every known id → the
 * YouTube gate ranks the rest (profile last) → the top
 * {@link DISCOVER_MAX_SHOWN} at or over {@link DISCOVER_MIN_SCORE}.
 *
 * Returns an outcome, never throws for an expected failure; the caller maps a
 * failure to its HTTP answer or its source-health record. Stores nothing: the
 * caller saves the run (`src/db/youtube-discover.ts`).
 */

import type { BotConfig } from "../bots/config.ts";
import type { Tracer } from "../tracing/tracer.ts";
import { readStoredCapture, titleFromDocId } from "../summaries/summary-save.ts";
import { stripSummaryFactcheckBlock } from "../summaries/factcheck-block.ts";
import { readerSimilarQuery } from "../summaries/reader-article.ts";
import { extractYouTubeVideoId } from "./url.ts";
import {
  buildDiscoverQueriesPrompt,
  buildDiscoverRankPrompt,
  DISCOVER_MAX_SHOWN,
  DISCOVER_MIN_SCORE,
  DISCOVER_RESULTS_PER_QUERY,
  parseDiscoverQueries,
  type DiscoverQuery,
  type YouTubeHit,
} from "./discover.ts";
import { indexScoresByN, parseGateScores } from "../watchers/gate-scores.ts";
import { withInterestProfile } from "../profile/inject.ts";

export type DiscoverTracer = Pick<Tracer, "start" | "end" | "finish">;

export interface DiscoverRunDeps {
  /** The raw file, or `null` when huginn has no such document. Throws on any other failure. */
  readRaw: (collection: string, docId: string) => Promise<string | null>;
  queriesCall: (prompt: string, bot: BotConfig, tracer: DiscoverTracer | null) => Promise<string>;
  rankCall: (prompt: string, bot: BotConfig, tracer: DiscoverTracer | null) => Promise<string>;
  /** One search: hits, or `null` when it failed. */
  search: (query: string, n: number) => Promise<YouTubeHit[] | null>;
  /** Every video id never to suggest: captured, dismissed or queued. A throw degrades to none. */
  knownIds: () => Promise<Set<string>>;
  /** The interest profile to rank with, or `null`. */
  profile: (bot: BotConfig) => Promise<string | null>;
}

export interface DiscoverResult extends YouTubeHit {
  score: number;
  why: string;
  /** The first query that found it. */
  query: string;
}

export interface DiscoverSeed {
  docId: string;
  title: string;
  videoId: string | null;
  category: string | null;
  /** The capture's `date:` frontmatter, as written. */
  date: string | null;
}

export type DiscoverRunOutcome =
  | {
      ok: true;
      seed: DiscoverSeed;
      queries: DiscoverQuery[];
      results: DiscoverResult[];
      searched: number;
      known: number;
    }
  | {
      ok: false;
      status: 404 | 502 | 503;
      code: "upstream" | "not_found" | "model_failed" | "model_unparseable" | "search_failed";
      error: string;
      /** The underlying error's text, for the caller's log (a read or model-call failure). */
      cause?: string;
      /** The step that failed: the watcher's health keys judge each step on its own. */
      stage: "read" | "queries" | "search" | "rank";
    };

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The seed's category: its `category:` frontmatter, else the doc id's folder. */
function seedCategory(frontmatter: Record<string, string>, docId: string): string | null {
  const fm = frontmatter.category?.trim();
  if (fm) return fm;
  const i = docId.lastIndexOf("/");
  return i > 0 ? docId.slice(0, i) : null;
}

export async function runDiscovery(
  deps: DiscoverRunDeps,
  bot: BotConfig,
  tracer: DiscoverTracer | null,
  target: { collection: string; docId: string },
): Promise<DiscoverRunOutcome> {
  const { collection, docId } = target;
  let raw: string | null;
  try {
    raw = await deps.readRaw(collection, docId);
  } catch (err) {
    tracer?.finish("error", { error: `read failed: ${errText(err)}` });
    return { ok: false, status: 502, code: "upstream", error: "Could not read the stored document.", cause: errText(err), stage: "read" };
  }
  if (raw === null) {
    tracer?.finish("error", { error: "not found" });
    return { ok: false, status: 404, code: "not_found", error: "No such document.", stage: "read" };
  }
  const stored = readStoredCapture(raw);
  const seed: DiscoverSeed = {
    docId,
    title: titleFromDocId(docId),
    videoId: extractYouTubeVideoId(stored.frontmatter.url ?? ""),
    category: seedCategory(stored.frontmatter, docId),
    date: stored.frontmatter.date?.trim() || null,
  };
  const opening = readerSimilarQuery(stripSummaryFactcheckBlock(stored.body));

  // 1. Queries.
  let queries: DiscoverQuery[] | null;
  tracer?.start("queries", { doc: docId });
  try {
    const answer = await deps.queriesCall(buildDiscoverQueriesPrompt(seed.title, opening), bot, tracer);
    queries = parseDiscoverQueries(answer);
    tracer?.end("queries", { queries: queries?.length ?? 0 });
  } catch (err) {
    tracer?.end("queries", { error: errText(err) }, "error");
    tracer?.finish("error");
    return {
      ok: false,
      status: 502,
      code: "model_failed",
      error: "The call that writes the search queries failed. Try again.",
      cause: `queries call: ${errText(err)}`,
      stage: "queries",
    };
  }
  if (!queries || queries.length === 0) {
    tracer?.finish("error", { error: "no queries" });
    return { ok: false, status: 502, code: "model_unparseable", error: "The model answered no usable search queries. Try again.", stage: "queries" };
  }
  const qs = queries;

  // 2. Searches, concurrently; union by id in query order.
  tracer?.start("search", { queries: qs.length });
  const answers = await Promise.all(qs.map((q) => deps.search(q.query, DISCOVER_RESULTS_PER_QUERY).catch(() => null)));
  const failed = answers.filter((a) => a === null).length;
  tracer?.end("search", { failed }, failed === answers.length ? "error" : "ok");
  if (failed === answers.length) {
    tracer?.finish("error", { error: "every search failed" });
    return { ok: false, status: 503, code: "search_failed", error: "Every YouTube search failed. Is yt-dlp installed and up to date?", stage: "search" };
  }
  const union = new Map<string, { hit: YouTubeHit; query: string }>();
  answers.forEach((hits, i) => {
    for (const hit of hits ?? []) if (!union.has(hit.videoId)) union.set(hit.videoId, { hit, query: qs[i]!.query });
  });

  // 3. Drop the seed and everything known.
  let knownSet: Set<string>;
  try {
    knownSet = await deps.knownIds();
  } catch {
    // Degrade: a result may be a video already captured, and the Summarize answer says `duplicate`.
    knownSet = new Set();
  }
  const fresh = [...union.values()].filter(({ hit }) => hit.videoId !== seed.videoId && !knownSet.has(hit.videoId));
  const searched = union.size;
  const known = searched - fresh.length;
  if (fresh.length === 0) {
    tracer?.finish("ok", { searched, known, shown: 0 });
    return { ok: true, seed, queries: qs, results: [], searched, known };
  }

  // 4. Rank (the YouTube gate), profile last.
  const profile = await deps.profile(bot).catch(() => null);
  const prompt = withInterestProfile(buildDiscoverRankPrompt(seed.title, fresh.map((f) => f.hit)), profile);
  let scores: ReturnType<typeof indexScoresByN>;
  tracer?.start("rank", { candidates: fresh.length, profile: profile ? "yes" : "no" });
  try {
    const answer = await deps.rankCall(prompt, bot, tracer);
    try {
      scores = indexScoresByN(parseGateScores(answer), fresh.length);
    } catch {
      tracer?.end("rank", { error: "unparseable" }, "error");
      tracer?.finish("error");
      return { ok: false, status: 502, code: "model_unparseable", error: "The ranking call answered no list. Try again.", stage: "rank" };
    }
    tracer?.end("rank", { scored: scores.size });
  } catch (err) {
    tracer?.end("rank", { error: errText(err) }, "error");
    tracer?.finish("error");
    return { ok: false, status: 502, code: "model_failed", error: "The ranking call failed. Try again.", cause: `rank call: ${errText(err)}`, stage: "rank" };
  }
  const results: DiscoverResult[] = fresh
    .map((f, i) => ({ f, s: scores.get(i + 1), i }))
    .filter(
      (x): x is { f: (typeof fresh)[number]; s: NonNullable<typeof x.s>; i: number } =>
        x.s !== undefined && x.s.score >= DISCOVER_MIN_SCORE,
    )
    .sort((a, b) => b.s.score - a.s.score || a.i - b.i)
    .slice(0, DISCOVER_MAX_SHOWN)
    .map(({ f, s }) => ({ ...f.hit, score: s.score, why: s.why, query: f.query }));
  tracer?.finish("ok", { searched, known, shown: results.length });
  return { ok: true, seed, queries: qs, results, searched, known };
}
