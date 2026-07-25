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
 *     (measured: three adjacent, near-identical scores in one fixture batch). Exactly ONE
 *     doc per article reaches the digest listing; the rest are dropped from it. The kept
 *     doc is the group's **highest-scoring member**, whatever its `docType` — collapse
 *     never trades a higher-scoring doc for a lower-scoring one.
 *  2. **Promote** — when enough DISTINCT authors independently quote the same article, that
 *     is real amplification, and the group's **article doc** earns a place in the digest
 *     even if its own `combined_score` fell short.
 *
 * ## The one-slot invariant
 *
 * An article group occupies **exactly one** slot in the digest listing, always:
 *
 *  - By default that slot holds the group's highest-scoring member (the *representative*),
 *    at its own natural rank — an unforced content downgrade is impossible.
 *  - When a group is promoted, the group's **article doc** takes over that same single slot
 *    and is moved to the bottom of the top-N band; the representative it replaces leaves the
 *    listing (it joins `collapsed`). The group never gains a second entry.
 *  - Promotion is only ever *considered* for a group whose representative sits **outside**
 *    the top-N band. A group already represented inside the band needs nothing — and would
 *    otherwise get a second entry there, which the invariant forbids.
 *  - Therefore each promotion pushes exactly ONE non-group doc out of the band, and total
 *    displacement is `min(maxPromotions, topN)` — bounded, whatever the corpus looks like.
 *  - When the article doc IS the representative, promotion is a pure move: nothing is
 *    replaced, and `replacedDocId` is null.
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
 * ## Known v1 limitation — the BINDING constraint on promotion
 *
 * This runs at the RANKING step (after fetch, before the `topN` slice) — deliberately NOT in
 * the `maxDocs` listing cap, which is listing-score based and happens before bodies (and
 * therefore before any `articleUrl`) exist. So promotion requires the article doc **AND** at
 * least `minAuthors` distinct amplifier docs to land inside the SAME top-`maxDocs` (80)
 * score-ordered batch. That is a much tighter constraint than the calibration window makes
 * it look: the 2026-07-25 fixture is the 476-doc *window*, and it holds 25 article docs of
 * which only **6** sit inside the cap (ranks 1 / 15 / 26 / 38 / 57 / 67). On the actual
 * production population — `compacted`, the top-80 batch — that day had 7 article-footer docs
 * in 7 groups, **0 multi-doc groups**, hence 0 collapses and 0 promotions.
 *
 * Not a dead letter, though: PR 1's parse lift re-scored amplifiers of AI-relevant articles
 * at 0.59–0.65 (pvncher 0.6457, startupideaspod 0.6420, AnatoliKopadze 0.5950) against a
 * 2-day top-80 cut of 0.5777 — three of four measured amplifiers clear the cap post-lift.
 * The fixture still carries their PRE-lift ranks (99–153), which is why the replay's
 * ≥`minAuthors` scenarios are synthetic extensions of real groups.
 *
 * ## Known + accepted
 *
 *  - **Collapse is not bounded by `maxPromotions`.** `maxPromotions` bounds displacement
 *    from promotion only; a degenerate group of N amplifiers collapses N−1 docs out of the
 *    listing. Measured on the live corpus the max group size is **2**, so this is theory,
 *    not today's behavior — and collapse is a de-duplication fix, not a ranking preference.
 *  - **The `minScore` gate still reads `compacted[0]`**, which may be a doc that collapse
 *    dropped from the listing. Deliberate behavioral parity: a collapsed amplifier is still
 *    a real, fetched tweet the run considered, and the gate must keep behaving as before.
 *  - **On Highlights (`dedupByTweetId: true`) a collapsed amplifier is marked seen without
 *    having been shown.** Accepted: `trackingIds` is built off `compacted` (unchanged), and
 *    the capture path still sees the doc — only the digest listing loses it.
 */

import type { XDocType } from "./x.ts";
import { normalizeHandle } from "../summaries/author-scores.ts";
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
/**
 * Upper bound accepted for `amplificationMaxPromotions`. The knob exists to CAP displacement,
 * so a fat-fingered `1e9` must not silently uncap it — anything above this is warned about and
 * dropped back to the default, same stance as a wrong-typed field.
 */
export const MAX_AMPLIFICATION_MAX_PROMOTIONS = 20;

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
    minAuthors: readInt(config.amplificationMinAuthors, "amplificationMinAuthors", DEFAULT_AMPLIFICATION_MIN_AUTHORS, 1, Number.MAX_SAFE_INTEGER, botName),
    maxPromotions: readInt(config.amplificationMaxPromotions, "amplificationMaxPromotions", DEFAULT_AMPLIFICATION_MAX_PROMOTIONS, 0, MAX_AMPLIFICATION_MAX_PROMOTIONS, botName),
  };
}

function readInt(raw: unknown, field: string, fallback: number, min: number, max: number, botName?: string): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
    log.warn("Ignoring invalid {field}={value} (want an integer in [{min}, {max}]); using {fallback}", {
      botName, field, value: String(raw), min, max, fallback,
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
  /**
   * The group's highest-scoring `**Type:** article` doc, or null when the article's own doc
   * is outside the window. This — never the representative — is what a promotion promotes.
   */
  articleDoc: T | null;
  /** Members dropped from the digest listing (kept everywhere else — capture, tracking). */
  collapsed: T[];
  /** Distinct handles referencing the article that are NOT its owner. */
  amplifierAuthors: number;
}

/** One reserved-slot promotion, for the telemetry line the caller logs. */
export interface AmplificationPromotion {
  articleUrl: string;
  /** The ARTICLE doc that entered the band (never the representative it may have replaced). */
  docId: string;
  amplifierAuthors: number;
  /**
   * 1-indexed rank the GROUP held in the collapsed listing BEFORE promotion — i.e. its
   * representative's slot, which the article doc takes over (the one-slot invariant).
   */
  fromRank: number;
  /** 1-indexed rank of the article doc AFTER promotion (always inside the top-N band). */
  toRank: number;
  /**
   * The group member the article doc displaced from the listing, or null when the article
   * doc WAS the representative (then promotion is a pure move, nothing is replaced).
   */
  replacedDocId: string | null;
}

export interface AmplificationResult<T extends RankedDoc> {
  /** The digest listing: collapsed, with promoted articles moved into reserved slots. */
  listing: T[];
  promotions: AmplificationPromotion[];
  /** Docs dropped from the digest listing (group collapse + any promotion-replaced representative). */
  collapsed: T[];
}

/**
 * Normalize an article permalink into a group key.
 *
 * Lowercased, `http://` upgraded to `https://`, query + fragment stripped, trailing slashes
 * trimmed — so the SAME article promoted twice (huginn's promoted docs are discovery-dated, so
 * one article can legitimately appear as two docs a week apart) and every amplifier quoting it
 * land in one group. All 34 live footers are `https://` today, but the scheme is upstream data:
 * a single `http://` footer would otherwise split a group in half, silently.
 */
export function normalizeArticleUrl(url: string): string {
  const trimmed = url.trim().toLowerCase();
  const withoutHash = trimmed.split("#")[0]!;
  const withoutQuery = withoutHash.split("?")[0]!;
  return withoutQuery.replace(/^http:\/\//, "https://").replace(/\/+$/, "");
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

/**
 * The group member that keeps a digest slot: simply the **highest-scoring member**, whatever
 * its `docType`.
 *
 * Measured on the real 2026-07-25 window, preferring the article doc regardless of rank made
 * 5 of the 7 multi-doc groups keep a LOWER-scoring doc — worst case an amplifier note at rank
 * 40 (0.6122) dropped for the article doc at rank 112 (0.5502), a self-quote no promotion can
 * ever rescue. Collapse would then delete an in-band doc and put nothing in the band. And 5 of
 * the 7 collapsible carriers are substantive `note` docs of the amplifier's OWN, not near
 * duplicates. So collapse never downgrades; the article doc reaches the band via the PROMOTE
 * leg (see {@link applyAmplification}) or not at all.
 *
 * Input is score-descending, so the first element IS the highest-scoring member.
 */
function pickRepresentative<T extends RankedDoc>(docs: T[]): T {
  return docs[0]!;
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
    // Score-descending input ⇒ `find` yields the highest-scoring article doc.
    const articleDoc = members.find((d) => d.docType === "article") ?? null;
    // Owner precedence: the permalink (authoritative, present even when the article's own
    // doc fell outside the window) → the article doc's own handle. Null only for a malformed
    // permalink with no article doc, where every distinct handle is counted — the widest
    // reading, but it needs `minAuthors` distinct handles anyway.
    const owner =
      articleOwnerHandle(representative.articleUrl ?? key) ??
      (articleDoc ? normalizeHandle(articleDoc.handle) : null);
    const amplifiers = new Set<string>();
    for (const doc of members) {
      const handle = normalizeHandle(doc.handle);
      if (handle && handle !== owner) amplifiers.add(handle);
    }
    groups.push({
      key,
      owner,
      docs: members,
      representative,
      articleDoc,
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
 * Promotion order among qualifying groups: distinct-amplifier count DESC, then the ARTICLE
 * doc's rank score DESC, then its docId ASC (deterministic). A group whose representative is
 * already inside the top-N band consumes no slot (the one-slot invariant — see the module
 * docstring).
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

  const empty: AmplificationResult<T> = { listing, promotions: [], collapsed };
  if (config.maxPromotions <= 0 || topN <= 0 || listing.length <= topN) return empty;

  const rankOf = new Map(listing.map((d, i) => [d, i]));
  // Displacement can never exceed the band it displaces INTO: with topN 1 / maxPromotions 3
  // an unclamped slice would both make a promoted article the digest LEAD and (via a negative
  // insert index) park the rest at the listing tail while logging fabricated `toRank`s.
  const effectiveMax = Math.min(config.maxPromotions, topN);
  const candidates = groups
    .filter(
      (g) =>
        g.articleDoc !== null &&
        g.amplifierAuthors >= config.minAuthors &&
        (rankOf.get(g.representative) ?? -1) >= topN,
    )
    .sort(
      (a, b) =>
        b.amplifierAuthors - a.amplifierAuthors ||
        b.articleDoc!.rankScore - a.articleDoc!.rankScore ||
        a.articleDoc!.docId.localeCompare(b.articleDoc!.docId),
    )
    .slice(0, effectiveMax);
  if (candidates.length === 0) return empty;

  // Reserved slots are the TAIL of the top-N band: promoted articles enter the digest at its
  // bottom, never as the lead, and exactly `candidates.length` docs are displaced. The article
  // doc TAKES OVER its group's single slot — the representative it replaces leaves the listing,
  // so the group still occupies one slot in total.
  const promoted = candidates.map((g) => g.articleDoc!);
  const replaced = candidates.map((g) => g.representative).filter((r, i) => r !== candidates[i]!.articleDoc);
  const removed = new Set<T>([...promoted, ...replaced]);
  const rest = listing.filter((d) => !removed.has(d));
  const insertAt = Math.max(0, topN - promoted.length);
  const reordered = [...rest.slice(0, insertAt), ...promoted, ...rest.slice(insertAt)];

  const finalRank = new Map(reordered.map((d, i) => [d, i]));
  const promotions = candidates.map((g) => {
    const article = g.articleDoc!;
    return {
      articleUrl: article.articleUrl ?? g.key,
      docId: article.docId,
      amplifierAuthors: g.amplifierAuthors,
      fromRank: rankOf.get(g.representative)! + 1,
      toRank: finalRank.get(article)! + 1,
      replacedDocId: article === g.representative ? null : g.representative.docId,
    };
  });

  // A replaced representative is dropped from the listing exactly like a collapsed doc, and a
  // promoted article doc is no longer dropped — keep `collapsed` an honest account of both.
  const promotedSet = new Set<T>(promoted);
  const finalCollapsed = [...collapsed.filter((d) => !promotedSet.has(d)), ...replaced];

  return { listing: reordered, promotions, collapsed: finalCollapsed };
}
