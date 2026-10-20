import { describe, expect, test } from "bun:test";
import { renderWikiHtml } from "../wiki/render.ts";
import { checkPageText } from "../wiki/lint.ts";
import { formatWebHtml } from "../web/web-format.ts";
import { GATE_BAR_AFTER_HEADERS, FUNNEL_OF_HEADERS } from "./chart-block.ts";
import { CHART_CHROME_CLASSES, CHART_WORDS, stepsAxisDecimals, stepsLabelIndexes, STEPS_X_LABELS_MAX } from "./chart-view.ts";
import { headerKey } from "./delta-table.ts";
import { PEEK_CHART_CHROME } from "../dashboard/views/components/wiki-ref-links.ts";

// Invented pages only.

const reader = (md: string, language?: "en" | "no") =>
  renderWikiHtml(md, () => undefined, { views: true, ...(language ? { language } : {}) } as never);

const chart = (open: string, rows: string[], extra: string[] = []) => [open, "", ...rows, "", ...extra, "</Chart>", ""].join("\n");

const gate = (rows: string[]) =>
  chart('<Chart kind="gate" caption="Gates" bar="Bar" pass="Pass" hold="Hold">', ["| Slice | Bar | Pass | Hold |", "|---|---|---|---|", ...rows]);

/** The text of each element with `cls`, in order. */
const texts = (html: string, cls: string) =>
  [...html.matchAll(new RegExp(`class="${cls}[^"]*"[^>]*>([^<]*)<`, "g"))].map((m) => m[1]);

describe("the chart view's words", () => {
  test("the gate toggle names the header set's own words in both languages", () => {
    for (const lang of ["en", "no"] as const) expect(GATE_BAR_AFTER_HEADERS.has(headerKey(CHART_WORDS[lang].after))).toBe(true);
    expect([...GATE_BAR_AFTER_HEADERS].sort()).toEqual(["bar after", "krav etter"]);
    expect(FUNNEL_OF_HEADERS.has(headerKey(CHART_WORDS.no.of))).toBe(true);
    expect(FUNNEL_OF_HEADERS.has(headerKey(CHART_WORDS.en.of))).toBe(true);
  });

  test("a Norwegian wiki labels the view in Norwegian and writes a decimal comma", () => {
    const md = chart('<Chart kind="funnel" caption="Trakt">', ["| Steg | Antall | Av |", "|---|---|---|", "| alle | 30 | |", "| beholdt | 1 | 30 |"]);
    const no = reader(md, "no");
    expect(no).toContain(">Diagram</button>");
    expect(no).toContain(">Tabell</button>");
    expect(no).toContain("1 av 30");
    expect(no).toContain("(3,3%)");
    const en = reader(md);
    expect(en).toContain(">Chart</button>");
    expect(en).toContain("(3.3%)");
  });

  test("the gate verdict reads in the wiki's language", () => {
    const md = gate(["| a | 2 | 3 | — |", "| b | 2 | 3 | 1 |", "| c | 2 | 3 | 2 |"]);
    expect(texts(reader(md), "vc-verdict")).toEqual(["numbers miss: hold not measured", "numbers miss: 1 &lt; 2", "numbers pass"]);
    expect(texts(reader(md, "no"), "vc-verdict")).toEqual(["tallene holder ikke: hold ikke målt", "tallene holder ikke: 1 &lt; 2", "tallene holder"]);
  });
});

describe("the section", () => {
  test("a peek strips exactly the chart's chrome", () => {
    expect([...PEEK_CHART_CHROME]).toEqual([...CHART_CHROME_CLASSES]);
  });

  const html = reader(gate(["| a | 2 | 3 | 2 |"]));

  test("is a figure named by its caption, with a kind class", () => {
    expect(html).toMatch(/<section class="vc vc-kind-gate" role="figure" aria-label="Gates">/);
  });

  test("every SVG is an image with a title", () => {
    const svgs = [...html.matchAll(/<svg class="vc-svg"[^>]*>/g)].map((m) => m[0]);
    expect(svgs.length).toBeGreaterThan(0);
    for (const s of svgs) expect(s).toContain('role="img"');
    expect((html.match(/<title>/g) ?? []).length).toBe(svgs.length);
  });

  test("the chrome is reader-only and the table is not", () => {
    for (const cls of ["vc-head", "vc-plot", "vc-legend"]) expect(html).toMatch(new RegExp(`class="${cls}"[^>]*data-reader-only`));
    expect(html).not.toMatch(/class="vc-table[^"]*"[^>]*data-reader-only/);
    expect(html).toContain("<table");
  });

  test("toggles are buttons carrying aria-pressed", () => {
    expect(html).toContain('<button type="button" class="vc-btn" data-vc-mode="chart" aria-pressed="true">');
    expect(html).toContain('<button type="button" class="vc-btn" data-vc-mode="table" aria-pressed="false">');
  });

  test("text before and after the table keeps its place", () => {
    const md = chart('<Chart kind="gate" bar="Bar" pass="Pass" hold="Hold">', ["Intro words.", "", "| S | Bar | Pass | Hold |", "|---|---|---|---|", "| a | 2 | 3 | 2 |"], ["After words.", ""]);
    const out = reader(md);
    const at = (s: string) => out.indexOf(s);
    expect(at("Intro words.")).toBeLessThan(at('class="vc-head"'));
    expect(at("<table")).toBeLessThan(at("After words."));
    expect(at("After words.")).toBeLessThan(at("</section>"));
  });
});

describe("value cell ids", () => {
  const log = (ids: string[]) => ["<DecisionLog>", "", ...ids.map((id) => `- **${id}** — Decided.`), "", "</DecisionLog>", ""];

  test("only decision and question ids link, in gap and gate alike", () => {
    const g = reader([...log(["D7", "S4"]), gate(["| a | 2 | 3 (D7, X12) | 2 (S4) |"])].join("\n"));
    expect(g).toContain('3 (<a class="dc-go" href="#d7" data-dc-ref="D7">D7</a>, X12)');
    expect(g).toContain('2 (<a class="dc-go" href="#s4" data-dc-ref="S4">S4</a>)');
    const gap = reader(
      [...log(["D3"]), chart('<Chart kind="gap" value="Now" target="Goal" gap="Gap">', ["| I | Now | Goal | Gap |", "|---|---|---|---|", "| a | 1 (D3) | 4 | 3 |"])].join("\n"),
    );
    expect(gap).toContain('1 (<a class="dc-go" href="#d3" data-dc-ref="D3">D3</a>)');
  });

  test("an id the page's DecisionLog does not have stays plain text", () => {
    const g = reader([...log(["D7"]), gate(["| a | 2 | 3 (D7, D9) | 2 (S4) |"])].join("\n"));
    expect(g).toContain('3 (<a class="dc-go" href="#d7" data-dc-ref="D7">D7</a>, D9)');
    expect(g).toContain("2 (S4)");
    const noLog = reader(chart('<Chart kind="funnel">', ["| Step | Count | Of |", "|---|---|---|", "| all | 40 (D2) | |", "| kept | 10 (S1) | 40 |"]));
    expect(noLog).toContain("40 (D2)");
    expect(noLog).toContain("10 (S1)");
    expect(noLog).not.toContain('class="dc-go"');
  });

  test("a link points at its DecisionLog item's final anchor", () => {
    const md = [
      '<Query id="D7" question="Q">',
      "",
      "Body.",
      "",
      "</Query>",
      "",
      "<DecisionLog>",
      "",
      "- **D7** — Decided.",
      "",
      "</DecisionLog>",
      "",
      gate(["| a | 2 | 3 (D7) | 2 |"]),
    ].join("\n");
    const out = reader(md);
    expect(out).toContain('id="d7-2"');
    expect(out).toContain('<a class="dc-go" href="#d7-2" data-dc-ref="D7">D7</a>');
  });
});

describe("numbers", () => {
  test("no −0% and a U+2212 minus", () => {
    const md = chart('<Chart kind="gap" value="Now" target="Goal" gap="Gap">', ["| I | Now | Goal | Gap |", "|---|---|---|---|", "| a | -0.0001 | 4 | |", "| b | -2 | 4 | |"]);
    const out = reader(md);
    // Switch to the % variant's text.
    const pct = out.slice(out.indexOf('data-vc-plot="pct"'));
    expect(pct).not.toContain("−0%");
    expect(pct).not.toContain("-0%");
    expect(pct).toContain("0% of");
    expect(pct).toContain("−50% of");
  });

  test("a negative bar gets a zero baseline", () => {
    const md = chart('<Chart kind="gap" value="Now" target="Goal" gap="Gap">', ["| I | Now | Goal | Gap |", "|---|---|---|---|", "| a | -2 | 4 | 6 |"]);
    expect(reader(md)).toContain('class="vc-zero"');
    const pos = chart('<Chart kind="gap" value="Now" target="Goal" gap="Gap">', ["| I | Now | Goal | Gap |", "|---|---|---|---|", "| a | 2 | 4 | 2 |"]);
    expect(reader(pos)).not.toContain('class="vc-zero"');
  });

  test("the gap band is drawn over the value bar, so a value past its target keeps the band in view", () => {
    const md = chart('<Chart kind="gap" value="Now" target="Goal" gap="Gap">', ["| I | Now | Goal | Gap |", "|---|---|---|---|", "| below | -9 | -3 | 6 |", "| over | 28 | 18 | -10 |", "| cross | -4 | 6 | 10 |", "| under | 4 | 12 | 8 |"]);
    const svgs = reader(md).match(/<svg[^]*?<\/svg>/g)!.filter((x) => x.includes('class="vc-band"'));
    expect(svgs.length).toBe(4); // one per row; a negative target offers no % variant
    for (const svg of svgs) expect(svg.indexOf('class="vc-band"')).toBeGreaterThan(svg.indexOf('class="vc-value"'));
  });

  test("the y axis shows the plotted extremes with enough decimals", () => {
    expect(stepsAxisDecimals(1.2, 1.25, 2)).toBe(2);
    expect(stepsAxisDecimals(1.2, 1.25, 0)).toBe(2);
    expect(stepsAxisDecimals(1.2, 1.203, 0)).toBe(3);
    expect(stepsAxisDecimals(3, 90, 0)).toBe(0);
    const md = chart('<Chart kind="steps" x="Step">', ["| Step | A |", "|---|---|", "| one | 1.21 |", "| two | 1.24 |"]);
    expect(texts(reader(md), "vc-ylab")).toEqual(["1.24", "1.21"]);
  });

  test("normalize draws the ref line at 100", () => {
    const md = chart('<Chart kind="steps" x="Step" ref="base" normalize="ref">', ["| Step | A |", "|---|---|", "| base | 8 |", "| one | 12 |"]);
    const out = reader(md);
    expect(out).toContain('class="vc-ref vc-ref-100"');
    expect(texts(out, "vc-ylab")).toEqual(["150%", "100%"]);
    expect(out).toContain("base = 100%");
  });
});

describe("steps x labels", () => {
  test("25 long steps keep at most the cap, first and last included, each under its point", () => {
    const idx = stepsLabelIndexes(25);
    expect(idx.length).toBeLessThanOrEqual(STEPS_X_LABELS_MAX);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(24);
    const rows = Array.from({ length: 25 }, (_, i) => `| step number ${i} with a long name | ${i} |`);
    const out = reader(chart('<Chart kind="steps" x="Step">', ["| Step | A |", "|---|---|", ...rows]));
    const labels = [...out.matchAll(/class="vc-xlab[^"]*" style="left:([\d.]+)%[^"]*" title="([^"]*)"/g)];
    expect(labels.map((m) => m[2])).toEqual(idx.map((i) => `step number ${i} with a long name`));
    expect(labels.map((m) => Number(m[1]))).toEqual(idx.map((i) => Math.round((i / 24) * 10000) / 100));
    // The words every step shares show once under the axis; each label shows what tells it apart.
    expect(texts(out, "vc-xlab")).toEqual(idx.map(String));
    expect(texts(out, "vc-xcap")).toEqual(["step number … with a long name"]);
    // An edge label grows one way, so it gets half a middle label's width.
    const widths = [...out.matchAll(/class="vc-xlab[^"]*" style="[^"]*max-width:([\d.]+)%/g)].map((m) => Number(m[1]));
    expect(widths[0]).toBeCloseTo(widths[1]! / 2, 1);
    expect(widths[widths.length - 1]).toBeCloseTo(widths[1]! / 2, 1);
  });

  test("a shared part is cut only at a word edge and only when every label keeps some text", () => {
    const steps = (names: string[]) =>
      reader(chart('<Chart kind="steps" x="Step">', ["| Step | A |", "|---|---|", ...names.map((n, i) => `| ${n} | ${i + 1} |`)]));
    const none = steps(["alpha", "beta", "gamma"]);
    expect(texts(none, "vc-xlab")).toEqual(["alpha", "beta", "gamma"]);
    expect(none).not.toContain("vc-xcap");
    // «run» is a whole label and «base» a shared word start: neither is cut.
    expect(texts(steps(["run", "run 2", "run 3"]), "vc-xlab")).toEqual(["run", "run 2", "run 3"]);
    expect(texts(steps(["baseline", "basement"]), "vc-xlab")).toEqual(["baseline", "basement"]);
    const tail = steps(["Q1 2030", "Q2 2030", "Q3 2030"]);
    expect(texts(tail, "vc-xlab")).toEqual(["Q1", "Q2", "Q3"]);
    expect(texts(tail, "vc-xcap")).toEqual(["… 2030"]);
    const head = steps(["phase-one", "phase-two"]);
    expect(texts(head, "vc-xlab")).toEqual(["one", "two"]);
    expect(texts(head, "vc-xcap")).toEqual(["phase …"]);
    // One step has nothing to share.
    expect(texts(steps(["only step"]), "vc-xlab")).toEqual(["only step"]);
  });

  test("a small step count labels every step", () => {
    expect(stepsLabelIndexes(3)).toEqual([0, 1, 2]);
    expect(stepsLabelIndexes(1)).toEqual([0]);
  });
});

describe("funnel", () => {
  test("bars are each row's share of its parent, indented by depth", () => {
    const md = chart('<Chart kind="funnel">', ["| Step | Count | Of |", "|---|---|---|", "| all | 40 | |", "| kept | 10 | 40 |", "| fine | 5 | 10 |", "| zero | 0 | 5 |", "| under | 0 | 0 |"]);
    const out = reader(md);
    expect(texts(out, "vc-pct")).toEqual(["(25%)", "(50%)", "(0%)", "(—)"]);
    expect(out).toContain('class="vc-d0">all');
    expect(out).toContain('class="vc-d2">fine');
    expect(out).toContain('class="vc-d4">under');
  });
});

describe("gate pills", () => {
  test("a gate row shows its PR's ledger state with the dc-s classes", () => {
    const md = ["## PR ledger", "", "| PR | What | State |", "|---|---|---|", "| 31 | a | merged |", "| 32 | b | open |", "", gate(["| PR 31 — a | 2 | 3 | 3 |", "| 32 b | 2 | 3 | 3 |", "| 12–40 | 2 | 3 | 3 |"])].join("\n");
    const out = reader(md);
    expect([...out.matchAll(/dc-pr dc-s-([a-z-]+) vc-pill/g)].map((m) => m[1])).toEqual(["merged"]);
  });

  // A ledger whose slate and GitHub numbers differ: slate 16 is merged, the
  // row linking GitHub PR 16 is slate 3 and open; GitHub PR 20 is slate 5.
  const ledger = ["## PR ledger", "", "| PR | What | State |", "|---|---|---|", "| 16 | a | merged |", "| 3 — [#16](https://example.test/o/r/pull/16) | b | open |", "| 5 — [#20](https://example.test/o/r/pull/20) | c | open |", ""];
  const pills = (out: string) => [...out.matchAll(/<span class="dc-pr dc-s-([a-z-]+) vc-pill"[^>]*aria-label="([^"]*)"/g)].map((m) => [m[1], m[2]]);

  test("a link-only first cell matches the ledger row with that link, not the slate with that number", () => {
    const out = reader([...ledger, gate(["| [#16](https://example.test/o/r/pull/16) | 2 | 3 | 3 |"])].join("\n"));
    expect(pills(out)).toEqual([["open", "PR 16 · open"]]);
  });

  test("a PR link followed by a label reads the link, as a ledger row does", () => {
    const out = reader([...ledger, gate(["| [#16](https://example.test/o/r/pull/16) Retry logic | 2 | 3 | 3 |", "| [#16](https://example.test/o/r/pull/16) — Retry | 2 | 3 | 3 |"])].join("\n"));
    expect(pills(out).map((p) => p[0])).toEqual(["open", "open"]);
  });

  test("a slate matches only the ledger row with that slate; a link no ledger row carries gets no pill", () => {
    const out = reader([...ledger, gate(["| 16 — a | 2 | 3 | 3 |", "| [#9](https://example.test/o/r/pull/9) | 2 | 3 | 3 |", "| 20 — c | 2 | 3 | 3 |", "| 3 — [#16](https://example.test/o/r/pull/16) | 2 | 3 | 3 |"])].join("\n"));
    expect(pills(out)).toEqual([["merged", "PR 16 · merged"], ["open", "PR 3 · open"]]);
  });

  test("struck text in the first cell is not read for the slate", () => {
    const md = ["## PR ledger", "", "| PR | What | State |", "|---|---|---|", "| 8 | a | open |", "| 12 | b | merged |", "", gate(["| ~~8~~ 12 — b | 2 | 3 | 3 |"])].join("\n");
    expect(pills(reader(md))).toEqual([["merged", "PR 12 · merged"]]);
  });

  test("no ledger, no pill", () => {
    expect(reader(gate(["| PR 31 — a | 2 | 3 | 3 |"]))).not.toContain("vc-pill");
  });
});

describe("off the reader view", () => {
  test("views without a chart view print the table", () => {
    const md = gate(["| a | 2 | 3 | 2 |"]);
    const out = formatWebHtml(md, { views: true });
    expect(out).not.toContain('class="vc ');
    expect(out).toContain("<table");
  });

  test("a table that fails its kind renders as its table under the finding", () => {
    const out = reader(gate(["| a | 2 | x | 2 |"]));
    expect(out).not.toContain("vc-kind-");
    expect(out).not.toContain("<svg");
    expect(out).toContain('<section class="vc vc-fallback" role="figure" aria-label="Gates">');
    expect(out).toMatch(/<ul class="vc-notes" data-reader-only="">.*not a number.*<\/ul><div class="tablewrap"><table/);
  });
});

describe("the accessible name", () => {
  // The caption's visible text, the same text lint names; never the source.
  const lintCaption = (md: string) => /caption="([^"]*)"/.exec(checkPageText({ relPath: "plans/a.mdx" }, md, []).find((f) => f.check === "chart-table")?.message ?? "")?.[1];
  const labels = (out: string) => [...out.matchAll(/<section class="vc [^"]*" role="figure" aria-label="([^"]*)"/g)].map((m) => m[1]);

  test("a drawn chart's caption with a wikilink names the link text", () => {
    const out = reader(chart('<Chart kind="gate" caption="Cap [[Foo|bar]]" bar="Bar" pass="Pass" hold="Hold">', ["| S | Bar | Pass | Hold |", "|---|---|---|---|", "| a | 2 | 3 | 2 |"]));
    expect(labels(out)).toEqual(["Cap bar"]);
    expect(out).not.toContain("[[Foo");
  });

  test("a fallback section's caption with a wikilink names what lint names", () => {
    const md = chart('<Chart kind="gate" caption="Cap [[Foo|bar]]" bar="Bar" pass="Pass" hold="Hold">', ["| S | Bar | Pass | Hold |", "|---|---|---|---|", "| a | 2 | x | 2 |"]);
    const out = reader(md);
    expect(out).toContain("vc-fallback");
    expect(labels(out)).toEqual(["Cap bar"]);
    expect(labels(out)).toEqual([lintCaption(md)]);
  });

  test("a steps plot's SVG title names the link text", () => {
    const out = reader(chart('<Chart kind="steps" caption="Cap [[Foo|bar]]" x="Step">', ["| Step | A |", "|---|---|", "| one | 1 |", "| two | 2 |"]));
    expect(out).toContain("<title>Cap bar");
    expect(out).not.toContain("[[Foo");
  });
});

describe("render and lint agree", () => {
  // Each table: does the reader draw it, and does lint raise a warning?
  const steps: [string, string[], boolean, string][] = [
    ["steps with series", ["| Step | A |", "|---|---|", "| one | 1 |"], true, '<Chart kind="steps" x="Step">'],
    ["steps with no series column", ["| Step |", "|---|", "| one |", "| two |"], false, '<Chart kind="steps" x="Step">'],
  ];
  const cases: [string, string[], boolean, string?][] = [
    ...steps,
    ["wikilink header", ["| Slice | [[Bar]] | Pass | Hold |", "|---|---|---|---|", "| a | 2 | 3 | 2 |"], true],
    ["aliased header", ["| Slice | [[x|Bar]] | Pass | Hold |", "|---|---|---|---|", "| a | 2 | 3 | 2 |"], true],
    ["code header", ["| Slice | `Bar` | Pass | Hold |", "|---|---|---|---|", "| a | 2 | 3 | 2 |"], true],
    ["bold header", ["| Slice | **Bar** | Pass | Hold |", "|---|---|---|---|", "| a | 2 | 3 | 2 |"], true],
    ["dash header", ["| Slice | Bar | Pass – now | Hold |", "|---|---|---|---|", "| a | 2 | 3 | 2 |"], false],
    ["NBSP cell", ["| Slice | Bar | Pass | Hold |", "|---|---|---|---|", "| a | 2 | 1 500 | 2 |"], true],
    ["bold cell", ["| Slice | Bar | Pass | Hold |", "|---|---|---|---|", "| a | 2 | **3** | 2 |"], true],
    ["wikilink cell", ["| Slice | Bar | Pass | Hold |", "|---|---|---|---|", "| a | 2 | [[x|3]] | 2 |"], true],
    ["code cell", ["| Slice | Bar | Pass | Hold |", "|---|---|---|---|", "| a | 2 | `3` | 2 |"], true],
    ["struck cell", ["| Slice | Bar | Pass | Hold |", "|---|---|---|---|", "| a | 2 | ~~9~~ 3 | 2 |"], true],
    ["text cell", ["| Slice | Bar | Pass | Hold |", "|---|---|---|---|", "| a | 2 | soon | 2 |"], false],
  ];
  for (const [name, rows, draws, open] of cases) {
    test(name, () => {
      const md = chart(open ?? '<Chart kind="gate" bar="Bar" pass="Pass" hold="Hold">', rows);
      const drawn = reader(md).includes("vc-kind-");
      const warned = checkPageText({ relPath: "plans/a.mdx" }, md, []).some((f) => f.check === "chart-table" && f.severity !== "info");
      expect({ drawn, warned }).toEqual({ drawn: draws, warned: !draws });
    });
  }
});
