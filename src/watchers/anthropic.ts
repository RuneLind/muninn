import type { Watcher, WatcherAlert } from "../types.ts";
import { decodeEntities, extractTag } from "./news.ts";
import { getLog } from "../logging.ts";

const log = getLog("watchers", "anthropic");

/** Cap entries considered per feed per run (mirrors news.ts MAX_RESULTS). */
const MAX_PER_FEED = 10;
/**
 * How far back to consider entries — a bound on the candidate SET, not the dedup
 * key. Dedup rides `last_notified_ids` (by entry id) in the runner; this only
 * limits how much of each feed's window we read so a long-idle watcher doesn't
 * resurface ancient entries.
 */
const DEFAULT_LOOKBACK_DAYS = 14;

/**
 * Verified Tier-1 Atom feeds (CONTEXT.md §11c). For the content repos
 * (cookbooks/quickstarts/courses/skills/tutorial) the *commits* feed is the real
 * signal — their `releases.atom` returns 200 but is usually empty. Release feeds
 * matter for claude-code + the two SDKs. Override per-watcher via `config.feeds`.
 */
export const DEFAULT_ANTHROPIC_FEEDS: readonly string[] = [
  "https://github.com/anthropics/claude-code/commits/main.atom",
  "https://github.com/anthropics/claude-code/releases.atom",
  "https://github.com/anthropics/anthropic-sdk-python/releases.atom",
  "https://github.com/anthropics/anthropic-sdk-typescript/releases.atom",
  "https://github.com/anthropics/claude-cookbooks/commits/main.atom",
  "https://github.com/anthropics/claude-quickstarts/commits/main.atom",
  "https://github.com/anthropics/courses/commits/master.atom",
  "https://github.com/anthropics/prompt-eng-interactive-tutorial/commits/master.atom",
  "https://github.com/anthropics/skills/commits/main.atom",
  "https://github.com/modelcontextprotocol/modelcontextprotocol/commits/main.atom",
];

export interface AtomEntry {
  /** Canonical id = the entry's alternate `<link href>`. */
  id: string;
  title: string;
  url: string;
  /** epoch ms from `<published>` (else `<updated>`); 0 if missing/unparseable. */
  updated: number;
  feedTitle: string;
}

interface AnthropicConfig {
  feeds?: string[];
  lookbackDays?: number;
}

/**
 * Tier-1 alert watcher: poll the verified Anthropic GitHub Atom feeds and emit one
 * `WatcherAlert` per new entry. No LLM, no quality gate (that lands in Phase 3) —
 * the runner dedups by entry id against `last_notified_ids`.
 */
export async function checkAnthropic(watcher: Watcher): Promise<WatcherAlert[]> {
  const config = (watcher.config ?? {}) as AnthropicConfig;
  const feeds = config.feeds?.length ? config.feeds : [...DEFAULT_ANTHROPIC_FEEDS];
  const lookbackMs = (config.lookbackDays ?? DEFAULT_LOOKBACK_DAYS) * 86_400_000;
  const cutoff = Date.now() - lookbackMs;

  // Fetch + parse each feed in isolation: one feed's failure must not drop the rest.
  const candidates: AtomEntry[] = [];
  for (const feedUrl of feeds) {
    try {
      const res = await fetch(feedUrl, {
        headers: {
          "User-Agent": "muninn-anthropic-watcher",
          Accept: "application/atom+xml, application/xml;q=0.9, */*;q=0.8",
        },
      });
      if (!res.ok) {
        log.warn("HTTP {status} for {feed}", { status: res.status, feed: feedUrl });
        continue;
      }
      const xml = await res.text();
      const entries = parseAtomEntries(xml)
        .filter((e) => e.updated === 0 || e.updated >= cutoff)
        .slice(0, MAX_PER_FEED);
      candidates.push(...entries);
    } catch (err) {
      log.error("Fetch/parse failed for {feed}: {error}", {
        feed: feedUrl,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (candidates.length === 0) {
    log.warn("Watcher \"{name}\": no entries from any feed", { name: watcher.name });
    return [];
  }

  // Cold start: a fresh watcher has empty last_notified_ids. Firing one alert per
  // visible entry would burst ~100 messages on run 1. Instead record a single
  // *silent* baseline carrying every current id as trackingIds — the runner persists
  // them (without notifying), so from run 2 on the id-diff surfaces only new entries.
  if (watcher.lastNotifiedIds.length === 0) {
    log.info("Watcher \"{name}\": cold-start baseline of {n} entries (silent)", {
      name: watcher.name,
      n: candidates.length,
    });
    return [
      {
        id: `anthropic:baseline:${watcher.id}`,
        source: "anthropic",
        summary: `Baseline recorded (${candidates.length} entries) — future updates will alert.`,
        urgency: "low",
        silent: true,
        trackingIds: candidates.map((c) => c.id),
      },
    ];
  }

  // Steady state: one candidate per entry. The runner drops any id already in
  // last_notified_ids, so only genuinely-new entries become real alerts.
  return candidates.map((c) => {
    const title = c.title.split("\n")[0]!.trim().slice(0, 200);
    return {
      id: c.id,
      source: "anthropic",
      sender: c.feedTitle,
      subject: title,
      summary: `**${c.feedTitle}** — ${title}\n${c.url}`,
      urgency: "low" as const,
    };
  });
}

/**
 * Minimal Atom parser. Muninn's `parseRssItems` is RSS-2.0-only (`<item>`/`<pubDate>`/
 * `<link>`-text) and returns zero items on Atom, whose entries use `<entry>`/
 * `<published>`|`<updated>` and carry the URL in a `<link href="...">` *attribute*
 * (`extractTag` reads element text only, so it can't get the href). We reuse
 * `extractTag` (which decodes + trims) for the text fields and add href extraction.
 */
export function parseAtomEntries(xml: string): AtomEntry[] {
  const feedTitle = extractFeedTitle(xml) ?? "Anthropic";
  const entries: AtomEntry[] = [];
  const entryRegex = /<entry[\s>]([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;
  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1]!;
    const title = extractTag(block, "title"); // extractTag already decodes + trims
    const url = extractAlternateHref(block);
    if (!title || !url) continue;
    const ts = extractTag(block, "published") ?? extractTag(block, "updated");
    const updatedMs = ts ? new Date(ts).getTime() : 0;
    entries.push({
      id: url,
      url,
      title,
      updated: Number.isNaN(updatedMs) ? 0 : updatedMs,
      feedTitle,
    });
  }
  return entries;
}

/** The feed-level `<title>` is the first one, before any `<entry>`. */
function extractFeedTitle(xml: string): string | null {
  const head = xml.split(/<entry[\s>]/)[0]!;
  return extractTag(head, "title");
}

/**
 * Atom links are `<link rel="alternate" type="text/html" href="..."/>`, but GitHub
 * varies the attribute order between feeds (releases put `rel` first, commits put
 * `type` first). So collect every `<link>` tag, prefer the `rel="alternate"` one
 * (the human page), and pull `href` independently of attribute order.
 */
function extractAlternateHref(block: string): string | null {
  const links = [...block.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  if (links.length === 0) return null;
  const alternate = links.find((l) => /rel=["']alternate["']/i.test(l)) ?? links[0]!;
  const href = alternate.match(/href=["']([^"']+)["']/i);
  return href ? decodeEntities(href[1]!) : null;
}
