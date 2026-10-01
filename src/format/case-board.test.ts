import { test, expect, describe } from "bun:test";
import { parseBlocks, type Block } from "./markdown-ast.ts";
import { CASEBOARD_MAX_CASES, caseCountParts, groupCases, parseCaseBoard } from "./case-board.ts";
import { pageFileRefs, type PageFileResult } from "./query-block.ts";
import { formatWebHtml } from "../web/web-format.ts";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { formatSlackMrkdwn } from "../slack/slack-format.ts";
import { formatEmailHtml } from "./email-format.ts";

const files = (entries: Record<string, PageFileResult>) => new Map(Object.entries(entries));
const board = (yaml: string) => formatWebHtml('<CaseBoard src="res/cases.yaml" />', { files: files({ "res/cases.yaml": { ok: true, text: yaml } }) });
const ok = (text: string) => {
  const b = parseCaseBoard(text);
  if (!b.ok) throw new Error(b.reason);
  return b;
};

const CASES = [
  "- id: MEL-1",
  "  status: none",
  "- id: MEL-2",
  "  status: hold",
  "  owner: Fag",
  "  note: Holdt **ute** til S4",
  "  refs: [Q-14, D6]",
  "- id: MEL-3",
  "  status: wait",
  "- id: MEL-4",
  "  status: hold",
  "- id: 545776",
  "  status: OK",
].join("\n");

describe("CaseBoard grammar", () => {
  test("self-closing with src; other attributes are dropped", () => {
    const b = parseBlocks('<CaseBoard src="cases.yaml" bogus="x" />')[0] as Extract<Block, { type: "component" }>;
    expect(b).toMatchObject({ type: "component", name: "CaseBoard", attrs: { src: "cases.yaml" }, children: [] });
  });

  test("a list of mappings parses; a numeric id is text; status is case-folded", () => {
    const b = ok(CASES);
    expect(b.cases.map((c) => [c.id, c.status])).toEqual([
      ["MEL-1", "none"],
      ["MEL-2", "hold"],
      ["MEL-3", "wait"],
      ["MEL-4", "hold"],
      ["545776", "ok"],
    ]);
    expect(b.cases[1]).toMatchObject({ owner: "Fag", note: "Holdt **ute** til S4", refs: ["Q-14", "D6"], anchor: "case-mel-2" });
    expect(b.counts).toEqual({ hold: 2, wait: 1, wrong: 0, none: 1, ok: 1, unknown: 0 });
  });

  test("a status outside the vocabulary, or none, is unknown and keeps what was written", () => {
    const b = ok("- id: A\n  status: blocked\n- id: B\n");
    expect(b.cases.map((c) => [c.status, c.rawStatus])).toEqual([["unknown", "blocked"], ["unknown", ""]]);
  });

  test("a single ref is a list of one; a non-scalar ref or note is dropped", () => {
    const b = ok("- id: A\n  status: ok\n  refs: Q-1\n  note: {x: 1}\n- id: B\n  status: ok\n  refs: [Q-2, [nested], {a: b}]\n");
    expect(b.cases[0]).toMatchObject({ refs: ["Q-1"], note: "" });
    expect(b.cases[1]!.refs).toEqual(["Q-2"]);
  });

  test("a block-scalar note is one line", () => {
    expect(ok("- id: A\n  status: ok\n  note: |\n    linje en\n    linje to\n").cases[0]!.note).toBe("linje en linje to");
  });

  test("an entry without an id, or not a mapping, is skipped and counted; an empty id apart", () => {
    const b = ok("- id: A\n  status: ok\n- status: hold\n- just text\n- id: ''\n  status: hold\n- [1, 2]\n");
    expect(b.cases.map((c) => c.id)).toEqual(["A"]);
    expect(b.skipped).toBe(3);
    expect(b.emptyIds).toBe(1);
    expect(b.counts.hold).toBe(0);
  });

  test("an empty file is an empty board", () => {
    const b = ok("");
    expect(b.cases).toEqual([]);
    expect(caseCountParts(b.counts)).toEqual([]);
    expect(board("")).toContain('<span class="cb-count">0 cases</span>');
  });

  test("past 500 cases the board shows 500 and the counts cover every case", () => {
    const yaml = Array.from({ length: 612 }, (_, i) => `- {id: C-${i}, status: ${i < 600 ? "none" : "hold"}}`).join("\n");
    const b = ok(yaml);
    expect(b.cases).toHaveLength(CASEBOARD_MAX_CASES);
    expect(b.total).toBe(612);
    expect(b.counts).toMatchObject({ none: 600, hold: 12 });
  });

  test("the count strip lists non-zero statuses in vocabulary order, unknown last", () => {
    expect(caseCountParts(ok(CASES).counts)).toEqual([[2, "hold"], [1, "wait"], [1, "none"], [1, "ok"]]);
    expect(caseCountParts(ok("- {id: A, status: x}\n- {id: B, status: wrong}").counts)).toEqual([[1, "wrong"], [1, "unknown"]]);
  });

  test("rows group by status in vocabulary order, file order within a group", () => {
    const groups = groupCases(ok(CASES).cases);
    expect(groups.map((g) => [g.status, g.cases.map((c) => c.id)])).toEqual([
      ["hold", ["MEL-2", "MEL-4"]],
      ["wait", ["MEL-3"]],
      ["none", ["MEL-1"]],
      ["ok", ["545776"]],
    ]);
  });
});

describe("CaseBoard YAML errors", () => {
  test("a syntax error is a one-line reason from Bun.YAML", () => {
    const b = parseCaseBoard("- id: a\n  status: [\n");
    expect(b).toEqual({ ok: false, reason: "YAML error: Unexpected token" });
  });

  test("an unresolved alias is a YAML error", () => {
    expect(parseCaseBoard("- id: *nope\n")).toEqual({ ok: false, reason: "YAML error: Unresolved alias" });
  });

  test("a top level that is not a list is refused", () => {
    expect(parseCaseBoard("cases:\n  - id: a\n")).toEqual({ ok: false, reason: "Expected a list of cases" });
    expect(parseCaseBoard("just text")).toEqual({ ok: false, reason: "Expected a list of cases" });
  });

  test("a parser that throws a multi-line message keeps its first line", () => {
    const parse = () => {
      throw new Error("bad thing\nat line 3");
    };
    expect(parseCaseBoard("x", parse)).toEqual({ ok: false, reason: "YAML error: bad thing" });
  });

  test("with no YAML parser (a browser) the board says so", () => {
    expect(parseCaseBoard("- id: a", null)).toEqual({ ok: false, reason: "YAML cannot be read here" });
  });

  test("on the web the error degrades inside the block, the rest of the page renders", () => {
    const html = formatWebHtml('Før.\n\n<CaseBoard src="res/cases.yaml" />\n\nEtter.', {
      files: files({ "res/cases.yaml": { ok: true, text: "- id: a\n  status: [\n" } }),
    });
    expect(html).toContain('<section class="caseboard"><p class="cb-unavailable">YAML error: Unexpected token: cases.yaml</p></section>');
    expect(html).toContain("Før.");
    expect(html).toContain("Etter.");
  });
});

describe("CaseBoard on the web", () => {
  test("the count strip, then rows grouped by status with an anchor per case", () => {
    const html = board(CASES);
    expect(html).toContain(
      '<p class="cb-strip"><span class="cb-count cb-count-hold"><span class="cb-n">2</span> hold</span><span class="cb-sep"> · </span>',
    );
    const order = [...html.matchAll(/<div class="cb-row" id="([^"]+)">/g)].map((m) => m[1]);
    expect(order).toEqual(["case-mel-2", "case-mel-4", "case-mel-3", "case-mel-1", "case-545776"]);
    expect(html).toContain('<a class="cb-id" href="#case-mel-2">MEL-2</a><span class="cb-pill cb-hold">hold</span>');
    expect(html).toContain('<span class="cb-note">Holdt <strong>ute</strong> til S4</span>');
    expect(html).toContain('<span class="cb-refs"><span class="cb-ref">Q-14</span><span class="cb-ref">D6</span></span>');
  });

  test("an unknown status renders an unknown pill titled with what was written", () => {
    expect(board("- {id: A, status: blocked}")).toContain('<span class="cb-pill cb-unknown" title="status: blocked">unknown</span>');
    expect(board("- {id: A}")).toContain('title="status: (none)">unknown</span>');
  });

  test("every file-derived string is escaped: id, owner, note, refs, the unknown status", () => {
    const html = board(
      [
        '- id: "<img src=x onerror=1>"',
        '  status: "<b>x\\""',
        '  owner: "<script>o</script>"',
        '  note: "<i>n</i> & [l](javascript:alert(1))"',
        '  refs: ["<r>"]',
      ].join("\n"),
    );
    expect(html).not.toMatch(/<img|<script|<i>|<r>|<b>|javascript:/);
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
    expect(html).toContain('title="status: &lt;b&gt;x&quot;"');
    expect(html).toContain("&lt;script&gt;o&lt;/script&gt;");
    expect(html).toContain("&lt;i&gt;n&lt;/i&gt; &amp; l");
    expect(html).toContain('<span class="cb-ref">&lt;r&gt;</span>');
  });

  test("a skipped entry and a cut board each say so", () => {
    expect(board("- {id: A, status: ok}\n- {status: ok}")).toContain('<p class="cb-warning">1 entry without an id skipped</p>');
    const big = Array.from({ length: 501 }, (_, i) => `- {id: C-${i}, status: none}`).join("\n");
    expect(board(big)).toContain('<p class="cb-truncated">showing 500 of 501 cases</p>');
  });

  test("an id with no usable character gets no anchor and no link", () => {
    const html = board('- {id: "—", status: ok}');
    expect(html).toContain('<div class="cb-row"><span class="cb-id">—</span>');
  });

  test("a repeated id gets a suffixed anchor in file order; a query keeps its own", () => {
    const html = formatWebHtml('<CaseBoard src="c.yaml" />\n\n<Query id="Q-1" question="x">\n\ny\n\n</Query>', {
      files: files({ "c.yaml": { ok: true, text: "- {id: Q-1, status: ok}\n- {id: Q-1, status: hold}\n" } }),
    });
    // Document order: the hold row (second in the file), the ok row, then the query card.
    expect([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1])).toEqual(["case-q-1-2", "case-q-1", "q-1"]);
    for (const id of ["case-q-1", "case-q-1-2", "q-1"]) expect(html).toContain(`href="#${id}"`);
  });

  test("a second board repeating an earlier board's id gets the next free suffix", () => {
    const html = formatWebHtml('<CaseBoard src="a.yaml" />\n\n<CaseBoard src="b.yaml" />', {
      files: files({
        "a.yaml": { ok: true, text: "- {id: A, status: ok}\n" },
        "b.yaml": { ok: true, text: "- {id: A, status: ok}\n- {id: A, status: ok}\n" },
      }),
    });
    expect([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1])).toEqual(["case-a", "case-a-3", "case-a-2"]);
    for (const id of ["case-a", "case-a-2", "case-a-3"]) expect(html).toContain(`href="#${id}"`);
  });

  test("no lookup (chat, the gardener preview) says the cases are not loaded here", () => {
    expect(formatWebHtml('<CaseBoard src="res/cases.yaml" />')).toContain(
      '<p class="cb-unavailable">Cases not loaded here: cases.yaml</p>',
    );
  });

  test("a missing file reads the same as one outside the root; no src says so", () => {
    expect(formatWebHtml('<CaseBoard src="x.yaml" />', { files: files({}) })).toContain("File not available: x.yaml");
    expect(formatWebHtml("<CaseBoard />", { files: files({}) })).toContain("CaseBoard without src");
  });

  test("the loader collects src from CaseBoard and DeltaTable, at any depth, never from a fence", () => {
    const md = [
      '<Fold title="x">',
      "",
      '<CaseBoard src="a.yaml" />',
      "",
      "</Fold>",
      "",
      '<DeltaTable src="b.csv" />',
      "",
      "```mdx",
      '<CaseBoard src="fenced.yaml" />',
      "```",
    ].join("\n");
    expect(pageFileRefs(parseBlocks(md))).toEqual(["a.yaml", "b.csv"]);
  });
});

describe("CaseBoard on the text surfaces (no file read)", () => {
  const md = '<CaseBoard src="res/<cases>.yaml" />';
  test("telegram, slack and email name the file, escaped", () => {
    expect(formatTelegramHtml(md)).toBe("Cases: &lt;cases&gt;.yaml");
    expect(formatSlackMrkdwn(md)).toBe("Cases: `&lt;cases&gt;.yaml`");
    const mail = formatEmailHtml(md);
    expect(mail).toContain("Cases: &lt;cases&gt;.yaml");
    expect(mail).not.toContain("<cases>");
  });
});

describe("fix round 1: CaseBoard", () => {
  const rowIds = (html: string) => [...html.matchAll(/<div class="cb-row" id="([^"]+)"/g)].map((m) => m[1]);

  test("case anchors take a case- prefix, so a case never renames a Query anchor", () => {
    const html = formatWebHtml('<Query id="Q-1" question="x">\n\ny\n\n</Query>\n\n<CaseBoard src="c.yaml" />', {
      files: files({ "c.yaml": { ok: true, text: "- {id: Q-1, status: ok}\n" } }),
    });
    expect(html).toContain('<section class="query" id="q-1">');
    expect(html).toContain('<a class="query-id" href="#q-1">');
    expect(rowIds(html)).toEqual(["case-q-1"]);
    expect(html).toContain('<a class="cb-id" href="#case-q-1">Q-1</a>');
  });

  test("repeats are suffixed in FILE order, so a status change never swaps suffixes", () => {
    // File order: A (none), A (hold). The hold group renders first.
    const html = board("- {id: A, status: none}\n- {id: A, status: hold}\n");
    expect(rowIds(html)).toEqual(["case-a-2", "case-a"]);
    expect(html).toContain('<a class="cb-id" href="#case-a-2">A</a><span class="cb-pill cb-hold">');
    const flipped = board("- {id: A, status: hold}\n- {id: A, status: hold}\n");
    expect(rowIds(flipped)).toEqual(["case-a", "case-a-2"]);
  });

  test("several YAML documents are reported as such", () => {
    expect(parseCaseBoard("- id: a\n---\n- id: b\n")).toEqual({ ok: false, reason: "Multiple YAML documents (---); use one list" });
    expect(parseCaseBoard("---\n- id: a\n")).toMatchObject({ ok: true, total: 1 });
    expect(parseCaseBoard("# head\n---\n- id: a\n")).toMatchObject({ ok: true, total: 1 });
  });

  test("an id YAML reads as a number or other non-text still renders, under one warning to quote it", () => {
    const html = board("- {id: 0123, status: ok}\n- {id: 0x1F, status: ok}\n- {id: 1e3, status: ok}\n- {id: .inf, status: ok}\n- {id: MEL-1, status: ok}\n");
    expect(html.match(/<div class="cb-row"/g)).toHaveLength(5);
    expect(html).toContain('<a class="cb-id" href="#case-123">123</a>');
    expect(html).toContain(
      '<p class="cb-warning">Read as numbers or other non-text, quote them to keep them as written: id 123, id 31, id 1000, id .inf</p>',
    );
    expect(html).not.toContain("without an id");
  });

  test("an empty id (~, null or nothing) is skipped under its own reason", () => {
    const html = board("- {id: ~, status: ok}\n- {id: A, status: ok}\n");
    expect(html).toContain('<p class="cb-warning">1 entry with an empty id skipped</p>');
    expect(html).not.toContain("without an id");
  });

  test("a non-text owner or ref is named in the warning; a list or mapping note/owner/ref is counted", () => {
    const html = board("- {id: A, status: ok, owner: 7, refs: [12, Q-1, [x]], note: {a: b}}\n");
    expect(html).toContain("quote them to keep them as written: owner 7, refs 12</p>");
    expect(html).toContain('<p class="cb-warning">2 values that are a list or mapping dropped (note, owner or refs)</p>');
  });

  test("every count on the board uses one formatter", () => {
    const yaml = Array.from({ length: 1500 }, (_, i) => `- {id: C-${i}, status: ok}`).join("\n");
    const html = board(yaml);
    expect(html).toContain('<span class="cb-n">1,500</span> ok');
    expect(html).toContain("showing 500 of 1,500 cases");
  });

  test("a CaseBoard src must be .yaml or .yml", () => {
    const html = formatWebHtml('<CaseBoard src="runs.csv" />', { files: files({ "runs.csv": { ok: true, text: "- id: A\n" } }) });
    expect(html).toContain("File type not allowed: runs.csv");
    expect(html).not.toContain("cb-row");
  });

  test("the text surfaces say a CaseBoard has no src, as the web does", () => {
    expect(formatTelegramHtml("<CaseBoard />")).toBe("CaseBoard without src");
    expect(formatSlackMrkdwn("<CaseBoard />")).toBe("CaseBoard without src");
    expect(formatEmailHtml("<CaseBoard />")).toContain("CaseBoard without src");
  });

  test("Slack names the file in a code span, so _ and * stay as written", () => {
    expect(formatSlackMrkdwn('<CaseBoard src="a_b*.yaml" />')).toBe("Cases: `a_b*.yaml`");
    expect(formatSlackMrkdwn('<DeltaTable src="r_1*.csv" />')).toBe("Table: `r_1*.csv`");
    expect(formatSlackMrkdwn('<Query id="Q-1" csv="q_1*.csv" />')).toContain("Resultat: `q_1*.csv`");
  });
});

describe("fix round 2: CaseBoard", () => {
  test("a Query card and a case never share an id: the card takes the next free suffix", () => {
    const html = formatWebHtml('<Query id="Case-A" question="x">\n\ny\n\n</Query>\n\n<CaseBoard src="c.yaml" />', {
      files: files({ "c.yaml": { ok: true, text: "- {id: A, status: ok}\n- {id: A-2, status: ok}\n" } }),
    });
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["case-a-3", "case-a", "case-a-2"]);
    expect(html).toContain('<a class="query-id" href="#case-a-3">');
    expect(html).toContain('<a class="cb-id" href="#case-a">A</a>');
  });

  test("a repeat's suffix never takes an authored id: A, A, A-2 → case-a, case-a-3, case-a-2", () => {
    expect(ok("- id: A\n- id: A\n- id: A-2\n").cases.map((c) => c.anchor)).toEqual(["case-a", "case-a-3", "case-a-2"]);
  });

  test("a ... document end followed by more is several documents", () => {
    const several = { ok: false as const, reason: "Multiple YAML documents (---); use one list" };
    expect(parseCaseBoard("- id: a\n...\n- id: b\n")).toEqual(several);
    expect(parseCaseBoard("...\n- id: a\n")).toEqual(several);
    expect(parseCaseBoard("- id: a\n...\n# end\n\n")).toMatchObject({ ok: true, total: 1 });
  });

  test("an id that is a list or a mapping is skipped as having no id, not as empty", () => {
    expect(ok("- id: [1]\n- id: {a: 1}\n- id:\n")).toMatchObject({ skipped: 2, emptyIds: 1, total: 0 });
  });

  test("YAML's .nan and -.inf are written back as YAML writes them", () => {
    expect(ok("- id: .nan\n- id: -.inf\n- id: .inf\n").cases.map((c) => c.id)).toEqual([".nan", "-.inf", ".inf"]);
  });
});
