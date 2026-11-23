/**
 * A synthetic `themes` map for the reader's unit tests (theme map P2): four AI
 * themes, one in each state, a Life theme, a connection stored on both ends,
 * and a drift and a gap item. Names are invented; no live-corpus content.
 */

import type { ThemeMap, ThemeMapTheme } from "../wiki/work-map/theme-schema.ts";

export const THEME_RUN_AT = Date.parse("2026-10-30T03:00:00Z");

export function fixtureTheme(id: string, over: Partial<ThemeMapTheme> = {}): ThemeMapTheme {
  return {
    id,
    name: `Theme ${id}`,
    oneLine: `One line about ${id}.`,
    state: "steady",
    domain: "ai",
    pages: [{ id: `sources/${id}-1.mdx`, role: "source" }],
    hubs: ["concepts/Hub X.md"],
    readFirst: [`sources/${id}-1.mdx`],
    takeaway: `Takeaway for ${id}, see ⟦sources/${id}-1.mdx⟧.`,
    disagreement: "",
    confidence: 0.8,
    related: [],
    weekly: [
      { week: "2026-W42", start: "2026-10-12", count: 1, partial: true },
      { week: "2026-W43", start: "2026-10-19", count: 2 },
      { week: "2026-W44", start: "2026-10-26", count: 4 },
    ],
    trend: { recent: 4, earlier: 2 },
    ...over,
  };
}

export function fixtureThemeMap(over: Partial<ThemeMap> = {}): ThemeMap {
  return {
    version: 1,
    kind: "themes",
    wiki: "w",
    runAtMs: THEME_RUN_AT,
    model: "test-model",
    coverage: { activeSources: 9, hubs: 3, driftHubs: 1, placed: 8, digestChars: 100, windowDays: 28, warnings: [] },
    summary: "You read most about ⟦sources/alpha-1.mdx⟧.",
    needsYou: [
      { title: "Hub X is behind its sources", kind: "drift", why: "Twelve sources arrived since.", action: "Refresh Hub X.", pages: ["sources/beta-1.mdx"], effort: "beta", hubs: ["concepts/Hub X.md"], count: 12 },
      { title: "Nothing on gamma's cost", kind: "gap", why: "", action: "", pages: ["sources/gamma-1.mdx", "sources/alpha-1.mdx"], effort: "gamma", hubs: [], count: 2 },
    ],
    themes: [
      { name: "AI & tech", efforts: ["alpha", "beta", "gamma", "delta"] },
      { name: "Life", efforts: ["life-one"] },
    ],
    efforts: [
      fixtureTheme("alpha", { state: "rising", related: [{ id: "beta", why: "Both lean on Hub X." }], pages: [{ id: "sources/alpha-1.mdx", role: "source" }, { id: "sources/alpha-2.mdx", role: "source" }] }),
      fixtureTheme("beta", { related: [{ id: "alpha", why: "The other end's why." }, { id: "gamma", why: "Beta feeds gamma." }] }),
      fixtureTheme("gamma", { state: "new" }),
      fixtureTheme("delta", { state: "fading", weekly: [{ week: "2026-W40", start: "2026-09-28", count: 3 }, { week: "2026-W41", start: "2026-10-05", count: 0 }] }),
      fixtureTheme("life-one", { domain: "life" }),
    ],
    retired: [],
    loose: [],
    ...over,
  };
}

/** Every page the fixture map names, as listing rows. */
export function fixtureThemePages(): { relPath: string; title: string }[] {
  const rels = new Set<string>();
  for (const e of fixtureThemeMap().efforts) {
    for (const p of e.pages) rels.add(p.id);
    for (const h of e.hubs) rels.add(h);
  }
  return [...rels].map((relPath) => ({ relPath, title: relPath.split("/").pop()!.replace(/\.mdx?$/, "") }));
}
