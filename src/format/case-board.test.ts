import { test, expect, describe } from "bun:test";
import { parseBlocks, type Block } from "./markdown-ast.ts";
import { CASEBOARD_MAX_CASES, caseCountText, groupCases, parseCaseBoard } from "./case-board.ts";
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
    expect(b.cases[1]).toMatchObject({ owner: "Fag", note: "Holdt **ute** til S4", refs: ["Q-14", "D6"], anchor: "mel-2" });
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

  test("an entry without an id, or not a mapping, is skipped and counted", () => {
    const b = ok("- id: A\n  status: ok\n- status: hold\n- just text\n- id: ''\n  status: hold\n- [1, 2]\n");
    expect(b.cases.map((c) => c.id)).toEqual(["A"]);
    expect(b.skipped).toBe(4);
    expect(b.counts.hold).toBe(0);
  });

  test("an empty file is an empty board", () => {
    const b = ok("");
    expect(b.cases).toEqual([]);
    expect(caseCountText(b.counts)).toBe("0 cases");
  });

  test("past 500 cases the board shows 500 and the counts cover every case", () => {
    const yaml = Array.from({ length: 612 }, (_, i) => `- {id: C-${i}, status: ${i < 600 ? "none" : "hold"}}`).join("\n");
    const b = ok(yaml);
    expect(b.cases).toHaveLength(CASEBOARD_MAX_CASES);
    expect(b.total).toBe(612);
    expect(b.counts).toMatchObject({ none: 600, hold: 12 });
  });

  test("the count strip lists non-zero statuses in vocabulary order, unknown last", () => {
    expect(caseCountText(ok(CASES).counts)).toBe("2 hold · 1 wait · 1 none · 1 ok");
    expect(caseCountText(ok("- {id: A, status: x}\n- {id: B, status: wrong}").counts)).toBe("1 wrong · 1 unknown");
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
    expect(order).toEqual(["mel-2", "mel-4", "mel-3", "mel-1", "545776"]);
    expect(html).toContain('<a class="cb-id" href="#mel-2">MEL-2</a><span class="cb-pill cb-hold">hold</span>');
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

  test("a repeated id gets a suffixed anchor, and a case and a query share the namespace", () => {
    const html = formatWebHtml('<CaseBoard src="c.yaml" />\n\n<Query id="Q-1" question="x">\n\ny\n\n</Query>', {
      files: files({ "c.yaml": { ok: true, text: "- {id: Q-1, status: ok}\n- {id: Q-1, status: hold}\n" } }),
    });
    // Document order: the hold row, the ok row, then the query card.
    expect([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1])).toEqual(["q-1", "q-1-2", "q-1-3"]);
    for (const id of ["q-1", "q-1-2", "q-1-3"]) expect(html).toContain(`href="#${id}"`);
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
    expect(formatSlackMrkdwn(md)).toBe("Cases: &lt;cases&gt;.yaml");
    const mail = formatEmailHtml(md);
    expect(mail).toContain("Cases: &lt;cases&gt;.yaml");
    expect(mail).not.toContain("<cases>");
  });
});
