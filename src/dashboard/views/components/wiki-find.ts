/**
 * FIND — the reader's palette (`/`, ⌘K) ranks the listing it already holds.
 * Pure and browser-safe: it reads `wiki-filter.ts` helpers and nothing else, so
 * `bun test` loads it and the /wiki bundle carries it.
 *
 * There is no find route. The server supplies one thing the listing cannot:
 * `near` on `/api/wiki/page` — closeness to the open page over the neighbour
 * rule (`src/wiki/strength.ts`), keyed by the listing's own `relPath` spelling.
 *
 * Grammar (`parseFindQuery`): free words are ANDed. `in:<text>` /
 * `in:"<text with spaces>"` keeps pages whose series key or label contains the
 * text; `type:<prefix>`; `age:<N` / `age:>N` days on the worked-on axis; `#tag`
 * a tag prefix, but `#<digits>` a number word; `is:retired` admits culled
 * pages. Any other `key:` token is a free word. Within one key the values are
 * ORed (`type:plan type:blog`), across keys ANDed.
 *
 * Score, per page: each word SUMS the weights of the fields it hits (title 3,
 * series 2, tags/aliases 1.5, description 1, relPath 1); a word that hits no
 * field drops the page. Total = text × (1 + 0.8 × near) + 0.6 × e^(−age/30).
 * A pure-digit word matches a WHOLE number in the title (weight 4, ISO dates
 * removed first, so `9` does not hit `2026-09-…`) or the description (1).
 */

import {
  displayTitleOf,
  isMetaPage,
  pageWorkedMs,
  relPathMatchesQuery,
  type WikiListing,
} from "./wiki-filter.ts";

/** How many rows the palette shows. */
export const FIND_ROWS_MAX = 40;
/** Field weights — see the header. */
export const FIND_WEIGHTS = {
  title: 3,
  titleNumber: 4,
  series: 2,
  tag: 1.5,
  description: 1,
  relPath: 1,
} as const;
/** How much `near` multiplies the text score at its ceiling. */
export const FIND_NEAR_BOOST = 0.8;
/** The recency term's weight and decay (days). */
export const FIND_RECENCY_WEIGHT = 0.6;
export const FIND_RECENCY_DAYS = 30;

const DAY_MS = 86_400_000;

export interface FindQuery {
  /** Free words, folded. */
  words: string[];
  /** `in:` values, folded. */
  inSeries: string[];
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

export function parseFindQuery(raw: string): FindQuery {
  const q: FindQuery = { words: [], inSeries: [], types: [], tags: [], retired: false };
  for (const tok of tokenize(raw)) {
    const colon = tok.indexOf(":");
    const key = colon > 0 ? tok.slice(0, colon).toLowerCase() : "";
    const value = colon > 0 ? unquote(tok.slice(colon + 1)) : "";
    if (key === "in" && value.trim()) {
      q.inSeries.push(foldText(value.trim()));
      continue;
    }
    if (key === "type" && value.trim()) {
      q.types.push(foldText(value.trim()));
      continue;
    }
    if (key === "age") {
      const m = /^([<>])(\d+)$/.exec(value);
      if (m) {
        if (m[1] === "<") q.ageLt = Number(m[2]);
        else q.ageGt = Number(m[2]);
        continue;
      }
    }
    if (key === "is" && value.toLowerCase() === "retired") {
      q.retired = true;
      continue;
    }
    if (tok.startsWith("#") && tok.length > 1) {
      const rest = tok.slice(1);
      if (/^\d+$/.test(rest)) q.words.push(rest);
      else q.tags.push(foldText(rest));
      continue;
    }
    const word = foldText(tok);
    if (word) q.words.push(word);
  }
  return q;
}

/** Does the query say anything at all? */
function isEmptyQuery(q: FindQuery): boolean {
  return (
    !q.words.length &&
    !q.inSeries.length &&
    !q.types.length &&
    !q.tags.length &&
    q.ageLt === undefined &&
    q.ageGt === undefined &&
    !q.retired
  );
}

/** A day, `YYYY-MM-DD`, or a month, `YYYY-MM` — removed before number matching. */
const ISO_DATE = /\b\d{4}-\d{2}(?:-\d{2})?\b/g;

function hasWholeNumber(text: string, digits: string): boolean {
  return new RegExp(`(?<!\\d)${digits}(?!\\d)`).test(text.replace(ISO_DATE, " "));
}

/** A series' display label per folded key, from the head page that carries it
 *  (`series_label:` sits on one page only). */
export function seriesLabels(pages: readonly WikiListing[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of pages) {
    if (p.series && p.seriesLabel) out.set(foldText(p.series.trim()), p.seriesLabel);
  }
  return out;
}

/** Is this page in the find pool before any query filter? */
export function inFindPool(p: WikiListing, retired: boolean): boolean {
  if (isMetaPage(p)) return false;
  // Attachment children fold under their parent; a superseded page stays.
  if (p.pairedBy === "stem" || p.pairedBy === "suffix" || p.pairedBy === "link") return false;
  if (p.culled && !retired) return false;
  return true;
}

export interface FindRow {
  page: WikiListing;
  score: number;
  /** The page's closeness to the open page, 0 when none. */
  near: number;
  /** Folded series key, `""` when the page has none. */
  seriesKey: string;
  seriesLabel: string;
}

export interface FindGroup {
  /** Folded series key, `""` for a no-series row (a group of one). */
  seriesKey: string;
  seriesLabel: string;
  rows: FindRow[];
}

export interface FindChip {
  seriesKey: string;
  label: string;
  /** Matches in this series across ALL results, not only the shown rows. */
  count: number;
  /** The query token the chip applies. */
  token: string;
}

export interface FindResult {
  /** Rows in display order: groups ordered by their best row, best row first
   *  inside each. Flattened `groups`. */
  rows: FindRow[];
  groups: FindGroup[];
  chips: FindChip[];
  /** All matches, before the row cap. */
  total: number;
  /** The folded terms the highlighter marks. */
  terms: string[];
}

export interface RankOptions {
  /** relPath (listing spelling) → closeness in (0, 1). */
  near?: Record<string, number>;
  /** One `now` per query (`anchorNow`). */
  now: number;
  limit?: number;
}

/** The text score of one page for the query's words; 0 when a word misses. */
function textScore(
  p: WikiListing,
  words: readonly string[],
  labels: Map<string, string>,
): number {
  if (!words.length) return 1;
  const titles = [...new Set([foldText(p.title), foldText(displayTitleOf(p))])];
  const key = p.series ? foldText(p.series.trim()) : "";
  const label = key ? foldText(labels.get(key) ?? "") : "";
  const tags = [...p.tags, ...p.aliases].map(foldText);
  const desc = foldText(p.description ?? "");
  const rel = foldText(p.relPath);
  let total = 0;
  for (const w of words) {
    let s = 0;
    if (/^\d+$/.test(w)) {
      if (titles.some((t) => hasWholeNumber(t, w))) s += FIND_WEIGHTS.titleNumber;
      if (desc && hasWholeNumber(desc, w)) s += FIND_WEIGHTS.description;
    } else {
      if (titles.some((t) => t.includes(w))) s += FIND_WEIGHTS.title;
      if (key && (key.includes(w) || label.includes(w))) s += FIND_WEIGHTS.series;
      if (tags.some((t) => t.includes(w))) s += FIND_WEIGHTS.tag;
      if (desc.includes(w)) s += FIND_WEIGHTS.description;
      if (relPathMatchesQuery(rel, w)) s += FIND_WEIGHTS.relPath;
    }
    if (s === 0) return 0;
    total += s;
  }
  return total;
}

function passesFilters(
  p: WikiListing,
  q: FindQuery,
  labels: Map<string, string>,
  ageDays: number | null,
): boolean {
  if (q.inSeries.length) {
    if (!p.series) return false;
    const key = foldText(p.series.trim());
    const label = foldText(labels.get(key) ?? "");
    if (!q.inSeries.some((v) => key.includes(v) || label.includes(v))) return false;
  }
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
  const empty: FindResult = { rows: [], groups: [], chips: [], total: 0, terms: q.words };
  if (isEmptyQuery(q)) return empty;
  const labels = seriesLabels(pages);
  const near = opts.near ?? {};
  const scored: FindRow[] = [];
  for (const p of pages) {
    if (!inFindPool(p, q.retired)) continue;
    const ms = pageWorkedMs(p, opts.now);
    const ageDays = ms > 0 ? Math.max(0, (opts.now - ms) / DAY_MS) : null;
    if (!passesFilters(p, q, labels, ageDays)) continue;
    const text = textScore(p, q.words, labels);
    if (text === 0) continue;
    const n = near[p.relPath] ?? 0;
    const recency = ageDays === null ? 0 : FIND_RECENCY_WEIGHT * Math.exp(-ageDays / FIND_RECENCY_DAYS);
    const key = p.series ? foldText(p.series.trim()) : "";
    scored.push({
      page: p,
      score: text * (1 + FIND_NEAR_BOOST * n) + recency,
      near: n,
      seriesKey: key,
      seriesLabel: key ? labels.get(key) ?? p.series!.trim() : "",
    });
  }
  scored.sort((a, b) => b.score - a.score || a.page.relPath.localeCompare(b.page.relPath));

  // Chips count every match, before the row cap.
  const chipMap = new Map<string, FindChip>();
  for (const r of scored) {
    if (!r.seriesKey) continue;
    const c = chipMap.get(r.seriesKey);
    if (c) c.count++;
    else {
      chipMap.set(r.seriesKey, {
        seriesKey: r.seriesKey,
        label: r.seriesLabel,
        count: 1,
        token: `in:"${r.page.series!.trim().replace(/"/g, "")}"`,
      });
    }
  }

  const top = scored.slice(0, opts.limit ?? FIND_ROWS_MAX);
  // Group by series, groups in order of their best row. A no-series row is a
  // group of one placed by its own score, so the best match always leads.
  const groups: FindGroup[] = [];
  const byKey = new Map<string, FindGroup>();
  for (const r of top) {
    if (!r.seriesKey) {
      groups.push({ seriesKey: "", seriesLabel: "", rows: [r] });
      continue;
    }
    const g = byKey.get(r.seriesKey);
    if (g) g.rows.push(r);
    else {
      const made = { seriesKey: r.seriesKey, seriesLabel: r.seriesLabel, rows: [r] };
      byKey.set(r.seriesKey, made);
      groups.push(made);
    }
  }
  return {
    rows: groups.flatMap((g) => g.rows),
    groups,
    chips: [...chipMap.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    total: scored.length,
    terms: q.words,
  };
}

/** The query with every `in:` token replaced by `token`. */
export function applySeriesChip(raw: string, token: string): string {
  const rest = tokenize(raw).filter((t) => !/^in:/i.test(t));
  return [...rest, token].join(" ");
}

function escText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Escape `text` and wrap every hit of `terms` in `<mark>` — in ONE pass over
 * the raw text with one combined pattern. Word-by-word replacement over the
 * escaped output corrupts its own markup the moment a later word (`class`,
 * `mark`) matches inside a `<mark class=…>` it inserted.
 *
 * Matching runs on a folded copy with an index map back to the raw text, so
 * `kjoring` marks `Kjøring`. Digit terms match whole numbers only.
 */
export function highlightFind(text: string, terms: readonly string[]): string {
  const usable = [...new Set(terms.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!usable.length || !text) return escText(text);
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
  const alt = usable.map((t) => (/^\d+$/.test(t) ? `(?<!\\d)${t}(?!\\d)` : esc(t))).join("|");
  const re = new RegExp(alt, "g");
  let out = "";
  let at = 0;
  for (let m = re.exec(folded); m; m = re.exec(folded)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const start = from[m.index]!;
    const end = from[m.index + m[0].length - 1]! + 1;
    if (start < at) continue;
    out += escText(text.slice(at, start)) + `<mark>${escText(text.slice(start, end))}</mark>`;
    at = end;
  }
  return out + escText(text.slice(at));
}
