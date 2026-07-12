import type { Watcher, WatcherAlert } from "../types.ts";
import { spawnHaiku, DEFAULT_MODEL, type HaikuTelemetry } from "../scheduler/executor.ts";
import { parseGateScores, indexScoresByN, type GateScore } from "./gate-scores.ts";
import { upsertCandidate } from "../db/summary-candidates.ts";
import { normalizeHandle, getAuthorScore } from "../summaries/author-scores.ts";
import { loadInterestProfileForBot } from "../profile/generator.ts";
import { withInterestProfile } from "../profile/inject.ts";
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

/**
 * Quiet-mode prompt — used by the daytime "highlights" watcher. The model is told to
 * either surface 1–3 genuinely exceptional tweets or respond with the literal word
 * "SKIP" (case-insensitive) to suppress the alert entirely. Pair with config.quietMode: true.
 */
export const DEFAULT_X_HIGHLIGHTS_PROMPT = `You are a quality gate for daytime Twitter alerts. The user only wants to be interrupted for content that is genuinely exceptional — a breakthrough result, a must-read long-form note, a news event they'd want to know about immediately, or an insight they'd otherwise miss.

If NOTHING in the list above meets that bar, respond with exactly:

SKIP

Otherwise, produce a short alert with 1–3 items maximum:
- One bold line per item with linked @handle and a one-sentence reason it's worth the interruption
- No "Also Notable" section — if it isn't exceptional, leave it out
- No preamble, no heading — start directly with the first item

Err on the side of SKIP. The user will get a full digest later today anyway.`;

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
  /** How many days back to include (default: 2 — today + yesterday). Set to 7 for a weekly digest. */
  windowDays?: number;
  /** Filter out tweets already in lastNotifiedIds (default: true). Set false for daily/weekly digests that re-rank the full window. */
  dedupByTweetId?: boolean;
  /** If set, silently skip the digest when the top tweet's rank score is below this threshold. Used for daytime "quiet" alerts that only fire on exceptional content. */
  minScore?: number;
  /** If true, the LLM may return literal "SKIP" to silently suppress the alert. Combined with a prompt that tells the model to only surface truly exceptional content. */
  quietMode?: boolean;
  // --- Candidate capture (Claude Learning Center, Phase B — X → summaries inbox) ---
  /**
   * Persist high-value LONG-FORM tweets into the `summary_candidates` inbox
   * (Candidates → Summaries). Collection path only. Runs on the FULL fetched batch,
   * independent of `minScore`/`quietMode` silencing — so a run that alerts nothing can
   * still capture. Only long-form notes/articles are eligible (see the pre-filter); a
   * short plain tweet is its own summary and is never captured.
   */
  captureCandidates?: boolean;
  /** Inbox capture floor — long-form tweets scored ≥ this by the capture gate are queued (default 0.6). */
  candidateMinScore?: number;
}

// --- Collection path (queries huginn's indexed x-feed collection) ---

const DEFAULT_API_URL = process.env.KNOWLEDGE_API_URL ?? "http://localhost:8321";
const DEFAULT_MAX_DOCS = 80;
const DEFAULT_TOP_N = 30;
const DEFAULT_WINDOW_DAYS = 2;

const OSLO_DATE_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit" });

/**
 * Detect a quiet-mode SKIP response from the LLM. Accepts `SKIP` with any whitespace or
 * surrounding punctuation so the model doesn't have to be pixel-perfect.
 */
export function isSkipResult(text: string): boolean {
  const stripped = text.trim().replace(/^[`*_~"'.\s]+|[`*_~"'.\s]+$/g, "");
  return stripped.toUpperCase() === "SKIP";
}

/** Build the set of acceptable date prefixes (YYYY-MM-DD, Europe/Oslo) for a rolling N-day window. */
export function buildDateWindow(windowDays: number, now: Date = new Date()): Set<string> {
  const days = Math.max(1, Math.floor(windowDays));
  const set = new Set<string>();
  for (let i = 0; i < days; i++) {
    set.add(OSLO_DATE_FMT.format(new Date(now.getTime() - i * 86400000)));
  }
  return set;
}

interface CollectionDoc {
  id: string;
  url: string;
}

interface CompactedTweet {
  text: string;
  rankScore: number;
  /** "@handle" (or "unknown") pulled from the doc heading — for the candidate title/src. */
  handle: string;
  /** Length of the extracted tweet body BEFORE truncation — the long-form capture signal. */
  bodyLength: number;
  /** The doc carries a `**Type:** note` marker (a long-form X note/article). */
  isNote: boolean;
  /** First body line of the tweet — used for the candidate title. */
  firstLine: string;
  /** Body slice up to {@link GATE_EXCERPT_CHARS} for the capture gate (text caps at 500). */
  gateBody: string;
}

/**
 * Capture-gate body slice cap. The gate judges whether a FULL long-form post is worth
 * summarizing, so it needs more than the digest's 500-char compact line — but stays
 * bounded so a batch of eligible notes can't balloon the prompt.
 */
const GATE_EXCERPT_CHARS = 1200;

/**
 * One per-doc record for the capture path (Candidates → Summaries). Carries the
 * bits capture needs that the compact digest text discards — the huginn `x-feed`
 * doc id (so the summarizer can fetch full content), the body length + note marker
 * (the long-form pre-filter), and the handle + first line (the candidate title).
 * Additive on {@link FetchResult} so the legacy `fetchFromPython` path (no doc ids)
 * compiles untouched; only the collection path populates it.
 */
export interface TweetDoc {
  docId: string;
  url: string;
  handle: string;
  bodyLength: number;
  isNote: boolean;
  firstLine: string;
  /** The compact one-liner (same string sent to the digest LLM). */
  text: string;
  /** Longer body slice for the capture gate — see {@link GATE_EXCERPT_CHARS}. */
  gateExcerpt: string;
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
export function compactTweetText(rawText: string, url: string): CompactedTweet {
  // Strip the bracketed document ID line huginn prepends
  const text = rawText.replace(/^\[.*?\]\n+/, "");
  const lines = text.split("\n");

  // Extract handle from heading: "# @handle — Author"
  const headingIdx = lines.findIndex((l) => l.startsWith("# @"));
  const heading = headingIdx >= 0 ? lines[headingIdx]! : "";
  const handleMatch = heading.match(/@(\w+)/);
  const handle = handleMatch ? `@${handleMatch[1]}` : "unknown";

  // Extract tweet body (lines between heading and the FOOTER "---" separator, excluding
  // metadata). The footer separator is the LAST "---" line — a long-form article can
  // legitimately contain "---" horizontal rules of its own, and cutting at the first one
  // would undercount bodyLength and misclassify exactly the long-form case we capture.
  const startIdx = headingIdx >= 0 ? headingIdx + 1 : 0;
  const separatorIdx = lines.lastIndexOf("---");
  const bodyLines = lines.slice(startIdx, separatorIdx > startIdx ? separatorIdx : undefined)
    .filter((l) => l.trim() && !l.startsWith("- **"))
    .map((l) => l.trim());
  const bodyRaw = bodyLines.join(" ");
  const firstLine = bodyLines[0] ?? "";
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
  // bodyLength measures the extracted body PRE-truncation (x-feed docs carry ~350–450
  // chars of fixed scaffolding, so measuring the doc length would misclassify ordinary
  // tweets as long-form — see isLongFormTweet). gateBody carries a longer slice for the
  // capture gate, which judges long-form posts and would be blind on the 500-char text.
  const gateBody = bodyRaw.length > GATE_EXCERPT_CHARS
    ? bodyRaw.slice(0, bodyRaw.lastIndexOf(" ", GATE_EXCERPT_CHARS)) + "…"
    : bodyRaw;
  return { text: result, rankScore, handle, bodyLength: bodyRaw.length, isNote, firstLine, gateBody };
}

function extractTweetId(docId: string): string {
  const match = docId.match(/_(\d+)\.md$/);
  return match ? match[1]! : docId;
}

interface FetchResult {
  texts: string[];
  trackingIds: string[];
  /** Highest rankScore among fetched tweets, used by checkX's minScore gate. Undefined when nothing was fetched. */
  topScore?: number;
  /**
   * Per-doc records for the FULL fetched batch (collection path only) — the input to
   * the candidate-capture pre-filter + gate. NOT the `topN`-sliced digest subset, so a
   * long-form tweet below the alert cutoff can still be captured. Undefined on the
   * legacy `fetchFromPython` path (no doc ids).
   */
  docs?: TweetDoc[];
}

export async function fetchFromCollection(
  config: XWatcherConfig,
  known: Set<string>,
  botName?: string,
): Promise<FetchResult | null> {
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

  // Oslo timezone — must match huginn's indexer date convention, or we'd get off-by-one near midnight
  const windowDays = config.windowDays ?? DEFAULT_WINDOW_DAYS;
  const dayStrings = buildDateWindow(windowDays);
  const recentDocs = docs.filter((d) => dayStrings.has(d.id.slice(0, 10)));

  // Daily/weekly digests disable this to re-rank the full window on every run
  const dedupByTweetId = config.dedupByTweetId ?? true;
  const newDocs = recentDocs
    .filter((d) => !dedupByTweetId || !known.has(`tw:${extractTweetId(d.id)}`))
    .sort((a, b) => a.id.localeCompare(b.id)); // oldest first for deterministic cap

  if (newDocs.length === 0) {
    log.info("No new recent tweets ({recent} recent, all seen)", { botName, recent: recentDocs.length });
    return { texts: [], trackingIds: [] };
  }

  // Fetch full content for new documents (cap to avoid huge prompts)
  const maxDocs = config.maxDocs ?? DEFAULT_MAX_DOCS;
  const toFetch = newDocs.slice(0, maxDocs);

  // Fetch in batches of 20 to avoid overwhelming huginn's Python server
  const compacted: (CompactedTweet & { docId: string; url: string })[] = [];
  for (let i = 0; i < toFetch.length; i += 20) {
    const batch = toFetch.slice(i, i + 20);
    const results = await Promise.all(
      batch.map(async (doc) => {
        try {
          const resp = await fetch(`${apiUrl}/api/document/${encodeURIComponent(collection)}/${encodeURIComponent(doc.id)}`);
          if (!resp.ok) return null;
          const data = await resp.json() as { text: string; metadata?: { url?: string } };
          const resolvedUrl = data.metadata?.url || doc.url;
          const compact = compactTweetText(data.text, resolvedUrl);
          return { docId: doc.id, url: resolvedUrl, ...compact };
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

  compacted.sort((a, b) => b.rankScore - a.rankScore);
  // Track ALL fetched tweets so below-cutoff ones aren't re-fetched next tick
  const trackingIds = compacted.map((r) => `tw:${extractTweetId(r.docId)}`);

  // Per-doc records for the capture path — the FULL batch (before the topN slice), so a
  // long-form tweet outside the digest still reaches the inbox pre-filter + gate. Only
  // built when the row actually captures; the digest rows never consume it.
  const tweetDocs: TweetDoc[] | undefined = config.captureCandidates
    ? compacted.map((r) => ({
        docId: r.docId,
        url: r.url,
        handle: r.handle,
        bodyLength: r.bodyLength,
        isNote: r.isNote,
        firstLine: r.firstLine,
        text: r.text,
        gateExcerpt: r.gateBody,
      }))
    : undefined;

  const topN = config.topN ?? DEFAULT_TOP_N;
  const ranked = compacted.slice(0, topN);
  const texts = ranked.map((r) => r.text);

  // Always emit the top score alongside counts so silent runs (minScore / quietMode)
  // still leave a breadcrumb the user can use to calibrate the gate from log history.
  log.info("Collection: {total} docs, {recent} recent, {newCount} new, {fetched} fetched, {ranked} after ranking, topScore={topScore}", {
    botName,
    total: docs.length,
    recent: recentDocs.length,
    newCount: newDocs.length,
    fetched: compacted.length,
    ranked: ranked.length,
    topScore: compacted[0]?.rankScore.toFixed(3) ?? "n/a",
  });

  return { texts, trackingIds, topScore: compacted[0]?.rankScore, docs: tweetDocs };
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
): Promise<FetchResult | null> {
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

// --- Candidate capture (Claude Learning Center, Phase B — X → summaries inbox) ---

/** Inbox capture floor when `config.candidateMinScore` is unset. */
const DEFAULT_CANDIDATE_MIN_SCORE = 0.6;
/**
 * A tweet body must reach this many chars (measured PRE-truncation on the extracted
 * body, not the raw doc) to count as long-form, unless the doc already carries the
 * `**Type:** note` marker. Below it the tweet is its own summary — never captured.
 */
const LONGFORM_MIN_CHARS = 800;
/** Capture-gate model-call timeout — Haiku over one small (dedupByTweetId) batch. */
const CAPTURE_GATE_TIMEOUT_MS = 90_000;

/**
 * Capture-gate prompt (mirrors the anthropic watcher's `{n,score,why}` contract). Scores
 * whether a SUMMARY of a long-form X post is worth a spot on a personal learning shelf —
 * i.e. whether reading the full note would teach a senior AI engineer something. Only
 * long-form notes/articles reach it (short tweets are pre-filtered out).
 */
export const DEFAULT_X_CAPTURE_PROMPT = `You are curating a personal learning shelf for a senior AI engineer who builds agents, tools, and retrieval systems. Below is a numbered list of LONG-FORM X posts (notes/articles). For EACH one, decide whether a written summary of the FULL post is worth saving to read later.

Weight HIGHEST: substantive technical insight, original analysis, research findings, agent/LLM/retrieval engineering lessons, thoughtful essays.
Weight LOW (omit): hot takes, self-promotion, threads that are mostly links, engagement bait, news the engineer would already know, anything where the tweet already says everything.

For EACH post worth saving, output one object:
  {"n": <the post number>, "score": <0.0-1.0>, "why": "<one short line on what reading it would teach>"}
Use ~1.0 for must-read, ~0.7 for clearly worthwhile, ~0.6 for borderline. OMIT posts that aren't worth a summary — do not output them at all.

Return ONLY a JSON array of these objects, no prose and no markdown fences. If nothing is worth saving, return [].`;

/**
 * Long-form pre-filter (mirror of the anthropic watcher's `isShelfWorthy`): capture
 * eligibility for the inbox. A long-form note/article — either the explicit `**Type:**
 * note` marker or an extracted body ≥ {@link LONGFORM_MIN_CHARS} — is worth summarizing;
 * a short plain tweet is its own summary and is deliberately excluded. Link-tweets are
 * NOT captured either: the summarizer would only see the tweet's own (short) text, not
 * the linked article, so they'd yield short-tweet summaries.
 */
export function isLongFormTweet(doc: Pick<TweetDoc, "bodyLength" | "isNote">): boolean {
  return doc.isNote || doc.bodyLength >= LONGFORM_MIN_CHARS;
}

/** Truncate a candidate title at a word boundary near `max` chars. */
function truncateTitle(s: string, max = 140): string {
  const clean = s.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.lastIndexOf(" ", max);
  return `${clean.slice(0, cut > 0 ? cut : max)}…`;
}

/**
 * Score the long-form subset with one Haiku call. Returns the parsed `{n,score,why}`
 * array (model omits the not-worth-saving). Throws on a model error or unparseable
 * output so the caller can log + fall back to the alert path.
 */
async function runCaptureGate(
  docs: TweetDoc[],
  botName: string | undefined,
  interestProfile: string | null,
  telemetry?: HaikuTelemetry,
): Promise<GateScore[]> {
  // Feed the gate the longer gateExcerpt, not the 500-char compact digest line — it is
  // judging whether the FULL long-form post is worth summarizing, and every eligible
  // post is by definition longer than the compact line shows.
  const list = docs
    .map((d, i) => `${i + 1}. ${d.isNote ? "[ARTICLE/NOTE] " : ""}${d.handle}: ${d.gateExcerpt}\n   URL: ${d.url}`)
    .join("\n\n");
  const criteria = withInterestProfile(DEFAULT_X_CAPTURE_PROMPT, interestProfile);
  const prompt = `${criteria}\n\nPosts:\n\n${list}`;

  const { result } = await spawnHaiku(prompt, {
    source: "watcher-x-capture",
    entrypoint: `${botName ?? "jarvis"}-watcher`,
    botName,
    model: DEFAULT_MODEL,
    timeoutMs: CAPTURE_GATE_TIMEOUT_MS,
    ...telemetry,
  });

  return parseGateScores(result);
}

/**
 * Persist high-value long-form tweets into the `summary_candidates` inbox. Runs on the
 * FULL fetched batch, INDEPENDENT of the alert `minScore`/`quietMode` silencing — a run
 * that alerts nothing can still capture. Best-effort throughout: a capture-gate error is
 * logged and the run proceeds with its normal alert path (the batch's shelf-worthy
 * tweets are lost to the inbox this run — we deliberately do NOT hold tweet IDs back
 * from tracking, so alert dedup never re-surfaces already-alerted tweets). Dedup rides
 * the table's `UNIQUE(source,url)` + the upstream `lastNotifiedIds` filter.
 */
async function captureXCandidates(
  docs: TweetDoc[],
  config: XWatcherConfig,
  watcher: Watcher,
  botName?: string,
  interestProfile: string | null = null,
  telemetry?: HaikuTelemetry,
): Promise<void> {
  const eligible = docs.filter(isLongFormTweet);
  if (eligible.length === 0) {
    log.info("Capture: no long-form tweets in the batch of {n}", { botName, n: docs.length });
    return;
  }

  let scored: GateScore[];
  try {
    scored = await runCaptureGate(eligible, botName, interestProfile, telemetry);
  } catch (err) {
    log.error("Capture gate failed, proceeding with alert path ({n} long-form tweet(s) lost to inbox): {error}", {
      botName,
      n: eligible.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const minScore = config.candidateMinScore ?? DEFAULT_CANDIDATE_MIN_SCORE;
  const byN = indexScoresByN(scored, eligible.length);

  let captured = 0;
  for (let i = 0; i < eligible.length; i++) {
    const score = byN.get(i + 1);
    if (!score || score.score < minScore) continue;
    const doc = eligible[i]!;
    const firstLine = doc.firstLine.trim() || doc.text;
    // Author transparency: the normalized handle keys huginn's ranking; the score is a
    // capture-time snapshot the /summaries page tiers against current percentile cuts.
    // Both degrade to null (unknown handle / scores file unavailable) — best-effort.
    const author = normalizeHandle(doc.handle);
    const authorScore = await getAuthorScore(author);
    try {
      await upsertCandidate({
        source: "x",
        url: doc.url,
        title: truncateTitle(`${doc.handle}: ${firstLine}`),
        candidateSrc: `X (${doc.handle})`,
        score: score.score,
        why: score.why,
        kind: "x-post",
        author,
        authorScore,
        sourceDocId: doc.docId,
        watcherId: watcher.id,
        botName: botName ?? null,
      });
      captured++;
    } catch (err) {
      log.error("Failed to capture X candidate {url}: {error}", {
        botName,
        url: doc.url,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (captured > 0) {
    log.info("Capture: queued {n} long-form X candidate(s) to the inbox", { botName, n: captured });
  }
}

// --- Main entry point ---

function silentAlert(trackingIds: string[]): WatcherAlert {
  return {
    id: `x-silent-${Date.now()}`,
    source: "x",
    summary: "",
    urgency: "low",
    trackingIds,
    silent: true,
  };
}

export async function checkX(watcher: Watcher, _cwd?: string, botName?: string, telemetry?: HaikuTelemetry): Promise<WatcherAlert[]> {
  const config = watcher.config as XWatcherConfig;
  const known = new Set(watcher.lastNotifiedIds);

  const data = config.collection
    ? await fetchFromCollection(config, known, botName)
    : await fetchFromPython(config, known, botName);

  if (!data) return []; // fetch error

  // Load the bot user's interest profile ONCE per run (not per candidate). Null
  // when the bot has no default user / no profile / on any error, in which case
  // the capture-gate and digest prompts are byte-identical to today (the profile
  // only ever augments the hardcoded baseline criteria — anti-filter-bubble).
  const interestProfile = await loadInterestProfileForBot(botName ?? watcher.botName);

  // Candidate capture (Candidates → Summaries) runs on the FULL fetched batch,
  // INDEPENDENT of the silencing paths below (the minScore early return + the quietMode
  // SKIP both permanently track tweet IDs), so a run that alerts nothing can still feed
  // the inbox. Started here and awaited in the finally below, so it runs CONCURRENTLY
  // with the digest model call — serialized, the capture gate's Haiku call plus a slow
  // Sonnet digest could exceed the runner's per-watcher timeout net (timeoutMs + 30s)
  // and get the digest killed. Collection path only; best-effort — captureXCandidates
  // swallows its own errors and this catch is the last-resort boundary, so the promise
  // never rejects and the alert path is never broken.
  const capturePromise: Promise<void> =
    config.captureCandidates && data.docs && data.docs.length > 0
      ? captureXCandidates(data.docs, config, watcher, botName, interestProfile, telemetry).catch((err) => {
          log.error("Candidate capture failed (alert path unaffected): {error}", {
            botName,
            error: err instanceof Error ? err.message : String(err),
          });
        })
      : Promise.resolve();

  try {
    return await runAlertPath(data, config, watcher, botName, interestProfile, telemetry);
  } finally {
    // Every checkX exit waits for capture to settle so the runner's timeout net and the
    // scheduler tick never leave an orphaned in-flight Haiku call behind.
    await capturePromise;
  }
}

/** The original checkX alert flow (minScore gate → digest LLM → SKIP/alert). */
async function runAlertPath(
  data: NonNullable<Awaited<ReturnType<typeof fetchFromCollection>>>,
  config: XWatcherConfig,
  watcher: Watcher,
  botName?: string,
  interestProfile: string | null = null,
  telemetry?: HaikuTelemetry,
): Promise<WatcherAlert[]> {
  // Score-based quality gate: if the top tweet doesn't clear the bar, track IDs silently
  // so the same tweets aren't re-evaluated, and skip the LLM call entirely.
  if (config.minScore != null && data.topScore != null && data.topScore < config.minScore) {
    log.info("Below minScore ({top} < {min}), silencing {count} tweets", {
      botName, top: data.topScore.toFixed(3), min: config.minScore, count: data.trackingIds.length,
    });
    return [silentAlert(data.trackingIds)];
  }

  if (data.texts.length === 0) {
    log.info("No new tweets to digest", { botName });
    return [];
  }

  const { texts, trackingIds } = data;
  const separator = config.collection ? "\n\n---\n\n" : "\n---\n";
  const userPrompt = withInterestProfile(config.prompt || DEFAULT_X_PROMPT, interestProfile);

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
      botName, model, timeoutMs, ...telemetry,
    });
    const durationMs = Date.now() - start;
    log.info("Digest ready in {duration}s ({model}, {count} tweets)", {
      botName, duration: (durationMs / 1000).toFixed(1), model, count: texts.length,
    });

    if (config.quietMode && isSkipResult(result)) {
      log.info("Quiet mode: LLM returned SKIP, silencing {count} tweets", { botName, count: trackingIds.length });
      return [silentAlert(trackingIds)];
    }

    return [{
      id: `x-digest-${Date.now()}`,
      source: "x",
      summary: result,
      urgency: "low",
      trackingIds,
    }];
  } catch (err) {
    log.error("Summarization failed, skipping digest ({count} tweets lost): {error}", {
      botName, count: texts.length, model, error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
