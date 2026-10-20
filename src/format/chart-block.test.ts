import { describe, expect, test } from "bun:test";
import {
  chartBlocks,
  chartBody,
  chartGateVerdict,
  chartTable,
  formatChartNumber,
  formatChartPercent,
  readChart,
  readValueCell,
  type ChartModel,
  type ChartRead,
} from "./chart-block.ts";
import { readChartKind } from "./component-spec.ts";
import { headerKey } from "./delta-table.ts";
import { parseBlocks } from "./markdown-ast.ts";
import { gateRowPr } from "./pr-ledger.ts";
import { visibleText } from "./report-top.ts";

// Invented tables only: no value here comes from a real page.

const pipe = (header: string[], rows: string[][]): string[] => [
  `| ${header.join(" | ")} |`,
  `|${header.map(() => "---").join("|")}|`,
  ...rows.map((r) => `| ${r.join(" | ")} |`),
];

/** One `<Chart>` read the way the reader and the lint read it. */
function chart(open: string, header: string[], rows: string[][]): ChartRead {
  const [block] = chartBlocks(parseBlocks([open, "", ...pipe(header, rows), "", "</Chart>"].join("\n")));
  const { table } = chartBody(block!.children);
  return readChart(readChartKind(block!.attrs.kind).value, block!.attrs, table ? chartTable(table, visibleText) : null);
}

const messages = (r: ChartRead) => r.findings.map((f) => f.message);
function model<K extends ChartModel["kind"]>(r: ChartRead, kind: K): Extract<ChartModel, { kind: K }> {
  expect(r.findings.filter((f) => f.fatal)).toEqual([]);
  expect(r.model?.kind).toBe(kind);
  return r.model as Extract<ChartModel, { kind: K }>;
}

describe("value cells", () => {
  test("a number, then ± n, then decision ids", () => {
    expect(readValueCell("12,5 ± 0,4 (D7, S2)", { decimalComma: true })).toEqual({
      n: 12.5,
      text: "12,5",
      decimals: 1,
      unit: "",
      pm: "0,4",
      ids: ["D7", "S2"],
    });
    expect(readValueCell("40 %", {})?.unit).toBe("%");
    for (const bad of ["about 4", "4 (see D7)", "± 2", "4 ± x", "4 (d7)"]) expect({ bad, v: readValueCell(bad, {}) }).toEqual({ bad, v: null });
  });

  test("a cell with ids or ± sets the table's decimal comma", () => {
    // `+1,5 (D7)` is the only unambiguous decimal comma; it makes `1,250` 1.25.
    const s = model(chart('<Chart kind="steps" x="Step">', ["Step", "S"], [["A", "1,250"], ["B", "+1,5 (D7)"]]), "steps");
    expect(s.series[0]!.points).toEqual([1.25, 1.5]);
  });

  test("struck text is not read", () => {
    const s = model(chart('<Chart kind="steps" x="Step">', ["Step", "S"], [["A", "~~9~~ 4"], ["B", "6"]]), "steps");
    expect(s.series[0]!.points).toEqual([4, 6]);
  });

  test("a non-number in a value column is a fatal finding and no model", () => {
    const r = chart('<Chart kind="gap" value="Now" target="Goal" gap="Gap">', ["Item", "Now", "Goal", "Gap"], [["a", "many", "10", ""]]);
    expect(r.model).toBeNull();
    expect(messages(r)).toEqual(['row "a": "many" in Now is not a number']);
  });
});

describe("headers", () => {
  test("an attribute matches its header past case, emphasis, dashes and spacing", () => {
    expect(headerKey("**Actual – now**")).toBe(headerKey("actual - now"));
    expect(headerKey("Bar after")).toBe("bar after");
    const r = chart('<Chart kind="gap" value="actual - now" target="GOAL" gap="gap">', ["Item", "**Actual – now**", "Goal", "_Gap_"], [["a", "4", "10", "6"]]);
    expect(model(r, "gap").valueName).toBe("Actual – now");
  });

  test("a header written twice is a finding", () => {
    const r = chart('<Chart kind="gap" value="Now" target="Goal" gap="Gap">', ["Item", "Now", "now", "Goal", "Gap"], [["a", "1", "2", "3", "2"]]);
    expect(messages(r)).toEqual(['value="Now" names a header written 2 times']);
  });

  test("a missing column and a missing attribute are findings", () => {
    const r = chart('<Chart kind="gap" value="Now" target="Aim">', ["Item", "Now", "Goal"], [["a", "1", "2"]]);
    expect(messages(r)).toEqual(['target="Aim" names no column', "needs gap= naming a column"]);
  });

  test("a mark= naming no column is a finding", () => {
    const r = chart('<Chart kind="gap" value="Now" target="Goal" gap="Gap" mark="Then">', ["Item", "Now", "Goal", "Gap"], [["a", "1", "2", "1"]]);
    expect(messages(r)).toEqual(['mark="Then" names no column']);
    expect(r.model).toBeNull();
  });

  test("kind is read case-sensitively", () => {
    expect(readChartKind("gap")).toEqual({ value: "gap", fellBack: false });
    expect(readChartKind("Gap")).toEqual({ value: null, fellBack: true });
    expect(readChartKind(undefined)).toEqual({ value: null, fellBack: false });
  });
});

describe("gap", () => {
  const gap = (value: string, target: string, g: string) =>
    chart('<Chart kind="gap" value="Now" target="Goal" gap="Gap">', ["Item", "Now", "Goal", "Gap"], [["a", value, target, g]]);

  test("a gap cell within half a unit of its last decimal is no note", () => {
    expect(gap("0", "1500.4", "1,500").findings).toEqual([]);
    expect(gap("0", "1499.5", "1,499.5").findings).toEqual([]);
    expect(gap("0", "1499.54", "1,499.5").findings).toEqual([]);
    expect(messages(gap("0", "1499.6", "1,499.5"))).toEqual(['row "a": the gap cell says 1,499.5, but Goal − Now is 1499.6']);
  });

  test("a signed gap is compared signed, an unsigned one by size", () => {
    expect(gap("10", "5", "5").findings).toEqual([]);
    expect(gap("10", "5", "−5").findings).toEqual([]);
    expect(messages(gap("10", "5", "+5"))).toEqual(['row "a": the gap cell says +5, but Goal − Now is −5']);
  });

  test("a gap note is info, the chart still draws, with a decimal comma when the table has one", () => {
    const r = gap("2,5", "4,0", "1,4");
    expect(r.findings).toEqual([{ message: 'row "a": the gap cell says 1,4, but Goal − Now is 1,5', fatal: false, row: 0 }]);
    expect(model({ ...r, findings: [] }, "gap").rows[0]!.gapText).toBe("1,4");
  });

  test("an empty mark column cell is no mark", () => {
    const r = chart('<Chart kind="gap" value="Now" target="Goal" gap="Gap" mark="Then">', ["Item", "Now", "Goal", "Gap", "Then"], [["a", "1", "3", "2", ""], ["b", "1", "3", "2", "2"]]);
    expect(model(r, "gap").rows.map((x) => x.mark?.n ?? null)).toEqual([null, 2]);
  });

  test("a table with no data rows says so", () => {
    const empty = { headers: ["Item", "Now", "Goal", "Gap"], rows: [], rawFirst: [] };
    expect(messages(readChart("gap", { value: "Now", target: "Goal", gap: "Gap" }, empty))).toEqual(["has no data rows"]);
  });
});

describe("gate", () => {
  const head = ["Slice", "Bar", "Pass", "Hold"];
  const open = '<Chart kind="gate" bar="Bar" pass="Pass" hold="Hold">';

  test("the verdict: both values reach the bar, an unmeasured hold is a miss", () => {
    const g = model(chart(open, head, [["1 — a", "2", "3", "2"], ["2 — b", "2", "3", "—"], ["3 — c", "2", "1,5", "3"], ["4", "2", "2", "1"]]), "gate");
    expect(g.rows.map((r) => chartGateVerdict(r.pass, r.hold, r.bar))).toEqual([
      { pass: true },
      { pass: false, reason: "hold-not-measured" },
      { pass: false, reason: "below", value: "1,5", bar: "2" },
      { pass: false, reason: "below", value: "1", bar: "2" },
    ]);
  });

  test("a % bar against a unitless value is a finding", () => {
    expect(messages(chart(open, head, [["1", "40%", "50", "45%"]]))).toEqual(['row "1": 40% and 50 are not in the same unit']);
    expect(messages(chart(open, head, [["1", "40", "50%", "45"]]))).toEqual(['row "1": 40 and 50% are not in the same unit']);
  });

  test("a Bar after column is read by its header in either language", () => {
    for (const after of ["Bar after", "Krav etter"]) {
      const g = model(chart(open, [...head, after], [["1", "2", "3", "3", "4"], ["2", "2", "3", "3", ""]]), "gate");
      expect({ after, bars: g.rows.map((r) => r.barAfter?.n ?? null), on: g.barAfter }).toEqual({ after, bars: [4, null], on: true });
    }
  });

  test("a row's PR is read as a ledger slate, strictly", () => {
    const g = model(chart(open, head, [["7 — rows", "1", "1", "1"], ["PR 9", "1", "1", "1"], ["3 runs", "1", "1", "1"]]), "gate");
    expect(g.rows.map((r) => r.pr?.slate ?? null)).toEqual([7, 9, null]);
  });
});

describe("named columns", () => {
  test("a mark= naming no column is fatal, and like a missing column stops the read", () => {
    const r = chart('<Chart kind="gap" value="Now" target="Goal" gap="Gap" mark="Nope">', ["I", "Now", "Goal", "Gap"], [["a", "soon", "4", "3"]]);
    expect(r.model).toBeNull();
    expect(messages(r)).toEqual(['mark="Nope" names no column']);
  });

  test("a Bar after column written in both languages is fatal", () => {
    const r = chart('<Chart kind="gate" bar="Bar" pass="Pass" hold="Hold">', ["S", "Bar", "Bar after", "Krav etter", "Pass", "Hold"], [["a", "2", "3", "3", "3", "3"]]);
    expect(r.model).toBeNull();
    expect(messages(r)).toEqual(["has 2 «Bar after» columns"]);
  });
});

describe("gateRowPr", () => {
  test.each([
    ["7", { slate: 7, link: null }],
    ["**7** — rows", { slate: 7, link: null }],
    ["PR 7", { slate: 7, link: null }],
    ["PR #7 rows", { slate: 7, link: 7 }],
    ["7: rows", { slate: 7, link: null }],
    ["[#7](https://example.test/o/r/pull/7)", { slate: null, link: 7 }],
    ["[#7](https://example.test/o/r/pull/7) Retry logic", { slate: null, link: 7 }],
    ["[#7](https://example.test/o/r/pull/7) — Retry", { slate: null, link: 7 }],
    ["2 — [#7](https://example.test/o/r/pull/7)", { slate: 2, link: 7 }],
    ["21a", null],
    ["2026-10-01", null],
    ["12–40", null],
    ["12-40", null],
    ["3 runs", null],
    ["7 — 3 runs", null],
    ["rows", null],
    ["~~8~~ 12", { slate: 12, link: null }],
    ["~~8~~ PR 12 rows", { slate: 12, link: null }],
    ["~~8~~", null],
    ["~~[#8](https://example.test/o/r/pull/8)~~ [#12](https://example.test/o/r/pull/12)", { slate: null, link: 12 }],
  ])("%p → %p", (cell, pr) => {
    expect(gateRowPr(cell)).toEqual(pr);
  });
});

describe("steps", () => {
  test("an empty cell carries the last value forward", () => {
    const s = model(chart('<Chart kind="steps" x="Step">', ["Step", "A", "B"], [["one", "1", ""], ["two", "", "5"], ["three", "3", ""]]), "steps");
    expect(s.series.map((x) => x.points)).toEqual([[1, 1, 3], [null, 5, 5]]);
    expect(s.steps).toEqual(["one", "two", "three"]);
  });

  test("normalize=ref plots each series as % of the ref row, which plots at 100 when it opens the table", () => {
    const s = model(chart('<Chart kind="steps" x="Step" ref="base" normalize="ref">', ["Step", "A"], [["base", "8"], ["next", "10"], ["last", "6"]]), "steps");
    expect(s.series[0]!.points).toEqual([100, 125, 75]);
    expect(s.refLabel).toBe("base");
  });

  test("a ref row that does not open the table is the reference only", () => {
    const s = model(chart('<Chart kind="steps" x="Step" ref="goal">', ["Step", "A"], [["one", "1"], ["goal", "9"], ["two", "2"]]), "steps");
    expect(s.steps).toEqual(["one", "two"]);
    expect(s.series[0]!.ref).toBe(9);
  });

  test("a ref row that opens the table gives each finding once, naming the row by its label", () => {
    const r = chart('<Chart kind="steps" x="Step" ref="base">', ["A", "Step"], [["lots", "base"], ["2", "next"]]);
    expect(messages(r)).toEqual(['row "base": "lots" in A is not a number']);
  });

  test("a series with no values is a finding", () => {
    expect(messages(chart('<Chart kind="steps" x="Step">', ["Step", "A", "B"], [["one", "1", ""], ["two", "2", "—"]]))).toEqual(["B has no values"]);
  });

  test("normalize needs a ref= row, and a non-zero value in it", () => {
    expect(messages(chart('<Chart kind="steps" x="Step" normalize="ref">', ["Step", "A"], [["one", "1"]]))).toEqual(['normalize="ref" needs ref= naming a row']);
    expect(messages(chart('<Chart kind="steps" x="Step" ref="one" normalize="ref">', ["Step", "A"], [["one", "0"], ["two", "2"]]))).toEqual([
      "A has no non-zero value in the one row to measure against",
    ]);
  });

  test("a ref= naming no row, or two rows, is a finding", () => {
    expect(messages(chart('<Chart kind="steps" x="Step" ref="zz">', ["Step", "A"], [["one", "1"]]))).toEqual(['ref="zz" names no row in Step']);
    expect(messages(chart('<Chart kind="steps" x="Step" ref="one">', ["Step", "A"], [["one", "1"], ["One", "2"]]))).toEqual(['ref="one" names 2 rows']);
  });

  test("x= naming the only column leaves no series, a fatal finding", () => {
    const r = chart('<Chart kind="steps" x="Step">', ["Step"], [["one"], ["two"]]);
    expect(r.model).toBeNull();
    expect(r.findings.map((f) => [f.message, f.fatal])).toEqual([["has no series columns", true]]);
  });

  test("a table with no rows says it has no step rows", () => {
    expect(messages(readChart("steps", { x: "Step" }, { headers: ["Step", "A"], rows: [], rawFirst: [] }))).toEqual(["has no step rows"]);
  });
});

describe("funnel", () => {
  test("each row's parent is the nearest earlier row with that count; share and depth follow", () => {
    const f = model(
      chart('<Chart kind="funnel">', ["Step", "Count", "Of"], [["all", "80", ""], ["kept", "40", "80"], ["sent", "20", "40"], ["side", "40", "80"], ["late", "10", "40"]]),
      "funnel",
    );
    expect(f.rows.map((r) => [r.label, r.depth, r.share])).toEqual([
      ["all", 0, null],
      ["kept", 1, 50],
      ["sent", 2, 50],
      ["side", 1, 50],
      ["late", 2, 25],
    ]);
  });

  test("of two earlier rows with the Of count, the nearer one is the parent", () => {
    const f = model(chart('<Chart kind="funnel">', ["Step", "Count", "Of"], [["root", "20", ""], ["again", "20", "20"], ["kid", "5", "20"]]), "funnel");
    expect(f.rows.map((r) => [r.label, r.depth])).toEqual([
      ["root", 0],
      ["again", 1],
      ["kid", 2],
    ]);
  });

  test("the count column defaults to the first after the label that is not Of; value= picks another", () => {
    const def = model(chart('<Chart kind="funnel">', ["Step", "Av", "Count", "Other"], [["all", "", "8", "1"], ["kept", "8", "4", "1"]]), "funnel");
    expect(def.rows.map((r) => r.value.n)).toEqual([8, 4]);
    const picked = chart('<Chart kind="funnel" value="Other">', ["Step", "Av", "Count", "Other"], [["all", "", "8", "1"], ["kept", "8", "4", "1"]]);
    expect(messages(picked)).toEqual(['row "kept": Av 8 matches no earlier row\'s count']);
  });

  test("a parent of 0 gives no share, never NaN", () => {
    const f = model(chart('<Chart kind="funnel">', ["Step", "Count", "Of"], [["all", "0", ""], ["kept", "0", "0"]]), "funnel");
    expect(f.rows[1]!.share).toBeNull();
  });

  test("a row larger than its parent, a negative count and a missing Of column are findings", () => {
    expect(messages(chart('<Chart kind="funnel">', ["Step", "Count", "Of"], [["all", "8", ""], ["kept", "9", "8"]]))).toEqual([
      'row "kept": 9 is larger than its parent 8',
    ]);
    expect(messages(chart('<Chart kind="funnel">', ["Step", "Count", "Of"], [["all", "-8", ""]]))).toEqual(['row "all": a count is negative']);
    expect(messages(chart('<Chart kind="funnel">', ["Step", "Count"], [["all", "8"]]))).toEqual([
      "has no «Av» or «Of» column naming each row's parent count",
    ]);
  });
});

describe("numbers", () => {
  test("a minus is U+2212, never −0, trailing zeros cut", () => {
    expect(formatChartNumber(-1.5, 1, false)).toBe("−1.5");
    expect(formatChartNumber(-0.001, 1, false)).toBe("0");
    expect(formatChartNumber(2.5, 2, true)).toBe("2,5");
    expect(formatChartNumber(3, 2, false)).toBe("3");
  });

  test("a percent has one decimal under 10 and none from 10, never −0%", () => {
    expect(formatChartPercent(4.25, true)).toBe("4,3%");
    expect(formatChartPercent(12.6, false)).toBe("13%");
    expect(formatChartPercent(-0.01, false)).toBe("0%");
  });
});

describe("the body", () => {
  test("blocks after the table stay after it", () => {
    const [block] = chartBlocks(parseBlocks(['<Chart kind="gap">', "", "Intro.", "", ...pipe(["A", "B"], [["1", "2"]]), "", "After.", "", "</Chart>"].join("\n")));
    const body = chartBody(block!.children);
    expect([body.before.length, body.table?.type, body.after.length]).toEqual([1, "table", 1]);
  });

  test("no table is a fatal finding", () => {
    expect(readChart("gap", {}, null).findings).toEqual([{ message: "holds no pipe table", fatal: true }]);
  });
});
