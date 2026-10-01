import { test, expect, describe } from "bun:test";
import { parseBlocks, type Block } from "./markdown-ast.ts";
import { computeDelta, deltaGrid, parseDeltaAttrs, stripEmphasis } from "./delta-table.ts";
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

  test("better takes lower or higher in any case; anything else is none, with a warning", () => {
    expect(parseDeltaAttrs({ src: " r.csv ", better: "Lower" })).toEqual({ src: "r.csv", better: "lower", rows: null, warning: "" });
    expect(parseDeltaAttrs({ better: "less" })).toMatchObject({ src: "", better: "", rows: null });
    expect(parseDeltaAttrs({ better: "less" }).warning).toContain("Unknown better value: less");
    expect(parseDeltaAttrs({})).toEqual({ src: "", better: "", rows: null, warning: "" });
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
      '<th scope="col" class="dt-delta">Δ <span class="dt-delta-runs">08.09 → 18.09</span><span class="dt-delta-dir">lower is better</span></th>',
    );
    expect(html).toContain(
      '<tr><th scope="row">Kandidater</th><td class="dt-run">140</td><td class="dt-run">132</td><td class="dt-run">16</td>' +
        '<td class="dt-delta dt-good"><span class="dt-mark" role="img" aria-label="better">✓</span> <span class="dt-abs">-116</span> <span class="dt-pct">(-87.9%)</span></td></tr>',
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
    expect(html).toContain(
      '<td class="dt-delta dt-good"><span class="dt-mark" role="img" aria-label="better">✓</span> <span class="dt-abs">+45</span> <span class="dt-pct">(+9.8%)</span></td>',
    );
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
    expect(formatSlackMrkdwn(md)).toBe("Table: `&lt;r&gt;.csv`");
    expect(formatEmailHtml(md)).toContain("Table: &lt;r&gt;.csv");
  });

  test("a pipe-table body renders as the surface's table", () => {
    const md = "<DeltaTable>\n\n| A | x | y |\n|---|---|---|\n| a | 1 | 2 |\n\n</DeltaTable>";
    expect(formatTelegramHtml(md)).toContain("a");
    expect(formatEmailHtml(md)).toContain("<table");
  });
});

/** The delta cells of a rendered table, as `[class, text]` with tags dropped. */
const deltaCells = (html: string) =>
  [...html.matchAll(/<td class="(dt-delta[^"]*)"[^>]*>([\s\S]*?)<\/td>/g)].map((m) => [m[1]!, m[2]!.replace(/<[^>]+>/g, "")]);
const pipe = (rows: string[], attrs = "") =>
  formatWebHtml([`<DeltaTable${attrs}>`, "", ...rows, "", "</DeltaTable>"].join("\n"));

describe("fix round 1: numbers read in the table's context", () => {
  test("a 0,ddd cell is a decimal, so 0,125 → 0,250 is +0,125", () => {
    expect(deltaCells(fromCsv('T,a,b\nX,"0,125","0,250"\n'))).toEqual([["dt-delta", "+0,125 (+100,0%)"]]);
  });

  test("a d,ddd cell in a table that writes decimal commas is a decimal", () => {
    expect(deltaCells(pipe(["| T | a | b |", "|---|---|---|", "| X | 1,250 sek | 0,980 sek |"]))).toEqual([
      ["dt-delta", "-0,270 sek (-21,6%)"],
    ]);
    expect(deltaCells(pipe(["| T | a | b |", "|---|---|---|", "| X | 22,10 | 22,100 |"]))).toEqual([["dt-delta dt-flat", "0,000 (0,0%)"]]);
  });

  test("an English table keeps 1,500 as thousands", () => {
    expect(deltaCells(fromCsv('T,a,b\nX,"1,500","1,750"\nY,2,3\n'))).toEqual([
      ["dt-delta", "+250 (+16.7%)"],
      ["dt-delta", "+1 (+50.0%)"],
    ]);
  });

  test("the percent separator follows the table: a comma table writes commas in every row", () => {
    expect(deltaCells(pipe(["| T | a | b |", "|---|---|---|", "| Tid | 22,10 | 27,81 |", "| Antall | 459 | 504 |"]))).toEqual([
      ["dt-delta", "+5,71 (+25,8%)"],
      ["dt-delta", "+45 (+9,8%)"],
    ]);
  });

  test("a decimal comma in either cell gives a comma: 9 → 9,5 is +0,5", () => {
    expect(computeDelta("9", "9,5", "")).toEqual({ abs: "+0,5", pct: "+5,6%", tone: "" });
  });
});

describe("fix round 1: the grid", () => {
  test("columns empty in every row, header included, are dropped before the last two runs are chosen", () => {
    expect(deltaCells(fromCsv("T,a,b,\nX,1,2,\nY,3,5,\n"))).toEqual([
      ["dt-delta", "+1 (+100.0%)"],
      ["dt-delta", "+2 (+66.7%)"],
    ]);
    // One row with a trailing comma widens the file by an empty column.
    expect(deltaCells(fromCsv("T,a,b\nX,1,2,\nY,3,5\n"))).toEqual([
      ["dt-delta", "+1 (+100.0%)"],
      ["dt-delta", "+2 (+66.7%)"],
    ]);
  });

  test("a row wider than the header gets no delta and a visible marker", () => {
    const csv = deltaCells(fromCsv("T,a,b\nX,1,2,9\nY,3,5\n"));
    expect(csv[0]![0]).toBe("dt-delta dt-overflow");
    expect(csv[0]![1]).toBe("more cells than the header");
    expect(csv[1]).toEqual(["dt-delta", "+2 (+66.7%)"]);
    const esc = deltaCells(pipe(["| T | a | b |", "|---|---|---|", "| a \\| b | 1 | 2 |", "| c | 1 | 2 |"]));
    expect(esc[0]).toEqual(["dt-delta dt-overflow", "more cells than the header"]);
    expect(esc[1]).toEqual(["dt-delta", "+1 (+100.0%)"]);
  });

  test("the pipe-body table renders exactly once", () => {
    const html = pipe(["Intro.", "", "| T | a | b |", "|---|---|---|", "| X | 1 | 2 |"]);
    expect(html.match(/<table/g)).toHaveLength(1);
  });
});

describe("fix round 1: cell shapes", () => {
  test("an exponent change that rounds to 0 at its decimals still shows, and is not flat", () => {
    expect(computeDelta("1e-7", "2e-7", "lower")).toEqual({ abs: "+1e-7", pct: "+100.0%", tone: "bad" });
    expect(computeDelta("2e-7", "2e-7", "lower")).toEqual({ abs: "0", pct: "0.0%", tone: "flat" });
  });

  test("a bold pipe-body cell keeps its delta and renders as authored", () => {
    const html = pipe(["| T | a | b |", "|---|---|---|", "| **Sum** | **1848** | **1804** |"]);
    expect(html).toContain('<td class="dt-run"><strong>1804</strong></td>');
    expect(deltaCells(html)).toEqual([["dt-delta", "-44 (-2.4%)"]]);
    expect(deltaCells(pipe(["| T | a | b |", "|---|---|---|", "| x | __3__ | *4* |"]))).toEqual([["dt-delta", "+1 (+33.3%)"]]);
  });

  test("a glued % reads as a unit; a % delta is in percentage points", () => {
    expect(computeDelta("12%", "15%", "")).toEqual({ abs: "+3 pp", pct: "+25.0%", tone: "" });
    expect(computeDelta("12 %", "11,5 %", "")).toEqual({ abs: "-0,5 pp", pct: "-4,2%", tone: "" });
  });
});

describe("fix round 1: better", () => {
  const RUNS = "Teller,a,b\nKandidater,132,16\nMetadatafeil,9,10\nUten treff,322,330\n";

  test("a per-row list colours only the rows it names, matched trimmed, case-insensitive, past emphasis", () => {
    const cells = deltaCells(fromCsv(RUNS, ' better="metadatafeil=lower;  **KANDIDATER** = higher"'));
    expect(cells.map((c) => c[0])).toEqual(["dt-delta dt-bad", "dt-delta dt-bad", "dt-delta"]);
  });

  test("a per-row label matches a code-span row label", () => {
    const html = pipe(["| T | a | b |", "|---|---|---|", "| `antallUtenTreff` | 322 | 355 |"], ' better="antallUtenTreff=lower"');
    expect(deltaCells(html)[0]![0]).toBe("dt-delta dt-bad");
  });

  test("an unknown better value is a warning line, not silently no tone", () => {
    const html = fromCsv(RUNS, ' better="lavere"');
    expect(html).toContain('<p class="dt-warning">Unknown better value: lavere');
    expect(deltaCells(html).map((c) => c[0])).toEqual(["dt-delta", "dt-delta", "dt-delta"]);
    expect(fromCsv(RUNS, ' better="Kandidater=lavere"')).toContain('<p class="dt-warning">Unknown better value: Kandidater=lavere');
  });

  test("a toned delta carries a marker with an accessible name; the Δ header names the direction", () => {
    const html = fromCsv(RUNS, ' better="lower"');
    expect(html).toContain('<td class="dt-delta dt-good"><span class="dt-mark" role="img" aria-label="better">✓</span> <span class="dt-abs">-116</span>');
    expect(html).toContain('<td class="dt-delta dt-bad"><span class="dt-mark" role="img" aria-label="worse">✗</span> <span class="dt-abs">+1</span>');
    expect(html).toContain('<span class="dt-delta-dir">lower is better</span>');
    expect(fromCsv(RUNS, ' better="higher"')).toContain('<span class="dt-delta-dir">higher is better</span>');
    expect(fromCsv(RUNS, ' better="Kandidater=lower"')).toContain('<span class="dt-delta-dir">✓ better, ✗ worse — per row</span>');
    expect(fromCsv(RUNS)).not.toContain("dt-delta-dir");
  });
});

describe("fix round 1: counts and files", () => {
  test("the truncation line and the row count share one formatter", () => {
    const csv = "T,a,b\n" + Array.from({ length: QUERY_CSV_MAX_ROWS + 3 }, (_, i) => `r${i},1,2`).join("\n");
    expect(fromCsv(csv)).toContain("showing 2,000 of 2,003 rows");
  });

  test("a DeltaTable src must be a .csv", () => {
    const html = formatWebHtml('<DeltaTable src="cases.yaml" />', { files: files({ "cases.yaml": { ok: true, text: "- id: A\n" } }) });
    expect(html).toContain("File type not allowed: cases.yaml");
    expect(html).not.toContain("<table");
  });
});

describe("fix round 2: the grid keeps every column that holds a value", () => {
  test("a blank header cell over a value keeps its column, and the delta", () => {
    const html = pipe(["| Teller | 18.09 |  |", "|---|---|---|", "| A | 1 | 2 |"]);
    expect(html).toContain('<td class="dt-run">2</td>');
    expect(html).not.toContain("Two runs are needed");
    expect(deltaCells(html)).toEqual([["dt-delta", "+1 (+100.0%)"]]);
  });

  test("the over-long-row marker renders when the table has no delta column", () => {
    const html = fromCsv("T,a\nX,1,9\nY,2\n");
    expect(html).toContain("Two runs are needed");
    expect(deltaCells(html)).toEqual([
      ["dt-delta dt-overflow", "more cells than the header"],
      ["dt-delta dt-none", ""],
    ]);
  });

  test("a column blank in the header and every row is dropped", () => {
    const html = fromCsv("T,a,b,\nX,1,2,\n");
    expect(html.match(/<th scope="col" class="dt-run">/g)).toHaveLength(2);
  });

  test("a run column with a header and no value in any row renders, and the delta skips it", () => {
    const future = pipe(["| T | a | b | 29.10 |", "|---|---|---|---|", "| X | 1 | 2 | |", "| Y | 4 | 5 | |"]);
    expect(future).toContain('<th scope="col" class="dt-run">29.10</th>');
    expect(future).toContain('<span class="dt-delta-runs">a → b</span>');
    expect(deltaCells(future)).toEqual([
      ["dt-delta", "+1 (+100.0%)"],
      ["dt-delta", "+1 (+25.0%)"],
    ]);
    const middle = pipe(["| T | a | mid | b |", "|---|---|---|---|", "| X | 1 | | 3 |"]);
    expect(middle).toContain('<span class="dt-delta-runs">a → b</span>');
    expect(deltaCells(middle)).toEqual([["dt-delta", "+2 (+200.0%)"]]);
  });
});

describe("fix round 2: each row is read in its own decimal context", () => {
  test("a 1,309 count beside a decimal-comma row stays a count; percents still write commas", () => {
    const html = pipe([
      "| Teller | a | b |",
      "|---|---:|---:|",
      "| `antallUtenTreff` | 1,309 | 1,344 |",
      "| Varighet | 81,38 sek | 82,00 sek |",
    ]);
    expect(deltaCells(html)).toEqual([
      ["dt-delta", "+35 (+2,7%)"],
      ["dt-delta", "+0,62 sek (+0,8%)"],
    ]);
  });

  test("the context is read through a cell's emphasis", () => {
    expect(deltaCells(pipe(["| T | a | b |", "|---|---|---|", "| X | **0,5** | 1,500 |"]))).toEqual([["dt-delta", "+1,000 (+200,0%)"]]);
  });

  test("the label column gives no context", () => {
    expect(deltaCells(fromCsv('T,a,b\n"0,5","1,500","1,750"\n'))).toEqual([["dt-delta", "+250 (+16.7%)"]]);
  });

  test("a glued % is read in the row's context", () => {
    expect(deltaCells(pipe(["| T | x | a | b |", "|---|---|---|---|", "| X | 0,5 | 1,250% | 1,500% |"]))).toEqual([
      ["dt-delta", "+0,250 pp (+20,0%)"],
    ]);
  });
});

describe("fix round 2: per-row better labels", () => {
  const RUNS = "Teller,a,b\nKandidater,132,16\nMetadatafeil,9,10\n";

  test("a label that matches no row is a warning naming it", () => {
    expect(fromCsv(RUNS, ' better="Kandidatr=lower"')).toContain('<p class="dt-warning">better names no row: Kandidatr</p>');
    expect(fromCsv(RUNS, ' better="Kandidater=lower"')).not.toContain("dt-warning");
  });

  test("a label given twice is a warning", () => {
    expect(fromCsv(RUNS, ' better="Kandidater=lower; kandidater=higher"')).toContain(
      '<p class="dt-warning">better names a row more than once: kandidater</p>',
    );
  });

  test("a label may hold =: the direction is after the last one", () => {
    expect(deltaCells(fromCsv("T,a,b\na=b,1,2\n", ' better="a=b=lower"'))).toEqual([["dt-delta dt-bad", "✗ +1 (+100.0%)"]]);
  });

  test("labels match in NFC: a decomposed label matches a composed row", () => {
    const cells = deltaCells(fromCsv("T,a,b\nÅrsak,1,2\n", ' better="Årsak=lower"'));
    expect(cells).toEqual([["dt-delta dt-bad", "✗ +1 (+100.0%)"]]);
  });
});

describe("fix round 2: emphasis", () => {
  test("_5_ is read like *5*", () => {
    expect(stripEmphasis("_5_")).toBe("5");
    expect(deltaCells(pipe(["| T | a | b |", "|---|---|---|", "| x | _3_ | 4 |"]))).toEqual([["dt-delta", "+1 (+33.3%)"]]);
  });
});

describe("fix round 2: text surfaces", () => {
  test("Slack: a file name holding a backtick falls back to the literal line", () => {
    expect(formatSlackMrkdwn('<DeltaTable src="a`b.csv" />')).toBe("Table: aˋb.csv");
  });
});
