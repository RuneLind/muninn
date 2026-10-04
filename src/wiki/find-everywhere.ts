/**
 * FIND EVERYWHERE — tier 2 of the find palette: one query over every
 * registered wiki through three legs, fused. No model call.
 *
 *  1. **text** — the palette's own ranker (`rankFind`) over each wiki's pages,
 *     free words only, merged across wikis by (words hit, score).
 *  2. **huginn** — one `brief=true` search over the union of the wikis'
 *     collections; a hit resolves to a page through the wiki whose
 *     `collections` hold it. Measured 2026-10-04: default (reranked) search
 *     takes 5–12 s, `brief=true` 50–210 ms with near-identical ranks.
 *  3. **sessions** — claude-usage's session search, joined onto every page
 *     whose `sessions:` frontmatter names a matched session. This is what finds
 *     a page by the words of the sessions that wrote it rather than its own.
 *
 * Fusion is reciprocal rank fusion (k = 60, weight 1 per leg), then HEADS
 * FIRST: every page that is #1 in some leg moves to the top, in fused order.
 * Measured reason: plain RRF dropped "which gate runs count" from #3 to #7,
 * because pages mediocre in two legs outvoted huginn's #1.
 *
 * Every leg is bounded and degrades on its own: a failing or unconfigured leg
 * reports itself in `sources` and never fails the request.
 */

import { freeText, rankFind, type FindRow } from "../dashboard/views/components/wiki-find.ts";
import { displayTitleOf, isMetaStem, pageStemOf, type WikiListing } from "../dashboard/views/components/wiki-filter.ts";
import { bareId, isSessionIdShape } from "./session-refs.ts";
import type { WikiIndex, WikiPageMeta } from "./store.ts";

/** RRF's k — the same constant the session leg's per-page score uses. */
export const FUSE_K = 60;
/** Rows each leg contributes to fusion. */
export const LEG_DEPTH = 30;
export const HUGINN_LIMIT = 15;
export const SESSIONS_LIMIT = 25;
export const HUGINN_TIMEOUT_MS = 3000;
/** One budget for the session search AND its title lookup. */
export const SESSIONS_TIMEOUT_MS = 2000;
export const SNIPPET_MAX = 200;
export const FIND_EVERYWHERE_LIMIT_DEFAULT = 20;
export const FIND_EVERYWHERE_LIMIT_MAX = 50;
/** Shorter queries answer an empty result set without asking any leg. */
export const FIND_EVERYWHERE_MIN_CHARS = 2;

export interface FindEverywhereWiki {
  name: string;
  root: string;
  collections?: readonly string[];
}

/** What the core reads. Each remote seam is `null` when unconfigured. */
export interface FindEverywhereDeps {
  wikis(): readonly FindEverywhereWiki[];
  index(root: string): Promise<WikiIndex | null>;
  /** `GET <knowledge api><path>` parsed as JSON. */
  huginn: ((path: string, signal: AbortSignal) => Promise<unknown>) | null;
  /** `GET <claude-usage><path>` parsed as JSON. */
  claudeUsage: ((path: string, signal: AbortSignal) => Promise<unknown>) | null;
  now(): number;
  huginnTimeoutMs?: number;
  sessionsTimeoutMs?: number;
}

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
  /** #1 in at least one leg. */
  head: boolean;
  legs: {
    text?: { rank: number };
    huginn?: { rank: number; snippet: string };
    sessions?: SessionReason[];
  };
}

export type LegStatus = "ok" | "error" | "unconfigured";

export interface LegReport {
  status: LegStatus;
  ms: number;
  error?: string;
}

export interface FindEverywhereResponse {
  q: string;
  results: FindEverywhereResult[];
  sources: { text: LegReport; huginn: LegReport; sessions: LegReport };
}

/** Clamp the route's `limit` param: default 20, 1..50. */
export function parseFindEverywhereLimit(raw: string | undefined): number {
  const n = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(n)) return FIND_EVERYWHERE_LIMIT_DEFAULT;
  return Math.min(FIND_EVERYWHERE_LIMIT_MAX, Math.max(1, Math.round(n)));
}

interface LoadedWiki {
  wiki: FindEverywhereWiki;
  index: WikiIndex;
}

const pageKey = (wiki: string, relPath: string): string => `${wiki}\u0000${relPath}`;

/** Pages the reader hides by default: bookkeeping pages and retired ones. */
function hidden(meta: WikiPageMeta): boolean {
  return !!meta.culled || isMetaStem(pageStemOf(meta.relPath));
}

/** The index's pages in the listing shape `rankFind` takes, one array per
 *  index build (the ranker memoizes its series labels per array). The two
 *  link counts are the only listing fields the index does not carry, and the
 *  ranker reads neither. */
const listingMemo = new WeakMap<WikiIndex, readonly WikiListing[]>();

function listingOf(index: WikiIndex): readonly WikiListing[] {
  let hit = listingMemo.get(index);
  if (!hit) {
    hit = index.pages.map((m) => ({ ...m, linkCount: 0, backlinkCount: 0 }));
    listingMemo.set(index, hit);
  }
  return hit;
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

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

/** One leg's ordered page keys, plus what each key carries as its reason. */
interface Leg<R> {
  keys: string[];
  reasons: Map<string, R>;
  /** May this leg's #1 be a head? False only for a text #1 in the palette's
   *  partial band (it hit fewer than all the words). */
  headable?: boolean;
}

const emptyLeg = <R>(): Leg<R> => ({ keys: [], reasons: new Map() });

function textLeg(loaded: readonly LoadedWiki[], words: string, now: number): Leg<{ rank: number }> {
  const rows: Array<{ wiki: string; row: FindRow }> = [];
  for (const { wiki, index } of loaded) {
    const pages = listingOf(index);
    for (const row of rankFind(pages, words, { now, limit: LEG_DEPTH }).rows) rows.push({ wiki: wiki.name, row });
  }
  rows.sort(
    (a, b) =>
      b.row.matched - a.row.matched ||
      b.row.score - a.row.score ||
      a.wiki.localeCompare(b.wiki) ||
      a.row.page.relPath.localeCompare(b.row.page.relPath),
  );
  const top = rows.slice(0, LEG_DEPTH);
  const keys = top.map((r) => pageKey(r.wiki, r.row.page.relPath));
  return {
    keys,
    reasons: new Map(keys.map((k, i) => [k, { rank: i + 1 }])),
    headable: top.length > 0 && !top[0]!.row.partial,
  };
}

interface HuginnHit {
  collection?: unknown;
  id?: unknown;
  snippet?: unknown;
}

function huginnLeg(body: unknown, loaded: readonly LoadedWiki[]): Leg<{ rank: number; snippet: string }> {
  const results = (body as { results?: unknown })?.results;
  if (!Array.isArray(results)) throw new Error("huginn answered without a results list");
  const keys: string[] = [];
  const reasons = new Map<string, { rank: number; snippet: string }>();
  for (const hit of results as HuginnHit[]) {
    if (typeof hit?.collection !== "string" || typeof hit.id !== "string") continue;
    for (const { wiki, index } of loaded) {
      if (!wiki.collections?.includes(hit.collection)) continue;
      const meta = index.resolveRelPath(hit.id);
      if (!meta || hidden(meta)) continue;
      const key = pageKey(wiki.name, meta.relPath);
      if (!reasons.has(key)) {
        keys.push(key);
        reasons.set(key, {
          rank: keys.length,
          snippet: clip(flatten(typeof hit.snippet === "string" ? hit.snippet : ""), SNIPPET_MAX).text,
        });
      }
      break;
    }
  }
  return { keys: keys.slice(0, LEG_DEPTH), reasons };
}

interface UsageSession {
  sessionId?: unknown;
  snippet?: unknown;
}

function sessionLeg(body: unknown, loaded: readonly LoadedWiki[]): Leg<SessionReason[]> {
  const sessions = (body as { sessions?: unknown })?.sessions;
  if (!Array.isArray(sessions)) throw new Error("claude-usage answered without a sessions list");
  const score = new Map<string, number>();
  const reasons = new Map<string, SessionReason[]>();
  const byIndex = loaded.map((l) => ({ ...l, map: sessionPages(l.index) }));
  (sessions as UsageSession[]).forEach((s, i) => {
    if (typeof s?.sessionId !== "string") return;
    const id = bareId(s.sessionId);
    const snippet = markedSnippet(typeof s.snippet === "string" ? s.snippet : "");
    for (const { wiki, index, map } of byIndex) {
      for (const rel of map.get(id) ?? []) {
        const meta = index.resolveRelPath(rel);
        if (!meta || hidden(meta)) continue;
        const key = pageKey(wiki.name, meta.relPath);
        const list = reasons.get(key) ?? [];
        if (list.some((r) => r.id === id)) continue;
        list.push({ id, rank: i + 1, snippet });
        reasons.set(key, list);
        score.set(key, (score.get(key) ?? 0) + 1 / (FUSE_K + i));
      }
    }
  });
  const keys = [...score.keys()]
    .sort((a, b) => score.get(b)! - score.get(a)! || a.localeCompare(b))
    .slice(0, LEG_DEPTH);
  return { keys, reasons };
}

/** Fill `title` on every session reason from `/api/sessions-by-id`. Best
 *  effort: a failure leaves the titles off and the leg ok. */
async function addSessionTitles(
  leg: Leg<SessionReason[]>,
  fetchJson: (path: string, signal: AbortSignal) => Promise<unknown>,
  signal: AbortSignal,
): Promise<void> {
  const ids = [...new Set(leg.keys.flatMap((k) => leg.reasons.get(k)!.map((r) => r.id)))];
  if (!ids.length) return;
  try {
    const body = await fetchJson(`/api/sessions-by-id?ids=${ids.map(encodeURIComponent).join(",")}`, signal);
    const rows = (body as { sessions?: unknown })?.sessions;
    if (!Array.isArray(rows)) return;
    const titles = new Map<string, string>();
    for (const r of rows as Array<{ sessionId?: unknown; title?: unknown }>) {
      if (typeof r?.sessionId === "string" && typeof r.title === "string" && r.title.trim()) {
        titles.set(r.sessionId, r.title.trim());
      }
    }
    for (const k of leg.keys) for (const r of leg.reasons.get(k)!) {
      const t = titles.get(r.id);
      if (t) r.title = t;
    }
  } catch {
    // Titles are a tooltip; the chips stand without them.
  }
}

async function timed<T>(
  run: () => Promise<T>,
): Promise<{ value?: T; ms: number; error?: string }> {
  const t0 = performance.now();
  try {
    const value = await run();
    return { value, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    return { ms: Math.round(performance.now() - t0), error: errorText(err) };
  }
}

/**
 * Fuse ordered legs: RRF (k = 60, weight 1), then every leg's #1 moves to the
 * top in fused order. Ties break on the key, so the order is deterministic.
 *
 * A leg with `headable: false` still votes but promotes no head: a text #1
 * that hit only some of the words is the palette's partial band, and a long
 * `status_note` hits `which`/`from`/`count` by substring. Measured on the real
 * wikis: one such plan was text #1 for both "which gate runs count" and "e2e
 * branches from console", and as a head it pushed the target to #4.
 */
export function fuseLegs(
  legs: ReadonlyArray<{ keys: readonly string[]; headable?: boolean }>,
): Array<{ key: string; score: number; head: boolean }> {
  const score = new Map<string, number>();
  const heads = new Set<string>();
  for (const { keys, headable } of legs) {
    keys.forEach((k, i) => score.set(k, (score.get(k) ?? 0) + 1 / (FUSE_K + i)));
    if (keys[0] !== undefined && headable !== false) heads.add(keys[0]);
  }
  const all = [...score.entries()]
    .map(([key, s]) => ({ key, score: s, head: heads.has(key) }))
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  return [...all.filter((r) => r.head), ...all.filter((r) => !r.head)];
}

export async function findEverywhere(
  rawQuery: string,
  limit: number,
  deps: FindEverywhereDeps,
): Promise<FindEverywhereResponse> {
  const q = rawQuery.trim();
  const words = freeText(q);
  const empty = (status: LegStatus): LegReport => ({ status, ms: 0 });
  if (words.length < FIND_EVERYWHERE_MIN_CHARS) {
    return {
      q,
      results: [],
      sources: {
        text: empty("ok"),
        huginn: empty(deps.huginn ? "ok" : "unconfigured"),
        sessions: empty(deps.claudeUsage ? "ok" : "unconfigured"),
      },
    };
  }

  const wikis = deps.wikis();
  // The indexes load once; every leg maps its hits through them, and the two
  // remote searches are already in flight while they load.
  const loadedP: Promise<LoadedWiki[]> = Promise.all(
    wikis.map((w) => deps.index(w.root).catch(() => null)),
  ).then((indexes) => wikis.flatMap((wiki, i) => (indexes[i] ? [{ wiki, index: indexes[i]! }] : [])));

  const textP = timed(async () => textLeg(await loadedP, words, deps.now()));

  const collections = [...new Set(wikis.flatMap((w) => w.collections ?? []))];
  const huginnFetch = deps.huginn;
  const huginnP =
    huginnFetch && collections.length
      ? timed(async () => {
          const params = new URLSearchParams({ q: words, limit: String(HUGINN_LIMIT), brief: "true" });
          for (const c of collections) params.append("collection", c);
          const signal = AbortSignal.timeout(deps.huginnTimeoutMs ?? HUGINN_TIMEOUT_MS);
          const body = await huginnFetch(`/api/search?${params}`, signal);
          return huginnLeg(body, await loadedP);
        })
      : null;

  const usage = deps.claudeUsage;
  const sessionsP = usage
    ? timed(async () => {
        // One budget for the search and the title lookup after it.
        const signal = AbortSignal.timeout(deps.sessionsTimeoutMs ?? SESSIONS_TIMEOUT_MS);
        const body = await usage(`/api/search?q=${encodeURIComponent(words)}&limit=${SESSIONS_LIMIT}`, signal);
        const leg = sessionLeg(body, await loadedP);
        await addSessionTitles(leg, usage, signal);
        return leg;
      })
    : null;

  const [loaded, textRun, huginnRun, sessionsRun] = await Promise.all([loadedP, textP, huginnP, sessionsP]);
  const report = (r: { ms: number; error?: string } | null): LegReport =>
    !r ? { status: "unconfigured", ms: 0 } : r.error ? { status: "error", ms: r.ms, error: r.error } : { status: "ok", ms: r.ms };
  const text = textRun.value ?? emptyLeg<{ rank: number }>();
  const huginn = huginnRun?.value ?? emptyLeg<{ rank: number; snippet: string }>();
  const sessions = sessionsRun?.value ?? emptyLeg<SessionReason[]>();

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
    if (h) legs.huginn = h;
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
    q,
    results,
    sources: { text: report(textRun), huginn: report(huginnRun), sessions: report(sessionsRun) },
  };
}
