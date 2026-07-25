/**
 * X-Article amplification signal — the digest-leg half of the X-Articles campaign.
 *
 * huginn writes a `- **Article:** <permalink>` footer on EVERY doc whose tweet or quote
 * target carries an X Article: the article's own (promoted, discovery-dated) doc AND each
 * amplifier doc that quote-tweeted it. `TweetDoc.articleUrl` (see `x.ts`) surfaces that
 * footer, which makes two things possible at ranking time:
 *
 *  1. **Collapse** — an amplifier doc now carries the article's title + preview inside its
 *     quote block, so one popular article can occupy N+1 near-identical digest slots
 *     (measured: three adjacent, near-identical scores in one fixture batch). One doc per
 *     article reaches the digest listing; the rest are dropped from it.
 *  2. **Promote** — when enough DISTINCT authors independently quote the same article, that
 *     is real amplification, and the article doc earns a place in the digest even if its own
 *     `combined_score` fell short.
 *
 * ## Why a reserved slot, not a score multiplier
 *
 * The plan's stated risk is that "a too-generous boost turns every widely-quoted listicle
 * into a digest lead". The live score distribution makes that risk concrete rather than
 * theoretical: over the real 2026-07-25 two-day window (476 docs, 100% listing-score
 * coverage) the whole usable band is **0.6201 (top-30 bar) → 0.7493 (max)** — a spread of
 * 0.13. A multiplier calibrated to lift a mid-band article (rank 67, 0.5903) over the bar
 * needs ≈ ×1.051; applied to the day's top article (0.7493) the same factor yields 0.7874,
 * i.e. an unassailable, permanent digest lead for whatever the amplifiers happened to like.
 * Worse, a multiplier's DISPLACEMENT is unbounded: N qualifying articles push N docs out.
 *
 * A reserved slot inverts both properties. At most {@link ResolvedAmplificationConfig.maxPromotions}
 * (default 1) promoted articles enter the digest, they enter at the BOTTOM of the top-N band
 * (never the lead), and the worst case is exactly `maxPromotions` displaced docs no matter
 * how junk or how widely quoted the article is. Nothing is multiplied, so the score ordering
 * of every other doc is byte-identical to today.
 *
 * ## Known v1 limitation
 *
 * This runs at the RANKING step (after fetch, before the `topN` slice) — deliberately NOT in
 * the `maxDocs` listing cap, which is listing-score based and happens before bodies (and
 * therefore before any `articleUrl`) exist. An article doc that misses the top-`maxDocs`
 * fetch is invisible here and cannot be promoted. Accepted: the live window's article-class
 * docs all sat at ranks 1–67, well inside the 80-doc cap.
 */

import type { XDocType } from "./x.ts";
import { getLog } from "../logging.ts";

const log = getLog("watchers", "x-amplification");

/** Distinct amplifying authors required before an article earns a reserved digest slot. */
export const DEFAULT_AMPLIFICATION_MIN_AUTHORS = 3;
/**
 * Reserved digest slots per run. The BOUND on the whole mechanism: at most this many docs
 * can ever be displaced from the digest by amplification, whatever the corpus looks like.
 * `0` disables promotion entirely (collapse still runs — it is a de-duplication fix).
 */
export const DEFAULT_AMPLIFICATION_MAX_PROMOTIONS = 1;

/** The watcher-config slice this module reads (a subset of `XWatcherConfig`). */
export interface AmplificationConfig {
  /** Distinct amplifying authors required to promote (default 3). */
  amplificationMinAuthors?: number;
  /** Max reserved digest slots per run (default 1; 0 disables promotion). */
  amplificationMaxPromotions?: number;
}

export interface ResolvedAmplificationConfig {
  minAuthors: number;
  maxPromotions: number;
}

/**
 * Read + validate the amplification knobs off the watcher's JSONB config.
 *
 * Same stance as bot-config discovery: a wrong-typed or out-of-range value is **warned about
 * and dropped** (the field falls back to its default) rather than carried downstream, and a
 * bad field never aborts the run. `maxPromotions: 0` is a valid, falsy-but-kept value.
 */
export function resolveAmplificationConfig(
  config: AmplificationConfig,
  botName?: string,
): ResolvedAmplificationConfig {
  return {
    minAuthors: readInt(config.amplificationMinAuthors, "amplificationMinAuthors", DEFAULT_AMPLIFICATION_MIN_AUTHORS, 1, botName),
    maxPromotions: readInt(config.amplificationMaxPromotions, "amplificationMaxPromotions", DEFAULT_AMPLIFICATION_MAX_PROMOTIONS, 0, botName),
  };
}

function readInt(raw: unknown, field: string, fallback: number, min: number, botName?: string): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min) {
    log.warn("Ignoring invalid {field}={value} (want an integer >= {min}); using {fallback}", {
      botName, field, value: String(raw), min, fallback,
    });
    return fallback;
  }
  return raw;
}

/** The minimum shape amplification needs off a fetched, score-ranked x-feed doc. */
export interface RankedDoc {
  docId: string;
  handle: string;
  rankScore: number;
  docType: XDocType | null;
  articleUrl: string | null;
}

/** One article's in-window doc family: its own doc (when present) plus every amplifier. */
export interface ArticleGroup<T extends RankedDoc> {
  /** Normalized `articleUrl` — the group key. */
  key: string;
  /** Handle that OWNS the article, parsed from the permalink (`x.com/<owner>/article/<id>`). */
  owner: string | null;
  /** Group members in input (score-descending) order. */
  docs: T[];
  /** The one member that keeps a digest slot — see {@link pickRepresentative}. */
  representative: T;
  /** Members dropped from the digest listing (kept everywhere else — capture, tracking). */
  collapsed: T[];
  /** Distinct handles referencing the article that are NOT its owner. */
  amplifierAuthors: number;
}

/** One reserved-slot promotion, for the telemetry line the caller logs. */
export interface AmplificationPromotion {
  articleUrl: string;
  docId: string;
  amplifierAuthors: number;
  /** 1-indexed rank in the collapsed listing BEFORE promotion. */
  fromRank: number;
  /** 1-indexed rank AFTER promotion (always inside the top-N band). */
  toRank: number;
}

export interface AmplificationResult<T extends RankedDoc> {
  /** The digest listing: collapsed, with promoted articles moved into reserved slots. */
  listing: T[];
  promotions: AmplificationPromotion[];
  /** Docs dropped from the digest listing by group collapse. */
  collapsed: T[];
  groups: ArticleGroup<T>[];
}

/**
 * Normalize an article permalink into a group key.
 *
 * Lowercased, query + fragment stripped, trailing slashes trimmed — so the SAME article
 * promoted twice (huginn's promoted docs are discovery-dated, so one article can legitimately
 * appear as two docs a week apart) and every amplifier quoting it land in one group.
 */
export function normalizeArticleUrl(url: string): string {
  const trimmed = url.trim().toLowerCase();
  const withoutHash = trimmed.split("#")[0]!;
  const withoutQuery = withoutHash.split("?")[0]!;
  return withoutQuery.replace(/\/+$/, "");
}

/**
 * The handle that OWNS an article, read off the permalink (`https://x.com/<owner>/article/<id>`).
 *
 * Load-bearing for the threshold: the article author posting their OWN article — or
 * quote-tweeting it themselves to bump it — is not amplification. Null when the URL doesn't
 * carry the expected shape; the caller then falls back to the article doc's own handle.
 */
export function articleOwnerHandle(url: string): string | null {
  const match = url.trim().toLowerCase().match(/^https?:\/\/[^/]+\/([^/?#]+)\/article\//);
  return match ? match[1]! : null;
}

/** `@Handle` → `handle`; empty/unknown → null. */
function normalize(handle: string): string | null {
  const bare = handle.trim().replace(/^@+/, "").toLowerCase();
  return !bare || bare === "unknown" ? null : bare;
}

/**
 * The group member that keeps a digest slot: the highest-scoring `**Type:** article` doc when
 * the article's OWN doc is in the window, else the highest-scoring member.
 *
 * The fallback matters for a pre-PR-1 corpus (and for an article first quoted before huginn
 * promoted it): with no article doc in the window the best amplifier is the only way the
 * article reaches the digest at all, so it is kept rather than the whole group dropped.
 *
 * Input is score-descending, so "first match wins" IS "highest-scoring".
 */
function pickRepresentative<T extends RankedDoc>(docs: T[]): T {
  return docs.find((d) => d.docType === "article") ?? docs[0]!;
}

/**
 * Group the fetched batch by normalized `articleUrl`. Docs without one are not in any group.
 * `docs` must be score-DESCENDING (the order `fetchFromCollection` establishes).
 */
export function buildArticleGroups<T extends RankedDoc>(docs: T[]): ArticleGroup<T>[] {
  const byKey = new Map<string, T[]>();
  for (const doc of docs) {
    if (!doc.articleUrl) continue;
    const key = normalizeArticleUrl(doc.articleUrl);
    if (!key) continue;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(doc);
    else byKey.set(key, [doc]);
  }

  const groups: ArticleGroup<T>[] = [];
  for (const [key, members] of byKey) {
    const representative = pickRepresentative(members);
    // Owner precedence: the permalink (authoritative, present even when the article's own
    // doc fell outside the window) → the representative's handle when IT is the article doc.
    // Null only for a malformed permalink with no article doc, where every distinct handle
    // is counted — the widest reading, but it needs `minAuthors` distinct handles anyway.
    const owner =
      articleOwnerHandle(representative.articleUrl ?? key) ??
      (representative.docType === "article" ? normalize(representative.handle) : null);
    const amplifiers = new Set<string>();
    for (const doc of members) {
      const handle = normalize(doc.handle);
      if (handle && handle !== owner) amplifiers.add(handle);
    }
    groups.push({
      key,
      owner,
      docs: members,
      representative,
      collapsed: members.filter((d) => d !== representative),
      amplifierAuthors: amplifiers.size,
    });
  }
  return groups;
}

/**
 * Collapse article groups and hand the qualifying ones a reserved digest slot.
 *
 * `docs` must be score-descending. Returns a NEW listing; the input array is untouched, and
 * every doc that is not a collapsed group member survives (a permutation minus `collapsed`),
 * so the caller's capture batch + tracking ids are unaffected.
 *
 * Promotion order among qualifying groups: distinct-amplifier count DESC, then rank score
 * DESC, then docId ASC (deterministic). A qualifying article already inside the top-N band
 * consumes no slot.
 */
export function applyAmplification<T extends RankedDoc>(
  docs: T[],
  topN: number,
  config: ResolvedAmplificationConfig,
): AmplificationResult<T> {
  const groups = buildArticleGroups(docs);
  const collapsed = groups.flatMap((g) => g.collapsed);
  const dropped = new Set(collapsed);
  const listing = docs.filter((d) => !dropped.has(d));

  const empty: AmplificationResult<T> = { listing, promotions: [], collapsed, groups };
  if (config.maxPromotions <= 0 || topN <= 0 || listing.length <= topN) return empty;

  const rankOf = new Map(listing.map((d, i) => [d, i]));
  const candidates = groups
    .filter((g) => g.amplifierAuthors >= config.minAuthors && (rankOf.get(g.representative) ?? -1) >= topN)
    .sort(
      (a, b) =>
        b.amplifierAuthors - a.amplifierAuthors ||
        b.representative.rankScore - a.representative.rankScore ||
        a.representative.docId.localeCompare(b.representative.docId),
    )
    .slice(0, config.maxPromotions);
  if (candidates.length === 0) return empty;

  // Reserved slots are the TAIL of the top-N band: promoted articles enter the digest at its
  // bottom, never as the lead, and exactly `candidates.length` docs are displaced.
  const promoted = candidates.map((g) => g.representative);
  const promotedSet = new Set(promoted);
  const rest = listing.filter((d) => !promotedSet.has(d));
  const reordered = [...rest.slice(0, topN - promoted.length), ...promoted, ...rest.slice(topN - promoted.length)];

  const finalRank = new Map(reordered.map((d, i) => [d, i]));
  const promotions = candidates.map((g) => ({
    articleUrl: g.representative.articleUrl ?? g.key,
    docId: g.representative.docId,
    amplifierAuthors: g.amplifierAuthors,
    fromRank: rankOf.get(g.representative)! + 1,
    toRank: finalRank.get(g.representative)! + 1,
  }));

  return { listing: reordered, promotions, collapsed, groups };
}
