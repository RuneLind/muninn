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
  is_retweet: boolean;
  quoted_tweet: XTweet | null;
  media: { type: string; url: string }[] | null;
}

export const DEFAULT_X_PROMPT = `Create a concise morning digest in markdown:
- Group tweets by topic/theme (tech, news, people, etc.)
- Highlight the most interesting or high-engagement posts
- Skip ads, low-value retweets, and noise
- Use bullet points, keep it scannable
- Include @handles for attribution
- Max 15 bullet points total
- Write in a casual, informative tone`;

export async function checkX(watcher: Watcher, _cwd?: string, botName?: string): Promise<WatcherAlert[]> {
  const config = watcher.config as { pages?: number; prompt?: string };
  const pages = config.pages ?? 3;

  // Fetch timeline from huginn's X fetcher
  let tweets: XTweet[];
  try {
    const proc = Bun.spawn(
      ["uv", "run", FETCHER_SCRIPT, "--pages", String(pages)],
      { cwd: HUGINN_PATH, stdout: "pipe", stderr: "pipe" },
    );

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;

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

  log.info("Fetched {total} tweets, {newCount} new, summarizing with Haiku", {
    botName, total: tweets.length, newCount: newTweets.length,
  });

  // Track all tweet IDs (prefixed to avoid collision with other ID types)
  const trackingIds = newTweets.map((t) => `tw:${t.id}`);

  // Build a compact representation for Haiku
  const tweetSummaries = newTweets.map((t) => {
    let line = `@${t.handle}: ${t.text}`;
    if (t.is_retweet) line = `[RT] ${line}`;
    if (t.likes > 50) line += ` (${t.likes} likes)`;
    if (t.quoted_tweet) line += `\n  > @${t.quoted_tweet.handle}: ${t.quoted_tweet.text}`;
    return line;
  }).join("\n---\n");

  const userPrompt = config.prompt || DEFAULT_X_PROMPT;

  const prompt = `You are summarizing a user's X/Twitter timeline into a morning digest.

Here are ${newTweets.length} tweets from the home timeline:

${tweetSummaries}

${userPrompt}`;

  try {
    const { result } = await spawnHaiku(prompt, "watcher-x", `${botName ?? "jarvis"}-watcher`);
    return [{
      id: `x-digest-${Date.now()}`,
      source: "x",
      summary: result,
      urgency: "low" as const,
      trackingIds,
    }];
  } catch (err) {
    log.error("Haiku summarization failed: {error}", { botName, error: err instanceof Error ? err.message : String(err) });

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
