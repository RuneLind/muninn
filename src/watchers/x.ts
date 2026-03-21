import type { Watcher, WatcherAlert } from "../types.ts";
import { spawnHaiku } from "../scheduler/executor.ts";
import { getLog } from "../logging.ts";
import path from "node:path";

const log = getLog("watchers", "x");

const HUGINN_PATH = path.resolve(import.meta.dir, "../../../huginn");
const FETCHER_SCRIPT = "scripts/x/fetchers/x_fetcher.py";

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

const FETCHER_TIMEOUT_MS = 60_000;
const MAX_PAGES = 10;

interface XWatcherConfig {
  pages?: number;
  prompt?: string;
  model?: string;
}

export async function checkX(watcher: Watcher, _cwd?: string, botName?: string): Promise<WatcherAlert[]> {
  const config = watcher.config as XWatcherConfig;
  const pages = Math.min(config.pages ?? 3, MAX_PAGES);

  // Fetch timeline from huginn's X fetcher
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
      return [];
    }

    tweets = JSON.parse(stdout);
  } catch (err) {
    log.error("Failed to run X fetcher: {error}", { botName, error: err instanceof Error ? err.message : String(err) });
    return [];
  }

  if (tweets.length === 0) {
    log.info("No tweets fetched from timeline", { botName });
    return [];
  }

  // Filter out already-seen tweets (by tweet ID in lastNotifiedIds)
  const known = new Set(watcher.lastNotifiedIds);
  const newTweets = tweets.filter((t) => !known.has(`tw:${t.id}`));

  if (newTweets.length === 0) {
    log.info("All {count} tweets already seen, skipping digest", { botName, count: tweets.length });
    return [];
  }

  log.info("Fetched {total} tweets, {newCount} new, summarizing", {
    botName, total: tweets.length, newCount: newTweets.length,
  });

  // Track all tweet IDs (prefixed to avoid collision with other ID types)
  const trackingIds = newTweets.map((t) => `tw:${t.id}`);

  // Build a compact representation with engagement signals for better curation
  const tweetSummaries = newTweets.map((t) => {
    let line = `@${t.handle}: ${t.text}`;
    if (t.is_retweet) line = `[RT] ${line}`;

    // Engagement signals
    const signals: string[] = [];
    if (t.likes > 50) signals.push(`${t.likes} likes`);
    if (t.views && t.views > 10000) signals.push(`${Math.round(t.views / 1000)}k views`);
    if (t.bookmarks && t.bookmarks > 10) signals.push(`${t.bookmarks} bookmarks`);
    if (signals.length > 0) line += ` (${signals.join(", ")})`;

    // Tweet type
    if (t.tweet_type === "note") line = `[ARTICLE/NOTE] ${line}`;

    if (t.quoted_tweet) line += `\n  > @${t.quoted_tweet.handle}: ${t.quoted_tweet.text}`;
    line += `\n  URL: ${t.url}`;
    return line;
  }).join("\n---\n");

  const userPrompt = config.prompt || DEFAULT_X_PROMPT;

  const prompt = `You are curating a user's X/Twitter timeline into a digest.

Here are ${newTweets.length} tweets from the home timeline:

${tweetSummaries}

${userPrompt}`;

  try {
    const { result } = await spawnHaiku(
      prompt, "watcher-x", `${botName ?? "jarvis"}-watcher`,
      undefined, botName, undefined, config.model,
    );
    return [{
      id: `x-digest-${Date.now()}`,
      source: "x",
      summary: result,
      urgency: "low" as const,
      trackingIds,
    }];
  } catch (err) {
    log.error("Summarization failed: {error}", { botName, error: err instanceof Error ? err.message : String(err) });

    // Fall back to raw tweet list (no summarization)
    const fallback = newTweets.slice(0, 10).map((t) =>
      `**@${t.handle}**: ${t.text.slice(0, 200)}`,
    ).join("\n\n");
    return [{
      id: `x-digest-${Date.now()}`,
      source: "x",
      summary: fallback,
      urgency: "low" as const,
      trackingIds,
    }];
  }
}
