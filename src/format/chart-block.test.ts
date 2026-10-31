import { describe, expect, test } from "bun:test";
import {
  chartBlocks,
  chartBody,
  chartGateVerdict,
  chartTable,
  formatChartNumber,
  formatChartPercent,
  readChart,
  readIntervalCell,
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

describe("bars", () => {
  test("one bar per row, in the order written, a leading currency sign read", () => {
    const b = model(chart('<Chart kind="bars" value="Cost">', ["Run", "Cost"], [["c", "$30"], ["a", "$12 (D2)"], ["b", "$45"]]), "bars");
    expect(b.rows.map((r) => [r.label, r.value.n, r.value.text, r.value.ids])).toEqual([
      ["c", 30, "$30", []],
      ["a", 12, "$12", ["D2"]],
      ["b", 45, "$45", []],
    ]);
    expect(b.log).toBe(false);
  });

  test("the log-scale rule: every value above 0 and the largest over 100 times the smallest", () => {
    const log = (vals: string[]) => model(chart('<Chart kind="bars" value="N">', ["Item", "N"], vals.map((v, i) => [`r${i}`, v])), "bars").log;
    expect(log(["1", "101"])).toBe(true);
    expect(log(["1", "100"])).toBe(false);
    expect(log(["0", "5000"])).toBe(false); // a 0 has no log
    expect(log(["-1", "5000"])).toBe(false);
    expect(log(["7"])).toBe(false);
  });

  test("findings: an unreadable cell, an empty cell, mixed units, no value=", () => {
    expect(messages(chart('<Chart kind="bars" value="N">', ["Item", "N"], [["a", "lots"]]))).toEqual(['row "a": "lots" in N is not a number']);
    expect(messages(chart('<Chart kind="bars" value="N">', ["Item", "N"], [["a", "—"]]))).toEqual(['row "a": the N cell is empty']);
    expect(messages(chart('<Chart kind="bars" value="N">', ["Item", "N"], [["a", "$3"], ["b", "4"]]))).toEqual(['row "b": $3 and 4 are not in the same unit']);
    expect(messages(chart('<Chart kind="bars" value="N">', ["Item", "N"], [["a", "3 h"], ["b", "4 d"]]))).toEqual(['row "b": 3 h and 4 d are not in the same unit']);
    const none = chart('<Chart kind="bars">', ["Item", "N"], [["a", "3"]]);
    expect(none.findings).toEqual([{ message: "needs value= naming a column", fatal: true }]);
    expect(none.model).toBeNull();
  });
});

describe("range", () => {
  const range = (rows: string[][], header = ["Slice", "Interval"]) => chart('<Chart kind="range" value="Interval">', header, rows);

  test("the interval spellings: en dash, spaced hyphen, a sign on either end, `~`, a trailing unit, a point", () => {
    const cases: [string, number, number, string, string][] = [
      ["$40–80", 40, 80, "$", ""],
      ["$40–$80", 40, 80, "$", ""],
      ["40–$80", 40, 80, "$", ""],
      ["~$40 – $80", 40, 80, "$", ""],
      ["40 - 80", 40, 80, "", ""],
      ["40–80 USD", 40, 80, "", "USD"],
      ["$1,200–1,800", 1200, 1800, "$", ""],
      ["€50", 50, 50, "€", ""],
      ["12", 12, 12, "", ""],
    ];
    for (const [cell, lo, hi, sign, unit] of cases) {
      const v = readIntervalCell(cell, {});
      expect({ cell, v: v && [v.lo, v.hi, v.sign, v.unit] }).toEqual({ cell, v: [lo, hi, sign, unit] });
    }
  });

  test("not an interval: dates, years, two signs, two units, a ± or text", () => {
    for (const cell of ["01.10–05.10", "1.10–31.12", "2024–2025", "$40–€80", "40 USD–80 EUR", "40–80 ± 5", "40-80", "soon", "40–"]) {
      expect({ cell, v: readIntervalCell(cell, {}) }).toEqual({ cell, v: null });
    }
    // A sign or unit makes it money, not a date span.
    expect(readIntervalCell("$2024–2025", {})?.hi).toBe(2025);
    expect(readIntervalCell("1.5–2.5", {})?.lo).toBe(1.5);
  });

  test("the plan cost table draws as it stands: a bold total, a bold value, below the parts", () => {
    const r = model(
      range(
        [
          ["P1 — chart kinds", "$120–220", "the size of #724"],
          ["P2 — lint", "$100–180", "one muninn PR"],
          ["**Slate**", "**$330–670**", ""],
        ],
        ["Slice", "Interval", "Basis"],
      ),
      "range",
    );
    expect(r.rows.map((x) => [x.label, x.value.lo, x.value.hi, x.total])).toEqual([
      ["P1 — chart kinds", 120, 220, false],
      ["P2 — lint", 100, 180, false],
      ["Slate", 330, 670, true],
    ]);
    expect(range([["a", "$1–2"]]).findings).toEqual([]);
  });

  test("findings: a low end above the high end is fatal, mixed signs warn, an unreadable cell is fatal", () => {
    const flipped = range([["a", "$80–40"]]);
    expect(flipped.findings).toEqual([{ message: 'row "a": the low end of $80–40 is above its high end', row: 0, fatal: true }]);
    expect(flipped.model).toBeNull();
    const mixed = range([["a", "$1–2"], ["b", "3–4"], ["c", "€5–6"]]);
    expect(mixed.findings).toEqual([{ message: 'row "c": € differs from $ in row "a"', row: 2, fatal: false }]);
    expect(mixed.model?.kind).toBe("range");
    const bad = range([["a", "$1–2"], ["b", "01.10–05.10"]]);
    expect(bad.findings).toEqual([{ message: 'row "b": "01.10–05.10" in Interval is not a number or a range', row: 1, fatal: true }]);
    expect(range([["a", ""]]).findings.map((f) => f.message)).toEqual(['row "a": the Interval cell is empty']);
  });
});

describe("bars and range cells", () => {
  const read = (kind: "bars" | "range", cells: string[]) => chart(`<Chart kind="${kind}" value="V">`, ["Row", "V"], cells.map((c, i) => [`r${i}`, c]));
  const ends = (r: ChartRead) => {
    const m = r.model;
    if (m?.kind === "range") return m.rows.map((x) => [x.value.lo, x.value.hi]);
    if (m?.kind === "bars") return m.rows.map((x) => x.value.n);
    return null;
  };

  test("a decimal comma behind a sign or inside an interval sets the table's context", () => {
    expect(ends(read("range", ["1,250–1,750", "0,5–1,5"]))).toEqual([[1.25, 1.75], [0.5, 1.5]]);
    const one = read("range", ["1,250–1,5"]);
    expect(one.findings).toEqual([]);
    expect(ends(one)).toEqual([[1.25, 1.5]]);
    const bars = read("bars", ["$1,5", "$1,250"]);
    expect(ends(bars)).toEqual([1.5, 1.25]);
    expect(bars.model?.kind === "bars" && bars.model.log).toBe(false);
  });

  test("dates, months, clock times and years read in neither kind", () => {
    const spans = ["10.2024–12.2024", "01.25–03.25", "09.00–11.30", "20.06–20.25", "09.52–09.53", "00.00–00.04"];
    for (const cell of spans) expect({ cell, m: read("range", [cell]).model }).toEqual({ cell, m: null });
    for (const kind of ["bars", "range"] as const) {
      for (const cells of [["2024"], ["01.10"], ["03.07"], ["18.09"], ["10.2024"], ["12.30"], ["18.09", "03.07"], ["2024", "2025"]]) {
        expect({ kind, cells, m: read(kind, cells).model }).toEqual({ kind, cells, m: null });
      }
      // A leading zero or MM.YYYY is a date in any column; a whole column of date shapes is named.
      for (const cells of [["01.10", "5"], ["10.2024", "5"]]) expect({ kind, cells, m: read(kind, cells).model }).toEqual({ kind, cells, m: null });
      expect(messages(read(kind, ["18.09", "2024"]))).toEqual(["V holds dates, times or years, not numbers"]);
    }
    expect(read("range", ["09.00–11.30", "5"]).model).toBeNull();
  });

  test("numbers that only look like dates still read", () => {
    expect(ends(read("range", ["1.5–2.5", "0.5"]))).toEqual([[1.5, 2.5], [0.5, 0.5]]);
    expect(ends(read("range", ["$2024–2025"]))).toEqual([[2024, 2025]]);
    expect(ends(read("bars", ["0.5", "1.10"]))).toEqual([0.5, 1.1]);
    expect(ends(read("bars", ["12.50", "15.75"]))).toEqual([12.5, 15.75]);
    expect(ends(read("bars", ["2048", "150"]))).toEqual([2048, 150]);
    expect(ends(read("bars", ["2024 kr"]))).toEqual([2024]);
  });

  test("`≈` and `ca.` read as `~` does", () => {
    const cases: [string, number, number, string, string][] = [
      ["≈ $40–80", 40, 80, "$", ""],
      ["≈$1–3", 1, 3, "$", ""],
      ["ca. $70–140", 70, 140, "$", ""],
      ["Ca.$105–220", 105, 220, "$", ""],
      ["CA. 1 min", 1, 1, "", "min"],
      ["ca. 40 – ca. 80", 40, 80, "", ""],
    ];
    for (const [cell, lo, hi, sign, unit] of cases) {
      const v = readIntervalCell(cell, {});
      expect({ cell, v: v && [v.lo, v.hi, v.sign, v.unit] }).toEqual({ cell, v: [lo, hi, sign, unit] });
    }
    expect(ends(read("bars", ["≈ $16", "ca. $20", "~$5"]))).toEqual([16, 20, 5]);
  });
});

describe("bars and range totals", () => {
  const totals = (kind: "bars" | "range", labels: string[]) => {
    const m = chart(`<Chart kind="${kind}" value="V">`, ["Row", "V"], labels.map((l, i) => [l, `${i + 1}`])).model;
    return m?.kind === kind ? m.rows.map((r) => [r.label, r.total]) : null;
  };

  test("only the trailing run of bold rows is the total, after at least one ordinary row", () => {
    for (const kind of ["bars", "range"] as const) {
      expect(totals(kind, ["a", "**Slate**", "c"])).toEqual([["a", false], ["Slate", false], ["c", false]]);
      expect(totals(kind, ["a", "**Sub**", "b", "**Total**", "**Grand**"])).toEqual([["a", false], ["Sub", false], ["b", false], ["Total", true], ["Grand", true]]);
      expect(totals(kind, ["**A**", "**B**"])).toEqual([["A", false], ["B", false]]);
    }
  });

  test("a label is bold only when one bold span covers all of it", () => {
    expect(totals("range", ["a", "**a** and **b**"])).toEqual([["a", false], ["a and b", false]]);
    expect(totals("range", ["a", "**Sl**ate**"])?.[1]?.[1]).toBe(false);
    expect(totals("range", ["a", "__All__"])?.[1]).toEqual(["All", true]);
    expect(totals("range", ["a", "**A**"])?.[1]).toEqual(["A", true]);
  });

  test("a bars total stays out of the log-scale rule", () => {
    const b = model(chart('<Chart kind="bars" value="V">', ["Row", "V"], [["a", "1"], ["b", "50"], ["**Total**", "5000"]]), "bars");
    expect(b.log).toBe(false);
  });
});

describe("range units", () => {
  const range = (cells: string[]) => chart('<Chart kind="range" value="V">', ["Row", "V"], cells.map((c, i) => [`r${i}`, c]));

  test("different trailing units across rows are fatal, a missing unit too", () => {
    expect(messages(range(["82 s", "20 min"]))).toEqual(['row "r1": 82 s and 20 min are not in the same unit']);
    expect(range(["82 s", "20 min"]).model).toBeNull();
    expect(messages(range(["3,5 min", "34 s"]))).toEqual(['row "r1": 3,5 min and 34 s are not in the same unit']);
    expect(messages(range(["~2 h", "5"]))).toEqual(['row "r1": ~2 h and 5 are not in the same unit']);
    expect(range(["1–2 h", "3 h"]).findings).toEqual([]);
  });

  test("a trailing currency is a sign: a different one warns, the same one does not", () => {
    expect(range(["$40–80", "40–80 €"]).findings).toEqual([{ message: 'row "r1": € differs from $ in row "r0"', row: 1, fatal: false }]);
    expect(messages(range(["$40–80", "40–80 EUR"]))).toEqual(['row "r1": EUR differs from $ in row "r0"']);
    expect(range(["$40–80", "40–80 EUR"]).model?.kind).toBe("range");
    expect(range(["$40–80", "40–80 USD"]).findings).toEqual([]);
    expect(range(["40–80 kr", "50 NOK"]).findings).toEqual([]);
  });
});

// The cell-grammar state table (fix round 2): one row per cell shape or column pair, each its own test.
// A row is [id, kind, column cells, the rows drawn ("lo–hi" or "n", null for no chart), the findings].
const GRAMMAR: [string, "bars" | "range", string[], string | null, string[]][] = [
  ["A1", "range", ["$40–80"], "40–80", []],
  ["A1b", "bars", ["$40"], "40", []],
  ["A2", "range", ["€50"], "50–50", []],
  ["A3", "range", ["$40–80","€50–60"], "40–80, 50–60", ["note: row \"r1\": € differs from $ in row \"r0\""]],
  ["A3b", "bars", ["$40","€50"], null, ["fatal: row \"r1\": $40 and €50 are not in the same unit"]],
  ["B1", "range", ["40–80 €"], "40–80", []],
  ["B1b", "bars", ["40 €"], "40", []],
  ["B2", "range", ["$40–80","40–80 €"], "40–80, 40–80", ["note: row \"r1\": € differs from $ in row \"r0\""]],
  ["C1", "range", ["40–80 USD"], "40–80", []],
  ["C2", "range", ["40–80 usd","$1–2"], "40–80, 1–2", []],
  ["C3", "range", ["$40–80","40–80 eur"], "40–80, 40–80", ["note: row \"r1\": eur differs from $ in row \"r0\""]],
  ["C4", "range", ["40–80 kr","50 Kr"], "40–80, 50–50", []],
  ["C5", "range", ["40–80 KR","50 NOK"], "40–80, 50–50", []],
  ["C6", "range", ["40 SEK","50 kr"], "40–40, 50–50", []],
  ["C7", "range", ["40 DKK","50 Kr"], "40–40, 50–50", []],
  ["C8", "range", ["40 CHF","50 chf"], "40–40, 50–50", []],
  ["C9", "range", ["40 SEK","50 kr","60 NOK"], "40–40, 50–50, 60–60", ["note: row \"r1\": kr differs from SEK in row \"r0\"","note: row \"r2\": NOK differs from SEK in row \"r0\""]],
  ["C10", "range", ["22,10 sek","2,55 sek"], "22.1–22.1, 2.55–2.55", []],
  ["C11", "range", ["22,10 sek","40 SEK"], null, ["fatal: row \"r1\": 22,10 sek and 40 SEK are not in the same unit"]],
  ["C12", "bars", ["40 USD","$50"], "40, 50", []],
  ["C13", "bars", ["40 kr","50 Kr","60 NOK"], "40, 50, 60", []],
  ["C14", "bars", ["40 SEK","50 kr"], "40, 50", []],
  ["C15", "bars", ["40 SEK","50 NOK"], null, ["fatal: row \"r1\": 40 SEK and 50 NOK are not in the same unit"]],
  ["D1", "range", ["$40–80 USD","$10–20"], "40–80, 10–20", []],
  ["D2", "range", ["$40–80 EUR"], null, ["fatal: row \"r0\": \"$40–80 EUR\" in V is not a number or a range"]],
  ["D3", "range", ["$40–80 €"], null, ["fatal: row \"r0\": \"$40–80 €\" in V is not a number or a range"]],
  ["D4", "range", ["$40–80","$40–80 EUR"], null, ["fatal: row \"r1\": \"$40–80 EUR\" in V is not a number or a range"]],
  ["D5", "bars", ["$40 EUR"], null, ["fatal: row \"r0\": \"$40 EUR\" in V is not a number"]],
  ["D6", "range", ["€40 eur","€5"], "40–40, 5–5", []],
  ["D7", "bars", ["$40 USD","$5"], "40, 5", []],
  ["E1", "range", ["~$40–80"], "40–80", []],
  ["E2", "range", ["≈ 40–80 €","€1"], "40–80, 1–1", []],
  ["E3", "range", ["ca. 40–80 kr","50 NOK"], "40–80, 50–50", []],
  ["E4", "range", ["Ca. $3–5 USD","$1"], "3–5, 1–1", []],
  ["E5", "range", ["~$40–80 EUR"], null, ["fatal: row \"r0\": \"~$40–80 EUR\" in V is not a number or a range"]],
  ["E6", "range", ["ca. $3–5 hver","$1–2"], "3–5, 1–2", []],
  ["F1", "range", ["$80–150 each","$15–30"], "80–150, 15–30", []],
  ["F2", "range", ["$40–80 hver","$5"], "40–80, 5–5", []],
  ["F3", "range", ["≈ $75 per PR","$10"], "75–75, 10–10", []],
  ["F4", "range", ["$85/PR","$10"], "85–85, 10–10", []],
  ["F5", "range", ["$40 total","$5"], "40–40, 5–5", []],
  ["F6", "range", ["$2 per session","$1–3"], "2–2, 1–3", []],
  ["F7", "bars", ["$80 each","$15"], "80, 15", []],
  ["F8", "range", ["40–80 EUR each","€5"], "40–80, 5–5", []],
  ["F9", "range", ["40 each","50 each"], "40–40, 50–50", []],
  ["F10", "range", ["40 each","50"], null, ["fatal: row \"r1\": 40 each and 50 are not in the same unit"]],
  ["F11", "range", ["40 per PR"], null, ["fatal: row \"r0\": \"40 per PR\" in V is not a number or a range"]],
  ["F12", "range", ["40/PR"], null, ["fatal: row \"r0\": \"40/PR\" in V is not a number or a range"]],
  ["F13", "range", ["$1.25 / $10.00 per 1M"], null, ["fatal: row \"r0\": \"$1.25 / $10.00 per 1M\" in V is not a number or a range"]],
  ["F14", "bars", ["≈ $75 per PR","$85/PR"], "75, 85", []],
  ["F15", "bars", ["$40 EUR each"], null, ["fatal: row \"r0\": \"$40 EUR each\" in V is not a number"]],
  ["G1", "range", ["1 økt","3 økter"], "1–1, 3–3", []],
  ["G2", "range", ["1 session","2 sessions"], "1–1, 2–2", []],
  ["G3", "range", ["1 day","3 days"], "1–1, 3–3", []],
  ["G4", "range", ["1 h","2 h"], "1–1, 2–2", []],
  ["G5", "range", ["1 dag","3–4 dager"], "1–1, 3–4", []],
  ["G6", "range", ["1 time","3 timer"], "1–1, 3–3", []],
  ["G7", "range", ["1 PR","3 PRs"], "1–1, 3–3", []],
  ["G8", "range", ["5 m","5 ms"], null, ["fatal: row \"r1\": 5 m and 5 ms are not in the same unit"]],
  ["G9", "bars", ["1 økt","3 økter"], "1, 3", []],
  ["G10", "bars", ["3 sessions","1 session"], "3, 1", []],
  ["H1", "range", ["82 s","20 min"], null, ["fatal: row \"r1\": 82 s and 20 min are not in the same unit"]],
  ["H2", "range", ["~1 day","~2.3 h"], null, ["fatal: row \"r1\": ~1 day and ~2.3 h are not in the same unit"]],
  ["H3", "range", ["$185","11 h"], null, ["fatal: row \"r1\": $185 and 11 h are not in the same unit"]],
  ["H4", "range", ["3,5 min","34 s"], null, ["fatal: row \"r1\": 3,5 min and 34 s are not in the same unit"]],
  ["H5", "bars", ["82 s","20 min"], null, ["fatal: row \"r1\": 82 s and 20 min are not in the same unit"]],
  ["H6", "bars", ["$185","11 h"], null, ["fatal: row \"r1\": $185 and 11 h are not in the same unit"]],
  ["I1", "range", ["5","5 merges"], null, ["fatal: row \"r1\": 5 and 5 merges are not in the same unit"]],
  ["I2", "range", ["21","18 days"], null, ["fatal: row \"r1\": 21 and 18 days are not in the same unit"]],
  ["I3", "range", ["40 %","5"], null, ["fatal: row \"r1\": 40 % and 5 are not in the same unit"]],
  ["I4", "range", ["$40–80","5"], "40–80, 5–5", []],
  ["I5", "bars", ["$40","5"], null, ["fatal: row \"r1\": $40 and 5 are not in the same unit"]],
  ["I6", "bars", ["5","5 merges"], null, ["fatal: row \"r1\": 5 and 5 merges are not in the same unit"]],
  ["J1", "bars", ["$40 ± 5","$50"], "40, 50", []],
  ["J2", "bars", ["40 h ± 5","50 h"], "40, 50", []],
  ["J3", "range", ["40 ± 5"], null, ["fatal: row \"r0\": \"40 ± 5\" in V is not a number or a range"]],
  ["J4", "bars", ["$40 ± 5 USD"], null, ["fatal: row \"r0\": \"$40 ± 5 USD\" in V is not a number"]],
  ["K1", "range", ["kr 40–80"], null, ["fatal: row \"r0\": \"kr 40–80\" in V is not a number or a range"]],
  ["K2", "bars", ["NOK 40"], null, ["fatal: row \"r0\": \"NOK 40\" in V is not a number"]],
  ["L1", "range", ["01.10–05.10 kr"], "1.1–5.1", []],
  ["L2", "range", ["09.00–11.30 %"], "9–11.3", []],
  ["L3", "range", ["$1,250–$1,750","$0,5–$1,5"], "1.25–1.75, 0.5–1.5", []],
  ["L4", "range", ["40–80 SEK","1 sek"], null, ["fatal: row \"r1\": 40–80 SEK and 1 sek are not in the same unit"]],
  ["M1", "range", ["40 USD–80 EUR"], null, ["fatal: row \"r0\": \"40 USD–80 EUR\" in V is not a number or a range"]],
  ["M2", "range", ["$40–€80"], null, ["fatal: row \"r0\": \"$40–€80\" in V is not a number or a range"]],
];

describe("bars and range cell grammar", () => {
  for (const [id, kind, cells, drawn, findings] of GRAMMAR) {
    test(`${id} ${kind}: ${cells.join(" / ")}`, () => {
      const r = chart(`<Chart kind="${kind}" value="V">`, ["Row", "V"], cells.map((c, i) => [`r${i}`, c]));
      const m = r.model;
      const got = m?.kind === "range" ? m.rows.map((x) => `${x.value.lo}–${x.value.hi}`).join(", ") : m?.kind === "bars" ? m.rows.map((x) => `${x.value.n}`).join(", ") : null;
      expect({ drawn: got, findings: r.findings.map((f) => `${f.fatal ? "fatal" : "note"}: ${f.message}`) }).toEqual({ drawn, findings });
    });
  }
});

describe("bars ±", () => {
  test("a value cell may carry ± n, as in the other kinds", () => {
    const b = model(chart('<Chart kind="bars" value="V">', ["Row", "V"], [["a", "5 ± 1"], ["b", "6 ± 2 (D3)"], ["c", "1,5 ± 0,5"]]), "bars");
    expect(b.rows.map((r) => [r.value.n, r.value.text, r.value.pm, r.value.ids])).toEqual([
      [5, "5", "1", []],
      [6, "6", "2", ["D3"]],
      [1.5, "1,5", "0,5", []],
    ]);
    const signed = model(chart('<Chart kind="bars" value="V">', ["Row", "V"], [["a", "$5 ± 1"], ["b", "~$7"]]), "bars");
    expect(signed.rows.map((r) => [r.value.n, r.value.text, r.value.pm])).toEqual([[5, "$5", "1"], [7, "~$7", null]]);
    expect(messages(chart('<Chart kind="bars" value="V">', ["Row", "V"], [["a", "5 ± x"]]))).toEqual(['row "a": "5 ± x" in V is not a number']);
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
