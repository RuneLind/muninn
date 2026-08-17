/**
 * The four behaviours the design prototype settled, plus the overlay's
 * disk-wins rule and the meter maths the "Backlog, priced" tile is built on.
 */

import { describe, expect, test } from "bun:test";
import {
  ACTIVE_COLUMN_KEYS,
  ageInDays,
  applyOverlay,
  cardMatches,
  columnForStatus,
  computeMeters,
  dropIntoColumn,
  familyCounts,
  filterCards,
  formatAge,
  formatUsd,
  nudgeOrder,
  rankOf,
  showRankUi,
  sortCards,
  visibleColumns,
  type BoardCard,
  type BoardColumnKey,
  type BoardOverlay,
  type EffectiveCard,
} from "./board-client-pure.ts";
import type { PlanPriority } from "./constants.ts";

function card(over: Partial<BoardCard> & { slug: string }): BoardCard {
  return {
    title: over.slug,
    description: null,
    statusNote: null,
    planStatus: "proposed",
    column: "proposed",
    statusDate: null,
    ageDays: null,
    mtimeMs: 0,
    priority: null,
    tags: [],
    relPath: `plans/${over.slug}.mdx`,
    hash: "h",
    followupsOpen: false,
    wikiUrl: `/wiki?wiki=mimir&page=${over.slug}`,
    family: "muninn",
    familySource: "slug",
    familyConfident: true,
    mixedRepos: false,
    estimate: null,
    ledger: null,
    ...over,
  };
}

function eff(over: Partial<BoardCard> & { slug: string }): EffectiveCard {
  const base = card(over);
  return { ...base, effectivePriority: base.priority, priorityIsDraft: false };
}

const est = (mid: number, low = mid / 2, high = mid * 2) => ({
  low,
  mid,
  high,
  prCount: 3,
  assumedCount: false,
  pool: "family" as const,
  poolKey: "muninn",
  sampleSize: 9,
  dollarsPerPR: { p25: low / 3, p50: mid / 3, p75: high / 3 },
});

describe("columns", () => {
  test("followups beats shipped, terminal states share a column, unknown files under proposed", () => {
    expect(columnForStatus("shipped", true)).toBe("followups");
    expect(columnForStatus("shipped", false)).toBe("shipped");
    expect(columnForStatus("superseded", false)).toBe("shipped");
    expect(columnForStatus("abandoned", false)).toBe("shipped");
    expect(columnForStatus("blocked", false)).toBe("blocked");
    expect(columnForStatus(null, false)).toBe("proposed");
    expect(columnForStatus("wat", false)).toBe("proposed");
    // A superseded plan carrying followups: open is still terminal — the
    // follow-ups column is about shipped work that left something behind.
    expect(columnForStatus("superseded", true)).toBe("shipped");
  });

  test("scopes add columns rather than replacing them", () => {
    expect(visibleColumns("active").map((c) => c.key)).toEqual([...ACTIVE_COLUMN_KEYS]);
    expect(visibleColumns("followups").map((c) => c.key)).toEqual([
      ...ACTIVE_COLUMN_KEYS,
      "followups",
    ]);
    expect(visibleColumns("all").map((c) => c.key)).toEqual([
      ...ACTIVE_COLUMN_KEYS,
      "followups",
      "shipped",
    ]);
  });
});

describe("rank belongs to the column, not to the plan", () => {
  const order = { proposed: ["a", "b"], ready: ["c"] };

  test("a slug ranked in one column has no rank in another", () => {
    expect(rankOf(order, "proposed", "b")).toBe(1);
    expect(rankOf(order, "ready", "b")).toBe(-1);
    expect(rankOf(order, "blocked", "a")).toBe(-1);
  });

  test("an unranked column ranks nothing", () => {
    expect(rankOf({}, "proposed", "a")).toBe(-1);
  });
});

describe("rank UI is live only under My order", () => {
  test("badges and nudges", () => {
    expect(showRankUi("rank")).toBe(true);
    for (const sort of ["age", "priority", "cost"] as const) {
      expect(showRankUi(sort)).toBe(false);
    }
  });
});

describe("ranking degrades", () => {
  // A column nobody would hand-rank: 20 cards, three of them placed.
  const cards: EffectiveCard[] = [];
  for (let i = 0; i < 20; i++) {
    cards.push(
      eff({
        slug: `p${String(i).padStart(2, "0")}`,
        priority: i % 5 === 0 ? "p0" : i % 3 === 0 ? "p2" : null,
        statusDate: i % 2 === 0 ? `2026-01-${String(10 + i).padStart(2, "0")}` : null,
        mtimeMs: 1000 - i,
      }),
    );
  }
  const placed = ["p07", "p03", "p19"];

  test("placed cards hold the top in placed order, the rest fall in behind", () => {
    const sorted = sortCards(cards, "rank", placed).map((c) => c.slug);
    expect(sorted.slice(0, 3)).toEqual(placed);
    expect(sorted).toHaveLength(20);
    expect(new Set(sorted).size).toBe(20);
  });

  test("the tail falls in on priority first, then age, undated last", () => {
    const tail = sortCards(cards, "rank", placed).slice(3);
    const rank = (p: PlanPriority | null) => (p === "p0" ? 0 : p === "p2" ? 2 : 9);
    for (let i = 1; i < tail.length; i++) {
      expect(rank(tail[i - 1]!.effectivePriority)).toBeLessThanOrEqual(
        rank(tail[i]!.effectivePriority),
      );
    }
    const p0s = tail.filter((c) => c.effectivePriority === "p0").map((c) => c.statusDate);
    // Older status_date first inside one priority bucket; undated after dated.
    const dated = p0s.filter((d): d is string => d !== null);
    expect([...dated].sort()).toEqual(dated);
    expect(p0s.indexOf(null)).toBe(dated.length === p0s.length ? -1 : dated.length);
  });

  test("an unranked column is pure degrade — no rank, no crash", () => {
    const sorted = sortCards(cards, "rank", []).map((c) => c.slug);
    expect(sorted).toHaveLength(20);
    expect(sorted[0]).toBe(sortCards(cards, "priority").map((c) => c.slug)[0]);
  });
});

describe("sorts", () => {
  const a = eff({ slug: "a", statusDate: "2026-01-01", priority: "p3", estimate: est(100) });
  const b = eff({ slug: "b", statusDate: "2026-06-01", priority: "p0", estimate: est(900) });
  const c = eff({ slug: "c", statusDate: null, mtimeMs: 50, priority: null });
  const d = eff({ slug: "d", statusDate: null, mtimeMs: 10, priority: "p1", estimate: est(400) });

  test("age: older first, undated last ordered by mtime", () => {
    expect(sortCards([c, b, d, a], "age").map((x) => x.slug)).toEqual(["a", "b", "d", "c"]);
  });

  test("priority: p0 first, unset last, age breaks ties", () => {
    expect(sortCards([c, a, b, d], "priority").map((x) => x.slug)).toEqual(["b", "d", "a", "c"]);
  });

  test("cost: biggest estimate first, unpriced last", () => {
    expect(sortCards([a, c, b, d], "cost").map((x) => x.slug)).toEqual(["b", "d", "a", "c"]);
  });

  test("sorting never mutates its input", () => {
    const input = [c, b, a];
    sortCards(input, "cost");
    expect(input.map((x) => x.slug)).toEqual(["c", "b", "a"]);
  });
});

describe("nudging", () => {
  test("swaps with the neighbour and refuses at the edges", () => {
    expect(nudgeOrder(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(nudgeOrder(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    expect(nudgeOrder(["a", "b", "c"], "a", -1)).toBeNull();
    expect(nudgeOrder(["a", "b", "c"], "c", 1)).toBeNull();
    expect(nudgeOrder(["a", "b"], "zz", -1)).toBeNull();
  });

  test("returns a new list rather than reordering in place", () => {
    const list = ["a", "b"];
    expect(nudgeOrder(list, "a", 1)).toEqual(["b", "a"]);
    expect(list).toEqual(["a", "b"]);
  });
});

describe("one drop must not pin 49 cards", () => {
  test("a drop on an unranked column changes nothing", () => {
    expect(dropIntoColumn(undefined, "x", null)).toBeUndefined();
  });

  test("a drop on a ranked column appends or inserts", () => {
    expect(dropIntoColumn(["a", "b"], "x", null)).toEqual(["a", "b", "x"]);
    expect(dropIntoColumn(["a", "b"], "x", "b")).toEqual(["a", "x", "b"]);
    // Re-placing a card already in the order moves it rather than duplicating.
    expect(dropIntoColumn(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });
});

describe("overlay: disk wins", () => {
  const cards = [
    card({ slug: "onDisk", priority: "p1" }),
    card({ slug: "noPriority" }),
    card({ slug: "ready1", column: "ready", planStatus: "ready" }),
  ];
  const overlay: BoardOverlay = {
    priority: { onDisk: "p3", noPriority: "p0" },
    order: { proposed: ["noPriority", "onDisk"], ready: ["ready1"] },
  };

  test("a disk priority is never overwritten by a draft", () => {
    const { cards: merged } = applyOverlay(cards, {}, overlay);
    const byS = Object.fromEntries(merged.map((c) => [c.slug, c]));
    expect(byS.onDisk!.effectivePriority).toBe("p1");
    expect(byS.onDisk!.priorityIsDraft).toBe(false);
    expect(byS.noPriority!.effectivePriority).toBe("p0");
    expect(byS.noPriority!.priorityIsDraft).toBe(true);
  });

  test("a column ranked on disk ignores the draft order entirely", () => {
    const disk = { proposed: ["onDisk", "noPriority"] };
    const { order, orderIsDraft } = applyOverlay(cards, disk, overlay);
    expect(order.proposed).toEqual(["onDisk", "noPriority"]);
    expect(orderIsDraft.proposed).toBe(false);
    // …while a column disk says nothing about still takes the draft.
    expect(order.ready).toEqual(["ready1"]);
    expect(orderIsDraft.ready).toBe(true);
  });

  test("a draft order is filtered to slugs still in that column", () => {
    const stale: BoardOverlay = { priority: {}, order: { proposed: ["gone", "onDisk"] } };
    const { order } = applyOverlay(cards, {}, stale);
    expect(order.proposed).toEqual(["onDisk"]);
  });

  test("no overlay at all is the identity", () => {
    const { cards: merged, order } = applyOverlay(cards, { proposed: ["onDisk"] });
    expect(merged.map((c) => c.effectivePriority)).toEqual(["p1", null, null]);
    expect(order).toEqual({ proposed: ["onDisk"] });
  });
});

describe("filters", () => {
  const cards = [
    eff({ slug: "muninn-a", title: "Board page", family: "muninn", tags: ["dashboard"], priority: "p0" }),
    eff({ slug: "huginn-b", title: "Indexer", family: "huginn", tags: ["search"] }),
  ];

  test("family, priority (incl. unset) and free text", () => {
    expect(filterCards(cards, { families: ["muninn"], priority: null, query: "" }).map((c) => c.slug))
      .toEqual(["muninn-a"]);
    expect(filterCards(cards, { families: [], priority: "unset", query: "" }).map((c) => c.slug))
      .toEqual(["huginn-b"]);
    expect(filterCards(cards, { families: [], priority: "p0", query: "" }).map((c) => c.slug))
      .toEqual(["muninn-a"]);
    expect(filterCards(cards, { families: [], priority: null, query: "search" }).map((c) => c.slug))
      .toEqual(["huginn-b"]);
    expect(filterCards(cards, { families: [], priority: null, query: "BOARD" }).map((c) => c.slug))
      .toEqual(["muninn-a"]);
    expect(cardMatches(cards[0]!, { families: ["huginn"], priority: null, query: "" })).toBe(false);
  });

  test("family chips are counted, most used first", () => {
    expect(familyCounts([card({ slug: "a" }), card({ slug: "b" }), card({ slug: "c", family: "mimir" })]))
      .toEqual([
        { family: "muninn", count: 2 },
        { family: "mimir", count: 1 },
      ]);
  });
});

describe("meters", () => {
  const cards: BoardCard[] = [
    card({ slug: "a", column: "proposed", estimate: est(100), ageDays: 10 }),
    card({ slug: "b", column: "in-flight", estimate: est(300), ageDays: 30, ledger: facts(50) }),
    card({ slug: "c", column: "blocked" }), // no ledger row at all — unpriced
    card({ slug: "d", column: "shipped", estimate: est(700), ledger: facts(640) }),
    card({ slug: "e", column: "followups", estimate: est(200), ledger: facts(180) }),
  ];

  test("backlog sums exactly the active cards it names", () => {
    const m = computeMeters(cards, true);
    expect(m.activeCount).toBe(3);
    expect(m.backlog!.slugs).toEqual(["a", "b"]);
    expect(m.backlog!.count).toBe(2);
    expect(m.backlog!.mid).toBe(400);
    expect(m.backlog!.low).toBe(200);
    expect(m.backlog!.high).toBe(800);
  });

  test("spent-to-date is the terminal columns' ledger cost, not the estimate", () => {
    const m = computeMeters(cards, true);
    expect(m.spentToDate).toBe(820);
    expect(m.spentOnActive).toBe(50);
    expect(m.followupsCount).toBe(1);
    expect(m.inFlightCount).toBe(1);
    expect(m.medianAgeDays).toBe(20);
  });

  test("money hidden ⇒ every money meter is null, counts survive", () => {
    const m = computeMeters(cards, false);
    expect(m.backlog).toBeNull();
    expect(m.spentToDate).toBeNull();
    expect(m.spentOnActive).toBeNull();
    expect(m.activeCount).toBe(3);
    expect(m.totalCount).toBe(5);
  });

  test("no dated active plan ⇒ no median age, never a zero", () => {
    expect(computeMeters([card({ slug: "x", column: "proposed" })], true).medianAgeDays).toBeNull();
  });
});

function facts(costUSD: number) {
  return {
    costUSD,
    landed: 2,
    merges: 2,
    activeHours: 3,
    findings: 4,
    maxRounds: 1,
    handovers: 0,
    sessions: 1,
    prs: [],
  };
}

describe("formatting", () => {
  test("usd rounds the same way everywhere, and says — for nothing", () => {
    expect(formatUsd(340.4)).toBe("$340");
    expect(formatUsd(1234)).toBe("$1.2k");
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(Number.NaN)).toBe("—");
  });

  test("an undated plan reads 'no date', never a fabricated age", () => {
    expect(formatAge(33)).toBe("33 d");
    expect(formatAge(null)).toBe("no date");
    expect(ageInDays(null, Date.now())).toBeNull();
    expect(ageInDays("not-a-date", Date.now())).toBeNull();
    expect(ageInDays("2026-08-01", Date.parse("2026-08-17T12:00:00Z"))).toBe(17);
  });
});

describe("column key coverage", () => {
  test("every BoardColumnKey has metadata", () => {
    const keys: BoardColumnKey[] = ["proposed", "ready", "in-flight", "blocked", "followups", "shipped"];
    for (const k of keys) expect(visibleColumns("all").some((c) => c.key === k)).toBe(true);
  });
});
