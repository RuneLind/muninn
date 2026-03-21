import type { Watcher, WatcherAlert } from "../types.ts";
import { spawnHaiku } from "../scheduler/executor.ts";
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
  /** Set to collection name (e.g. "x-feed") to query huginn's indexed collection instead of spawning the fetcher */
  collection?: string;
  /** Knowledge API URL (default: http://localhost:8321) */
  apiUrl?: string;
}

// --- Collection path (queries huginn's indexed x-feed collection) ---

const DEFAULT_API_URL = "http://localhost:8321";
const MAX_COLLECTION_DOCS = 80;

interface CollectionDoc {
  id: string;
  url: string;
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

  // Filter to new tweets not in lastNotifiedIds
  const newDocs = docs.filter((d) => !known.has(`tw:${extractTweetId(d.id)}`));

  if (newDocs.length === 0) {
    log.info("All {count} collection documents already seen", { botName, count: docs.length });
    return { texts: [], trackingIds: [] };
  }

  // Fetch full content for new documents (cap to avoid huge prompts)
  const toFetch = newDocs.slice(0, MAX_COLLECTION_DOCS);
  const texts: string[] = [];
  const trackingIds: string[] = [];

  // Fetch in parallel batches of 10
  for (let i = 0; i < toFetch.length; i += 10) {
    const batch = toFetch.slice(i, i + 10);
    const results = await Promise.all(
      batch.map(async (doc) => {
        try {
          const resp = await fetch(`${apiUrl}/api/document/${encodeURIComponent(collection)}/${encodeURIComponent(doc.id)}`);
          if (!resp.ok) return null;
          const data = await resp.json() as { text: string };
          return { docId: doc.id, text: data.text };
        } catch {
          return null;
        }
      }),
    );
    for (const r of results) {
      if (r) {
        texts.push(r.text);
        trackingIds.push(`tw:${extractTweetId(r.docId)}`);
      }
    }
  }

  log.info("Collection: {total} docs, {newCount} new, {fetched} fetched", {
    botName, total: docs.length, newCount: newDocs.length, fetched: texts.length,
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

  log.info("Fetcher: {total} tweets, {newCount} new", {
    botName, total: tweets.length, newCount: newTweets.length,
  });

  const trackingIds = newTweets.map((t) => `tw:${t.id}`);

  // Build text summaries with engagement signals
  const texts = newTweets.map((t) => {
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

Here are ${texts.length} tweets from the home timeline:

${texts.join(separator)}

${userPrompt}`;

  try {
    const { result } = await spawnHaiku(prompt, {
      source: "watcher-x", entrypoint: `${botName ?? "jarvis"}-watcher`,
      botName, model: config.model,
    });
    return [{
      id: `x-digest-${Date.now()}`,
      source: "x",
      summary: result,
      urgency: "low" as const,
      trackingIds,
    }];
  } catch (err) {
    log.error("Summarization failed: {error}", { botName, error: err instanceof Error ? err.message : String(err) });

    // Fall back to first 10 texts truncated
    const fallback = texts.slice(0, 10).map((t) => t.slice(0, 200)).join("\n\n");
    return [{
      id: `x-digest-${Date.now()}`,
      source: "x",
      summary: fallback,
      urgency: "low" as const,
      trackingIds,
    }];
  }
}
