import type { Watcher, WatcherAlert } from "../types.ts";

const MAX_RESULTS = 10;

export async function checkNews(watcher: Watcher): Promise<WatcherAlert[]> {
  const config = watcher.config as { filter?: string };
  const keywords = config.filter;

  if (!keywords) {
    console.log(`[news] Watcher "${watcher.name}" has no keywords, skipping`);
    return [];
  }

  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(keywords)}&hl=en&gl=US&ceid=US:en`;

  let xml: string;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`[news] HTTP ${res.status} for "${keywords}"`);
      return [];
    }
    xml = await res.text();
  } catch (err) {
    console.error(`[news] Fetch failed for "${keywords}":`, err);
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
    summary: `<b>${escapeHtml(item.sourceName)}</b> — ${escapeHtml(item.title)}\n${item.link}`,
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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
