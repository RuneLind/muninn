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

import { joinWorkMap, type JoinablePage, type JoinedEffort, type JoinedWorkMap } from "../../../wiki/work-map/join.ts";
import type { WorkMap } from "../../../wiki/work-map/schema.ts";
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
  map: WorkMap | null;
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
  body: WorkMapGetBody & { map: WorkMap };
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

/** `text` as plain text, each marker read as its page title: a `title=`
 *  value for prose the card clamps. */
export function proseText(text: string, byKey: ReadonlyMap<string, CardPage>): string {
  return text.replace(/⟦([^⟧]+)⟧/g, (_, rel: string) => {
    const page = byKey.get(normalizeRelPath(rel));
    return page ? pageTitle(page) : stemOf(rel);
  });
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

/** The newest day with any activity, as days before `now` (local days). */
export function lastActiveDays(effort: { daily: readonly { day: string; commits: number; sessions: number }[] }, now: number): number | null {
  let best: string | null = null;
  for (const d of effort.daily) if (d.commits + d.sessions > 0 && (!best || d.day > best)) best = d.day;
  if (!best) return null;
  const t = Date.parse(best + "T12:00:00");
  if (!Number.isFinite(t)) return null;
  const today = new Date(now);
  today.setHours(12, 0, 0, 0);
  return Math.max(0, Math.round((today.getTime() - t) / 86_400_000));
}

function activeLabel(days: number | null): string {
  if (days === null) return "";
  return days === 0 ? "today" : days === 1 ? "yesterday" : `${days} d ago`;
}

// ── The card ──────────────────────────────────────────────────────────
export function workCardHtml<P extends CardPage>(input: WorkCardInput<P>): string {
  const { body, now, hrefFor } = input;
  const joined = joinWorkMap(body.map, input.pages, now);
  const byKey = new Map<string, CardPage>(input.pages.map((p) => [normalizeRelPath(p.relPath), p]));
  const prose = (s: string) => proseHtml(s, byKey, hrefFor);
  return (
    headHtml(joined, body, now, input.refresh) +
    (joined.summary.trim() ? `<div class="wiki-wm-summary">${prose(joined.summary)}</div>` : "") +
    needsYouHtml(joined, body.map.needsYou, input.done, input.openWhy ?? new Set(), prose, byKey, hrefFor) +
    lanesHtml(joined, now, prose, byKey, hrefFor, input.effortHref) +
    coverageHtml(joined)
  );
}

function headHtml<P>(map: JoinedWorkMap<P>, body: WorkMapGetBody, now: number, refresh: RefreshView): string {
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
    '<span class="wiki-wn-title">Your work</span>' +
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
  map: JoinedWorkMap<P>,
  raw: WorkMap["needsYou"],
  done: ReadonlySet<string>,
  openWhy: ReadonlySet<string>,
  prose: (s: string) => string,
  byKey: ReadonlyMap<string, CardPage>,
  hrefFor: (rel: string) => string,
): string {
  if (!map.needsYou.length) return "";
  // Keyed on the STORED item, so the key survives a page rename between renders.
  const open = map.needsYou.map((n, i) => ({ n, i })).filter(({ i }) => !done.has(needKey(raw[i]!)));
  const doneCount = map.needsYou.length - open.length;
  const cards = open
    .map(
      ({ n, i }) =>
        `<div class="wiki-wm-need" data-wm-need="${i}">` +
        `<div class="wiki-wm-need-head"><span class="wiki-wm-kind">${esc(n.kind)}</span>` +
        `<span class="wiki-wm-need-title">${prose(n.title)}</span>` +
        `<button class="wiki-wm-done" data-wm-done="${i}" data-wm-key="${esc(needKey(raw[i]!))}" title="Mark done" aria-label="Mark done">✓</button></div>` +
        (n.why ? whyHtml(i, needKey(raw[i]!), openWhy.has(needKey(raw[i]!)), n.why, prose, byKey) : "") +
        (n.action ? `<div class="wiki-wm-action">${prose(n.action)}</div>` : "") +
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
    '<div class="wiki-wm-section"><div class="wiki-wm-section-title">Needs you' +
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
