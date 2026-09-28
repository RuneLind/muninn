/**
 * The rail's pure functions reach the page as `.toString()` source, which
 * serializes a body and NOT its dependencies. This evaluates the block the
 * page actually ships and runs every function through it, so a helper added
 * to src/summaries/latest-rail.ts without joining RAIL_FUNCTIONS fails here
 * with a ReferenceError instead of in a browser.
 */
import { describe, expect, test } from "bun:test";
import * as rail from "../../../summaries/latest-rail.ts";
import { sumLatestRailScript, sumLatestRailStyles } from "./sum-latest-rail.ts";

function injectedBlock(): string {
  const script = sumLatestRailScript();
  const start = script.indexOf("// --- rail-fns:start ---");
  const end = script.indexOf("// --- rail-fns:end ---");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return script.slice(start, end);
}

describe("sum-latest-rail: the injected functions", () => {
  test("every exported function is injected, and nothing else is", () => {
    const block = injectedBlock();
    const injected = [...block.matchAll(/^\s{4}var (\w+) = function\b/gm)].map((m) => m[1]);
    const exported = Object.entries(rail)
      .filter(([, v]) => typeof v === "function")
      .map(([k]) => k)
      .sort();
    expect(injected.slice().sort()).toEqual(exported);
  });

  test("the injected copies run standalone and agree with the module", () => {
    const names = rail.RAIL_FUNCTIONS.map((f) => f.name);
    const api = new Function(injectedBlock() + "\nreturn {" + names.map((n) => n + ": " + n).join(",") + "};")() as typeof rail;

    const docs: rail.RailDoc[] = [
      { id: "ai/agents/A.md", source: "youtube", date: "2026-09-28", modifiedTime: "2026-09-28T09:00:00.000001" },
      { id: "ai/agents/B.md", source: "youtube", date: "2026-09-28", modifiedTime: "2026-09-28T09:00:00.000002" },
      { id: "life/sleep/C.md", source: "x-article", date: "2026-09-20" },
      { id: "ai/old/D.md", source: "vimeo", date: "2026-08-01" },
      { id: "ai/none/E.md", source: "youtube" },
    ];
    const init = api.railReadStateInit(null, "2026-09-27");
    const state = api.railMarkOpened(api.railPrune(init.state, docs), "youtube|ai/agents/A.md");
    const today = api.railLocalDay(new Date(2026, 8, 28, 12));
    const cutoff = api.railInitialCutoff(today);
    const filtered = api.railFilter(docs, "", "all", state);
    const win = api.railGroup(filtered, cutoff);

    expect(win).toEqual(rail.railGroup(docs, cutoff));
    expect(win.days.map((g) => [api.railDayLabel(g.day, today), g.docs.map((d) => api.railTitle(d.id))])).toEqual([
      ["Today", ["B", "A"]],
      ["Sun 20 Sep", ["C"]],
    ]);
    expect(api.railGroup(docs, api.railNextCutoff(win.newestHidden!)).days).toHaveLength(3);
    expect(win.days[0]!.docs.map((d) => api.railIsUnread(state, d))).toEqual([true, false]);
    expect(api.railBusiestCategories(docs, cutoff, 4)).toEqual(rail.railBusiestCategories(docs, cutoff, 4));
    expect(api.railCategoryLabel(api.railCategory("ai/agents/A.md"))).toBe("agents");
    expect(api.railReadStateParse(init.write)).toEqual(init.state);
    expect(api.railAddDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(api.railUtcDay(new Date(Date.UTC(2026, 8, 28, 23)))).toBe("2026-09-28");
    const ctx = { key: "j", altKey: false, ctrlKey: false, metaKey: false, panelOpen: true, editing: false, dialogOpen: false, menuOpen: false };
    expect(api.railStep(3, -1, api.railKeyAction(ctx)!)).toBe(0);
    expect(api.railCompare(docs[0]!, docs[1]!)).toBeGreaterThan(0);
  });

  test("the styles carry the rules the markup depends on", () => {
    const css = sumLatestRailStyles();
    for (const sel of [".sum-rail .sum-latest-row.current {", ".sum-latest-dot {", ".sum-latest-title {", ".sum-rail-pane[hidden] {"]) {
      expect(css).toContain(sel);
    }
    expect(css).toMatch(/-webkit-line-clamp: 2;/);
  });
});
