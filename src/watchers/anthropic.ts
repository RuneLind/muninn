import type { Watcher, WatcherAlert } from "../types.ts";
import { decodeEntities, extractTag } from "./news.ts";
import { isSkipResult } from "./x.ts";
import { spawnHaiku, DEFAULT_MODEL } from "../scheduler/executor.ts";
import { extractJson } from "../ai/json-extract.ts";
import { getWatcherSnapshot, setWatcherSnapshot } from "../db/watchers.ts";
import { upsertCandidate, getCandidateBySourceUrl } from "../db/summary-candidates.ts";
import { autoPromoteCandidate } from "../anthropic/summarizer.ts";
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
/** Capture floor for the Candidates → Summaries inbox (config.captureCandidates). A
 *  candidate scored ≥ this lands in the inbox, INDEPENDENT of the alert `minScore` — so
 *  the relevant-but-not-urgent middle (≥0.5, <0.8) that stays silent on Telegram is still
 *  queued for summarizing. Pair captureCandidates with the STANDARD gate prompt
 *  (DEFAULT_ANTHROPIC_GATE_PROMPT), which scores 0.5–1.0; the strict Highlights prompt only
 *  emits ≥0.8, so it would leave the inbox sparse. */
const DEFAULT_CANDIDATE_MIN_SCORE = 0.5;
/** Gate model-call timeout when `config.timeoutMs` is unset. Kept UNDER the runner's
 *  120s watcher-timeout floor so the inner call settles before the outer net fires;
 *  set `config.timeoutMs` (≥ ~150s) on watchers that gate large candidate batches —
 *  the runner then widens its net to config.timeoutMs + 30s. */
const DEFAULT_GATE_TIMEOUT_MS = 90_000;

/**
 * Hard cap on the body excerpt fed to the gate per candidate (Alert depth, §10).
 * A few hundred chars sharpens the score + "why" over a title-only signal without
 * blowing Haiku's context — one gate call can carry ~200 candidates, so this stays
 * modest. Excerpts ride the GATE path only; the digest (which rolls up to 200
 * Tier-1 items into one prompt) stays title-only so its prompt can't balloon.
 */
const MAX_EXCERPT_CHARS = 300;
/**
 * Bound on Tier-2 doc body fetches per gate run. Tier-1 excerpts are free (parsed
 * from the Atom `<content>`); Tier-2 docs need a small `.md` fetch each, so cap the
 * fan-out — beyond this, the extra docs gate title-only.
 */
const MAX_DOC_EXCERPT_FETCHES = 10;
/** Per-fetch timeout for a Tier-2 doc body slice (best-effort, short). */
const DOC_EXCERPT_TIMEOUT_MS = 6_000;

/**
 * Digest-mode (Phase 4) Tier-1 cap. The digest rows roll a whole window's candidates
 * into ONE message; this bounds the Tier-1 (feed) portion fed to the LLM. It equals the
 * structural Tier-1 max (DEFAULT feed count × MAX_PER_FEED = 10 × 20), so it is a safety
 * rail that does not bite in normal operation — per-feed capping already balances feeds.
 * Tier-2 additions are NEVER capped (see runDigest): their dedup is the snapshot, which
 * persistTier2 advances to the full set unconditionally, so an un-surfaced Tier-2
 * addition would be lost forever; a truncated Tier-1 item instead re-surfaces next run
 * via last_notified_ids (within lookbackDays).
 */
const DIGEST_MAX_TIER1 = 200;

/**
 * Quality-gate prompt: score each new candidate 0–1 for whether it's worth
 * interrupting a senior AI engineer who lives in Claude Code. Mirrors the `x`
 * watcher's quiet-mode "surface only the exceptional, else suppress" shape, but
 * per-candidate (JSON array) so each surfaced alert carries its own "why".
 */
export const DEFAULT_ANTHROPIC_GATE_PROMPT = `You are a quality gate for proactive alerts sent to a senior AI engineer who lives in Claude Code and builds agents, tools, and retrieval systems. They only want to be interrupted for genuinely notable NEW Anthropic releases, docs, blog posts, or research — not routine churn.

Weight HIGHEST: Claude Code features and releases; agents, tool use, and MCP; retrieval, RAG, and evals; new models or model updates; meaningful API or SDK changes.
Weight LOW (omit): typo/whitespace fixes, dependency bumps, CI/internal chores, doc reformatting, minor wording tweaks, routine version housekeeping, merge/rollup commits, releases that are just a version bump with a routine changelog, corrections or small follow-ups to already-published posts, and translated or duplicate doc pages.

Below is a numbered list of new candidates (GitHub commits/releases, new docs, and new blog/research posts). For EACH candidate that clears the bar, output one object:
  {"n": <the candidate number>, "score": <0.0-1.0>, "why": "<one short line on why it matters to this engineer>"}
Use ~1.0 for must-see, ~0.7 for clearly relevant, ~0.5 for borderline. OMIT candidates that are routine churn — do not output them at all.
Scores also feed a reading shelf of summarized items: score for whether reading the FULL content would teach this engineer something new — high-signal keywords (Claude, MCP, SDK) alone do not make an item notable.

Return ONLY a JSON array of these objects, no prose and no markdown fences. If nothing clears the bar, return [].`;

/**
 * Highlights gate prompt (Phase 4). A STRICTER variant of the gate prompt for the
 * real-time "Highlights" row: it must stay silent unless something is genuinely
 * exceptional, because a daily and a weekly digest follow. Same JSON-array
 * `{n,score,why}` output contract as the gate prompt, so `runGate` is unchanged.
 * Pair with `minScore: 0.8`.
 */
export const DEFAULT_ANTHROPIC_HIGHLIGHTS_PROMPT = `You are a STRICT real-time quality gate for interrupt alerts sent to a senior AI engineer who lives in Claude Code and builds agents, tools, and retrieval systems. This is the HIGHLIGHTS channel: it must stay silent unless something is genuinely exceptional, because a full daily digest and a weekly digest follow later. Err heavily toward omitting.

Weight HIGHEST: major Claude Code features/releases; significant agents, tool-use, and MCP capabilities; notable retrieval/RAG/evals work; new models or model updates; breaking or high-impact API/SDK changes.
Weight LOW (omit): routine commits, dependency bumps, CI/internal chores, doc reformatting, minor wording tweaks, version housekeeping, translated/duplicate doc pages, and anything merely incremental.

Below is a numbered list of new candidates (GitHub commits/releases, new docs, and new blog/research posts). Output an object ONLY for a candidate that is must-see RIGHT NOW:
  {"n": <the candidate number>, "score": <0.0-1.0>, "why": "<one short line on why it can't wait>"}
Reserve ~1.0 for unmistakable headline news, ~0.85 for clearly exceptional. Do NOT output anything you would score below 0.8 — leave it for the digests. OMIT routine items entirely.

Return ONLY a JSON array of these objects, no prose and no markdown fences. If nothing is exceptional, return [].`;

/**
 * Daily-digest prompt (Phase 4). Rolls the day's gated candidates into ONE message.
 * Used by `runDigest` on the "Anthropic Daily Digest" row (with `quietMode: true`, so
 * the trailing SKIP clause can suppress an all-churn day).
 */
export const DEFAULT_ANTHROPIC_DAILY_PROMPT = `Write a concise daily digest of what Anthropic shipped today for a senior AI engineer who lives in Claude Code and builds agents, tools, and retrieval systems.

Weight HIGHEST: Claude Code features/releases; agents, tool use, and MCP; retrieval, RAG, and evals; new models or model updates; meaningful API/SDK changes. Downweight or omit routine churn: dependency bumps, CI/internal chores, doc reformatting, minor wording, version housekeeping, translated/duplicate pages.

Structure (markdown, no preamble, do NOT start with a heading):
**Top** (up to 5) — the items most worth knowing, each a bold one-liner with a markdown link and a short "why it matters".
**Also notable** (up to 8) — one-line bullets with markdown links, no commentary.

Cluster related items; don't just relist commits. Keep it scannable.
If nothing today clears the bar (only routine churn), respond with exactly: SKIP`;

/**
 * Weekly-digest prompt (Phase 4). Clusters the week's gated candidates into themes +
 * top picks. Used by `runDigest` on the "Anthropic Weekly Digest" row.
 */
export const DEFAULT_ANTHROPIC_WEEKLY_PROMPT = `Write a weekly digest of what Anthropic shipped this week for a senior AI engineer who lives in Claude Code and builds agents, tools, and retrieval systems.

Weight HIGHEST: Claude Code features/releases; agents, tool use, and MCP; retrieval, RAG, and evals; new models or model updates; meaningful API/SDK changes. Omit routine churn.

Structure (markdown, no preamble, do NOT start with a heading):
**Themes of the week** (3-5 bullets) — cluster by topic, one sentence each; what moved this week.
**Top picks** (5-7) — the most valuable individual items, each a bold one-liner with a markdown link and a short "why".
**Also notable** (up to 10) — one-line bullets with markdown links.

Cluster by theme, not by repo. Keep it scannable.`;

export interface AtomEntry {
  /** Canonical id = the entry's alternate `<link href>`. */
  id: string;
  title: string;
  url: string;
  /** epoch ms from `<published>` (else `<updated>`); 0 if missing/unparseable. */
  updated: number;
  feedTitle: string;
  /**
   * Truncated plain-text body slice from the entry's `<content>`/`<summary>`, when
   * the feed carried one (GitHub commit messages / release notes live there). Feeds
   * the quality gate so it scores off content, not just the title. Absent → the gate
   * sees title-only (today's behavior). See {@link MAX_EXCERPT_CHARS}.
   */
  excerpt?: string;
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
  /** Override the gate/digest criteria prompt. */
  prompt?: string;
  // --- Candidate capture (Claude Learning Center, Phase B) ---
  /**
   * Persist gated candidates into the `summary_candidates` inbox (Candidates → Summaries).
   * Gate path only (needs scores). Pair with the standard gate prompt so the 0.5–0.8 middle
   * is scored and the inbox isn't limited to the alerted ≥0.8 items.
   */
  captureCandidates?: boolean;
  /** Inbox capture floor — candidates scored ≥ this are queued (default 0.5), independent of `minScore`. */
  candidateMinScore?: number;
  /**
   * Per-kind overrides of the inbox capture floor, keyed by URL shape: `commit` /
   * `release` (GitHub) / `doc` (.md) / `blog`. A kind left unset uses
   * max(candidateMinScore, built-in kind default — commit 0.7, release 0.8); an
   * explicit value wins outright (so it CAN lower a kind below its default). Lets
   * keyword-rich GitHub churn (version-stub releases, spec-repo commits) earn an
   * inbox slot only at a higher score, while docs/blog capture stays generous.
   */
  candidateMinScoreByKind?: Partial<Record<CandidateKind, number>>;
  /**
   * Auto-promote floor (Claude Learning Center, Phase B.3 / D-button). A captured
   * candidate scored ≥ this is summarized IN-PROCESS immediately — no manual click —
   * landing on the `anthropic-summaries` shelf. **Opt-in**: leave unset and nothing
   * auto-promotes (only the inbox fills). Start HIGH (~0.9–0.95) so only true
   * headliners auto-spend a Claude call; the rest wait for a manual pick. Requires
   * `captureCandidates` (the candidate row must exist first).
   */
  autoPromoteScore?: number;
  // --- Digest cadence (Phase 4) ---
  /**
   * Roll the window's candidates into ONE digest message (Daily/Weekly rows) instead of
   * per-item gated alerts (Highlights). Mutually exclusive with the per-item gate path.
   */
  digest?: boolean;
  /** Time-of-day gate (Europe/Oslo) read by the runner's isScheduledTimeDue — digest rows only. */
  hour?: number;
  minute?: number;
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
  /**
   * Truncated body slice fed to the gate alongside the title (Alert depth, §10).
   * Tier-1 carries it for free from the Atom `<content>`; Tier-2 docs are enriched
   * by a small `.md` fetch (see {@link enrichDocExcerpts}). Absent → title-only.
   */
  excerpt?: string;
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

  // Tier-1 cold start: a fresh watcher (empty last_notified_ids) hasn't seen its
  // Tier-1 entries — record them as a single silent baseline (ids persist without
  // notifying) so run 1 doesn't burst. Tier-2 is INDEPENDENT (its dedup is the
  // per-source snapshot, not last_notified_ids), so Tier-2 additions still flow
  // through the gate below even on a cold-start run.
  const coldTier1 = watcher.lastNotifiedIds.length === 0;
  const known = new Set(watcher.lastNotifiedIds);

  const baselineAlerts: WatcherAlert[] = [];
  if (coldTier1 && tier1Entries.length > 0) {
    log.info("Watcher \"{name}\": cold-start baseline of {n} Tier-1 entries (silent)", {
      name: watcher.name,
      n: tier1Entries.length,
    });
    baselineAlerts.push({
      id: `anthropic:baseline:${watcher.id}`,
      source: "anthropic",
      summary: `Baseline recorded (${tier1Entries.length} entries) — future updates will alert.`,
      urgency: "low",
      silent: true,
      trackingIds: tier1Entries.map((e) => e.id),
    });
  }

  // Steady state: only genuinely-new items become candidates. Filtering against
  // last_notified_ids here (not just in the runner) keeps the gate batch small —
  // it sees the delta since last run, not the whole window. Tier-1 entries are
  // skipped on cold start (baselined above, not gated); Tier-2 additions are not.
  // Keep the two tiers separate so digest mode can cap Tier-1 without ever truncating
  // Tier-2 (whose dedup is the snapshot, not last_notified_ids — see runDigest).
  const tier1Cands: Candidate[] = coldTier1
    ? []
    : tier1Entries.filter((e) => !known.has(e.id)).map(toFeedCandidate);
  const tier2Cands: Candidate[] = tier2.candidates.filter((c) => !known.has(c.id));
  const candidates: Candidate[] = [...tier1Cands, ...tier2Cands];

  if (candidates.length === 0) {
    await persistTier2();
    if (!coldTier1) log.info("Watcher \"{name}\": no new candidates this run", { name: watcher.name });
    return baselineAlerts;
  }

  // Digest mode (Phase 4): roll this window's candidates into ONE digest message
  // (Daily/Weekly rows) instead of per-item gated alerts. Reached only with ≥1
  // candidate, so cold-start digest rows already returned the silent baseline above.
  // Mirror the gate path's error discipline: runDigest throws on a model error OR
  // empty output, so persistTier2 runs ONLY after a clean digest/SKIP — a failed run
  // leaves the Tier-2 snapshots unadvanced and the whole window re-surfaces next run.
  if (config.digest) {
    try {
      const digestAlerts = await runDigest(tier1Cands, tier2Cands, config, watcher);
      await persistTier2();
      return [...baselineAlerts, ...digestAlerts];
    } catch (err) {
      log.error("Watcher \"{name}\": digest failed, suppressing {count} item(s) this run: {error}", {
        name: watcher.name,
        count: tier1Cands.length + tier2Cands.length,
        error: err instanceof Error ? err.message : String(err),
      });
      return baselineAlerts;
    }
  }

  // No gate → Phase-1 behavior: one alert per new candidate.
  if (!config.gate) {
    await persistTier2();
    return [...baselineAlerts, ...candidates.map(toPlainAlert)];
  }

  // Alert depth (§10): enrich the gate's view with a body slice so it scores off
  // content, not just titles. Tier-1 excerpts are already on the candidates (free,
  // from the Atom parse); this only fetches the Tier-2 doc `.md` bodies. Best-effort
  // — a miss leaves a candidate title-only. Gate path only (the digest stays
  // title-only), so it never runs on the Daily/Weekly rows.
  await enrichDocExcerpts(candidates);

  // Gate the candidates. On failure DON'T advance snapshots, so the additions
  // re-surface and retry next run (mirrors the x watcher's no-fallback); still
  // return the Tier-1 baseline so a cold-start run makes forward progress.
  let scored: GateScore[] | "SKIP_ALL";
  try {
    scored = await runGate(candidates, config, watcher);
  } catch (err) {
    log.error("Watcher \"{name}\": gate failed, suppressing {count} candidate(s) this run: {error}", {
      name: watcher.name,
      count: candidates.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return baselineAlerts;
  }

  await persistTier2();

  // quietMode SKIP → suppress all, but track ids so they aren't re-evaluated.
  if (scored === "SKIP_ALL") {
    log.info("Watcher \"{name}\": gate returned SKIP, silencing {count} candidate(s)", {
      name: watcher.name,
      count: candidates.length,
    });
    return [...baselineAlerts, silentAlert(candidates.map((c) => c.id))];
  }

  const minScore = config.minScore ?? DEFAULT_MIN_SCORE;
  // Index ALL model-returned scores by candidate number (not just the surfaced ones),
  // so the per-candidate calibration log below can also show below-threshold scores.
  const byN = new Map<number, GateScore>();
  for (const s of scored) {
    if (s.n < 1 || s.n > candidates.length) continue;
    // If the model emits more than one object for the same candidate number
    // (off-contract — the prompt asks for one each), keep the HIGHEST score so a
    // passing score is never masked by a later failing duplicate.
    const prev = byN.get(s.n);
    if (!prev || s.score > prev.score) byN.set(s.n, s);
  }

  const visible: WatcherAlert[] = [];
  const silentIds: string[] = [];
  candidates.forEach((c, i) => {
    const score = byN.get(i + 1);
    const surfaced = score != null && score.score >= minScore;
    // Per-candidate calibration log (Phase 4). Greppable prefix `gate-score`: mine the
    // log history (e.g. after a week of real output) to set the final minScore — the
    // distribution of surfaced vs below-min vs omitted scores. `omitted` = the model
    // dropped the candidate as routine churn (no score returned).
    log.info(
      "Watcher \"{name}\": gate-score n={n} score={score} min={min} surfaced={surfaced} src=\"{src}\" label=\"{label}\" url={url}",
      {
        name: watcher.name,
        n: i + 1,
        score: score ? score.score.toFixed(2) : "omitted",
        min: minScore,
        surfaced,
        src: c.sourceLabel,
        label: c.label,
        url: c.url,
      },
    );
    if (surfaced && score) visible.push(toGatedAlert(c, score));
    else silentIds.push(c.id);
  });

  log.info("Watcher \"{name}\": gate surfaced {visible}/{total} candidate(s)", {
    name: watcher.name,
    visible: visible.length,
    total: candidates.length,
  });

  // Capture the scored candidates into the inbox (Candidates → Summaries). Best-effort
  // and independent of the alert threshold: every candidate the gate scored ≥
  // candidateMinScore is queued, so the silent middle band lands in the inbox too.
  // Then hybrid curation: auto-summarize the clear headliners (≥ autoPromoteScore)
  // in-process, leaving the middle band for a manual pick on /summaries.
  if (config.captureCandidates) {
    await captureGatedCandidates(candidates, byN, config, watcher);
    await maybeAutoPromote(candidates, byN, config, watcher);
  }

  const alerts: WatcherAlert[] = [...baselineAlerts, ...visible];
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
    ...(e.excerpt ? { excerpt: e.excerpt } : {}),
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

      // `prior`: the stored baseline as an array, or null when there's no row yet
      // (or a corrupt non-array — re-baseline rather than treat it as empty).
      const snap = await getWatcherSnapshot(watcherId, src.key);
      const prior = Array.isArray(snap) ? (snap as string[]) : null;

      // Guard against a poisoned baseline. A 200 with an empty/garbage body (JS
      // challenge, truncated transfer) parses to 0 — or far fewer — URLs. If we
      // baselined/advanced to that, the next healthy fetch would diff against it
      // and flood the gate with the entire set as "new" (a ~1753-item burst for
      // llms.txt). Skip the source instead — don't diff, don't persist — so it
      // retries next run against the real set. A legitimate large removal also
      // gets skipped, which only delays recording it (removals never alert).
      if (freshUrls.length === 0 || (prior && prior.length > 0 && freshUrls.length < prior.length / 2)) {
        log.warn("Tier-2 {key}: suspicious fetch ({n} urls vs baseline {b}) — skipping, snapshot left as-is", {
          key: src.key,
          n: freshUrls.length,
          b: prior?.length ?? 0,
        });
        continue;
      }

      if (prior == null) {
        // Cold start for this source: baseline silently, no candidates.
        log.info("Tier-2 {key}: cold-start baseline of {n} url(s) (silent)", { key: src.key, n: freshUrls.length });
      } else {
        const seen = new Set(prior);
        for (const [url, label] of freshMap) {
          if (!seen.has(url)) {
            candidates.push({ id: `an:${url}`, sourceLabel: src.sourceLabel, label, url });
          }
        }
      }
      // Advance the snapshot: baseline on cold start, otherwise the new full set.
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
  // Escape the section in case it ever carries regex metacharacters from config.
  const esc = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`href="(?:https?://www\\.anthropic\\.com)?/${esc}/([^"#?]+)"`, "gi");
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

/**
 * Best-effort: enrich Tier-2 doc candidates with a body slice for the gate (Alert
 * depth, §10). The llms.txt candidate URLs are clean-markdown `.md` docs (per L7,
 * "`.md` doc URLs are clean markdown and fetchable directly"), so fetch the first
 * slice straight from the URL — no Huginn id-resolution, and no indexing-lag miss
 * for a brand-new doc that `anthropic-knowledge` hasn't crawled yet. Bounded to
 * {@link MAX_DOC_EXCERPT_FETCHES} with a short per-fetch timeout; any miss/error or
 * over-cap doc gates title-only. Blog candidates (HTML listings, no cheap clean
 * body) stay title-only by design. Mutates the candidates in place.
 */
async function enrichDocExcerpts(candidates: Candidate[]): Promise<void> {
  const docs = candidates.filter((c) => !c.excerpt && c.url.endsWith(".md"));
  if (docs.length === 0) return;
  const targets = docs.slice(0, MAX_DOC_EXCERPT_FETCHES);
  if (docs.length > targets.length) {
    log.warn("Doc-excerpt enrichment capped at {cap} (of {n}); the rest gate title-only", {
      cap: MAX_DOC_EXCERPT_FETCHES,
      n: docs.length,
    });
  }
  await Promise.all(
    targets.map(async (c) => {
      const controller = new AbortController();
      // Arm the timer through the body read too — clearing it before res.text()
      // would leave a slow-streaming body un-bounded and stall the awaited gate run.
      const timeout = setTimeout(() => controller.abort(), DOC_EXCERPT_TIMEOUT_MS);
      try {
        const res = await fetch(c.url, {
          headers: { "User-Agent": "muninn-anthropic-watcher", Accept: "text/markdown, text/plain, */*" },
          signal: controller.signal,
        });
        if (!res.ok) return;
        const excerpt = markdownExcerpt(await res.text());
        if (excerpt) c.excerpt = excerpt;
      } catch {
        // Best-effort: a fetch/parse/timeout error leaves the candidate title-only.
      } finally {
        clearTimeout(timeout);
      }
    }),
  );
}

/**
 * First usable plain-text slice from a clean-markdown doc: drop a leading YAML
 * frontmatter block, soften markdown punctuation, collapse whitespace, and
 * hard-truncate to {@link MAX_EXCERPT_CHARS}.
 */
function markdownExcerpt(md: string): string | undefined {
  const stripped = md
    .replace(/^﻿?\s*---\n[\s\S]*?\n---\s*/, "") // leading frontmatter, if any
    .replace(/[#*_`>]+/g, " "); // soften md markers (headings, emphasis, quotes)
  return cleanExcerpt(stripped);
}

// --- Haiku quality gate ---

/**
 * Numbered candidate list shared by the gate and digest prompts (keeps the two in
 * sync). With `withExcerpt` each candidate's truncated body slice is appended on its
 * own line — the GATE passes this so it scores off content, not just titles; the
 * digest omits it (default) because it rolls up to 200 items and would balloon.
 * Candidates with no excerpt render title-only either way.
 */
export function formatCandidateList(cands: Candidate[], opts?: { withExcerpt?: boolean }): string {
  return cands
    .map((c, i) => {
      const head = `${i + 1}. [${c.sourceLabel}] ${c.label}\n   ${c.url}`;
      return opts?.withExcerpt && c.excerpt ? `${head}\n   ${c.excerpt}` : head;
    })
    .join("\n");
}

/** One Anthropic model call with the shared watcher attribution. Throws on a model error. */
async function callAnthropicModel(
  prompt: string,
  model: string,
  timeoutMs: number,
  watcher: Watcher,
): Promise<string> {
  const { result } = await spawnHaiku(prompt, {
    source: "watcher-anthropic",
    entrypoint: `${watcher.botName ?? "jarvis"}-watcher`,
    botName: watcher.botName,
    model,
    timeoutMs,
  });
  return result;
}

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
  const criteria = config.prompt || DEFAULT_ANTHROPIC_GATE_PROMPT;
  const prompt = `${criteria}\n\nCandidates:\n\n${formatCandidateList(candidates, { withExcerpt: true })}`;

  const model = config.model || DEFAULT_MODEL;
  const timeoutMs = config.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  log.info("Watcher \"{name}\": scoring {count} candidate(s) with {model} (timeout {t}s)", {
    name: watcher.name,
    count: candidates.length,
    model,
    t: Math.round(timeoutMs / 1000),
  });

  const result = await callAnthropicModel(prompt, model, timeoutMs, watcher);

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

// --- Candidate capture (Claude Learning Center, Phase B) ---

/**
 * Shelf-capture classification of a candidate by URL shape (Candidates → Summaries).
 * Drives the per-kind capture floors: GitHub churn (commits, version-stub releases)
 * must clear a higher gate score to earn an inbox slot than a new doc or blog post,
 * whose full content is always summarizable.
 */
export type CandidateKind = "commit" | "release" | "doc" | "blog";

export function candidateKind(url: string): CandidateKind {
  if (/github\.com\/[^/]+\/[^/]+\/commit\//.test(url)) return "commit";
  if (/github\.com\/[^/]+\/[^/]+\/releases\/tag\//.test(url)) return "release";
  if (url.endsWith(".md")) return "doc";
  return "blog";
}

/** Commit titles that are pure repo plumbing — never shelf-worthy regardless of score.
 *  Covers git's default singular AND plural/tag forms ("Merge branches 'a' and 'b'",
 *  "Merge tag 'v1.2'"). */
const MERGE_COMMIT_RE = /^Merge (pull request|branch(es)?|remote-tracking branch(es)?|tag)\b/i;

/**
 * Deterministic pre-filter for inbox CAPTURE only (alerts are untouched): a
 * merge/rollup commit's content is a diff of other commits, so a summary of it is
 * noise no matter how well the gate scored its keywords. Kind-scoped — a doc or blog
 * post whose title happens to start with "Merge" is not filtered.
 */
export function isShelfWorthy(c: Pick<Candidate, "label" | "url">): boolean {
  return !(candidateKind(c.url) === "commit" && MERGE_COMMIT_RE.test(c.label));
}

/**
 * Built-in per-kind capture floors layered on `candidateMinScore` (raise-only via
 * max — a raised base is never undercut). Calibrated against the 2026-07 inbox:
 * spec-repo churn (doc tweaks, blog corrections) scored 0.55–0.68 while every
 * hand-summarized commit scored 0.7+ → commit floor 0.7; SDK version-stub releases
 * clustered at 0.75–0.8 → release floor 0.8, which also equals the seeded Highlights
 * alert `minScore`, so a release that interrupts on Telegram is always summarizable
 * from the inbox (alerted ⇒ captured). Docs/blog stay at the base floor. Merge
 * commits are handled by {@link isShelfWorthy}, not these floors.
 */
const DEFAULT_KIND_FLOORS: Partial<Record<CandidateKind, number>> = {
  commit: 0.7,
  release: 0.8,
};

/** Effective inbox capture floor for one candidate kind (see candidateMinScoreByKind). */
export function captureFloor(kind: CandidateKind, config: AnthropicConfig): number {
  const explicit = config.candidateMinScoreByKind?.[kind];
  if (explicit != null) return explicit;
  const base = config.candidateMinScore ?? DEFAULT_CANDIDATE_MIN_SCORE;
  const kindDefault = DEFAULT_KIND_FLOORS[kind];
  return kindDefault != null ? Math.max(base, kindDefault) : base;
}

/**
 * Persist gated candidates into the `summary_candidates` inbox (Candidates → Summaries).
 * Captures every candidate the gate scored at or above its kind's capture floor (see
 * {@link captureFloor}), INDEPENDENT of the alert `minScore` — so the relevant middle
 * band (≥0.5, <0.8) that stays silent on Telegram still lands in the inbox for manual
 * summarizing. Merge/rollup commits are filtered deterministically first (see
 * {@link isShelfWorthy}) — capture-only, they can still alert. Best-effort: a DB error
 * is logged, never breaks the alert path. Dedup rides the table's UNIQUE(source,url)
 * + the upstream `last_notified_ids` filter, so each item is captured once (re-runs
 * upsert and keep the max score).
 */
async function captureGatedCandidates(
  candidates: Candidate[],
  byN: Map<number, GateScore>,
  config: AnthropicConfig,
  watcher: Watcher,
): Promise<void> {
  let captured = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    if (!isShelfWorthy(c)) {
      // info, not debug: the adjacent gate-score line may say surfaced=true for the
      // same item, so a silent capture skip would look like a bug when mining logs.
      log.info("Watcher \"{name}\": capture skipped merge commit — {label}", {
        name: watcher.name,
        label: c.label,
      });
      continue;
    }
    const score = byN.get(i + 1);
    if (!score || score.score < captureFloor(candidateKind(c.url), config)) continue;
    try {
      await upsertCandidate({
        source: "anthropic",
        url: c.url,
        title: c.label,
        candidateSrc: c.sourceLabel,
        score: score.score,
        why: score.why,
        watcherId: watcher.id,
        botName: watcher.botName ?? null,
      });
      captured++;
    } catch (err) {
      log.error("Watcher \"{name}\": failed to capture candidate {url}: {error}", {
        name: watcher.name,
        url: c.url,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (captured > 0) {
    log.info("Watcher \"{name}\": captured {n} candidate(s) to the inbox", {
      name: watcher.name,
      n: captured,
    });
  }
}

/**
 * Auto-promote the clear headliners (Claude Learning Center, Phase B.3 / D-button).
 * For every gated candidate scored ≥ `config.autoPromoteScore`, summarize it
 * IN-PROCESS immediately — no manual click — so true must-see items land on the
 * `anthropic-summaries` shelf on their own; everything below waits in the inbox.
 *
 * Opt-in: with `autoPromoteScore` unset this is a no-op (the inbox just fills).
 * Deduped: only rows still in status `new` are kicked, so an item already
 * summarizing/summarized/dismissed from a prior run is never re-summarized (and a
 * captured candidate whose upsert was a no-op against a non-`new` row is skipped).
 * The summarize itself is fire-and-forget inside {@link autoPromoteCandidate}, so a
 * slow Claude call never blocks the watcher run. Best-effort: a per-candidate error
 * is logged and never breaks the alert path.
 */
async function maybeAutoPromote(
  candidates: Candidate[],
  byN: Map<number, GateScore>,
  config: AnthropicConfig,
  watcher: Watcher,
): Promise<void> {
  const threshold = config.autoPromoteScore;
  if (threshold == null) return;

  let promoted = 0;
  for (let i = 0; i < candidates.length; i++) {
    const score = byN.get(i + 1);
    if (!score || score.score < threshold) continue;
    const c = candidates[i]!;
    try {
      // Resolve the persisted row to read its status — the dedup gate. The row can
      // be missing when capture filtered the candidate (merge commit, or scored
      // below its kind's capture floor); such a candidate must never auto-promote.
      const row = await getCandidateBySourceUrl("anthropic", c.url);
      if (!row || row.status !== "new") continue;

      const jobId = await autoPromoteCandidate({ id: row.id, title: row.title, url: row.url });
      if (jobId) {
        promoted++;
        log.info(
          "Watcher \"{name}\": auto-promoted candidate (score {score}) → job {jobId} — {url}",
          { name: watcher.name, score: score.score.toFixed(2), jobId, url: c.url },
        );
      }
    } catch (err) {
      log.error("Watcher \"{name}\": auto-promote failed for {url}: {error}", {
        name: watcher.name,
        url: c.url,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (promoted > 0) {
    log.info("Watcher \"{name}\": auto-promoted {n} headliner(s) (score ≥ {threshold})", {
      name: watcher.name,
      n: promoted,
      threshold,
    });
  }
}

// --- Digest mode (Phase 4) ---

/**
 * Roll a window's candidates into ONE digest message (the Daily/Weekly rows). Caps the
 * Tier-1 (feed) portion at DIGEST_MAX_TIER1 but NEVER truncates Tier-2 additions: their
 * dedup is the per-source snapshot, which `persistTier2` advances to the full fresh set
 * unconditionally, so an un-surfaced Tier-2 addition would be lost forever — whereas a
 * truncated Tier-1 item re-surfaces next run via last_notified_ids (within lookbackDays).
 * `trackingIds` are the digested set's ids only (all Tier-2 + the capped Tier-1), so the
 * dropped Tier-1 tail isn't marked seen.
 *
 * THROWS on a model error or empty output (the caller then skips persistTier2, so the
 * whole window re-surfaces and retries the next *scheduled* run — the digest rows' widened
 * lookbackDays keeps a failed run's oldest Tier-1 inside the fetch cutoff until then).
 * Returns a single alert on success, or a silent alert on a quiet-mode SKIP; the caller
 * advances the Tier-2 snapshots only after a clean return (forward progress).
 */
async function runDigest(
  tier1Cands: Candidate[],
  tier2Cands: Candidate[],
  config: AnthropicConfig,
  watcher: Watcher,
): Promise<WatcherAlert[]> {
  const cappedTier1 = tier1Cands.slice(0, DIGEST_MAX_TIER1);
  const dropped = tier1Cands.length - cappedTier1.length;
  if (dropped > 0) {
    log.warn("Watcher \"{name}\": digest capped Tier-1 at {cap} (dropped {dropped}; they re-surface next run)", {
      name: watcher.name,
      cap: DIGEST_MAX_TIER1,
      dropped,
    });
  }
  // Tier-2 first so new docs/posts are never crowded out by the (capped) Tier-1 commits.
  const digestList: Candidate[] = [...tier2Cands, ...cappedTier1];
  const ids = digestList.map((c) => c.id);

  const criteria = config.prompt || DEFAULT_ANTHROPIC_DAILY_PROMPT;
  const prompt = `${criteria}\n\nItems:\n\n${formatCandidateList(digestList)}`;

  const model = config.model || DEFAULT_MODEL;
  const timeoutMs = config.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  log.info("Watcher \"{name}\": digesting {total} item(s) ({t2} tier-2 + {t1} tier-1) with {model} (timeout {t}s)", {
    name: watcher.name,
    total: digestList.length,
    t2: tier2Cands.length,
    t1: cappedTier1.length,
    model,
    t: Math.round(timeoutMs / 1000),
  });

  // Let a model error propagate — the caller catches it and skips persistTier2 (retry).
  const result = await callAnthropicModel(prompt, model, timeoutMs, watcher);

  // quietMode: an all-churn day suppresses the digest (the Daily prompt invites "SKIP").
  // ids are still tracked (silent) so the same items aren't re-considered next run.
  if (config.quietMode && isSkipResult(result)) {
    log.info("Watcher \"{name}\": digest returned SKIP, silencing {count} item(s)", {
      name: watcher.name,
      count: digestList.length,
    });
    return [silentAlert(ids)];
  }

  // An empty/blank model result (exit 0 but no content) would otherwise send a
  // header-only Telegram message AND advance the Tier-2 snapshots past these additions
  // (losing them forever). Treat it as a failure so the caller skips persist and retries
  // — mirrors runGate, which throws when extractJson finds no array.
  if (!result.trim()) throw new Error("digest model returned empty output");

  return [{
    id: `anthropic:digest:${Date.now()}`,
    source: "anthropic",
    summary: result,
    urgency: "low",
    trackingIds: ids,
  }];
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
    const excerpt = extractEntryExcerpt(block);
    entries.push({
      id: url,
      url,
      title,
      updated: Number.isNaN(updatedMs) ? 0 : updatedMs,
      feedTitle,
      ...(excerpt ? { excerpt } : {}),
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

// --- Body excerpt (Alert depth, §10) ---

/**
 * Pull a short plain-text body slice from an Atom entry's `<content>`/`<summary>`
 * for the quality gate. GitHub feeds carry the commit message / release notes there
 * as escaped HTML, so `extractTag` decodes it once to real markup; strip the tags,
 * collapse whitespace, and hard-truncate. Returns undefined when there's no usable
 * body so the gate falls back to title-only. `<content>` wins over `<summary>`.
 */
function extractEntryExcerpt(block: string): string | undefined {
  const raw = extractTag(block, "content") ?? extractTag(block, "summary");
  return raw ? cleanExcerpt(raw.replace(/<[^>]+>/g, " ")) : undefined;
}

/** Collapse whitespace + hard-truncate a body slice to {@link MAX_EXCERPT_CHARS}. */
function cleanExcerpt(text: string): string | undefined {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  return clean.length <= MAX_EXCERPT_CHARS ? clean : `${clean.slice(0, MAX_EXCERPT_CHARS).trimEnd()}…`;
}
