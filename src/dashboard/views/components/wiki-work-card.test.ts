import { describe, expect, test } from "bun:test";
import { WORK_MAP_VERSION, type WorkMap } from "../../../wiki/work-map/schema.ts";
import { metadataFilterWarning } from "../../../wiki/work-map/run.ts";
import {
  formatAge,
  isNestedEffort,
  isWorkMapStale,
  laneEfforts,
  lastActiveDays,
  needKey,
  parseDone,
  pollState,
  proseHtml,
  proseText,
  refreshRefusalText,
  workCardHtml,
  writeDone,
  WORK_MAP_STALE_MS,
  THEME_STRIP_WEEKS,
  themeActiveLabel,
  themeConnections,
  weeklyStripHtml,
  type WorkMapGetBody,
} from "./wiki-work-card.ts";
import { fixtureTheme, fixtureThemeMap, fixtureThemePages, THEME_RUN_AT } from "../../../test/theme-map-fixture.ts";
import type { ThemeMap } from "../../../wiki/work-map/theme-schema.ts";

const NOW = Date.parse("2026-10-29T12:00:00");
const HOUR = 3_600_000;

function effort(id: string, state: WorkMap["efforts"][number]["state"], pages: string[], extra: Partial<WorkMap["efforts"][number]> = {}): WorkMap["efforts"][number] {
  return { id, name: `Effort ${id}`, aliases: [], oneLine: "", state, pages: pages.map((p) => ({ id: p, role: "plan" as const })), why: "", confidence: 1, next: "", related: [], daily: [], ...extra };
}

function map(over: Partial<WorkMap> = {}): WorkMap {
  return {
    version: WORK_MAP_VERSION,
    wiki: "w",
    runAtMs: NOW - 2 * HOUR,
    model: "opus-test",
    coverage: { sessionsSinceMs: NOW - 8 * 24 * HOUR, sessionsAsOfMs: NOW - 2 * HOUR, touchWindowDays: 28, activePages: 12, threads: 3, logEntries: 120, logEntriesInWindow: 140, digestChars: 1000, warnings: [] },
    summary: "Two efforts move: ⟦plans/a.mdx⟧ and ⟦plans/gone.mdx⟧.",
    needsYou: [
      { title: "Decide ⟦plans/a.mdx⟧", kind: "decision", why: "why", action: "act", pages: ["plans/a.mdx"] },
      { title: "Second", kind: "followup", why: "", action: "", pages: [] },
    ],
    themes: [],
    efforts: [effort("alpha", "active", ["plans/a.mdx", "plans/gone.mdx"]), effort("beta", "cooling", ["plans/b.mdx"]), effort("gamma", "shipped", ["plans/c.mdx"])],
    loose: [],
    ...over,
  };
}

const PAGES = [
  { relPath: "plans/a.mdx", title: "Plan A" },
  { relPath: "plans/b.mdx", title: "Plan <B>" },
  { relPath: "plans/c.mdx", title: "Plan C" },
];
const href = (rel: string) => `/wiki?relPath=${encodeURIComponent(rel)}`;

function card(m: WorkMap, over: Partial<Omit<WorkMapGetBody, "map">> = {}, done = new Set<string>()): string {
  return workCardHtml({ body: { map: m, organizable: false, ...over }, pages: PAGES, now: NOW, done, hrefFor: href, refresh: { phase: "idle" } });
}

describe("workCardHtml", () => {
  test("renders the age, the model, the summary links and the coverage", () => {
    const html = card(map());
    expect(html).toContain("organized 2 h ago");
    expect(html).toContain("opus-test");
    expect(html).toContain('data-relpath="plans/a.mdx">Plan A</a>');
    // A marker to a page the listing no longer holds is plain text.
    expect(html).toContain("and gone.");
    expect(html).not.toContain('data-relpath="plans/gone.mdx"');
    expect(html).toContain("12 active pages · 3 threads · log: the newest 120 of 140 shown");
    expect(html).not.toContain("wiki-wm-stale");
  });

  test("marks a map older than 26 h stale", () => {
    expect(card(map({ runAtMs: NOW - WORK_MAP_STALE_MS - 1 }))).toContain("wiki-wm-stale");
    expect(card(map({ runAtMs: NOW - WORK_MAP_STALE_MS + 60_000 }))).not.toContain("wiki-wm-stale");
  });

  test("shows ↻ only when organizable", () => {
    expect(card(map())).not.toContain("wikiWorkMapRefresh");
    expect(card(map(), { organizable: true, lastSuccessAt: NOW - 3 * HOUR })).toContain("last run 3 h ago");
  });

  test("Moving is open; Cooling and Quiet-and-shipped are closed", () => {
    const html = card(map());
    expect(html).toMatch(/data-wm-lane="moving" open>/);
    expect(html).toMatch(/data-wm-lane="cooling">/);
    expect(html).toMatch(/data-wm-lane="quiet">/);
  });

  test("escapes every model string and listing title", () => {
    const m = map({ summary: "<img src=x onerror=1> ⟦plans/b.mdx⟧", model: "<b>m</b>" });
    m.efforts[0]!.name = '"><script>';
    const html = card(m);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>m</b>");
    expect(html).toContain("Plan &lt;B&gt;");
  });

  test("a Needs-you item does not repeat a page its prose already links", () => {
    const html = card(map());
    const first = html.slice(html.indexOf('data-wm-need="0"'), html.indexOf('data-wm-need="1"'));
    expect(first.match(/data-relpath="plans\/a.mdx"/g)).toHaveLength(1);
  });

  test("a done Needs-you item is hidden and counted", () => {
    const m = map();
    const html = card(m, {}, new Set([needKey(m.needsYou[0]!)]));
    expect(html).not.toContain('data-wm-need="0"');
    expect(html).toContain('data-wm-need="1"');
    expect(html).toContain("1 done · show");
  });

  test("a why carries a keyboard control for its clamp, hidden until the client finds it clamped", () => {
    const html = card(map());
    const why = html.slice(html.indexOf('class="wiki-wm-why'), html.indexOf('class="wiki-wm-action'));
    expect(why).toContain('<div class="wiki-wm-why-text" id="wikiWmWhy0"');
    expect(why).toMatch(/<button type="button" class="wiki-wm-why-more" data-wm-why="decision\|Decide ⟦plans\/a.mdx⟧" aria-controls="wikiWmWhy0" aria-expanded="false" hidden>more<\/button>/);
    expect(why).not.toContain("wiki-wm-why open");
  });

  test("a why the reader opened renders open, its control shown and expanded", () => {
    const m = map();
    const html = workCardHtml({ body: { map: m, organizable: false }, pages: PAGES, now: NOW, done: new Set(), openWhy: new Set([needKey(m.needsYou[0]!)]), hrefFor: href, refresh: { phase: "idle" } });
    expect(html).toContain('class="wiki-wm-why open"');
    expect(html).toMatch(/aria-expanded="true">less<\/button>/);
  });

  test("the degraded-filter warning P1 wrote shows once", () => {
    const m = map();
    m.coverage.metadataFilter = { degraded: true, reason: "steps", pages: 4 };
    m.coverage.warnings = [metadataFilterWarning(m.coverage.metadataFilter)!, "Active pages fell from 90 to 30."];
    const html = card(m);
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html).toContain("4 page(s)");
    expect(html).toContain("Active pages fell from 90 to 30.");
  });

  test("a sub-effort renders under its parent, not as its own row", () => {
    const m = map({ efforts: [effort("p", "active", ["plans/a.mdx"]), effort("k", "active", ["plans/b.mdx"], { parent: "p" })] });
    const html = card(m);
    expect(html).toMatch(/data-effort-id="p">[\s\S]*wiki-wm-sub[\s\S]*data-effort-id="k"/);
    expect(html.match(/data-effort-id="k"/g)).toHaveLength(1);
  });
});

describe("lanes and nesting", () => {
  test("a Moving sub-effort of a closed-lane parent renders in Moving, naming its parent", () => {
    const m = map({ efforts: [effort("p", "shipped", ["plans/a.mdx"]), effort("k", "active", ["plans/b.mdx"], { parent: "p" }), effort("q", "cooling", [], { parent: "p" })] });
    const html = card(m);
    const lane = (id: string) => html.slice(html.indexOf(`data-wm-lane="${id}"`), html.indexOf("</details>", html.indexOf(`data-wm-lane="${id}"`)));
    expect(lane("moving")).toContain('data-effort-id="k"');
    expect(lane("moving")).toContain("part of Effort p");
    expect(lane("moving")).toContain('wiki-wm-count">1<');
    expect(lane("quiet")).not.toContain('data-effort-id="k"');
    // A closed child of a closed parent stays nested, and counts in the lane it renders in.
    expect(lane("quiet")).toContain('data-effort-id="q"');
    expect(lane("quiet")).toContain('wiki-wm-count">2<');
    expect(html.match(/data-effort-id="k"/g)).toHaveLength(1);
  });
  test("a Moving sub-effort of a Moving parent stays nested and counts in Moving", () => {
    const m = map({ efforts: [effort("p", "active", []), effort("k", "blocked", [], { parent: "p" })] });
    const html = card(m);
    expect(html).toMatch(/data-effort-id="p">[\s\S]*wiki-wm-sub[\s\S]*data-effort-id="k"/);
    expect(html).not.toContain("part of");
    expect(html).toContain('wiki-wm-count">2<');
  });
  test("a Moving grandchild under a closed-state child of a Moving effort renders once, top-level in Moving", () => {
    const m = map({ efforts: [effort("g", "active", []), effort("c", "cooling", [], { parent: "g" }), effort("k", "active", [], { parent: "c" })] });
    const html = card(m);
    expect(html.match(/data-effort-id="k"/g)).toHaveLength(1);
    expect(html).toContain("part of Effort c");
    expect(html).toContain('data-wm-lane="moving"');
    expect(html).toContain('wiki-wm-count">3<');
  });
  test("duplicate effort ids that cross-parent render once each, without overflowing", () => {
    const m = map({ efforts: [effort("a", "active", [], { parent: "b" }), effort("a", "active", []), effort("b", "active", [], { parent: "a" }), effort("b", "active", [])] });
    const html = card(m);
    expect(html.match(/data-effort-id="a"/g)).toHaveLength(1);
    expect(html.match(/data-effort-id="b"/g)).toHaveLength(1);
  });
  test("a parent cycle leaves both efforts top-level", () => {
    const es = [effort("a", "active", [], { parent: "b" }), effort("b", "active", [], { parent: "a" })];
    expect(es.map((e) => isNestedEffort(e, es))).toEqual([false, false]);
    expect(laneEfforts(es.map((e) => ({ ...e, pages: [], movedOut: [] })))[0]!.efforts.map((e) => e.id)).toEqual(["a", "b"]);
  });
  test("a missing parent leaves the effort top-level", () => {
    const es = [effort("a", "cooling", [], { parent: "zz" })];
    expect(isNestedEffort(es[0]!, es)).toBe(false);
  });
  test("lastActiveDays reads the newest day with activity", () => {
    const daily = [
      { day: "2026-10-20", commits: 1, sessions: 0 },
      { day: "2026-10-27", commits: 0, sessions: 2 },
      { day: "2026-10-28", commits: 0, sessions: 0 },
    ];
    expect(lastActiveDays({ daily }, NOW)).toBe(2);
    expect(lastActiveDays({ daily: [] }, NOW)).toBeNull();
  });
});

describe("done store", () => {
  test("is keyed by run time: another run reads empty", () => {
    const raw = writeDone(null, 100, "decision|x", true);
    expect([...parseDone(raw, 100)]).toEqual(["decision|x"]);
    expect(parseDone(raw, 200).size).toBe(0);
    expect(parseDone("not json", 100).size).toBe(0);
    expect(parseDone(writeDone(raw, 100, "decision|x", false), 100).size).toBe(0);
  });
});

describe("prose and ages", () => {
  test("proseHtml escapes text around markers", () => {
    const byKey = new Map([["plans/a.mdx", PAGES[0]!]]);
    expect(proseHtml("a<b ⟦Plans/A.mdx⟧", byKey, href)).toBe('a&lt;b <a class="wiki-wm-link" href="/wiki?relPath=plans%2Fa.mdx" data-relpath="plans/a.mdx">Plan A</a>');
  });
  test("proseHtml separates markers with only whitespace between them", () => {
    const byKey = new Map([["plans/a.mdx", PAGES[0]!]]);
    const sep = '<span class="wiki-wm-sep"> · </span>';
    const html = proseHtml("⟦plans/a.mdx⟧ ⟦plans/gone.mdx⟧ moved; ⟦plans/a.mdx⟧⟦plans/a.mdx⟧, ⟦plans/gone.mdx⟧", byKey, href);
    expect(html.split(sep).length - 1).toBe(2);
    expect(html).toContain("</a>" + sep + "gone moved");
    expect(html).toContain("</a>" + sep + "<a ");
    expect(html).toContain("</a>, gone");
  });
  test("proseText reads markers as titles with the same separator proseHtml puts between back-to-back markers", () => {
    const byKey = new Map([["plans/a.mdx", PAGES[0]!]]);
    expect(proseText("a<b ⟦plans/a.mdx⟧ ⟦plans/gone.mdx⟧ moved; ⟦plans/a.mdx⟧⟦plans/a.mdx⟧, ⟦plans/gone.mdx⟧", byKey)).toBe(
      "a<b Plan A · gone moved; Plan A · Plan A, gone",
    );
  });
  test("formatAge and isWorkMapStale", () => {
    expect(formatAge(30_000)).toBe("just now");
    expect(formatAge(5 * 60_000)).toBe("5 min ago");
    expect(formatAge(3 * HOUR)).toBe("3 h ago");
    expect(formatAge(72 * HOUR)).toBe("3 d ago");
    expect(isWorkMapStale(NOW - 27 * HOUR, NOW)).toBe(true);
  });
});

describe("↻", () => {
  test("refusal copy", () => {
    expect(refreshRefusalText(429, { retryAfterMs: 4 * 60_000, lastSuccessAt: NOW - 6 * 60_000 }, NOW)).toBe("Ran 6 min ago — try again in 4 min.");
    expect(refreshRefusalText(429, { retryAfterMs: 60_000, lastFailedAt: NOW - 9 * 60_000 }, NOW)).toBe("A run failed 9 min ago — try again in 1 min.");
    expect(refreshRefusalText(403, { error: "not in WORK_MAP_WIKIS" }, NOW)).toContain("not in WORK_MAP_WIKIS");
  });
  test("pollState: updated, settled, pending", () => {
    const m = map();
    expect(pollState({ map: { ...m, runAtMs: m.runAtMs + 1 }, organizable: true }, m.runAtMs, NOW).state).toBe("updated");
    expect(pollState({ map: m, organizable: true, running: { startedAt: NOW } }, m.runAtMs, NOW).state).toBe("pending");
    expect(pollState({ map: m, organizable: true, lastAttempt: { at: NOW - 1, outcome: "failed" } }, m.runAtMs, NOW).state).toBe("pending");
    const s = pollState({ map: m, organizable: true, lastAttempt: { at: NOW, outcome: "refused", error: "cold" } }, m.runAtMs, NOW);
    expect(s).toEqual({ state: "settled", attempt: { at: NOW, outcome: "refused", error: "cold" } });
  });
});

describe("What you're following (a themes map, theme map P2)", () => {
  const T_NOW = THEME_RUN_AT + 2 * HOUR;
  const themeCard = (m: ThemeMap = fixtureThemeMap(), done = new Set<string>()) =>
    workCardHtml({
      body: { map: m, organizable: true },
      pages: fixtureThemePages(),
      now: T_NOW,
      done,
      hrefFor: href,
      effortHref: (id) => `/wiki?effort=${id}`,
      refresh: { phase: "idle" },
    });

  test("the head, Worth a look and the coverage read the themes words", () => {
    const html = themeCard();
    expect(html).toContain('<span class="wiki-wn-title">What you’re following</span>');
    expect(html).not.toContain("Your work");
    expect(html).toContain("Worth a look");
    expect(html).not.toContain("Needs you");
    expect(html).toContain('<div class="wiki-wm-coverage">9 sources in 28 days · 3 hubs</div>');
    expect(html).not.toContain("active page");
  });

  test("a drift item shows the runner's count; another kind shows its sources; hubs render as chips", () => {
    const html = themeCard();
    expect(html).toContain(">12 new since update</span>");
    expect(html).toContain(">2 sources</span>");
    expect(html).toContain('<span class="wiki-wm-hub"><a class="wiki-wm-link" href="/wiki?relPath=concepts%2FHub%20X.md" data-relpath="concepts/Hub X.md">Hub X</a></span>');
  });

  test("✓ hides an item by its needKey", () => {
    const html = themeCard(fixtureThemeMap(), new Set([needKey({ kind: "drift", title: "Hub X is behind its sources" })]));
    expect(html).not.toContain("12 new since update");
    expect(html).toContain("1 done · show");
  });

  test("Connected lists each pair once, A ↔ B: why, with the first end's why", () => {
    const html = themeCard();
    const conns = [...html.matchAll(/data-wm-conn="([^"]+)"/g)].map((m) => m[1]);
    expect(conns).toEqual(["alpha|beta", "beta|gamma"]);
    expect(html).toContain("Both lean on Hub X.");
    expect(html).not.toContain("The other end");
    expect(html).toMatch(/data-effort-link="alpha">Theme alpha<\/a> <span class="wiki-wm-conn-arrow"[^>]*>↔<\/span> <a [^>]*data-effort-link="beta">Theme beta<\/a><span class="wiki-wm-conn-why">: Both lean on Hub X\.<\/span>/);
  });

  test("lanes New, Rising, Steady, Fading in that order, Fading closed; Life follows the AI lanes", () => {
    const html = themeCard();
    const lanes = [...html.matchAll(/<details class="wiki-wm-lane[^"]*" data-wm-lane="([a-z]+)"( open)?>/g)].map((m) => `${m[1]}${m[2] ? "+" : ""}`);
    expect(lanes).toEqual(["new+", "rising+", "steady+", "fading", "life+"]);
    const life = html.slice(html.indexOf('data-wm-lane="life"'));
    expect(life).toContain(">Life <span");
    expect(life).toContain('data-effort-id="life-one"');
    expect(html.indexOf('data-effort-id="life-one"')).toBeGreaterThan(html.indexOf('data-effort-id="delta"'));
  });

  test("each theme carries a weekly strip, its hubs and its sources", () => {
    const html = themeCard();
    expect((html.match(/class="wiki-wm-weeks"/g) ?? []).length).toBe(5);
    const alpha = html.slice(html.indexOf('data-effort-id="alpha"'), html.indexOf("</li>", html.indexOf('data-effort-id="alpha"')));
    expect(alpha).toContain("2 sources · this week");
    expect(alpha).toContain('aria-label="7 sources over the last 3 weeks"');
    expect(alpha).toContain('data-relpath="sources/alpha-2.mdx"');
  });

  test("a work map renders unchanged words (no themes branch)", () => {
    const html = card(map());
    expect(html).toContain('<span class="wiki-wn-title">Your work</span>');
    expect(html).toContain("Needs you");
    expect(html).not.toContain("wiki-wm-need-count");
  });
});

describe("theme helpers", () => {
  test("lastActiveDays reads the newest week with a source, from its Sunday", () => {
    const t = fixtureTheme("x");
    // W44 starts Monday 2026-10-26; its Sunday is 2026-11-01, after T_NOW.
    expect(lastActiveDays(t, Date.parse("2026-10-30T12:00:00"))).toBe(0);
    expect(lastActiveDays(t, Date.parse("2026-11-04T12:00:00"))).toBe(3);
    expect(lastActiveDays(fixtureTheme("y", { weekly: [{ week: "2026-W40", start: "2026-09-28", count: 0 }] }), NOW)).toBeNull();
    // A week with no source does not count: delta's newest active week is W40.
    const delta = fixtureTheme("d", { weekly: [{ week: "2026-W40", start: "2026-09-28", count: 3 }, { week: "2026-W41", start: "2026-10-05", count: 0 }] });
    expect(lastActiveDays(delta, Date.parse("2026-10-30T12:00:00"))).toBe(26);
    expect(themeActiveLabel(26)).toBe("4 wk ago");
    expect([0, 1, 7, 8].map(themeActiveLabel)).toEqual(["this week", "last week", "last week", "2 wk ago"]);
  });

  test("lastActiveDays on a work effort still reads daily", () => {
    expect(lastActiveDays({ daily: [{ day: "2026-10-27", commits: 1, sessions: 0 }] }, NOW)).toBe(2);
  });

  test("the strip shows the newest weeks only, oldest first, with partial weeks marked", () => {
    const weekly = Array.from({ length: THEME_STRIP_WEEKS + 2 }, (_, i) => ({ week: `W${i}`, start: `2026-08-${String(i + 10).padStart(2, "0")}`, count: i, ...(i === 9 ? { partial: true } : {}) }));
    const html = weeklyStripHtml(weekly.reverse());
    const titles = [...html.matchAll(/title="([^"]+)"/g)].map((m) => m[1]!.split(" ")[0]);
    expect(titles).toEqual(["W2", "W3", "W4", "W5", "W6", "W7", "W8", "W9"]);
    expect(html).toContain('class="wiki-wm-week lvl-4 partial"');
    expect(weeklyStripHtml([])).toBe("");
  });

  test("themeConnections drops a link to a theme not listed and a self link", () => {
    const a = { id: "a", related: [{ id: "a", why: "self" }, { id: "gone", why: "x" }, { id: "b", why: "ab" }] };
    const b = { id: "b", related: [{ id: "a", why: "ba" }] };
    expect(themeConnections([a, b]).map((c) => [c.a.id, c.b.id, c.why])).toEqual([["a", "b", "ab"]]);
  });
});
