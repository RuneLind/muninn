/**
 * After validation, the runner normalizes a theme answer onto the stored
 * `ThemeMap` (plan `muninn-wiki-theme-map`, Design, «Normalize for themes»):
 *
 *  1. Slugify theme ids; drop an id that still fails `EFFORT_ID_RE`, and a
 *     second theme with a used id.
 *  2. Map short source ids to relPaths; drop an unknown id; a source sits in
 *     the first theme that names it.
 *  3. A theme keeps the sources of its majority domain; the rest go to loose.
 *     A theme left with no sources is dropped.
 *  4. `readFirst` keeps ids inside the theme's sources (at most 3); hub names
 *     resolve to relPaths, an unknown hub is dropped.
 *  5. `connections` become each end's `related`; one naming a missing theme
 *     is dropped.
 *  6. The runner's numbers: trend `state`, `weekly` (below) and `retired`.
 *  7. `worthALook` becomes `needsYou`: a drift item whose hubs do not qualify
 *     is dropped, then at most 2 drift items stay (most `sinceUpdate` first),
 *     then the first 6 items stay. `count` is a drift item's `sinceUpdate`,
 *     else the number of sources it cites.
 *  8. Every active source no theme holds goes to loose.
 *
 * `weekly`: each run recounts every ISO week that starts on or after the
 * window start from the current members, and carries every earlier week from
 * the previous map unchanged (up to 26 weeks), so a week is counted while it
 * is whole inside the window and then frozen.
 */

import { EFFORT_ID_RE } from "./ids.ts";
import { linkifySigils, slugifyEffortId } from "./normalize.ts";
import { addDays, THEME_RECENT_DAYS, THEME_WINDOW_DAYS, type ThemeHub, type ThemeSource } from "./theme-digest.ts";
import type {
  ThemeDomain,
  ThemeMap,
  ThemeMapAnswer,
  ThemeMapRetired,
  ThemeMapTheme,
  ThemeNeedsYou,
  ThemeState,
  ThemeWeek,
} from "./theme-schema.ts";

const DAY = 86_400_000;
/** Weeks `weekly` keeps; a retired theme quiet this long is dropped. */
export const THEME_WEEKS_KEPT = 26;
/** `rising` at this ratio of recent to earlier sources or more … */
export const THEME_RISING_RATIO = 2;
/** … with at least this many recent sources. */
export const THEME_RISING_MIN_RECENT = 3;
/** `fading` at this ratio or less. */
export const THEME_FADING_RATIO = 0.5;
/** Drift items kept, most sources since the hub's update first. */
export const THEME_DRIFT_ITEMS_MAX = 2;
/** `needsYou` items kept. */
export const THEME_NEEDS_MAX = 6;
const READ_FIRST_MAX = 3;
export const THEME_GROUP_LABELS: Record<ThemeDomain, string> = { ai: "AI & tech", life: "Life" };

export interface ThemeNormalizeContext {
  /** short id → relPath (`ThemeDigest.rel`). */
  rel: ReadonlyMap<string, string>;
  /** Every active source by relPath (the digest's cut ones included). */
  sources: ReadonlyMap<string, ThemeSource>;
  hubs: readonly ThemeHub[];
  /** Lowercased hub name → relPath, from the digest. */
  hubByName: ReadonlyMap<string, string>;
  /** Fallback for a hub name outside the digest (`WikiIndex.resolve`): the
   *  relPath of a hub page, undefined for a source or an unknown name. */
  resolveHub: (name: string) => string | undefined;
  /** Any page's creation day (retired themes' `lastActive`). */
  createdDayOf: (relPath: string) => string | undefined;
  runDay: string;
  previous: ThemeMap | null;
}

export type NormalizedThemeMap = Pick<ThemeMap, "summary" | "needsYou" | "themes" | "efforts" | "retired" | "loose">;

const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** The Monday of `day`'s ISO week. */
export function isoMonday(day: string): string {
  const dow = (new Date(dayMs(day)).getUTCDay() + 6) % 7;
  return addDays(day, -dow);
}

/** `day`'s ISO week label, `2026-W44`. */
export function isoWeekLabel(day: string): string {
  const thursday = addDays(isoMonday(day), 3);
  const year = thursday.slice(0, 4);
  const jan4Monday = isoMonday(`${year}-01-04`);
  const week = Math.round((dayMs(isoMonday(day)) - dayMs(jan4Monday)) / (7 * DAY)) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** The window's first day for a run on `runDay`. */
export function themeWindowStart(runDay: string): string {
  return addDays(runDay, -(THEME_WINDOW_DAYS - 1));
}

/** The first Monday on or after the window start: weeks from it on are recounted. */
export function firstRecountedMonday(runDay: string): string {
  const start = themeWindowStart(runDay);
  const mon = isoMonday(start);
  return mon === start ? mon : addDays(mon, 7);
}

/**
 * A theme's weekly counts tonight. `created` are its members' creation days;
 * `prior` is the weekly list of the previous map's entry for this id (a theme
 * or a retired theme), null when the previous map lacks it; `priorRunDay` is
 * the previous run's day.
 */
export function themeWeekly(created: readonly string[], prior: readonly ThemeWeek[] | null, priorRunDay: string | null, runDay: string): ThemeWeek[] {
  const windowStart = themeWindowStart(runDay);
  const recountFrom = firstRecountedMonday(runDay);
  const current = isoMonday(runDay);
  const inWeek = (mon: string, from = mon) => created.filter((d) => d >= from && d <= addDays(mon, 6)).length;
  const out: ThemeWeek[] = [];
  // Weeks before the window start: carried as stored.
  const carried = new Set<string>();
  for (const w of prior ?? []) {
    if (w.start >= recountFrom) continue;
    const endedBeforePriorRun = priorRunDay !== null && priorRunDay >= addDays(w.start, 6);
    out.push({ week: w.week, start: w.start, count: w.count, ...(w.partial || !endedBeforePriorRun ? { partial: true } : {}) });
    carried.add(w.start);
  }
  // The straddling week, when the prior map could not have counted it whole.
  const straddle = isoMonday(windowStart);
  if (straddle !== windowStart && !carried.has(straddle)) {
    const priorSawIt = prior !== null && priorRunDay !== null && priorRunDay >= addDays(straddle, 6);
    const n = inWeek(straddle, windowStart);
    if (!priorSawIt && (n > 0 || prior === null)) out.push({ week: isoWeekLabel(straddle), start: straddle, count: n, partial: true });
  }
  for (let mon = recountFrom; mon <= current; mon = addDays(mon, 7)) {
    out.push({ week: isoWeekLabel(mon), start: mon, count: inWeek(mon) });
  }
  const oldest = addDays(current, -7 * (THEME_WEEKS_KEPT - 1));
  return out.filter((w) => w.start >= oldest).sort((a, b) => a.start.localeCompare(b.start));
}

/** The trend state from the two windows; `isNew` wins. */
export function themeState(recent: number, earlier: number, isNew: boolean): ThemeState {
  if (isNew) return "new";
  if (recent >= THEME_RISING_MIN_RECENT && recent >= THEME_RISING_RATIO * earlier) return "rising";
  if (recent <= THEME_FADING_RATIO * earlier) return "fading";
  return "steady";
}

export function normalizeThemeAnswer(answer: ThemeMapAnswer, ctx: ThemeNormalizeContext): NormalizedThemeMap {
  const link = (s: string) => linkifySigils(s, ctx.rel);
  const toRel = (id: string) => ctx.rel.get(id);
  const resolveHub = (name: string) => ctx.hubByName.get(name.trim().toLowerCase()) ?? ctx.resolveHub(name.trim());
  const hubStat = new Map(ctx.hubs.map((h) => [h.relPath, h]));
  const prev = ctx.previous;
  const prevRunDay = prev ? new Date(prev.runAtMs).toISOString().slice(0, 10) : null;
  const prevTheme = new Map((prev?.efforts ?? []).map((t) => [t.id, t]));
  const prevRetired = new Map((prev?.retired ?? []).map((r) => [r.id, r]));

  // 1–2. Ids, sources.
  const seen = new Set<string>();
  const placed = new Set<string>();
  type Draft = { id: string; a: ThemeMapAnswer["themes"][number]; sources: string[] };
  let drafts: Draft[] = [];
  for (const a of answer.themes) {
    const id = slugifyEffortId(a.id);
    if (!EFFORT_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const sources: string[] = [];
    for (const sid of a.sources) {
      const r = toRel(sid);
      if (!r || placed.has(r)) continue;
      placed.add(r);
      sources.push(r);
    }
    drafts.push({ id, a, sources });
  }

  // 3. Majority domain; the minority goes back to unplaced.
  const domainOf = new Map<string, ThemeDomain>();
  drafts = drafts.map((d) => {
    const ai = d.sources.filter((r) => ctx.sources.get(r)?.domain !== "life").length;
    const life = d.sources.length - ai;
    const domain: ThemeDomain = life > ai ? "life" : ai > life ? "ai" : (d.a.domain ?? "ai");
    domainOf.set(d.id, domain);
    const keep = d.sources.filter((r) => (ctx.sources.get(r)?.domain === "life" ? "life" : "ai") === domain);
    for (const r of d.sources) if (!keep.includes(r)) placed.delete(r);
    return { ...d, sources: keep };
  });
  drafts = drafts.filter((d) => d.sources.length > 0);
  const known = new Set(drafts.map((d) => d.id));

  // 5. Connections → related.
  const related = new Map<string, { id: string; why: string }[]>(drafts.map((d) => [d.id, []]));
  for (const c of answer.connections) {
    const a = slugifyEffortId(c.a);
    const b = slugifyEffortId(c.b);
    if (a === b || !known.has(a) || !known.has(b)) continue;
    for (const [from, to] of [
      [a, b],
      [b, a],
    ] as const) {
      const list = related.get(from)!;
      if (!list.some((r) => r.id === to)) list.push({ id: to, why: link(c.why) });
    }
  }

  // 4, 6. The stored themes.
  const recentFrom = addDays(ctx.runDay, -(THEME_RECENT_DAYS - 1));
  const efforts: ThemeMapTheme[] = drafts.map((d) => {
    const inTheme = new Set(d.sources);
    const readFirst = [...new Set(d.a.readFirst.map(toRel).filter((r): r is string => !!r && inTheme.has(r)))].slice(0, READ_FIRST_MAX);
    const hubs = [...new Set(d.a.hubs.map(resolveHub).filter((r): r is string => !!r))];
    const created = d.sources.map((r) => ctx.sources.get(r)?.created).filter((x): x is string => !!x);
    const recent = created.filter((c) => c >= recentFrom).length;
    const earlier = created.length - recent;
    const isNew = prev !== null && !prevTheme.has(d.id) && !prevRetired.has(d.id);
    const prior = prevTheme.get(d.id)?.weekly ?? prevRetired.get(d.id)?.weekly ?? null;
    return {
      id: d.id,
      name: d.a.name,
      oneLine: link(d.a.oneLine),
      state: themeState(recent, earlier, isNew),
      domain: domainOf.get(d.id)!,
      pages: d.sources.map((r) => ({ id: r, role: "source" as const })),
      hubs,
      readFirst,
      takeaway: link(d.a.takeaway),
      disagreement: link(d.a.disagreement),
      confidence: d.a.confidence,
      related: related.get(d.id)!,
      weekly: themeWeekly(created, prior, prevRunDay, ctx.runDay),
      trend: { recent, earlier },
    };
  });

  // Retired: the previous map's themes and retired themes not back tonight.
  const lastActiveOf = (t: { pages: { id: string }[] }, fallback: number) => {
    const days = t.pages.map((p) => ctx.createdDayOf(p.id)).filter((x): x is string => !!x);
    return days.length ? dayMs(days.sort().at(-1)!) : fallback;
  };
  const quietLimit = dayMs(ctx.runDay) - THEME_WEEKS_KEPT * 7 * DAY;
  const retired: ThemeMapRetired[] = [];
  for (const t of prev?.efforts ?? []) {
    if (known.has(t.id)) continue;
    retired.push({ id: t.id, name: t.name, lastActive: lastActiveOf(t, prev!.runAtMs), weekly: t.weekly });
  }
  for (const r of prev?.retired ?? []) {
    if (known.has(r.id) || prevTheme.has(r.id)) continue;
    retired.push(r);
  }
  const keptRetired = retired.filter((r) => r.lastActive >= quietLimit).sort((a, b) => a.id.localeCompare(b.id));

  // 7. Worth a look.
  let needs: (ThemeNeedsYou & { drift?: number })[] = [];
  for (const w of answer.worthALook) {
    const pages = [...new Set(w.sources.map(toRel).filter((r): r is string => !!r))];
    const hubs = [...new Set(w.hubs.map(resolveHub).filter((r): r is string => !!r))];
    const effort = w.theme !== undefined ? slugifyEffortId(w.theme) : undefined;
    const base = {
      title: link(w.title),
      kind: w.kind,
      why: link(w.why),
      action: link(w.action),
      pages,
      ...(effort !== undefined && known.has(effort) ? { effort } : {}),
      hubs,
    };
    if (w.kind === "drift") {
      const qualifying = hubs.map((h) => hubStat.get(h)).filter((h): h is ThemeHub => !!h && h.drift);
      if (qualifying.length === 0) continue;
      const count = Math.max(...qualifying.map((h) => h.sinceUpdate));
      needs.push({ ...base, count, drift: count });
    } else {
      needs.push({ ...base, count: pages.length });
    }
  }
  const keptDrift = new Set(
    needs
      .filter((n) => n.drift !== undefined)
      .sort((a, b) => b.drift! - a.drift!)
      .slice(0, THEME_DRIFT_ITEMS_MAX),
  );
  needs = needs.filter((n) => n.drift === undefined || keptDrift.has(n)).slice(0, THEME_NEEDS_MAX);
  const needsYou: ThemeNeedsYou[] = needs.map(({ drift: _d, ...n }) => n);

  // Domain groups.
  const themes = (["ai", "life"] as const)
    .map((dom) => ({ name: THEME_GROUP_LABELS[dom], efforts: efforts.filter((e) => e.domain === dom).map((e) => e.id) }))
    .filter((g) => g.efforts.length > 0);

  // 8. Loose.
  const held = new Set(efforts.flatMap((e) => e.pages.map((p) => p.id)));
  const loose: string[] = [];
  for (const id of answer.loose) {
    const r = toRel(id);
    if (r && !held.has(r) && !loose.includes(r)) loose.push(r);
  }
  for (const r of ctx.sources.keys()) if (!held.has(r) && !loose.includes(r)) loose.push(r);

  return { summary: link(answer.summary), needsYou, themes, efforts, retired: keptRetired, loose };
}
