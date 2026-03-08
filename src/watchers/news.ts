import type { Watcher, WatcherAlert } from "../types.ts";
import { getLog } from "../logging.ts";

const log = getLog("watchers", "news");

const MAX_RESULTS = 10;

export async function checkNews(watcher: Watcher): Promise<WatcherAlert[]> {
  const config = watcher.config as { filter?: string };
  const keywords = config.filter;

  if (!keywords) {
    log.warn("Watcher \"{name}\" has no keywords, skipping", { name: watcher.name });
    return [];
  }

  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(keywords)}&hl=en&gl=US&ceid=US:en`;

  let xml: string;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      log.warn("HTTP {status} for \"{keywords}\"", { status: res.status, keywords });
      return [];
    }
    xml = await res.text();
  } catch (err) {
    log.error("Fetch failed for \"{keywords}\": {error}", { keywords, error: err instanceof Error ? err.message : String(err) });
    return [];
  }

  const items = parseRssItems(xml);

  // Filter to articles published after last run
  const since = watcher.lastRunAt ?? 0;
  const recent = items.filter((item) => item.pubDate > since);

  return recent.slice(0, MAX_RESULTS).map((item) => ({
    id: item.link,
    source: "news",
    sender: item.sourceName,
    subject: item.title,
    summary: `**${item.sourceName}** — ${item.title}\n${item.link}`,
    urgency: "low" as const,
  }));
}

interface RssItem {
  title: string;
  link: string;
  pubDate: number;
  sourceName: string;
}

function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1]!;
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const pubDateStr = extractTag(block, "pubDate");
    const sourceName = extractSourceName(block);

    if (!title || !link) continue;

    const pubDate = pubDateStr ? new Date(pubDateStr).getTime() : 0;
    if (isNaN(pubDate)) continue;

    items.push({ title, link, pubDate, sourceName: sourceName || "Unknown" });
  }

  return items;
}

function extractTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  if (match) return decodeEntities(match[1]!.trim());

  // <link> in RSS is often self-closing or just text after the tag
  if (tag === "link") {
    const linkMatch = xml.match(/<link[^>]*>\s*(https?:\/\/[^\s<]+)/);
    return linkMatch ? linkMatch[1]!.trim() : null;
  }
  return null;
}

function extractSourceName(block: string): string | null {
  // Google News RSS uses <source url="...">Source Name</source>
  const match = block.match(/<source[^>]*>([\s\S]*?)<\/source>/);
  return match ? decodeEntities(match[1]!.trim()) : null;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}
