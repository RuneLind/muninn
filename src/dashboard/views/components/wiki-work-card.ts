/**
 * The Your work card (plan `muninn-wiki-work-map`, P2): the start view's card
 * over a wiki's `.work-map.json`, in What's new's slot. Pure and DOM-free —
 * the fetch, the ↻ poll and the click handling live in `wiki-start-cards.ts`.
 *
 * Every string in the map is model output, so all of it is escaped, and a
 * `⟦relPath⟧` marker links only to a page the live listing holds (the map is
 * joined through `joinWorkMap` first, so a page renamed since the run drops out
 * of its effort and its marker reads as plain text).
 */

import {
  isThemeMap,
  joinWorkMap,
  type AnyWorkMap,
  type JoinablePage,
  type JoinedAnyMap,
  type JoinedEffort,
  type JoinedTheme,
  type JoinedThemeMap,
  type JoinedWorkMap,
} from "../../../wiki/work-map/join.ts";
import { osloDay } from "../../../wiki/work-map/ids.ts";
import type { ThemeMap, ThemeWeek } from "../../../wiki/work-map/theme-schema.ts";
import { normalizeRelPath } from "../../../wiki/rel-path.ts";
import { escHtml as esc } from "./escape.ts";

/** Past this age the card marks the map stale (the loop runs daily). */
export const WORK_MAP_STALE_MS = 26 * 3_600_000;
/** Page links shown per effort before `+N more`. */
export const EFFORT_PAGES_SHOWN = 6;

export interface WorkMapAttempt {
  at: number;
  outcome: "ok" | "refused" | "failed";
  error?: string;
}

/** `GET /api/wiki/work-map`'s body (`routes/wiki-work-map.ts`). */
export interface WorkMapGetBody {
  wiki?: string;
  /** Either kind: a themes map carries `kind: "themes"`. */
  map: AnyWorkMap | null;
  mapError?: string;
  organizable: boolean;
  organizableReason?: string;
  lastAttempt?: WorkMapAttempt;
  lastSuccessAt?: number;
  running?: { startedAt: number };
}

/** Just the listing fields the card reads: the title, and what `joinWorkMap`
 *  reads to place a page declared after the run (P6). */
export interface CardPage extends JoinablePage {
  relPath: string;
  title: string;
  displayTitle?: string;
}

/** What the ↻ control is doing, held by the DOM half. */
export type RefreshView =
  | { phase: "idle" }
  | { phase: "running"; startedAt: number }
  | { phase: "message"; text: string; tone: "info" | "warn" };

export interface WorkCardInput<P extends CardPage> {
  body: WorkMapGetBody & { map: AnyWorkMap };
  pages: readonly P[];
  now: number;
  /** Needs-you keys marked done for this run. */
  done: ReadonlySet<string>;
  /** Needs-you keys whose clamped why the reader opened. */
  openWhy?: ReadonlySet<string>;
  hrefFor(relPath: string): string;
  /** The reader URL of an effort page; absent, effort names render as text. */
  effortHref?(id: string): string;
  refresh: RefreshView;
}

/** "just now" / "N min ago" / "N h ago" / "N d ago". */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export function isWorkMapStale(runAtMs: number, now: number): boolean {
  return now - runAtMs > WORK_MAP_STALE_MS;
}

/** A Needs-you item's dismiss key: the stored item's kind and title. */
export function needKey(n: { kind: string; title: string }): string {
  return `${n.kind}|${n.title}`;
}

/** The map's Needs-you items for effort `id`: index into `needsYou` and key. */
export function effortNeedItems(needsYou: readonly { kind: string; title: string; effort?: string }[], id: string): { i: number; key: string }[] {
  return needsYou.flatMap((n, i) => (n.effort === id ? [{ i, key: needKey(n) }] : []));
}

/** The items not ✓ on the card. The effort page's Needs you and the rail's ✋
 *  both count through this and {@link effortNeedItems}. */
export function openNeeds<T extends { key: string }>(items: readonly T[], done: ReadonlySet<string>): T[] {
  return items.filter(({ key }) => !done.has(key));
}

// ── Done store (per wiki, keyed by run time) ──────────────────────────
export const WORK_MAP_DONE_KEY_PREFIX = "muninn.wiki.workMapDone.v1:";

/** The done set stored for `runAt`; a set stored for another run is empty, so
 *  the next run starts clean. */
export function parseDone(raw: string | null, runAt: number): Set<string> {
  if (!raw) return new Set();
  try {
    const v = JSON.parse(raw) as { runAt?: unknown; items?: unknown };
    if (v.runAt !== runAt || !Array.isArray(v.items)) return new Set();
    return new Set(v.items.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

/** The stored value after marking `key` done (`on`) or not, for `runAt`. */
export function writeDone(raw: string | null, runAt: number, key: string, on: boolean): string {
  const set = parseDone(raw, runAt);
  if (on) set.add(key);
  else set.delete(key);
  return JSON.stringify({ runAt, items: [...set] });
}

// ── Prose with page markers ───────────────────────────────────────────
/** Escape `text`, turning each `⟦relPath⟧` marker into a link to that page
 *  when the listing holds it, else into its file stem as plain text. Two
 *  markers with only whitespace between them get a ` · ` separator, so two
 *  titles never read as one. */
export function proseHtml(text: string, byKey: ReadonlyMap<string, CardPage>, hrefFor: (rel: string) => string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(/⟦([^⟧]+)⟧/g)) {
    const gap = text.slice(last, m.index);
    out += last > 0 && gap.trim() === "" ? '<span class="wiki-wm-sep"> · </span>' : esc(gap);
    out += pageLinkHtml(m[1]!, byKey, hrefFor);
    last = m.index! + m[0].length;
  }
  return out + esc(text.slice(last));
}

/** `text` as plain text, each marker read as its page title, with the same
 *  ` · ` between back-to-back markers as {@link proseHtml}: prose the card
 *  clamps (a `title=` value) and the rail's effort summary. */
export function proseText(text: string, byKey: ReadonlyMap<string, CardPage>): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(/⟦([^⟧]+)⟧/g)) {
    const gap = text.slice(last, m.index);
    out += last > 0 && gap.trim() === "" ? " · " : gap;
    const page = byKey.get(normalizeRelPath(m[1]!));
    out += page ? pageTitle(page) : stemOf(m[1]!);
    last = m.index! + m[0].length;
  }
  return out + text.slice(last);
}

function pageTitle(page: CardPage): string {
  return page.displayTitle || page.title || stemOf(page.relPath);
}

function pageLinkHtml(rel: string, byKey: ReadonlyMap<string, CardPage>, hrefFor: (rel: string) => string): string {
  const page = byKey.get(normalizeRelPath(rel));
  if (!page) return esc(stemOf(rel));
  const title = pageTitle(page);
  return `<a class="wiki-wm-link" href="${esc(hrefFor(page.relPath))}" data-relpath="${esc(page.relPath)}">${esc(title)}</a>`;
}

function citedIn(text: string): Set<string> {
  return new Set([...text.matchAll(/⟦([^⟧]+)⟧/g)].map((m) => normalizeRelPath(m[1]!)));
}

function stemOf(rel: string): string {
  return (rel.split("/").pop() || rel).replace(/\.[^.]+$/, "");
}

// ── Lanes ─────────────────────────────────────────────────────────────
export const WORK_MAP_LANES = [
  { id: "moving", label: "Moving", states: ["active", "blocked", "proposed"], open: true },
  { id: "cooling", label: "Cooling", states: ["cooling"], open: false },
  { id: "quiet", label: "Quiet and shipped", states: ["quiet", "shipped"], open: false },
] as const;

const MOVING_STATES: readonly string[] = WORK_MAP_LANES[0].states;

/** True when `e` renders under its parent: nested, and not a Moving effort
 *  whose parent's own state is a closed-lane one (cooling, quiet, shipped),
 *  wherever that parent renders; that one renders in Moving instead. */
export function rendersUnderParent(e: { id: string; parent?: string; state: string }, efforts: readonly { id: string; parent?: string; state: string }[]): boolean {
  if (!isNestedEffort(e, efforts)) return false;
  const parent = efforts.findLast((x) => x.id === e.parent);
  return !(MOVING_STATES.includes(e.state) && parent && !MOVING_STATES.includes(parent.state));
}

/** Top-level efforts per lane, map order. A sub-effort renders under its
 *  parent, except a Moving one under a closed-lane parent, which is top-level
 *  in Moving. */
export function laneEfforts<P>(efforts: readonly JoinedEffort<P>[]): { lane: (typeof WORK_MAP_LANES)[number]; efforts: JoinedEffort<P>[] }[] {
  const top = efforts.filter((e) => !rendersUnderParent(e, efforts));
  return WORK_MAP_LANES.map((lane) => ({
    lane,
    efforts: top.filter((e) => (lane.states as readonly string[]).includes(e.state)),
  }));
}

/** True when `e` renders under a parent: its parent chain reaches a root
 *  effort without a cycle. A cycle or a missing parent leaves it top-level. */
export function isNestedEffort(e: { id: string; parent?: string }, efforts: readonly { id: string; parent?: string }[]): boolean {
  const byId = new Map(efforts.map((x) => [x.id, x]));
  const seen = new Set([e.id]);
  let cur = e.parent !== undefined ? byId.get(e.parent) : undefined;
  if (!cur) return false;
  while (cur) {
    if (seen.has(cur.id)) return false;
    seen.add(cur.id);
    cur = cur.parent !== undefined ? byId.get(cur.parent) : undefined;
  }
  return true;
}

/** The newest day with any activity, as days before `now` (local days). A
 *  theme stores no `daily`: its newest week with a source counts from that
 *  week's last day (Sunday), so a source this week reads as 0. */
export function lastActiveDays(
  effort: { daily?: readonly { day: string; commits: number; sessions: number }[]; weekly?: readonly { start: string; count: number }[] },
  now: number,
): number | null {
  let best: string | null = null;
  if (effort.daily) {
    for (const d of effort.daily) if (d.commits + d.sessions > 0 && (!best || d.day > best)) best = d.day;
  } else {
    for (const w of effort.weekly ?? []) if (w.count > 0 && (!best || w.start > best)) best = w.start;
    if (best) best = plusDays(best, 6);
  }
  if (!best) return null;
  const t = Date.parse(best + "T12:00:00");
  if (!Number.isFinite(t)) return null;
  const today = new Date(now);
  today.setHours(12, 0, 0, 0);
  return Math.max(0, Math.round((today.getTime() - t) / 86_400_000));
}

/** `YYYY-MM-DD` plus `n` days, by the calendar. */
function plusDays(day: string, n: number): string {
  const t = Date.parse(day + "T12:00:00Z");
  return Number.isFinite(t) ? new Date(t + n * 86_400_000).toISOString().slice(0, 10) : day;
}

function activeLabel(days: number | null): string {
  if (days === null) return "";
  return days === 0 ? "today" : days === 1 ? "yesterday" : `${days} d ago`;
}

// ── The card ──────────────────────────────────────────────────────────
export function workCardHtml<P extends CardPage>(input: WorkCardInput<P>): string {
  const { body, now, hrefFor } = input;
  if (isThemeMap(body.map)) return themeCardHtml(input, body.map);
  const joined = joinWorkMap(body.map, input.pages, now);
  const byKey = new Map<string, CardPage>(input.pages.map((p) => [normalizeRelPath(p.relPath), p]));
  const prose = (s: string) => proseHtml(s, byKey, hrefFor);
  return (
    headHtml(joined, body, now, input.refresh) +
    (joined.summary.trim() ? `<div class="wiki-wm-summary">${prose(joined.summary)}</div>` : "") +
    needsYouHtml(joined, body.map.needsYou, input.done, input.openWhy ?? new Set(), prose, byKey, hrefFor, "Needs you") +
    lanesHtml(joined, now, prose, byKey, hrefFor, input.effortHref) +
    coverageHtml(joined)
  );
}

function headHtml<P>(map: JoinedAnyMap<P>, body: WorkMapGetBody, now: number, refresh: RefreshView, title = "Your work"): string {
  const stale = isWorkMapStale(map.runAtMs, now);
  const runAt = new Date(map.runAtMs);
  const lastRun = body.lastSuccessAt ?? map.runAtMs;
  const running = refresh.phase === "running" || !!body.running;
  const btn = body.organizable
    ? `<button class="wiki-wn-refresh${running ? " spinning" : ""}" id="wikiWorkMapRefresh" title="${esc(
        `Re-organize — last run ${formatAge(now - lastRun)}`,
      )}"${running ? " disabled" : ""}>↻</button>`
    : "";
  let status = "";
  if (refresh.phase === "running") status = `<div class="wiki-wm-status" id="wikiWorkMapStatus">Organizing… started ${esc(formatAge(now - refresh.startedAt))}</div>`;
  else if (refresh.phase === "message") status = `<div class="wiki-wm-status${refresh.tone === "warn" ? " warn" : ""}" id="wikiWorkMapStatus">${esc(refresh.text)}</div>`;
  else if (body.lastAttempt && body.lastAttempt.outcome !== "ok" && body.lastAttempt.at > map.runAtMs) {
    const a = body.lastAttempt;
    status = `<div class="wiki-wm-status warn" id="wikiWorkMapStatus">Last attempt ${esc(formatAge(now - a.at))} ${esc(a.outcome)}${a.error ? ": " + esc(a.error) : ""}</div>`;
  }
  return (
    '<div class="wiki-wn-head">' +
    `<span class="wiki-wn-title">${esc(title)}</span>` +
    `<span class="wiki-wm-age" title="${esc(runAt.toLocaleString())}">organized ${esc(formatAge(now - map.runAtMs))}</span>` +
    (stale ? '<span class="wiki-wm-stale" title="The map is more than 26 hours old">stale</span>' : "") +
    (map.model ? `<span class="wiki-wm-model">${esc(map.model)}</span>` : "") +
    btn +
    "</div>" +
    status
  );
}

function pagesHtml(rels: readonly string[], byKey: ReadonlyMap<string, CardPage>, hrefFor: (rel: string) => string): string {
  const shown = rels.slice(0, EFFORT_PAGES_SHOWN).map((r) => pageLinkHtml(r, byKey, hrefFor));
  const more = rels.length - shown.length;
  if (!shown.length) return "";
  return `<div class="wiki-wm-pages">${shown.join('<span class="wiki-wm-sep"> · </span>')}${more > 0 ? `<span class="wiki-wm-more"> +${more} more</span>` : ""}</div>`;
}

function needsYouHtml<P>(
  map: JoinedAnyMap<P>,
  raw: readonly { kind: string; title: string }[],
  done: ReadonlySet<string>,
  openWhy: ReadonlySet<string>,
  prose: (s: string) => string,
  byKey: ReadonlyMap<string, CardPage>,
  hrefFor: (rel: string) => string,
  title: string,
): string {
  // A theme item also carries `hubs` and the runner's `count`.
  const needs = map.needsYou as readonly { kind: string; title: string; why: string; action: string; pages: string[]; hubs?: string[]; count?: number }[];
  if (!needs.length) return "";
  // Keyed on the STORED item, so the key survives a page rename between renders.
  const open = needs.map((n, i) => ({ n, i })).filter(({ i }) => !done.has(needKey(raw[i]!)));
  const doneCount = needs.length - open.length;
  const cards = open
    .map(
      ({ n, i }) =>
        `<div class="wiki-wm-need" data-wm-need="${i}">` +
        `<div class="wiki-wm-need-head"><span class="wiki-wm-kind">${esc(n.kind)}</span>` +
        `<span class="wiki-wm-need-title">${prose(n.title)}</span>` +
        (n.count !== undefined ? needCountHtml(n.kind, n.count) : "") +
        `<button class="wiki-wm-done" data-wm-done="${i}" data-wm-key="${esc(needKey(raw[i]!))}" title="Mark done" aria-label="Mark done">✓</button></div>` +
        (n.why ? whyHtml(i, needKey(raw[i]!), openWhy.has(needKey(raw[i]!)), n.why, prose, byKey) : "") +
        (n.action ? `<div class="wiki-wm-action">${prose(n.action)}</div>` : "") +
        (n.hubs?.length ? hubsHtml(n.hubs, byKey, hrefFor) : "") +
        // Pages the item's own prose already links are not repeated.
        pagesHtml(
          n.pages.filter((r) => !citedIn(`${n.title} ${n.why} ${n.action}`).has(normalizeRelPath(r))),
          byKey,
          hrefFor,
        ) +
        "</div>",
    )
    .join("");
  return (
    `<div class="wiki-wm-section"><div class="wiki-wm-section-title">${esc(title)}` +
    (doneCount ? ` <button class="wiki-wm-restore" id="wikiWorkMapRestore" title="Show the items marked done">${doneCount} done · show</button>` : "") +
    "</div>" +
    (cards ? `<div class="wiki-wm-needs">${cards}</div>` : '<div class="wiki-wm-empty">Nothing left for this run.</div>') +
    "</div>"
  );
}

/** A Needs-you why, clamped to two lines. Its expand control renders hidden
 *  unless open; the client shows it once it finds the text clamped. */
function whyHtml(i: number, key: string, open: boolean, why: string, prose: (s: string) => string, byKey: ReadonlyMap<string, CardPage>): string {
  const id = `wikiWmWhy${i}`;
  return (
    `<div class="wiki-wm-why${open ? " open" : ""}">` +
    `<div class="wiki-wm-why-text" id="${id}" title="${esc(proseText(why, byKey))}">${prose(why)}</div>` +
    `<button type="button" class="wiki-wm-why-more" data-wm-why="${esc(key)}" aria-controls="${id}" aria-expanded="${open}"${open ? "" : " hidden"}>${open ? "less" : "more"}</button>` +
    "</div>"
  );
}

function effortHtml<P>(
  e: JoinedEffort<P>,
  childrenOf: (id: string) => JoinedEffort<P>[],
  now: number,
  prose: (s: string) => string,
  byKey: ReadonlyMap<string, CardPage>,
  hrefFor: (rel: string) => string,
  shown: Set<string> = new Set(),
  partOf?: string,
  effortHref?: (id: string) => string,
): string {
  shown.add(e.id);
  const active = activeLabel(lastActiveDays(e, now));
  // Sub-efforts render under their parent; `isNestedEffort` keeps a cycle
  // top-level, and `shown` stops the walk at an id already rendered.
  const children = childrenOf(e.id).filter((c) => !shown.has(c.id));
  for (const c of children) shown.add(c.id);
  const subs = children.length
    ? `<ul class="wiki-wm-sub">${children.map((c) => effortHtml(c, childrenOf, now, prose, byKey, hrefFor, shown, undefined, effortHref)).join("")}</ul>`
    : "";
  return (
    `<li class="wiki-wm-effort" data-effort-id="${esc(e.id)}">` +
    '<div class="wiki-wm-effort-head">' +
    (effortHref
      ? `<a class="wiki-wm-effort-name" href="${esc(effortHref(e.id))}" data-effort-link="${esc(e.id)}">${esc(e.name)}</a>`
      : `<span class="wiki-wm-effort-name">${esc(e.name)}</span>`) +
    `<span class="wiki-wm-state wm-state-${esc(e.state)}">${esc(e.state)}</span>` +
    (active ? `<span class="wiki-wm-active">${esc(active)}</span>` : "") +
    (partOf ? `<span class="wiki-wm-partof">part of ${esc(partOf)}</span>` : "") +
    "</div>" +
    (e.oneLine ? `<div class="wiki-wm-oneline">${prose(e.oneLine)}</div>` : "") +
    pagesHtml(
      e.pages.map((p) => p.id),
      byKey,
      hrefFor,
    ) +
    (e.next ? `<div class="wiki-wm-next"><span class="wiki-wm-next-label">Next:</span> ${prose(e.next)}</div>` : "") +
    subs +
    "</li>"
  );
}

/** The efforts the card lists: every joined effort except one that declared
 *  pages moving elsewhere left empty (P6). An effort emptied by deletions
 *  stays, so the card can still say it existed. */
export function cardEfforts<P>(efforts: readonly JoinedEffort<P>[]): JoinedEffort<P>[] {
  return efforts.filter((e) => e.pages.length > 0 || e.movedOut.length === 0);
}

function lanesHtml<P>(
  map: JoinedWorkMap<P>,
  now: number,
  prose: (s: string) => string,
  byKey: ReadonlyMap<string, CardPage>,
  hrefFor: (rel: string) => string,
  effortHref?: (id: string) => string,
): string {
  const listed = cardEfforts(map.efforts);
  const childrenOf = (id: string) => listed.filter((x) => x.parent === id && rendersUnderParent(x, listed));
  const parentName = (e: JoinedEffort<P>) => (isNestedEffort(e, listed) ? listed.find((x) => x.id === e.parent)?.name : undefined);
  const shown = new Set<string>();
  return laneEfforts(listed)
    .map(({ lane, efforts }) => {
      const before = shown.size;
      const items = efforts
        .filter((e) => !shown.has(e.id))
        .map((e) => effortHtml(e, childrenOf, now, prose, byKey, hrefFor, shown, parentName(e), effortHref))
        .join("");
      // Every effort rendered in this lane, sub-efforts included.
      const count = shown.size - before;
      if (!count) return "";
      return (
        `<details class="wiki-wm-lane" data-wm-lane="${lane.id}"${lane.open ? " open" : ""}>` +
        `<summary class="wiki-wm-lane-title">${esc(lane.label)} <span class="wiki-wm-count">${count}</span></summary>` +
        `<ul class="wiki-wm-efforts">${items}</ul></details>`
      );
    })
    .join("");
}

function coverageHtml<P>(map: JoinedWorkMap<P>): string {
  const c = map.coverage;
  const since = new Date(c.sessionsSinceMs);
  const parts = [
    `sessions since ${since.toLocaleDateString()}`,
    `${c.activePages} active page${c.activePages === 1 ? "" : "s"}`,
    `${c.threads} thread${c.threads === 1 ? "" : "s"}`,
  ];
  if (c.logEntriesInWindow !== undefined && c.logEntriesInWindow > c.logEntries) {
    parts.push(`log: the newest ${c.logEntries} of ${c.logEntriesInWindow} shown`);
  }
  // P1 writes the degraded-filter warning into `warnings` itself.
  const uniq = [...new Set(c.warnings)];
  return (
    `<div class="wiki-wm-coverage">Covers ${esc(parts.join(" · "))}</div>` +
    (uniq.length ? `<ul class="wiki-wm-warnings">${uniq.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : "")
  );
}

// ── What you're following (a themes map, plan muninn-wiki-theme-map P2) ──
/** The themes card's lanes, by the runner's trend state. Fading starts closed,
 *  as the work card's quiet lanes do. */
export const THEME_MAP_LANES = [
  { id: "new", label: "New", states: ["new"], open: true },
  { id: "rising", label: "Rising", states: ["rising"], open: true },
  { id: "steady", label: "Steady", states: ["steady"], open: true },
  { id: "fading", label: "Fading", states: ["fading"], open: false },
] as const;
/** Weeks a theme's strip shows, oldest first. */
export const THEME_STRIP_WEEKS = 8;
/** Hub chips shown before `+N more`. */
export const THEME_HUBS_SHOWN = 4;
/** Connections shown before `+N more`. */
export const THEME_CONNECTIONS_SHOWN = 6;

/** The card's Connected row: each pair of listed themes once (a connection is
 *  stored on both ends). `themes` come in the card's lane order; rows are
 *  dealt round-robin so one theme cannot fill the row: in round k a theme
 *  already in more than k rows waits, else it takes its first pair not yet
 *  shown, its own stored links first, with itself on the left and its own why
 *  (a pair stored on the other end only keeps that end on the left). */
export function themeConnections<T extends { id: string; related: readonly { id: string; why: string }[] }>(
  themes: readonly T[],
): { a: T; b: T; why: string }[] {
  const byId = new Map(themes.map((t) => [t.id, t]));
  const key = (x: string, y: string) => [x, y].sort().join("\u0000");
  // Each theme's candidates: its own links, then links stored only on the other end.
  const cands = new Map<string, { a: T; b: T; why: string; key: string }[]>(themes.map((t) => [t.id, []]));
  const stored = new Set<string>();
  for (const a of themes) {
    for (const r of a.related) {
      const b = byId.get(r.id);
      if (!b || b.id === a.id) continue;
      const k = key(a.id, b.id);
      if (cands.get(a.id)!.some((c) => c.key === k)) continue;
      cands.get(a.id)!.push({ a, b, why: r.why, key: k });
      stored.add(`${a.id}\u0000${b.id}`);
    }
  }
  for (const a of themes) {
    for (const c of [...cands.get(a.id)!]) {
      if (!stored.has(`${c.b.id}\u0000${a.id}`)) cands.get(c.b.id)!.push(c);
    }
  }
  const seen = new Set<string>();
  const uses = new Map<string, number>();
  const out: { a: T; b: T; why: string }[] = [];
  const total = new Set([...cands.values()].flat().map((c) => c.key)).size;
  for (let round = 0; out.length < total; round++) {
    for (const t of themes) {
      if ((uses.get(t.id) ?? 0) > round) continue;
      const c = cands.get(t.id)!.find((x) => !seen.has(x.key));
      if (!c) continue;
      seen.add(c.key);
      for (const id of [c.a.id, c.b.id]) uses.set(id, (uses.get(id) ?? 0) + 1);
      out.push({ a: c.a, b: c.b, why: c.why });
    }
  }
  return out;
}

/** "this week" / "last week" / "N wk ago", from {@link lastActiveDays}. */
export function themeActiveLabel(days: number | null): string {
  if (days === null) return "";
  const weeks = Math.ceil(days / 7);
  return weeks === 0 ? "this week" : weeks === 1 ? "last week" : `${weeks} wk ago`;
}

/** A Worth-a-look item's runner count: a drift item's sources since the hub's
 *  last update, else the sources it cites. */
function needCountHtml(kind: string, count: number): string {
  const drift = kind === "drift";
  const text = drift ? `${count} new since update` : `${count} source${count === 1 ? "" : "s"}`;
  const title = drift ? "Active sources linking this hub, created after the hub was last updated" : "Sources this item cites";
  return `<span class="wiki-wm-need-count" title="${esc(title)}">${esc(text)}</span>`;
}

function hubsHtml(rels: readonly string[], byKey: ReadonlyMap<string, CardPage>, hrefFor: (rel: string) => string): string {
  const shown = rels.slice(0, THEME_HUBS_SHOWN).map((r) => `<span class="wiki-wm-hub">${pageLinkHtml(r, byKey, hrefFor)}</span>`);
  if (!shown.length) return "";
  const more = rels.length - shown.length;
  return `<div class="wiki-wm-hubs">${shown.join("")}${more > 0 ? `<span class="wiki-wm-more">+${more} more</span>` : ""}</div>`;
}

/** The weekly bar strip: the newest {@link THEME_STRIP_WEEKS} stored weeks,
 *  each bar's height a step of the strip's busiest week. Older weeks holding
 *  sources show as «+N earlier». The week holding `runAtMs` (Oslo) is still
 *  running and is framed `current`; a `partial` week is framed too, so an
 *  empty one reads apart from a full empty week. */
export function weeklyStripHtml(weekly: readonly ThemeWeek[], runAtMs?: number): string {
  const sorted = [...weekly].sort((a, b) => a.start.localeCompare(b.start));
  const weeks = sorted.slice(-THEME_STRIP_WEEKS);
  if (!weeks.length) return "";
  const earlier = sorted.slice(0, sorted.length - weeks.length);
  const earlierTotal = earlier.reduce((n, w) => n + w.count, 0);
  const runDay = runAtMs === undefined ? null : osloDay(runAtMs);
  const isCurrent = (w: ThemeWeek) => runDay !== null && w.start <= runDay && runDay <= plusDays(w.start, 6);
  const max = Math.max(1, ...weeks.map((w) => w.count));
  const total = weeks.reduce((n, w) => n + w.count, 0);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const bars = weeks
    .map((w) => {
      const level = w.count === 0 ? 0 : Math.max(1, Math.ceil((w.count / max) * 4));
      const current = isCurrent(w);
      const mark = current ? " current" : w.partial ? " partial" : "";
      const label =
        `${w.week} (from ${w.start}): ${plural(w.count, "source")}` +
        (current ? " so far, week still running" : w.partial ? ", may miss days" : "");
      return `<span class="wiki-wm-slot${mark}" title="${esc(label)}"><span class="wiki-wm-week lvl-${level}"></span></span>`;
    })
    .join("");
  const partials = weeks.filter((w) => w.partial && !isCurrent(w)).length;
  const aria =
    `${plural(total, "source")} over the last ${plural(weeks.length, "week")}` +
    (weeks.some(isCurrent) ? ", this week so far" : "") +
    (partials ? `, ${plural(partials, "week")} may miss days` : "") +
    (earlierTotal ? `, ${earlierTotal} more in ${earlier.length} earlier week${earlier.length === 1 ? "" : "s"}` : "");
  const more = earlierTotal
    ? `<span class="wiki-wm-weeks-earlier" title="${esc(`${plural(earlierTotal, "source")} in the ${earlier.length} week${earlier.length === 1 ? "" : "s"} before`)}">+${earlierTotal} earlier</span>`
    : "";
  return `<div class="wiki-wm-weeks" role="img" aria-label="${esc(aria)}">${more}${bars}</div>`;
}

function themeHtml<P>(
  e: JoinedTheme<P>,
  now: number,
  prose: (s: string) => string,
  byKey: ReadonlyMap<string, CardPage>,
  hrefFor: (rel: string) => string,
  runAtMs: number,
  effortHref?: (id: string) => string,
): string {
  const active = themeActiveLabel(lastActiveDays(e, now));
  const n = e.pages.length;
  return (
    `<li class="wiki-wm-effort wiki-wm-theme" data-effort-id="${esc(e.id)}">` +
    '<div class="wiki-wm-effort-head">' +
    (effortHref
      ? `<a class="wiki-wm-effort-name" href="${esc(effortHref(e.id))}" data-effort-link="${esc(e.id)}">${esc(e.name)}</a>`
      : `<span class="wiki-wm-effort-name">${esc(e.name)}</span>`) +
    `<span class="wiki-wm-state wm-state-${esc(e.state)}">${esc(e.state)}</span>` +
    `<span class="wiki-wm-active">${esc(`${n} source${n === 1 ? "" : "s"}`)}${active ? esc(` · ${active}`) : ""}</span>` +
    "</div>" +
    (e.oneLine ? `<div class="wiki-wm-oneline">${prose(e.oneLine)}</div>` : "") +
    weeklyStripHtml(e.weekly, runAtMs) +
    hubsHtml(e.hubs, byKey, hrefFor) +
    pagesHtml(
      e.pages.map((p) => p.id),
      byKey,
      hrefFor,
    ) +
    "</li>"
  );
}

/** A theme's place in the card's lane order: New, Rising, Steady, Fading, then Life. */
function themeLaneRank(e: { state: string; domain?: string }): number {
  if (e.domain === "life") return THEME_MAP_LANES.length;
  const i = THEME_MAP_LANES.findIndex((l) => (l.states as readonly string[]).includes(e.state));
  return i < 0 ? THEME_MAP_LANES.length : i;
}

function connectedHtml<P>(themes: readonly JoinedTheme<P>[], prose: (s: string) => string, effortHref?: (id: string) => string): string {
  // Stable sort: map order within a lane.
  const pairs = themeConnections([...themes].sort((x, y) => themeLaneRank(x) - themeLaneRank(y)));
  if (!pairs.length) return "";
  const name = (t: JoinedTheme<P>) =>
    effortHref
      ? // `data-wm-conn-link` sets this link apart from the theme's name in its lane, for the focus restore.
        `<a class="wiki-wm-effort-name" href="${esc(effortHref(t.id))}" data-effort-link="${esc(t.id)}" data-wm-conn-link>${esc(t.name)}</a>`
      : `<span class="wiki-wm-effort-name">${esc(t.name)}</span>`;
  const shown = pairs.slice(0, THEME_CONNECTIONS_SHOWN);
  const more = pairs.length - shown.length;
  return (
    '<div class="wiki-wm-section wiki-wm-connected"><div class="wiki-wm-section-title">Connected</div><ul class="wiki-wm-conns">' +
    shown
      .map(
        ({ a, b, why }) =>
          `<li class="wiki-wm-conn" data-wm-conn="${esc(a.id)}|${esc(b.id)}">${name(a)} <span class="wiki-wm-conn-arrow" aria-label="connected to">↔</span> ${name(b)}` +
          (why ? `<span class="wiki-wm-conn-why">: ${prose(why)}</span>` : "") +
          "</li>",
      )
      .join("") +
    "</ul>" +
    (more > 0 ? `<div class="wiki-wm-more">+${more} more</div>` : "") +
    "</div>"
  );
}

function themeLaneHtml<P>(
  id: string,
  label: string,
  open: boolean,
  themes: readonly JoinedTheme<P>[],
  render: (e: JoinedTheme<P>) => string,
  extraClass = "",
): string {
  if (!themes.length) return "";
  return (
    `<details class="wiki-wm-lane${extraClass}" data-wm-lane="${esc(id)}"${open ? " open" : ""}>` +
    `<summary class="wiki-wm-lane-title">${esc(label)} <span class="wiki-wm-count">${themes.length}</span></summary>` +
    `<ul class="wiki-wm-efforts">${themes.map(render).join("")}</ul></details>`
  );
}

function themeCardHtml<P extends CardPage>(input: WorkCardInput<P>, map: ThemeMap): string {
  const { body, now, hrefFor } = input;
  const joined: JoinedThemeMap<P> = joinWorkMap(map, input.pages, now);
  const byKey = new Map<string, CardPage>(input.pages.map((p) => [normalizeRelPath(p.relPath), p]));
  const prose = (s: string) => proseHtml(s, byKey, hrefFor);
  const listed = joined.efforts.filter((e) => e.pages.length > 0 || e.movedOut.length === 0);
  const render = (e: JoinedTheme<P>) => themeHtml(e, now, prose, byKey, hrefFor, map.runAtMs, input.effortHref);
  const ai = listed.filter((e) => e.domain !== "life");
  const life = listed.filter((e) => e.domain === "life");
  // The Life section takes its name from the stored domain group holding its themes.
  const lifeLabel = joined.themes.find((g) => life.some((e) => g.efforts.includes(e.id)))?.name || "Life";
  const lanes = THEME_MAP_LANES.map((lane) =>
    themeLaneHtml(
      lane.id,
      lane.label,
      lane.open,
      ai.filter((e) => (lane.states as readonly string[]).includes(e.state)),
      render,
    ),
  ).join("");
  return (
    headHtml(joined, body, now, input.refresh, "What you’re following") +
    (joined.summary.trim() ? `<div class="wiki-wm-summary">${prose(joined.summary)}</div>` : "") +
    needsYouHtml(joined, map.needsYou, input.done, input.openWhy ?? new Set(), prose, byKey, hrefFor, "Worth a look") +
    connectedHtml(listed, prose, input.effortHref) +
    lanes +
    themeLaneHtml("life", lifeLabel, true, life, render, " wiki-wm-life") +
    themeCoverageHtml(joined)
  );
}

function themeCoverageHtml<P>(map: JoinedThemeMap<P>): string {
  const c = map.coverage;
  const text = `${c.activeSources} source${c.activeSources === 1 ? "" : "s"} in ${c.windowDays} days · ${c.hubs} hub${c.hubs === 1 ? "" : "s"}`;
  const uniq = [...new Set(c.warnings)];
  return (
    `<div class="wiki-wm-coverage">${esc(text)}</div>` +
    (uniq.length ? `<ul class="wiki-wm-warnings">${uniq.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : "")
  );
}

// ── ↻ outcomes ────────────────────────────────────────────────────────
/** The status line for a refused POST. */
export function refreshRefusalText(status: number, body: Record<string, unknown>, now: number): string {
  const err = typeof body.error === "string" ? body.error : "";
  if (status === 429) {
    const wait = typeof body.retryAfterMs === "number" ? Math.max(1, Math.ceil(body.retryAfterMs / 60_000)) : null;
    const success = typeof body.lastSuccessAt === "number" ? body.lastSuccessAt : null;
    const failed = typeof body.lastFailedAt === "number" ? body.lastFailedAt : null;
    const lead = success !== null ? `Ran ${formatAge(now - success)}` : failed !== null ? `A run failed ${formatAge(now - failed)}` : "Ran recently";
    return `${lead} — try again in ${wait ?? "a few"} min.`;
  }
  if (status === 403) return `Can’t re-organize here: ${err || "not organizable on this instance"}.`;
  return `Re-organize failed (${status})${err ? ": " + err : ""}.`;
}

/**
 * Where a poll after ↻ stands: `updated` when the map's run time moved,
 * `settled` when the attempt this ↻ started (or joined) has resolved without a
 * new map (refused or failed, or ok with the same bytes), else `pending`.
 */
export function pollState(
  body: WorkMapGetBody,
  prevRunAt: number,
  startedAt: number,
): { state: "updated" } | { state: "settled"; attempt: WorkMapAttempt } | { state: "pending" } {
  if (body.map && body.map.runAtMs > prevRunAt) return { state: "updated" };
  const a = body.lastAttempt;
  if (!body.running && a && a.at >= startedAt) return { state: "settled", attempt: a };
  return { state: "pending" };
}
