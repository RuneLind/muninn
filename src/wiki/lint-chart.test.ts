import { describe, expect, test } from "bun:test";
import { checkCharts } from "./lint-chart.ts";
import { checkComponents } from "./lint-components.ts";
import { checkPageText } from "./lint.ts";

// Invented pages only.

const page = { relPath: "plans/c.mdx" };
const lint = (lines: string[]) => checkCharts(page, lines.join("\n")).map((f) => [f.line, f.severity ?? "warning", f.message]);

describe("lint check 17 (chart-table)", () => {
  test("a finding sits on its row's line, for two charts on one page", () => {
    expect(
      lint([
        "---", // 1
        "title: C", // 2
        "---", // 3
        '<Chart kind="funnel" caption="First">', // 4
        "", // 5
        "| Step | Count | Of |", // 6
        "|---|---|---|", // 7
        "| all | 8 | |", // 8
        "| kept | 9 | 8 |", // 9
        "", // 10
        "</Chart>", // 11
        "", // 12
        '<Chart kind="gap" value="Now" target="Goal" gap="Gap">', // 13
        "", // 14
        "| Item | Now | Goal | Gap |", // 15
        "|---|---|---|---|", // 16
        "| a | 1 | 4 | 3 |", // 17
        "| b | 1 | 4 | 2 |", // 18
        "", // 19
        "</Chart>", // 20
      ]),
    ).toEqual([
      [9, "warning", '<Chart kind="funnel" caption="First"> row "kept": 9 is larger than its parent 8; it renders as its table'],
      [18, "info", '<Chart kind="gap"> row "b": the gap cell says 2, but Goal − Now is 3'],
    ]);
  });

  test("a table-shaped line in a fence before the table does not move the line", () => {
    expect(
      lint([
        '<Chart kind="funnel">', // 1
        "", // 2
        "```", // 3
        "| not | the | table |", // 4
        "```", // 5
        "", // 6
        "| Step | Count | Of |", // 7
        "|---|---|---|", // 8
        "| all | -1 | |", // 9
        "", // 10
        "</Chart>", // 11
      ]),
    ).toEqual([[9, "warning", '<Chart kind="funnel"> row "all": a count is negative; it renders as its table']]);
  });

  test("a whole-chart finding sits on the tag line", () => {
    expect(lint(["Intro.", "", '<Chart kind="gap" value="Now">', "", "| Item | Now |", "|---|---|", "| a | 1 |", "", "</Chart>"])).toEqual([
      [3, "warning", '<Chart kind="gap"> needs target= naming a column; it renders as its table'],
      [3, "warning", '<Chart kind="gap"> needs gap= naming a column; it renders as its table'],
    ]);
  });

  test("a chart inside a fence is no chart", () => {
    expect(lint(["```", '<Chart kind="gap">', "", "| a |", "|---|", "| 1 |", "", "</Chart>", "```"])).toEqual([]);
  });

  test("a mis-cased or missing kind is check 15's, not this check's", () => {
    const text = (open: string) => [open, "", "| Item | Now |", "|---|---|", "| a | 1 |", "", "</Chart>"].join("\n");
    for (const open of ['<Chart kind="Gap">', "<Chart>"]) {
      expect(checkCharts(page, text(open))).toEqual([]);
      expect(checkComponents(page.relPath, text(open)).map((f) => f.message)).toEqual([
        open === "<Chart>" ? "Chart has no kind; it renders as its table" : 'Chart kind="Gap" is not a chart kind; it renders as its table',
      ]);
    }
  });

  test("checkPageText runs it on an .mdx page that is not culled", () => {
    const text = ['<Chart kind="funnel">', "", "| Step | Count |", "|---|---|", "| all | 8 |", "", "</Chart>"].join("\n");
    expect(checkPageText({ relPath: "plans/c.mdx" }, text, []).filter((f) => f.check === "chart-table")).toHaveLength(1);
    expect(checkPageText({ relPath: "plans/c.mdx", culled: true }, text, []).filter((f) => f.check === "chart-table")).toEqual([]);
  });
});
