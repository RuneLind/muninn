import type { Watcher, WatcherAlert } from "../types.ts";
import { decodeEntities, extractTag } from "./news.ts";
import { isSkipResult } from "./x.ts";
import { spawnHaiku, DEFAULT_MODEL } from "../scheduler/executor.ts";
import { extractJson } from "../ai/json-extract.ts";
import { getWatcherSnapshot, setWatcherSnapshot } from "../db/watchers.ts";
import { getLog } from "../logging.ts";

const log = getLog("watchers", "anthropic");

/**
 * Cap entries considered per feed per run. Above news.ts's 10 because a busy feed
 * (claude-code/commits) can land >10 entries in one 2h interval; the feed is
 * append-only, so anything past the cap that scrolls out of the next run's window
 * is missed permanently. 20 covers typical bursts while keeping the cold-start
 * baseline (≤feeds×cap ids) well under the runner's 400-id cap.
 */
const MAX_PER_FEED = 20;
/**
 * How far back to consider entries — a bound on the candidate SET, not the dedup
 * key. Dedup rides `last_notified_ids` (by entry id) in the runner; this only
 * limits how much of each feed's window we read so a long-idle watcher doesn't
 * resurface ancient entries.
 */
const DEFAULT_LOOKBACK_DAYS = 7;

/**
 * Verified Tier-1 Atom feeds (CONTEXT.md §11c). For the content repos
 * (cookbooks/quickstarts/courses/skills/tutorial) the *commits* feed is the real
 * signal — their `releases.atom` returns 200 but is usually empty. Release feeds
 * matter for claude-code + the two SDKs. Override per-watcher via `config.feeds`.
 *
 * Phase 1 narrowed the live watcher to releases-only to cut per-commit noise; with
 * the Phase 3 Haiku gate (`config.gate`) the full high-churn set can be restored —
 * routine commits are scored low and tracked silently instead of alerting.
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

/** Primary Tier-2 doc index (CONTEXT.md §11c): ~1753 doc-URL lines, no clean feed. */
const DEFAULT_LLMS_TXT_URL = "https://platform.claude.com/llms.txt";
/** Tier-2 blog/research listings (SSR HTML, no feed): diff the `/section/<slug>` set. */
const DEFAULT_BLOG_SECTIONS: readonly string[] = ["news", "engineering", "research"];

/** Default Haiku-gate threshold once `config.gate` is on. The model already omits
 *  routine churn; this is a defensive floor (Phase 4 calibrates against real output). */
const DEFAULT_MIN_SCORE = 0.5;
/** Gate model-call timeout when `config.timeoutMs` is unset. Kept UNDER the runner's
 *  120s watcher-timeout floor so the inner call settles before the outer net fires;
 *  set `config.timeoutMs` (≥ ~150s) on watchers that gate large candidate batches —
 *  the runner then widens its net to config.timeoutMs + 30s. */
const DEFAULT_GATE_TIMEOUT_MS = 90_000;

/**
 * Quality-gate prompt: score each new candidate 0–1 for whether it's worth
 * interrupting a senior AI engineer who lives in Claude Code. Mirrors the `x`
 * watcher's quiet-mode "surface only the exceptional, else suppress" shape, but
 * per-candidate (JSON array) so each surfaced alert carries its own "why".
 */
export const DEFAULT_ANTHROPIC_GATE_PROMPT = `You are a quality gate for proactive alerts sent to a senior AI engineer who lives in Claude Code and builds agents, tools, and retrieval systems. They only want to be interrupted for genuinely notable NEW Anthropic releases, docs, blog posts, or research — not routine churn.

Weight HIGHEST: Claude Code features and releases; agents, tool use, and MCP; retrieval, RAG, and evals; new models or model updates; meaningful API or SDK changes.
Weight LOW (omit): typo/whitespace fixes, dependency bumps, CI/internal chores, doc reformatting, minor wording tweaks, routine version housekeeping, and translated or duplicate doc pages.

Below is a numbered list of new candidates (GitHub commits/releases, new docs, and new blog/research posts). For EACH candidate that clears the bar, output one object:
  {"n": <the candidate number>, "score": <0.0-1.0>, "why": "<one short line on why it matters to this engineer>"}
Use ~1.0 for must-see, ~0.7 for clearly relevant, ~0.5 for borderline. OMIT candidates that are routine churn — do not output them at all.

Return ONLY a JSON array of these objects, no prose and no markdown fences. If nothing clears the bar, return [].`;

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
  // --- Tier-2 snapshot-and-diff (Phase 3) ---
  /** Enable the llms.txt + blog slug-set diff. Off by default (Phase-1 watchers stay Tier-1-only). */
  tier2?: boolean;
  /** Override the llms.txt doc index URL. */
  llmsTxtUrl?: string;
  /** anthropic.com listing sections to diff (default news/engineering/research). */
  blogSections?: string[];
  // --- Haiku quality gate (Phase 3) ---
  /** Run new candidates (Tier-1 entries + Tier-2 additions) through the Haiku scorer. */
  gate?: boolean;
  /** Drop scored candidates below this 0–1 threshold (default 0.5 when the gate is on). */
  minScore?: number;
  /** Gate model (default Haiku via executor's DEFAULT_MODEL). */
  model?: string;
  /** Gate model-call timeout in ms. Set ≥ ~150000 so it clears the runner's 120s floor. */
  timeoutMs?: number;
  /** Allow the model to return the literal "SKIP" to suppress the whole batch silently. */
  quietMode?: boolean;
  /** Override the gate criteria prompt. */
  prompt?: string;
}

/** A new item to potentially alert on — a Tier-1 feed entry or a Tier-2 doc/blog addition. */
interface Candidate {
  /** Dedup key in last_notified_ids: Tier-1 = the GitHub URL; Tier-2 = `an:<url>`. */
  id: string;
  /** Display + gate-prompt label for the source ("Recent Commits to …", "Docs (llms.txt)", "News"). */
  sourceLabel: string;
  /** The item's own label — commit/release title, doc title, or prettified blog slug. */
  label: string;
  url: string;
}

interface GateScore {
  n: number;
  score: number;
  why: string;
}

/** Snapshot key namespace, one row per Tier-2 source. */
const SNAP_LLMS = "tier2:llms";
const snapBlogKey = (section: string) => `tier2:blog:${section}`;

/**
 * Tier-1 + Tier-2 alert watcher. Tier-1 polls the verified Anthropic GitHub Atom
 * feeds; Tier-2 (opt-in via `config.tier2`) diffs the feed-less surfaces
 * (`llms.txt` doc set + `anthropic.com/{news,engineering,research}` slug sets)
 * against a stored snapshot. New candidates are optionally scored by a Haiku
 * quality gate (`config.gate`); only those clearing `minScore` alert (each with a
 * one-line "why"), the rest are tracked silently. Dedup rides `last_notified_ids`
 * (the runner skips content-hash dedup for type='anthropic').
 */
export async function checkAnthropic(watcher: Watcher): Promise<WatcherAlert[]> {
  const config = (watcher.config ?? {}) as AnthropicConfig;

  const tier1Entries = await fetchTier1Entries(config);
  const tier2 = config.tier2
    ? await fetchTier2(config, watcher.id)
    : { candidates: [] as Candidate[], fresh: [] as { key: string; urls: string[] }[] };

  // Persist the freshly-fetched Tier-2 sets that survived their fetch. Only called
  // once we're sure we won't retry (cold-start, no-candidates, or after a clean
  // gate pass) — a gate failure leaves snapshots untouched so the same additions
  // re-surface next run. Per-source: a failed fetch isn't in `fresh`, so its
  // snapshot isn't advanced and that source retries.
  const persistTier2 = async () => {
    for (const f of tier2.fresh) {
      try {
        await setWatcherSnapshot(watcher.id, f.key, f.urls);
      } catch (err) {
        log.error("Failed to persist Tier-2 snapshot {key}: {error}", {
          key: f.key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  // Cold start: a fresh watcher has empty last_notified_ids. Record the Tier-1
  // baseline as a single silent alert (its ids persist without notifying), and
  // baseline every Tier-2 snapshot — so run 1 fires nothing despite ~1753 docs.
  if (watcher.lastNotifiedIds.length === 0) {
    await persistTier2();
    if (tier1Entries.length === 0) {
      log.warn("Watcher \"{name}\": cold start with no Tier-1 entries", { name: watcher.name });
      return [];
    }
    log.info("Watcher \"{name}\": cold-start baseline of {n} Tier-1 entries (silent)", {
      name: watcher.name,
      n: tier1Entries.length,
    });
    return [
      {
        id: `anthropic:baseline:${watcher.id}`,
        source: "anthropic",
        summary: `Baseline recorded (${tier1Entries.length} entries) — future updates will alert.`,
        urgency: "low",
        silent: true,
        trackingIds: tier1Entries.map((e) => e.id),
      },
    ];
  }

  // Steady state: only genuinely-new items become candidates. Filtering Tier-1
  // entries against last_notified_ids here (not just in the runner) keeps the gate
  // batch small — it sees the delta since last run, not the whole 7-day window.
  const known = new Set(watcher.lastNotifiedIds);
  const candidates: Candidate[] = [
    ...tier1Entries.filter((e) => !known.has(e.id)).map(toFeedCandidate),
    ...tier2.candidates.filter((c) => !known.has(c.id)),
  ];

  if (candidates.length === 0) {
    await persistTier2();
    return [];
  }

  // No gate → Phase-1 behavior: one alert per new candidate.
  if (!config.gate) {
    await persistTier2();
    return candidates.map(toPlainAlert);
  }

  // Gate the candidates. On failure return [] WITHOUT advancing snapshots so the
  // additions re-surface and retry next run (mirrors the x watcher's no-fallback).
  let scored: GateScore[] | "SKIP_ALL";
  try {
    scored = await runGate(candidates, config, watcher);
  } catch (err) {
    log.error("Watcher \"{name}\": gate failed, suppressing {count} candidate(s) this run: {error}", {
      name: watcher.name,
      count: candidates.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  await persistTier2();

  // quietMode SKIP → suppress all, but track ids so they aren't re-evaluated.
  if (scored === "SKIP_ALL") {
    log.info("Watcher \"{name}\": gate returned SKIP, silencing {count} candidate(s)", {
      name: watcher.name,
      count: candidates.length,
    });
    return [silentAlert(candidates.map((c) => c.id))];
  }

  const minScore = config.minScore ?? DEFAULT_MIN_SCORE;
  const selected = new Map<number, GateScore>();
  for (const s of scored) {
    if (s.score >= minScore && s.n >= 1 && s.n <= candidates.length) selected.set(s.n, s);
  }

  const visible: WatcherAlert[] = [];
  const silentIds: string[] = [];
  candidates.forEach((c, i) => {
    const hit = selected.get(i + 1);
    if (hit) visible.push(toGatedAlert(c, hit));
    else silentIds.push(c.id);
  });

  log.info("Watcher \"{name}\": gate surfaced {visible}/{total} candidate(s)", {
    name: watcher.name,
    visible: visible.length,
    total: candidates.length,
  });

  const alerts: WatcherAlert[] = [...visible];
  if (silentIds.length > 0) alerts.push(silentAlert(silentIds));
  return alerts;
}

// --- Tier-1: GitHub Atom feeds ---

async function fetchTier1Entries(config: AnthropicConfig): Promise<AtomEntry[]> {
  const feeds = config.feeds?.length ? config.feeds : [...DEFAULT_ANTHROPIC_FEEDS];
  const lookbackMs = (config.lookbackDays ?? DEFAULT_LOOKBACK_DAYS) * 86_400_000;
  const cutoff = Date.now() - lookbackMs;

  // Fetch + parse each feed in isolation: one feed's failure must not drop the rest.
  const entries: AtomEntry[] = [];
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
      const parsed = parseAtomEntries(xml)
        .filter((e) => e.updated === 0 || e.updated >= cutoff)
        .slice(0, MAX_PER_FEED);
      entries.push(...parsed);
    } catch (err) {
      log.error("Fetch/parse failed for {feed}: {error}", {
        feed: feedUrl,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return entries;
}

function toFeedCandidate(e: AtomEntry): Candidate {
  return {
    id: e.id,
    sourceLabel: e.feedTitle,
    label: e.title.split("\n")[0]!.trim().slice(0, 200),
    url: e.url,
  };
}

// --- Tier-2: snapshot-and-diff of the feed-less surfaces ---

interface Tier2Source {
  key: string;
  sourceLabel: string;
  /** Fetch the current set as url → display label. Throws on a fetch/parse error. */
  fetch: () => Promise<Map<string, string>>;
}

function buildTier2Sources(config: AnthropicConfig): Tier2Source[] {
  const sources: Tier2Source[] = [];
  const llmsUrl = config.llmsTxtUrl ?? DEFAULT_LLMS_TXT_URL;
  sources.push({
    key: SNAP_LLMS,
    sourceLabel: "Docs (llms.txt)",
    fetch: () => fetchLlmsTxtDocs(llmsUrl),
  });
  const sections = config.blogSections?.length ? config.blogSections : [...DEFAULT_BLOG_SECTIONS];
  for (const section of sections) {
    sources.push({
      key: snapBlogKey(section),
      sourceLabel: blogLabel(section),
      fetch: () => fetchBlogSlugs(section),
    });
  }
  return sources;
}

/**
 * Diff each Tier-2 source's freshly-fetched URL set against its stored snapshot.
 * URLs not in the snapshot are candidates. A source with no snapshot yet is a
 * cold start: record the baseline silently (no candidates). Per-source isolation:
 * a fetch that throws is skipped (snapshot left untouched → retry next run).
 */
async function fetchTier2(
  config: AnthropicConfig,
  watcherId: string,
): Promise<{ candidates: Candidate[]; fresh: { key: string; urls: string[] }[] }> {
  const candidates: Candidate[] = [];
  const fresh: { key: string; urls: string[] }[] = [];

  for (const src of buildTier2Sources(config)) {
    try {
      const freshMap = await src.fetch();
      const freshUrls = [...freshMap.keys()];

      const snap = await getWatcherSnapshot(watcherId, src.key);
      if (snap == null) {
        // Cold start for this source: baseline silently, no candidates.
        log.info("Tier-2 {key}: cold-start baseline of {n} url(s) (silent)", {
          key: src.key,
          n: freshUrls.length,
        });
      } else {
        const seen = new Set(Array.isArray(snap) ? (snap as string[]) : []);
        for (const [url, label] of freshMap) {
          if (!seen.has(url)) {
            candidates.push({ id: `an:${url}`, sourceLabel: src.sourceLabel, label, url });
          }
        }
      }
      // Mark for persistence regardless: baseline on cold start, advance otherwise.
      fresh.push({ key: src.key, urls: freshUrls });
    } catch (err) {
      log.error("Tier-2 fetch/parse failed for {key}: {error}", {
        key: src.key,
        error: err instanceof Error ? err.message : String(err),
      });
      // No `fresh` entry → snapshot not advanced → this source retries next run.
    }
  }
  return { candidates, fresh };
}

async function fetchLlmsTxtDocs(url: string): Promise<Map<string, string>> {
  const res = await fetch(url, {
    headers: { "User-Agent": "muninn-anthropic-watcher", Accept: "text/plain, text/markdown, */*" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return parseLlmsTxtDocs(await res.text());
}

async function fetchBlogSlugs(section: string): Promise<Map<string, string>> {
  const url = `https://www.anthropic.com/${section}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "muninn-anthropic-watcher", Accept: "text/html, */*" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return parseBlogSlugs(await res.text(), section);
}

/**
 * Extract the doc-URL set from `llms.txt`. Each line is a markdown link
 * `- [Title](https://platform.claude.com/docs/en/….md)`; we keep links whose URL
 * is under `/docs/` and ends in `.md` (excludes the one `llms-full.txt` link and
 * any non-doc links). Returns url → title for alert labels.
 */
export function parseLlmsTxtDocs(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const url = m[2]!;
    if (!url.includes("/docs/") || !url.endsWith(".md")) continue;
    if (!map.has(url)) {
      const label = decodeEntities(m[1]!.trim());
      map.set(url, label || url);
    }
  }
  return map;
}

/**
 * Extract the `/section/<slug>` set from a server-rendered anthropic.com listing.
 * Hrefs are `href="/news/<slug>"` (relative) or the absolute form; we skip
 * sub-paths and empty slugs. Returns canonical url → prettified slug label.
 */
export function parseBlogSlugs(html: string, section: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = new RegExp(`href="(?:https?://www\\.anthropic\\.com)?/${section}/([^"#?]+)"`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const slug = m[1]!.replace(/\/+$/, "");
    if (!slug || slug.includes("/")) continue; // skip sub-paths / the bare section page
    const url = `https://www.anthropic.com/${section}/${slug}`;
    if (!map.has(url)) map.set(url, prettifySlug(slug));
  }
  return map;
}

function blogLabel(section: string): string {
  return section.charAt(0).toUpperCase() + section.slice(1);
}

function prettifySlug(slug: string): string {
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// --- Haiku quality gate ---

/**
 * Score the candidate batch with one Haiku call. Returns the parsed
 * `{n, score, why}` array (model omits routine churn), or "SKIP_ALL" when
 * quietMode is on and the model replied with the literal "SKIP". Throws on a
 * model error or unparseable output so the caller can retry next run.
 */
async function runGate(
  candidates: Candidate[],
  config: AnthropicConfig,
  watcher: Watcher,
): Promise<GateScore[] | "SKIP_ALL"> {
  const list = candidates
    .map((c, i) => `${i + 1}. [${c.sourceLabel}] ${c.label}\n   ${c.url}`)
    .join("\n");
  const criteria = config.prompt || DEFAULT_ANTHROPIC_GATE_PROMPT;
  const prompt = `${criteria}\n\nCandidates:\n\n${list}`;

  const model = config.model || DEFAULT_MODEL;
  const timeoutMs = config.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  log.info("Watcher \"{name}\": scoring {count} candidate(s) with {model} (timeout {t}s)", {
    name: watcher.name,
    count: candidates.length,
    model,
    t: Math.round(timeoutMs / 1000),
  });

  const { result } = await spawnHaiku(prompt, {
    source: "watcher-anthropic",
    entrypoint: `${watcher.botName ?? "jarvis"}-watcher`,
    botName: watcher.botName,
    model,
    timeoutMs,
  });

  if (config.quietMode && isSkipResult(result)) return "SKIP_ALL";

  const parsed = extractJson<unknown[]>(result);
  if (!Array.isArray(parsed)) throw new Error("gate did not return a JSON array");
  return parsed
    .map((p) => {
      const o = (p ?? {}) as Record<string, unknown>;
      return { n: Number(o.n), score: Number(o.score), why: String(o.why ?? "") };
    })
    .filter((p) => Number.isFinite(p.n) && Number.isFinite(p.score));
}

// --- Alert builders ---

function toPlainAlert(c: Candidate): WatcherAlert {
  return {
    id: c.id,
    source: "anthropic",
    sender: c.sourceLabel,
    subject: c.label,
    summary: `**${c.sourceLabel}** — ${c.label}\n${c.url}`,
    urgency: "low",
  };
}

function toGatedAlert(c: Candidate, score: GateScore): WatcherAlert {
  const why = score.why.trim();
  const summary = why
    ? `**${c.sourceLabel}** — ${c.label}\n_${why}_\n${c.url}`
    : `**${c.sourceLabel}** — ${c.label}\n${c.url}`;
  return {
    id: c.id,
    source: "anthropic",
    sender: c.sourceLabel,
    subject: c.label,
    summary,
    urgency: score.score >= 0.85 ? "high" : score.score >= 0.6 ? "medium" : "low",
  };
}

/**
 * One silent alert carrying the gated-out (or quiet-suppressed) candidate ids as
 * trackingIds — the runner persists them into last_notified_ids without notifying,
 * so they aren't re-evaluated next run. Unique id (never deduped) so its trackingIds
 * always persist, mirroring the x watcher's silent alert.
 */
function silentAlert(trackingIds: string[]): WatcherAlert {
  return {
    id: `anthropic:silent:${Date.now()}`,
    source: "anthropic",
    summary: "",
    urgency: "low",
    trackingIds,
    silent: true,
  };
}

// --- Atom parser (Phase 1) ---

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
