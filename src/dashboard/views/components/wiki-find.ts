/**
 * FIND — the reader's palette (`/`, ⌘K) ranks the listing it already holds.
 * Pure and browser-safe: it reads `wiki-filter.ts`, `escape.ts` and the rail's
 * series helpers in `wiki-groups.ts` — so a series is grouped, keyed and labelled
 * the way the rail does it — and nothing else, so `bun test` loads it and the
 * /wiki bundle carries it.
 *
 * The local rows need no route (the palette's Everywhere section is
 * `GET /api/wiki/find-everywhere`). The server supplies one thing the listing cannot:
 * `near` on `/api/wiki/page` — closeness to the open page over the neighbour
 * rule (`src/wiki/strength.ts`), keyed by the listing's own `relPath` spelling.
 *
 * Grammar (`parseFindQuery`): free words are soft-ANDed (below) and
 * deduplicated after folding, stray `"` dropped (no phrase search).
 * `in:<text>` / `in:"<text with spaces>"` keeps pages whose series key or
 * label contains the text; `series:<key>` (what a chip applies) keeps the
 * series whose key IS that key, in the rail's fold; `type:<prefix>`;
 * `age:<N` / `age:>N` days on the worked-on axis; `#tag` a tag prefix, but
 * `#<digits>` a REQUIRED number word (a bare `12` stays a free word);
 * `is:retired` admits culled pages. A known key with no value yet (`in:`,
 * `type:`, `#`, `age:<`) is ignored; any other `key:` token
 * is a free word (quotes and all: `foo:"a b"` is the one word `foo:a b`). `<`
 * or `>` alone is unfinished only after `age:`. `in:`, `series:` and `type:` OR
 * their values (`type:plan type:blog`); two `#tag`s AND; two `age:` bounds AND,
 * so a second bound of the same direction keeps the tighter. Across keys
 * everything ANDs. A chip REPLACES the `series:` tokens and keeps the rest, so
 * it yields exactly the count it shows (pinned by a property test): what the
 * query returns inside that series alone — its full rows, plus at most
 * `PARTIAL_BAND_MAX` of its partial rows when it has fewer than
 * `PARTIAL_BAND_MAX_FULL` full rows.
 *
 * Score, per page: each word SUMS the weights of the fields it hits (title 3,
 * series 2, tags/aliases 1.5, description 1, status_note 1, relPath 1).
 * Total = text × (1 + 0.8 × near) + 0.6 × e^(−age/30). A pure-digit word
 * matches a WHOLE number outside any ISO date in the title (weight 4, so `9`
 * does not hit `2026-09-…`), the description or the status_note (1).
 *
 * Soft AND — filters stay hard, long free words do not. Every page listed
 * hits every REQUIRED word: a `#<digits>` word, and any free word shorter than
 * `FIND_SHORT_WORD` characters (folded), which matches too much to be the one
 * missing. A page hitting every word is in the FULL band, ranked as above. A
 * page hitting fewer, but at least `findNeed(n)` of the n LONG words (1 for
 * n ≤ 2, ⌈n/2⌉ from 3), is in the PARTIAL band, strictly below every full row.
 * The partial band is a bounded rescue for a weak query: a query whose full
 * band has `PARTIAL_BAND_MAX_FULL` or more rows gets no partial rows, and a
 * weaker one gets at most `PARTIAL_BAND_MAX`, ordered by words hit, then by
 * the rarity of the long words the page hit (Σ ln(1 + pool / pages hitting
 * the word), over the filtered pool for this query), then score. So on
 * "felles wiki" a page hitting `felles` outranks one hitting only `wiki`. A
 * one-word query behaves as plain AND. A partial row marks only its own words.
 */

import { escHtml } from "./escape.ts";
import {
  displayTitleOf,
  isMetaPage,
  pageWorkedMs,
  relPathMatchesQuery,
  type WikiListing,
} from "./wiki-filter.ts";
import { seriesCensusKey, seriesHead, seriesKeyOf, seriesMembersByFoldKey } from "./wiki-groups.ts";

/** How many rows the palette shows. */
export const FIND_ROWS_MAX = 40;
/** Field weights — see the header. */
export const FIND_WEIGHTS = {
  title: 3,
  titleNumber: 4,
  series: 2,
  tag: 1.5,
  description: 1,
  statusNote: 1,
  relPath: 1,
} as const;
/** A free word shorter than this (folded) is required, by length alone.
 *  Measured on mimir (559 pages in the pool): `i` hits 556, `w` 398 — as the
 *  missing word they flooded the partial band. `12` (21 pages) is required
 *  only because it is short. */
export const FIND_SHORT_WORD = 3;
/** A query whose full band has this many rows or more gets no partial rows. */
export const PARTIAL_BAND_MAX_FULL = 5;
/** The most partial rows a query returns, rarest matched words first. */
export const PARTIAL_BAND_MAX = 10;
/** The text score's multiplier is 1 + this × `near`, so 1.8 at `near` = 1. */
export const FIND_NEAR_BOOST = 0.8;
/** The recency term's weight and decay (days). */
export const FIND_RECENCY_WEIGHT = 0.6;
export const FIND_RECENCY_DAYS = 30;

const DAY_MS = 86_400_000;

export interface FindQuery {
  /** Free words, folded, deduplicated, none of them in `numbers`. */
  words: string[];
  /** `#<digits>` words, `#` dropped, deduplicated — required in both bands. */
  numbers: string[];
  /** `in:` values, folded. */
  inSeries: string[];
  /** `series:` keys, in {@link seriesMatchKey}'s form. */
  series: string[];
  /** `type:` prefixes, folded. */
  types: string[];
  /** `#tag` prefixes, folded, `#` dropped. */
  tags: string[];
  /** `age:<N` — page younger than N days. */
  ageLt?: number;
  /** `age:>N` — page older than N days. */
  ageGt?: number;
  /** `is:retired` — admit culled pages. */
  retired: boolean;
}

/** Lowercase and fold diacritics, so `Kjøring` matches `kjoring`. */
export function foldText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ø/gi, "o")
    .replace(/æ/gi, "ae")
    .replace(/đ/gi, "d")
    .replace(/ł/gi, "l")
    .toLowerCase();
}

/** Split a query into tokens, keeping `key:"a b"` whole. */
function tokenize(raw: string): string[] {
  const out: string[] = [];
  const re = /([A-Za-z]+:"[^"]*"?)|(\S+)/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) out.push(m[0]);
  return out;
}

function unquote(v: string): string {
  return v.startsWith('"') ? v.slice(1, v.endsWith('"') && v.length > 1 ? -1 : undefined) : v;
}

/**
 * The form a `series:` value and a page's series key are compared in: the
 * rail's fold (trimmed, lower-cased), with any `"` removed on BOTH sides — a
 * chip cannot quote a key that contains one.
 */
export function seriesMatchKey(key: string): string {
  return seriesCensusKey(key.replace(/"/g, ""));
}

/** Keys that are syntax even before a value is typed: an empty value (`in:`,
 *  `type:""`) is ignored rather than read as a word. */
const KNOWN_KEYS = new Set(["in", "series", "type", "is", "age"]);

/** What one query token is, as the parser reads it. The ONE classification:
 *  `parseFindQuery`, `isFindFilterToken` and `findFreeTokens` all read it. */
type FindToken =
  | { kind: "ignored" }
  | { kind: "in"; value: string }
  | { kind: "series"; key: string }
  | { kind: "type"; value: string }
  | { kind: "age"; dir: "<" | ">"; n: number }
  | { kind: "retired" }
  | { kind: "tag"; value: string }
  | { kind: "number"; digits: string }
  /** `raw` is the typed token, `"` removed, NOT folded. */
  | { kind: "word"; raw: string };

const FILTER_KINDS: ReadonlySet<FindToken["kind"]> = new Set(["in", "series", "type", "age", "retired", "tag"]);

function classifyToken(tok: string): FindToken {
  const colon = tok.indexOf(":");
  const key = colon > 0 ? tok.slice(0, colon).toLowerCase() : "";
  const value = colon > 0 ? unquote(tok.slice(colon + 1)) : "";
  // Mid-typing: `in:`, `in:"`, `age:<` — no filter, and not a word either.
  // `<`/`>` alone is unfinished only for `age:`; elsewhere it is a value
  // (a series keyed `<` has a chip, and `series:<` must apply it).
  const v = value.trim();
  if (KNOWN_KEYS.has(key) && (v === "" || (key === "age" && (v === "<" || v === ">")))) return { kind: "ignored" };
  if (key === "in") return { kind: "in", value: foldText(v) };
  if (key === "series") {
    const k = seriesMatchKey(value);
    return k ? { kind: "series", key: k } : { kind: "ignored" };
  }
  if (key === "type") return { kind: "type", value: foldText(v) };
  if (key === "age") {
    const m = /^([<>])(\d+)$/.exec(value);
    if (m) return { kind: "age", dir: m[1] as "<" | ">", n: Number(m[2]) };
  }
  if (key === "is" && value.toLowerCase() === "retired") return { kind: "retired" };
  if (tok === "#") return { kind: "ignored" };
  if (tok.startsWith("#")) {
    const rest = tok.slice(1);
    return /^\d+$/.test(rest) ? { kind: "number", digits: rest } : { kind: "tag", value: foldText(rest) };
  }
  const raw = tok.replace(/"/g, "");
  return foldText(raw) ? { kind: "word", raw } : { kind: "ignored" };
}

export function parseFindQuery(raw: string): FindQuery {
  const q: FindQuery = { words: [], numbers: [], inSeries: [], series: [], types: [], tags: [], retired: false };
  for (const tok of tokenize(raw)) {
    const t = classifyToken(tok);
    switch (t.kind) {
      case "ignored":
        break;
      case "in":
        q.inSeries.push(t.value);
        break;
      case "series":
        q.series.push(t.key);
        break;
      case "type":
        q.types.push(t.value);
        break;
      case "age":
        if (t.dir === "<") q.ageLt = q.ageLt === undefined ? t.n : Math.min(q.ageLt, t.n);
        else q.ageGt = q.ageGt === undefined ? t.n : Math.max(q.ageGt, t.n);
        break;
      case "retired":
        q.retired = true;
        break;
      case "tag":
        q.tags.push(t.value);
        break;
      case "number":
        q.numbers.push(t.digits);
        break;
      case "word":
        q.words.push(foldText(t.raw));
        break;
    }
  }
  q.numbers = [...new Set(q.numbers)];
  q.words = [...new Set(q.words)].filter((w) => !q.numbers.includes(w));
  return q;
}

/**
 * Is this token a FILTER — exactly when `parseFindQuery` reads it as one:
 * `in:`, `series:`, `type:` with a value, `age:<N`/`age:>N`, `is:retired`, a
 * `#tag`. An unfinished key (`type:`, `age:<`) is ignored, not a filter;
 * `is:foo` and `age:soon` are words; `#<digits>` is a number word.
 */
export function isFindFilterToken(tok: string): boolean {
  return FILTER_KINDS.has(classifyToken(tok).kind);
}

/** Does the query narrow by any filter token? The palette's Everywhere
 *  section is off while it does: filters mean "narrow this wiki". */
export function hasFindFilters(raw: string): boolean {
  return tokenize(raw).some(isFindFilterToken);
}

/**
 * The query's free WORDS in their typed spelling (not folded), `"` removed:
 * `text` keeps `#12` (the palette's hard number), `remote` is its digits `12`
 * — what huginn and claude-usage are sent. A quoted phrase after an unknown
 * key (`foo:"a b"`) is one word to the ranker but yields one entry per word
 * here, so a cap on entries is a cap on words.
 *
 * `text` re-parses to itself: a word the parser would read as something else
 * when unquoted (`"type:plan"`, `"#tag"`, `"#12"`) is sent quoted, so the
 * server's parse of the joined texts yields these same entries.
 */
export function findFreeTokens(raw: string): Array<{ text: string; remote: string }> {
  const out: Array<{ text: string; remote: string }> = [];
  for (const tok of tokenize(raw)) {
    const t = classifyToken(tok);
    if (t.kind === "number") out.push({ text: `#${t.digits}`, remote: t.digits });
    else if (t.kind === "word") for (const w of t.raw.split(/\s+/)) if (w) out.push({ text: wordText(w), remote: w });
  }
  return out;
}

/** A free word as the parser reads it back: bare when it parses as that same
 *  word, else quoted (a quoted token is never a key, a tag or a number). */
function wordText(w: string): string {
  const t = classifyToken(w);
  return t.kind === "word" && t.raw === w ? w : `"${w}"`;
}

/** What the palette sends the Everywhere route: the free words' `text` forms,
 *  filters out. `capFindEverywhereQuery` parses it back to the same entries. */
export function everywhereRequestQuery(raw: string): string {
  return findFreeTokens(raw)
    .map((t) => t.text)
    .join(" ");
}

/** The free words the remote legs are sent, joined by one space — and the key
 *  the palette refetches Everywhere on. */
export function freeText(raw: string): string {
  return findFreeTokens(raw)
    .map((t) => t.remote)
    .join(" ");
}

/** Does the query say anything at all? */
function isEmptyQuery(q: FindQuery): boolean {
  return (
    !q.words.length &&
    !q.numbers.length &&
    !q.inSeries.length &&
    !q.series.length &&
    !q.types.length &&
    !q.tags.length &&
    q.ageLt === undefined &&
    q.ageGt === undefined &&
    !q.retired
  );
}

/** A day, `YYYY-MM-DD`, or a month, `YYYY-MM` — a digit word never matches
 *  inside one, in the scorer and the highlighter alike. */
const ISO_DATE = /\b\d{4}-\d{2}(?:-\d{2})?\b/g;

function isoDateSpans(text: string): Array<[number, number]> {
  return [...text.matchAll(ISO_DATE)].map((m) => [m.index, m.index + m[0].length]);
}

function insideSpan(spans: ReadonlyArray<[number, number]>, start: number, end: number): boolean {
  return spans.some(([a, b]) => start < b && end > a);
}

const wholeNumberSource = (digits: string): string => `(?<!\\d)${digits}(?!\\d)`;

function hasWholeNumber(text: string, digits: string): boolean {
  const spans = isoDateSpans(text);
  for (const m of text.matchAll(new RegExp(wholeNumberSource(digits), "g"))) {
    if (!insideSpan(spans, m.index, m.index + m[0].length)) return true;
  }
  return false;
}

const labelMemo = new WeakMap<readonly WikiListing[], Map<string, string>>();

/** A series' display label per rail fold key (`seriesCensusKey`): the rail's
 *  `seriesHead` label, else the head's own spelling of the key. Memoized per
 *  listing array — the shell replaces the array on every refetch. */
export function seriesLabels(pages: readonly WikiListing[]): Map<string, string> {
  const hit = labelMemo.get(pages);
  if (hit) return hit;
  const out = new Map<string, string>();
  for (const [fold, members] of seriesMembersByFoldKey(pages)) {
    const head = seriesHead(members);
    out.set(fold, head?.seriesLabel || (head ? seriesKeyOf(head) : fold));
  }
  labelMemo.set(pages, out);
  return out;
}

/** A page's series label out of `seriesLabels`' map, `""` for a page in no
 *  series (or one the map does not know). The one spelling the palette and
 *  Related work's pill both read. */
export function seriesLabelFor(p: WikiListing, labels: ReadonlyMap<string, string>): string {
  const raw = seriesKeyOf(p);
  return raw ? (labels.get(seriesCensusKey(raw)) ?? "") : "";
}

/** Is this page in the find pool before any query filter? */
export function inFindPool(p: WikiListing, retired: boolean): boolean {
  if (isMetaPage(p)) return false;
  // Attachment children fold under their parent; a superseded page stays.
  if (p.pairedBy === "stem" || p.pairedBy === "suffix" || p.pairedBy === "link") return false;
  if (p.culled && !retired) return false;
  return true;
}

/** How many of `n` LONG free words a page must hit to be listed at all. */
export function findNeed(n: number): number {
  return n <= 2 ? Math.min(n, 1) : Math.ceil(n / 2);
}

export interface FindRow {
  page: WikiListing;
  score: number;
  /** How many of the query's words (`FindResult.terms`) the page hits. */
  matched: number;
  /** The folded words the page hits — what its row marks. */
  terms: string[];
  /** Hits fewer than all the words (the partial band). */
  partial: boolean;
  /** The page's closeness to the open page, 0 when none. */
  near: number;
  /** The rail's fold of the series key, `""` when the page has none. */
  seriesKey: string;
  seriesLabel: string;
}

export interface FindGroup {
  /** The rail's fold of the series key, `""` for a no-series row (a group of one). */
  seriesKey: string;
  seriesLabel: string;
  rows: FindRow[];
}

export interface FindChip {
  /** {@link seriesMatchKey} of the series — what `token` matches. */
  seriesKey: string;
  label: string;
  /** What applying the chip yields: its full rows, plus at most
   *  `PARTIAL_BAND_MAX` of its partial rows when it has fewer than
   *  `PARTIAL_BAND_MAX_FULL` full rows. Not only shown rows. */
  count: number;
  /** Full-band rows in this series — chips sort on it first. */
  full: number;
  /** The query token the chip applies. */
  token: string;
}

export interface FindResult {
  /** Rows in display order: groups ordered by their best row, best row first
   *  inside each. Flattened `groups`. */
  rows: FindRow[];
  groups: FindGroup[];
  chips: FindChip[];
  /** All returned matches before the row cap: the full band, plus the
   *  partial band when it is shown (capped at `PARTIAL_BAND_MAX`). */
  total: number;
  /** How many of `total` are partial rows. */
  partials: number;
  /** The query's folded words, free and `#<digits>`. A row marks its own `terms`. */
  terms: string[];
}

export interface RankOptions {
  /** relPath (listing spelling) → closeness in (0, 1). */
  near?: Record<string, number>;
  /** One `now` per query (`anchorNow`). */
  now: number;
  limit?: number;
}

interface TextHit {
  score: number;
  /** The words that hit at least one field. */
  hit: string[];
}

/** The text score of one page: the summed weights of the words that hit. */
function textScore(
  p: WikiListing,
  words: readonly string[],
  labels: Map<string, string>,
): TextHit {
  if (!words.length) return { score: 1, hit: [] };
  const titles = [...new Set([foldText(p.title), foldText(displayTitleOf(p))])];
  const raw = seriesKeyOf(p);
  const key = foldText(raw);
  const label = foldText(seriesLabelFor(p, labels));
  const tags = [...p.tags, ...p.aliases].map(foldText);
  const desc = foldText(p.description ?? "");
  const note = foldText(p.status_note ?? "");
  const rel = foldText(p.relPath);
  let total = 0;
  const hit: string[] = [];
  for (const w of words) {
    let s = 0;
    if (/^\d+$/.test(w)) {
      if (titles.some((t) => hasWholeNumber(t, w))) s += FIND_WEIGHTS.titleNumber;
      if (desc && hasWholeNumber(desc, w)) s += FIND_WEIGHTS.description;
      if (note && hasWholeNumber(note, w)) s += FIND_WEIGHTS.statusNote;
    } else {
      if (titles.some((t) => t.includes(w))) s += FIND_WEIGHTS.title;
      if (key && (key.includes(w) || label.includes(w))) s += FIND_WEIGHTS.series;
      if (tags.some((t) => t.includes(w))) s += FIND_WEIGHTS.tag;
      if (desc.includes(w)) s += FIND_WEIGHTS.description;
      if (note.includes(w)) s += FIND_WEIGHTS.statusNote;
      if (relPathMatchesQuery(rel, w)) s += FIND_WEIGHTS.relPath;
    }
    if (s === 0) continue;
    total += s;
    hit.push(w);
  }
  return { score: total, hit };
}

function passesFilters(
  p: WikiListing,
  q: FindQuery,
  labels: Map<string, string>,
  ageDays: number | null,
): boolean {
  const raw = seriesKeyOf(p);
  if (q.inSeries.length) {
    if (!raw) return false;
    const key = foldText(raw);
    const label = foldText(seriesLabelFor(p, labels));
    if (!q.inSeries.some((v) => key.includes(v) || label.includes(v))) return false;
  }
  if (q.series.length && !q.series.includes(seriesMatchKey(raw))) return false;
  if (q.types.length && !q.types.some((t) => foldText(p.type).startsWith(t))) return false;
  if (q.tags.length) {
    const tags = p.tags.map(foldText);
    if (!q.tags.every((t) => tags.some((tag) => tag.startsWith(t)))) return false;
  }
  if (q.ageLt !== undefined && (ageDays === null || !(ageDays < q.ageLt))) return false;
  if (q.ageGt !== undefined && (ageDays === null || !(ageDays > q.ageGt))) return false;
  return true;
}

/**
 * Rank the listing for a query. Empty query ⇒ no rows. Filters with no free
 * words admit every page that passes them at text score 1, so closeness and
 * recency still order them.
 */
export function rankFind(pages: readonly WikiListing[], raw: string, opts: RankOptions): FindResult {
  const q = parseFindQuery(raw);
  const terms = [...q.words, ...q.numbers];
  const empty: FindResult = { rows: [], groups: [], chips: [], total: 0, partials: 0, terms };
  if (isEmptyQuery(q)) return empty;
  const labels = seriesLabels(pages);
  const near = opts.near ?? {};
  const required = new Set([...q.numbers, ...q.words.filter((w) => w.length < FIND_SHORT_WORD)]);
  const need = findNeed(terms.length - required.size);
  // Pages per long word over the filtered pool — the partial band's rarity.
  const wordHits = new Map(terms.filter((w) => !required.has(w)).map((w) => [w, 0]));
  let pool = 0;
  const candidates: FindRow[] = [];
  for (const p of pages) {
    if (!inFindPool(p, q.retired)) continue;
    const ms = pageWorkedMs(p, opts.now);
    const ageDays = ms > 0 ? Math.max(0, (opts.now - ms) / DAY_MS) : null;
    if (!passesFilters(p, q, labels, ageDays)) continue;
    pool++;
    const text = textScore(p, terms, labels);
    for (const w of text.hit) {
      const n = wordHits.get(w);
      if (n !== undefined) wordHits.set(w, n + 1);
    }
    const hitRequired = text.hit.filter((w) => required.has(w)).length;
    if (hitRequired < required.size || text.hit.length - hitRequired < need) continue;
    const n = near[p.relPath] ?? 0;
    const recency = ageDays === null ? 0 : FIND_RECENCY_WEIGHT * Math.exp(-ageDays / FIND_RECENCY_DAYS);
    const raw = seriesKeyOf(p);
    const key = raw ? seriesCensusKey(raw) : "";
    candidates.push({
      page: p,
      score: text.score * (1 + FIND_NEAR_BOOST * n) + recency,
      matched: text.hit.length,
      terms: text.hit,
      partial: text.hit.length < terms.length,
      near: n,
      seriesKey: key,
      seriesLabel: key ? seriesLabelFor(p, labels) || raw : "",
    });
  }
  const rarity = (r: FindRow) =>
    r.terms.reduce((sum, w) => {
      const n = wordHits.get(w);
      return n ? sum + Math.log(1 + pool / n) : sum;
    }, 0);
  const byPath = (a: FindRow, b: FindRow) => a.page.relPath.localeCompare(b.page.relPath);
  const full = candidates.filter((r) => !r.partial).sort((a, b) => b.score - a.score || byPath(a, b));
  const rare = new Map(candidates.filter((r) => r.partial).map((r) => [r, rarity(r)]));
  const partial = [...rare.keys()].sort(
    (a, b) => b.matched - a.matched || rare.get(b)! - rare.get(a)! || b.score - a.score || byPath(a, b),
  );
  // The full band sits above every partial row; the partial band is a
  // bounded rescue for a weak full band, not a second result list.
  const scored = full.length < PARTIAL_BAND_MAX_FULL ? [...full, ...partial.slice(0, PARTIAL_BAND_MAX)] : full;

  // Chips count before the row cap, keyed on exactly what the chip's
  // `series:` token matches. Applying a chip runs the band rules on that
  // series alone — the threshold on its own full rows, the cap on its own
  // partial rows — so the count does too, and equals what applying it yields.
  // A chip exists for each series among the returned rows.
  const tally = new Map<string, { label: string; full: number; partial: number }>();
  for (const r of candidates) {
    const match = r.seriesKey ? seriesMatchKey(r.seriesKey) : "";
    if (!match) continue;
    const t = tally.get(match) ?? { label: r.seriesLabel, full: 0, partial: 0 };
    if (r.partial) t.partial++;
    else t.full++;
    tally.set(match, t);
  }
  const chipMap = new Map<string, FindChip>();
  for (const r of scored) {
    const match = r.seriesKey ? seriesMatchKey(r.seriesKey) : "";
    if (!match || chipMap.has(match)) continue;
    const t = tally.get(match)!;
    chipMap.set(match, {
      seriesKey: match,
      label: t.label,
      count: t.full + (t.full < PARTIAL_BAND_MAX_FULL ? Math.min(t.partial, PARTIAL_BAND_MAX) : 0),
      full: t.full,
      token: /\s/.test(match) ? `series:"${match}"` : `series:${match}`,
    });
  }

  const top = scored.slice(0, opts.limit ?? FIND_ROWS_MAX);
  // Group by series, groups in order of their best row. A no-series row is a
  // group of one placed by its own score, so the best match always leads. A
  // group never spans two words-hit tiers, or a partial row would sit inside a
  // series group above a full row ranked after that group's head.
  const groups: FindGroup[] = [];
  const byKey = new Map<string, FindGroup>();
  for (const r of top) {
    if (!r.seriesKey) {
      groups.push({ seriesKey: "", seriesLabel: "", rows: [r] });
      continue;
    }
    const tierKey = `${r.matched}\u0000${r.seriesKey}`;
    const g = byKey.get(tierKey);
    if (g) g.rows.push(r);
    else {
      const made = { seriesKey: r.seriesKey, seriesLabel: r.seriesLabel, rows: [r] };
      byKey.set(tierKey, made);
      groups.push(made);
    }
  }
  return {
    rows: groups.flatMap((g) => g.rows),
    groups,
    chips: [...chipMap.values()].sort(
      (a, b) => b.full - a.full || b.count - a.count || a.label.localeCompare(b.label),
    ),
    total: scored.length,
    partials: scored.filter((r) => r.partial).length,
    terms,
  };
}

/**
 * The query with its `series:` tokens replaced by `token`; every other token,
 * `in:` included, stays. The chip was counted over the rows the WHOLE query
 * admits, so the applied query must keep every filter but the one it replaces
 * — dropping `in:` admitted a quote twin (`a"b` beside `ab`) `in:` had kept
 * out. A dangling `key:"…` is closed first, or the appended token would be
 * read as part of its value.
 */
export function applySeriesChip(raw: string, token: string): string {
  const rest = tokenize(raw)
    .filter((t) => !/^series:/i.test(t))
    .map((t) => (/^[A-Za-z]+:"[^"]*$/.test(t) ? `${t}"` : t));
  return [...rest, token].join(" ");
}

/**
 * Escape `text` and wrap every hit of `terms` in `<mark>` — in ONE pass over
 * the raw text with one combined pattern. Word-by-word replacement over the
 * escaped output corrupts its own markup the moment a later word (`class`,
 * `mark`) matches inside a `<mark class=…>` it inserted.
 *
 * Matching runs on a folded copy with an index map back to the raw text, so
 * `kjoring` marks `Kjøring`. Digit terms match whole numbers outside ISO
 * dates only — the scorer's rule, so a mark never claims a hit scoring refused.
 */
export function highlightFind(text: string, terms: readonly string[]): string {
  const usable = [...new Set(terms.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!usable.length || !text) return escHtml(text);
  // Fold char by char, recording which raw index each folded char came from.
  let folded = "";
  const from: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const f = foldText(text[i]!);
    for (let k = 0; k < f.length; k++) {
      folded += f[k];
      from.push(i);
    }
  }
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const alt = usable.map((t) => (/^\d+$/.test(t) ? wholeNumberSource(t) : esc(t))).join("|");
  const re = new RegExp(alt, "g");
  const dates = isoDateSpans(folded);
  let out = "";
  let at = 0;
  for (let m = re.exec(folded); m; m = re.exec(folded)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    if (/^\d+$/.test(m[0]) && insideSpan(dates, m.index, m.index + m[0].length)) continue;
    const start = from[m.index]!;
    const end = from[m.index + m[0].length - 1]! + 1;
    if (start < at) continue;
    out += escHtml(text.slice(at, start)) + `<mark>${escHtml(text.slice(start, end))}</mark>`;
    at = end;
  }
  return out + escHtml(text.slice(at));
}
