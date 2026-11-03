import { describe, expect, test } from "bun:test";
import { WORK_MAP_VERSION, type WorkMap } from "../../../wiki/work-map/schema.ts";
import { metadataFilterWarning } from "../../../wiki/work-map/run.ts";
import {
  BOARD_COLUMNS,
  WORK_MAP_LANES,
  boardColumn,
  boardFacts,
  formatAge,
  isNestedEffort,
  isWorkMapStale,
  lastActiveDays,
  needKey,
  needMarksReader,
  parseDone,
  pollState,
  proseHtml,
  proseText,
  refreshRefusalText,
  SPARK_DAYS,
  sparkValues,
  STRIP_ROWS_SHOWN,
  stripKey,
  stripRows,
  workCardHtml,
  writeDone,
  WORK_MAP_STALE_MS,
  THEME_STRIP_WEEKS,
  THEME_CONNECTIONS_SHOWN,
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

  test("the five columns in order, Waiting on you and Moving open, each rendered even when empty", () => {
    const html = card(map({ efforts: [] }));
    const cols = [...html.matchAll(/<details class="wiki-wm-col" data-wm-lane="([a-z]+)" aria-label="[^"]*"( open)?>/g)].map((m) => `${m[1]}${m[2] ? "+" : ""}`);
    expect(cols).toEqual(["you+", "moving+", "cooling", "quiet", "shipped"]);
    expect(html.match(/wiki-wm-col-none">none</g)).toHaveLength(5);
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

});

describe("the board", () => {
  type Pg = { relPath: string; title: string; movesWaiting?: number; waitingSince?: string; movesYou?: number; plan_status?: string };
  const pg = (rel: string, over: Partial<Pg> = {}): Pg => ({ relPath: rel, title: rel, ...over });
  const render = (m: WorkMap, pages: Pg[], over: { done?: Set<string>; waitsCounted?: boolean; checks?: Parameters<typeof workCardHtml>[0]["checks"]; now?: number } = {}) =>
    workCardHtml({ body: { map: m, organizable: false }, pages, now: over.now ?? NOW, done: over.done ?? new Set(), hrefFor: href, effortHref: (id) => `/wiki?effort=${id}`, refresh: { phase: "idle" }, waitsCounted: over.waitsCounted ?? true, ...(over.checks ? { checks: over.checks } : {}) });
  const col = (html: string, id: string) => {
    const at = html.indexOf(`data-wm-lane="${id}"`);
    return html.slice(at, html.indexOf("</details>", at));
  };
  const columnOf = (html: string, effortId: string) => ["you", "moving", "cooling", "quiet", "shipped"].filter((c) => col(html, c).includes(`data-effort-id="${effortId}"`));
  const orderIn = (html: string, id: string) => [...col(html, id).matchAll(/wiki-wm-tile" data-effort-id="([^"]+)"/g)].map((m) => m[1]);
  const need = (effortId: string | undefined, title = "Do it", kind: "decision" | "followup" = "followup") => ({ title, kind, why: "", action: "", pages: [], ...(effortId ? { effort: effortId } : {}) }) as WorkMap["needsYou"][number];
  const only = (e: WorkMap["efforts"], needsYou: WorkMap["needsYou"] = []) => map({ efforts: e, needsYou, summary: "" });
  const checksFor = (runAt: number, entries: { kind: string; title: string; pr: number; state: "MERGED" | "OPEN"; asksForIt: boolean }[]) => ({
    body: { needs: entries.map((e) => ({ ...e, mergedAt: null })), contradictions: [], uncheckedRows: [], unlinkedRows: [], checked: 0, compared: 0, unchecked: 0, unlinked: 0, skipped: 0 } as never,
    answerRunAt: runAt,
  });

  test("BOARD_COLUMNS maps every state; a wait or an open item beats the state", () => {
    const quiet = { decisions: 0, steps: 0, needKinds: [] };
    for (const [state, column] of Object.entries(BOARD_COLUMNS)) expect(boardColumn({ state: state as "active" }, quiet)).toBe(column);
    expect(Object.keys(BOARD_COLUMNS).sort()).toEqual(["active", "blocked", "cooling", "proposed", "quiet", "shipped"]);
    expect(boardColumn({ state: "shipped" }, { ...quiet, decisions: 1 })).toBe("you");
    expect(boardColumn({ state: "quiet" }, { ...quiet, needKinds: ["followup"] })).toBe("you");
    // Steps alone move nothing.
    expect(boardColumn({ state: "quiet" }, { ...quiet, steps: 4 })).toBe("quiet");
  });

  test("the board's Moving column holds the states the rail's Moving lane does", () => {
    const moving = Object.entries(BOARD_COLUMNS).flatMap(([state, column]) => (column === "moving" ? [state] : []));
    expect(moving.sort()).toEqual([...WORK_MAP_LANES[0].states].sort());
  });

  test("one effort for each column rule", () => {
    const html = render(
      only(
        [effort("w", "quiet", ["w.mdx"]), effort("n", "cooling", ["n.mdx"]), effort("a", "active", ["a.mdx"]), effort("b", "blocked", ["a.mdx"]), effort("p", "proposed", ["a.mdx"]), effort("c", "cooling", ["a.mdx"]), effort("q", "quiet", ["a.mdx"]), effort("s", "shipped", ["a.mdx"])],
        [need("n")],
      ),
      [pg("w.mdx", { movesWaiting: 1 }), pg("n.mdx"), pg("a.mdx")],
    );
    const at = Object.fromEntries(["w", "n", "a", "b", "p", "c", "q", "s"].map((id) => [id, columnOf(html, id)]));
    expect(at).toEqual({ w: ["you"], n: ["you"], a: ["moving"], b: ["moving"], p: ["moving"], c: ["cooling"], q: ["quiet"], s: ["shipped"] });
  });

  test("an effort with no page is not on the board, though the map holds it", () => {
    const html = render(only([effort("empty", "active", ["gone.mdx"]), effort("a", "active", ["a.mdx"])]), [pg("a.mdx")]);
    expect(html).not.toContain('data-effort-id="empty"');
    expect(col(html, "moving")).toContain('wiki-wm-count">1<');
  });

  test("waitsCounted false: no question rule and no decisions pill; Needs you and steps still run", () => {
    const m = only([effort("w", "quiet", ["w.mdx"]), effort("n", "quiet", ["n.mdx"])], [need("n")]);
    const pages = [pg("w.mdx", { movesWaiting: 2, waitingSince: "2026-10-01", movesYou: 3 }), pg("n.mdx")];
    const html = render(m, pages, { waitsCounted: false });
    expect(columnOf(html, "w")).toEqual(["quiet"]);
    expect(columnOf(html, "n")).toEqual(["you"]);
    expect(html).not.toContain("wiki-wm-pill warn");
    expect(html).toContain(">3 steps<");
    expect(columnOf(render(m, pages), "w")).toEqual(["you"]);
  });

  test("a closed-without-shipping page neither makes Waiting nor adds a step, as in the strip", () => {
    const html = render(only([effort("x", "quiet", ["x.mdx"])]), [pg("x.mdx", { movesWaiting: 2, movesYou: 2, waitingSince: "2026-10-01", plan_status: "abandoned" })]);
    expect(columnOf(html, "x")).toEqual(["quiet"]);
    expect(html).not.toContain("wiki-wm-pill");
    expect(stripRows([pg("x.mdx", { movesWaiting: 2, plan_status: "abandoned" })]).decisions).toEqual([]);
  });

  test("a ✓-done item and a struck item do not make Waiting; an unstruck one does", () => {
    const m = only([effort("d", "quiet", ["a.mdx"]), effort("g", "quiet", ["a.mdx"]), effort("o", "quiet", ["a.mdx"])], [need("d", "Done one"), need("g", "Merged one"), need("o", "Open one")]);
    const entries = [
      { kind: "followup", title: "Merged one", pr: 1, state: "MERGED" as const, asksForIt: true },
      { kind: "followup", title: "Open one", pr: 2, state: "OPEN" as const, asksForIt: true },
    ];
    const html = render(m, [pg("a.mdx")], { done: new Set([needKey(need("d", "Done one"))]), checks: checksFor(m.runAtMs, entries) });
    expect(columnOf(html, "d")).toEqual(["quiet"]);
    expect(columnOf(html, "g")).toEqual(["quiet"]);
    expect(columnOf(html, "o")).toEqual(["you"]);
    // The same answer for another map marks nothing: exactly the section's gate.
    const older = render(m, [pg("a.mdx")], { checks: checksFor(m.runAtMs - 1, entries) });
    expect(columnOf(older, "g")).toEqual(["you"]);
    expect(older).not.toContain("gh-done");
    // A mention is not an ask, and two PRs need both merged.
    const reader = needMarksReader(m.needsYou, { ...checksFor(m.runAtMs, [{ ...entries[0]!, asksForIt: false }]) }, m.runAtMs);
    expect(reader(1).struck).toBe(false);
    const two = needMarksReader(m.needsYou, { ...checksFor(m.runAtMs, [entries[0]!, { ...entries[0]!, pr: 3, state: "OPEN" }]) }, m.runAtMs);
    expect(two(1).struck).toBe(false);
  });

  test("an item with no effort or an unknown effort moves nothing, and a parent's item does not roll up", () => {
    const m = only([effort("p", "quiet", ["a.mdx"]), effort("k", "quiet", ["a.mdx"], { parent: "p" })], [need(undefined), need("zz", "Other"), need("k", "Kid's")]);
    const html = render(m, [pg("a.mdx")]);
    expect(columnOf(html, "p")).toEqual(["quiet"]);
    expect(columnOf(html, "k")).toEqual(["you"]);
    expect(col(html, "you")).toContain("part of Effort p");
  });

  test("a waiting sub-effort under a Moving parent stands on its own, naming its parent", () => {
    const html = render(only([effort("p", "active", ["a.mdx"]), effort("k", "active", ["w.mdx"], { parent: "p" })]), [pg("a.mdx"), pg("w.mdx", { movesWaiting: 1 })]);
    expect(columnOf(html, "k")).toEqual(["you"]);
    expect(col(html, "you")).toContain('wiki-wm-tile" data-effort-id="k"');
    expect(col(html, "you")).toContain("part of Effort p");
    expect(col(html, "moving")).not.toContain("wiki-wm-kid");
    expect(col(html, "moving")).toContain('wiki-wm-count">1<');
  });

  test("a sub-effort in its parent's column is a compact row in the tile, counted in the head", () => {
    const html = render(only([effort("p", "active", ["a.mdx"]), effort("k", "blocked", ["a.mdx"], { parent: "p", oneLine: "Kid line.", next: "Kid next." })]), [pg("a.mdx")]);
    const moving = col(html, "moving");
    expect(moving).toMatch(/wiki-wm-tile" data-effort-id="p">[\s\S]*wiki-wm-kids[\s\S]*wiki-wm-kid" data-effort-id="k"/);
    expect(moving).toContain('wiki-wm-count">2<');
    expect(moving).not.toContain("part of");
    expect(moving).not.toContain("Kid line.");
    expect(moving).not.toContain("Kid next.");
    expect(html.match(/data-effort-id="k"/g)).toHaveLength(1);
  });

  test("a grandchild in the same column renders once, in the top tile", () => {
    const html = render(only([effort("g", "active", ["a.mdx"]), effort("c", "active", ["a.mdx"], { parent: "g" }), effort("k", "active", ["a.mdx"], { parent: "c" })]), [pg("a.mdx")]);
    expect(orderIn(html, "moving")).toEqual(["g"]);
    expect(col(html, "moving").match(/wiki-wm-kid" data-effort-id/g)).toHaveLength(2);
    expect(html.match(/data-effort-id="k"/g)).toHaveLength(1);
  });

  test("a grandchild whose parent went elsewhere stands on its own, naming that parent", () => {
    const html = render(only([effort("g", "active", ["a.mdx"]), effort("c", "cooling", ["a.mdx"], { parent: "g" }), effort("k", "active", ["a.mdx"], { parent: "c" })]), [pg("a.mdx")]);
    expect(orderIn(html, "moving")).toEqual(["g", "k"]);
    expect(col(html, "moving")).toContain("part of Effort c");
    expect(col(html, "cooling")).toContain("part of Effort g");
  });

  test("a parent cycle and a missing parent stay top-level, once each, with no «part of»", () => {
    const es = [effort("a", "active", ["a.mdx"], { parent: "b" }), effort("b", "active", ["a.mdx"], { parent: "a" }), effort("m", "active", ["a.mdx"], { parent: "zz" })];
    expect(es.map((e) => isNestedEffort(e, es))).toEqual([false, false, false]);
    const html = render(only(es), [pg("a.mdx")]);
    expect(orderIn(html, "moving")).toEqual(["a", "b", "m"]);
    expect(html).not.toContain("part of");
  });

  test("duplicate effort ids render once each", () => {
    const html = render(only([effort("a", "active", ["a.mdx"], { parent: "b" }), effort("a", "active", ["a.mdx"]), effort("b", "active", ["a.mdx"], { parent: "a" }), effort("b", "active", ["a.mdx"])]), [pg("a.mdx")]);
    expect(html.match(/data-effort-id="a"/g)).toHaveLength(1);
    expect(html.match(/data-effort-id="b"/g)).toHaveLength(1);
  });

  test("a parent with no page is off the board, so its sub-effort stands alone with no «part of»", () => {
    const html = render(only([effort("p", "active", []), effort("k", "active", ["a.mdx"], { parent: "p" })]), [pg("a.mdx")]);
    expect(orderIn(html, "moving")).toEqual(["k"]);
    expect(html).not.toContain("part of");
  });

  test("order: oldest wait first, undated after, then most recently active, then map order", () => {
    const day = (d: string) => [{ day: d, commits: 1, sessions: 0 }];
    const html = render(
      only([
        effort("undated-old", "active", ["u.mdx"], { daily: day("2026-10-01") }),
        effort("undated-new", "active", ["u.mdx"], { daily: day("2026-10-28") }),
        effort("dated-young", "active", ["y.mdx"]),
        effort("dated-old", "active", ["o.mdx"]),
        effort("idle-a", "active", ["u.mdx"]),
        effort("idle-b", "active", ["u.mdx"]),
      ]),
      [pg("u.mdx", { movesWaiting: 1 }), pg("y.mdx", { movesWaiting: 1, waitingSince: "2026-10-20" }), pg("o.mdx", { movesWaiting: 1, waitingSince: "2026-10-02" })],
    );
    expect(orderIn(html, "you")).toEqual(["dated-old", "dated-young", "undated-new", "undated-old", "idle-a", "idle-b"]);
  });

  describe("order: dated waits oldest first, then undated waits, then no wait", () => {
    const kidsIn = (html: string, tile: string) => {
      const at = html.indexOf(`wiki-wm-tile" data-effort-id="${tile}"`);
      return [...html.slice(at, html.indexOf("</ul>", at)).matchAll(/wiki-wm-kid" data-effort-id="([^"]+)"/g)].map((m) => m[1]);
    };
    const pillsOf = (html: string, id: string) => {
      const at = html.indexOf(`wiki-wm-pills`, html.indexOf(`data-effort-id="${id}"`));
      return html.slice(at, html.indexOf("</div>", at));
    };
    const day = (d: string) => [{ day: d, commits: 1, sessions: 0 }];
    const waits = (since: string) => pg(`w-${since}.mdx`, { movesWaiting: 1, waitingSince: since });
    const undated = pg("undated.mdx", { movesWaiting: 1 });
    const plain = pg("plain.mdx");

    test("an undated wait ranks ahead of no wait, however recent the no-wait effort is", () => {
      const html = render(
        only(
          [
            effort("needs-only", "active", ["plain.mdx"], { daily: day("2026-10-29") }),
            effort("undated", "active", ["undated.mdx"], { daily: day("2026-10-19") }),
            effort("dated", "active", ["w-2026-10-01.mdx"]),
          ],
          [need("needs-only")],
        ),
        [plain, undated, waits("2026-10-01")],
      );
      expect(orderIn(html, "you")).toEqual(["dated", "undated", "needs-only"]);
    });

    test("a tile sorts by the oldest wait nested in it, and its pills and the row's keep their own facts", () => {
      const html = render(
        only([
          effort("mid", "active", ["w-2026-10-06.mdx"]),
          effort("other", "active", ["w-2026-10-10.mdx"]),
          effort("parent", "active", ["w-2026-10-23.mdx"]),
          effort("old-kid", "active", ["w-2026-09-24.mdx"], { parent: "parent" }),
        ]),
        ["2026-10-06", "2026-10-10", "2026-10-23", "2026-09-24"].map(waits),
      );
      expect(orderIn(html, "you")).toEqual(["parent", "mid", "other"]);
      expect(pillsOf(html, "parent")).toContain("1 decision · 6 d");
      expect(pillsOf(html, "parent")).not.toContain("35 d");
      expect(pillsOf(html, "old-kid")).toContain("1 decision · 35 d");
    });

    test("the rollup reaches a grandchild, which renders as a flat row in the top tile", () => {
      const html = render(
        only(
          [
            effort("rival", "active", ["w-2026-10-06.mdx"]),
            effort("top", "active", ["plain.mdx"]),
            effort("child", "active", ["plain.mdx"], { parent: "top" }),
            effort("grandchild", "active", ["w-2026-09-24.mdx"], { parent: "child" }),
          ],
          [need("top"), need("child", "Other")],
        ),
        [plain, waits("2026-10-06"), waits("2026-09-24")],
      );
      expect(orderIn(html, "you")).toEqual(["top", "rival"]);
    });

    test("a nested undated wait lifts its tile above no wait, below a dated wait", () => {
      const html = render(
        only(
          [
            effort("no-wait", "active", ["plain.mdx"], { daily: day("2026-10-29") }),
            effort("holder", "active", ["plain.mdx"], { daily: day("2026-10-01") }),
            effort("undated-kid", "active", ["undated.mdx"], { parent: "holder" }),
            effort("dated", "active", ["w-2026-10-20.mdx"]),
          ],
          [need("no-wait"), need("holder", "Other")],
        ),
        [plain, undated, waits("2026-10-20")],
      );
      expect(orderIn(html, "you")).toEqual(["dated", "holder", "no-wait"]);
    });

    test("with no wait, a tile sorts by the most recent activity nested in it", () => {
      const html = render(
        only([
          effort("recent", "active", ["plain.mdx"], { daily: day("2026-10-20") }),
          effort("holder", "active", ["plain.mdx"], { daily: day("2026-10-10") }),
          effort("busy-kid", "active", ["plain.mdx"], { parent: "holder", daily: day("2026-10-29") }),
        ]),
        [plain],
      );
      expect(orderIn(html, "moving")).toEqual(["holder", "recent"]);
    });

    test("a sub-effort that stands alone in another column does not lift its parent", () => {
      const html = render(
        only(
          [
            effort("recent", "active", ["plain.mdx"], { daily: day("2026-10-24") }),
            effort("holder", "active", ["plain.mdx"], { daily: day("2026-10-09") }),
            effort("elsewhere", "active", ["plain.mdx"], { parent: "holder", daily: day("2026-10-29") }),
          ],
          [need("recent"), need("holder", "Other")],
        ),
        [plain],
      );
      expect(orderIn(html, "you")).toEqual(["recent", "holder"]);
      expect(orderIn(html, "moving")).toEqual(["elsewhere"]);
    });

    test("nested rows take the same order inside their tile", () => {
      const html = render(
        only(
          [
            effort("top", "active", ["plain.mdx"]),
            effort("none-old", "active", ["plain.mdx"], { parent: "top", daily: day("2026-10-01") }),
            effort("none-new", "active", ["plain.mdx"], { parent: "top", daily: day("2026-10-28") }),
            effort("undated", "active", ["undated.mdx"], { parent: "top", daily: day("2026-09-20") }),
            effort("young", "active", ["w-2026-10-20.mdx"], { parent: "top" }),
            effort("old", "active", ["w-2026-10-02.mdx"], { parent: "top" }),
          ],
          [need("top"), need("none-old", "A"), need("none-new", "B")],
        ),
        [plain, undated, waits("2026-10-20"), waits("2026-10-02")],
      );
      expect(kidsIn(html, "top")).toEqual(["old", "young", "undated", "none-new", "none-old"]);
    });
  });

  test("the bar and the active pill read Oslo's day where the local one is behind it (no TZ set)", () => {
    // 23:30 UTC is 00:30 the next day in Oslo; `bun test` runs in UTC when no TZ is set.
    const now = Date.parse("2026-11-03T23:30:00Z");
    const daily = [{ day: "2026-11-02", commits: 3, sessions: 0 }, { day: "2026-11-03", commits: 5, sessions: 0 }, { day: "2026-11-04", commits: 7, sessions: 0 }];
    expect(sparkValues(daily, now).slice(-4)).toEqual([0, 3, 5, 7]);
    const pills = (rows: typeof daily) => {
      const html = render(only([effort("x", "active", ["a.mdx"], { daily: rows })]), [pg("a.mdx")], { now });
      return html.slice(html.indexOf("wiki-wm-pills"));
    };
    expect(pills(daily)).toContain(">today<");
    expect(pills(daily.slice(0, 2))).toContain(">yesterday<");
  });

  test("pills: counts and fixed labels, oldest date across pages, no age without a date, a duplicate page once", () => {
    const m = only([effort("x", "active", ["a.mdx", "b.mdx", "a.mdx"], { daily: [{ day: "2026-10-27", commits: 1, sessions: 0 }] })], [need("x", "One", "decision"), need("x", "Two")]);
    const html = render(m, [pg("a.mdx", { movesWaiting: 2, waitingSince: "2026-10-19", movesYou: 1 }), pg("b.mdx", { movesWaiting: 1, waitingSince: "2026-10-26", movesYou: 1 })]);
    expect([...html.matchAll(/wiki-wm-pill( \w+)?">([^<]*)</g)].map((p) => p[2])).toEqual(["3 decisions · 10 d", "decision · followup", "2 steps", "2 d ago"]);
    const one = render(only([effort("x", "active", ["a.mdx"])]), [pg("a.mdx", { movesWaiting: 1, movesYou: 1 })]);
    expect([...one.matchAll(/wiki-wm-pill( \w+)?">([^<]*)</g)].map((p) => p[2])).toEqual(["1 decision", "1 step"]);
  });

  // The map's `daily` cannot say a live page has no activity, so no label claims it.
  test("an effort with no activity has no label and no pills div, only a flat sparkline, on a tile and on a compact row", () => {
    const quietDay = [{ day: "2026-10-27", commits: 0, sessions: 0 }];
    const html = render(only([effort("x", "active", ["a.mdx"]), effort("k", "active", ["a.mdx"], { parent: "x", daily: quietDay })]), [pg("a.mdx")]);
    expect(html).toContain('wiki-wm-kid" data-effort-id="k"');
    expect(html).not.toContain("wiki-wm-pill");
    expect(html).not.toContain("no activity");
    const sparks = [...html.matchAll(/<svg class="wiki-wm-spark".*?<\/svg>/g)].map((m) => m[0]);
    expect(sparks).toHaveLength(2);
    for (const spark of sparks) expect(new Set([...spark.matchAll(/ height="([^"]+)"/g)].map((h) => h[1])).size).toBe(1);
  });

  test("boardFacts counts what stripRows counts for the same pages", () => {
    const pages = [pg("a.mdx", { movesWaiting: 2, waitingSince: "2026-10-05", movesYou: 1 }), pg("b.mdx", { movesWaiting: 1 }), pg("c.mdx", { movesWaiting: 9, plan_status: "abandoned" })];
    const f = boardFacts({ id: "x", pages: pages.map((page) => ({ page })) }, [], new Set(), () => ({ struck: false, notes: [] }), true);
    const rows = stripRows(pages);
    expect(f.decisions).toBe(rows.decisions.reduce((n, r) => n + (r.count ?? 0), 0));
    expect(f.steps).toBe(rows.steps.reduce((n, r) => n + (r.count ?? 0), 0));
    expect(f.since).toBe(rows.oldest[0]!.since);
  });

  test("the tile: linked name, sparkline, one line, Next; no page list and no state chip", () => {
    const html = render(only([effort("x", "active", ["a.mdx"], { oneLine: "See ⟦a.mdx⟧.", next: "Ship <it>." })]), [pg("a.mdx")]);
    const tile = col(html, "moving");
    expect(tile).toContain('<a class="wiki-wm-effort-name" href="/wiki?effort=x" data-effort-link="x">Effort x</a>');
    expect(tile).toContain('role="img" aria-label="Activity, last 28 days"');
    expect(tile).toContain('data-relpath="a.mdx"');
    expect(tile).toContain("Ship &lt;it&gt;.");
    expect(tile).not.toContain("wiki-wm-pages");
    expect(tile).not.toContain("wiki-wm-state");
  });

  test("with no effort href the name is text", () => {
    const html = workCardHtml({ body: { map: only([effort("x", "active", ["plans/a.mdx"])]), organizable: false }, pages: PAGES, now: NOW, done: new Set(), hrefFor: href, refresh: { phase: "idle" } });
    expect(html).toContain('<span class="wiki-wm-effort-name">Effort x</span>');
  });

  test("escapes the name, the part-of parent and a kind", () => {
    const m = only([effort("p", "active", ["a.mdx"], { name: '<i>"p' }), effort("k", "cooling", ["a.mdx"], { parent: "p", name: "<b>k" })], [{ ...need("p"), kind: "<u>" as never }]);
    const html = render(m, [pg("a.mdx")]);
    for (const raw of ["<i>", "<b>k", "<u>"]) expect(col(html, "you") + col(html, "cooling")).not.toContain(raw);
    expect(col(html, "cooling")).toContain("part of &lt;i&gt;");
  });
});

describe("sparkValues", () => {
  test("28 days ending today: commits plus twice the sessions, summed per day", () => {
    const v = sparkValues([{ day: "2026-10-29", commits: 2, sessions: 1 }, { day: "2026-10-29", commits: 1, sessions: 0 }, { day: "2026-10-28", commits: 0, sessions: 3 }, { day: "2026-10-02", commits: 7, sessions: 0 }], NOW);
    expect(v).toHaveLength(SPARK_DAYS);
    expect(v[27]).toBe(5);
    expect(v[26]).toBe(6);
    expect(v[0]).toBe(7);
    expect(v.reduce((a, b) => a + b, 0)).toBe(18);
  });
  test("a day outside the 28 is ignored, a bad day too, and a later day counts as today", () => {
    const v = sparkValues([{ day: "2026-10-01", commits: 9, sessions: 9 }, { day: "not-a-day", commits: 9, sessions: 9 }, { day: "2026-10-30", commits: 1, sessions: 0 }], NOW);
    expect(v.reduce((a, b) => a + b, 0)).toBe(1);
    expect(v[27]).toBe(1);
  });
  test("an all-zero series draws a flat baseline, a real day stands taller", () => {
    const m = map({ efforts: [effort("z", "active", ["plans/a.mdx"]), effort("y", "active", ["plans/a.mdx"], { daily: [{ day: "2026-10-29", commits: 4, sessions: 0 }, { day: "2026-10-28", commits: 1, sessions: 0 }] })], needsYou: [], summary: "" });
    const html = card(m);
    const svg = (id: string) => {
      const at = html.indexOf(`data-effort-id="${id}"`);
      return html.slice(html.indexOf("<svg", at), html.indexOf("</svg>", at));
    };
    expect(svg("z").match(/<rect class="zero"[^>]*height="2\.0"/g)).toHaveLength(28);
    expect(svg("z")).not.toMatch(/<rect x/);
    expect(svg("y").match(/<rect class="zero"/g)).toHaveLength(26);
    expect(svg("y")).toContain('<rect x="27.1" y="0.0" width="0.8" height="24.0"/>');
    expect(svg("y")).toContain('<rect x="26.1" y="18.0" width="0.8" height="6.0"/>');
  });
  test("a small day keeps a floor taller than a zero bar", () => {
    const m = map({ efforts: [effort("y", "active", ["plans/a.mdx"], { daily: [{ day: "2026-10-29", commits: 100, sessions: 0 }, { day: "2026-10-28", commits: 1, sessions: 0 }] })], needsYou: [], summary: "" });
    expect(card(m)).toContain('<rect x="26.1" y="20.0" width="0.8" height="4.0"/>');
  });
  test("a compact row's name carries the whole name in a tooltip, since it may be cut to one line", () => {
    const m = map({ efforts: [effort("p", "active", ["plans/a.mdx"]), effort("k", "active", ["plans/a.mdx"], { parent: "p", name: 'a "long" name' })], needsYou: [], summary: "" });
    expect(card(m)).toMatch(/wiki-wm-kid" data-effort-id="k"><[^>]*class="wiki-wm-effort-name"[^>]*title="a &quot;long&quot; name"/);
  });
});

describe("the sparkline and the active label in any time zone", () => {
  type Row = { day: string; commits: number; sessions: number };
  type Case = { now: string; rows: Record<string, number>; bars: Record<number, number>; idle: number | null };
  const bars = (at: Record<number, number>) => Array.from({ length: SPARK_DAYS }, (_, i) => at[i] ?? 0);
  const row = (rows: Record<string, number>): Row[] => Object.entries(rows).map(([day, commits]) => ({ day, commits, sessions: 0 }));
  const CASES: Case[] = [
    // Oslo is already 11-04: New York's local day is still 11-03.
    { now: "2026-11-03T23:30:00Z", rows: { "2026-11-02": 3, "2026-11-03": 5, "2026-11-04": 7 }, bars: { 25: 3, 26: 5, 27: 7 }, idle: 0 },
    { now: "2026-11-03T23:30:00Z", rows: { "2026-11-03": 5 }, bars: { 26: 5 }, idle: 1 },
    // Oslo is still 11-03: Tokyo's local day is already 11-04.
    { now: "2026-11-03T22:00:00Z", rows: { "2026-11-01": 2, "2026-11-02": 3, "2026-11-03": 5 }, bars: { 25: 2, 26: 3, 27: 5 }, idle: 0 },
    // Just after midnight in Oslo on the day after each clock change.
    { now: "2026-10-25T23:30:00Z", rows: { "2026-10-24": 1, "2026-10-25": 2, "2026-10-26": 4 }, bars: { 25: 1, 26: 2, 27: 4 }, idle: 0 },
    { now: "2026-03-29T22:30:00Z", rows: { "2026-03-28": 1, "2026-03-29": 2, "2026-03-30": 4 }, bars: { 25: 1, 26: 2, 27: 4 }, idle: 0 },
    // The window's edge, across a clock change: day 27 back is in, day 28 back is out.
    { now: "2026-11-03T23:30:00Z", rows: { "2026-10-08": 6, "2026-10-07": 9 }, bars: { 0: 6 }, idle: 27 },
    { now: "2026-04-10T10:00:00Z", rows: { "2026-03-14": 6, "2026-03-13": 9 }, bars: { 0: 6 }, idle: 27 },
    // A row later than Oslo's today counts as today.
    { now: "2026-11-03T22:00:00Z", rows: { "2026-11-04": 7 }, bars: { 27: 7 }, idle: 0 },
  ];
  // A child process, because assigning process.env.TZ here does not reliably move or
  // restore the local clock in bun (Tokyo, then "UTC", stayed on Tokyo).
  const PROBE = `
    const { sparkValues, lastActiveDays } = await import(process.env.CARD_MODULE);
    const cases = JSON.parse(process.env.CARD_CASES);
    console.log(JSON.stringify(cases.map(({ now, daily }) => {
      const t = Date.parse(now);
      return { offset: new Date(t).getTimezoneOffset(), bars: sparkValues(daily, t), idle: lastActiveDays({ daily }, t) };
    })));
  `;
  const zones: [string, string, number][] = [
    ["America/New_York", "2026-11-03T23:30:00Z", 300],
    ["Asia/Tokyo", "2026-11-03T23:30:00Z", -540],
    ["Europe/Oslo", "2026-11-03T23:30:00Z", -60],
    ["Pacific/Kiritimati", "2026-11-03T23:30:00Z", -840],
    ["Pacific/Pago_Pago", "2026-11-03T23:30:00Z", 660],
  ];
  test.each(zones)("%s", (TZ, proofAt, proofOffset) => {
    const input = [{ now: proofAt, daily: [] as Row[] }, ...CASES.map((c) => ({ now: c.now, daily: row(c.rows) }))];
    const out = Bun.spawnSync([process.execPath, "-e", PROBE], {
      cwd: import.meta.dir,
      env: { ...process.env, TZ, CARD_MODULE: `${import.meta.dir}/wiki-work-card.ts`, CARD_CASES: JSON.stringify(input) },
    });
    expect(out.stderr.toString()).toBe("");
    const [proof, ...got] = JSON.parse(out.stdout.toString()) as { offset: number; bars: number[]; idle: number | null }[];
    // The zone really moved the child's local clock, or the rest proves nothing.
    expect(proof!.offset).toBe(proofOffset);
    expect(got.map((g) => ({ bars: g.bars, idle: g.idle }))).toEqual(CASES.map((c) => ({ bars: bars(c.bars), idle: c.idle })));
  }, 30_000);

  test("a theme's week ends on Oslo's calendar too", () => {
    const theme = { weekly: [{ start: "2026-10-26", count: 1 }] };
    // 23:30 UTC on the week's Sunday is already Monday in Oslo.
    expect(lastActiveDays(theme, Date.parse("2026-11-01T23:30:00Z"))).toBe(1);
    expect(themeActiveLabel(lastActiveDays(theme, Date.parse("2026-11-01T22:30:00Z")))).toBe("this week");
  });
});

describe("nesting and days", () => {
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
    // Lane order deals the rows: gamma (New) first, its one pair stored on beta's end.
    expect(conns).toEqual(["beta|gamma", "alpha|beta"]);
    expect(html).toContain("Both lean on Hub X.");
    expect(html).not.toContain("The other end");
    expect(html).toMatch(/data-effort-link="alpha" data-wm-conn-link>Theme alpha<\/a> <span class="wiki-wm-conn-arrow"[^>]*>↔<\/span> <a [^>]*data-effort-link="beta" data-wm-conn-link>Theme beta<\/a><span class="wiki-wm-conn-why">: Both lean on Hub X\.<\/span>/);
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
    expect(alpha).toContain('aria-label="7 sources over the last 3 weeks, this week so far, 1 week may miss days"');
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
    const titles = [...html.matchAll(/class="wiki-wm-slot[^"]*" title="([^"]+)"/g)].map((m) => m[1]!.split(" ")[0]);
    expect(titles).toEqual(["W2", "W3", "W4", "W5", "W6", "W7", "W8", "W9"]);
    expect(html).toContain('<span class="wiki-wm-slot partial" title="W9 (from 2026-08-19): 9 sources, may miss days"><span class="wiki-wm-week lvl-4"></span></span>');
    expect(weeklyStripHtml([])).toBe("");
  });

  // Fix round 1 batch 2: the strip's hidden weeks, the running week, a partial week.
  const mondays = (from: string, n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 7 * 86_400_000).toISOString().slice(0, 10));

  test("weeks before the strip's 8 bars show as «+N earlier», and the label does not claim them", () => {
    const weekly = mondays("2026-08-10", 12).map((start, i) => ({ week: `W${i}`, start, count: i < 4 ? 9 : 1 }));
    const html = weeklyStripHtml(weekly);
    expect((html.match(/class="wiki-wm-week /g) ?? []).length).toBe(THEME_STRIP_WEEKS);
    expect(html).toContain('<span class="wiki-wm-weeks-earlier" title="36 sources in the 4 weeks before">+36 earlier</span>');
    expect(html).toContain('aria-label="8 sources over the last 8 weeks, 36 more in 4 earlier weeks"');
    // Earlier weeks with no source: nothing hidden, no marker.
    const quiet = weeklyStripHtml(mondays("2026-08-10", 10).map((start, i) => ({ week: `W${i}`, start, count: i < 2 ? 0 : 1 })));
    expect(quiet).not.toContain("wiki-wm-weeks-earlier");
    expect(quiet).toContain('aria-label="8 sources over the last 8 weeks"');
  });

  test("the week holding the run is marked running, a partial week is marked, a full empty week is not", () => {
    // THEME_RUN_AT is Friday 2026-10-30 in Oslo: W44 (from 2026-10-26) is still running.
    const weekly = [
      { week: "2026-W40", start: "2026-09-28", count: 0, partial: true },
      { week: "2026-W41", start: "2026-10-05", count: 0 },
      { week: "2026-W44", start: "2026-10-26", count: 2 },
    ];
    const html = weeklyStripHtml(weekly, THEME_RUN_AT);
    const slots = [...html.matchAll(/<span class="wiki-wm-slot([^"]*)" title="([^"]+)">/g)].map((m) => [m[1], m[2]]);
    expect(slots).toEqual([
      [" partial", "2026-W40 (from 2026-09-28): 0 sources, may miss days"],
      ["", "2026-W41 (from 2026-10-05): 0 sources"],
      [" current", "2026-W44 (from 2026-10-26): 2 sources so far, week still running"],
    ]);
    expect(html).toContain('aria-label="2 sources over the last 3 weeks, this week so far, 1 week may miss days"');
    // A run on the Monday after: W44 is complete.
    expect(weeklyStripHtml(weekly, Date.parse("2026-11-02T03:00:00Z"))).not.toContain(" current");
  });

  // Fix round 2 batch 2: the running mark needs the run's week AND a week not yet over.
  const W44 = { week: "2026-W44", start: "2026-10-26", count: 2 };
  const W45 = { week: "2026-W45", start: "2026-11-02", count: 1 };
  const slotsOf = (html: string) => [...html.matchAll(/<span class="wiki-wm-slot([^"]*)" title="([^"]+)">/g)].map((m) => [m[1], m[2]]);

  test("a map run Friday and rendered the next Tuesday shows its week as partial, not still running", () => {
    const tuesday = Date.parse("2026-11-03T12:00:00Z");
    const html = weeklyStripHtml([W44], THEME_RUN_AT, tuesday);
    expect(slotsOf(html)).toEqual([[" partial", "2026-W44 (from 2026-10-26): 2 sources, may miss days"]]);
    expect(html).toContain('aria-label="2 sources over the last 1 week, 1 week may miss days"');
    // Rendered the same Sunday evening, the week still runs.
    expect(slotsOf(weeklyStripHtml([W44], THEME_RUN_AT, Date.parse("2026-11-01T20:00:00Z")))[0]![0]).toBe(" current");
    // The card reads its own clock.
    const m = fixtureThemeMap();
    const html2 = workCardHtml({ body: { map: m, organizable: true }, pages: fixtureThemePages(), now: tuesday, done: new Set(), hrefFor: href, refresh: { phase: "idle" } });
    expect(html2).not.toContain("week still running");
    expect(html2).not.toContain("this week so far");
  });

  test("the running week turns at Oslo midnight, not UTC midnight", () => {
    const at = (iso: string) => slotsOf(weeklyStripHtml([W44, W45], Date.parse(iso))).map((s) => s[0]);
    // November in Oslo is UTC+1.
    expect(at("2026-11-01T22:30:00Z")).toEqual([" current", ""]); // Sunday 23:30
    expect(at("2026-11-01T22:59:59Z")).toEqual([" current", ""]); // Sunday 23:59:59
    expect(at("2026-11-01T23:00:00Z")).toEqual(["", " current"]); // Monday 00:00
    expect(at("2026-11-01T23:30:00Z")).toEqual(["", " current"]); // Monday 00:30
  });

  test("a run on the Monday a week starts marks that week running", () => {
    expect(slotsOf(weeklyStripHtml([W44, W45], Date.parse("2026-11-02T08:00:00Z"))).map((s) => s[0])).toEqual(["", " current"]);
  });

  test("a week both running and partial reads running, and the aria count of partial weeks leaves it out", () => {
    const weekly = [{ week: "2026-W40", start: "2026-09-28", count: 0, partial: true }, { ...W44, partial: true }];
    const html = weeklyStripHtml(weekly, THEME_RUN_AT);
    expect(slotsOf(html)[1]).toEqual([" current", "2026-W44 (from 2026-10-26): 2 sources so far, week still running"]);
    expect(html).toContain('aria-label="2 sources over the last 2 weeks, this week so far, 1 week may miss days"');
  });

  // Fix round 2 batch 1: the shown rows are picked so no theme fills them.
  const t = (id: string, rel: string[]) => ({ id, related: rel.map((r) => ({ id: r, why: `${id}-${r}` })) });
  const rowsOf = (themes: ReturnType<typeof t>[]) => themeConnections(themes).map((c) => `${c.a.id}|${c.b.id}:${c.why}`);
  /** Each theme's count of rows among the first `THEME_CONNECTIONS_SHOWN`. */
  const appearances = (themes: ReturnType<typeof t>[]) => {
    const n = new Map<string, number>();
    for (const c of themeConnections(themes).slice(0, THEME_CONNECTIONS_SHOWN)) for (const id of [c.a.id, c.b.id]) n.set(id, (n.get(id) ?? 0) + 1);
    return Object.fromEntries([...n].sort(([a], [b]) => a.localeCompare(b)));
  };

  test("Connected: a hub linked to six themes, plus three pairs without it, shows the hub in 3 of 6 rows, not every row", () => {
    const themes = [
      t("h", ["x1", "x2", "x3", "x4", "x5", "x6"]),
      t("x1", ["h", "x2"]), t("x2", ["h", "x1"]), t("x3", ["h", "x4"]), t("x4", ["h", "x3"]), t("x5", ["h", "x6"]), t("x6", ["h", "x5"]),
    ];
    // 9 pairs; any 6 of them hold at least 3 of the hub's 6, so 3 is the least it can fill.
    expect(rowsOf(themes)).toEqual(["h|x1:h-x1", "x3|x4:x3-x4", "x5|x6:x5-x6", "h|x2:h-x2", "x1|x2:x1-x2", "h|x3:h-x3", "h|x4:h-x4", "h|x5:h-x5", "h|x6:h-x6"]);
    expect(appearances(themes)).toEqual({ h: 3, x1: 2, x2: 2, x3: 2, x4: 1, x5: 1, x6: 1 });
  });

  test("Connected: a chain of seven themes shows its six links, no theme in more than 2 rows", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g"];
    const themes = ids.map((id, i) => t(id, [ids[i - 1], ids[i + 1]].filter((x): x is string => !!x)));
    expect(rowsOf(themes)).toEqual(["a|b:a-b", "c|d:c-d", "e|f:e-f", "f|g:f-g", "b|c:b-c", "d|e:d-e"]);
    expect(Math.max(...Object.values(appearances(themes)))).toBe(2);
  });

  test("Connected: four themes all linked show their six links, each theme in exactly 3 rows", () => {
    const ids = ["a", "b", "c", "d"];
    const themes = ids.map((id) => t(id, ids.filter((x) => x !== id)));
    expect(rowsOf(themes)).toEqual(["a|b:a-b", "c|d:c-d", "a|c:a-c", "b|d:b-d", "a|d:a-d", "b|c:b-c"]);
    expect(appearances(themes)).toEqual({ a: 3, b: 3, c: 3, d: 3 });
  });

  test("Connected: five themes all linked show 6 of 10 links, no theme in more than 3 rows", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const themes = ids.map((id) => t(id, ids.filter((x) => x !== id)));
    expect(themeConnections(themes)).toHaveLength(10);
    // 12 ends over 5 themes: at least one theme fills 3 rows.
    expect(Math.max(...Object.values(appearances(themes)))).toBe(3);
  });

  test("Connected: with five rows placed, b|d (busier end 2) comes before a|e (busier end 3)", () => {
    const themes = [t("a", ["d", "c", "e"]), t("b", ["a", "d"]), t("c", ["b"]), t("d", []), t("e", ["d"])];
    // After five rows a is in 3, b and d in 2, e in 1: b|d (2, 2) sums to 4 and a|e (3, 1) to 4 too,
    // so only the busier-end key separates them. A sum-only pick would take a|e here.
    expect(rowsOf(themes)).toEqual(["b|a:b-a", "e|d:e-d", "a|c:a-c", "c|b:c-b", "a|d:a-d", "b|d:b-d", "a|e:a-e"]);
    expect(appearances(themes).a).toBe(3);
  });

  test("Connected: a pair stored on one end only keeps that end first, with its why; one stored on both keeps the earlier end's", () => {
    expect(rowsOf([t("g", []), t("h", ["g"])])).toEqual(["h|g:h-g"]);
    expect(rowsOf([t("g", ["h"]), t("h", ["g"])])).toEqual(["g|h:g-h"]);
    // A hub only others point at: still spread.
    const themes = [t("h", []), ...["x1", "x2", "x3", "x4", "x5", "x6", "x7"].map((id) => t(id, ["h"])), t("y1", ["y2"]), t("y2", []), t("y3", ["y4"]), t("y4", [])];
    expect(appearances(themes).h).toBe(4);
    expect(rowsOf(themes).slice(0, 3)).toEqual(["x1|h:x1-h", "y1|y2:y1-y2", "y3|y4:y3-y4"]);
  });

  test("Connected: the real map's shape (12 links over 17 themes) shows no theme in more than 2 rows", () => {
    // Synthetic ids; the link shape of the jarvis map of 2026-10-30, in lane
    // order (new, rising, steady, fading, life), map order within a lane.
    const links: Record<string, string[]> = {
      n13: [], r0: ["r2", "f8", "f12", "s1"], r2: ["r0", "s4", "r5", "r10"], r5: ["r2", "s4"], r9: [], r10: ["s7", "r2", "l15"],
      s1: ["r0"], s3: ["s4"], s4: ["r2", "s3", "r5"], s6: ["s7"], s7: ["r10", "s6"], s11: [], f8: ["r0"], f12: ["r0"], l14: [], l15: ["r10"], l16: [],
    };
    const themes = Object.entries(links).map(([id, rel]) => t(id, rel));
    expect(themeConnections(themes)).toHaveLength(12);
    // 12 ends; r0's three one-link neighbours and r2's crowd make 1 each impossible.
    expect(Math.max(...Object.values(appearances(themes)))).toBe(2);
  });

  test("Connected: a row counts against both its ends", () => {
    // Counting only the left end, b|x would follow a|x; only the right end, h|b would follow h|a.
    expect(rowsOf([t("x", []), t("a", ["x"]), t("b", ["x"]), t("c", ["d"]), t("d", [])])).toEqual(["a|x:a-x", "c|d:c-d", "b|x:b-x"]);
    expect(rowsOf([t("h", ["a", "b"]), t("a", []), t("b", []), t("c", ["d"]), t("d", [])])).toEqual(["h|a:h-a", "c|d:c-d", "h|b:h-b"]);
  });

  test("Connected: a Life theme sorts after the AI lanes whatever its state", () => {
    const m = fixtureThemeMap({
      efforts: [
        fixtureTheme("alpha", { state: "rising", related: [{ id: "beta", why: "ab" }] }),
        fixtureTheme("beta"),
        fixtureTheme("delta", { state: "fading" }),
        fixtureTheme("life-one", { state: "new", domain: "life", related: [{ id: "delta", why: "ld" }] }),
      ],
    });
    const html = workCardHtml({ body: { map: m, organizable: true }, pages: fixtureThemePages(), now: THEME_RUN_AT, done: new Set(), hrefFor: href, refresh: { phase: "idle" } });
    // By state alone life-one (new) would lead, and its pair with delta would take the first row.
    expect([...html.matchAll(/data-wm-conn="([^"]+)"/g)].map((x) => x[1])).toEqual(["alpha|beta", "life-one|delta"]);
  });

  test("themeConnections drops a link to a theme not listed and a self link", () => {
    const a = { id: "a", related: [{ id: "a", why: "self" }, { id: "gone", why: "x" }, { id: "b", why: "ab" }] };
    const b = { id: "b", related: [{ id: "a", why: "ba" }] };
    expect(themeConnections([a, b]).map((c) => [c.a.id, c.b.id, c.why])).toEqual([["a", "b", "ab"]]);
  });
});

describe("the health strip", () => {
  const body = (m: WorkMap) => ({ map: m, organizable: false }) as WorkMapGetBody & { map: WorkMap };
  const html = (pages: Parameters<typeof workCardHtml>[0]["pages"], over: Partial<Parameters<typeof workCardHtml>[0]> = {}) =>
    workCardHtml({ body: body(map()), pages, now: NOW, done: new Set(), hrefFor: href, refresh: { phase: "idle" }, waitsCounted: true, ...over });
  const cell = (out: string, name: string) => new RegExp(`data-wm-cell="${name}"[^>]*><b>([^<]*)</b>`).exec(out)?.[1];
  const page = (rel: string, over: Record<string, unknown> = {}) => ({ relPath: rel, title: rel, ...over });

  test("the four cells sum the whole listing, placed by the map or not", () => {
    const out = html([
      page("plans/a.mdx", { movesWaiting: 2, waitingSince: "2026-10-20", movesYou: 3 }),
      page("plans/unplaced.mdx", { movesWaiting: 1, waitingSince: "2026-10-27", movesYou: 1 }),
      page("plans/s.mdx", { plan_status: "shipped", followups: "open" }),
      page("plans/t.mdx", { plan_status: "shipped", followups: "none" }),
    ]);
    expect(cell(out, "decisions")).toBe("3");
    expect(cell(out, "oldest")).toBe("9 d");
    expect(cell(out, "steps")).toBe("4");
    expect(cell(out, "shipped")).toBe("1");
    expect(out.match(/data-wm-cell=/g)!.length).toBe(4);
  });

  test("an abandoned or superseded plan counts in no cell; a shipped one still does", () => {
    const out = html([
      page("plans/x.mdx", { plan_status: "abandoned", movesWaiting: 5, waitingSince: "2020-01-01", movesYou: 5 }),
      page("plans/y.mdx", { plan_status: "superseded", movesWaiting: 5, movesYou: 5, followups: "open" }),
      page("plans/z.mdx", { plan_status: "shipped", movesWaiting: 1, waitingSince: "2026-10-28", movesYou: 2 }),
    ]);
    expect(cell(out, "decisions")).toBe("1");
    expect(cell(out, "oldest")).toBe("1 d");
    expect(cell(out, "steps")).toBe("2");
  });

  test("an undated wait counts in decisions and not in the oldest wait", () => {
    const pages = [page("plans/a.mdx", { movesWaiting: 2 })];
    const out = html(pages);
    expect(cell(out, "decisions")).toBe("2");
    expect(cell(out, "oldest")).toBe("—");
    expect(stripRows(pages).oldest).toEqual([]);
  });

  test("no owner: both wait cells read «owner not set», never 0, and open nothing", () => {
    const out = html([page("plans/a.mdx", { movesWaiting: 2, waitingSince: "2026-10-20", movesYou: 1 })], {
      waitsCounted: false,
      strip: { open: "decisions", expanded: false },
    });
    expect(cell(out, "decisions")).toBe("owner not set");
    expect(cell(out, "oldest")).toBe("owner not set");
    expect(out).toMatch(/data-wm-cell="decisions"[^>]* disabled/);
    expect(cell(out, "steps")).toBe("1");
    expect(out).not.toContain("wiki-wm-drill");
  });

  test("warn takes the count past 10 and the wait past 7 days, not at them", () => {
    const tone = (out: string, name: string) => new RegExp(`class="wiki-wm-cell([^"]*)" data-wm-cell="${name}"`).exec(out)![1];
    const at = (n: number, since: string) => html([page("plans/a.mdx", { movesWaiting: n, waitingSince: since })]);
    expect(tone(at(10, "2026-10-22"), "decisions")).not.toContain("warn");
    expect(tone(at(10, "2026-10-22"), "oldest")).not.toContain("warn");
    expect(tone(at(11, "2026-10-21"), "decisions")).toContain("warn");
    expect(tone(at(11, "2026-10-21"), "oldest")).toContain("warn");
  });

  test("a cell opens its list, oldest first, with count and since; 8 rows, then +N more", () => {
    const pages = Array.from({ length: 11 }, (_, i) => page(`plans/p${i}.mdx`, { title: `P${i}`, movesWaiting: 1, waitingSince: `2026-10-${String(11 + i)}` }));
    pages.push(page("plans/undated.mdx", { title: "Undated", movesWaiting: 4 }));
    const shut = html(pages);
    expect(shut).not.toContain("wiki-wm-drill-row");
    const open = html(pages, { strip: { open: "decisions", expanded: false } });
    expect(open.match(/wiki-wm-drill-row/g)!.length).toBe(STRIP_ROWS_SHOWN);
    expect(open).toContain("+4 more");
    expect(open.indexOf(">P0<")).toBeLessThan(open.indexOf(">P1<"));
    expect(open).toContain("· 1 · since 2026-10-11 · 18 d");
    const all = html(pages, { strip: { open: "decisions", expanded: true } });
    expect(all.match(/wiki-wm-drill-row/g)!.length).toBe(12);
    expect(all).not.toContain("wiki-wm-drill-more");
    // Undated sorts last, and the oldest cell leaves it out.
    expect(all.indexOf(">P10<")).toBeLessThan(all.indexOf(">Undated<"));
    expect(html(pages, { strip: { open: "oldest", expanded: true } })).not.toContain(">Undated<");
  });

  test("the other cells' lists: steps by count, shipped by status date", () => {
    const pages = [
      page("plans/one.mdx", { title: "One", movesYou: 1 }),
      page("plans/three.mdx", { title: "Three", movesYou: 3 }),
      page("plans/new.mdx", { title: "New", plan_status: "shipped", followups: "open", status_date: "2026-10-20" }),
      page("plans/old.mdx", { title: "Old", plan_status: "shipped", followups: "open", status_date: "2026-09-01" }),
    ];
    const steps = html(pages, { strip: { open: "steps", expanded: false } });
    expect(steps.indexOf(">Three<")).toBeLessThan(steps.indexOf(">One<"));
    const shipped = html(pages, { strip: { open: "shipped", expanded: false } });
    expect(shipped.indexOf(">Old<")).toBeLessThan(shipped.indexOf(">New<"));
    expect(shipped).toContain("since 2026-09-01");
  });

  test("an empty cell does not open", () => {
    expect(html([])).toMatch(/data-wm-cell="steps"[^>]* disabled/);
  });

  test("a page title is escaped in its row", () => {
    const out = html([page("plans/a.mdx", { title: "<b>x</b>", movesYou: 1 })], { strip: { open: "steps", expanded: false } });
    expect(out).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  test("stripKey moves with what the strip reads, and with nothing else", () => {
    const a = [page("plans/a.mdx", { movesWaiting: 1 }), page("plans/b.mdx")];
    expect(stripKey(a, true)).toBe(stripKey([page("plans/a.mdx", { movesWaiting: 1 }), page("plans/b.mdx", { updated: "2026-01-01" })], true));
    expect(stripKey(a, true)).not.toBe(stripKey([page("plans/a.mdx", { movesWaiting: 2 }), page("plans/b.mdx")], true));
    expect(stripKey(a, true)).not.toBe(stripKey(a, false));
  });

  test("stripKey moves for what the board reads: any page's title, a page leaving, a status; not for the listing's order", () => {
    const a = [page("plans/a.mdx", { movesWaiting: 1, title: "Old" }), page("plans/b.mdx", { title: "Quiet" })];
    expect(stripKey(a, true)).not.toBe(stripKey([page("plans/a.mdx", { movesWaiting: 1, title: "New" }), a[1]!], true));
    // A marker in an effort's one line reads a page the strip does not list, by title.
    expect(stripKey(a, true)).not.toBe(stripKey([a[0]!, page("plans/b.mdx", { title: "Renamed" })], true));
    // A page gone can leave an effort with none, and that effort leaves the board.
    expect(stripKey(a, true)).not.toBe(stripKey([a[0]!], true));
    expect(stripKey(a, true)).not.toBe(stripKey([page("plans/a.mdx", { movesWaiting: 1, title: "Old", plan_status: "abandoned" }), a[1]!], true));
    expect(stripKey(a, true)).toBe(stripKey([a[1]!, a[0]!], true));
  });

  test("a themes map has no strip", () => {
    const out = workCardHtml({
      body: { map: fixtureThemeMap(), organizable: false } as WorkMapGetBody & { map: ThemeMap },
      pages: [page("plans/a.mdx", { movesWaiting: 2, movesYou: 1 })],
      now: NOW,
      done: new Set(),
      hrefFor: href,
      refresh: { phase: "idle" },
      waitsCounted: true,
    });
    expect(out).not.toContain("wiki-wm-strip");
  });
});
