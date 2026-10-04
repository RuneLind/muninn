/**
 * FIND EVERYWHERE — tier 2 of the find palette: one query over every
 * registered wiki through three legs, fused. No model call.
 *
 *  1. **text** — the palette's own ranker (`rankFind`, every rule including
 *     `#<digits>`) over each wiki's pages, merged across wikis by (words hit,
 *     score).
 *  2. **huginn** — one `brief=true` search over the union of the wikis'
 *     collections; a hit resolves to a page through the wiki whose
 *     `collections` hold it. Measured 2026-10-04: default (reranked) search
 *     takes 5–12 s, `brief=true` 50–210 ms with near-identical ranks.
 *  3. **sessions** — claude-usage's session search, joined onto every page
 *     whose `sessions:` frontmatter names a matched session. This is what finds
 *     a page by the words of the sessions that wrote it rather than its own.
 *
 * Fusion is reciprocal rank fusion (k = 60, weight 1 per leg), then HEADS
 * FIRST (`fuseLegs`). Measured reason: plain RRF dropped "which gate runs
 * count" from #3 to #7, because pages mediocre in two legs outvoted huginn's #1.
 *
 * Bounds, in order: the wiki indexes load first, under `INDEX_TIMEOUT_MS` (a
 * late wiki answers from its last-good index and is named `stale`; one with
 * none, or that fails, is skipped and named in `sources.indexes`); then
 * the legs start, each under its own timer combined with the caller's abort
 * signal, so no leg's `ms` includes the index wait. The session titles call
 * has its own `TITLES_TIMEOUT_MS` after the search. The query is capped at
 * `QUERY_MAX_CHARS` code points and `QUERY_MAX_WORDS` free words.
 */

import {
  findFreeTokens,
  inFindPool,
  rankFind,
  type FindRow,
} from "../dashboard/views/components/wiki-find.ts";
import { displayTitleOf, type WikiListing } from "../dashboard/views/components/wiki-filter.ts";
import { bareId, isSessionIdShape } from "./session-refs.ts";
import type { WikiIndex, WikiPageMeta } from "./store.ts";

/** RRF's k — the same constant the session leg's per-page score uses. */
export const FUSE_K = 60;
/** Rows each leg contributes to fusion. */
export const LEG_DEPTH = 30;
export const HUGINN_LIMIT = 15;
export const SESSIONS_LIMIT = 25;
/** The whole index load, every wiki in parallel. */
export const INDEX_TIMEOUT_MS = 2500;
export const HUGINN_TIMEOUT_MS = 3000;
/** The session search alone; the titles call has its own budget after it.
 *  claude-usage runs its ingest tick in its HTTP process and stalls (measured
 *  2026-10-04: p50 70 ms, p95 215 ms, ~3 % over 2 s, max 6.8 s); at 2 s, its
 *  own busy_timeout, results flapped during a stall. */
export const SESSIONS_TIMEOUT_MS = 3000;
export const TITLES_TIMEOUT_MS = 400;
/** huginn's answer is read under this cap (`brief=true` at 15 hits is ~10 KB). */
export const HUGINN_MAX_BYTES = 1024 * 1024;
/** A sessions-leg #1 is a head only when its session is this high in claude-usage's answer. */
export const SESSIONS_HEAD_TOP = 5;
export const SNIPPET_MAX = 200;
export const FIND_EVERYWHERE_LIMIT_DEFAULT = 20;
export const FIND_EVERYWHERE_LIMIT_MAX = 50;
/** Shorter free text (code points) answers an empty result set without asking any leg. */
export const FIND_EVERYWHERE_MIN_CHARS = 2;
export const QUERY_MAX_CHARS = 200;
export const QUERY_MAX_WORDS = 12;

export interface FindEverywhereWiki {
  name: string;
  root: string;
  collections?: readonly string[];
}

/** What the core reads. */
export interface FindEverywhereDeps {
  wikis(): readonly FindEverywhereWiki[];
  index(root: string): Promise<WikiIndex | null>;
  /** `GET <knowledge api><path>` parsed as JSON. Throws {@link LegFetchError}
   *  for what it can classify. */
  huginn: (path: string, signal: AbortSignal) => Promise<unknown>;
  /** `GET <claude-usage><path>` parsed as JSON; `null` when `CLAUDE_USAGE_URL` is unset. */
  claudeUsage: ((path: string, signal: AbortSignal) => Promise<unknown>) | null;
  now(): number;
  /** The caller's request signal: an aborted palette fetch cancels every leg. */
  signal?: AbortSignal;
  indexTimeoutMs?: number;
  huginnTimeoutMs?: number;
  sessionsTimeoutMs?: number;
  titlesTimeoutMs?: number;
}

/** A failure the fetch seam could classify: `unreachable` (no answer),
 *  `bad response` (not JSON, over the byte cap) or an HTTP status. */
export class LegFetchError extends Error {
  constructor(
    readonly kind: "unreachable" | "bad response" | "http",
    readonly status?: number,
  ) {
    super(kind === "http" ? `HTTP ${status}` : kind);
    this.name = "LegFetchError";
  }
}

/** An answer that parsed but is not the contract (a wrong service on the port). */
class BadShape extends Error {}

/** A snippet with its match spans as [start, end) offsets — the client
 *  escapes the text and wraps the spans, so no markup crosses the wire. */
export interface MarkedSnippet {
  text: string;
  marks: Array<[number, number]>;
}

export interface SessionReason {
  id: string;
  /** The session's rank in claude-usage's answer, 1-based. */
  rank: number;
  title?: string;
  snippet: MarkedSnippet;
}

export interface FindEverywhereResult {
  wiki: string;
  relPath: string;
  title: string;
  type: string;
  score: number;
  /** A head of at least one leg (see `fuseLegs`). */
  head: boolean;
  legs: {
    text?: { rank: number };
    huginn?: { rank: number; snippet: string };
    sessions?: SessionReason[];
  };
}

export type LegStatus = "ok" | "error" | "unconfigured" | "skipped";

export interface LegReport {
  status: LegStatus;
  ms: number;
  /** `timeout`, `unreachable`, `bad response`, `HTTP <n>`, `aborted` or
   *  `failed`; for `unconfigured` what is missing, for `skipped` why. */
  error?: string;
}

/** The sessions leg's report: `ms` is the search alone, `titles` the
 *  separate title lookup's outcome. */
export interface SessionsLegReport extends LegReport {
  titles?: "ok" | "timeout" | "failed" | "skipped";
}

export interface FindEverywhereResponse {
  /** The query as the legs saw it: capped, filter tokens dropped. */
  q: string;
  results: FindEverywhereResult[];
  sources: {
    query: { truncated: boolean };
    /** Wikis whose index failed or missed `INDEX_TIMEOUT_MS` with no earlier
     *  index to fall back on (`skipped`), and wikis answered from their
     *  last-good index because the rebuild missed the bound (`stale`); `ms`
     *  is the wait. */
    indexes: {
      ms: number;
      skipped: Array<{ wiki: string; error: string }>;
      stale: Array<{ wiki: string; error: string }>;
    };
    text: LegReport;
    huginn: LegReport;
    sessions: SessionsLegReport;
  };
}

/** Clamp the route's `limit` param: default 20, 1..50. */
export function parseFindEverywhereLimit(raw: string | undefined): number {
  const n = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(n)) return FIND_EVERYWHERE_LIMIT_DEFAULT;
  return Math.min(FIND_EVERYWHERE_LIMIT_MAX, Math.max(1, Math.round(n)));
}

/** The capped query: the text leg's form (`#12` stays a number), the remote
 *  legs' form (`#12` is the digits `12`), and whether a cap cut it. */
export function capFindEverywhereQuery(raw: string): { text: string; remote: string; truncated: boolean } {
  const chars = Array.from(raw.trim());
  let truncated = chars.length > QUERY_MAX_CHARS;
  let tokens = findFreeTokens(truncated ? chars.slice(0, QUERY_MAX_CHARS).join("") : chars.join(""));
  if (tokens.length > QUERY_MAX_WORDS) {
    truncated = true;
    tokens = tokens.slice(0, QUERY_MAX_WORDS);
  }
  return {
    text: tokens.map((t) => t.text).join(" "),
    remote: tokens.map((t) => t.remote).join(" "),
    truncated,
  };
}

interface LoadedWiki {
  wiki: FindEverywhereWiki;
  index: WikiIndex;
}

const pageKey = (wiki: string, relPath: string): string => `${wiki}\u0000${relPath}`;

/** Code-unit order. ICU `localeCompare` ignores `\u0000`, so two different
 *  page keys can compare equal there and a tie would fall to sort stability. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The index's pages in the listing shape `rankFind` and `inFindPool` take,
 *  one array per index build (the ranker memoizes its series labels per
 *  array). The two link counts are the only listing fields the index does not
 *  carry, and neither reads them. */
const listingMemo = new WeakMap<WikiIndex, { list: readonly WikiListing[]; byRel: Map<string, WikiListing> }>();

function listingOf(index: WikiIndex): { list: readonly WikiListing[]; byRel: Map<string, WikiListing> } {
  let hit = listingMemo.get(index);
  if (!hit) {
    const list = index.pages.map((m) => ({ ...m, linkCount: 0, backlinkCount: 0 }) as WikiListing);
    hit = { list, byRel: new Map(list.map((p) => [p.relPath, p])) };
    listingMemo.set(index, hit);
  }
  return hit;
}

/** Would the palette list this page at all? Its pool rule: no bookkeeping
 *  page, no attachment child (paired by stem, suffix or link), no retired page. */
function pooled(index: WikiIndex, meta: WikiPageMeta): boolean {
  const p = listingOf(index).byRel.get(meta.relPath);
  return !!p && inFindPool(p, false);
}

/** bare session id → relPaths naming it, built once per index build. */
const sessionMemo = new WeakMap<WikiIndex, { scannedAt: number; map: Map<string, string[]> }>();

export function sessionPages(index: WikiIndex): Map<string, string[]> {
  const hit = sessionMemo.get(index);
  if (hit && hit.scannedAt === index.scannedAt) return hit.map;
  const map = new Map<string, string[]>();
  for (const meta of index.pages) {
    if (!meta.sessions?.length) continue;
    const seen = new Set<string>();
    for (const ref of meta.sessions) {
      const id = bareId(ref.trim());
      if (!isSessionIdShape(id) || seen.has(id)) continue;
      seen.add(id);
      const list = map.get(id);
      if (list) list.push(meta.relPath);
      else map.set(id, [meta.relPath]);
    }
  }
  sessionMemo.set(index, { scannedAt: index.scannedAt, map });
  return map;
}

/** Cut to `max` characters on a code-point boundary, `…` appended; `cut`
 *  is the kept prefix's length in UTF-16 units (what offsets index). */
function clip(text: string, max: number): { text: string; cut: number } {
  const chars = Array.from(text);
  if (chars.length <= max) return { text, cut: text.length };
  const head = chars.slice(0, max).join("");
  return { text: head + "…", cut: head.length };
}

const flatten = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Drop fenced code: each fence pair with what it holds, and an opener the
 *  clip left unclosed with everything after it. */
function dropFences(s: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of s.split("\n")) {
    const m = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (m) fence = m[1]!;
      else out.push(line);
    } else if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length && line.trim() === m[1]) {
      fence = null;
    }
  }
  return out.join("\n");
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** Index just past the construct opened at `from` and closed by `close` at
 *  depth 0 outside quotes (`{` nests when `close` is `}`), or -1 when none
 *  closes it. Quotes and braces inside protect a `>` or `}`. Inside an
 *  expression (`close` is `}`) a quote counts only when the same character
 *  follows it somewhere, so the apostrophe in `{x | x's > 0}` is a letter.
 *  `quotes` false reads every quote as a letter: the second try, for a stray
 *  quote that pairs past the real closer (`{x's} and it's`). */
function skipBalanced(s: string, from: number, close: ">" | "}", quotes = true): number {
  let depth = 0;
  let quote = "";
  for (let i = from; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (ch === quote) quote = "";
    } else if (
      quotes &&
      (ch === '"' || ch === "'" || (ch === "`" && close === "}")) &&
      (close === ">" || s.indexOf(ch, i + 1) !== -1)
    ) {
      quote = ch;
    } else if (ch === "{") depth++;
    else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && close === "}") return i + 1;
    } else if (ch === close && depth === 0) return i + 1;
  }
  return -1;
}

/** `skipBalanced`, then again with quotes read as letters. */
function closerOf(s: string, from: number, close: ">" | "}"): number {
  const end = skipBalanced(s, from, close);
  return end !== -1 ? end : skipBalanced(s, from, close, false);
}

const TAG_NAME = String.raw`[A-Za-z][\w.:-]*`;
const ATTR_NAME = String.raw`[A-Za-z_:@][\w.:-]*`;
const ATTR_VALUE = String.raw`"[^"]*"|'[^']*'|\{[^{}]*\}|[^\s"'=<>\x60{}]+`;
/** An unclosed tag the clip cut: a name, finished attributes, then at most
 *  one attribute cut mid-value. */
const CUT_TAG = new RegExp(
  String.raw`^<[/!]?${TAG_NAME}(?:\s+(?:${ATTR_NAME}(?:\s*=\s*(?:${ATTR_VALUE}))?|\{[^{}]*\}))*` +
    String.raw`(?:\s+(?:${ATTR_NAME}\s*=\s*(?:"[^"]*|'[^']*|\{[\s\S]*)?|\{[\s\S]*))?\s*/?$`,
);

/** Is `tail` (a `<` to the end of the text) a tag the clip cut off, rather
 *  than a `<` in prose? It reads as a tag to the very end and says so: a bare
 *  name, or an `=` or `{`. `n <k the loop ends…` is prose. */
function isCutTag(tail: string): boolean {
  if (!CUT_TAG.test(tail)) return false;
  return /^<[/!]?\S*\s*$/.test(tail) || /[={]/.test(tail);
}

/**
 * One left-to-right pass over inline markup: `<!-- … -->`, MDX/HTML tags
 * (attributes may hold `>` inside quotes or braces) and `{…}` expressions out,
 * inline code kept without its backticks. A `<` opens a tag when `/` or `!`
 * follows it, or a letter does and no word character precedes it — so
 * `x<y and z>w` stays prose. A construct with no closer ends the snippet only
 * when it reads as cut off: a comment, a tag to the end (`isCutTag`), a `{`
 * before a non-space. Otherwise its `<` or `{` is prose.
 */
function stripInlineMarkup(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; ) {
    const ch = s[i]!;
    if (ch === "`") {
      let n = 1;
      while (s[i + n] === "`") n++;
      const run = "`".repeat(n);
      const end = s.indexOf(run, i + n);
      if (end === -1) {
        i += n;
      } else {
        out += s.slice(i + n, end);
        i = end + n;
      }
      continue;
    }
    if (ch === "<" && s.startsWith("<!--", i)) {
      const end = s.indexOf("-->", i + 4);
      if (end === -1) break;
      out += " ";
      i = end + 3;
      continue;
    }
    const next = s[i + 1] ?? "";
    const opensTag = /[A-Za-z]/.test(next) ? !(i > 0 && WORD_CHAR.test(s[i - 1]!)) : next === "/" || next === "!";
    if (ch === "<" && opensTag) {
      const end = closerOf(s, i + 1, ">");
      if (end !== -1) {
        out += " ";
        i = end;
        continue;
      }
      // Unclosed: a tag the clip cut off ends the snippet; else `<` is prose.
      if (isCutTag(s.slice(i))) break;
    }
    if (ch === "{") {
      const end = closerOf(s, i, "}");
      if (end !== -1) {
        out += " ";
        i = end;
        continue;
      }
      // Unclosed: `{expr` the clip cut off ends the snippet; a `{` before
      // white space (`Use { to open a block`) is prose.
      if (!/\s/.test(s[i + 1] ?? "")) break;
    }
    out += ch;
    i++;
  }
  return out;
}

/** One line of block markdown reduced to its text. */
function flattenBlockLine(line: string): string {
  let l = line.replace(/^[ \t]*(?:>[ \t]?)+/, "");
  l = l.replace(/^[ \t]*\[![\w-]+\][+-]?[ \t]*/, "");
  l = l.replace(/^[ \t]*#{1,6}[ \t]+/, "");
  l = l.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/, "");
  l = l.replace(/^\[[ xX]\][ \t]+/, "");
  const t = l.trim();
  if (t.startsWith("|")) {
    if (/^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?$/.test(t)) return "";
    return t
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean)
      .join(" · ");
  }
  return l;
}

const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&amp;": "&" };

/**
 * huginn's snippet as plain text, before the clip. huginn cuts a chunk
 * mid-markup, so every construct may arrive unterminated. Out: the breadcrumb
 * (a leading `tags: …` line and heading line), fenced code, comments, MDX/HTML
 * tags, `{…}` expressions. Flattened: headings, list bullets and checkboxes,
 * table rows (cells joined by ` · `, separator rows dropped), blockquotes and
 * `> [!type]` markers, inline code, `[[target|label]]`, `[label](url)`,
 * `![alt](src)`, emphasis at word boundaries (`__init__` stays). An unclosed
 * `[[` or `[` keeps its text. Five entities are decoded last.
 */
export function plainSnippet(raw: string): string {
  let s = raw.replace(/\r\n?/g, "\n");
  s = s.replace(/^\s*tags:[^\n]*(\n|$)/i, "");
  s = s.replace(/^[ \t]*#{1,6}[ \t]+[^\n]*(\n|$)/, "");
  s = dropFences(s);
  s = stripInlineMarkup(s);
  s = s.split("\n").map(flattenBlockLine).join("\n");
  s = s.replace(/!\[([^\]\n]*)\]\([^)\n]*\)?/g, "$1");
  s = s.replace(/\[\[([^\]|\n]*)\|([^\]\n]*)\]\]/g, "$2").replace(/\[\[([^\]\n]*)\]\]/g, "$1");
  s = s.replace(/\[\[(?:[^\]|\n]*\|)?/g, "");
  s = s.replace(/\[([^\]\n]*)\]\([^)\n]*\)?/g, "$1");
  s = s.replace(/\[(?![^\]\n]*\])/g, "");
  s = s.replace(/\*\*|~~/g, "");
  // Strong `__…__` only around more than one identifier word: `__init__` is a name.
  s = s.replace(/(^|[^\w])__(\S(?:[^\n]*?\S)?)__(?!\w)/g, (m, pre: string, inner: string) =>
    /^\w+$/.test(inner) ? m : pre + inner,
  );
  s = s.replace(/(^|[^\w*])[*_]([^*_\n]+?)[*_](?=[^\w*]|$)/g, "$1$2");
  s = s.replace(/&(?:lt|gt|quot|#39|amp);/g, (e) => ENTITIES[e]!);
  return clip(flatten(s), SNIPPET_MAX).text;
}

/** claude-usage marks hits `\u0002…\u0003`; turn them into offsets into the
 *  text the client receives (markers out, whitespace collapsed, trimmed). */
export function markedSnippet(raw: string): MarkedSnippet {
  let plain = "";
  const marks: Array<[number, number]> = [];
  let open = -1;
  for (const ch of raw.replace(/\s+/g, " ")) {
    if (ch === "\u0002") open = plain.length;
    else if (ch === "\u0003") {
      if (open >= 0 && plain.length > open) marks.push([open, plain.length]);
      open = -1;
    } else if (ch !== " " || (plain !== "" && !plain.endsWith(" "))) plain += ch;
  }
  plain = plain.trimEnd();
  const { text, cut } = clip(plain, SNIPPET_MAX);
  return {
    text,
    marks: marks
      .map(([a, b]) => [a, Math.min(b, cut)] as [number, number])
      .filter(([a, b]) => b > a),
  };
}

/** One leg's ordered page keys, what each key carries as its reason, and the
 *  keys this leg promotes to head. */
interface Leg<R> {
  keys: string[];
  reasons: Map<string, R>;
  heads: string[];
}

const emptyLeg = <R>(): Leg<R> => ({ keys: [], reasons: new Map(), heads: [] });

/** The leading keys whose tie value equals the first key's — the leg's #1 and
 *  every page tied with it — filtered by `eligible`. */
function tiedHeads(keys: readonly string[], tie: (k: string) => unknown, eligible: (k: string) => boolean): string[] {
  if (!keys.length) return [];
  const top = tie(keys[0]!);
  const out: string[] = [];
  for (const k of keys) {
    if (tie(k) !== top) break;
    if (eligible(k)) out.push(k);
  }
  return out;
}

function textLeg(loaded: readonly LoadedWiki[], query: string, now: number): Leg<{ rank: number }> {
  const rows: Array<{ wiki: string; row: FindRow }> = [];
  for (const { wiki, index } of loaded) {
    for (const row of rankFind(listingOf(index).list, query, { now, limit: LEG_DEPTH }).rows) rows.push({ wiki: wiki.name, row });
  }
  rows.sort(
    (a, b) =>
      b.row.matched - a.row.matched ||
      b.row.score - a.row.score ||
      byCodeUnit(a.wiki, b.wiki) ||
      byCodeUnit(a.row.page.relPath, b.row.page.relPath),
  );
  const top = rows.slice(0, LEG_DEPTH);
  const keys = top.map((r) => pageKey(r.wiki, r.row.page.relPath));
  const byKey = new Map(top.map((r, i) => [keys[i]!, r.row]));
  return {
    keys,
    reasons: new Map(keys.map((k, i) => [k, { rank: i + 1 }])),
    // A partial-band #1 (it hit only some of the words) is no head.
    heads: tiedHeads(keys, (k) => `${byKey.get(k)!.matched}\u0000${byKey.get(k)!.score}`, (k) => !byKey.get(k)!.partial),
  };
}

interface HuginnHit {
  collection?: unknown;
  id?: unknown;
  snippet?: unknown;
  relevance?: unknown;
}

function huginnLeg(body: unknown, loaded: readonly LoadedWiki[]): Leg<{ rank: number; snippet: string }> {
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) throw new BadShape("huginn answered without a results list");
  const keys: string[] = [];
  const reasons = new Map<string, { rank: number; snippet: string }>();
  const relevance = new Map<string, unknown>();
  for (const hit of results as HuginnHit[]) {
    if (typeof hit?.collection !== "string" || typeof hit.id !== "string") continue;
    for (const { wiki, index } of loaded) {
      if (!wiki.collections?.includes(hit.collection)) continue;
      const meta = index.resolveRelPath(hit.id);
      if (!meta) continue;
      // The first wiki that resolves the id decides: a page it hides is
      // dropped, never looked up in another wiki at the same relPath.
      if (pooled(index, meta)) {
        const key = pageKey(wiki.name, meta.relPath);
        if (!reasons.has(key)) {
          keys.push(key);
          reasons.set(key, {
            rank: keys.length,
            snippet: plainSnippet(typeof hit.snippet === "string" ? hit.snippet : ""),
          });
          relevance.set(key, typeof hit.relevance === "number" ? hit.relevance : Symbol());
        }
      }
      break;
    }
  }
  const top = keys.slice(0, LEG_DEPTH);
  // Candidates only: `agreedHuginnHeads` keeps the ones another leg also found.
  return { keys: top, reasons, heads: tiedHeads(top, (k) => relevance.get(k), () => true) };
}

/** A huginn #1 (or a page tied with it) leads only when the text leg or the
 *  sessions leg also returned it, at any rank; otherwise it only votes.
 *  `brief=true` relevance is rank-derived, so nonsense gets a confident #1,
 *  and two rounds of a lexical-evidence word list still leaked function words. */
export function agreedHuginnHeads(
  huginnHeads: readonly string[],
  others: ReadonlyArray<{ keys: readonly string[] }>,
): string[] {
  const seen = new Set(others.flatMap((l) => l.keys));
  return huginnHeads.filter((k) => seen.has(k));
}

interface UsageSession {
  sessionId?: unknown;
  snippet?: unknown;
}

function sessionLeg(body: unknown, loaded: readonly LoadedWiki[]): Leg<SessionReason[]> {
  const sessions = (body as { sessions?: unknown } | null)?.sessions;
  if (!Array.isArray(sessions)) throw new BadShape("claude-usage answered without a sessions list");
  const score = new Map<string, number>();
  const reasons = new Map<string, SessionReason[]>();
  const byIndex = loaded.map((l) => ({ ...l, map: sessionPages(l.index) }));
  // Ranks count well-formed rows only: a malformed row shifts neither a later
  // session's rank nor the top-5 head gate.
  let i = -1;
  for (const s of sessions as UsageSession[]) {
    if (typeof s?.sessionId !== "string") continue;
    const id = bareId(s.sessionId.trim());
    if (!isSessionIdShape(id)) continue;
    i++;
    const snippet = markedSnippet(typeof s.snippet === "string" ? s.snippet : "");
    for (const { wiki, index, map } of byIndex) {
      for (const rel of map.get(id) ?? []) {
        const meta = index.resolveRelPath(rel);
        if (!meta || !pooled(index, meta)) continue;
        const key = pageKey(wiki.name, meta.relPath);
        const list = reasons.get(key) ?? [];
        if (list.some((r) => r.id === id)) continue;
        list.push({ id, rank: i + 1, snippet });
        reasons.set(key, list);
        score.set(key, (score.get(key) ?? 0) + 1 / (FUSE_K + i));
      }
    }
  }
  const keys = [...score.keys()]
    .sort((a, b) => score.get(b)! - score.get(a)! || byCodeUnit(a, b))
    .slice(0, LEG_DEPTH);
  // Session search ranks loosely: a page carried only by a session far down
  // claude-usage's answer is a vote, never a head.
  const heads = tiedHeads(
    keys,
    (k) => score.get(k),
    (k) => Math.min(...reasons.get(k)!.map((r) => r.rank)) <= SESSIONS_HEAD_TOP,
  );
  return { keys, reasons, heads };
}

/** Fill `title` on every session reason from `/api/sessions-by-id`. Best
 *  effort under its own budget: a failure or a late answer leaves the titles
 *  off and the leg ok; the outcome is reported beside the leg. */
async function addSessionTitles(
  leg: Leg<SessionReason[]>,
  fetchJson: (path: string, signal: AbortSignal) => Promise<unknown>,
  timeoutMs: number,
  outer: AbortSignal | undefined,
): Promise<NonNullable<SessionsLegReport["titles"]>> {
  const ids = [...new Set(leg.keys.flatMap((k) => leg.reasons.get(k)!.map((r) => r.id)))];
  if (!ids.length) return "skipped";
  const { signal, timeout } = legSignal(timeoutMs, outer);
  try {
    // Ids are shape-checked (`isSessionIdShape`), so encoding cannot throw.
    const body = await raceSignal(
      fetchJson(`/api/sessions-by-id?ids=${ids.map(encodeURIComponent).join(",")}`, signal),
      signal,
    );
    const rows = (body as { sessions?: unknown } | null)?.sessions;
    if (!Array.isArray(rows)) return "failed";
    const titles = new Map<string, string>();
    for (const r of rows as Array<{ sessionId?: unknown; title?: unknown }>) {
      if (typeof r?.sessionId === "string" && typeof r.title === "string" && r.title.trim()) {
        titles.set(bareId(r.sessionId), r.title.trim());
      }
    }
    for (const k of leg.keys) for (const r of leg.reasons.get(k)!) {
      const t = titles.get(r.id);
      if (t) r.title = t;
    }
    return "ok";
  } catch {
    // Titles are a tooltip; the chips stand without them.
    return timeout?.aborted && !outer?.aborted ? "timeout" : "failed";
  }
}

/** A leg's own deadline combined with the caller's abort; `ms` null ⇒ no
 *  deadline (the text leg runs in process and returns synchronously). */
function legSignal(ms: number | null, outer: AbortSignal | undefined): { signal: AbortSignal; timeout: AbortSignal | null } {
  const timeout = ms === null ? null : AbortSignal.timeout(ms);
  const parts = [outer, timeout].filter((s): s is AbortSignal => !!s);
  return { signal: parts.length === 1 ? parts[0]! : AbortSignal.any(parts), timeout };
}

/** Settle with `p`, or reject as soon as `signal` aborts — a seam that ignores
 *  its signal still cannot hold a leg past its budget. */
function raceSignal<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** The honest label for a failed leg. */
function errorLabel(err: unknown, timeout: AbortSignal | null, outer: AbortSignal | undefined): string {
  if (outer?.aborted) return "aborted";
  if (timeout?.aborted) return "timeout";
  if (err instanceof LegFetchError) return err.message;
  if (err instanceof BadShape) return "bad response";
  return "failed";
}

async function runLeg<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number | null,
  outer: AbortSignal | undefined,
): Promise<{ value?: T; report: LegReport }> {
  const t0 = performance.now();
  const { signal, timeout } = legSignal(ms, outer);
  try {
    const value = await raceSignal(run(signal), signal);
    return { value, report: { status: "ok", ms: Math.round(performance.now() - t0) } };
  } catch (err) {
    return {
      report: { status: "error", ms: Math.round(performance.now() - t0), error: errorLabel(err, timeout, outer) },
    };
  }
}

/**
 * The last index each root answered with. After the store's 5-minute TTL every
 * expired wiki rebuilds at once (measured 1.85–1.97 s for 5 wikis against the
 * 2.5 s bound), so a modest slowdown would skip them all; a late wiki answers
 * from here instead, and the rebuild it started still lands here when done.
 */
const lastGoodIndex = new Map<string, WikiIndex>();

/** Test seam: forget every last-good index. */
export function __resetFindEverywhereIndexesForTest(): void {
  lastGoodIndex.clear();
}

/** Load every wiki's index in parallel under ONE bound. A wiki that misses
 *  the bound answers from its last-good index (`stale`); one with none, or
 *  whose load fails, is skipped. */
async function loadIndexes(
  wikis: readonly FindEverywhereWiki[],
  deps: FindEverywhereDeps,
): Promise<{
  loaded: LoadedWiki[];
  skipped: Array<{ wiki: string; error: string }>;
  stale: Array<{ wiki: string; error: string }>;
  ms: number;
}> {
  const t0 = performance.now();
  const { signal } = legSignal(deps.indexTimeoutMs ?? INDEX_TIMEOUT_MS, deps.signal);
  type Outcome = LoadedWiki | { wiki: string; error: string; stale?: WikiIndex };
  const outcomes = await Promise.all(
    wikis.map(async (wiki): Promise<Outcome> => {
      const pending = Promise.resolve()
        .then(() => deps.index(wiki.root))
        .then((index) => {
          if (index) lastGoodIndex.set(wiki.root, index);
          return index;
        });
      pending.catch(() => {});
      try {
        const index = await raceSignal(pending, signal);
        return index ? { wiki, index } : { wiki: wiki.name, error: "failed" };
      } catch {
        if (!signal.aborted) return { wiki: wiki.name, error: "failed" };
        if (deps.signal?.aborted) return { wiki: wiki.name, error: "aborted" };
        return { wiki: wiki.name, error: "timeout", stale: lastGoodIndex.get(wiki.root) };
      }
    }),
  );
  const loaded: LoadedWiki[] = [];
  const skipped: Array<{ wiki: string; error: string }> = [];
  const stale: Array<{ wiki: string; error: string }> = [];
  wikis.forEach((wiki, i) => {
    const o = outcomes[i]!;
    if ("index" in o) loaded.push(o);
    else if (o.stale) {
      loaded.push({ wiki, index: o.stale });
      stale.push({ wiki: o.wiki, error: o.error });
    } else skipped.push({ wiki: o.wiki, error: o.error });
  });
  return { loaded, skipped, stale, ms: Math.round(performance.now() - t0) };
}

/**
 * Fuse ordered legs: RRF (k = 60, weight 1), then every leg's HEADS move to the
 * top in fused order. Ties break on the key, so the order is deterministic.
 *
 * Heads: the text leg's #1 when it is a full-band row (a partial #1 hit only
 * some words — a long `status_note` hits `which`/`from`/`count` by substring,
 * and measured on the real wikis one such plan, as a head, pushed the target
 * to #4); huginn's #1 only when the text or sessions leg also returned it
 * (`agreedHuginnHeads`); the sessions leg's #1 only when its session is in
 * claude-usage's top `SESSIONS_HEAD_TOP`. A page tied with a head on that
 * leg's own score is a head too — a tie is never split by spelling.
 */
export function fuseLegs(
  legs: ReadonlyArray<{ keys: readonly string[]; heads?: readonly string[] }>,
): Array<{ key: string; score: number; head: boolean }> {
  const score = new Map<string, number>();
  const heads = new Set<string>();
  for (const { keys, heads: h } of legs) {
    keys.forEach((k, i) => score.set(k, (score.get(k) ?? 0) + 1 / (FUSE_K + i)));
    for (const k of h ?? []) heads.add(k);
  }
  const all = [...score.entries()]
    .map(([key, s]) => ({ key, score: s, head: heads.has(key) }))
    .sort((a, b) => b.score - a.score || byCodeUnit(a.key, b.key));
  return [...all.filter((r) => r.head), ...all.filter((r) => !r.head)];
}

export async function findEverywhere(
  rawQuery: string,
  limit: number,
  deps: FindEverywhereDeps,
): Promise<FindEverywhereResponse> {
  const query = capFindEverywhereQuery(rawQuery);
  const outer = deps.signal;
  const unconfiguredUsage: LegReport = { status: "unconfigured", ms: 0, error: "CLAUDE_USAGE_URL unset" };
  const tooShort: LegReport = { status: "skipped", ms: 0, error: "query too short" };
  const empty = (indexes: FindEverywhereResponse["sources"]["indexes"], legs: Pick<FindEverywhereResponse["sources"], "text" | "huginn" | "sessions">): FindEverywhereResponse => ({
    q: query.text,
    results: [],
    sources: { query: { truncated: query.truncated }, indexes, ...legs },
  });
  // The text form decides: `#5` is a hard number to the text leg even though
  // its remote form `5` is too short to send anywhere.
  if (Array.from(query.text).length < FIND_EVERYWHERE_MIN_CHARS) {
    return empty({ ms: 0, skipped: [], stale: [] }, { text: tooShort, huginn: tooShort, sessions: tooShort });
  }
  const remoteTooShort = Array.from(query.remote).length < FIND_EVERYWHERE_MIN_CHARS;

  // The indexes load BEFORE any leg's timer starts: every leg maps its hits
  // through them, and a slow index build must not eat a remote leg's budget.
  const wikis = deps.wikis();
  const indexes = await loadIndexes(wikis, deps);
  const { loaded } = indexes;
  const indexReport = { ms: indexes.ms, skipped: indexes.skipped, stale: indexes.stale };
  if (outer?.aborted) {
    const aborted: LegReport = { status: "error", ms: 0, error: "aborted" };
    return empty(indexReport, { text: aborted, huginn: aborted, sessions: aborted });
  }

  const textP = runLeg(async () => textLeg(loaded, query.text, deps.now()), null, outer);

  const collections = [...new Set(loaded.flatMap((l) => l.wiki.collections ?? []))];
  const huginnP: Promise<{ value?: Leg<{ rank: number; snippet: string }>; report: LegReport }> = remoteTooShort
    ? Promise.resolve({ report: tooShort })
    : collections.length
      ? runLeg(
          async (signal) => {
            const params = new URLSearchParams({ q: query.remote, limit: String(HUGINN_LIMIT), brief: "true" });
            for (const c of collections) params.append("collection", c);
            return huginnLeg(await deps.huginn(`/api/search?${params}`, signal), loaded);
          },
          deps.huginnTimeoutMs ?? HUGINN_TIMEOUT_MS,
          outer,
        )
      : Promise.resolve({
          report: wikis.some((w) => w.collections?.length)
            ? { status: "skipped", ms: 0, error: "no wiki index loaded" }
            : { status: "unconfigured", ms: 0, error: "no wiki collections" },
        });

  const usage = deps.claudeUsage;
  const sessionsP: Promise<{ value?: Leg<SessionReason[]>; report: SessionsLegReport }> = !usage
    ? Promise.resolve({ report: unconfiguredUsage })
    : remoteTooShort
      ? Promise.resolve({ report: tooShort })
      : (async () => {
          const params = new URLSearchParams({ q: query.remote, limit: String(SESSIONS_LIMIT) });
          const run: { value?: Leg<SessionReason[]>; report: SessionsLegReport } = await runLeg(
            async (signal) => sessionLeg(await usage(`/api/search?${params}`, signal), loaded),
            deps.sessionsTimeoutMs ?? SESSIONS_TIMEOUT_MS,
            outer,
          );
          // The titles call is reported on its own; the leg's `ms` stays the search.
          if (run.value) run.report.titles = await addSessionTitles(run.value, usage, deps.titlesTimeoutMs ?? TITLES_TIMEOUT_MS, outer);
          return run;
        })();

  const [textRun, huginnRun, sessionsRun] = await Promise.all([textP, huginnP, sessionsP]);
  const text = textRun.value ?? emptyLeg<{ rank: number }>();
  const huginn = huginnRun.value ?? emptyLeg<{ rank: number; snippet: string }>();
  const sessions = sessionsRun.value ?? emptyLeg<SessionReason[]>();
  huginn.heads = agreedHuginnHeads(huginn.heads, [text, sessions]);

  const metaOf = new Map<string, { wiki: string; meta: WikiPageMeta }>();
  for (const { wiki, index } of loaded) {
    for (const meta of index.pages) metaOf.set(pageKey(wiki.name, meta.relPath), { wiki: wiki.name, meta });
  }

  const results: FindEverywhereResult[] = [];
  for (const f of fuseLegs([text, huginn, sessions])) {
    if (results.length >= limit) break;
    const hit = metaOf.get(f.key);
    if (!hit) continue;
    const legs: FindEverywhereResult["legs"] = {};
    const t = text.reasons.get(f.key);
    if (t) legs.text = t;
    const h = huginn.reasons.get(f.key);
    if (h && huginn.keys.includes(f.key)) legs.huginn = h;
    const s = sessions.reasons.get(f.key);
    if (s && sessions.keys.includes(f.key)) legs.sessions = s;
    results.push({
      wiki: hit.wiki,
      relPath: hit.meta.relPath,
      title: displayTitleOf(hit.meta),
      type: hit.meta.type,
      score: Number(f.score.toFixed(5)),
      head: f.head,
      legs,
    });
  }
  return {
    q: query.text,
    results,
    sources: {
      query: { truncated: query.truncated },
      indexes: indexReport,
      text: textRun.report,
      huginn: huginnRun.report,
      sessions: sessionsRun.report,
    },
  };
}
