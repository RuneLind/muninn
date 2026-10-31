/**
 * The theme page (plan `muninn-wiki-theme-map`, P3): `?effort=<id>` on a wiki
 * whose `.work-map.json` is a themes map. The work map's effort page
 * (`wiki-effort-page.ts`) stays as it was; `paintEffort` in `wiki-browser.ts`
 * picks this view by the map's kind. Pure and DOM-free.
 *
 * Every map string is model output, so all of it is escaped; prose markers go
 * through the card's `proseHtml`.
 */

import { joinWorkMap, type JoinedTheme, type JoinedThemeMap } from "../../../wiki/work-map/join.ts";
import { declaredEffortOf, osloDay } from "../../../wiki/work-map/ids.ts";
import { createdDayOf } from "../../../wiki/work-map/theme-digest.ts";
import type { ThemeMap, ThemeMapRetired, ThemeWeek } from "../../../wiki/work-map/theme-schema.ts";
import { normalizeRelPath } from "../../../wiki/rel-path.ts";
import { escHtml as esc } from "./escape.ts";
import {
  confidenceLabel,
  crumbsHtml,
  effortLinkHtml,
  lookupEffort,
  pageTitle,
  plural,
  stateHtml,
  withFocusKeys,
  type EffortView,
} from "./wiki-effort-page.ts";
import { effortNeedItems, lastActiveDays, needCountHtml, openNeeds, proseHtml, themeActiveLabel, weeklyStripHtml, type CardPage } from "./wiki-work-card.ts";

/** The listing fields the theme page reads: a source's `created:` dates it. */
export interface ThemePageListing extends CardPage {
  created?: string;
}

export interface ThemeViewInput<P extends ThemePageListing> {
  map: ThemeMap;
  pages: readonly P[];
  id: string;
  wiki: string;
  startHref: string;
  hrefFor(relPath: string): string;
  effortHref(id: string): string;
  /** Worth-a-look keys marked done on the card for this run. */
  done?: ReadonlySet<string>;
  /** The reader's clock: the strip marks the run's week as running only while it has not ended. */
  now: number;
}

/** The crumb for a theme no domain group names. */
const THEMES_CRUMB = "Themes";

function stemOf(rel: string): string {
  return (rel.split("/").pop() || rel).replace(/\.[^.]+$/, "");
}

/** A page link, or the stem as plain text with a note when the listing no longer holds it. */
function pageRowLink(rel: string, byKey: ReadonlyMap<string, CardPage>, hrefFor: (rel: string) => string): string {
  const page = byKey.get(normalizeRelPath(rel));
  return page
    ? `<a class="wiki-ef-plink" href="${esc(hrefFor(page.relPath))}" data-relpath="${esc(page.relPath)}">${esc(pageTitle(page))}</a>`
    : `<span class="wiki-ef-conn-gone">${esc(stemOf(rel))}</span><span class="wiki-ef-meta">no longer in the wiki</span>`;
}

/** Hub chips, every one of them (the card shows four). */
function hubChipsHtml(rels: readonly string[], byKey: ReadonlyMap<string, CardPage>, hrefFor: (rel: string) => string): string {
  if (!rels.length) return "";
  return `<div class="wiki-wm-hubs wiki-ef-hubs">${rels.map((r) => `<span class="wiki-wm-hub">${pageRowLink(r, byKey, hrefFor)}</span>`).join("")}</div>`;
}

/** The theme's sources, newest `created` day first (the run's `createdDayOf`); undated sources last, map order within a day. */
export function sourcesNewestFirst<P extends ThemePageListing>(pages: readonly { id: string; page: P }[]): { id: string; page: P; day: string | undefined }[] {
  return pages
    .map((p) => ({ ...p, day: createdDayOf(p.page) }))
    .sort((a, b) => (a.day === b.day ? 0 : a.day === undefined ? 1 : b.day === undefined ? -1 : b.day.localeCompare(a.day)));
}

/** The domain group naming theme `id`, else the theme's domain in words. */
function domainName(map: { themes: { name: string; efforts: string[] }[] }, id: string, domain?: string): string {
  return map.themes.find((g) => g.efforts.includes(id))?.name || (domain === "life" ? "Life" : domain === "ai" ? "AI & tech" : THEMES_CRUMB);
}

function weeklyHtml(weekly: readonly ThemeWeek[], runAtMs: number, now: number): string {
  if (!weekly.length) {
    return '<section class="wiki-ef-section wiki-ef-weekly"><h2 class="wiki-ef-h">Sources per week</h2><div class="wiki-ef-note">No weeks stored for this theme.</div></section>';
  }
  const sorted = [...weekly].sort((a, b) => a.start.localeCompare(b.start));
  return (
    '<section class="wiki-ef-section wiki-ef-weekly"><h2 class="wiki-ef-h">Sources per week</h2>' +
    weeklyStripHtml(sorted, runAtMs, now, sorted.length) +
    `<div class="wiki-ef-strip-foot"><span>${esc(sorted[0]!.week)}</span><span>${esc(sorted[sorted.length - 1]!.week)}</span></div>` +
    '<div class="wiki-ef-legend">Each bar counts the sources created that week. A dashed frame marks the week still running; a dotted frame marks a week whose count may miss days.</div>' +
    "</section>"
  );
}

function footHtml(runAtMs: number): string {
  return `<div class="wiki-ef-foot">From the theme map organized ${esc(new Date(runAtMs).toLocaleString())}.</div>`;
}

/** The theme page, the retired theme page, or «no longer in the map». */
export function themeView<P extends ThemePageListing>(input: ThemeViewInput<P>): EffortView {
  const joined: JoinedThemeMap<P> = joinWorkMap(input.map, input.pages, input.now);
  const byKey = new Map<string, CardPage>(input.pages.map((p) => [normalizeRelPath(p.relPath), p]));
  const prose = (s: string) => proseHtml(s, byKey, input.hrefFor);
  const found = lookupEffort(joined, input.id);
  if (found.kind === "dropped") return droppedThemeView(input, found.matches);
  if (found.kind === "retired") return retiredThemeView(input, found.retired, byKey);
  const e = found.effort;
  const home = domainName(joined, e.id, e.domain);

  const stored = input.map.efforts.find((x) => x.id === e.id);
  const gone = (stored?.pages ?? []).filter((p) => !byKey.has(normalizeRelPath(p.id))).length;
  const meta: string[] = [stateHtml(e.state)];
  meta.push(`<span class="wiki-ef-meta">${esc(plural(e.pages.length, "source"))}${gone > 0 ? esc(` (${gone} no longer in the wiki)`) : ""}</span>`);
  meta.push(`<span class="wiki-ef-meta" title="How sure the theme run was that these sources share one theme">confidence ${esc(confidenceLabel(e.confidence))}</span>`);
  const active = themeActiveLabel(lastActiveDays(e, input.now));
  if (active) meta.push(`<span class="wiki-ef-meta">${esc(`active ${active}`)}</span>`);

  const inShort =
    e.oneLine || e.takeaway
      ? '<section class="wiki-ef-tldr"><div class="wiki-ef-tldr-label">In short</div>' +
        (e.oneLine ? `<p class="wiki-ef-oneline">${prose(e.oneLine)}</p>` : "") +
        (e.takeaway ? `<p class="wiki-ef-next wiki-ef-takeaway"><span class="wiki-ef-next-label">Takeaway:</span> ${prose(e.takeaway)}</p>` : "") +
        "</section>"
      : "";

  const readFirst = e.readFirst.length
    ? `<section class="wiki-ef-section wiki-ef-readfirst"><h2 class="wiki-ef-h">Read first <span class="wiki-ef-count">${e.readFirst.length}</span></h2><ol class="wiki-ef-pages">` +
      e.readFirst.map((r) => `<li class="wiki-ef-page" style="--ef-depth:0" data-depth="0">${pageRowLink(r, byKey, input.hrefFor)}</li>`).join("") +
      "</ol></section>"
    : "";
  const disagreement = e.disagreement.trim()
    ? `<section class="wiki-ef-section wiki-ef-disagree"><h2 class="wiki-ef-h">Where the sources disagree</h2><p class="wiki-ef-why">${prose(e.disagreement)}</p></section>`
    : "";
  const hubs = e.hubs.length
    ? `<section class="wiki-ef-section wiki-ef-hubsec"><h2 class="wiki-ef-h">Hubs <span class="wiki-ef-count">${e.hubs.length}</span></h2>${hubChipsHtml(e.hubs, byKey, input.hrefFor)}</section>`
    : "";

  const article =
    `<div class="wiki-effort wiki-theme" id="wikiEffortPage" data-effort="${esc(e.id)}" data-kind="themes">` +
    '<div class="wiki-article-head">' +
    crumbsHtml(input, [], home) +
    `<h1>${esc(e.name)}</h1>` +
    `<div class="wiki-meta-row wiki-ef-metarow">${meta.join("")}</div>` +
    "</div>" +
    inShort +
    worthALookHtml(joined, input.map, e.id, input.done ?? new Set(), prose, byKey, input.hrefFor) +
    readFirst +
    disagreement +
    hubs +
    sourcesHtml(e, input, gone) +
    weeklyHtml(e.weekly, input.map.runAtMs, input.now) +
    footHtml(input.map.runAtMs) +
    "</div>";

  return { article: withFocusKeys(article, "a"), connections: withFocusKeys(connectionsHtml(e, joined, home, input, prose), "c") };
}

/** The theme's Worth-a-look items: kind, the runner's count, every hub and the cited sources. */
function worthALookHtml<P>(
  map: JoinedThemeMap<P>,
  raw: ThemeMap,
  id: string,
  done: ReadonlySet<string>,
  prose: (s: string) => string,
  byKey: ReadonlyMap<string, CardPage>,
  hrefFor: (rel: string) => string,
): string {
  // Keys from the raw map: the join rewrites titles. Same selection and done
  // filter as the rail's ✋.
  const items = effortNeedItems(raw.needsYou, id).map(({ i, key }) => ({ n: map.needsYou[i]!, key }));
  if (!items.length) return "";
  const open = openNeeds(items, done);
  const doneCount = items.length - open.length;
  return (
    '<section class="wiki-ef-section"><h2 class="wiki-ef-h">Worth a look</h2>' +
    (open.length
      ? '<ul class="wiki-ef-needs">' +
        open
          .map(({ n }) => {
            const cited = new Set([...`${n.title} ${n.why} ${n.action}`.matchAll(/⟦([^⟧]+)⟧/g)].map((m) => normalizeRelPath(m[1]!)));
            const pages = n.pages.filter((r) => !cited.has(normalizeRelPath(r)));
            return (
              `<li class="wiki-ef-need" data-need-kind="${esc(n.kind)}">` +
              `<div class="wiki-ef-need-head"><span class="wiki-ef-kind">${esc(n.kind)}</span><span class="wiki-ef-need-title">${prose(n.title)}</span>${needCountHtml(n.kind, n.count)}</div>` +
              (n.why ? `<div class="wiki-ef-need-why">${prose(n.why)}</div>` : "") +
              (n.action ? `<div class="wiki-ef-need-action">${prose(n.action)}</div>` : "") +
              hubChipsHtml(n.hubs, byKey, hrefFor) +
              (pages.length ? `<div class="wiki-wm-pages">${pages.map((r) => pageRowLink(r, byKey, hrefFor)).join('<span class="wiki-wm-sep"> · </span>')}</div>` : "") +
              "</li>"
            );
          })
          .join("") +
        "</ul>"
      : "") +
    (doneCount ? `<div class="wiki-ef-note">${esc(plural(doneCount, "item"))} marked done on the What you’re following card.</div>` : "") +
    "</section>"
  );
}

function sourcesHtml<P extends ThemePageListing>(e: JoinedTheme<P>, input: ThemeViewInput<P>, gone: number): string {
  const rows = sourcesNewestFirst(e.pages);
  if (!rows.length) {
    const note = gone > 0 ? "None of this theme’s sources are in the wiki any more." : e.movedOut.length ? "Every source of this theme now declares another theme." : "This theme has no sources.";
    return `<section class="wiki-ef-section wiki-ef-sources"><h2 class="wiki-ef-h">Sources</h2><div class="wiki-ef-note">${esc(note)}</div></section>`;
  }
  return (
    `<section class="wiki-ef-section wiki-ef-sources"><h2 class="wiki-ef-h">Sources <span class="wiki-ef-count">${rows.length}</span></h2><ol class="wiki-ef-pages">` +
    rows
      .map(
        (r) =>
          `<li class="wiki-ef-page" style="--ef-depth:0" data-depth="0"${r.day ? ` data-created="${esc(r.day)}"` : ""}>` +
          `<a class="wiki-ef-plink" href="${esc(input.hrefFor(r.id))}" data-relpath="${esc(r.id)}">${esc(pageTitle(r.page))}</a>` +
          `<span class="wiki-ef-meta">${esc(r.day ?? "no date")}</span>` +
          "</li>",
      )
      .join("") +
    "</ol></section>"
  );
}

function connectionsHtml<P>(
  e: JoinedTheme<P>,
  map: JoinedThemeMap<P>,
  home: string,
  input: { effortHref(id: string): string },
  prose: (s: string) => string,
): string {
  const byId = new Map(map.efforts.map((x) => [x.id, x]));
  const related = e.related.filter((r) => r.id !== e.id);
  const relatedHtml = related
    .map((r) => {
      const target = byId.get(r.id);
      const retired = target ? undefined : map.retired.find((x) => x.id === r.id);
      return (
        '<li class="wiki-ef-conn">' +
        (target
          ? `${effortLinkHtml(target, input.effortHref)}${stateHtml(target.state)}`
          : retired
            ? `${effortLinkHtml(retired, input.effortHref)}${stateHtml("retired")}`
            : `<span class="wiki-ef-conn-gone">${esc(r.id)}</span><span class="wiki-ef-meta">no longer in the map</span>`) +
        (r.why ? `<div class="wiki-ef-conn-why">${prose(r.why)}</div>` : "") +
        "</li>"
      );
    })
    .join("");
  let html =
    `<div class="wiki-conn-section"><div class="wiki-ef-conn-title">Connected themes (${related.length})</div>` +
    (relatedHtml ? `<ul class="wiki-ef-conns">${relatedHtml}</ul>` : '<div class="wiki-ef-conn-empty">None</div>') +
    "</div>";
  const group = map.themes.find((g) => g.efforts.includes(e.id));
  html += '<div class="wiki-conn-section wiki-ef-domain"><div class="wiki-ef-conn-title">Domain</div>';
  if (!group) {
    html += `<div class="wiki-ef-conn-empty">${esc(home === THEMES_CRUMB ? "This theme is in no domain group." : `${home}: no domain group lists this theme.`)}</div></div>`;
    return html;
  }
  const shown = new Set([e.id, ...related.map((r) => r.id)]);
  const siblings = [...new Set(group.efforts)].filter((id) => !shown.has(id)).map((id) => byId.get(id)).filter((x): x is JoinedTheme<P> => !!x);
  html +=
    `<div class="wiki-ef-conn-empty wiki-ef-domain-name">${esc(group.name)}: ${esc(plural(siblings.length, "other theme"))}</div>` +
    (siblings.length ? `<ul class="wiki-ef-conns">${siblings.map((s) => `<li class="wiki-ef-conn">${effortLinkHtml(s, input.effortHref)}${stateHtml(s.state)}</li>`).join("")}</ul>` : "") +
    "</div>";
  return html;
}

function droppedThemeView<P extends ThemePageListing>(input: ThemeViewInput<P>, matches: JoinedTheme<P>[]): EffortView {
  const article =
    `<div class="wiki-effort wiki-effort-gone wiki-theme" id="wikiEffortPage" data-effort="${esc(input.id)}" data-kind="themes">` +
    '<div class="wiki-article-head">' +
    crumbsHtml(input, [`<span class="wiki-ef-crumb-theme">${esc(input.id)}</span>`], THEMES_CRUMB) +
    `<h1>${esc(input.id)}</h1>` +
    "</div>" +
    '<p class="wiki-ef-gone">This theme is no longer in the map. A later run dropped or renamed it.</p>' +
    (matches.length ? `<p class="wiki-ef-gone-match">It may continue as ${matches.map((m) => effortLinkHtml(m, input.effortHref)).join(", ")}.</p>` : "") +
    `<p class="wiki-ef-gone-home"><a class="wiki-ef-crumb" href="${esc(input.startHref)}" data-effort-home>See every theme on the What you’re following card</a></p>` +
    "</div>";
  return { article: withFocusKeys(article, "a"), connections: '<div class="wiki-ef-conn-empty">This theme is no longer in the map.</div>' };
}

/**
 * A retired theme: its name, last-active day, its stored weeks, the last
 * members the listing still holds and the pages that declare it. The map keeps
 * no other pages for it.
 */
function retiredThemeView<P extends ThemePageListing>(input: ThemeViewInput<P>, r: ThemeMapRetired, byKey: ReadonlyMap<string, CardPage>): EffortView {
  const listed = (r.members ?? []).map((rel) => byKey.get(normalizeRelPath(rel))).filter((p): p is CardPage => !!p);
  const memberKeys = new Set(listed.map((p) => normalizeRelPath(p.relPath)));
  const declaring = input.pages.filter((p) => declaredEffortOf(p) === r.id && !memberKeys.has(normalizeRelPath(p.relPath)));
  const rows = [...listed, ...declaring];
  const last = r.lastActive > 0 ? osloDay(r.lastActive) : null;
  const pages = rows.length
    ? `<section class="wiki-ef-section wiki-ef-sources"><h2 class="wiki-ef-h">Its last sources <span class="wiki-ef-count">${rows.length}</span></h2><ol class="wiki-ef-pages">` +
      rows
        .map((p) => `<li class="wiki-ef-page" style="--ef-depth:0" data-depth="0"><a class="wiki-ef-plink" href="${esc(input.hrefFor(p.relPath))}" data-relpath="${esc(p.relPath)}">${esc(pageTitle(p))}</a></li>`)
        .join("") +
      "</ol></section>"
    : '<section class="wiki-ef-section wiki-ef-sources"><h2 class="wiki-ef-h">Its last sources</h2><div class="wiki-ef-note">No source in the wiki belongs to it any more.</div></section>';
  const article =
    `<div class="wiki-effort wiki-effort-retired wiki-theme" id="wikiEffortPage" data-effort="${esc(r.id)}" data-kind="themes">` +
    '<div class="wiki-article-head">' +
    crumbsHtml(input, ['<span class="wiki-ef-crumb-theme">Retired</span>'], THEMES_CRUMB) +
    `<h1>${esc(r.name)}</h1>` +
    `<div class="wiki-meta-row wiki-ef-metarow">${stateHtml("retired")}` +
    `<span class="wiki-ef-meta" data-effort-last-active>${esc(last ? `last active ${last}` : "no recorded activity")}</span></div>` +
    "</div>" +
    `<p class="wiki-ef-gone">This theme is retired: no source from the last ${esc(String(input.map.coverage.windowDays))} days sits under it. It comes back when a run places new sources under it.</p>` +
    pages +
    weeklyHtml(r.weekly, input.map.runAtMs, input.now) +
    footHtml(input.map.runAtMs) +
    "</div>";
  return { article: withFocusKeys(article, "a"), connections: '<div class="wiki-ef-conn-empty">A retired theme has no connections in the map.</div>' };
}
