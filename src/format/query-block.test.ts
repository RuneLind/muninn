import { test, expect, describe } from "bun:test";
import { parseBlocks, type Block } from "./markdown-ast.ts";
import {
  QUERY_CSV_MAX_ROWS,
  checkPageFileRef,
  parseQueryAttrs,
  queryFileRefs,
  splitQuerySql,
  type PageFileResult,
} from "./query-block.ts";
import { formatWebHtml } from "../web/web-format.ts";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { formatSlackMrkdwn } from "../slack/slack-format.ts";
import { formatEmailHtml } from "./email-format.ts";
import { stripTokenSpans } from "../test/highlighted-code.ts";

const fence = (lang: string, code: string) => ["```" + lang, code, "```"].join("\n");

const QUERY = [
  '<Query id="Q-8" question="Har de 46 sakene fått årsavregning?" answer="Tre saker (→ S1, S2)." csv="res/Q-8.csv" run="2026-09-30" uses="8045, 8306" bogus="x">',
  "",
  "Fag sa 30.09 at **dette** gjelder.",
  "",
  fence("sql", "SELECT 1 FROM dual;"),
  "",
  fence("sql", "SELECT 2 FROM dual;"),
  "",
  "</Query>",
].join("\n");

const files = (entries: Record<string, PageFileResult>) => new Map(Object.entries(entries));
const component = (blocks: Block[]) => blocks.find((b) => b.type === "component") as Extract<Block, { type: "component" }>;

describe("Query grammar", () => {
  test("whitelisted attributes parse; unknown ones are dropped; uses splits on commas", () => {
    const q = component(parseBlocks(QUERY));
    expect(q.name).toBe("Query");
    expect(q.attrs.bogus).toBeUndefined();
    expect(parseQueryAttrs(q.attrs)).toEqual({
      id: "Q-8",
      anchor: "q-8",
      question: "Har de 46 sakene fått årsavregning?",
      answer: "Tre saker (→ S1, S2).",
      csv: "res/Q-8.csv",
      sql: "",
      run: "2026-09-30",
      uses: ["8045", "8306"],
    });
  });

  test("the anchor keeps letters, digits, - and _; anything else becomes -", () => {
    expect(parseQueryAttrs({ id: "Q 10/13" }).anchor).toBe("q-10-13");
    expect(parseQueryAttrs({ id: "§§" }).anchor).toBe("");
  });

  test("without sql=, the FIRST direct-child sql fence moves out; the second stays", () => {
    const q = component(parseBlocks(QUERY));
    const { sql, body } = splitQuerySql(q.children, false);
    expect(sql?.code).toBe("SELECT 1 FROM dual;");
    expect(body.filter((b) => b.type === "code_block").map((b) => (b as { code: string }).code)).toEqual([
      "SELECT 2 FROM dual;",
    ]);
  });

  test("with sql=, every fence stays in the body", () => {
    const q = component(parseBlocks(QUERY));
    const { sql, body } = splitQuerySql(q.children, true);
    expect(sql).toBeNull();
    expect(body).toBe(q.children);
  });

  test("a sql fence inside a nested component does not move", () => {
    const md = ['<Query id="Q-1">', "", "<Fold title=\"x\">", "", fence("sql", "SELECT 9;"), "", "</Fold>", "", "</Query>"].join("\n");
    expect(splitQuerySql(component(parseBlocks(md)).children, false).sql).toBeNull();
  });

  test("Fold › Query › Fold parses all three levels", () => {
    const md = [
      '<Fold title="outer">',
      "",
      '<Query id="Q-2" csv="a.csv">',
      "",
      '<Fold title="inner">',
      "",
      "deep",
      "",
      "</Fold>",
      "",
      "</Query>",
      "",
      "</Fold>",
    ].join("\n");
    const outer = component(parseBlocks(md));
    const query = component(outer.children);
    const inner = component(query.children);
    expect([outer.name, query.name, inner.name]).toEqual(["Fold", "Query", "Fold"]);
    expect(queryFileRefs(parseBlocks(md))).toEqual(["a.csv"]);
    const html = formatWebHtml(md);
    expect(html).toContain('<section class="query" id="q-2">');
    expect(html.match(/<details class="fold">/g)).toHaveLength(2);
  });
});

describe("queryFileRefs", () => {
  test("csv and sql at any depth, deduplicated, in source order", () => {
    const md = [
      '<Query id="A" csv="r/a.csv" sql="r/a.sql">',
      "",
      "</Query>",
      "",
      '<Historic since="x">',
      "",
      '<Query id="B" csv="r/b.csv">',
      "",
      "</Query>",
      "",
      '<Query id="C" csv="r/a.csv">',
      "",
      "</Query>",
      "",
      "</Historic>",
    ].join("\n");
    expect(queryFileRefs(parseBlocks(md))).toEqual(["r/a.csv", "r/a.sql", "r/b.csv"]);
  });

  test("a Query written inside a code fence names nothing", () => {
    const md = fence("mdx", '<Query id="Q-X" csv="../../etc/hosts.csv">\n\n</Query>');
    expect(queryFileRefs(parseBlocks(md))).toEqual([]);
  });
});

describe("checkPageFileRef", () => {
  test("relative paths with an allowed extension pass, `..` included (containment is the loader's)", () => {
    expect(checkPageFileRef("res/Q-8.csv")).toBe("ok");
    expect(checkPageFileRef("../x.SQL")).toBe("ok");
  });
  test("absolute, backslash, NUL and drive paths are invalid", () => {
    for (const ref of ["/etc/hosts.csv", "res\\Q.csv", "a\0.csv", "C:/x.csv", ""]) {
      expect(checkPageFileRef(ref)).toBe("invalid");
    }
  });
  test("any other extension is refused", () => {
    for (const ref of [".env", "x.env", "res/x", "a.csv/b", "x.yaml"]) expect(checkPageFileRef(ref)).toBe("extension");
  });
});

describe("Query on the web", () => {
  test("a card: header, body, a table from the CSV and the moved SQL in a closed disclosure", () => {
    const html = formatWebHtml(QUERY, {
      files: files({ "res/Q-8.csv": { ok: true, text: 'SAK,BEH\nMEL-1,"1,2"\nMEL-<2>,3\n' } }),
    });
    expect(html).toContain('<section class="query" id="q-8">');
    expect(html).toContain('<a class="query-id" href="#q-8">Q-8</a>');
    expect(html).toContain('<span class="query-question">Har de 46 sakene fått årsavregning?</span>');
    expect(html).toContain('<div class="query-answer">Tre saker (→ S1, S2).</div>');
    expect(html).toContain('<span class="query-run">run 2026-09-30</span>');
    expect(html).toContain('<span class="query-use">8045</span><span class="query-use">8306</span>');
    expect(html).toContain("<strong>dette</strong>");
    expect(html).toContain('<span class="query-rows">2 rows</span>');
    expect(html).toContain('<th scope="col">SAK</th><th scope="col">BEH</th>');
    expect(html).toContain("<tr><td>MEL-1</td><td>1,2</td></tr><tr><td>MEL-&lt;2&gt;</td><td>3</td></tr>");
    const sql = html.slice(html.indexOf('<details class="query-sql">'));
    expect(sql.startsWith('<details class="query-sql"><summary>SQL</summary>')).toBe(true);
    expect(stripTokenSpans(sql)).toContain("SELECT 1 FROM dual;");
    // The second fence stays in the reading, above the result.
    const body = html.slice(html.indexOf('<div class="query-body">'), html.indexOf('<div class="query-result">'));
    expect(stripTokenSpans(body)).toContain("SELECT 2 FROM dual;");
    expect(stripTokenSpans(body)).not.toContain("SELECT 1 FROM dual;");
  });

  test("sql= reads the file into the disclosure and leaves the inline fence in the body", () => {
    const md = QUERY.replace('csv="res/Q-8.csv"', 'csv="res/Q-8.csv" sql="res/Q-8.sql"');
    const html = formatWebHtml(md, {
      files: files({
        "res/Q-8.csv": { ok: true, text: "A\n1\n" },
        "res/Q-8.sql": { ok: true, text: "SELECT 'fil' FROM dual;\n" },
      }),
    });
    const sql = stripTokenSpans(html.slice(html.indexOf('<details class="query-sql">')));
    expect(sql).toContain("<summary>SQL <code>Q-8.sql</code></summary>");
    expect(sql).toContain("SELECT 'fil' FROM dual;");
    const body = stripTokenSpans(html.slice(html.indexOf('<div class="query-body">'), html.indexOf('<div class="query-result">')));
    expect(body).toContain("SELECT 1 FROM dual;");
  });

  test("no reader: the card says the result is not loaded here", () => {
    const html = formatWebHtml(QUERY);
    expect(html).toContain('<p class="query-unavailable">Result not loaded here: Q-8.csv</p>');
    expect(html).not.toContain("<table");
  });

  test("a missing and an outside file render the same text", () => {
    const missing = formatWebHtml(QUERY, { files: files({ "res/Q-8.csv": { ok: false, reason: "unavailable" } }) });
    const notListed = formatWebHtml(QUERY, { files: files({}) });
    expect(missing).toContain('<p class="query-unavailable">File not available: Q-8.csv</p>');
    expect(notListed).toBe(missing);
  });

  test("the other failure reasons each name themselves", () => {
    const html = (reason: "invalid" | "extension" | "too-large" | "limit") =>
      formatWebHtml(QUERY, { files: files({ "res/Q-8.csv": { ok: false, reason } }) });
    expect(html("too-large")).toContain("File over 1 MB, not shown: Q-8.csv");
    expect(html("extension")).toContain("File type not allowed: Q-8.csv");
    expect(html("invalid")).toContain("Invalid file path: Q-8.csv");
    expect(html("limit")).toContain("Over 50 files on this page, not loaded: Q-8.csv");
  });

  test(`at most ${QUERY_CSV_MAX_ROWS} rows render, with a count of the rest`, () => {
    const rows = Array.from({ length: QUERY_CSV_MAX_ROWS + 5 }, (_, i) => String(i)).join("\n");
    const html = formatWebHtml(QUERY, { files: files({ "res/Q-8.csv": { ok: true, text: `N\n${rows}\n` } }) });
    expect(html.match(/<tr><td>/g)).toHaveLength(QUERY_CSV_MAX_ROWS);
    expect(html).toContain('<p class="query-truncated">showing 2,000 of 2,005 rows</p>');
    expect(html).toContain('<span class="query-rows">2,005 rows</span>');
  });

  test("attribute text is escaped", () => {
    const html = formatWebHtml('<Query id="Q&lt;" question="<b>x</b>" uses="<i>">\n\n</Query>');
    expect(html).not.toContain("<b>x</b>");
    expect(html).not.toContain("<i>");
  });
});

describe("Query on the text surfaces (no file read)", () => {
  test("telegram", () => {
    expect(formatTelegramHtml(QUERY)).toBe(
      [
        "<b>Q-8 — Har de 46 sakene fått årsavregning?</b>",
        "Svar: Tre saker (→ S1, S2).",
        "",
        "Fag sa 30.09 at <b>dette</b> gjelder.",
        "",
        "<pre><code class=\"language-sql\">SELECT 1 FROM dual;</code></pre>",
        "",
        "<pre><code class=\"language-sql\">SELECT 2 FROM dual;</code></pre>",
        "",
        "Resultat: Q-8.csv",
      ].join("\n"),
    );
  });

  test("slack", () => {
    const out = formatSlackMrkdwn(QUERY);
    expect(out.startsWith("*Q-8 — Har de 46 sakene fått årsavregning?*\nSvar: Tre saker (→ S1, S2).\n")).toBe(true);
    expect(out).toContain("Fag sa 30.09 at *dette* gjelder.");
    expect(out.endsWith("\nResultat: Q-8.csv")).toBe(true);
  });

  test("email", () => {
    const out = formatEmailHtml(QUERY);
    expect(out).toContain(">Q-8 — Har de 46 sakene fått årsavregning?</div>");
    expect(out).toContain(">Svar: Tre saker (→ S1, S2).</div>");
    expect(out).toContain(">Resultat: Q-8.csv</div>");
  });

  test("no csv ⇒ no Resultat line", () => {
    expect(formatTelegramHtml('<Query id="Q-1" question="q">\n\nbody\n\n</Query>')).toBe("<b>Q-1 — q</b>\n\nbody");
  });
});
