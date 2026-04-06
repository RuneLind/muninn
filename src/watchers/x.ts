import type { Watcher, WatcherAlert } from "../types.ts";
import { spawnHaiku, DEFAULT_MODEL } from "../scheduler/executor.ts";
import { getLog } from "../logging.ts";
import path from "node:path";

const log = getLog("watchers", "x");

export const DEFAULT_X_PROMPT = `Create a digest with two sections:

**Top Picks** (3-5 items) — the most interesting, impactful, or high-engagement content:
- Give each a brief description with context on why it matters
- Link @handles to the original tweet URL (markdown link)
- Prioritize: articles/long-form notes, original insights, high view-to-like ratio, threads

**Also Notable** (up to 10 items) — everything else worth mentioning:
- One-line bullets only, with linked @handle
- Skip: ads, spam, generic motivational, low-effort retweets, engagement bait, promotional

Format rules:
- Do NOT start with a heading — jump straight into "**Top Picks**"
- Use bold for section headers
- Keep it scannable — bullet points throughout
- Write in a casual, informative tone`;

interface XWatcherConfig {
  pages?: number;
  prompt?: string;
  model?: string;
  /** Timeout in ms for the model call (default: 300s) */
  timeoutMs?: number;
  /** Set to collection name (e.g. "x-feed") to query huginn's indexed collection instead of spawning the fetcher */
  collection?: string;
  /** Knowledge API URL (default: http://localhost:8321) */
  apiUrl?: string;
  /** Max documents to include in digest (default: 80) */
  maxDocs?: number;
  /** Max tweets to send to LLM after ranking (default: 30). Tweets are ranked by engagement_score. */
  topN?: number;
}

// --- Collection path (queries huginn's indexed x-feed collection) ---

const DEFAULT_API_URL = process.env.KNOWLEDGE_API_URL ?? "http://localhost:8321";
const DEFAULT_MAX_DOCS = 80;
const DEFAULT_TOP_N = 30;

interface CollectionDoc {
  id: string;
  url: string;
}

interface CompactedTweet {
  text: string;
  rankScore: number;
}

/**
 * Extract rank score from markdown text. Prefers combined_score (engagement + relevance),
 * falls back to engagement_score if relevance scoring hasn't run yet.
 * Field names are a shared contract with huginn-jarvis/scripts/x/scoring/relevance_scorer.py.
 */
export function extractRankScore(text: string): number {
  const combinedMatch = text.match(/combined_score:\s*([\d.]+)/);
  if (combinedMatch) return parseFloat(combinedMatch[1]!);
  const engMatch = text.match(/engagement_score:\s*([\d.]+)/);
  return engMatch ? parseFloat(engMatch[1]!) : 0;
}

/**
 * Convert full huginn markdown document into a compact one-liner for the digest prompt.
 * Input:  "# @handle — Author\n\nTweet text...\n\n---\n\n- **Engagement:** 1,508 likes..."
 * Output: { text: "@handle: Tweet text (1,508 likes, 524k views)\n  URL: ...", rankScore: 12.34 }
 */
function compactTweetText(rawText: string, url: string): CompactedTweet {
  // Strip the bracketed document ID line huginn prepends
  const text = rawText.replace(/^\[.*?\]\n+/, "");
  const lines = text.split("\n");

  // Extract handle from heading: "# @handle — Author"
  const headingIdx = lines.findIndex((l) => l.startsWith("# @"));
  const heading = headingIdx >= 0 ? lines[headingIdx]! : "";
  const handleMatch = heading.match(/@(\w+)/);
  const handle = handleMatch ? `@${handleMatch[1]}` : "unknown";

  // Extract tweet body (lines between heading and "---" separator, excluding metadata)
  const startIdx = headingIdx >= 0 ? headingIdx + 1 : 0;
  const separatorIdx = lines.indexOf("---", startIdx);
  const bodyLines = lines.slice(startIdx, separatorIdx > 0 ? separatorIdx : undefined)
    .filter((l) => l.trim() && !l.startsWith("- **"))
    .map((l) => l.trim());
  const bodyRaw = bodyLines.join(" ");
  // Truncate at word boundary
  const body = bodyRaw.length > 500 ? bodyRaw.slice(0, bodyRaw.lastIndexOf(" ", 500)) + "..." : bodyRaw;

  // Extract engagement from footer
  const engagementLine = lines.find((l) => l.includes("**Engagement:**")) ?? "";
  const likesMatch = engagementLine.match(/([\d,]+)\s*likes/);
  const viewsMatch = engagementLine.match(/([\d,]+)\s*views/);
  const signals: string[] = [];
  if (likesMatch) signals.push(`${likesMatch[1]} likes`);
  if (viewsMatch) signals.push(`${viewsMatch[1]} views`);

  const rankScore = extractRankScore(rawText);

  // Extract type
  const typeLine = lines.find((l) => l.includes("**Type:**")) ?? "";
  const isNote = typeLine.includes("note");

  let result = `${handle}: ${body}`;
  if (signals.length > 0) result += ` (${signals.join(", ")})`;
  if (isNote) result = `[ARTICLE/NOTE] ${result}`;
  result += `\n  URL: ${url}`;
  return { text: result, rankScore };
}

function extractTweetId(docId: string): string {
  const match = docId.match(/_(\d+)\.md$/);
  return match ? match[1]! : docId;
}

async function fetchFromCollection(
  config: XWatcherConfig,
  known: Set<string>,
  botName?: string,
): Promise<{ texts: string[]; trackingIds: string[] } | null> {
  const apiUrl = config.apiUrl || DEFAULT_API_URL;
  const collection = config.collection!;

  // Get all document IDs from the collection
  let docs: CollectionDoc[];
  try {
    const resp = await fetch(`${apiUrl}/api/collection/${encodeURIComponent(collection)}/documents`);
    if (!resp.ok) {
      log.error("Failed to list collection documents: HTTP {status}", { botName, status: resp.status });
      return null;
    }
    const data = await resp.json() as { documents: CollectionDoc[] };
    docs = data.documents;
  } catch (err) {
    log.error("Failed to reach knowledge API: {error}", { botName, error: err instanceof Error ? err.message : String(err) });
    return null;
  }

  // Filter by recency — only docs from today or yesterday (date prefix in filename)
  // Use Europe/Oslo timezone to match huginn's date convention
  const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit" });
  const now = new Date();
  const today = dateFmt.format(now);
  const yesterday = dateFmt.format(new Date(now.getTime() - 86400000));
  const recentDocs = docs.filter((d) => d.id.startsWith(today) || d.id.startsWith(yesterday));

  // Then filter out already-seen tweets
  const newDocs = recentDocs
    .filter((d) => !known.has(`tw:${extractTweetId(d.id)}`))
    .sort((a, b) => a.id.localeCompare(b.id)); // oldest first for deterministic cap

  if (newDocs.length === 0) {
    log.info("No new recent tweets ({recent} recent, all seen)", { botName, recent: recentDocs.length });
    return { texts: [], trackingIds: [] };
  }

  // Fetch full content for new documents (cap to avoid huge prompts)
  const maxDocs = config.maxDocs ?? DEFAULT_MAX_DOCS;
  const toFetch = newDocs.slice(0, maxDocs);

  // Fetch in batches of 20 to avoid overwhelming huginn's Python server
  const compacted: (CompactedTweet & { docId: string })[] = [];
  for (let i = 0; i < toFetch.length; i += 20) {
    const batch = toFetch.slice(i, i + 20);
    const results = await Promise.all(
      batch.map(async (doc) => {
        try {
          const resp = await fetch(`${apiUrl}/api/document/${encodeURIComponent(collection)}/${encodeURIComponent(doc.id)}`);
          if (!resp.ok) return null;
          const data = await resp.json() as { text: string; metadata?: { url?: string } };
          const { text, rankScore } = compactTweetText(data.text, data.metadata?.url || doc.url);
          return { docId: doc.id, text, rankScore };
        } catch (err) {
          log.warn("Failed to fetch doc {docId}: {error}", { botName, docId: doc.id, error: err instanceof Error ? err.message : String(err) });
          return null;
        }
      }),
    );
    for (const r of results) {
      if (r) compacted.push(r);
    }
  }

  // Rank by engagement score (highest first) and take top-N for the LLM
  compacted.sort((a, b) => b.rankScore - a.rankScore);
  const topN = config.topN ?? DEFAULT_TOP_N;
  const ranked = compacted.slice(0, topN);
  const texts = ranked.map((r) => r.text);
  // Track ALL fetched tweets so below-cutoff ones aren't re-fetched next tick
  const trackingIds = compacted.map((r) => `tw:${extractTweetId(r.docId)}`);

  log.info("Collection: {total} docs, {recent} recent, {newCount} new, {fetched} fetched, {ranked} after ranking", {
    botName, total: docs.length, recent: recentDocs.length, newCount: newDocs.length, fetched: compacted.length, ranked: ranked.length,
  });

  return { texts, trackingIds };
}

// --- Legacy path (spawns huginn Python fetcher directly) ---

const HUGINN_PATH = path.resolve(import.meta.dir, "../../../huginn");
const FETCHER_SCRIPT = "scripts/x/fetchers/x_fetcher.py";
const FETCHER_TIMEOUT_MS = 60_000;
const MAX_PAGES = 10;

interface XTweet {
  id: string;
  author: string;
  handle: string;
  text: string;
  created_at: string;
  url: string;
  likes: number;
  retweets: number;
  replies: number;
  views?: number;
  bookmarks?: number;
  tweet_type?: string;
  is_retweet: boolean;
  quoted_tweet: XTweet | null;
  media: { type: string; url: string }[] | null;
  engagement_score?: number;
}

async function fetchFromPython(
  config: XWatcherConfig,
  known: Set<string>,
  botName?: string,
): Promise<{ texts: string[]; trackingIds: string[] } | null> {
  const pages = Math.min(config.pages ?? 3, MAX_PAGES);

  let tweets: XTweet[];
  try {
    const proc = Bun.spawn(
      ["uv", "run", FETCHER_SCRIPT, "--pages", String(pages)],
      { cwd: HUGINN_PATH, stdout: "pipe", stderr: "pipe" },
    );

    const timeout = setTimeout(() => {
      log.warn("X fetcher timed out after {ms}ms, killing", { botName, ms: FETCHER_TIMEOUT_MS });
      proc.kill();
    }, FETCHER_TIMEOUT_MS);

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(timeout);

    if (exitCode !== 0) {
      log.error("X fetcher failed (exit {code}): {stderr}", { botName, code: exitCode, stderr: stderr.slice(0, 500) });
      return null;
    }

    tweets = JSON.parse(stdout);
  } catch (err) {
    log.error("Failed to run X fetcher: {error}", { botName, error: err instanceof Error ? err.message : String(err) });
    return null;
  }

  const newTweets = tweets.filter((t) => !known.has(`tw:${t.id}`));

  if (newTweets.length === 0) {
    return { texts: [], trackingIds: [] };
  }

  // Sort by engagement score (already sorted by fetcher, but re-sort after dedup filtering)
  newTweets.sort((a, b) => (b.engagement_score ?? 0) - (a.engagement_score ?? 0));
  const topN = config.topN ?? DEFAULT_TOP_N;
  const ranked = newTweets.slice(0, topN);

  log.info("Fetcher: {total} tweets, {newCount} new, {ranked} after ranking (top-{topN})", {
    botName, total: tweets.length, newCount: newTweets.length, ranked: ranked.length, topN,
  });

  const trackingIds = ranked.map((t) => `tw:${t.id}`);

  // Build text summaries with engagement signals (tweets are pre-ranked by engagement_score)
  const texts = ranked.map((t) => {
    let line = `@${t.handle}: ${t.text}`;
    if (t.is_retweet) line = `[RT] ${line}`;

    const signals: string[] = [];
    if (t.likes > 50) signals.push(`${t.likes} likes`);
    if (t.views && t.views > 10000) signals.push(`${Math.round(t.views / 1000)}k views`);
    if (t.bookmarks && t.bookmarks > 10) signals.push(`${t.bookmarks} bookmarks`);
    if (signals.length > 0) line += ` (${signals.join(", ")})`;

    if (t.tweet_type === "note") line = `[ARTICLE/NOTE] ${line}`;
    if (t.quoted_tweet) line += `\n  > @${t.quoted_tweet.handle}: ${t.quoted_tweet.text}`;
    line += `\n  URL: ${t.url}`;
    return line;
  });

  return { texts, trackingIds };
}

// --- Main entry point ---

export async function checkX(watcher: Watcher, _cwd?: string, botName?: string): Promise<WatcherAlert[]> {
  const config = watcher.config as XWatcherConfig;
  const known = new Set(watcher.lastNotifiedIds);

  // Choose data source
  const data = config.collection
    ? await fetchFromCollection(config, known, botName)
    : await fetchFromPython(config, known, botName);

  if (!data) return []; // fetch error
  if (data.texts.length === 0) {
    log.info("No new tweets to digest", { botName });
    return [];
  }

  const { texts, trackingIds } = data;
  const separator = config.collection ? "\n\n---\n\n" : "\n---\n";
  const userPrompt = config.prompt || DEFAULT_X_PROMPT;

  const prompt = `You are curating a user's X/Twitter timeline into a digest.

Here are ${texts.length} tweets from the home timeline, pre-ranked by engagement score (highest engagement first):

${texts.join(separator)}

${userPrompt}`;

  const model = config.model || DEFAULT_MODEL;
  const timeoutMs = config.timeoutMs ?? 300_000;
  log.info("Summarizing {count} tweets with {model} (timeout {timeout}s)", {
    botName, count: texts.length, model, timeout: Math.round(timeoutMs / 1000),
  });

  try {
    const start = Date.now();
    const { result } = await spawnHaiku(prompt, {
      source: "watcher-x", entrypoint: `${botName ?? "jarvis"}-watcher`,
      botName, model, timeoutMs,
    });
    const durationMs = Date.now() - start;
    log.info("Digest ready in {duration}s ({model}, {count} tweets)", {
      botName, duration: (durationMs / 1000).toFixed(1), model, count: texts.length,
    });
    return [{
      id: `x-digest-${Date.now()}`,
      source: "x",
      summary: result,
      urgency: "low" as const,
      trackingIds,
    }];
  } catch (err) {
    log.error("Summarization failed, skipping digest ({count} tweets lost): {error}", {
      botName, count: texts.length, model, error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
