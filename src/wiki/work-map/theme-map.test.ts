/**
 * The `themes` kind (plan `muninn-wiki-theme-map`, P1): the digest, normalize
 * (states, retired, drift, caps, connections, domains, loose), the weekly
 * freeze across nightly runs, the run's kind branch, and the stored map read
 * back through `readMapFile`. Every fixture is synthetic.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { WikiIndex, WikiPageMeta } from "../store.ts";
import { workMapKindFromReaderText, parseWorkMapReaderConfig } from "./kind.ts";
import { previousMapOf, readMapFile } from "./map-file.ts";
import { __resetWorkMapRunsForTest, startWorkMapRun, type ModelRequest, type WorkMapRunDeps } from "./run.ts";
import { WORK_MAP_VERSION } from "./schema.ts";
import { addDays, buildThemeMapDigest, THEME_DRIFT_MIN_SINCE, type ThemeDigestPage, type ThemeSource } from "./theme-digest.ts";
import {
  firstRecountedMonday,
  isoMonday,
  isoWeekLabel,
  normalizeThemeAnswer,
  themeState,
  themeWeekly,
  themeWindowStart,
  type ThemeNormalizeContext,
} from "./theme-normalize.ts";
import { parseThemeMap, THEME_MAP_VERSION, themeAnswerSchema, type ThemeMap } from "./theme-schema.ts";
import { memoryStateStore } from "./dry-run.ts";

const NOW = Date.parse("2026-10-31T10:00:00Z");
const RUN_DAY = "2026-10-31";
const DAY = 86_400_000;

beforeEach(() => __resetWorkMapRunsForTest());
afterEach(() => __resetWorkMapRunsForTest());

function src(rel: string, created: string, extra: Partial<ThemeDigestPage> = {}): ThemeDigestPage {
  return {
    relPath: rel,
    name: rel.split("/").pop()!.replace(/\.mdx?$/, ""),
    title: rel.split("/").pop()!.replace(/\.mdx?$/, ""),
    type: "source",
    domain: rel.startsWith("life/") ? "life" : "ai",
    tags: ["t"],
    created,
    ...extra,
  };
}
function hub(rel: string, updated: string): ThemeDigestPage {
  return { relPath: rel, name: rel.split("/").pop()!.replace(/\.mdx?$/, ""), title: rel, type: rel.startsWith("entities") ? "entity" : "concept", domain: "ai", tags: [], updated };
}
const key = (r: string) => r.toLowerCase();

/** Sources a1..a6 (ai), l1..l2 (life), an aggregator, two hubs. */
function fixturePages() {
  const pages: ThemeDigestPage[] = [
    src("sources/a1.md", "2026-10-30"),
    src("sources/a2.md", "2026-10-29"),
    src("sources/a3.md", "2026-10-25"),
    src("sources/a4.md", "2026-10-10"),
    src("sources/a5.md", "2026-10-08"),
    src("sources/a6.md", "2026-10-06"),
    src("life/sources/l1.md", "2026-10-28"),
    src("life/sources/l2.md", "2026-10-12"),
    src("sources/Sources — October.md", "2026-10-30"),
    src("sources/old.md", "2026-09-01"),
    src("sources/nocreated.md", "", { created: undefined, gitCreatedMs: Date.parse("2026-10-20T08:00:00Z") }),
    hub("concepts/Hub A.md", "2026-08-01"),
    hub("entities/Hub B.md", "2026-10-30"),
  ];
  const outgoing = new Map<string, string[]>();
  for (const p of pages.filter((p) => p.type === "source")) outgoing.set(key(p.relPath), [key("concepts/Hub A.md"), key("entities/Hub B.md")]);
  return { pages, outgoing };
}

describe("kind", () => {
  test("absent, malformed and unknown kinds read as work; themes reads as themes", () => {
    expect(workMapKindFromReaderText(null)).toBe("work");
    expect(workMapKindFromReaderText("{")).toBe("work");
    expect(workMapKindFromReaderText("{}")).toBe("work");
    expect(workMapKindFromReaderText('{"workMap":{"kind":"themes"}}')).toBe("themes");
    expect(workMapKindFromReaderText('{"workMap":{"kind":"nope"}}')).toBe("work");
    expect(parseWorkMapReaderConfig({ kind: "nope" }).warning).toContain("nope");
    expect(parseWorkMapReaderConfig("x").warning).toBeDefined();
    expect(parseWorkMapReaderConfig(undefined)).toEqual({ kind: "work" });
  });
});

describe("theme digest", () => {
  test("the active set: source pages created in 28 days, newest first; aggregators, old pages and hubs out; git date fallback", () => {
    const { pages, outgoing } = fixturePages();
    const d = buildThemeMapDigest({ wiki: "w", nowMs: NOW, pages, outgoing, previous: null });
    expect(d.active.map((s) => s.relPath)).toEqual([
      "sources/a1.md",
      "sources/a2.md",
      "life/sources/l1.md",
      "sources/a3.md",
      "sources/nocreated.md",
      "life/sources/l2.md",
      "sources/a4.md",
      "sources/a5.md",
      "sources/a6.md",
    ]);
    expect(d.windowStart).toBe("2026-10-04");
    expect(d.text).toContain('p1 "a1" | ai | created=2026-10-30 | tags=t | links=[Hub A; Hub B]');
    expect(d.text).not.toContain("Sources — October");
  });

  test("hub lines carry runner-computed counts; drift marks a hub only at the bar", () => {
    const { pages, outgoing } = fixturePages();
    const d = buildThemeMapDigest({ wiki: "w", nowMs: NOW, pages, outgoing, previous: null });
    const a = d.hubs.find((h) => h.name === "Hub A")!;
    expect(a).toMatchObject({ links: 9, sinceUpdate: 9, share: 1 });
    expect(a.drift).toBe(9 >= THEME_DRIFT_MIN_SINCE);
    const b = d.hubs.find((h) => h.name === "Hub B")!;
    expect(b).toMatchObject({ links: 9, sinceUpdate: 0, drift: false });
    expect(d.text).toContain("Hub B | entities | linked by 9 recent sources | page updated=2026-10-30 | 0 created since that update");
  });

  test("drift qualifies at sinceUpdate ≥ the bar AND share ≥ 0.5", () => {
    const pages: ThemeDigestPage[] = [hub("concepts/H.md", "2026-10-15")];
    const outgoing = new Map<string, string[]>();
    const n = THEME_DRIFT_MIN_SINCE;
    // n created after the update, n + 1 before it: share just under 0.5.
    for (let i = 0; i < 2 * n + 1; i++) {
      const rel = `sources/s${i}.md`;
      pages.push(src(rel, i < n ? "2026-10-20" : "2026-10-10"));
      outgoing.set(key(rel), [key("concepts/H.md")]);
    }
    const under = buildThemeMapDigest({ wiki: "w", nowMs: NOW, pages, outgoing, previous: null }).hubs[0]!;
    expect(under).toMatchObject({ sinceUpdate: n, drift: false });
    const atShare = buildThemeMapDigest({ wiki: "w", nowMs: NOW, pages: pages.slice(0, -1), outgoing, previous: null }).hubs[0]!;
    expect(atShare).toMatchObject({ sinceUpdate: n, share: 0.5, drift: true });
    const fewer = buildThemeMapDigest({ wiki: "w", nowMs: NOW, pages: pages.filter((p) => p.relPath !== "sources/s0.md"), outgoing, previous: null }).hubs[0]!;
    expect(fewer.drift).toBe(false);
  });

  test("the previous map lists member short ids with +N not active now, and its retired themes", () => {
    const { pages, outgoing } = fixturePages();
    const previous = themeMap({
      efforts: [theme("t1", "T one", ["sources/a1.md", "sources/a2.md", "sources/gone.md", "sources/gone2.md"])],
      retired: [{ id: "r1", name: "R one", lastActive: Date.parse("2026-09-01"), weekly: [] }],
    });
    const d = buildThemeMapDigest({ wiki: "w", nowMs: NOW, pages, outgoing, previous });
    expect(d.text).toContain("t1: T one (ai) — sources [p1,p2] +2 not active now");
    expect(d.text).toContain("r1: R one — last active 2026-09-01");
  });
});

function theme(id: string, name: string, rels: string[], over: Partial<ThemeMap["efforts"][number]> = {}): ThemeMap["efforts"][number] {
  return {
    id,
    name,
    oneLine: "",
    state: "steady",
    domain: "ai",
    pages: rels.map((r) => ({ id: r, role: "source" })),
    hubs: [],
    readFirst: [],
    takeaway: "",
    disagreement: "",
    confidence: 0.5,
    related: [],
    weekly: [],
    trend: { recent: 0, earlier: 0 },
    ...over,
  };
}
function themeMap(over: Partial<ThemeMap> = {}): ThemeMap {
  return {
    version: THEME_MAP_VERSION,
    kind: "themes",
    wiki: "w",
    runAtMs: NOW - DAY,
    model: "m",
    coverage: { activeSources: 0, hubs: 0, driftHubs: 0, placed: 0, digestChars: 0, windowDays: 28, warnings: [] },
    summary: "",
    needsYou: [],
    themes: [],
    efforts: [],
    retired: [],
    loose: [],
    ...over,
  };
}

/** A normalize context over plain sources `{rel: created}`. */
function ctxFor(sources: Record<string, string>, runDay: string, previous: ThemeMap | null, over: Partial<ThemeNormalizeContext> = {}): ThemeNormalizeContext {
  const rels = Object.keys(sources);
  const rel = new Map(rels.map((r, i) => [`p${i + 1}`, r]));
  return {
    rel,
    sources: new Map(rels.map((r) => [r, { relPath: r, created: sources[r]!, domain: r.startsWith("life/") ? "life" : "ai" } satisfies ThemeSource])),
    hubs: [],
    hubByName: new Map(),
    resolveHub: () => undefined,
    createdDayOf: (r) => sources[r],
    runDay,
    previous,
    ...over,
  };
}
const idsOf = (ctx: ThemeNormalizeContext, rels: string[]) => rels.map((r) => [...ctx.rel].find(([, v]) => v === r)![0]);
const answer = (a: unknown) => themeAnswerSchema.parse(a);

describe("normalize: every state and retired", () => {
  test("new, rising, steady, fading, a revived retired id, a retired theme, and a quiet retired theme dropped", () => {
    const recent = (n: number) => addDays(RUN_DAY, -n);
    const sources: Record<string, string> = {
      "sources/f1.md": recent(1),
      "sources/c1.md": recent(1),
      "sources/c2.md": recent(2),
      "sources/c3.md": recent(3),
      "sources/s1.md": recent(2),
      "sources/s2.md": recent(5),
      "sources/s3.md": recent(16),
      "sources/s4.md": recent(20),
      "sources/d1.md": recent(15),
      "sources/d2.md": recent(18),
      "sources/d3.md": recent(25),
      "sources/b1.md": recent(4),
    };
    const previous = themeMap({
      efforts: [
        theme("climb", "Climb", ["sources/c1.md"]),
        theme("flat", "Flat", ["sources/s3.md"]),
        theme("fade", "Fade", ["sources/d1.md"]),
        theme("gone", "Gone", ["sources/old1.md", "sources/old2.md"], { weekly: [{ week: "2026-W38", start: "2026-09-14", count: 2 }] }),
      ],
      retired: [
        { id: "back", name: "Back", lastActive: Date.parse("2026-08-01"), weekly: [{ week: "2026-W31", start: "2026-07-27", count: 4 }] },
        { id: "ancient", name: "Ancient", lastActive: Date.parse("2026-03-01"), weekly: [] },
      ],
    });
    const ctx = ctxFor(sources, RUN_DAY, previous, { createdDayOf: (r) => (r.startsWith("sources/old") ? "2026-09-15" : sources[r]) });
    const out = normalizeThemeAnswer(
      answer({
        themes: [
          { id: "fresh", name: "Fresh", sources: idsOf(ctx, ["sources/f1.md"]) },
          { id: "climb", name: "Climb", sources: idsOf(ctx, ["sources/c1.md", "sources/c2.md", "sources/c3.md"]) },
          { id: "flat", name: "Flat", sources: idsOf(ctx, ["sources/s1.md", "sources/s2.md", "sources/s3.md", "sources/s4.md"]) },
          { id: "fade", name: "Fade", sources: idsOf(ctx, ["sources/d1.md", "sources/d2.md", "sources/d3.md"]) },
          { id: "back", name: "Back", sources: idsOf(ctx, ["sources/b1.md"]) },
        ],
      }),
      ctx,
    );
    expect(out.efforts.map((e) => [e.id, e.state, e.trend])).toEqual([
      ["fresh", "new", { recent: 1, earlier: 0 }],
      ["climb", "rising", { recent: 3, earlier: 0 }],
      ["flat", "steady", { recent: 2, earlier: 2 }],
      ["fade", "fading", { recent: 0, earlier: 3 }],
      ["back", "steady", { recent: 1, earlier: 0 }],
    ]);
    // A revived id keeps its frozen weeks; a new one starts with a partial straddling week.
    expect(out.efforts.find((e) => e.id === "back")!.weekly[0]).toMatchObject({ start: "2026-07-27", count: 4 });
    expect(out.retired).toEqual([{ id: "gone", name: "Gone", lastActive: Date.parse("2026-09-15"), weekly: [{ week: "2026-W38", start: "2026-09-14", count: 2 }] }]);
    expect(parseThemeMap(JSON.stringify(themeMap({ ...out, kind: "themes" })))).not.toBeNull();
  });

  test("first run: no previous map, so no theme is new", () => {
    const ctx = ctxFor({ "sources/a.md": addDays(RUN_DAY, -1) }, RUN_DAY, null);
    const out = normalizeThemeAnswer(answer({ themes: [{ id: "a", name: "A", sources: ["p1"] }] }), ctx);
    expect(out.efforts[0]!.state).toBe("steady");
  });

  test("themeState thresholds", () => {
    expect(themeState(4, 2, false)).toBe("rising");
    expect(themeState(3, 2, false)).toBe("steady");
    expect(themeState(2, 0, false)).toBe("steady");
    expect(themeState(2, 4, false)).toBe("fading");
    expect(themeState(3, 4, false)).toBe("steady");
    expect(themeState(0, 0, true)).toBe("new");
  });
});

describe("normalize: references, domains, caps", () => {
  test("ids slugged and deduped; unknown sources, hubs and readFirst outside the theme dropped; connections become related", () => {
    const ctx = ctxFor({ "sources/a.md": "2026-10-30", "sources/b.md": "2026-10-29", "sources/c.md": "2026-10-28" }, RUN_DAY, null, {
      hubByName: new Map([["hub a", "concepts/Hub A.md"]]),
      resolveHub: (n) => (n === "Hub Z" ? "entities/Hub Z.md" : undefined),
    });
    const out = normalizeThemeAnswer(
      answer({
        themes: [
          { id: "Alpha Theme", name: "A", sources: ["p1", "p99", "p2"], readFirst: ["p3", "p1"], hubs: ["hub A", "Hub Z", "Nope"] },
          { id: "alpha-theme", name: "dup", sources: ["p3"] },
          { id: "beta", name: "B", sources: ["p2", "p3"] },
          { id: "empty", name: "E", sources: ["p404"] },
        ],
        connections: [
          { a: "alpha-theme", b: "beta", why: "shared ⟨p1⟩" },
          { a: "beta", b: "missing", why: "x" },
          { a: "beta", b: "beta", why: "self" },
        ],
      }),
      ctx,
    );
    expect(out.efforts.map((e) => [e.id, e.pages.map((p) => p.id)])).toEqual([
      ["alpha-theme", ["sources/a.md", "sources/b.md"]],
      ["beta", ["sources/c.md"]],
    ]);
    const a = out.efforts[0]!;
    expect(a.readFirst).toEqual(["sources/a.md"]);
    expect(a.hubs).toEqual(["concepts/Hub A.md", "entities/Hub Z.md"]);
    expect(a.related).toEqual([{ id: "beta", why: "shared ⟦sources/a.md⟧" }]);
    expect(out.efforts[1]!.related).toEqual([{ id: "alpha-theme", why: "shared ⟦sources/a.md⟧" }]);
    expect(out.loose).toEqual([]);
  });

  test("a theme keeps its majority domain; the rest and every unplaced active source end in loose; groups by domain", () => {
    const ctx = ctxFor({ "sources/a.md": "2026-10-30", "sources/b.md": "2026-10-29", "life/sources/l.md": "2026-10-28", "life/sources/m.md": "2026-10-27", "sources/u.md": "2026-10-20" }, RUN_DAY, null);
    const out = normalizeThemeAnswer(
      answer({
        themes: [
          { id: "ai", name: "AI", domain: "life", sources: ["p1", "p2", "p3"] },
          { id: "life", name: "Life", sources: ["p4"] },
        ],
        loose: ["p5", "p5"],
      }),
      ctx,
    );
    expect(out.efforts.map((e) => [e.id, e.domain, e.pages.length])).toEqual([
      ["ai", "ai", 2],
      ["life", "life", 1],
    ]);
    expect(out.loose.sort()).toEqual(["life/sources/l.md", "sources/u.md"]);
    expect(out.themes).toEqual([
      { name: "AI & tech", efforts: ["ai"] },
      { name: "Life", efforts: ["life"] },
    ]);
  });

  test("worth a look: non-qualifying drift dropped, at most 2 drift ranked by sinceUpdate, then 6 items; counts", () => {
    const hubs = ["h1", "h2", "h3", "h4"].map((n, i) => ({
      relPath: `concepts/${n}.md`,
      name: n,
      folder: "concepts",
      links: 40,
      updated: "2026-08-01",
      sinceUpdate: [30, 25, 40, 3][i]!,
      share: 1,
      drift: i < 3,
    }));
    const ctx = ctxFor({ "sources/a.md": "2026-10-30", "sources/b.md": "2026-10-29" }, RUN_DAY, null, {
      hubs,
      hubByName: new Map(hubs.map((h) => [h.name, h.relPath])),
    });
    const drift = (h: string) => ({ title: `drift ${h}`, kind: "drift" as const, hubs: [h] });
    const out = normalizeThemeAnswer(
      answer({
        themes: [{ id: "t", name: "T", sources: ["p1", "p2"] }],
        worthALook: [
          { title: "gap", kind: "gap", sources: ["p1", "p2", "p9"], theme: "t" },
          drift("h1"),
          drift("h4"),
          drift("h2"),
          drift("h3"),
          { title: "c1", kind: "contradiction", sources: ["p1"] },
          { title: "s1", kind: "shift", theme: "nope" },
          { title: "s2", kind: "shift" },
          { title: "s3", kind: "shift" },
        ],
      }),
      ctx,
    );
    expect(out.needsYou.map((n) => [n.title, n.count])).toEqual([
      ["gap", 2],
      ["drift h1", 30],
      ["drift h3", 40],
      ["c1", 1],
      ["s1", 0],
      ["s2", 0],
    ]);
    expect(out.needsYou[0]!.effort).toBe("t");
    expect(out.needsYou[4]!.effort).toBeUndefined();
    expect(out.needsYou[1]!.hubs).toEqual(["concepts/h1.md"]);
  });
});

describe("weekly", () => {
  test("ISO weeks", () => {
    expect(isoMonday("2026-10-31")).toBe("2026-10-26");
    expect(isoWeekLabel("2026-10-31")).toBe("2026-W44");
    expect(isoWeekLabel("2026-01-01")).toBe("2026-W01");
    expect(isoWeekLabel("2027-01-01")).toBe("2026-W53");
    expect(themeWindowStart("2026-10-31")).toBe("2026-10-04");
    expect(firstRecountedMonday("2026-10-31")).toBe("2026-10-05");
    expect(firstRecountedMonday("2026-11-01")).toBe("2026-10-05");
  });

  test("a first run marks the straddling week partial and recounts the rest", () => {
    const w = themeWeekly(["2026-10-04", "2026-10-05", "2026-10-30"], null, null, RUN_DAY);
    expect(w).toEqual([
      { week: "2026-W40", start: "2026-09-28", count: 1, partial: true },
      { week: "2026-W41", start: "2026-10-05", count: 1 },
      { week: "2026-W42", start: "2026-10-12", count: 0 },
      { week: "2026-W43", start: "2026-10-19", count: 0 },
      { week: "2026-W44", start: "2026-10-26", count: 1 },
    ]);
  });

  test("a carried week is partial when the previous run came before it ended", () => {
    const prior = [{ week: "2026-W40", start: "2026-09-28", count: 3 }];
    expect(themeWeekly([], prior, "2026-10-02", RUN_DAY)[0]).toEqual({ week: "2026-W40", start: "2026-09-28", count: 3, partial: true });
    expect(themeWeekly([], prior, "2026-10-30", RUN_DAY)[0]).toEqual({ week: "2026-W40", start: "2026-09-28", count: 3 });
  });

  test("nightly across week boundaries: a frozen week holds its full 7-day count, and the invariant holds every night", () => {
    // One source a day; a theme holding every active source.
    const first = "2026-09-23"; // window starts on a Thursday
    let previous: ThemeMap | null = null;
    const frozenSeen = new Map<string, number>();
    for (let night = 0; night < 45; night++) {
      const runDay = addDays(first, night);
      const windowStart = themeWindowStart(runDay);
      const sources: Record<string, string> = {};
      for (let d = windowStart; d <= runDay; d = addDays(d, 1)) sources[`sources/${d}.md`] = d;
      const ctx = ctxFor(sources, runDay, previous);
      const out = normalizeThemeAnswer(answer({ themes: [{ id: "daily", name: "Daily", sources: [...ctx.rel.keys()] }] }), ctx);
      const t = out.efforts[0]!;
      // Invariant: weeks starting on or after the window start sum to the members created in them.
      const fromMon = firstRecountedMonday(runDay);
      const counted = t.weekly.filter((w) => w.start >= windowStart).reduce((n, w) => n + w.count, 0);
      expect(counted).toBe(Object.values(sources).filter((d) => d >= fromMon).length);
      for (const w of t.weekly) if (w.start < fromMon && !w.partial) frozenSeen.set(w.start, w.count);
      previous = themeMap({ ...out, runAtMs: Date.parse(`${runDay}T10:00:00Z`) });
    }
    // Every week frozen after the first night is whole; the first night's straddling week stays partial.
    expect(frozenSeen.size).toBeGreaterThanOrEqual(4);
    for (const [, count] of frozenSeen) expect(count).toBe(7);
    expect(previous!.efforts[0]!.weekly.find((w) => w.start === isoMonday(themeWindowStart(first)))?.partial).toBe(true);
  });

  test("a source moving to another theme takes its recounted week; carried weeks stay", () => {
    const sources = { "sources/x.md": "2026-10-28", "sources/y.md": "2026-10-27" };
    const previous = themeMap({
      runAtMs: NOW - DAY,
      efforts: [
        theme("a", "A", ["sources/x.md", "sources/y.md"], { weekly: [{ week: "2026-W39", start: "2026-09-21", count: 5 }, { week: "2026-W44", start: "2026-10-26", count: 2 }] }),
        theme("b", "B", []),
      ],
    });
    const ctx = ctxFor(sources, RUN_DAY, previous);
    const out = normalizeThemeAnswer(answer({ themes: [{ id: "a", name: "A", sources: ["p2"] }, { id: "b", name: "B", sources: ["p1"] }] }), ctx);
    const wk = (id: string, start: string) => out.efforts.find((e) => e.id === id)!.weekly.find((w) => w.start === start)?.count;
    expect([wk("a", "2026-09-21"), wk("a", "2026-10-26"), wk("b", "2026-10-26")]).toEqual([5, 1, 1]);
  });
});

// --- the run ---------------------------------------------------------------

function indexPages(): WikiPageMeta[] {
  return fixturePages().pages.map((p) => ({ aliases: [], steps: [], ...p }) as unknown as WikiPageMeta);
}
function themeIndex(): WikiIndex {
  const pages = indexPages();
  const { outgoing } = fixturePages();
  return {
    pages,
    outgoing,
    resolve: (t: string) => pages.find((p) => p.name.toLowerCase() === t.toLowerCase()),
    gitTouches: new Map(),
  } as unknown as WikiIndex;
}

function themeDeps(over: Partial<WorkMapRunDeps> = {}, files: Record<string, string> = {}) {
  const models: ModelRequest[] = [];
  const written: string[] = [];
  const d: WorkMapRunDeps = {
    config: { workMapWikis: ["kb"], workMapModel: "m", schedulerEnabled: true, profile: "default" },
    now: () => NOW,
    registry: () => [{ name: "kb", root: "/w/kb", source: "extra" } as never],
    isReadonly: () => false,
    isReadonlyRoot: () => false,
    // A themes run never asks claude-usage: these would refuse a work run.
    inputs: {
      urlConfigured: false,
      ledger: async () => ({ ok: false, reason: "never asked" }),
      sessions: async () => ({ memo: null, timedOut: true }),
      rebuildIndex: async () => themeIndex(),
    },
    readText: async (p) => {
      const name = p.split("/").pop()!;
      if (name === ".wiki-reader.json") return files[name] ?? '{"workMap":{"kind":"themes"}}';
      return files[name] ?? null;
    },
    model: async (req) => {
      models.push(req);
      return {
        text: JSON.stringify({
          summary: "Reading ⟨p1⟩.",
          themes: [
            { id: "agents", name: "Agents", domain: "ai", hubs: ["Hub A"], sources: ["p1", "p2", "p4", "p5", "p7", "p8", "p9"], readFirst: ["p1"], takeaway: "t", confidence: 0.8 },
            { id: "health", name: "Health", domain: "life", sources: ["p3", "p6"] },
          ],
          connections: [{ a: "agents", b: "health", why: "w" }],
          worthALook: [{ kind: "gap", title: "No hub for X", sources: ["p1", "p2"], theme: "agents" }],
          loose: [],
        }),
        costUsd: 0.7,
      };
    },
    write: async (o) => {
      written.push(o.content);
      return { outcome: "written" };
    },
    state: memoryStateStore(),
    ...over,
  };
  return { d, models, written };
}

describe("the themes run", () => {
  test("reads the kind before the gate, skips claude-usage, and writes a themes map that reads back by kind", async () => {
    const { d, models, written } = themeDeps();
    const res = await startWorkMapRun("kb", d).promise;
    expect(res.outcome).toBe("ok");
    expect(models[0]!.systemPrompt).toContain("KNOWLEDGE wiki");
    expect(models[0]!.prompt).toContain("## Hub pages");
    const stored = readMapFile(written[0]!);
    expect(stored?.kind).toBe("themes");
    const map = stored!.map as ThemeMap;
    expect(map.coverage).toMatchObject({ activeSources: 9, placed: 9, hubs: 2, windowDays: 28 });
    expect(map.efforts.map((e) => [e.id, e.domain, e.hubs, e.related])).toEqual([
      ["agents", "ai", ["concepts/Hub A.md"], [{ id: "health", why: "w" }]],
      ["health", "life", [], [{ id: "agents", why: "w" }]],
    ]);
    expect(map.needsYou).toEqual([{ title: "No hub for X", kind: "gap", why: "", action: "", pages: ["sources/a1.md", "sources/a2.md"], effort: "agents", hubs: [], count: 2 }]);
    expect(map.loose).toEqual([]);
    expect(map.usage).toEqual({ costUsd: 0.7 });
  });

  test("a previous map of the other kind reads as none", async () => {
    const workMap = JSON.stringify({ version: WORK_MAP_VERSION, wiki: "kb", runAtMs: NOW - DAY, model: "m", coverage: { sessionsSinceMs: 0, sessionsAsOfMs: 0, touchWindowDays: 28, activePages: 0, threads: 0, logEntries: 0, digestChars: 0, warnings: [] }, summary: "", needsYou: [], themes: [], efforts: [{ id: "agents", name: "Old", aliases: [], oneLine: "", state: "active", pages: [], why: "", confidence: 1, next: "", related: [], daily: [] }], loose: [] });
    expect(previousMapOf(workMap, "themes")).toBeNull();
    expect(previousMapOf(workMap, "work")).not.toBeNull();
    const { d, models, written } = themeDeps({}, { ".work-map.json": workMap });
    await startWorkMapRun("kb", d).promise;
    expect(models[0]!.prompt).not.toContain("## The previous map");
    // No previous themes map ⇒ first run ⇒ no theme is new.
    expect((readMapFile(written[0]!)!.map as ThemeMap).efforts.every((e) => e.state !== "new")).toBe(true);
    // And a themes map is none to a work run.
    expect(previousMapOf(written[0]!, "work")).toBeNull();
  });

  test("a work wiki (no workMap key) keeps the work path: it refuses without claude-usage", async () => {
    const { d, models } = themeDeps({}, { ".wiki-reader.json": "{}" });
    const res = await startWorkMapRun("kb", d).promise;
    expect(res).toEqual({ outcome: "refused", reason: "claude-usage not configured (CLAUDE_USAGE_URL is unset)" });
    expect(models).toHaveLength(0);
  });

  test("a themes answer that is not a theme map fails and writes nothing", async () => {
    const { d, written } = themeDeps({ model: async () => ({ text: JSON.stringify({ themes: [{ name: "no id" }] }) }) });
    const res = await startWorkMapRun("kb", d).promise;
    expect(res.outcome).toBe("failed");
    expect(written).toHaveLength(0);
  });

  test("no source in the window refuses before the model call", async () => {
    const { d, models } = themeDeps({ now: () => NOW + 400 * DAY });
    const res = await startWorkMapRun("kb", d).promise;
    expect(res.outcome).toBe("refused");
    expect(models).toHaveLength(0);
  });
});
