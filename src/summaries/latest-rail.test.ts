import { describe, expect, test } from "bun:test";
import {
  railAddDays,
  railBusiestCategories,
  railCompare,
  railDay,
  railDayLabel,
  railFilter,
  railGroup,
  railInitialCutoff,
  railIsUnread,
  railKey,
  railKeyAction,
  railLocalDay,
  railMarkOpened,
  railNextCutoff,
  railPrune,
  railReadStateInit,
  railReadStateParse,
  railStep,
  type RailDoc,
  type RailKeyContext,
} from "./latest-rail.ts";

const doc = (id: string, date: string | undefined, modifiedTime?: string, source = "youtube"): RailDoc => ({
  id,
  source,
  date,
  modifiedTime,
});

describe("latest rail: days", () => {
  test("railDay reads the day prefix and nothing else", () => {
    expect(railDay("2026-09-26")).toBe("2026-09-26");
    expect(railDay("2026-09-26T23:10:00Z")).toBe("2026-09-26");
    expect(railDay("26.09.2026")).toBeNull();
    expect(railDay(undefined)).toBeNull();
    expect(railDay(20260926)).toBeNull();
  });

  test("railAddDays crosses month and year ends", () => {
    expect(railAddDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(railAddDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(railInitialCutoff("2026-09-28")).toBe("2026-09-15");
    expect(railNextCutoff("2026-08-20")).toBe("2026-08-07");
  });

  test("labels: Today, Yesterday, then a weekday date, with the year only when it differs", () => {
    expect(railDayLabel("2026-09-28", "2026-09-28")).toBe("Today");
    expect(railDayLabel("2026-09-27", "2026-09-28")).toBe("Yesterday");
    expect(railDayLabel("2026-09-26", "2026-09-28")).toBe("Sat 26 Sep");
    expect(railDayLabel("2025-12-31", "2026-01-02")).toBe("Wed 31 Dec 2025");
  });

  test("railLocalDay is the local calendar day, not the UTC one", () => {
    const d = new Date(2026, 8, 28, 0, 30);
    expect(railLocalDay(d)).toBe("2026-09-28");
  });
});

describe("latest rail: ordering and grouping", () => {
  test("newest day first; within a day modifiedTime descending, then title", () => {
    const docs = [
      doc("ai/a/Beta.md", "2026-09-26", "2026-09-26T10:00:00.000002"),
      doc("ai/a/Alpha.md", "2026-09-26", "2026-09-26T10:00:00.000002"),
      doc("ai/a/Late.md", "2026-09-26", "2026-09-26T10:00:00.000003"),
      doc("ai/a/Newer day.md", "2026-09-27", "2026-09-01T00:00:00.000000"),
      doc("ai/a/No mtime.md", "2026-09-26", undefined),
    ];
    const titles = docs.slice().sort(railCompare).map((d) => d.id.split("/").pop());
    // Microseconds decide: a Date.parse compare would tie Late with Alpha/Beta.
    expect(titles).toEqual(["Newer day.md", "Late.md", "Alpha.md", "Beta.md", "No mtime.md"]);
  });

  test("groups by day inside the cutoff, counts the rest as hidden", () => {
    const docs = [
      doc("ai/a/Today.md", "2026-09-28"),
      doc("ai/a/Two.md", "2026-09-26"),
      doc("ai/a/Two b.md", "2026-09-26"),
      doc("ai/a/Old.md", "2026-09-01"),
      doc("ai/a/Older.md", "2026-08-01"),
      doc("ai/a/Undated.md", undefined),
    ];
    const win = railGroup(docs, "2026-09-15");
    expect(win.days.map((g) => [g.day, g.docs.length])).toEqual([
      ["2026-09-28", 1],
      ["2026-09-26", 2],
    ]);
    expect(win.hidden).toBe(2);
    expect(win.newestHidden).toBe("2026-09-01");
    // Show older reveals the newest hidden day even across a gap.
    const more = railGroup(docs, railNextCutoff(win.newestHidden!));
    expect(more.days.map((g) => g.day)).toEqual(["2026-09-28", "2026-09-26", "2026-09-01"]);
    expect(more.newestHidden).toBe("2026-08-01");
    expect(railGroup(docs, "2026-01-01").newestHidden).toBeNull();
  });

  test("busiest categories: last 14 days only, count then name, shared labels spelled out", () => {
    const docs = [
      doc("ai/tools/a.md", "2026-09-28"),
      doc("ai/tools/b.md", "2026-09-27"),
      doc("life/tools/c.md", "2026-09-27"),
      doc("ai/agents/d.md", "2026-09-20"),
      doc("ai/agents/e.md", "2026-09-20"),
      doc("ai/agents/f.md", "2026-09-20"),
      doc("health/sleep/g.md", "2026-09-20"),
      doc("ai/old/h.md", "2026-08-01"),
      doc("ai/old/i.md", "2026-08-01"),
      doc("ai/old/j.md", "2026-08-01"),
      doc("ai/old/k.md", "2026-08-01"),
    ];
    expect(railBusiestCategories(docs, "2026-09-15", 4)).toEqual([
      { key: "ai/agents", label: "agents", count: 3 },
      { key: "ai/tools", label: "ai/tools", count: 2 },
      { key: "health/sleep", label: "sleep", count: 1 },
      { key: "life/tools", label: "life/tools", count: 1 },
    ]);
  });
});

describe("latest rail: read state", () => {
  test("a first visit stores today's UTC day as the watermark", () => {
    const init = railReadStateInit(null, "2026-09-28");
    expect(init.state).toEqual({ watermark: "2026-09-28", opened: [] });
    expect(railReadStateParse(init.write)).toEqual(init.state);
  });

  test("a stored state is kept; a damaged one starts over", () => {
    const raw = JSON.stringify({ watermark: "2026-09-01", opened: ["youtube|a/b.md"] });
    expect(railReadStateInit(raw, "2026-09-28")).toEqual({
      state: { watermark: "2026-09-01", opened: ["youtube|a/b.md"] },
      write: null,
    });
    for (const bad of ["{", "null", '{"watermark":"yesterday","opened":[]}', '{"watermark":"2026-09-01"}']) {
      expect(railReadStateInit(bad, "2026-09-28").state.watermark).toBe("2026-09-28");
    }
  });

  test("unread = dated on or after the watermark and never opened; no state = read", () => {
    const state = { watermark: "2026-09-27", opened: [] as string[] };
    const before = doc("ai/a/Before.md", "2026-09-26");
    const on = doc("ai/a/On.md", "2026-09-27");
    const after = doc("ai/a/After.md", "2026-09-28");
    expect(railIsUnread(state, before)).toBe(false);
    expect(railIsUnread(state, on)).toBe(true);
    expect(railIsUnread(state, after)).toBe(true);
    const opened = railMarkOpened(state, railKey(after));
    expect(railIsUnread(opened, after)).toBe(false);
    expect(railMarkOpened(opened, railKey(after))).toBe(opened);
    expect(railIsUnread(null, after)).toBe(false);
  });

  test("a later modifiedTime never marks an opened or pre-watermark row unread", () => {
    const state = { watermark: "2026-09-27", opened: ["youtube|ai/a/Seen.md"] };
    expect(railIsUnread(state, doc("ai/a/Seen.md", "2026-09-28", "2026-09-30T00:00:00.000000"))).toBe(false);
    expect(railIsUnread(state, doc("ai/a/Old.md", "2026-09-01", "2026-09-30T00:00:00.000000"))).toBe(false);
  });

  test("the key includes the source: the same id in two verticals is two rows", () => {
    const state = railMarkOpened({ watermark: "2026-09-01", opened: [] }, "youtube|ai/a/X.md");
    expect(railIsUnread(state, doc("ai/a/X.md", "2026-09-28", undefined, "x-article"))).toBe(true);
  });

  test("prune drops deleted and pre-watermark keys, and never runs on an empty listing", () => {
    const state = {
      watermark: "2026-09-20",
      opened: ["youtube|ai/a/Keep.md", "youtube|ai/a/Gone.md", "youtube|ai/a/Old.md"],
    };
    const docs = [doc("ai/a/Keep.md", "2026-09-25"), doc("ai/a/Old.md", "2026-09-10")];
    expect(railPrune(state, docs).opened).toEqual(["youtube|ai/a/Keep.md"]);
    expect(railPrune(state, [])).toBe(state);
    const clean = { watermark: "2026-09-20", opened: ["youtube|ai/a/Keep.md"] };
    expect(railPrune(clean, docs)).toBe(clean);
  });
});

describe("latest rail: filter", () => {
  const state = { watermark: "2026-09-27", opened: ["youtube|ai/agents/Seen.md"] };
  const docs = [
    doc("ai/agents/Seen.md", "2026-09-28"),
    doc("ai/agents/Fresh.md", "2026-09-28"),
    doc("health/sleep/Deep sleep.md", "2026-09-20"),
  ];
  const ids = (list: RailDoc[]) => list.map((d) => d.id);

  test("chips: all, unread, one category", () => {
    expect(ids(railFilter(docs, "", "all", state))).toHaveLength(3);
    expect(ids(railFilter(docs, "", "unread", state))).toEqual(["ai/agents/Fresh.md"]);
    expect(ids(railFilter(docs, "", "cat:health/sleep", state))).toEqual(["health/sleep/Deep sleep.md"]);
    expect(railFilter(docs, "", "unread", null)).toEqual([]);
  });

  test("the query matches title or category, case-insensitively, and composes with a chip", () => {
    expect(ids(railFilter(docs, "  DEEP ", "all", state))).toEqual(["health/sleep/Deep sleep.md"]);
    expect(ids(railFilter(docs, "agents", "unread", state))).toEqual(["ai/agents/Fresh.md"]);
  });
});

describe("latest rail: j / k", () => {
  const base: RailKeyContext = {
    key: "j",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    panelOpen: true,
    editing: false,
    dialogOpen: false,
    menuOpen: false,
  };

  test("j is next and k is prev, only with the panel open and nothing else focused", () => {
    expect(railKeyAction(base)).toBe("next");
    expect(railKeyAction({ ...base, key: "k" })).toBe("prev");
    expect(railKeyAction({ ...base, key: "J" })).toBeNull();
    expect(railKeyAction({ ...base, key: "x" })).toBeNull();
    for (const off of [
      { panelOpen: false },
      { editing: true },
      { dialogOpen: true },
      { menuOpen: true },
      { metaKey: true },
      { ctrlKey: true },
      { altKey: true },
    ]) {
      expect(railKeyAction({ ...base, ...off })).toBeNull();
    }
  });

  test("steps stop at the ends; with no current row j starts at the top and k at the bottom", () => {
    expect(railStep(5, -1, "next")).toBe(0);
    expect(railStep(5, -1, "prev")).toBe(4);
    expect(railStep(5, 2, "next")).toBe(3);
    expect(railStep(5, 2, "prev")).toBe(1);
    expect(railStep(5, 4, "next")).toBe(-1);
    expect(railStep(5, 0, "prev")).toBe(-1);
    expect(railStep(0, -1, "next")).toBe(-1);
  });
});
