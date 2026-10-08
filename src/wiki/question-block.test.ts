import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildWikiIndex } from "./store.ts";
import { lintWiki, type LintFinding } from "./lint.ts";
import { questionRenderOptionsFor, renderWikiHtml } from "./render.ts";
import { parseToAttr } from "../format/question.ts";

// The `<Question>` block's wiki half: the lint check, the `.wiki-reader.json`
// `language` key and the render option `/api/wiki/page` threads through
// `renderWikiHtml`. Every fixture is synthetic.

const NOW = Date.parse("2026-10-07T12:00:00Z");

let root: string;
const write = (rel: string, content: string) => Bun.write(path.join(root, rel), content);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "wiki-question-"));
  await mkdir(path.join(root, "plans"), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function plan(questions: string[], logItems: string[]): string {
  return [
    "---",
    "title: A plan",
    "type: plan",
    "updated: 2026-10-01",
    'questions_to: ["Yvonne Jacobs (X111111)", "Ola Nordmann"]',
    "---",
    "",
    ...questions.flatMap((q) => [q, "", "Question text?", "", "</Question>", ""]),
    "<DecisionLog>",
    "",
    "- **D99** — A decision.",
    ...logItems,
    "",
    "</DecisionLog>",
    "",
  ].join("\n");
}

async function questionFindings(): Promise<LintFinding[]> {
  const index = await buildWikiIndex(root);
  return (await lintWiki(index, { now: () => NOW })).findings.filter((f) => f.check === "question-block");
}

describe("lint: question-block", () => {
  test("a clean page with a canonical close reports nothing", async () => {
    await write("plans/clean.mdx", plan(['<Question id="O3">'], ["- **O3** — Keep it? Closed 2026-10-08 (D99)."]));
    expect(await questionFindings()).toEqual([]);
  });

  test("a <Question> id with no DecisionLog item", async () => {
    await write("plans/p.mdx", plan(['<Question id="O7">'], ["- **O3** — Something else."]));
    const f = await questionFindings();
    expect(f.map((x) => [x.relPath, x.message, x.line])).toEqual([
      ["plans/p.mdx", '<Question id="O7"> has no item in the page\'s <DecisionLog>, so its card can never close', 8],
    ]);
  });

  test("a duplicate <Question> id, reported once", async () => {
    await write("plans/p.mdx", plan(['<Question id="O3">', '<Question id="O3">'], ["- **O3** — Keep it?"]));
    const f = await questionFindings();
    expect(f.map((x) => x.message)).toEqual(["2 <Question> blocks use id O3; an answer to that id is refused"]);
  });

  test("a <Question> with no id", async () => {
    await write("plans/p.mdx", plan(["<Question>"], []));
    const f = await questionFindings();
    expect(f.map((x) => [x.message, x.line])).toEqual([
      ["a <Question> has no id, so its card cannot name a DecisionLog item", 8],
    ]);
  });

  test("D6's near-miss close: a colon between date and decision", async () => {
    await write("plans/p.mdx", plan(['<Question id="O3">'], ["- **O3** — Keep it? Closed 2026-10-08: B (D99)"]));
    const f = await questionFindings();
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toBe(
      'DecisionLog item O3 says "Closed" but no canonical close (Closed <date> (Dn).), so its card stays open',
    );
  });

  test("D6's near-miss close: struck question text with Besvart", async () => {
    await write("plans/p.mdx", plan(['<Question id="O3">'], ["- **O3** — ~~Keep it?~~ Besvart 06.10: ja."]));
    expect((await questionFindings()).map((x) => x.message)).toEqual([
      'DecisionLog item O3 says "Besvart" but no canonical close (Closed <date> (Dn).), so its card stays open',
    ]);
  });

  test("no near miss on the stay-open shapes that are not closes", async () => {
    await write(
      "plans/p.mdx",
      plan(
        ['<Question id="O3">', '<Question id="S2">', '<Question id="O4">'],
        [
          "- **O3** — Keep it? closed 2026-10-08 (D99), and `Closed 2026-10-08: x (D99)` quoted.",
          "- **S2** — Skal sakene henlegges? Spurt 30.09, aldri besvart direkte.",
          "- **O4** — Does this reopen a closed item?",
        ],
      ),
    );
    expect(await questionFindings()).toEqual([]);
  });

  test("an item WITHOUT a <Question> is never checked — the free-text closes already in the wikis", async () => {
    await write("plans/p.mdx", plan([], ["- **O3** — Besvart 06.10: ja. Closed: chose B."]));
    expect(await questionFindings()).toEqual([]);
  });

  test("a <Question> quoted in a fence or in backticks is documentation", async () => {
    await write(
      "plans/p.mdx",
      ["# Doc", "", "```markdown", '<Question id="O9">', "", "Q", "", "</Question>", "```", "", "Inline `<Question id=\"O9\">` too."].join("\n"),
    );
    expect(await questionFindings()).toEqual([]);
  });
});

describe("the render option", () => {
  test("language comes from .wiki-reader.json; a bad value warns and falls back to en", async () => {
    await write(".wiki-reader.json", JSON.stringify({ language: "no" }));
    expect((await buildWikiIndex(root)).readerConfig?.language).toBe("no");
    await write(".wiki-reader.json", JSON.stringify({ language: "sv" }));
    expect((await buildWikiIndex(root)).readerConfig?.language).toBe("en");
    await write(".wiki-reader.json", JSON.stringify({}));
    expect((await buildWikiIndex(root)).readerConfig?.language).toBe("en");
  });

  test("questionRenderOptionsFor reads questions_to: from the frontmatter and the language from the config", async () => {
    await write(".wiki-reader.json", JSON.stringify({ language: "no" }));
    const md = plan(['<Question id="O3">'], ["- **O3** — Keep it?"]);
    const o = questionRenderOptionsFor(md, (await buildWikiIndex(root)).readerConfig, false);
    expect(o).toEqual({
      questionsTo: [
        { name: "Yvonne Jacobs", ident: "X111111" },
        { name: "Ola Nordmann", ident: null },
      ],
      language: "no",
      answerable: false,
    });
    expect(questionRenderOptionsFor("No frontmatter.", null, true)).toEqual({ questionsTo: [], language: "en", answerable: true });
  });

  test("renderWikiHtml threads the option into the card", async () => {
    const md = plan(['<Question id="O3">'], ["- **O3** — Lukket 08.10 (D99)."]);
    const resolve = () => undefined;
    const html = renderWikiHtml(md, resolve, {
      question: { questionsTo: [{ name: "Yvonne Jacobs", ident: "X111111" }], language: "no", answerable: true },
    });
    expect(html).toContain('class="question q-decided"');
    expect(html).toContain('data-wiki-answerable="true"');
    expect(html).toContain('data-question-to="Yvonne Jacobs"');
    expect(html).toContain("Avgjort → ");
    expect(html).toContain('<li class="dl-item" id="o3">');
    // Without the option the same page renders the plain question.
    expect(renderWikiHtml(md, resolve)).toContain('class="question question-plain"');
  });
});

// ── Fix round 1 ────────────────────────────────────────────────────────────

describe("fix round 1: lint", () => {
  test("a near miss on a dimmed item says the card shows Closed, not that it stays open", async () => {
    await write("plans/p.mdx", plan(['<Question id="O3">'], ["- **O3** — ~~Keep it? Besvart 06.10: ja.~~"]));
    expect((await questionFindings()).map((x) => x.message)).toEqual([
      'DecisionLog item O3 says "Besvart" but has no canonical close naming a decision this page defines, so its card shows Closed without a decision',
    ]);
  });

  test("a near miss beside a canonical close names the decided state", async () => {
    await write("plans/p.mdx", plan(['<Question id="O3">'], ["- **O3** — Besvart 06.10. Closed 2026-10-08 (D99)."]));
    expect((await questionFindings()).map((x) => x.message)).toEqual([
      'DecisionLog item O3 says "Besvart" outside its canonical close; the card shows Decided → D99',
    ]);
  });

  test("a code span between Closed and its date is a near miss", async () => {
    await write("plans/p.mdx", plan(['<Question id="O3">'], ["- **O3** — Keep it? Closed `x` 2026-10-08 (D99)."]));
    expect((await questionFindings()).map((x) => x.message)).toEqual([
      'DecisionLog item O3 says "Closed" but no canonical close (Closed <date> (Dn).), so its card stays open',
    ]);
  });

  test("a later duplicate DecisionLog item for a question's id is named, not silent", async () => {
    await write("plans/p.mdx", plan(['<Question id="O3">'], ["- **O3** — opened.", "- **O3** — Closed 2026-10-08 (D99)."]));
    expect((await questionFindings()).map((x) => x.message)).toEqual([
      'DecisionLog has 2 items for O3 ("opened.", "Closed 2026-10-08 (D99).") — the first decides the card; the others are ignored',
    ]);
  });

  test("a questions_to: block list is reported with the inline-list form", async () => {
    const md = plan(['<Question id="O3">'], ["- **O3** — Keep it?"]).replace(
      'questions_to: ["Yvonne Jacobs (X111111)", "Ola Nordmann"]',
      "questions_to:\n  - Yvonne Jacobs (X111111)\n  - Ola Nordmann",
    );
    await write("plans/p.mdx", md);
    expect((await questionFindings()).map((x) => [x.message, x.line])).toEqual([
      [
        'frontmatter questions_to: is not an inline list, so no card names who it is for; write it as questions_to: ["Name (IDENT)", "Name"]',
        5,
      ],
    ]);
  });

  test("a <Question> quoted in a fence above the real one does not take its line", async () => {
    const md = plan(['<Question id="O7">'], ["- **O3** — Something else."]).replace(
      "\n\n<Question",
      '\n\n```markdown\n<Question id="O7">\n```\n\n<Question',
    );
    await write("plans/p.mdx", md);
    expect((await questionFindings()).map((x) => x.line)).toEqual([12]);
  });

  test("each id-less <Question> gets its own line", async () => {
    await write("plans/p.mdx", plan(["<Question>", "<Question>"], []));
    expect((await questionFindings()).map((x) => x.line)).toEqual([8, 14]);
  });
});

describe("fix round 1: renderWikiHtml", () => {
  test("a wikilink in choices= or to= stays text inside the card's data attributes", () => {
    const md = [
      '<Question id="O1" choices="[[Foo]]|B" to="[[Bar]] (X1)">',
      "",
      "Q?",
      "",
      "</Question>",
      "",
      "<DecisionLog>",
      "",
      "- **O1** — Q?",
      "",
      "</DecisionLog>",
    ].join("\n");
    const meta = (name: string) => ({ name, relPath: `${name.toLowerCase()}.md` }) as never;
    const html = renderWikiHtml(md, (t) => (t === "Foo" || t === "Bar" ? meta(t) : undefined), {
      question: { questionsTo: [], language: "en", answerable: false },
    });
    const tag = /<section class="question[^>]*>/.exec(html)?.[0] ?? "";
    expect(tag).toMatch(/^<section class="question q-open"(?: data-[a-z-]+="[^"<>]*")+>$/);
    expect(tag).toContain('data-question-choices="[[Foo]]|B"');
    expect(tag).toContain('data-question-to="[[Bar]]"');
    // Outside the tag the same link still renders as a link.
    expect(html).toContain('<div class="q-for"><span class="q-for-label">For</span> <a href="/wiki?relPath=bar.md" class="wiki-link"');
  });
});

// ── Fix round 2 ────────────────────────────────────────────────────────────

/** The 1-based line of the first line of `md` equal to `text`. */
const lineOfText = (md: string, text: string) => md.split("\n").indexOf(text) + 1;

describe("fix round 2: lint lines", () => {
  // Each broken shape shares the real block's id, so the per-id placement
  // cannot rescue a tag test that reads it as a block.
  const broken: [string, string][] = [
    ["a self-closing tag", '<Question id="O7" />'],
    ["an open tag with text after it, closed below", '<Question id="O7"> Keep it?\n\n</Question>'],
    ["a one-line tag with text after its close", '<Question id="O7">Keep it?</Question> trailing'],
    ["an unclosed open tag", '<Question id="O7">'],
  ];
  for (const [label, shape] of broken) {
    test(`${label} does not cost the real block its line`, async () => {
      const md = plan(['<Question id="O7">'], ["- **O3** — Something else."]).replace("\n\n<Question", `\n\n${shape}\n\n<Question`);
      await write("plans/p.mdx", md);
      const real = md.split("\n").lastIndexOf('<Question id="O7">') + 1;
      expect((await questionFindings()).map((x) => [x.message, x.line])).toEqual([
        ['<Question id="O7"> has no item in the page\'s <DecisionLog>, so its card can never close', real],
      ]);
    });
  }

  test("a self-closing tag inside a block's body does not nest", async () => {
    const md = plan(['<Question id="O7">'], ["- **O3** — Something else."]).replace(
      "Question text?",
      'Question text?\n\n<Question id="O7" />',
    );
    await write("plans/p.mdx", md);
    expect((await questionFindings()).map((x) => x.line)).toEqual([lineOfText(md, '<Question id="O7">')]);
  });

  test("when the tags and the blocks still disagree, each id is placed on its own", async () => {
    let deep = '<Question id="DEEP">\n\nQ?\n\n</Question>';
    for (let i = 0; i < 3; i++) deep = `<Callout type="note">\n\n${deep}\n\n</Callout>`;
    const md = plan(['<Question id="O7">'], ["- **O3** — Something else."]).replace("\n\n<Question", `\n\n${deep}\n\n<Question`);
    await write("plans/p.mdx", md);
    expect((await questionFindings()).map((x) => x.line)).toEqual([lineOfText(md, '<Question id="O7">')]);
  });

  test("an indented tag and a tag inside an HTML comment are blocks to the parser, and keep their lines", async () => {
    const md = plan(['    <Question id="O7">'], ["- **O3** — Something else."]).replace(
      "<DecisionLog>",
      '<!--\n<Question id="O8">\n\nQuestion text?\n\n</Question>\n-->\n\n<DecisionLog>',
    );
    await write("plans/p.mdx", md);
    expect((await questionFindings()).map((x) => x.line)).toEqual([
      lineOfText(md, '    <Question id="O7">'),
      lineOfText(md, '<Question id="O8">'),
    ]);
  });

  test("a <Question> quoted in the frontmatter does not take the real block's line", async () => {
    const md = plan(['<Question id="O7">'], ["- **O3** — Something else."]).replace(
      "updated: 2026-10-01\n",
      'updated: 2026-10-01\ndescription: |\n  <Question id="O7">Quoted?</Question>\n',
    );
    await write("plans/p.mdx", md);
    expect((await questionFindings()).map((x) => x.line)).toEqual([lineOfText(md, '<Question id="O7">')]);
  });
});

describe("fix round 2: near-miss wording", () => {
  test("a reopened item says it was reopened, not that it has no canonical close", async () => {
    await write(
      "plans/p.mdx",
      plan(['<Question id="O3">'], ["- **O3** — Besvart 06.10. Closed 2026-10-08 (D99). Reopened 2026-10-09."]),
    );
    expect((await questionFindings()).map((x) => x.message)).toEqual([
      'DecisionLog item O3 says "Besvart" outside its canonical phrases; its last canonical phrase reopens it (Reopened <date>.), so its card stays open',
    ]);
  });

  test("a near miss in a sub-bullet under the item is reported", async () => {
    await write("plans/p.mdx", plan(['<Question id="O3">'], ["- **O3** — Keep it?\n  - Besvart 06.10: ja."]));
    expect((await questionFindings()).map((x) => x.message)).toEqual([
      'DecisionLog item O3 says "Besvart" but no canonical close (Closed <date> (Dn).), so its card stays open',
    ]);
  });
});

describe("fix round 2: renderWikiHtml attributes", () => {
  const render = (tag: string) => {
    const md = [tag, "", "Q?", "", "</Question>", "", "<DecisionLog>", "", "- **O1** — Q?", "", "</DecisionLog>"].join("\n");
    const meta = (name: string) => ({ name, relPath: `${name.toLowerCase()}.md` }) as never;
    const html = renderWikiHtml(md, (t) => meta(t.split("|")[0]!), {
      question: { questionsTo: [], language: "en", answerable: false },
    });
    return /<section class="question[^>]*>/.exec(html)?.[0] ?? "";
  };

  test("a wikilink alias in to= reads back as one target", () => {
    const tag = render('<Question id="O1" to="[[Bar|Alias]] (X1)">');
    const to = /data-question-to="([^"]*)"/.exec(tag)?.[1] ?? "";
    expect(to).toBe("[[Bar|Alias]]");
    expect(parseToAttr(to)).toEqual([{ name: "[[Bar|Alias]]", ident: null }]);
  });

  test("a restored wikilink is escaped inside the attribute", () => {
    const tag = render('<Question id="O1" choices="[[A<b]]|B" to="[[C&d]] (X1)">');
    expect(tag).toMatch(/^<section class="question q-open"(?: data-[a-z-]+="[^"<>]*")+>$/);
    expect(tag).toContain('data-question-choices="[[A&lt;b]]|B"');
    expect(tag).toContain('data-question-to="[[C&amp;d]]"');
  });
});
