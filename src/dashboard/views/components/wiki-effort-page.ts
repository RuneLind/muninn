/**
 * The effort page (plan `muninn-wiki-work-map`, P3): `?effort=<id>` in the
 * article pane, over the stored `.work-map.json` joined to the live listing.
 * Pure and DOM-free — the fetch, the URL state and the clicks live in
 * `wiki-browser.ts` (`renderEffort`).
 *
 * Every string in the map is model output, so all of it is escaped; prose
 * markers go through the card's `proseHtml`, so a page the listing no longer
 * holds reads as its file stem.
 */

import { joinWorkMap, type JoinedEffort, type JoinedEffortPage, type JoinedWorkMap } from "../../../wiki/work-map/join.ts";
import { declaredEffortOf, EFFORT_ID_RE, osloDay, slugifyEffortId } from "../../../wiki/work-map/ids.ts";
import type { WorkMap, WorkMapDaily, WorkMapRetired } from "../../../wiki/work-map/schema.ts";
import { normalizeRelPath } from "../../../wiki/rel-path.ts";
import { escHtml as esc } from "./escape.ts";
import { isNestedEffort, lastActiveDays, needKey, proseHtml, type CardPage } from "./wiki-work-card.ts";

/** The URL parameter that names an effort. */
export const EFFORT_PARAM = "effort";
/** The windows `dailyActivity` counts over: commits for the last 28 days,
 *  sessions for the last 8 (`WORK_WINDOW_MS`). Both are rolling, so each
 *  reaches into one more Oslo calendar day, and a DST change moves that by
 *  one: the strip spans 28–30 days. */
export const STRIP_DAYS = 28;
export const STRIP_SESSION_DAYS = 8;
const DAY_MS = 86_400_000;
/** Lineage indent stops growing past this depth. */
const MAX_INDENT = 4;

/** The listing fields the page reads. */
export interface EffortPageListing extends CardPage {
  plan_status?: string;
  /** The page's declared effort (frontmatter `effort:`, P6). */
  effort?: string;
}

export interface EffortViewInput<P extends EffortPageListing> {
  map: WorkMap;
  pages: readonly P[];
  id: string;
  /** The wiki's display name for the first crumb. */
  wiki: string;
  /** The overview URL (the Your work card's view). */
  startHref: string;
  hrefFor(relPath: string): string;
  effortHref(id: string): string;
  /** A page's plan-status pill, the reader's own spelling; "" for none. */
  pill?(page: P): string;
  /** Needs-you keys marked done on the card for this run. */
  done?: ReadonlySet<string>;
  now: number;
}

/**
 * The effort id an `?effort=` value names: null for an empty or blank value
 * (the URL means the start view); a value `EFFORT_ID_RE` accepts as typed, so
 * a stored id the slug would change (`a--b`) is never rewritten; else its slug,
 * so `Work-Map` opens `work-map`. A value with no slug (`日本語`, `🚀`) stays as
 * typed and reads as a dropped id.
 */
export function canonicalEffortParam(raw: string | null): string | null {
  if (raw === null || raw.trim() === "") return null;
  if (EFFORT_ID_RE.test(raw)) return raw;
  return slugifyEffortId(raw) || raw;
}

export type EffortLookup<P> =
  | { kind: "found"; effort: JoinedEffort<P> }
  | { kind: "retired"; retired: WorkMapRetired }
  | { kind: "dropped"; matches: JoinedEffort<P>[] };

/**
 * Find `id` in the joined map. A missing id is `dropped`; the stored map keeps
 * no record of a dropped effort's pages, so it is matched to a current effort
 * only when one of that effort's aliases, or its name, slugifies to the id.
 */
export function lookupEffort<P>(map: JoinedWorkMap<P>, id: string): EffortLookup<P> {
  const retired = (rid: string) => map.retired?.find((r) => r.id === rid);
  // An exact id wins: the schema accepts ids the slug changes (`a--b`).
  const exact = map.efforts.find((e) => e.id === id);
  if (exact) return { kind: "found", effort: exact };
  const retiredExact = retired(id);
  if (retiredExact) return { kind: "retired", retired: retiredExact };
  // Otherwise `id` is compared as its slug; one that is no valid effort id
  // (empty slug, too long) is dropped with no match, so an empty name slug
  // never matches.
  const key = slugifyEffortId(id);
  if (!EFFORT_ID_RE.test(key)) return { kind: "dropped", matches: [] };
  const effort = map.efforts.find((e) => e.id === key);
  if (effort) return { kind: "found", effort };
  // A retired id (P6) answers before the dropped fallback.
  const retiredSlug = retired(key);
  if (retiredSlug) return { kind: "retired", retired: retiredSlug };
  const matches = map.efforts.filter((e) => slugifyEffortId(e.name) === key || e.aliases.some((a) => slugifyEffortId(a) === key));
  return { kind: "dropped", matches };
}

export interface LineageRow<P> {
  page: JoinedEffortPage<P>;
  depth: number;
}

/**
 * The effort's pages in lineage order: roots (no `derivedFrom`, or one naming
 * a page outside the effort) in map order, each followed by its descendants
 * depth-first, children in map order. A page left unvisited (a `derivedFrom`
 * cycle) follows as a root, so every page shows once.
 */
export function lineageOrder<P>(pages: readonly JoinedEffortPage<P>[]): LineageRow<P>[] {
  const key = (rel: string) => normalizeRelPath(rel);
  const inEffort = new Set(pages.map((p) => key(p.id)));
  const childrenOf = new Map<string, JoinedEffortPage<P>[]>();
  for (const p of pages) {
    if (p.derivedFrom === undefined || !inEffort.has(key(p.derivedFrom)) || key(p.derivedFrom) === key(p.id)) continue;
    const k = key(p.derivedFrom);
    const list = childrenOf.get(k) ?? [];
    list.push(p);
    childrenOf.set(k, list);
  }
  const out: LineageRow<P>[] = [];
  const seen = new Set<string>();
  const walk = (p: JoinedEffortPage<P>, depth: number) => {
    if (seen.has(key(p.id))) return;
    seen.add(key(p.id));
    out.push({ page: p, depth });
    for (const c of childrenOf.get(key(p.id)) ?? []) walk(c, depth + 1);
  };
  const isRoot = (p: JoinedEffortPage<P>) =>
    p.derivedFrom === undefined || !inEffort.has(key(p.derivedFrom)) || key(p.derivedFrom) === key(p.id);
  for (const p of pages) if (isRoot(p)) walk(p, 0);
  for (const p of pages) walk(p, 0);
  return out;
}

export interface StripDay {
  day: string;
  commits: number;
  /** null before the sessions window: that day counts commits only. */
  sessions: number | null;
}

/** `YYYY-MM-DD` minus `n` calendar days. */
function minusDays(day: string, n: number): string {
  const t = Date.parse(day + "T12:00:00Z") - n * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * The Oslo days the run's windows touch, oldest first: from the day 28 × 24 h
 * before the run (or an older stored day) to the run's own day. A day missing
 * from `daily` (only active days are stored) reads as zero.
 */
export function activityStrip(
  daily: readonly WorkMapDaily[],
  runAtMs: number,
  sessionsSinceMs: number = runAtMs - STRIP_SESSION_DAYS * DAY_MS,
): StripDay[] {
  const end = osloDay(runAtMs);
  const from = sessionsFromDay(daily, runAtMs, sessionsSinceMs);
  let start = osloDay(runAtMs - STRIP_DAYS * DAY_MS);
  for (const d of daily) if (d.day < start) start = d.day;
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const out: StripDay[] = [];
  for (let day = start; day <= end; day = minusDays(day, -1)) {
    const d = byDay.get(day);
    out.push({ day, commits: d?.commits ?? 0, sessions: day >= from ? (d?.sessions ?? 0) : null });
  }
  return out;
}

/**
 * The first day that counts sessions: the earlier of the sessions memo's first
 * Oslo day (`sessionsSinceMs`) and the oldest stored day with a session, never
 * after the run's own day. Every day from it on carries sessions, every day
 * before it `null`, so no stored session sits in the commits-only run.
 */
export function sessionsFromDay(
  daily: readonly WorkMapDaily[],
  runAtMs: number,
  sessionsSinceMs: number = runAtMs - STRIP_SESSION_DAYS * DAY_MS,
): string {
  let from = osloDay(Math.min(sessionsSinceMs, runAtMs));
  for (const d of daily) if (d.sessions > 0 && d.day < from) from = d.day;
  return from;
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** One day's tooltip: no "0 sessions" — a day with commits and no session
 *  reported says only what it has. */
export function stripDayLabel(d: StripDay): string {
  const parts: string[] = [];
  if (d.commits) parts.push(plural(d.commits, "commit"));
  if (d.sessions) parts.push(plural(d.sessions, "session"));
  return `${d.day}: ${parts.length ? parts.join(", ") : "no activity"}`;
}

export function activityStripHtml(daily: readonly WorkMapDaily[], runAtMs: number, sessionsSinceMs?: number): string {
  const days = activityStrip(daily, runAtMs, sessionsSinceMs);
  const from = sessionsFromDay(daily, runAtMs, sessionsSinceMs);
  const maxCommits = Math.max(1, ...days.map((d) => d.commits));
  const commits = days.reduce((n, d) => n + d.commits, 0);
  const activeDays = days.filter((d) => d.commits > 0 || (d.sessions ?? 0) > 0).length;
  const sessions = days.reduce((n, d) => n + (d.sessions ?? 0), 0);
  const cell = (d: StripDay) => {
    const level = d.commits === 0 ? 0 : Math.max(1, Math.ceil((d.commits / maxCommits) * 4));
    const label = stripDayLabel(d);
    return (
      `<span class="wiki-ef-day lvl-${level}${d.sessions === null ? " old" : ""}" title="${esc(label)}">` +
      (d.sessions ? `<span class="wiki-ef-sess" aria-hidden="true"></span>` : "") +
      "</span>"
    );
  };
  const split = days.findIndex((d) => d.day >= from);
  const old = days.slice(0, split);
  const recent = days.slice(split);
  // The text names the session run's first CELL, which a memo older than the
  // strip would otherwise put before the strip's first day.
  const since = recent[0]!.day;
  const run = (cls: string, label: string, ds: StripDay[]) =>
    ds.length === 0
      ? ""
      : `<div class="wiki-ef-run${cls}" style="--ef-cells:${ds.length}"><div class="wiki-ef-run-label">${label}</div><div class="wiki-ef-cells">${ds.map(cell).join("")}</div></div>`;
  const summary =
    activeDays === 0
      ? "No commits or sessions in the last 28 days"
      : `${plural(commits, "commit")} on ${plural(activeDays, "day")}` + (sessions ? ` · ${plural(sessions, "session")} since ${since}` : "");
  return (
    '<section class="wiki-ef-section wiki-ef-activity"><h2 class="wiki-ef-h">Activity, last 28 days</h2>' +
    `<div class="wiki-ef-strip" role="img" tabindex="0" aria-label="${esc(`${summary}.${old.length ? ` Days before ${since} count commits only.` : ""}`)}">` +
    run(" old", "earlier · commits only", old) +
    run("", `since ${esc(since)} · commits and sessions`, recent) +
    "</div>" +
    `<div class="wiki-ef-strip-foot"><span>${esc(days[0]!.day)}</span><span class="wiki-ef-strip-sum">${esc(activeDays === 0 ? summary + "." : summary)}</span><span>${esc(days[days.length - 1]!.day)}</span></div>` +
    `<div class="wiki-ef-legend">Darker means more commits; a dot marks a day with a session. Sessions are counted from ${esc(since)} on.</div>` +
    "</section>"
  );
}

// ── The view ──────────────────────────────────────────────────────────
export interface EffortView {
  /** The article pane's HTML. */
  article: string;
  /** The Connections pane's HTML. */
  connections: string;
}

function pageTitle(page: CardPage): string {
  return page.displayTitle || page.title || (page.relPath.split("/").pop() || page.relPath).replace(/\.[^.]+$/, "");
}

function stateHtml(state: string): string {
  return `<span class="wiki-wm-state wm-state-${esc(state)}">${esc(state)}</span>`;
}

function effortLinkHtml(e: { id: string; name: string }, href: (id: string) => string, cls = "wiki-ef-elink"): string {
  return `<a class="${cls}" href="${esc(href(e.id))}" data-effort-link="${esc(e.id)}">${esc(e.name)}</a>`;
}

function crumbsHtml(input: { wiki: string; startHref: string }, tail: string[]): string {
  return (
    '<nav class="wiki-ef-crumbs" aria-label="Breadcrumb">' +
    `<a class="wiki-bc-wiki" href="${esc(input.startHref)}" title="Back to the overview"><span aria-hidden="true">⌂</span> ${esc(input.wiki || "Wiki")}</a>` +
    '<span class="wiki-ef-sep" aria-hidden="true">›</span>' +
    `<a class="wiki-ef-crumb" href="${esc(input.startHref)}" data-effort-home>Efforts</a>` +
    tail.map((t) => `<span class="wiki-ef-sep" aria-hidden="true">›</span>${t}`).join("") +
    "</nav>"
  );
}

function activeLabel(days: number | null): string {
  if (days === null) return "";
  return days === 0 ? "active today" : days === 1 ? "active yesterday" : `active ${days} d ago`;
}

/** The effort page, or the «no longer in the map» page for an id the map
 *  does not hold. */
export function effortView<P extends EffortPageListing>(input: EffortViewInput<P>): EffortView {
  const joined = joinWorkMap(input.map, input.pages);
  const byKey = new Map<string, CardPage>(input.pages.map((p) => [normalizeRelPath(p.relPath), p]));
  const prose = (s: string) => proseHtml(s, byKey, input.hrefFor);
  const found = lookupEffort(joined, input.id);
  if (found.kind === "dropped") return droppedView(input, found.matches);
  if (found.kind === "retired") return retiredView(input, found.retired);
  const e = found.effort;
  const efforts = joined.efforts;
  // The card's rule: a parent chain that cycles or dangles leaves the effort top-level.
  const parent = isNestedEffort(e, efforts) ? efforts.find((x) => x.id === e.parent) : undefined;
  const themes = joined.themes.filter((t) => t.efforts.includes(e.id));
  const tail: string[] = [];
  tail.push(themes[0] ? `<span class="wiki-ef-crumb-theme">${esc(themes[0].name)}</span>` : '<span class="wiki-ef-crumb-theme">No theme</span>');
  if (parent) tail.push(effortLinkHtml(parent, input.effortHref, "wiki-ef-crumb"));

  const stored = input.map.efforts.find((x) => x.id === e.id);
  const gone = (stored?.pages.length ?? e.pages.length) - e.pages.length;
  const meta: string[] = [stateHtml(e.state)];
  meta.push(`<span class="wiki-ef-meta">${esc(plural(e.pages.length, "page"))}${gone > 0 ? esc(` (${gone} no longer in the wiki)`) : ""}</span>`);
  meta.push(`<span class="wiki-ef-meta" title="How sure the organize run was that these pages are one piece of work">confidence ${esc(confidenceLabel(e.confidence))}</span>`);
  const active = activeLabel(lastActiveDays(e, input.now));
  if (active) meta.push(`<span class="wiki-ef-meta">${esc(active)}</span>`);

  const inShort =
    e.oneLine || e.next
      ? '<section class="wiki-ef-tldr"><div class="wiki-ef-tldr-label">In short</div>' +
        (e.oneLine ? `<p class="wiki-ef-oneline">${prose(e.oneLine)}</p>` : "") +
        (e.next ? `<p class="wiki-ef-next"><span class="wiki-ef-next-label">Next:</span> ${prose(e.next)}</p>` : "") +
        "</section>"
      : "";

  const article =
    `<div class="wiki-effort" id="wikiEffortPage" data-effort="${esc(e.id)}">` +
    '<div class="wiki-article-head">' +
    crumbsHtml(input, tail) +
    `<h1>${esc(e.name)}</h1>` +
    `<div class="wiki-meta-row wiki-ef-metarow">${meta.join("")}</div>` +
    "</div>" +
    inShort +
    needsHtml(joined, input.map, e.id, input.done ?? new Set(), prose) +
    subEffortsHtml(e, efforts, input.effortHref) +
    pagesHtml(e, input) +
    activityStripHtml(e.daily, input.map.runAtMs, input.map.coverage.sessionsSinceMs) +
    (e.why ? `<section class="wiki-ef-section"><h2 class="wiki-ef-h">Why together</h2><p class="wiki-ef-why">${prose(e.why)}</p></section>` : "") +
    `<div class="wiki-ef-foot">From the work map organized ${esc(new Date(input.map.runAtMs).toLocaleString())}.</div>` +
    "</div>";

  return { article: withFocusKeys(article, "a"), connections: withFocusKeys(connectionsHtml(e, joined, themes, input, prose), "c") };
}

/** The opening tag of every element a keyboard reaches: links, buttons and
 *  anything with a `tabindex`. Attribute values are escaped, so no `>` sits
 *  inside one. */
const FOCUSABLE_TAG_RE = /<(a|button)\b([^>]*)>|<(\w+)\b([^>]*\btabindex="[^"]*"[^>]*)>/g;

/**
 * Give every focusable element a `data-focus-key`, so a repaint can put focus
 * back on the same control (`writeEffortPanes`). The key is the element's id,
 * else its tag, first class and the page or effort it names, never its href (a
 * facet change rewrites every href); a repeat gets `~n`, so keys are unique
 * within the pane.
 */
export function withFocusKeys(html: string, pane: string): string {
  const seen = new Map<string, number>();
  return html.replace(FOCUSABLE_TAG_RE, (_tag, t1: string | undefined, a1: string | undefined, t2: string | undefined, a2: string | undefined) => {
    const name = (t1 ?? t2)!;
    const attrs = (a1 ?? a2)!;
    const attr = (n: string) => attrs.match(new RegExp(`\\s${n}="([^"]*)"`))?.[1];
    const id = attr("id");
    const target = attr("data-relpath") ?? attr("data-effort-link") ?? (/\sdata-effort-home\b/.test(attrs) ? "home" : "");
    const base = `${pane}:` + (id ? `#${id}` : `${name}.${(attr("class") ?? "").split(" ")[0]}|${target}`);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `<${name}${attrs} data-focus-key="${n ? `${base}~${n}` : base}">`;
  });
}

function confidenceLabel(c: number): string {
  if (!Number.isFinite(c)) return "unknown";
  return c <= 1 ? `${Math.round(c * 100)}%` : String(c);
}

function needsHtml<P>(map: JoinedWorkMap<P>, raw: WorkMap, id: string, done: ReadonlySet<string>, prose: (s: string) => string): string {
  const items = map.needsYou.map((n, i) => ({ n, key: needKey(raw.needsYou[i]!) })).filter(({ n }) => n.effort === id);
  if (!items.length) return "";
  const open = items.filter(({ key }) => !done.has(key));
  const doneCount = items.length - open.length;
  return (
    '<section class="wiki-ef-section"><h2 class="wiki-ef-h">Needs you</h2>' +
    (open.length
      ? '<ul class="wiki-ef-needs">' +
        open
          .map(
            ({ n }) =>
              '<li class="wiki-ef-need">' +
              `<div class="wiki-ef-need-head"><span class="wiki-ef-kind">${esc(n.kind)}</span><span class="wiki-ef-need-title">${prose(n.title)}</span></div>` +
              (n.why ? `<div class="wiki-ef-need-why">${prose(n.why)}</div>` : "") +
              (n.action ? `<div class="wiki-ef-need-action">${prose(n.action)}</div>` : "") +
              "</li>",
          )
          .join("") +
        "</ul>"
      : "") +
    (doneCount ? `<div class="wiki-ef-note">${esc(plural(doneCount, "item"))} marked done on the Your work card.</div>` : "") +
    "</section>"
  );
}

function subEffortsHtml<P>(e: JoinedEffort<P>, efforts: readonly JoinedEffort<P>[], href: (id: string) => string): string {
  // Every child whose crumb names this effort (`isNestedEffort`), including a
  // Moving child the card lifts top-level from a closed-lane parent.
  const all = efforts.filter((x) => x.parent === e.id && isNestedEffort(x, efforts));
  if (!all.length) return "";
  return (
    `<section class="wiki-ef-section"><h2 class="wiki-ef-h">Sub-efforts <span class="wiki-ef-count">${all.length}</span></h2><ul class="wiki-ef-subs">` +
    all
      .map(
        (s) =>
          `<li class="wiki-ef-sub">${effortLinkHtml(s, href)}${stateHtml(s.state)}<span class="wiki-ef-meta">${esc(plural(s.pages.length, "page"))}</span></li>`,
      )
      .join("") +
    "</ul></section>"
  );
}

function pagesHtml<P extends EffortPageListing>(e: JoinedEffort<P>, input: EffortViewInput<P>): string {
  const rows = lineageOrder(e.pages);
  if (!rows.length) {
    return '<section class="wiki-ef-section"><h2 class="wiki-ef-h">Pages</h2><div class="wiki-ef-note">None of this effort’s pages are in the wiki any more.</div></section>';
  }
  const titleOf = new Map(e.pages.map((p) => [normalizeRelPath(p.id), pageTitle(p.page)]));
  return (
    `<section class="wiki-ef-section"><h2 class="wiki-ef-h">Pages <span class="wiki-ef-count">${rows.length}</span></h2><ol class="wiki-ef-pages">` +
    rows
      .map(({ page, depth }) => {
        const from = page.derivedFrom !== undefined && depth > 0 ? titleOf.get(normalizeRelPath(page.derivedFrom)) : undefined;
        const pill = input.pill ? input.pill(page.page) : "";
        return (
          `<li class="wiki-ef-page" style="--ef-depth:${Math.min(depth, MAX_INDENT)}" data-depth="${depth}"${from ? ` title="${esc(`Derived from ${from}`)}"` : ""}>` +
          (depth > 0 ? '<span class="wiki-ef-branch" aria-hidden="true">↳</span>' : "") +
          `<a class="wiki-ef-plink" href="${esc(input.hrefFor(page.id))}" data-relpath="${esc(page.id)}">${esc(pageTitle(page.page))}</a>` +
          `<span class="wiki-ef-role">${esc(page.role)}</span>` +
          pill +
          "</li>"
        );
      })
      .join("") +
    "</ol></section>"
  );
}

function connectionsHtml<P>(
  e: JoinedEffort<P>,
  map: JoinedWorkMap<P>,
  themes: { name: string; efforts: string[] }[],
  input: { effortHref(id: string): string },
  prose: (s: string) => string,
): string {
  const byId = new Map(map.efforts.map((x) => [x.id, x]));
  const related = e.related.filter((r) => r.id !== e.id);
  const relatedHtml = related.length
    ? related
        .map((r) => {
          const target = byId.get(r.id);
          return (
            '<li class="wiki-ef-conn">' +
            (target
              ? `${effortLinkHtml(target, input.effortHref)}${stateHtml(target.state)}`
              : `<span class="wiki-ef-conn-gone">${esc(r.id)}</span><span class="wiki-ef-meta">no longer in the map</span>`) +
            (r.why ? `<div class="wiki-ef-conn-why">${prose(r.why)}</div>` : "") +
            "</li>"
          );
        })
        .join("")
    : "";
  let html =
    `<div class="wiki-conn-section"><div class="wiki-ef-conn-title">Related efforts (${related.length})</div>` +
    (relatedHtml ? `<ul class="wiki-ef-conns">${relatedHtml}</ul>` : '<div class="wiki-ef-conn-empty">None</div>') +
    "</div>";
  const shown = new Set([e.id, ...related.map((r) => r.id)]);
  if (!themes.length) {
    html += '<div class="wiki-conn-section"><div class="wiki-ef-conn-title">Theme</div><div class="wiki-ef-conn-empty">This effort is in no theme.</div></div>';
  }
  for (const t of themes) {
    const siblings = [...new Set(t.efforts)].filter((id) => !shown.has(id)).map((id) => byId.get(id)).filter((x): x is JoinedEffort<P> => !!x);
    html +=
      `<div class="wiki-conn-section"><div class="wiki-ef-conn-title">Also in ${esc(t.name)} (${siblings.length})</div>` +
      (siblings.length
        ? `<ul class="wiki-ef-conns">${siblings.map((s) => `<li class="wiki-ef-conn">${effortLinkHtml(s, input.effortHref)}${stateHtml(s.state)}</li>`).join("")}</ul>`
        : '<div class="wiki-ef-conn-empty">No other efforts</div>') +
      "</div>";
  }
  return html;
}

function droppedView<P extends EffortPageListing>(input: EffortViewInput<P>, matches: JoinedEffort<P>[]): EffortView {
  const article =
    `<div class="wiki-effort wiki-effort-gone" id="wikiEffortPage" data-effort="${esc(input.id)}">` +
    '<div class="wiki-article-head">' +
    crumbsHtml(input, [`<span class="wiki-ef-crumb-theme">${esc(input.id)}</span>`]) +
    `<h1>${esc(input.id)}</h1>` +
    "</div>" +
    '<p class="wiki-ef-gone">This effort is no longer in the map. A later organize run dropped or renamed it.</p>' +
    (matches.length
      ? `<p class="wiki-ef-gone-match">It may continue as ${matches.map((m) => effortLinkHtml(m, input.effortHref)).join(", ")}.</p>`
      : "") +
    `<p class="wiki-ef-gone-home"><a class="wiki-ef-crumb" href="${esc(input.startHref)}" data-effort-home>See every effort on the Your work card</a></p>` +
    "</div>";
  return {
    article: withFocusKeys(article, "a"),
    connections: '<div class="wiki-ef-conn-empty">This effort is no longer in the map.</div>',
  };
}

/**
 * A retired effort (P6): its name, its last-active date and the live
 * listing's pages that declare it. The map stores no pages for it, so the
 * listing is the only page list there is.
 */
function retiredView<P extends EffortPageListing>(input: EffortViewInput<P>, r: WorkMapRetired): EffortView {
  const declaring = input.pages
    .filter((p) => declaredEffortOf(p) === r.id)
    .sort((a, b) => pageTitle(a).localeCompare(pageTitle(b)));
  const last = r.lastActive > 0 ? osloDay(r.lastActive) : null;
  const pages = declaring.length
    ? `<section class="wiki-ef-section"><h2 class="wiki-ef-h">Pages that declare it <span class="wiki-ef-count">${declaring.length}</span></h2><ol class="wiki-ef-pages">` +
      declaring
        .map(
          (p) =>
            '<li class="wiki-ef-page" style="--ef-depth:0" data-depth="0">' +
            `<a class="wiki-ef-plink" href="${esc(input.hrefFor(p.relPath))}" data-relpath="${esc(p.relPath)}">${esc(pageTitle(p))}</a>` +
            (input.pill ? input.pill(p) : "") +
            "</li>",
        )
        .join("") +
      "</ol></section>"
    : '<section class="wiki-ef-section"><h2 class="wiki-ef-h">Pages that declare it</h2><div class="wiki-ef-note">No page in the wiki declares it any more.</div></section>';
  const article =
    `<div class="wiki-effort wiki-effort-retired" id="wikiEffortPage" data-effort="${esc(r.id)}">` +
    '<div class="wiki-article-head">' +
    crumbsHtml(input, ['<span class="wiki-ef-crumb-theme">Retired</span>']) +
    `<h1>${esc(r.name)}</h1>` +
    `<div class="wiki-meta-row wiki-ef-metarow">${stateHtml("retired")}` +
    `<span class="wiki-ef-meta" data-effort-last-active>${esc(last ? `last active ${last}` : "no recorded activity")}</span></div>` +
    "</div>" +
    '<p class="wiki-ef-gone">This effort is retired: pages declare it, but none of them has been active lately. It comes back when one of them is.</p>' +
    pages +
    `<div class="wiki-ef-foot">From the work map organized ${esc(new Date(input.map.runAtMs).toLocaleString())}.</div>` +
    "</div>";
  return {
    article: withFocusKeys(article, "a"),
    connections: '<div class="wiki-ef-conn-empty">A retired effort has no connections in the map.</div>',
  };
}

/** The pane while the map loads, and when the wiki has none. */
export function effortStatusHtml(input: { wiki: string; startHref: string; id: string }, kind: "loading" | "no-map" | "error", detail = ""): string {
  const text =
    kind === "loading"
      ? "Loading the work map…"
      : kind === "no-map"
        ? "This wiki has no work map, so it has no effort pages."
        : `Couldn’t load the work map${detail ? `: ${detail}` : "."}`;
  return withFocusKeys(
    `<div class="wiki-effort wiki-effort-status" id="wikiEffortPage" data-effort="${esc(input.id)}" data-effort-status="${kind}">` +
    '<div class="wiki-article-head">' +
    crumbsHtml(input, [`<span class="wiki-ef-crumb-theme">${esc(input.id)}</span>`]) +
    `<h1>${esc(input.id)}</h1></div>` +
    `<p class="wiki-ef-status${kind === "error" ? " warn" : ""}" role="status">${esc(text)}</p>` +
    (kind === "error" ? '<button type="button" class="wiki-ef-retry" id="wikiEffortRetry">Retry</button>' : "") +
    "</div>",
    "a",
  );
}

/** `/wiki?wiki=<w>&effort=<id>`, carrying the wiki only; `effortHrefFor` in
 *  `wiki-browser.ts` adds the project and Jira facets. */
export function effortUrl(wiki: string, id: string): string {
  const w = wiki ? "wiki=" + encodeURIComponent(wiki) + "&" : "";
  return "/wiki?" + w + EFFORT_PARAM + "=" + encodeURIComponent(id);
}
