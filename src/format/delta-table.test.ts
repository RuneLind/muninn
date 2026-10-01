import { test, expect, describe } from "bun:test";
import { parseBlocks, type Block } from "./markdown-ast.ts";
import { computeDelta, deltaGrid, parseDeltaAttrs } from "./delta-table.ts";
import { parseCellNumberParts, parseCellValue } from "./cell-number.ts";
import { QUERY_CSV_MAX_ROWS, type PageFileResult } from "./query-block.ts";
import { formatWebHtml } from "../web/web-format.ts";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { formatSlackMrkdwn } from "../slack/slack-format.ts";
import { formatEmailHtml } from "./email-format.ts";

const files = (entries: Record<string, PageFileResult>) => new Map(Object.entries(entries));
const fromCsv = (csv: string, attrs = "") =>
  formatWebHtml(`<DeltaTable src="r/runs.csv"${attrs} />`, { files: files({ "r/runs.csv": { ok: true, text: csv } }) });

describe("the shared number reading", () => {
  test("decimals and the decimal mark come from what was written", () => {
    expect(parseCellNumberParts("22,10")).toEqual({ n: 22.1, decimals: 2, decimalComma: true });
    expect(parseCellNumberParts("27.81")).toEqual({ n: 27.81, decimals: 2, decimalComma: false });
    expect(parseCellNumberParts("1 500,5")).toEqual({ n: 1500.5, decimals: 1, decimalComma: true });
    // Comma thousands: the comma is not a decimal mark.
    expect(parseCellNumberParts("1,500")).toEqual({ n: 1500, decimals: 0, decimalComma: false });
    expect(parseCellNumberParts("1,234,567.25")).toEqual({ n: 1234567.25, decimals: 2, decimalComma: false });
    expect(parseCellNumberParts("−42")).toEqual({ n: -42, decimals: 0, decimalComma: false });
    expect(parseCellNumberParts("x")).toBeNull();
  });

  test("a unit is read off the end, the number before it as above", () => {
    expect(parseCellValue("22,10 sek")).toEqual({ n: 22.1, decimals: 2, decimalComma: true, unit: "sek" });
    expect(parseCellValue("12 %")).toMatchObject({ n: 12, unit: "%" });
    expect(parseCellValue("ikke i koden")).toBeNull();
  });
});

describe("delta arithmetic", () => {
  test("an increase and a decrease, absolute and in percent of the base", () => {
    expect(computeDelta("459", "504", "")).toEqual({ abs: "+45", pct: "+9.8%", tone: "" });
    expect(computeDelta("132", "16", "")).toEqual({ abs: "-116", pct: "-87.9%", tone: "" });
  });

  test("a negative base: the percent is of its magnitude, so the sign follows the change", () => {
    expect(computeDelta("-4", "-6", "")).toEqual({ abs: "-2", pct: "-50.0%", tone: "" });
    expect(computeDelta("-10", "5", "")).toEqual({ abs: "+15", pct: "+150.0%", tone: "" });
  });

  test("a zero base gives the absolute delta and no percent", () => {
    expect(computeDelta("0", "5", "")).toEqual({ abs: "+5", pct: "", tone: "" });
    expect(computeDelta("0", "0", "")).toEqual({ abs: "0", pct: "", tone: "flat" });
  });

  test("no change is 0 with no sign, and flat whatever better says", () => {
    expect(computeDelta("10", "10", "lower")).toEqual({ abs: "0", pct: "0.0%", tone: "flat" });
    expect(computeDelta("1.50", "1.5", "higher")).toEqual({ abs: "0.00", pct: "0.0%", tone: "flat" });
  });

  test("decimals: the larger of the two cells, no float noise; a decimal comma carries over", () => {
    expect(computeDelta("22,10 sek", "27,81 sek", "")).toEqual({ abs: "+5,71 sek", pct: "+25,8%", tone: "" });
    expect(computeDelta("0.1", "0.3", "")).toEqual({ abs: "+0.2", pct: "+200.0%", tone: "" });
    expect(computeDelta("1,500", "1,750", "")).toEqual({ abs: "+250", pct: "+16.7%", tone: "" });
  });

  test("better colours a change: lower is good when it falls, higher when it rises", () => {
    expect(computeDelta("10", "8", "lower")!.tone).toBe("good");
    expect(computeDelta("10", "12", "lower")!.tone).toBe("bad");
    expect(computeDelta("10", "12", "higher")!.tone).toBe("good");
    expect(computeDelta("10", "8", "higher")!.tone).toBe("bad");
  });

  test("a non-numeric, empty or NULL cell, or two different units, give no delta", () => {
    for (const [a, b] of [["ikke i koden", "132"], ["–", "5"], ["", "1"], ["NULL", "3"], ["2", "null"], ["5 sek", "5 min"], ["5 sek", "6"], ["**5**", "6"]]) {
      expect(computeDelta(a!, b!, "lower")).toBeNull();
    }
  });

  test("better takes lower or higher in any case; anything else is none", () => {
    expect(parseDeltaAttrs({ src: " r.csv ", better: "Lower" })).toEqual({ src: "r.csv", better: "lower" });
    expect(parseDeltaAttrs({ better: "less" })).toEqual({ src: "", better: "" });
  });

  test("rows are padded or cut to the header's width", () => {
    expect(deltaGrid(["a", "b", "c"], [["x"], ["y", "1", "2", "3"]]).rows).toEqual([["x", "", ""], ["y", "1", "2"]]);
  });
});

describe("DeltaTable grammar", () => {
  test("self-closing with src, or paired with a pipe-table body", () => {
    const [a] = parseBlocks('<DeltaTable src="r.csv" better="lower" bogus="x" />') as Extract<Block, { type: "component" }>[];
    expect(a).toMatchObject({ name: "DeltaTable", attrs: { src: "r.csv", better: "lower" }, children: [] });
    const [b] = parseBlocks('<DeltaTable better="higher">\n\n| A | x | y |\n|---|---|---|\n| a | 1 | 2 |\n\n</DeltaTable>') as Extract<
      Block,
      { type: "component" }
    >[];
    expect(b!.children.some((c) => c.type === "table")).toBe(true);
  });
});

describe("DeltaTable on the web", () => {
  test("from a CSV: label column, the runs, and a delta between the last two", () => {
    const html = fromCsv("Teller,07.09,08.09,18.09\nKandidater,140,132,16\n", ' better="lower"');
    expect(html).toContain('<section class="delta-table dt-better-lower">');
    expect(html).toContain(
      '<th scope="col" class="dt-delta">Δ <span class="dt-delta-runs">08.09 → 18.09</span></th>',
    );
    expect(html).toContain(
      '<tr><th scope="row">Kandidater</th><td class="dt-run">140</td><td class="dt-run">132</td><td class="dt-run">16</td>' +
        '<td class="dt-delta dt-good"><span class="dt-abs">-116</span> <span class="dt-pct">(-87.9%)</span></td></tr>',
    );
  });

  test("a non-numeric row gets an empty delta cell; a zero base shows no percent", () => {
    const html = fromCsv("Teller,a,b\nHoppet over,ikke i koden,132\nNye,0,4\n");
    expect(html).toContain('<td class="dt-run">132</td><td class="dt-delta dt-none"></td>');
    expect(html).toContain('<td class="dt-delta"><span class="dt-abs">+4</span></td>');
  });

  test("from a pipe-table body: cells as inline markdown, the rest of the body above the table", () => {
    const html = formatWebHtml(
      ['<DeltaTable better="higher">', "", "Simulering mot simulering.", "", "| Teller | 08.09 | 18.09 |", "|---|---:|---:|", "| `antallInputHendelser` | 459 | 504 |", "", "</DeltaTable>"].join("\n"),
    );
    expect(html.indexOf("Simulering mot simulering.")).toBeLessThan(html.indexOf("<table"));
    expect(html).toContain('<th scope="row"><code>antallInputHendelser</code></th>');
    expect(html).toContain('<td class="dt-delta dt-good"><span class="dt-abs">+45</span> <span class="dt-pct">(+9.8%)</span></td>');
  });

  test("one run: the table renders, no delta column, and says why", () => {
    const html = fromCsv("Teller,08.09\nA,1\n");
    expect(html).not.toContain("dt-delta");
    expect(html).toContain('<p class="dt-note">Two runs are needed for a delta</p>');
  });

  test("every file-derived string is escaped: headers, labels, cells, the delta header", () => {
    const html = fromCsv('"<h>",<a1>,"<b&2>"\n"<img src=x>",<1>,"2 <u>"\n7,<s>1</s>,"3"\n');
    expect(html).not.toMatch(/<h>|<a1>|<b&|<img|<1>|<u>|<s>/);
    expect(html).toContain('<th scope="col">&lt;h&gt;</th>');
    expect(html).toContain('<span class="dt-delta-runs">&lt;a1&gt; → &lt;b&amp;2&gt;</span>');
    expect(html).toContain('<th scope="row">&lt;img src=x&gt;</th><td class="dt-run">&lt;1&gt;</td><td class="dt-run">2 &lt;u&gt;</td>');
  });

  test("a pipe-table cell's raw HTML is escaped too", () => {
    const html = formatWebHtml('<DeltaTable>\n\n| <b>A</b> | x | y |\n|---|---|---|\n| <i>a</i> | 1 | 2 |\n\n</DeltaTable>');
    expect(html).not.toMatch(/<b>|<i>/);
    expect(html).toContain("&lt;i&gt;a&lt;/i&gt;");
  });

  test("the CSV shares the Query caps: at most 2,000 rows, with a line", () => {
    const csv = "T,a,b\n" + Array.from({ length: QUERY_CSV_MAX_ROWS + 3 }, (_, i) => `r${i},1,2`).join("\n");
    const html = fromCsv(csv);
    expect(html.match(/<tr><th scope="row">/g)).toHaveLength(QUERY_CSV_MAX_ROWS);
    expect(html).toContain('<p class="dt-truncated">showing 2,000 of 2,003 rows</p>');
  });

  test("an unreadable file degrades inside the block; no data says so", () => {
    expect(formatWebHtml('Før.\n\n<DeltaTable src="r.csv" />\n\nEtter.', { files: files({ "r.csv": { ok: false, reason: "too-large" } }) })).toMatch(
      /Før\.[\s\S]*<p class="dt-unavailable">File over 1 MB, not shown: r\.csv<\/p>[\s\S]*Etter\./,
    );
    expect(formatWebHtml('<DeltaTable src="r.csv" />')).toContain("Table not loaded here: r.csv");
    expect(formatWebHtml("<DeltaTable>\n\nBare tekst.\n\n</DeltaTable>")).toContain("DeltaTable without src or a table");
    expect(fromCsv("")).toContain("Empty file: runs.csv");
  });
});

describe("DeltaTable on the text surfaces (no file read)", () => {
  test("a src table names the file, escaped", () => {
    const md = '<DeltaTable src="<r>.csv" />';
    expect(formatTelegramHtml(md)).toBe("Table: &lt;r&gt;.csv");
    expect(formatSlackMrkdwn(md)).toBe("Table: &lt;r&gt;.csv");
    expect(formatEmailHtml(md)).toContain("Table: &lt;r&gt;.csv");
  });

  test("a pipe-table body renders as the surface's table", () => {
    const md = "<DeltaTable>\n\n| A | x | y |\n|---|---|---|\n| a | 1 | 2 |\n\n</DeltaTable>";
    expect(formatTelegramHtml(md)).toContain("a");
    expect(formatEmailHtml(md)).toContain("<table");
  });
});
