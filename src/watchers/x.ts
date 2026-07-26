import type { Watcher, WatcherAlert } from "../types.ts";
import { spawnHaiku, DEFAULT_MODEL, type HaikuTelemetry } from "../scheduler/executor.ts";
import { parseGateScores, indexScoresByN, type GateScore } from "./gate-scores.ts";
import { upsertCandidate, upsertDestinationCandidate } from "../db/summary-candidates.ts";
import { normalizeHandle, getAuthorScore, getAuthorTierThresholds, type AuthorTierThresholds } from "../summaries/author-scores.ts";
import { extractDocLinks } from "../summaries/doc-links.ts";
import { destinationGroupKey } from "../summaries/destination-url.ts";
import { applyAmplification, resolveAmplificationConfig, type AmplificationConfig } from "./x-amplification.ts";
import { WATCHER_TIMEOUT_MARGIN_MS, TICK_TIMEOUT_MS } from "./timeout.ts";
import { loadInterestProfile } from "../profile/generator.ts";
import { withInterestProfile } from "../profile/inject.ts";
import { getLog } from "../logging.ts";
import path from "node:path";

const log = getLog("watchers", "x");

export const DEFAULT_X_PROMPT = `This digest covers AI, LLMs and agents, developer tools, software engineering, open source, cloud/infrastructure, and tech industry news.

Create a digest with two sections:

**Top Picks** (3-5 items) — the most interesting, impactful, or high-engagement content:
- Give each a brief description with context on why it matters
- Link @handles to the original tweet URL (markdown link)
- Prioritize: articles/long-form notes, original insights, threads

**Also Notable** (up to 10 items) — everything else worth mentioning:
- One-line bullets only, with linked @handle
- Skip: ads, spam, generic motivational, low-effort retweets, engagement bait, promotional
- Skip: content outside those topics — sport, football, celebrity, politics, viral memes, engagement-bait — regardless of how high its engagement is

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

"Exceptional" is scoped to these topics: AI, LLMs and agents, developer tools, software engineering, open source, cloud/infrastructure, and tech industry news. Exclude content outside those topics — sport, football, celebrity, politics, viral memes, engagement-bait — regardless of how high its engagement is.

If NOTHING in the list above meets that bar, respond with exactly:

SKIP

Otherwise, produce a short alert with 1–3 items maximum:
- One bold line per item with linked @handle and a one-sentence reason it's worth the interruption
- No "Also Notable" section — if it isn't exceptional, leave it out
- No preamble, no heading — start directly with the first item

Err on the side of SKIP. The user will get a full digest later today anyway.`;

interface XWatcherConfig extends AmplificationConfig {
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
  /**
   * Stricter capture floor applied to NON-top-5%-author tweets (default 0.75). The
   * author PageRank score is the strongest capture prior, so a note from a top-5%
   * tracked author keeps the base `candidateMinScore`, while everyone else (incl.
   * unknown authors / when the scores file is unavailable) must clear
   * `max(candidateMinScore, candidateMinScoreNonTop)`. When the scores file is
   * unavailable EVERY author is treated as non-top, so the stricter floor applies
   * globally — a safe direction (fewer captures), never a silent widening.
   */
  candidateMinScoreNonTop?: number;
  /**
   * Per-kind capture-floor overrides (name + semantics mirror the anthropic vertical's
   * `candidateMinScoreByKind`). Two X kinds:
   *   - `"x-post"` — overrides the long-form base floor (else `candidateMinScore`, 0.6);
   *     the non-top-author raise (`candidateMinScoreNonTop`) still applies on top.
   *   - `"x-link"` — the pointer-tweet floor (else 0.7). `candidateMinScoreNonTop` NEVER
   *     applies here — link-tweets are already top-author-only by eligibility.
   */
  candidateMinScoreByKind?: { "x-post"?: number; "x-link"?: number };
  // --- X-Article amplification (digest leg) ---
  // `amplificationMinAuthors` / `amplificationMaxPromotions` are inherited from
  // {@link AmplificationConfig}; see `x-amplification.ts` for the mechanism + its bound.
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
  /** huginn's `include_scores` listing enrichment. Absent on pre-`include_scores` huginn. */
  combined_score?: number | string | null;
}

/**
 * Strict DECIMAL numeric literal — optional sign, digits with an optional
 * fraction (or a bare `.5`), optional exponent. Deliberately narrower than
 * `Number()`: it rejects hex (`"0x10"`), `Infinity`, and whitespace-only or
 * empty strings, mirroring huginn's server-side `float(raw)` + `isfinite`
 * guard set rather than JS's much looser string→number coercion.
 */
const DECIMAL_LITERAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Read a listing doc's `combined_score` as a usable number, or null.
 *
 * The parse is LOAD-BEARING even though huginn now coerces server-side: a
 * lexicographic sort over `"0.9"` vs `"0.1234"` fails SILENTLY (it just ranks
 * wrong), so the belt-and-braces read stays.
 *
 * Accepted: a finite `number`, or a string that trims to a decimal literal
 * (huginn's `read_frontmatter` serves frontmatter numerics as strings).
 * Rejected — every one of these would otherwise become a finite number under a
 * bare `Number()` and mis-rank the doc:
 *  - `null` / `undefined` / `""` / `"   "` → `Number()` gives `0`, sinking a
 *    scoreless doc instead of letting it hold its place (see `orderDocsForCap`);
 *  - `false` → `0`, `true` → `1` (a boolean would top the whole listing);
 *  - `[]` → `0`, and hex/`Infinity` strings, which huginn's own guard rejects.
 */
function listingScore(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!DECIMAL_LITERAL.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** How much of a listing actually carries a usable `combined_score`. */
export interface ListingCoverage {
  scored: number;
  total: number;
}

export function listingCoverage(docs: CollectionDoc[]): ListingCoverage {
  return {
    scored: docs.filter((d) => listingScore(d.combined_score) !== null).length,
    total: docs.length,
  };
}

/**
 * Coverage below which the score-ordered cap is mostly a no-op — under half the
 * window scored, the pinned (unscored) docs still occupy most cap slots, so the
 * cut is effectively still alphabetical.
 */
export const LOW_COVERAGE_FRACTION = 0.5;

/**
 * The one-line degrade complaint for a listing's score coverage, or null when
 * coverage is healthy (or the listing is empty).
 *
 * Two distinct failures, deliberately worded differently: ZERO scored docs means
 * the enrichment isn't there at all (old huginn ignoring `include_scores`), while
 * a nonzero minority means the enrichment works but the scorer is behind.
 */
export function coverageWarning({ scored, total }: ListingCoverage): string | null {
  if (total === 0) return null;
  if (scored === 0) {
    return `No listing scores on any of ${total} docs — capping alphabetically (huginn without include_scores?)`;
  }
  if (scored / total < LOW_COVERAGE_FRACTION) {
    const pct = ((scored / total) * 100).toFixed(1);
    return `Only ${scored}/${total} docs (${pct}%) carry a listing score — the maxDocs cap is still mostly alphabetical for the unscored majority`;
  }
  return null;
}

/**
 * Order a collection listing so the `maxDocs` cap keeps the HIGHEST-scoring docs.
 *
 * The cap used to slice an id-sorted list, and ids are `YYYY-MM-DD_<handle>_<id>.md`
 * — so within a day the cap was alphabetical by handle, and a 389-doc day was cut at
 * the B's. Ranking happened only AFTER the cap, on the survivors.
 *
 * Exact semantics — **positional hold** (per-doc degrade, not all-or-nothing):
 *  1. The alphabetical (`localeCompare` on id) order is the baseline — today's order.
 *  2. A doc with no finite `combined_score` is PINNED to the index it holds in that
 *     baseline. It neither rises nor sinks.
 *  3. Every scored doc is sorted `combined_score` DESC (tie-break `localeCompare` on
 *     id, so the cap stays deterministic) and poured back into the unpinned slots in
 *     that order.
 *
 * Why pin rather than sink: **kept-set identity with the old behavior**. An unscored
 * doc keeps exactly the cap odds it had before this change — if it was inside the old
 * alphabetical cap it is still inside, if it was outside it is still outside. No more,
 * no less. (Note the old `// oldest first for deterministic cap` comment was CORRECT:
 * `localeCompare` on `YYYY-MM-DD_…` ids is oldest-first, so the newest docs already sat
 * at the tail — sinking unscored docs would NOT have "inverted recency", it would simply
 * have moved them, changing which docs the cap keeps for reasons unrelated to their
 * quality. Pinning is the change that touches only the scored docs' ordering.)
 *
 * When NO doc has a finite score (an older huginn with no `include_scores` support)
 * every doc is pinned, so this returns the alphabetical order unchanged.
 */
export function orderDocsForCap(docs: CollectionDoc[]): CollectionDoc[] {
  const alphabetical = [...docs].sort((a, b) => a.id.localeCompare(b.id));
  const scored = alphabetical.filter((d) => listingScore(d.combined_score) !== null);
  if (scored.length === 0) return alphabetical;

  scored.sort((a, b) =>
    (listingScore(b.combined_score)! - listingScore(a.combined_score)!) || a.id.localeCompare(b.id));

  let next = 0;
  return alphabetical.map((d) => (listingScore(d.combined_score) === null ? d : scored[next++]!));
}

/**
 * The two long-form species an x-feed doc's `**Type:**` footer can carry:
 *   - `note` — an X long-form Note. Its full text IS the doc body.
 *   - `article` — an X Article. The doc body is only the article TITLE plus a short
 *     preview (~190 chars), so its body is SHORT (≈280–460 chars measured) and the
 *     {@link LONGFORM_MIN_CHARS} fallback can never rescue it — the marker is the
 *     only signal that it is long-form. The full article lives behind X's auth wall
 *     at the `- **Article:**` footer URL.
 * Anything else (`tweet`) is a plain post and maps to `null`.
 */
export type XDocType = "note" | "article";

interface CompactedTweet {
  text: string;
  rankScore: number;
  /** "@handle" (or "unknown") pulled from the doc heading — for the candidate title/src. */
  handle: string;
  /** Length of the extracted tweet body BEFORE truncation — the long-form capture signal. */
  bodyLength: number;
  /**
   * The doc's `**Type:**` marker when it is one of the two long-form species
   * (`note` / `article`), else null (a plain `tweet`). See {@link parseDocType}.
   */
  docType: XDocType | null;
  /** First body line of the tweet — used for the candidate title. */
  firstLine: string;
  /**
   * The X Article permalink from the doc's `- **Article:**` footer line, when present.
   * huginn writes that footer on ANY doc whose tweet or quote target carries an article
   * (amplifier notes included) — only `**Type:** article` docs use it as the candidate
   * url downstream. See {@link extractArticleUrl}.
   */
  articleUrl: string | null;
  /** Body slice up to {@link GATE_EXCERPT_CHARS} for the capture gate (text caps at 500). */
  gateBody: string;
  /**
   * External destination URLs parsed from the doc's plural `**Links:**` footer line
   * (self/t.co hosts already filtered — see {@link extractDocLinks}). Empty for a tweet
   * that links nowhere. The link-tweet capture eligibility ({@link isLinkTweet}) reads this.
   */
  links: string[];
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
  /** The doc's long-form `**Type:**` marker (`note`/`article`), else null. */
  docType: XDocType | null;
  firstLine: string;
  /**
   * The `- **Article:**` footer permalink when the doc carries one, else null. Present
   * on amplifier docs too (a note quoting someone else's article), so the capture path
   * only adopts it as the candidate `url` — so `/summaries` links to the ARTICLE rather
   * than the announcing tweet — when `docType === "article"`. See {@link extractArticleUrl}.
   */
  articleUrl: string | null;
  /** The compact one-liner (same string sent to the digest LLM). */
  text: string;
  /** Longer body slice for the capture gate — see {@link GATE_EXCERPT_CHARS}. */
  gateExcerpt: string;
  /**
   * External destination URLs from the doc footer (see {@link CompactedTweet.links}).
   * Drives link-tweet capture eligibility ({@link isLinkTweet}) + the x-link gate line.
   */
  links: string[];
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

  // Extract type — `note` AND `article` are both long-form species (see XDocType).
  const typeLine = lines.find((l) => l.startsWith("- **Type:**")) ?? "";
  const docType = parseDocType(typeLine);

  let result = `${handle}: ${body}`;
  if (signals.length > 0) result += ` (${signals.join(", ")})`;
  // Both species SHARE the existing `[ARTICLE/NOTE]` prefix — it already names both,
  // and the digest/gate prompts read it as one "this is long-form" hint, so a separate
  // `[ARTICLE]` token would only add a second thing for the models to learn.
  if (docType) result = `[ARTICLE/NOTE] ${result}`;
  result += `\n  URL: ${url}`;
  // bodyLength measures the extracted body PRE-truncation (x-feed docs carry ~350–450
  // chars of fixed scaffolding, so measuring the doc length would misclassify ordinary
  // tweets as long-form — see isLongFormTweet). gateBody carries a longer slice for the
  // capture gate, which judges long-form posts and would be blind on the 500-char text.
  const gateBody = bodyRaw.length > GATE_EXCERPT_CHARS
    ? bodyRaw.slice(0, bodyRaw.lastIndexOf(" ", GATE_EXCERPT_CHARS)) + "…"
    : bodyRaw;
  // Parse the footer's external destination links from the RAW doc (the compact `text`
  // and `gateBody` slices don't carry the `**Links:**` footer line). Drives link-tweet
  // capture eligibility downstream.
  const links = extractDocLinks(rawText);
  // The article permalink is a DEDICATED footer field, deliberately kept out of `links`
  // (which is fetched downstream) — see extractArticleUrl.
  const articleUrl = extractArticleUrl(rawText);
  return { text: result, rankScore, handle, bodyLength: bodyRaw.length, docType, firstLine, articleUrl, gateBody, links };
}

/**
 * Read the long-form species off a doc's `- **Type:** <value>` footer line.
 *
 * The line must be ANCHORED (`- **Type:**` at line start) and its value matched
 * EXACTLY — tweet bodies are author-controlled, so a substring scan would let a
 * post whose text merely mentions "article" claim long-form eligibility, and
 * `notearticle` would match too. `note` is checked first because upstream
 * deliberately keeps a note that links an article typed as `note`, so it never
 * loses its long-form eligibility either way.
 *
 * Case-sensitive on purpose: huginn's `x_fetcher.py` writes the value lowercase.
 * That is an external contract — if huginn ever changes the casing, this returns
 * null (fewer captures, the safe degrade) rather than silently widening.
 */
export function parseDocType(typeLine: string): XDocType | null {
  const match = typeLine.match(/^- \*\*Type:\*\*\s*(.*)$/);
  if (!match) return null;
  const value = match[1]!.trim();
  if (value === "note") return "note";
  if (value === "article") return "article";
  return null;
}

/**
 * Extract the X Article permalink from a doc's `- **Article:** <url>` FOOTER line
 * (huginn's `x_fetcher.py` writes it after the `---` separator, on any doc whose
 * tweet OR quote target carries an article — NOT `**Type:** article` docs only).
 *
 * Scanning is confined to the FOOTER region (lines after the last `---`) and the
 * line must start with `- **Article:**`: tweet body text is author-controlled, so
 * an unanchored scan would let a body line reading `- **Article:** https://spam`
 * win over the real footer field.
 *
 * This is deliberately a DEDICATED field rather than a widening of
 * {@link extractDocLinks}: that parser feeds `pickEnrichmentLink`, which
 * direct-FETCHES `links[0]` when summarizing — and an `x.com/…/article/…` URL
 * behind X's auth wall would only ever return the login wall into the prompt.
 * Here the URL is metadata (the candidate's `/summaries` link target), never fetched.
 */
export function extractArticleUrl(docText: string): string | null {
  const lines = docText.split("\n");
  const separatorIdx = lines.lastIndexOf("---");
  for (const line of lines.slice(separatorIdx + 1)) {
    const match = line.match(/^- \*\*Article:\*\*\s*(https?:\/\/\S+)/i);
    if (match) return match[1]!;
  }
  return null;
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
    // `include_scores` lets the cap below keep the top-scoring docs instead of the
    // alphabetically-first ones. Older huginn ignores the unknown param and returns
    // the plain listing — `orderDocsForCap` then degrades to alphabetical.
    const resp = await fetch(`${apiUrl}/api/collection/${encodeURIComponent(collection)}/documents?include_scores=1`);
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
  const candidateDocs = recentDocs.filter((d) => !dedupByTweetId || !known.has(`tw:${extractTweetId(d.id)}`));
  // Coverage is the honest measure of how much the score-ordering actually did. A
  // partially-scored window (huginn's scorer running behind its fetcher) leaves the
  // cap mostly alphabetical, so it warns — not just the all-or-nothing zero case.
  const coverage = listingCoverage(candidateDocs);
  const coverageComplaint = coverageWarning(coverage);
  if (coverageComplaint) log.warn(coverageComplaint, { botName, ...coverage });
  // Score-descending so the maxDocs cap keeps the BEST docs, not the alphabetically
  // first ones; unscored docs hold their alphabetical slot. See orderDocsForCap.
  const newDocs = orderDocsForCap(candidateDocs);

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
          const data = await resp.json() as { text: string; metadata?: { url?: string; combined_score?: string | number } };
          const resolvedUrl = data.metadata?.url || doc.url;
          const compact = compactTweetText(data.text, resolvedUrl);
          // Same read as the listing cap (see `listingScore`): prefer huginn's
          // whitelisted `combined_score` metadata, fall back to the text-regex
          // `compact.rankScore` (0 for pre-whitelist docs) when it isn't usable.
          const rankScore = listingScore(data.metadata?.combined_score) ?? compact.rankScore;
          return { docId: doc.id, url: resolvedUrl, ...compact, rankScore };
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
        docType: r.docType,
        firstLine: r.firstLine,
        articleUrl: r.articleUrl,
        text: r.text,
        gateExcerpt: r.gateBody,
        links: r.links,
      }))
    : undefined;

  const topN = config.topN ?? DEFAULT_TOP_N;
  // X-Article amplification, applied at the RANKING step (after fetch, before the topN
  // slice) — deliberately NOT in the maxDocs listing cap, which is listing-score based and
  // runs before any body (and therefore any articleUrl) exists. Two effects, both scoped to
  // the DIGEST listing: each article group keeps exactly ONE slot (collapse — an amplifier now
  // carries the article's title+preview, so a popular article could otherwise take N+1
  // near-identical slots; the kept doc is the group's highest-scoring member, never a
  // downgrade), and an article quoted by >= amplificationMinAuthors distinct authors takes
  // over that one slot with its ARTICLE doc, moved to the BOTTOM of the top-N band, in one of
  // at most amplificationMaxPromotions reserved slots.
  // `compacted` itself is untouched, so the capture batch and trackingIds are unaffected.
  const amplification = resolveAmplificationConfig(config, botName);
  const amplified = applyAmplification(compacted, topN, amplification);
  for (const p of amplified.promotions) {
    log.info("Amplification: promoted {articleUrl} ({authors} distinct amplifiers) into rank {to}, taking the group's slot at rank {from} (replacing {replaced})", {
      botName, articleUrl: p.articleUrl, authors: p.amplifierAuthors, from: p.fromRank, to: p.toRank,
      docId: p.docId, replaced: p.replacedDocId ?? "nothing (the article doc was the group's representative)",
    });
  }
  const ranked = amplified.listing.slice(0, topN);
  const texts = ranked.map((r) => r.text);

  // Always emit the top score alongside counts so silent runs (minScore / quietMode)
  // still leave a breadcrumb the user can use to calibrate the gate from log history.
  // `scored=` is the cap's honesty field: it says how much of the in-window set the
  // score-ordering could actually rank (the rest held their alphabetical slot).
  // NB `article-collapsed` reads **0** on today's data: the 2026-07-25 top-80 batch — the real
  // production population, not the 476-doc window — held 7 article-footer docs in 7 groups with
  // NO multi-doc group. A nonzero value there is the first sign amplification has real surface.
  log.info("Collection: {total} docs, {recent} recent, {newCount} new, scored={scored}, {fetched} fetched, {collapsed} article-collapsed, {ranked} after ranking, topScore={topScore}", {
    botName,
    total: docs.length,
    recent: recentDocs.length,
    newCount: newDocs.length,
    scored: `${coverage.scored}/${coverage.total}`,
    fetched: compacted.length,
    collapsed: amplified.collapsed.length,
    ranked: ranked.length,
    topScore: compacted[0]?.rankScore.toFixed(3) ?? "n/a",
  });

  // `topScore` stays the FULL batch's top (`compacted[0]`, which collapse may have dropped
  // from the listing): it feeds the alert-path `minScore` gate, which must keep behaving
  // exactly as it did — a collapsed amplifier is still a real, fetched tweet the run
  // considered. Known + accepted; likewise on Highlights (`dedupByTweetId: true`) a collapsed
  // amplifier is marked seen without having been shown, since `trackingIds` rides `compacted`.
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

    // Same widening as the collection path's `parseDocType`: `article` is long-form too.
    if (t.tweet_type === "note" || t.tweet_type === "article") line = `[ARTICLE/NOTE] ${line}`;
    if (t.quoted_tweet) line += `\n  > @${t.quoted_tweet.handle}: ${t.quoted_tweet.text}`;
    line += `\n  URL: ${t.url}`;
    return line;
  });

  return { texts, trackingIds };
}

// --- Candidate capture (Claude Learning Center, Phase B — X → summaries inbox) ---

/** Inbox capture floor when `config.candidateMinScore` is unset. */
const DEFAULT_CANDIDATE_MIN_SCORE = 0.6;
/** Stricter capture floor for non-top-5%-author tweets when `config.candidateMinScoreNonTop` is unset. */
const DEFAULT_CANDIDATE_MIN_SCORE_NONTOP = 0.75;
/** Capture floor for `x-link` (pointer) tweets when `config.candidateMinScoreByKind["x-link"]` is unset. */
const DEFAULT_CANDIDATE_MIN_SCORE_XLINK = 0.7;

/** Author percentile tier, derived from the current x-feed author-score thresholds. */
export type AuthorTier = "top1" | "top5";

/**
 * Resolve a candidate author's percentile tier from their PageRank score against the
 * current thresholds. Null when the author is unknown/unranked OR the scores file is
 * unavailable (no thresholds) — the deliberate degrade: treat as non-top.
 */
export function resolveAuthorTier(
  score: number | null,
  thresholds: AuthorTierThresholds | null,
): AuthorTier | null {
  if (score == null || !thresholds) return null;
  if (score >= thresholds.top1) return "top1";
  if (score >= thresholds.top5) return "top5";
  return null;
}

/**
 * Per-tier inbox capture floor for `x-post` (long-form) tweets. Base precedence:
 * `candidateMinScoreByKind["x-post"]` → `candidateMinScore` → 0.6. A top-5% (or top-1%)
 * author keeps the base; every other author (incl. unknown / thresholds unavailable ⇒
 * tier `null`) must clear `max(base, candidateMinScoreNonTop)` — one knob, raise-only
 * (a raised base is never undercut). See {@link resolveAuthorTier}.
 *
 * A `docType` of `article` EXEMPTS a doc from the non-top raise. Full precedence table:
 *
 * | kind     | `**Type:**`      | author tier | floor                                    |
 * |----------|------------------|-------------|------------------------------------------|
 * | `x-post` | `article`        | any         | base (0.6)  ← non-top raise NEVER applies |
 * | `x-post` | `note` / ≥800ch  | top1/top5   | base (0.6)                                |
 * | `x-post` | `note` / ≥800ch  | null        | max(base, nonTop) (0.75)                  |
 * | `x-link` | any              | top1/top5   | {@link captureFloorForXLink} (0.7)        |
 *
 * Why articles are exempt: the non-top raise exists to suppress SHORT hype posts from
 * unknown authors that merely clear the 800-char body floor. An X Article is long-form
 * BY CONSTRUCTION (a published article, not a thread), so the raise would be filtering
 * on a signal that doesn't apply — and would silently kill the whole class, since
 * articles from top-5% authors are rare. An explicitly RAISED base still applies (the
 * exemption skips the non-top raise, it does not undercut a configured floor).
 */
export function captureFloorForTier(
  tier: AuthorTier | null,
  config: Pick<XWatcherConfig, "candidateMinScore" | "candidateMinScoreNonTop" | "candidateMinScoreByKind">,
  docType: XDocType | null = null,
): number {
  const base =
    config.candidateMinScoreByKind?.["x-post"] ??
    config.candidateMinScore ??
    DEFAULT_CANDIDATE_MIN_SCORE;
  const nonTop = config.candidateMinScoreNonTop ?? DEFAULT_CANDIDATE_MIN_SCORE_NONTOP;
  return tier != null || docType === "article" ? base : Math.max(base, nonTop);
}

/**
 * Inbox capture floor for `x-link` (pointer) tweets: `candidateMinScoreByKind["x-link"]`
 * → 0.7. `candidateMinScoreNonTop` NEVER applies — link-tweets are already top-author-only
 * by eligibility ({@link isLinkTweet}), so there's no non-top band to raise for.
 */
export function captureFloorForXLink(
  config: Pick<XWatcherConfig, "candidateMinScoreByKind">,
): number {
  return config.candidateMinScoreByKind?.["x-link"] ?? DEFAULT_CANDIDATE_MIN_SCORE_XLINK;
}

/** Gate-prompt author prior line for a tier (tier only, never the raw score), or null when unknown. */
function authorTierLabel(tier: AuthorTier | null): string | null {
  if (tier === "top1") return "author rank: top 1% of tracked authors";
  if (tier === "top5") return "author rank: top 5% of tracked authors";
  return null;
}
/**
 * A tweet body must reach this many chars (measured PRE-truncation on the extracted
 * body, not the raw doc) to count as long-form, unless the doc already carries a
 * long-form `**Type:**` marker (`note`/`article`). Below it the tweet is its own
 * summary — never captured.
 */
const LONGFORM_MIN_CHARS = 800;

/**
 * Default model-call timeout for an X row that configures none — the ONE default both
 * legs read: the digest call (`runAlertPath`) and the capture budget
 * ({@link captureBudgetMs}). Previously only the digest leg had it, while capture derived
 * its budget from `computeWatcherTimeoutMs`'s unrelated 120s floor.
 */
const DEFAULT_X_TIMEOUT_MS = 300_000;

/**
 * Capture-gate model-call timeout, PER ATTEMPT. Raised 90s → 180s after 2026-07-26,
 * when the gate produced ZERO successful runs for a day: the 90s cap was hit at
 * n=64/57/54/61/54 but ALSO at n=6/14/19, so the tail is spawn + model latency, not
 * only batch size. There is real headroom for it — the capturing X Highlights row runs
 * `config.timeoutMs: 600000`, i.e. a 630s runner net (`computeWatcherTimeoutMs`) — and
 * the hard completion budget below is what keeps the raise from ever eating that net.
 */
const CAPTURE_GATE_TIMEOUT_MS = 180_000;

/** Attempts per gate call: the first try plus ONE retry (the tail is transient). */
const CAPTURE_GATE_MAX_ATTEMPTS = 2;

/**
 * Never start a gate attempt with less than this much budget left. An attempt that
 * can't plausibly finish is worse than not trying: it burns the remaining budget and
 * still returns nothing. **45s is calibrated from the observed floor** — the fastest
 * empirically observed SUCCESSFUL gate call is 22.9s, so a 20s window (the first cut of
 * this constant) was near-certain waste. Re-cut it from the first week of
 * `x-capture-gate` `ok` lines (a low percentile of `durationMs`) once they exist. Below
 * the floor the gate gives up immediately and logs a `budget-exhausted` outcome instead.
 */
const CAPTURE_GATE_MIN_ATTEMPT_MS = 45_000;

/**
 * Safety margin subtracted from `min(watcher net, scheduler tick)` to get the capture
 * leg's hard completion budget (X Highlights: 630s net capped by the 600s tick ⇒ 540s).
 *
 * Blowing the net is CATASTROPHIC, not soft: `withWatcherTimeout` rejects, the runner's
 * catch re-saves the OLD `lastNotifiedIds` (`runner.ts`), so the whole batch is
 * re-fetched next run and the bulge grows. Capture runs CONCURRENTLY with the digest
 * call (started early in `checkX`, awaited in its `finally`), so the run's wall clock is
 * `max(capture, alert)` — no alert reserve is subtracted here, only this margin for the
 * surrounding fetch/persist/send work.
 */
const CAPTURE_BUDGET_SAFETY_MARGIN_MS = 60_000;

/**
 * The capture leg's hard completion budget, in ms from the run's start.
 *
 * Ceiling is `min(watcher net, scheduler tick)`, minus the safety margin:
 *   - **watcher net** = `(config.timeoutMs ?? DEFAULT_X_TIMEOUT_MS) + WATCHER_TIMEOUT_MARGIN_MS`.
 *     The default is read from the SAME `?? DEFAULT_X_TIMEOUT_MS` the digest leg uses, not
 *     from `computeWatcherTimeoutMs`'s 120s no-config FLOOR — that floor is a safety net for
 *     watcher types with no model call worth speaking of, and deriving the capture budget
 *     from it gave an un-configured X row a 60s budget, i.e. WORSE than the pre-retry flat
 *     90s and with the retry permanently dead. One field, one default, both legs.
 *   - **scheduler tick** ({@link TICK_TIMEOUT_MS}, 600s) is the TRUE ceiling: the tick race
 *     fires before a 630s net ever would.
 */
export function captureBudgetMs(watcher: Watcher): number {
  const configured = (watcher.config as XWatcherConfig | undefined)?.timeoutMs;
  const net = (configured ?? DEFAULT_X_TIMEOUT_MS) + WATCHER_TIMEOUT_MARGIN_MS;
  return Math.max(0, Math.min(net, TICK_TIMEOUT_MS) - CAPTURE_BUDGET_SAFETY_MARGIN_MS);
}

/**
 * Absolute wall-clock deadline the capture leg must finish by, derived from the RUNNER'S
 * clock. `runStartedAt` must be sampled at `checkX` entry — i.e. BEFORE
 * `fetchFromCollection`, which does up to `maxDocs` (80) per-doc HTTP fetches. A deadline
 * anchored at capture START would silently grant the gate that whole fetch duration on
 * top of the net and overshoot it.
 */
export function captureBudgetDeadline(watcher: Watcher, runStartedAt: number): number {
  return runStartedAt + captureBudgetMs(watcher);
}

/**
 * Timeout for the next gate attempt: `min(per-attempt cap, remaining budget)`, or `null`
 * when the remaining budget can't cover a plausible attempt (⇒ don't start one).
 */
export function captureAttemptTimeoutMs(deadline: number, now: number): number | null {
  const remaining = deadline - now;
  if (remaining < CAPTURE_GATE_MIN_ATTEMPT_MS) return null;
  return Math.min(CAPTURE_GATE_TIMEOUT_MS, remaining);
}

/**
 * Capture-gate prompt (mirrors the anthropic watcher's `{n,score,why}` contract). Scores
 * whether a SUMMARY is worth a spot on a personal learning shelf. Two item species reach
 * it: long-form notes/articles (judged on their own content) and top-author pointer tweets
 * (`x-link`, judged on the linked destination — marked by the per-item `links to:` line
 * `runCaptureGate` appends). The prompt teaches the model to tell them apart off that line.
 *
 * **Code-only** — `runCaptureGate` reads this constant unconditionally; the watcher row's
 * `config.prompt` reaches ONLY the alert/digest path (`runAlertPath`), so calibration
 * changes here ship without a seeded-prompt migration.
 *
 * Calibrated 2026-07-26 (X hype-dedup, step 1): the shelf was wall-to-wall engagement-farm
 * pointer content at 0.9–0.95 because the only anchors were ~1.0/~0.7/~0.6 — nothing
 * separated 0.9 from 0.95, and corr(gate score, author_score) measured −0.001 over 659
 * candidates. Three edits: (a) a **repackaging cap** at ~0.8 for secondhand long-form,
 * (b) real 0.8/0.9 anchors reserving ≥0.9 for **primary sources only** so the UI's "high"
 * band biases toward artifacts, (c) an in-list topic dedup instruction, (d) an explicit
 * anti-clustering line so 0.85 doesn't become the new pile-up bucket.
 *
 * **Author rank is never a positive prior.** An earlier cut also licensed ≥0.9 for "material
 * from a top-tier author" — but every eligible pointer item carries an `(author rank: top
 * 1%/5%)` line BY CONSTRUCTION (`isLinkTweet` requires `tier != null`), and that rank is farm
 * PageRank (measured corr −0.001 with quality). The disjunct therefore re-authorized exactly
 * the farm pointers being calibrated away, so the prompt now names the rank line as a reach
 * statistic and not a credibility signal.
 *
 * Both ceilings (0.85 without primary-source standing, 0.8 for repackaging) are phrased
 * **topic-independently** inside the prompt, because `withInterestProfile` appends its
 * "can RAISE relevance" block LAST — after this ladder — and that shared block
 * (`src/profile/inject.ts`, used by other watchers) must not be edited for an x-only fix.
 *
 * No code-side clamp is applied to the returned scores: compliance is best-effort (an
 * identical item scored 0.85 then 0.9 on a straight re-run). A deterministic post-gate clamp
 * is the plan's stated fallback if the first week of `x-capture-gate ok` lines shows poor
 * cap compliance.
 *
 * The cap's **pointer carve-out is load-bearing, not politeness**: pointer items are scored
 * on their DESTINATION and stay uncapped. A blanket ≤0.8 cap would suppress exactly the
 * artifacts the later destination-URL keying promotes — destination rows inherit the
 * representative pointer's gate score, so capping every pointer would pin every promoted
 * artifact below the 0.85 the inbox's `LIMIT 200` currently cuts at, while uncapped hype
 * threads sat above them.
 */
export const DEFAULT_X_CAPTURE_PROMPT = `You are curating a personal learning shelf for a senior AI engineer who builds agents, tools, and retrieval systems. Below is a numbered list of X posts. For EACH one, decide whether a written summary is worth saving to read later.

The list mixes two kinds of item:
• Long-form notes/articles — the value is the post's OWN text. Judge whether reading the full post is worth it.
• Pointer tweets — a short post whose value is the external destination it links to (a video, an article), marked by a "links to:" line. Judge the value of that LINKED destination given WHO is pointing at it: a top author flagging a 28-min video or an in-depth article is a strong signal even when the tweet itself says little.

For long-form notes:
  Weight HIGHEST: substantive technical insight, original analysis, research findings, agent/LLM/retrieval engineering lessons, thoughtful essays.
  Weight LOW (omit): hot takes, self-promotion, threads that are mostly links, engagement bait, news the engineer would already know, anything where the tweet already says everything.
  REPACKAGING CAP — applies ONLY to long-form notes, NEVER to pointer items: if a long-form note's value is mostly a secondhand repackaging of someone else's artifact (a course, paper, article, video, release) — a recap, a "here is what it says" breakdown, a summary of an announcement — score it BY THAT ARTIFACT and cap the score at 0.8. This ceiling binds regardless of the author's rank or standing; it lifts only when the post adds original analysis, benchmarks, or first-hand experience of its own. The ceiling is also topic-independent: it is not lifted by how well the item matches the reader's interests.
For pointer tweets (a "links to:" line), the "mostly links" / "already says everything" down-weights do NOT apply — a bare pointer to a substantive destination is exactly what we want, and the repackaging cap above does NOT apply either: a pointer is scored on its DESTINATION with no cap, so a pointer to a primary source can score 0.9 or above. Omit one only when the destination itself looks like self-promotion, engagement bait, or something the engineer would already know.

If several posts in this list point at, cover, or announce the same resource or announcement, keep only the one whose content (or destination) is most worth reading — score that one and omit the rest.

For EACH item worth saving, output one object:
  {"n": <the post number>, "score": <0.0-1.0>, "why": "<one short line on what reading it (or the linked content) would teach>"}
Calibration anchors — use the whole range, and judge a pointer item's destination against these same anchors:
  ~1.0 must-read.
  ~0.9 and above is RESERVED for a primary source — the artifact itself: the author's (or destination's) OWN work, paper, repo, release, or announcement — never coverage of one. Loud framing, ALL-CAPS, and engagement volume are NOT evidence of this. The "author rank" line is a reach statistic from the scraped feed, NOT a credibility signal: a high author rank never by itself justifies 0.9 or above. Without primary-source standing, do not go above 0.85 — this ceiling is absolute and is not lifted by how well the item matches the reader's interests.
  ~0.8 strong secondhand coverage — also the ceiling for repackaged long-form (see the cap above).
  ~0.7 clearly worthwhile.
  ~0.6 borderline.
Do not cluster scores at a ceiling: 0.85 is a maximum for items without primary-source standing, not their default. Below it, separate items — 0.8 strong secondhand coverage, 0.7 clearly worthwhile, 0.6 borderline — and use intermediate values (0.75, 0.65) freely.
OMIT items that aren't worth a summary — do not output them at all.

Return ONLY a JSON array of these objects, no prose and no markdown fences. If nothing is worth saving, return [].`;

/**
 * Long-form pre-filter (mirror of the anthropic watcher's `isShelfWorthy`): capture
 * eligibility for the inbox. A long-form note/article — either a long-form `**Type:**`
 * marker ({@link XDocType}: `note` OR `article`) or an extracted body ≥
 * {@link LONGFORM_MIN_CHARS} — is worth summarizing; a short plain tweet is its own
 * summary and is deliberately excluded. Link-tweets are NOT captured either: the
 * summarizer would only see the tweet's own (short) text, not the linked article, so
 * they'd yield short-tweet summaries.
 *
 * The marker branch is load-bearing for `article`: an X Article doc's body is only the
 * title + a ~190-char preview (≈280–460 chars measured), so the char floor can never
 * rescue it — without the marker the whole class is invisible to capture.
 */
export function isLongFormTweet(doc: Pick<TweetDoc, "bodyLength" | "docType">): boolean {
  return doc.docType != null || doc.bodyLength >= LONGFORM_MIN_CHARS;
}

/**
 * Link-tweet (pointer-tweet) capture eligibility — the second capture class alongside
 * {@link isLongFormTweet}. A pointer tweet's value is the external link it points at (a
 * 28-min video, an article), not its own short text, so the summarizer follows the link
 * (`kind: "x-link"`, PR 2's enrichment path treats the linked content as the primary
 * subject). Eligible iff ALL of:
 *   1. NOT long-form (long-form tweets are captured as `x-post` regardless of links);
 *   2. carries ≥1 external destination link (`doc.links`, already host-filtered by
 *      {@link extractDocLinks} — a raw link count would match every tweet via its own
 *      permalink, but that's on the singular `**Link:**` line which the parser ignores);
 *   3. the author is top-5% (or top-1%) of tracked authors (`tier != null`). Restricting
 *      to top authors keeps link-tweet volume — and the gate cost — bounded; the tier is
 *      the PR-1 per-run resolution, reused here.
 */
export function isLinkTweet(
  doc: Pick<TweetDoc, "bodyLength" | "docType" | "links">,
  tier: AuthorTier | null,
): boolean {
  return !isLongFormTweet(doc) && doc.links.length >= 1 && tier != null;
}

/** Truncate a candidate title at a word boundary near `max` chars. */
function truncateTitle(s: string, max = 140): string {
  const clean = s.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.lastIndexOf(" ", max);
  return `${clean.slice(0, cut > 0 ? cut : max)}…`;
}

/** The two X capture classes. `x-post` = long-form tweet; `x-link` = pointer tweet. */
type CaptureKind = "x-post" | "x-link";

/** One capture-eligible doc with its resolved author + kind (built in captureXCandidates). */
interface EligibleTweet {
  doc: TweetDoc;
  author: string | null;
  authorScore: number | null;
  tier: AuthorTier | null;
  kind: CaptureKind;
}

/** Host of a link's URL for the x-link gate line, or the raw URL if it won't parse. */
function linkDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Does this eligible item's gate score clear its per-kind capture floor? Single source of
 * truth shared by the persist loop and the gate's outcome log, so the logged
 * `aboveFloor` can never drift from what actually gets captured.
 */
function passesCaptureFloor(item: EligibleTweet, score: GateScore, config: XWatcherConfig): boolean {
  // x-post → per-tier floor (non-top raise applies, EXCEPT for `**Type:** article` —
  // long-form by construction, see the precedence table on captureFloorForTier);
  // x-link → the pointer-tweet floor (already top-author-only by eligibility, so no raise).
  const floor =
    item.kind === "x-link"
      ? captureFloorForXLink(config)
      : captureFloorForTier(item.tier, config, item.doc.docType);
  return score.score >= floor;
}

/** One gate attempt's outcome — the measurement surface, logged unconditionally. */
interface GateOutcome {
  outcome: "ok" | "failed" | "budget-exhausted";
  /** Items fed to THIS call. Load-bearing: the duration-vs-n correlation is what decides
   *  whether the batch needs chunking, and later batch-growth work must be able to split
   *  pre/post populations off this field. */
  n: number;
  /** USABLE parsed scores (`indexScoresByN` size — out-of-range/duplicate `n`s dropped),
   *  not the raw parsed-entry count. **`ok` outcomes only** — on a failed/exhausted call
   *  there is nothing scored, and emitting `0` there is indistinguishable from "ran and
   *  scored nothing", which would poison any mining of the acceptance rate. */
  scored?: number;
  /** Items that would actually be captured (`passesCaptureFloor`). `ok` only, same reason. */
  aboveFloor?: number;
  durationMs: number;
  /** Attempts actually MADE (so a `budget-exhausted` line before attempt k reports k−1,
   *  never a phantom attempt that never ran). */
  attempt: number;
  attemptTimeoutMs: number;
  promptChars: number;
  error?: string;
}

/**
 * THE capture-gate measurement surface — emitted for EVERY gate call, success and
 * failure alike. Nothing else records gate duration: `haiku_usage` has no duration column
 * and is written only on success, `spawnHaiku` emits no `claude` span for this call, and
 * the `Capture: queued` line only fires when something was actually captured. One
 * grep-stable prefix (`x-capture-gate`) so the log history can be mined directly.
 *
 * The rendered placeholders and the structured props in the JSONL sink carry the SAME
 * names (notably `attemptTimeoutMs`, never a rendered-only `timeoutMs` alias) — a mining
 * script written off the rendered line must find the same field in the sink.
 */
function logGateOutcome(o: GateOutcome, botName: string | undefined): void {
  // `scored`/`aboveFloor` are omitted entirely on non-ok outcomes (see GateOutcome).
  const counts = o.outcome === "ok" ? " scored={scored} aboveFloor={aboveFloor}" : "";
  const msg =
    `x-capture-gate {outcome}: n={n}${counts} durationMs={durationMs} attempt={attempt}/{maxAttempts} attemptTimeoutMs={attemptTimeoutMs} promptChars={promptChars}`;
  const props = { botName, maxAttempts: CAPTURE_GATE_MAX_ATTEMPTS, ...o };
  if (o.outcome === "ok") log.info(msg, props);
  else log.warn(`${msg} error={error}`, props);
}

/**
 * Score the eligible subset (long-form `x-post` + pointer `x-link` tweets) with one Haiku
 * call, retried once. Returns the parsed `{n,score,why}` array (model omits the
 * not-worth-saving). Throws on a model error or unparseable output that survives the
 * retry, so the caller can log + fall back to the alert path.
 *
 * Bounded by `deadline` (an absolute epoch-ms instant off the RUNNER'S clock): each
 * attempt gets `min(CAPTURE_GATE_TIMEOUT_MS, remaining)` and no attempt is started that
 * the remaining budget can't cover. Overrunning the runner's net doesn't just lose the
 * capture — it re-saves the OLD `lastNotifiedIds` and re-fetches the whole batch next
 * run, so the invariant is hard.
 */
async function runCaptureGate(
  eligible: EligibleTweet[],
  config: XWatcherConfig,
  botName: string | undefined,
  interestProfile: string | null,
  deadline: number,
  telemetry?: HaikuTelemetry,
): Promise<GateScore[]> {
  // Feed the gate the longer gateExcerpt, not the 500-char compact digest line — it is
  // judging whether the FULL post is worth summarizing. The author-rank prior (tier only,
  // when known) lets the gate judge content WITH the strongest prior; the deterministic
  // per-kind/tier floor stays the backstop. For an x-link (pointer) tweet the value is the
  // LINKED content, so the line names the destination (`links to: <domain> — <url>`) — the
  // gate weighs "a 28-min video by Claude Code's creator", not just the short tweet text.
  const list = eligible
    .map(({ doc, tier, kind }, i) => {
      const tierLine = authorTierLabel(tier);
      const priorPart = tierLine ? `\n   (${tierLine})` : "";
      const linkPart =
        kind === "x-link" && doc.links[0]
          ? `\n   links to: ${linkDomain(doc.links[0])} — ${doc.links[0]}`
          : "";
      return `${i + 1}. ${doc.docType ? "[ARTICLE/NOTE] " : ""}${doc.handle}: ${doc.gateExcerpt}${linkPart}${priorPart}\n   URL: ${doc.url}`;
    })
    .join("\n\n");
  const criteria = withInterestProfile(DEFAULT_X_CAPTURE_PROMPT, interestProfile);
  const prompt = `${criteria}\n\nPosts:\n\n${list}`;

  const base = {
    n: eligible.length,
    promptChars: prompt.length,
  };

  let lastError: unknown;
  let attemptsMade = 0;
  let budgetExhausted = false;
  for (let attempt = 1; attempt <= CAPTURE_GATE_MAX_ATTEMPTS; attempt++) {
    const attemptTimeoutMs = captureAttemptTimeoutMs(deadline, Date.now());
    if (attemptTimeoutMs === null) {
      // Hard budget invariant: never start an attempt the remaining budget can't cover.
      // `attempt` here is the one we're DECLINING to start, so the log reports the
      // attempts actually made (`attemptsMade`), never a phantom.
      budgetExhausted = true;
      logGateOutcome(
        {
          ...base,
          outcome: "budget-exhausted",
          durationMs: 0,
          attempt: attemptsMade,
          attemptTimeoutMs: 0,
          error: "capture budget exhausted",
        },
        botName,
      );
      break;
    }
    attemptsMade = attempt;
    const startedAt = Date.now();
    try {
      const { result } = await spawnHaiku(prompt, {
        source: "watcher-x-capture",
        entrypoint: `${botName ?? "jarvis"}-watcher`,
        botName,
        model: DEFAULT_MODEL,
        timeoutMs: attemptTimeoutMs,
        ...telemetry,
      });
      // Read the clock the instant the model call returns — `durationMs` must be MODEL
      // latency (the number the chunking decision correlates against n), not model +
      // parse + floor loop.
      const durationMs = Date.now() - startedAt;
      const scores = parseGateScores(result);
      const byN = indexScoresByN(scores, eligible.length);
      let aboveFloor = 0;
      for (let i = 0; i < eligible.length; i++) {
        const s = byN.get(i + 1);
        if (s && passesCaptureFloor(eligible[i]!, s, config)) aboveFloor++;
      }
      logGateOutcome(
        // `scored` is the USABLE count (byN.size), not scores.length — `indexScoresByN`
        // drops out-of-range/duplicate `n`s, and those never reach the persist loop.
        { ...base, outcome: "ok", scored: byN.size, aboveFloor, durationMs, attempt, attemptTimeoutMs },
        botName,
      );
      return scores;
    } catch (err) {
      lastError = err;
      logGateOutcome(
        {
          ...base,
          outcome: "failed",
          durationMs: Date.now() - startedAt,
          attempt,
          attemptTimeoutMs,
          error: err instanceof Error ? err.message : String(err),
        },
        botName,
      );
    }
  }

  // Budget termination must survive into the caller's `Capture gate failed` line —
  // rethrowing attempt 1's raw error there would hide the fact that the retry never ran.
  const raw = lastError instanceof Error ? lastError.message : lastError ? String(lastError) : null;
  if (budgetExhausted) {
    throw new Error(
      raw
        ? `capture budget exhausted after attempt ${attemptsMade}: ${raw}`
        : "capture budget exhausted before any attempt was started",
    );
  }
  throw lastError instanceof Error ? lastError : new Error(raw ?? "capture gate failed");
}

/**
 * Persist high-value tweets into the `summary_candidates` inbox — two capture classes fed
 * to ONE gate call: long-form tweets (`x-post`) and top-author pointer tweets (`x-link`).
 * Runs on the FULL fetched batch, INDEPENDENT of the alert `minScore`/`quietMode`
 * silencing — a run that alerts nothing can still capture. Best-effort throughout: a
 * capture-gate error is logged and the run proceeds with its normal alert path (the
 * batch's shelf-worthy tweets are lost to the inbox this run — we deliberately do NOT hold
 * tweet IDs back from tracking, so alert dedup never re-surfaces already-alerted tweets).
 * Dedup rides the table's `UNIQUE(source,url)` + the upstream `lastNotifiedIds` filter.
 */
async function captureXCandidates(
  docs: TweetDoc[],
  config: XWatcherConfig,
  watcher: Watcher,
  /** Absolute instant the capture leg must be done by — see {@link captureBudgetDeadline}. */
  deadline: number,
  botName?: string,
  interestProfile: string | null = null,
  telemetry?: HaikuTelemetry,
): Promise<void> {
  // Pre-candidates: long-form OR link-carrying. A link-carrying tweet still needs its
  // author tier resolved (top-5%-only eligibility), so it can't be filtered before the
  // author lookup below; a tweet that's neither long-form nor links anywhere can never
  // be captured, so it's dropped here to bound the author lookups.
  const preCandidates = docs.filter((d) => isLongFormTweet(d) || d.links.length >= 1);
  if (preCandidates.length === 0) {
    log.info("Capture: no long-form or link tweets in the batch of {n}", { botName, n: docs.length });
    return;
  }

  // Resolve author score + percentile tier ONCE per pre-candidate, BEFORE eligibility +
  // the floor check — the tier feeds link-tweet eligibility, the gate-prompt author prior,
  // AND the per-tier x-post floor. The thresholds are fetched once per run. Both the score
  // and the thresholds degrade to null (unknown handle / scores file unavailable) ⇒ tier
  // null ⇒ x-post treated as non-top (stricter floor) and x-link excluded — never wider.
  const thresholds = await getAuthorTierThresholds();
  const resolved = await Promise.all(
    preCandidates.map(async (doc) => {
      const author = normalizeHandle(doc.handle);
      const authorScore = await getAuthorScore(author);
      return { doc, author, authorScore, tier: resolveAuthorTier(authorScore, thresholds) };
    }),
  );

  // Build the eligible list with a per-doc kind. Long-form wins outright (captured as
  // x-post regardless of any links); otherwise a top-author link-tweet is x-link.
  const eligible: EligibleTweet[] = [];
  for (const r of resolved) {
    if (isLongFormTweet(r.doc)) eligible.push({ ...r, kind: "x-post" });
    else if (isLinkTweet(r.doc, r.tier)) eligible.push({ ...r, kind: "x-link" });
  }
  if (eligible.length === 0) {
    log.info("Capture: no eligible tweets after author-tier gating in the batch of {n}", { botName, n: docs.length });
    return;
  }

  let scored: GateScore[];
  try {
    scored = await runCaptureGate(eligible, config, botName, interestProfile, deadline, telemetry);
  } catch (err) {
    log.error("Capture gate failed, proceeding with alert path ({n} eligible tweet(s) lost to inbox): {error}", {
      botName,
      n: eligible.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const byN = indexScoresByN(scored, eligible.length);

  let captured = 0;
  for (let i = 0; i < eligible.length; i++) {
    const score = byN.get(i + 1);
    if (!score) continue;
    const item = eligible[i]!;
    const { doc, author, authorScore, kind } = item;
    // Per-kind floor — shared with the gate's outcome log so `aboveFloor` there always
    // means exactly "would be captured here".
    if (!passesCaptureFloor(item, score, config)) continue;
    const firstLine = doc.firstLine.trim() || doc.text;
    // An X Article's own permalink is the thing worth opening from /summaries — the
    // announcing tweet is just the pointer. Gated on `docType === "article"`, NOT on
    // `articleUrl` being present: huginn writes the `- **Article:**` footer on amplifier
    // docs too (a note/tweet whose QUOTE target is someone else's article), so a
    // capture-eligible non-article doc would otherwise key its row on another author's
    // article URL — and collide with the real article doc on UNIQUE(source, url), which
    // resolves content by `sourceDocId` and would serve the wrong body under that title.
    // Non-article docs keep the tweet URL. (Content resolution is unaffected either way:
    // the summarizer reads `sourceDocId`, never this URL.)
    //
    // POINTER (x-link) candidates are keyed on the normalized DESTINATION URL instead
    // (`destinationGroupKey`), so a wave of N pointer tweets at the same artifact —
    // arriving ≈1 per 2h batch over days, which in-batch dedup can never catch —
    // collapses to ONE row across runs. Null (no/unparseable/self-host link, or a PDF
    // destination) ⇒ today's tweet-URL keying, unchanged. Long-form is NEVER re-keyed:
    // long-form wins the kind resolution outright, so `kind === "x-link"` implies
    // `docType === null` and the two branches can't overlap.
    const destinationKey = kind === "x-link" ? destinationGroupKey(doc.links) : null;
    const candidateUrl =
      destinationKey ?? (doc.docType === "article" ? (doc.articleUrl ?? doc.url) : doc.url);
    // A destination-keyed row is written as ONE COHERENT SET (see
    // upsertDestinationCandidate): each admission either replaces every field from the
    // incoming member or leaves the stored representative alone — never a mix of two
    // wave members' score/why and doc id. Tweet-keyed rows keep the shared upsert, whose
    // identity-derived COALESCE precedence is correct when the url IS the tweet.
    const writeCandidate = destinationKey ? upsertDestinationCandidate : upsertCandidate;
    // Author transparency: the normalized handle keys huginn's ranking; the score is a
    // capture-time snapshot the /summaries page tiers against current percentile cuts.
    try {
      await writeCandidate({
        source: "x",
        url: candidateUrl,
        title: truncateTitle(`${doc.handle}: ${firstLine}`),
        candidateSrc: `X (${doc.handle})`,
        score: score.score,
        why: score.why,
        kind,
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
        url: candidateUrl,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (captured > 0) {
    log.info("Capture: queued {n} X candidate(s) to the inbox", { botName, n: captured });
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

  // Capture's hard completion budget is anchored HERE — `checkX` entry is effectively the
  // runner's clock (`runChecker` awaits this call immediately after starting
  // `withWatcherTimeout`). Anchoring it after the fetch below would silently grant the
  // gate up to 80 per-doc HTTP fetches' worth of extra time and overshoot the net.
  const captureBudget = captureBudgetMs(watcher);
  const captureDeadline = Date.now() + captureBudget;
  // A budget under one full per-attempt timeout means the gate can't even run one
  // uncapped attempt, let alone the retry — a degraded config, so say so out loud rather
  // than silently shipping a gate that can only ever half-try.
  if (config.captureCandidates && captureBudget < CAPTURE_GATE_TIMEOUT_MS) {
    log.warn(
      "Capture budget {budgetMs}ms is below the per-attempt gate timeout {attemptMs}ms — raise config.timeoutMs (gate attempts will be truncated and the retry may not fit)",
      { botName, budgetMs: captureBudget, attemptMs: CAPTURE_GATE_TIMEOUT_MS },
    );
  }

  const data = config.collection
    ? await fetchFromCollection(config, known, botName)
    : await fetchFromPython(config, known, botName);

  if (!data) return []; // fetch error

  // Load the bot user's interest profile ONCE per run (not per candidate). Null
  // when the bot has no default user / no profile / on any error, in which case
  // the capture-gate and digest prompts are byte-identical to today (the profile
  // only ever augments the hardcoded baseline criteria — anti-filter-bubble).
  const interestProfile = await loadInterestProfile(watcher.userId, botName ?? watcher.botName);

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
      ? captureXCandidates(data.docs, config, watcher, captureDeadline, botName, interestProfile, telemetry).catch((err) => {
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

Here are ${texts.length} tweets from the home timeline, pre-ranked by relevance to the user's interests:

${texts.join(separator)}

${userPrompt}`;

  const model = config.model || DEFAULT_MODEL;
  const timeoutMs = config.timeoutMs ?? DEFAULT_X_TIMEOUT_MS;
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
