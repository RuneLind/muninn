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
import { closedWithoutShipping } from "../../../plans/board-client-pure.ts";
import type { ChecksNeed, NotCheckedReason, WorkMapChecksBody } from "../../../wiki/work-map/gh-check.ts";
import { escHtml as esc } from "./escape.ts";

/** Past this age the card marks the map stale (the loop runs daily). */
export const WORK_MAP_STALE_MS = 26 * 3_600_000;
/** Page links a Needs you item or a theme shows before `+N more`. */
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
  movesYou?: number;
  movesWaiting?: number;
  waitingSince?: string;
  plan_status?: string;
  status_date?: string;
  followups?: string;
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
  /** The listing's `waitsCounted`; absent reads as not counted. */
  waitsCounted?: boolean;
  /** The health strip's open cell and whether its list is expanded. */
  strip?: StripView;
  /** The GitHub check's fifth cell and the Needs you marks; absent, neither renders. */
  checks?: ChecksView;
}

/** Where the card's GitHub check stands, held by the DOM half. */
export interface ChecksView {
  /** Null until the first answer. */
  body: WorkMapChecksBody | null;
  /** The map `body` was fetched for. A title can recur on a new map, so only an
   *  answer for the map on the card may mark its items. */
  answerRunAt: number | null;
  /** The last fetch failed: `body`, if any, is older and did not just get checked. */
  failed?: boolean;
  /** The card will fetch again while `refreshing` stays true. */
  retrying?: boolean;
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
  const marks = needMarksReader(body.map.needsYou, input.checks, body.map.runAtMs);
  return (
    headHtml(joined, body, now, input.refresh) +
    healthStripHtml(input.pages, !!input.waitsCounted, input.strip ?? { open: null, expanded: false }, now, byKey, hrefFor, input.checks, body.map.runAtMs) +
    (joined.summary.trim() ? `<div class="wiki-wm-summary">${prose(joined.summary)}</div>` : "") +
    needsYouHtml(joined, body.map.needsYou, input.done, input.openWhy ?? new Set(), prose, byKey, hrefFor, "Needs you", marks) +
    boardHtml(joined, body.map.needsYou, input.done, marks, !!input.waitsCounted, now, prose, input.effortHref) +
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
  marks: NeedMarks = () => ({ struck: false, notes: [] }),
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
        `<div class="wiki-wm-need${marks(i).struck ? " gh-done" : ""}" data-wm-need="${i}">` +
        `<div class="wiki-wm-need-head"><span class="wiki-wm-kind">${esc(n.kind)}</span>` +
        `<span class="wiki-wm-need-title">${prose(n.title)}</span>` +
        (n.count !== undefined ? needCountHtml(n.kind, n.count) : "") +
        `<button class="wiki-wm-done" data-wm-done="${i}" data-wm-key="${esc(needKey(raw[i]!))}" title="Mark done" aria-label="Mark done">✓</button></div>` +
        (n.why ? whyHtml(i, needKey(raw[i]!), openWhy.has(needKey(raw[i]!)), n.why, prose, byKey) : "") +
        (n.action ? `<div class="wiki-wm-action">${prose(n.action)}</div>` : "") +
        marks(i)
          .notes.map((note) => `<div class="wiki-wm-ghnote ${note.tone}">${esc(note.text)}</div>`)
          .join("") +
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

/** A merge date as the card writes it: `29.10`, the viewer's day. */
function shortDay(iso: string | null): string {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? `${d.getDate()}.${d.getMonth() + 1}` : "";
}

/**
 * What GitHub says on one Needs you item, from its entries in the checks body.
 * It is struck through only when it asks for its PRs and every one is merged. A
 * PR closed without a merge warns. An item that asks for several PRs says where
 * each stands, so a reader can see why it is not struck through. On an answer
 * GitHub did not just confirm, `unconfirmed`, only a merge is still said: it is
 * final, while an open or closed PR can have moved, and no note shows an age.
 */
export function needGhMarks(entries: readonly ChecksNeed[], unconfirmed = false): { struck: boolean; notes: GhNote[] } {
  const struck = entries.length > 0 && entries.every((e) => e.asksForIt && e.state === "MERGED");
  const several = entries.length > 1;
  const notes: GhNote[] = [];
  for (const e of entries) {
    const merged = `GitHub: #${e.pr} merged ${shortDay(e.mergedAt)}`.trim();
    if (e.state === "MERGED") notes.push(struck ? { tone: "done", text: `${merged}, this step is done` } : { tone: "info", text: merged });
    else if (unconfirmed && e.state !== null) continue;
    else if (e.state === "CLOSED") notes.push({ tone: "warn", text: `GitHub: #${e.pr} closed without merge` });
    else if (several && e.asksForIt) notes.push({ tone: "info", text: `GitHub: #${e.pr} ${e.state === "OPEN" ? "open" : "not checked"}` });
  }
  return { struck, notes };
}

export interface GhNote {
  tone: "done" | "warn" | "info";
  text: string;
}

/** What GitHub says on the map's Needs you item at index `i`. */
export type NeedMarks = (i: number) => { struck: boolean; notes: GhNote[] };

/**
 * The one reading of the check for the Needs you cards and the board, so the two
 * cannot differ: only an answer for the map on the card marks its items.
 */
export function needMarksReader(raw: readonly { kind: string; title: string }[], checks: ChecksView | undefined, runAtMs: number): NeedMarks {
  const entries = checks?.answerRunAt === runAtMs ? (checks.body?.needs ?? []) : [];
  const unconfirmed = !!checks?.failed || (!!checks?.body?.refreshing && !checks.retrying);
  return (i) => needGhMarks(entries.filter((c) => needKey(c) === needKey(raw[i]!)), unconfirmed);
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

// ── The board (plan muninn-wiki-your-work-board, P3) ──────────────────
export type BoardColumnId = "you" | "moving" | "cooling" | "quiet" | "shipped";

/** The column an effort's state puts it in, when nothing waits on the reader. */
export const BOARD_COLUMNS: Record<JoinedEffort<unknown>["state"], Exclude<BoardColumnId, "you">> = {
  active: "moving",
  blocked: "moving",
  proposed: "moving",
  cooling: "cooling",
  quiet: "quiet",
  shipped: "shipped",
};

const BOARD_COLUMN_HEADS: readonly { id: BoardColumnId; label: string; open: boolean }[] = [
  { id: "you", label: "Waiting on you", open: true },
  { id: "moving", label: "Moving", open: true },
  { id: "cooling", label: "Cooling", open: false },
  { id: "quiet", label: "Quiet", open: false },
  { id: "shipped", label: "Shipped", open: false },
];

/** What the board reads off an effort's pages and Needs you items. */
export interface BoardFacts {
  decisions: number;
  /** The oldest dated wait, `YYYY-MM-DD`. */
  since?: string;
  steps: number;
  /** The `kind` of each Needs you item still open for this effort. */
  needKinds: string[];
}

/** The strip's page rule per effort; `waitsCounted` false turns only the waits off. */
export function boardFacts<P extends CardPage>(
  effort: { id: string; pages: readonly { page: P }[] },
  raw: readonly { kind: string; title: string; effort?: string }[],
  done: ReadonlySet<string>,
  marks: NeedMarks,
  waitsCounted: boolean,
): BoardFacts {
  const live = livePages([...new Set(effort.pages.map((p) => p.page))]);
  const waits = waitsCounted ? live.filter((p) => (p.movesWaiting ?? 0) > 0) : [];
  const dates = waits.flatMap((p) => (p.waitingSince ? [p.waitingSince] : [])).sort();
  return {
    decisions: waits.reduce((n, p) => n + p.movesWaiting!, 0),
    ...(dates[0] ? { since: dates[0] } : {}),
    steps: live.reduce((n, p) => n + (p.movesYou ?? 0), 0),
    needKinds: openNeeds(effortNeedItems(raw, effort.id), done)
      .filter(({ i }) => !marks(i).struck)
      .map(({ i }) => raw[i]!.kind),
  };
}

export function boardColumn(effort: { state: JoinedEffort<unknown>["state"] }, facts: BoardFacts): BoardColumnId {
  return facts.decisions > 0 || facts.needKinds.length > 0 ? "you" : BOARD_COLUMNS[effort.state];
}

/** The days a sparkline covers, today last. */
export const SPARK_DAYS = 28;
const SPARK_HEIGHT = 24;

/** Commits plus twice the sessions per day, oldest first. A day after today counts as today, as in {@link lastActiveDays}. */
export function sparkValues(daily: readonly { day: string; commits: number; sessions: number }[], now: number): number[] {
  const out = new Array<number>(SPARK_DAYS).fill(0);
  for (const d of daily) {
    const age = daysSinceDay(d.day, now);
    if (age < SPARK_DAYS) out[SPARK_DAYS - 1 - age]! += d.commits + 2 * d.sessions;
  }
  return out;
}

function sparkHtml(daily: readonly { day: string; commits: number; sessions: number }[], now: number): string {
  const values = sparkValues(daily, now);
  const top = Math.max(1, ...values);
  const bars = values.map((v, i) => {
    const h = v ? Math.max(3, (v / top) * SPARK_HEIGHT) : 1;
    return `<rect${v ? "" : ' class="zero"'} x="${i + 0.1}" y="${(SPARK_HEIGHT - h).toFixed(1)}" width="0.8" height="${h.toFixed(1)}"/>`;
  });
  return `<svg class="wiki-wm-spark" viewBox="0 0 ${SPARK_DAYS} ${SPARK_HEIGHT}" preserveAspectRatio="none" role="img" aria-label="Activity, last 28 days">${bars.join("")}</svg>`;
}

interface BoardRow<P> {
  e: JoinedEffort<P>;
  at: number;
  facts: BoardFacts;
  col: BoardColumnId;
  idle: number | null;
}

/** Oldest wait first, undated after; then most recently active, then map order. */
function byBoardOrder<P>(a: BoardRow<P>, b: BoardRow<P>): number {
  const x = a.facts.since;
  const y = b.facts.since;
  if (x !== y) return !x ? 1 : !y ? -1 : x < y ? -1 : 1;
  return (a.idle ?? Infinity) - (b.idle ?? Infinity) || a.at - b.at;
}

function boardPillsHtml<P>(r: BoardRow<P>, now: number): string {
  const { decisions, since, steps, needKinds } = r.facts;
  const pill = (text: string, tone = "") => `<span class="wiki-wm-pill${tone}">${esc(text)}</span>`;
  const active = activeLabel(r.idle);
  const pills =
    (decisions ? pill(`${decisions} decision${decisions === 1 ? "" : "s"}${since ? ` · ${daysSinceDay(since, now)} d` : ""}`, " warn") : "") +
    (needKinds.length ? pill(needKinds.join(" · "), " acc") : "") +
    (steps ? pill(`${steps} step${steps === 1 ? "" : "s"}`) : "") +
    (active ? pill(active) : "");
  return pills && `<div class="wiki-wm-pills">${pills}</div>`;
}

function boardNameHtml(e: { id: string; name: string }, effortHref?: (id: string) => string): string {
  return effortHref
    ? `<a class="wiki-wm-effort-name" href="${esc(effortHref(e.id))}" data-effort-link="${esc(e.id)}">${esc(e.name)}</a>`
    : `<span class="wiki-wm-effort-name">${esc(e.name)}</span>`;
}

function boardHtml<P extends CardPage>(
  map: JoinedWorkMap<P>,
  raw: readonly { kind: string; title: string; effort?: string }[],
  done: ReadonlySet<string>,
  marks: NeedMarks,
  waitsCounted: boolean,
  now: number,
  prose: (s: string) => string,
  effortHref?: (id: string) => string,
): string {
  const listed = map.efforts.filter((e) => e.pages.length > 0);
  const rows = listed.map((e, at): BoardRow<P> => {
    const facts = boardFacts(e, raw, done, marks, waitsCounted);
    return { e, at, facts, col: boardColumn(e, facts), idle: lastActiveDays(e, now) };
  });
  const byId = new Map(rows.map((r) => [r.e.id, r]));
  const parentOf = (r: BoardRow<P>) => (isNestedEffort(r.e, listed) ? byId.get(r.e.parent!) : undefined);
  const nestsUp = (r: BoardRow<P>) => parentOf(r)?.col === r.col;
  // `isNestedEffort` holds for the whole chain, so this walk ends.
  const tileOf = (r: BoardRow<P>): BoardRow<P> => (nestsUp(r) ? tileOf(parentOf(r)!) : r);
  const kidHtml = (k: BoardRow<P>) =>
    `<li class="wiki-wm-effort wiki-wm-kid" data-effort-id="${esc(k.e.id)}">${boardNameHtml(k.e, effortHref)}${boardPillsHtml(k, now)}${sparkHtml(k.e.daily, now)}</li>`;
  const tileHtml = (r: BoardRow<P>) => {
    const kids = rows.filter((k) => nestsUp(k) && tileOf(k) === r).sort(byBoardOrder);
    const partOf = parentOf(r);
    return (
      `<li class="wiki-wm-effort wiki-wm-tile" data-effort-id="${esc(r.e.id)}">` +
      `<div class="wiki-wm-effort-head">${boardNameHtml(r.e, effortHref)}${partOf ? `<span class="wiki-wm-partof">part of ${esc(partOf.e.name)}</span>` : ""}</div>` +
      sparkHtml(r.e.daily, now) +
      (r.e.oneLine ? `<div class="wiki-wm-oneline">${prose(r.e.oneLine)}</div>` : "") +
      boardPillsHtml(r, now) +
      (r.e.next ? `<div class="wiki-wm-next"><span class="wiki-wm-next-label">Next:</span> ${prose(r.e.next)}</div>` : "") +
      (kids.length ? `<ul class="wiki-wm-kids">${kids.map(kidHtml).join("")}</ul>` : "") +
      "</li>"
    );
  };
  const cols = BOARD_COLUMN_HEADS.map(({ id, label, open }) => {
    const inCol = rows.filter((r) => r.col === id);
    const tiles = inCol.filter((r) => !nestsUp(r)).sort(byBoardOrder);
    return (
      // Named here because an inert head (the wide board) drops out of the accessibility tree.
      `<details class="wiki-wm-col" data-wm-lane="${id}" aria-label="${esc(label)} ${inCol.length}"${open ? " open" : ""}>` +
      `<summary class="wiki-wm-lane-title">${esc(label)} <span class="wiki-wm-count">${inCol.length}</span></summary>` +
      (tiles.length ? `<ul class="wiki-wm-efforts">${tiles.map(tileHtml).join("")}</ul>` : '<div class="wiki-wm-col-none">none</div>') +
      "</details>"
    );
  });
  return `<div class="wiki-wm-board"><div class="wiki-wm-cols">${cols.join("")}</div></div>`;
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

// ── The health strip (plan muninn-wiki-your-work-board, P1) ───────────
export type StripCell = "decisions" | "oldest" | "steps" | "shipped" | "github";
export interface StripView {
  open: StripCell | null;
  expanded: boolean;
  /** How far the GitHub list's two shut groups are open: absent is the one line. */
  ghGroups?: Partial<Record<GhFoldedGroup, "window" | "all">>;
}
export type GhFoldedGroup = "unchecked" | "unlinked";
/** Rows a cell's list shows before `+N more`. */
export const STRIP_ROWS_SHOWN = 8;
/** Past these the two wait cells take the warn tone. */
export const STRIP_DECISIONS_WARN = 10;
export const STRIP_OLDEST_WARN_DAYS = 7;

interface StripRow {
  relPath: string;
  count?: number;
  since?: string;
}

/** Calendar days from `day` to `now`, local; a future day reads as 0. */
function daysSinceDay(day: string, now: number): number {
  const today = new Date(now);
  today.setHours(12, 0, 0, 0);
  return Math.max(0, Math.round((today.getTime() - Date.parse(day + "T12:00:00")) / 86_400_000));
}

/** Oldest first, undated last; then the larger count, then the path. */
function byOldest(a: StripRow, b: StripRow): number {
  if (a.since !== b.since) return !a.since ? 1 : !b.since ? -1 : a.since < b.since ? -1 : 1;
  return (b.count ?? 0) - (a.count ?? 0) || a.relPath.localeCompare(b.relPath);
}

/** The pages the strip and the board count: all but a plan closed without shipping. */
function livePages<P extends CardPage>(pages: readonly P[]): P[] {
  return pages.filter((p) => !closedWithoutShipping(p.plan_status));
}

/**
 * The strip's four lists, from the live listing. Every page counts but a plan
 * closed without shipping, whether or not the map placed it. A wait with no
 * parsed `since` lists under decisions and not under oldest.
 */
export function stripRows<P extends CardPage>(pages: readonly P[]): Record<Exclude<StripCell, "github">, StripRow[]> {
  const live = livePages(pages);
  const waits = live
    .filter((p) => (p.movesWaiting ?? 0) > 0)
    .map((p) => ({ relPath: p.relPath, count: p.movesWaiting, ...(p.waitingSince ? { since: p.waitingSince } : {}) }));
  return {
    decisions: [...waits].sort(byOldest),
    oldest: waits.filter((r) => r.since).sort(byOldest),
    steps: live.filter((p) => (p.movesYou ?? 0) > 0).map((p) => ({ relPath: p.relPath, count: p.movesYou })).sort(byOldest),
    shipped: live
      .filter((p) => p.plan_status === "shipped" && p.followups === "open")
      .map((p) => ({ relPath: p.relPath, ...(p.status_date ? { since: p.status_date } : {}) }))
      .sort(byOldest),
  };
}

/** What the strip and the board read off the listing, so an adopt repaints only on a change: an
 *  effort leaves the board with its last page, and its prose names any page by title. */
export function stripKey<P extends CardPage>(pages: readonly P[], waitsCounted: boolean): string {
  return JSON.stringify([waitsCounted, stripRows(pages), pages.map((p) => `${normalizeRelPath(p.relPath)}\u0000${pageTitle(p)}`).sort()]);
}

const STRIP_TITLES: Record<StripCell, string> = {
  decisions: "Open questions, oldest wait first",
  oldest: "Dated waits, oldest first",
  steps: "Pages with steps in a you lane",
  shipped: "Shipped plans with follow-ups open, oldest first",
  github: "What the GitHub check found in the ledger rows",
};

function stripCellHtml(cell: StripCell, value: string, label: string, tone: string, view: StripView, empty: boolean, extra: { note?: string; title?: string } = {}): string {
  const on = view.open === cell && !empty;
  return (
    `<button type="button" class="wiki-wm-cell${tone ? " " + tone : ""}${on ? " on" : ""}" data-wm-cell="${cell}" aria-expanded="${on}"${extra.title ? ` title="${esc(extra.title)}"` : ""}${empty ? " disabled" : ""}>` +
    `<b>${esc(value)}</b><span>${esc(label)}</span>${extra.note ?? ""}</button>`
  );
}

function drillHtml(items: readonly string[], cell: StripCell, view: StripView): string {
  const shown = view.expanded ? items : items.slice(0, STRIP_ROWS_SHOWN);
  const more = items.length - shown.length;
  return (
    `<div class="wiki-wm-drill" data-wm-drill="${cell}"><div class="wiki-wm-drill-title">${esc(STRIP_TITLES[cell])}</div>` +
    `<ol class="wiki-wm-drill-list">${shown.join("")}</ol>` +
    (more > 0 ? `<button type="button" class="wiki-wm-drill-more" data-wm-drill-more>+${more} more</button>` : "") +
    "</div>"
  );
}

function stripDrillHtml(rows: readonly StripRow[], cell: StripCell, view: StripView, now: number, byKey: ReadonlyMap<string, CardPage>, hrefFor: (rel: string) => string): string {
  const items = rows.map((r) => {
    const meta = [
      ...(r.count !== undefined ? [String(r.count)] : []),
      ...(r.since ? [`since ${r.since} · ${daysSinceDay(r.since, now)} d`] : []),
    ].join(" · ");
    return `<li class="wiki-wm-drill-row">${pageLinkHtml(r.relPath, byKey, hrefFor)}${meta ? ` <span class="wiki-wm-drill-meta">· ${esc(meta)}</span>` : ""}</li>`;
  });
  return drillHtml(items, cell, view);
}

// ── The GitHub check's cell (your-work board P2) ──────────────────────
const GH_CELL_LABEL = "ledger rows GitHub contradicts";
const GH_NOT_CURRENT = "From the last answer, not current";

const NOT_CHECKED_HTML: Record<Exclude<NotCheckedReason, "disabled" | "no-access">, string> = {
  "no-gh": "not checked: install <code>gh</code>",
  auth: "not checked: log in with <code>gh auth login</code>",
  sso: "not checked: authorize the token for the organization (<code>gh auth refresh</code>)",
};

function notCheckedHtml(reason: Exclude<NotCheckedReason, "disabled">, repos: readonly string[]): string {
  if (reason === "no-access") return `not checked: your <code>gh</code> login cannot see ${esc(repos[0] ?? "a repo")} (<code>gh auth status</code>)`;
  return NOT_CHECKED_HTML[reason];
}

function ghPrLinkHtml(repo: string, pr: number): string {
  return `<a class="wiki-wm-link" href="https://github.com/${esc(repo)}/pull/${pr}" target="_blank" rel="noopener noreferrer">#${pr}</a>`;
}

/** The check's counts and no conclusion: every sentence that drew one was false on some answer. */
function ghCounts(body: WorkMapChecksBody): string {
  return `${body.checked} checked · ${body.compared} with a state to compare · ${body.unchecked} not checked · ${body.unlinked} with no PR link read · ${body.skipped} skipped`;
}

/** One labelled group. A folded one is a heading and a `+N more`; open, it takes the row window. */
function ghGroupHtml(key: string, label: string, items: readonly string[], fold: "shut" | "window" | "all", moreLabel: string): string {
  if (!items.length) return "";
  const shown = fold === "all" ? items : fold === "window" ? items.slice(0, STRIP_ROWS_SHOWN) : [];
  const more = items.length - shown.length;
  const moreHtml = more > 0 ? `<button type="button" class="wiki-wm-drill-more" data-wm-gh-more="${key}" aria-label="+${more} more ${esc(moreLabel)}">+${more} more</button>` : "";
  return (
    `<div class="wiki-wm-drill-group" data-wm-gh-group="${key}"><div class="wiki-wm-drill-group-head"><span>${esc(label)} · ${items.length}</span>${fold === "shut" ? ` ${moreHtml}` : ""}</div>` +
    (shown.length ? `<ol class="wiki-wm-drill-list">${shown.join("")}</ol>` : "") +
    (fold === "shut" ? "" : moreHtml) +
    "</div>"
  );
}

/** The cell's list, or "" with nothing to list. The contradictions are always all shown. */
function ghDrillHtml(body: WorkMapChecksBody, view: StripView, stale: boolean, byKey: ReadonlyMap<string, CardPage>, hrefFor: (rel: string) => string): string {
  const row = (page: string, meta: string) => `<li class="wiki-wm-drill-row">${pageLinkHtml(page, byKey, hrefFor)} <span class="wiki-wm-drill-meta">· ${meta}</span></li>`;
  if (!body.contradictions.length && !body.uncheckedRows.length && !body.unlinkedRows.length) return "";
  const fold = (g: GhFoldedGroup) => view.ghGroups?.[g] ?? "shut";
  return (
    `<div class="wiki-wm-drill" data-wm-drill="github"><div class="wiki-wm-drill-title">${esc(STRIP_TITLES.github)}</div>` +
    (stale ? `<p class="wiki-wm-drill-stale">${GH_NOT_CURRENT}</p>` : "") +
    `<p class="wiki-wm-drill-counts">${esc(ghCounts(body))}</p>` +
    ghGroupHtml(
      "contradictions",
      "GitHub contradicts",
      body.contradictions.map((c) =>
        row(c.page, `says ${esc(c.rowState)} · GitHub: ${ghPrLinkHtml(c.repo, c.pr)} ${c.ghState === "MERGED" ? esc(`merged ${shortDay(c.mergedAt)}`.trim()) : "closed without merge"}`),
      ),
      "all",
      "",
    ) +
    ghGroupHtml("unchecked", "Not checked", body.uncheckedRows.map((r) => row(r.page, `${ghPrLinkHtml(r.repo, r.pr)} not checked`)), fold("unchecked"), "not checked") +
    ghGroupHtml("unlinked", "No PR link read", body.unlinkedRows.map((r) => row(r.page, `${esc(r.label)}: no PR link in a column the check reads`)), fold("unlinked"), "with no PR link read") +
    "</div>"
  );
}

/** The fifth cell and its list, or null when the check is off here. */
function ghCell(checks: ChecksView, view: StripView, byKey: ReadonlyMap<string, CardPage>, hrefFor: (rel: string) => string, runAtMs: number | undefined): { cell: string; drill: string } | null {
  const { body } = checks;
  if (!body) {
    return checks.failed
      ? { cell: stripCellHtml("github", "—", GH_CELL_LABEL, "muted", view, true, { note: '<span class="wiki-wm-cell-note">not checked</span>' }), drill: "" }
      : { cell: stripCellHtml("github", "checking…", GH_CELL_LABEL, "muted unset", view, true), drill: "" };
  }
  const notChecked = body.notChecked;
  const reason = notChecked?.reason;
  if (reason === "disabled") return null;
  const n = body.contradictions.length;
  const notes: string[] = [];
  // The rows are read from the pages, so an older answer's count still stands, muted.
  const older = checks.answerRunAt !== runAtMs;
  // A hung `gh` answers from states past their hour, so the retries can end here.
  const notRefreshed = !!body.refreshing && !checks.retrying;
  const stale = older || !!checks.failed || notRefreshed;
  const drill = ghDrillHtml(body, view, stale, byKey, hrefFor);
  // Rows but no PR to ask about: that 0 would read as all clear too.
  const noneToAsk = body.checked === 0 && !reason && body.unchecked === 0 && body.unlinked + body.skipped > 0;
  // A 0 with nothing read would read as all clear.
  const nothingRead = body.checked === 0 && (!!reason || body.unchecked > 0 || noneToAsk);
  if (reason) notes.push(`<span class="wiki-wm-cell-note">${notCheckedHtml(reason, notChecked?.repos ?? [])}</span>`);
  // A failed fetch outranks what the older answer said about itself; a remedy already says it.
  if (checks.failed) {
    if (!reason) notes.push('<span class="wiki-wm-cell-note">not checked</span>');
  } else if (older) notes.push('<span class="wiki-wm-cell-note">checking…</span>');
  else if (body.refreshing && checks.retrying) notes.push('<span class="wiki-wm-cell-note">refreshing</span>');
  else {
    if (notRefreshed && !nothingRead) notes.push('<span class="wiki-wm-cell-note">not refreshed</span>');
    if (!reason && body.unchecked > 0) notes.push(`<span class="wiki-wm-cell-note">${body.unchecked} not checked</span>`);
    else if (noneToAsk) notes.push(`<span class="wiki-wm-cell-note">${body.unlinked ? `${body.unlinked} with no PR link read` : `${body.skipped} skipped`}</span>`);
  }
  const tone = [stale || nothingRead ? "muted" : n > 0 ? "bad" : "", reason ? "wide" : ""].filter(Boolean).join(" ");
  const cell = stripCellHtml("github", nothingRead ? "—" : String(n), GH_CELL_LABEL, tone, view, !drill, {
    note: notes.join(""),
    title: `${stale ? `${GH_NOT_CURRENT} · ` : ""}${ghCounts(body)}`,
  });
  return { cell, drill };
}

function healthStripHtml<P extends CardPage>(
  pages: readonly P[],
  waitsCounted: boolean,
  view: StripView,
  now: number,
  byKey: ReadonlyMap<string, CardPage>,
  hrefFor: (rel: string) => string,
  checks?: ChecksView,
  runAtMs?: number,
): string {
  const rows = stripRows(pages);
  const sum = (rs: readonly StripRow[]) => rs.reduce((n, r) => n + (r.count ?? 0), 0);
  const decisions = sum(rows.decisions);
  const oldest = rows.oldest[0]?.since ? daysSinceDay(rows.oldest[0].since, now) : null;
  const cells = [
    waitsCounted
      ? stripCellHtml("decisions", String(decisions), "decisions wait on you", decisions > STRIP_DECISIONS_WARN ? "warn" : "", view, !rows.decisions.length)
      : stripCellHtml("decisions", "owner not set", "decisions wait on you", "unset", view, true),
    waitsCounted
      ? stripCellHtml("oldest", oldest === null ? "—" : `${oldest} d`, "oldest wait", oldest !== null && oldest > STRIP_OLDEST_WARN_DAYS ? "warn" : "", view, oldest === null)
      : stripCellHtml("oldest", "owner not set", "oldest wait", "unset", view, true),
    stripCellHtml("steps", String(sum(rows.steps)), "steps in your lanes", "", view, !rows.steps.length),
    stripCellHtml("shipped", String(rows.shipped.length), "shipped, follow-ups open", "muted", view, !rows.shipped.length),
  ];
  const gh = checks ? ghCell(checks, view, byKey, hrefFor, runAtMs) : null;
  if (gh) cells.push(gh.cell);
  const open = view.open;
  let drill = "";
  if (open === "github") {
    drill = gh?.drill ?? "";
  } else if (open) {
    const waitCell = open === "decisions" || open === "oldest";
    const list = waitCell && !waitsCounted ? [] : rows[open];
    if (list.length) drill = stripDrillHtml(list, open, view, now, byKey, hrefFor);
  }
  return (
    '<div class="wiki-wm-section-title">Waiting on you, counted from the pages now</div>' +
    `<div class="wiki-wm-strip">${cells.join("")}</div>` +
    drill
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
 *  stored on both ends), left end the earlier theme that stores it, with its
 *  why. `themes` come in the card's lane order. Rows are picked greedily so a
 *  hub no longer fills every row: each next row is the remaining pair whose
 *  busier end is in the fewest rows so far, then the fewest rows over both
 *  ends, then the earliest pair in lane order. Greedy, not optimal: on some
 *  graphs a theme lands in one row more than the best pick allows (t0 linked
 *  to t1–t4 and t1 to t2–t4 puts t0 in 4 rows; 3 is possible). */
export function themeConnections<T extends { id: string; related: readonly { id: string; why: string }[] }>(
  themes: readonly T[],
): { a: T; b: T; why: string }[] {
  const at = new Map<string, number>();
  themes.forEach((t, i) => at.has(t.id) || at.set(t.id, i));
  const pairs = new Map<string, { a: T; b: T; why: string; lo: number; hi: number }>();
  themes.forEach((a, i) => {
    for (const r of a.related) {
      const j = at.get(r.id);
      if (j === undefined || r.id === a.id) continue;
      const k = [a.id, r.id].sort().join("\u0000");
      if (!pairs.has(k)) pairs.set(k, { a, b: themes[j]!, why: r.why, lo: Math.min(i, j), hi: Math.max(i, j) });
    }
  });
  const rest = [...pairs.values()].sort((x, y) => x.lo - y.lo || x.hi - y.hi);
  const uses = new Map<string, number>();
  const n = (id: string) => uses.get(id) ?? 0;
  const out: { a: T; b: T; why: string }[] = [];
  while (rest.length) {
    let best = 0;
    let bestMax = Infinity;
    let bestSum = Infinity;
    rest.forEach((c, i) => {
      const max = Math.max(n(c.a.id), n(c.b.id));
      const sum = n(c.a.id) + n(c.b.id);
      if (max < bestMax || (max === bestMax && sum < bestSum)) [best, bestMax, bestSum] = [i, max, sum];
    });
    const { a, b, why } = rest.splice(best, 1)[0]!;
    for (const id of [a.id, b.id]) uses.set(id, n(id) + 1);
    out.push({ a, b, why });
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
export function needCountHtml(kind: string, count: number): string {
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

/** The weekly bar strip: the newest `shown` stored weeks (the card's
 *  {@link THEME_STRIP_WEEKS}; the theme page passes every stored week),
 *  each bar's height a step of the strip's busiest week. Older weeks holding
 *  sources show as «+N earlier». The week holding `runAtMs` (Oslo) is framed
 *  `current` while it has not ended at `now` (Oslo; absent, the run's own
 *  day); once it has, the run missed its last days and it reads `partial`. A
 *  `partial` week is framed too, so an empty one reads apart from a full
 *  empty week. */
export function weeklyStripHtml(weekly: readonly ThemeWeek[], runAtMs?: number, now?: number, shown: number = THEME_STRIP_WEEKS): string {
  const sorted = [...weekly].sort((a, b) => a.start.localeCompare(b.start));
  const weeks = sorted.slice(-Math.max(1, shown));
  if (!weeks.length) return "";
  const earlier = sorted.slice(0, sorted.length - weeks.length);
  const earlierTotal = earlier.reduce((n, w) => n + w.count, 0);
  const runDay = runAtMs === undefined ? null : osloDay(runAtMs);
  const nowDay = now === undefined ? runDay : osloDay(now);
  const holdsRun = (w: ThemeWeek) => runDay !== null && w.start <= runDay && runDay <= plusDays(w.start, 6);
  const isCurrent = (w: ThemeWeek) => holdsRun(w) && nowDay !== null && nowDay <= plusDays(w.start, 6);
  const isPartial = (w: ThemeWeek) => !!w.partial || holdsRun(w);
  const max = Math.max(1, ...weeks.map((w) => w.count));
  const total = weeks.reduce((n, w) => n + w.count, 0);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const bars = weeks
    .map((w) => {
      const level = w.count === 0 ? 0 : Math.max(1, Math.ceil((w.count / max) * 4));
      const current = isCurrent(w);
      const mark = current ? " current" : isPartial(w) ? " partial" : "";
      const label =
        `${w.week} (from ${w.start}): ${plural(w.count, "source")}` +
        (current ? " so far, week still running" : isPartial(w) ? ", may miss days" : "");
      return `<span class="wiki-wm-slot${mark}" title="${esc(label)}"><span class="wiki-wm-week lvl-${level}"></span></span>`;
    })
    .join("");
  const partials = weeks.filter((w) => isPartial(w) && !isCurrent(w)).length;
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
    weeklyStripHtml(e.weekly, runAtMs, now) +
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
