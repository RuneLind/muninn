import { describe, expect, test } from "bun:test";
import { gateVerdict, leadingNumber, leadingPr, readChart, type ChartTable } from "./chart-block.ts";
import { CHART_CHROME_CLASSES } from "./chart-view.ts";
import { COMPONENT_ATTRS, readChartKind } from "./component-spec.ts";
import { formatWebHtml } from "../web/web-format.ts";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { formatSlackMrkdwn } from "../slack/slack-format.ts";
import { formatEmailHtml } from "./email-format.ts";
import { renderWikiHtml } from "../wiki/render.ts";
import { checkPageText } from "../wiki/lint.ts";
import { PEEK_SKIP, PEEK_STRIP_SELECTOR } from "../dashboard/views/components/wiki-ref-links.ts";
import { COMPONENT_CLASS_ALLOW } from "../chat/views/components/component-class-allow.ts";
import { READER_ONLY_ATTR } from "./reader-lens.ts";

// `<Chart kind="…">` (MDX visual components PR 3): the table read per kind,
// the gate verdict, the reader-only view, the formatters' table-as-written
// and the chart-table lint. Synthetic fixtures only.

const t = (headers: string[], ...rows: string[][]): ChartTable => ({ headers, rows });
const chart = (attrs: string, table: string[]) => [`<Chart ${attrs}>`, "", ...table, "", "</Chart>"].join("\n");

const GAP = chart('kind="gap" value="Now" target="Goal" gap="Gap" caption="Scores"', [
  "| Track | Now | Goal | Gap |",
  "|---|---|---|---|",
  "| Alpha | 40 | 50 | 10 |",
  "| Beta | −0.85 | 1.2 | 2.05 |",
]);
const GATE = chart('kind="gate" bar="Bar" pass="101–160" hold="Hold"', [
  "| PR | Bar | 101–160 | Hold |",
  "|---|---|---|---|",
  "| PR 21 | +5 (D17) | +6.1 | +5.2 |",
  "| 22 — Soft | +5 | +4.05 | +6 |",
]);
const STEPS = chart('kind="steps" x="Step" ref="Base" normalize="ref"', [
  "| Step | A | B |",
  "|---|---|---|",
  "| s1 | 10 | 20 |",
  "| s2 |  | 25 |",
  "| Base | 10 | 20 |",
]);
const FUNNEL = chart('kind="funnel"', [
  "| Stage | Count | Of |",
  "|---|---|---|",
  "| All | 8 501 | |",
  "| Picked | 46 | 8 501 |",
  "| Kept | 3 | 46 |",
]);
const ALL = [GAP, GATE, STEPS, FUNNEL];
const unwrap = (md: string) => md.split("\n").filter((l) => !/^<\/?Chart\b/.test(l)).join("\n");

describe("spec", () => {
  test("Chart lists its attributes and kind parses the four kinds", () => {
    expect(COMPONENT_ATTRS.Chart).toEqual(["kind", "caption", "value", "target", "gap", "mark", "x", "ref", "normalize", "bar", "pass", "hold"]);
    for (const k of ["gap", "steps", "gate", "funnel"]) expect(readChartKind(k).value).toBe(k as never);
    expect(readChartKind("pie").value).toBeNull();
  });
});

describe("cells", () => {
  test("a bar cell reads its leading number and keeps the rest", () => {
    expect(leadingNumber("+10 (D17)")).toEqual({ n: 10, text: "+10", rest: "(D17)" });
    expect(leadingNumber("−0.85")?.n).toBe(-0.85);
    expect(leadingNumber("8 501")?.n).toBe(8501);
    expect(leadingNumber("about 3")).toBeNull();
  });
  test("a PR's number is the first cell's leading integer", () => {
    expect(leadingPr("PR 21")).toBe(21);
    expect(leadingPr("21")).toBe(21);
    expect(leadingPr("21 — Hard congestion")).toBe(21);
    expect(leadingPr("Baseline")).toBeNull();
  });
});

describe("gate verdict", () => {
  const n = (v: number, text = String(v)) => ({ n: v, text });
  test("numbers pass when pass and hold both reach the bar", () => {
    expect(gateVerdict(n(6), n(5), n(5))).toEqual({ pass: true });
  });
  test("numbers miss names the first value under the bar", () => {
    expect(gateVerdict(n(4.05, "+4.05"), n(6), n(5, "+5"))).toEqual({ pass: false, miss: "+4.05 < +5" });
    expect(gateVerdict(n(6), n(4, "+4"), n(5, "+5"))).toEqual({ pass: false, miss: "+4 < +5" });
  });
  test("with no hold column, pass alone decides", () => {
    expect(gateVerdict(n(5), null, n(5)).pass).toBe(true);
  });
});

describe("readChart per kind", () => {
  test("gap: a gap cell that is not target − value warns, the chart still draws", () => {
    const r = readChart("gap", { value: "Now", target: "Goal", gap: "Gap" }, t(["T", "Now", "Goal", "Gap"], ["a", "4", "10", "5"]));
    expect(r.model?.kind).toBe("gap");
    expect(r.findings.map((f) => f.fatal)).toEqual([false]);
    expect(r.findings[0]!.message).toContain("Goal − Now is 6");
  });
  test("gap: a named column missing is fatal", () => {
    const r = readChart("gap", { value: "Now", target: "Target", gap: "Gap" }, t(["T", "Now", "Goal", "Gap"], ["a", "4", "10", "6"]));
    expect(r.model).toBeNull();
    expect(r.findings[0]!.message).toContain('target="Target" names no column');
  });
  test("gate: pass= names a column by its header text, hold= is required, and a non-number is fatal", () => {
    expect(readChart("gate", { bar: "Bar", pass: "101–160", hold: "Hold" }, t(["PR", "Bar", "101–160", "Hold"], ["PR 1", "+5", "+6", "+5"])).model?.kind).toBe("gate");
    const bad = readChart("gate", { bar: "Bar", pass: "101–160", hold: "Hold" }, t(["PR", "Bar", "101–160", "Hold"], ["PR 1", "+5", "n/a", "+5"]));
    expect(bad.model).toBeNull();
    expect(bad.findings[0]!.message).toContain("is not a number");
    expect(readChart("gate", { bar: "Bar", pass: "101–160" }, t(["PR", "Bar", "101–160"], ["PR 1", "+5", "+6"])).findings[0]!.message).toContain("needs hold=");
  });
  test("steps: an empty cell is unchanged, normalize needs a ref row", () => {
    const ok = readChart("steps", { x: "Step", ref: "Base", normalize: "ref" }, t(["Step", "A"], ["s1", "10"], ["s2", ""], ["Base", "10"]));
    expect(ok.model?.kind).toBe("steps");
    const noRef = readChart("steps", { x: "Step", normalize: "ref" }, t(["Step", "A"], ["s1", "10"]));
    expect(noRef.findings[0]!.message).toContain("needs ref=");
    const zero = readChart("steps", { x: "Step", ref: "Base", normalize: "ref" }, t(["Step", "A"], ["s1", "10"], ["Base", "0"]));
    expect(zero.model).toBeNull();
  });

  test("steps: a ref row that opens the table is the first step, the baseline", () => {
    const r = readChart("steps", { x: "Step", ref: "Base", normalize: "ref" }, t(["Step", "A"], ["Base", "10"], ["s1", "12"], ["s2", "15"]));
    expect(r.findings).toEqual([]);
    const m = r.model as { steps: string[]; extras: unknown[] } | null;
    expect(m?.steps).toEqual(["Base", "s1", "s2"]);
    expect(m?.extras).toEqual([]);
  });
  test("funnel: a row larger than its parent is fatal; Av names the parent column too", () => {
    const big = readChart("funnel", {}, t(["Stage", "Count", "Of"], ["All", "10", ""], ["Some", "12", "10"]));
    expect(big.model).toBeNull();
    expect(big.findings[0]!.message).toContain("larger than its parent");
    const no = readChart("funnel", {}, t(["Steg", "Antall", "Av"], ["Alle", "10", ""], ["Noen", "3", "10"]));
    expect(no.model?.kind).toBe("funnel");
  });
  test("no table at all is fatal", () => {
    expect(readChart("gap", {}, null).findings[0]!.fatal).toBe(true);
  });
});

describe("reader view", () => {
  const view = (md: string) => formatWebHtml(md, { views: true, reader: true });
  test("each kind draws on the reader's page render and keeps the table beside it", () => {
    for (const md of ALL) {
      const html = view(md);
      expect(html).toContain('class="vc-chart vc-');
      expect(html).toContain("vc-has-plot");
      expect(html).toContain('<div class="vc-table tablewrap"><table>');
      expect(html).toContain("<svg");
    }
  });
  test("every chrome element is reader-only and none carries the dc-view class a peek skips", () => {
    const html = view(ALL.join("\n\n"));
    for (const cls of CHART_CHROME_CLASSES) {
      for (const m of html.matchAll(new RegExp(`<[a-z]+ class="${cls}[^"]*"([^>]*)>`, "g"))) expect(m[1]).toContain(READER_ONLY_ATTR);
    }
    expect(html).not.toContain("dc-view");
  });
  test("a peek strips the chart chrome and keeps the table", () => {
    for (const cls of CHART_CHROME_CLASSES) expect(PEEK_STRIP_SELECTOR).toContain(`.${cls}`);
    expect(PEEK_STRIP_SELECTOR).not.toContain(".vc-table");
    expect(PEEK_SKIP).not.toContain("vc-chart");
  });
  test("gate: the verdict is numeric, the (D17) id links to its decision", () => {
    const html = view(GATE);
    expect(html).toContain("numbers pass");
    expect(html).toContain("numbers miss: +4.05 &lt; +5");
    expect(html).toContain('<a class="dc-go" href="#d17" data-dc-ref="D17">D17</a>');
  });
  test("gate: a matching ledger row's state shows beside the verdict", () => {
    const page = ["## PR ledger", "", "| PR | State |", "|---|---|", "| 21 | merged |", "| 22 | dropped |", "", GATE].join("\n");
    const html = view(page);
    expect(html).toMatch(/PR 21 <span class="vc-state vc-st-merged">merged<\/span>/);
    expect(html).toMatch(/22 — Soft <span class="vc-state vc-st-dropped">dropped<\/span>/);
  });
  test("gate: with no ledger the verdict stands alone", () => {
    expect(view(GATE)).not.toContain("vc-state");
  });
  test("gap: the % of target variant is offered only when every target is above zero", () => {
    expect(view(GAP)).toContain('data-vc-variant="pct"');
    const neg = GAP.replace("| 50 | 10 |", "| −5 | 10 |");
    expect(view(neg)).not.toContain('data-vc-variant="pct"');
  });
  test("a table that fails its kind renders the table with the finding, never an empty chart", () => {
    const bad = FUNNEL.replace("| Kept | 3 | 46 |", "| Kept | 300 | 46 |");
    const html = view(bad);
    expect(html).toContain("vc-fallback");
    expect(html).not.toContain("<svg");
    expect(html).toContain("larger than its parent");
    expect(html).toContain("<table>");
  });
  test("an unknown kind renders the table with a finding", () => {
    const html = view(GAP.replace('kind="gap"', 'kind="pie"'));
    expect(html).toContain("vc-fallback");
    expect(html).toContain("<table>");
  });
  test("colours are classes over theme tokens, never literals", () => {
    expect(view(ALL.join("\n\n"))).not.toMatch(/(fill|stroke)="#|style="[^"]*(#[0-9a-f]{3}|rgb)/i);
  });
});

describe("off the reader: the table as written", () => {
  test("without views the web render is the bare table, byte for byte", () => {
    for (const md of ALL) expect(formatWebHtml(md)).toBe(formatWebHtml(unwrap(md)));
    for (const md of ALL) expect(formatWebHtml(md, { reader: true })).toBe(formatWebHtml(unwrap(md), { reader: true }));
  });
  test("each formatter prints the table rows verbatim", () => {
    for (const md of ALL) {
      expect(formatTelegramHtml(md)).toBe(formatTelegramHtml(unwrap(md)));
      expect(formatSlackMrkdwn(md)).toBe(formatSlackMrkdwn(unwrap(md)));
      expect(formatEmailHtml(md)).toBe(formatEmailHtml(unwrap(md)));
    }
  });
  test("a <Chart> reaches chat as its table: no svg, no chart class the sanitizer keeps", async () => {
    const html = formatWebHtml(ALL.join("\n\n"));
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("vc-");
    for (const cls of COMPONENT_CLASS_ALLOW) expect(cls.startsWith("vc-")).toBe(false);
    const src = await Bun.file(new URL("../chat/views/components/web-format-browser.ts", import.meta.url)).text();
    const tags = /const WEB_TAGS = \[([\s\S]*?)\];/.exec(src)?.[1] ?? "";
    expect(tags).toContain('"table"');
    expect(tags).not.toContain('"svg"');
  });
  test("renderWikiHtml draws only with views, as GET /api/wiki/page passes it", () => {
    expect(renderWikiHtml(GAP, () => undefined, { views: true })).toContain("vc-chart");
    expect(renderWikiHtml(GAP, () => undefined)).toBe(renderWikiHtml(unwrap(GAP), () => undefined));
  });
});

describe("lint: chart-table via checkPageText, agreeing with the reader", () => {
  const page = (body: string) => ["---", "title: P", "---", "", body, ""].join("\n");
  const lint = (body: string) => checkPageText({ relPath: "plans/p.mdx" }, page(body), []).filter((f) => f.check === "chart-table");
  const render = (body: string) => renderWikiHtml(page(body), () => undefined, { views: true });
  test("a clean chart of each kind has no finding and draws", () => {
    for (const md of ALL) {
      expect(lint(md)).toEqual([]);
      expect(render(md)).toContain("vc-has-plot");
    }
  });
  test("the finding sits on the Chart tag's line", () => {
    const bad = FUNNEL.replace("| Kept | 3 | 46 |", "| Kept | 300 | 46 |");
    const f = lint(bad);
    expect(f).toHaveLength(1);
    expect(f[0]!.line).toBe(5);
    expect(f[0]!.message).toContain("the reader shows the table instead");
  });
  test("a wikilinked header and row match on their link text in both", () => {
    const md = chart('kind="gap" value="Now" target="Goal" gap="Gap"', [
      "| Track | [[plans/x|Now]] | Goal | Gap |",
      "|---|---|---|---|",
      "| [[plans/a|Alpha]] | 40 | 50 | 10 |",
    ]);
    expect(lint(md)).toEqual([]);
    const html = render(md);
    expect(html).toContain("vc-has-plot");
    expect(html).toContain('<span class="vc-lab">Alpha</span>');
  });
  test("a wikilinked gate row matches the ledger by its link text's leading integer", () => {
    const md = [
      "## PR ledger",
      "",
      "| PR | State |",
      "|---|---|",
      "| 7 | open |",
      "",
      chart('kind="gate" bar="Bar" pass="Pass" hold="Hold"', ["| PR | Bar | Pass | Hold |", "|---|---|---|---|", "| [[plans/p7|7 — Seven]] | 2 | 3 | 3 |"]),
    ].join("\n");
    expect(lint(md)).toEqual([]);
    expect(render(md)).toContain('vc-st-open">open</span>');
  });
  test("lint and render agree on which charts fall back", () => {
    const cases = [
      GAP.replace('target="Goal"', 'target="Nope"'),
      GATE.replace("| +6.1 |", "| n/a |"),
      STEPS.replace('ref="Base"', 'ref="Nope"'),
      FUNNEL.replace("| Stage | Count | Of |", "| Stage | Count | Parent |"),
      GAP.replace("| 40 | 50 | 10 |", "| 40 | 50 | 99 |"),
    ];
    for (const md of cases) {
      const fatal = lint(md).some((f) => f.message.includes("shows the table instead"));
      expect(render(md).includes("vc-fallback")).toBe(fatal);
    }
  });
});
