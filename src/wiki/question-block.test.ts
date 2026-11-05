import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildWikiIndex } from "./store.ts";
import { lintWiki, type LintFinding } from "./lint.ts";
import { questionRenderOptionsFor, renderWikiHtml } from "./render.ts";
import { parseToAttr } from "../format/question.ts";
import { testTempDir } from "../test/temp-dir.ts";

// The `<Question>` block's wiki half: the lint check, the `.wiki-reader.json`
// `language` key and the render option `/api/wiki/page` threads through
// `renderWikiHtml`. Every fixture is synthetic.

const NOW = Date.parse("2026-10-07T12:00:00Z");

let root: string;
const write = (rel: string, content: string) => Bun.write(path.join(root, rel), content);

beforeEach(async () => {
  root = await testTempDir(path.join(tmpdir(), "wiki-question-"));
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
    'questions_to: ["Synne Testdal (X111111)", "Ola Nordmann"]',
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

describe("lint: question-block, a card its page already answered", () => {
  const messagesFor = async (items: string[], questions = ['<Question id="O3">']): Promise<string[]> => {
    await write("plans/p.mdx", plan(questions, items));
    return (await questionFindings()).map((x) => x.message);
  };
  const addDecision = (id: string, word: string) =>
    `DecisionLog item ${id} says "${word}" but its card stays open and no decision's first sentence names ${id} as ruled. If this is a ruling, write Closed <date> (Dn). in item ${id}, naming the decision that records it or one you add; if it is not, leave the card open`;
  const rules = (d: string, id: string) =>
    `Decision ${d} already rules on ${id} but its card stays open; write Closed <date> (${d}). in item ${id}`;

  for (const word of ["answered", "besvart", "avgjort", "decided", "AVGJORT", "Decided"]) {
    test(`its own item holds «${word}»`, async () => {
      expect(await messagesFor([`- **O3** — Keep it? Asked Kari; **${word} A on 01.10**.`])).toEqual([addDecision("O3", word)]);
    });
  }

  for (const [name, sentence] of [
    ["an arrow", "Keep the old path (O3 → B). Kari, 01.10."],
    ["an arrow with no space", "Keep the old path (O3→B). Kari, 01.10."],
    ["an equals sign", "Keep the old path, O3 = B. Kari, 01.10."],
    ["avgjort", "O3 avgjort med B, den gamle veien står. Kari, 01.10."],
    ["a bold id", "**O3** → B, the old path stays. Kari, 01.10."],
    ["Answer and card", "Answer on card O3: the old path stays. Kari, 01.10."],
    ["Svar and kortet", "Svar på kortet O3: den gamle veien står. Kari, 01.10."],
  ] as const) {
    test(`a decision's first sentence names the id with ${name}`, async () => {
      expect(await messagesFor(["- **O3** — Keep it?", `- **D5** — ${sentence}`])).toEqual([rules("D5", "O3")]);
    });
  }

  test("the first sentence is read past the dots in a code span", async () => {
    expect(await messagesFor(["- **O3** — Keep it?", "- **D5** — Bind to `10.0.0.1` on the host (O3 → B). Kari, 01.10."])).toEqual([
      rules("D5", "O3"),
    ]);
  });

  test("a decision also ruling names the decision, not the add-one-first message", async () => {
    expect(await messagesFor(["- **O3** — Keep it? Answered in chat, decided A.", "- **D5** — The old path stays (O3 → A)."])).toEqual([
      'DecisionLog item O3 says "Answered" but no canonical close (Closed <date> (Dn).), so its card stays open',
    ]);
    expect(await messagesFor(["- **O3** — Keep it? decided A in chat.", "- **D5** — The old path stays (O3 → A)."])).toEqual([rules("D5", "O3")]);
  });

  test("the last decision naming the id is the one to close with", async () => {
    expect(await messagesFor(["- **O3** — Keep it?", "- **D5** — First go at this (O3 → A).", "- **D6** — Second go at this (O3 → B)."])).toEqual([
      rules("D6", "O3"),
    ]);
  });

  test("a superseded decision hands the close to its successor", async () => {
    expect(
      await messagesFor(["- **O3** — Keep it?", "- **D5** — Bind the UIs here (O3 → B). Superseded by D6: the bind fails.", "- **D6** — Bind on loopback instead."]),
    ).toEqual(["Decision D5, superseded by D6, already rules on O3 but its card stays open; write Closed <date> (D6). in item O3"]);
  });

  test("the canonical close reports nothing, whatever else the page says", async () => {
    expect(await messagesFor(["- **O3** — Keep it? answered A. Closed 2026-10-08 (D5).", "- **D5** — The old path stays (O3 → A)."])).toEqual([]);
  });

  for (const negated of [
    "ikke besvart",
    "ikke avgjort",
    "not answered",
    "not decided",
    "not yet decided",
    "to be decided",
    "to be answered",
    "ikke **avgjort**",
    "NOT decided",
    "aldri besvart",
    "never answered",
  ]) {
    test(`a negated word stays silent: ${negated}`, async () => {
      // "not answered" holds no capitalised Answered, so no near miss fires either.
      expect(await messagesFor([`- **O3** — Keep it? Still ${negated}.`])).toEqual([]);
    });
  }

  test("a negated word and a plain one in one item flags the plain one", async () => {
    expect(await messagesFor(["- **O3** — Keep it? Not decided on 01.10, decided A on 03.10."])).toEqual([addDecision("O3", "decided")]);
  });

  for (const [name, items] of [
    ["a decision the item cites but no shape reads", ["- **O3** — Keep it? Avgjort 06.10 (D5).", "- **D5** — The old path stays."]],
    ["a decision naming the card in passing", ["- **O3** — Keep it? answered A.", "- **D1** — Build the script (O3 A)."]],
  ] as const) {
    test(`the message claims only what it checked: ${name}`, async () => {
      const [message, ...rest] = await messagesFor([...items]);
      expect(rest).toEqual([]);
      expect(message).toContain("no decision's first sentence names O3 as ruled");
      expect(message).not.toContain("no decision records");
      expect(message).toContain("naming the decision that records it");
      expect(message).toContain("or one you add");
      expect(message).toContain("if it is not, leave the card open");
    });
  }

  test("a struck word and a question draw no finding at all", async () => {
    expect(await messagesFor(["- **O3** — Keep it? ~~decided A~~ taken back. Who decided this?"])).toEqual([]);
  });

  test("a near miss on Answered or Besvart gets no second finding", async () => {
    expect(await messagesFor(["- **O3** — Keep it? Besvart 06.10: ja."])).toEqual([
      'DecisionLog item O3 says "Besvart" but no canonical close (Closed <date> (Dn).), so its card stays open',
    ]);
    expect(await messagesFor(["- **O3** — Keep it? Answered 06.10, avgjort A."])).toEqual([
      'DecisionLog item O3 says "Answered" but no canonical close (Closed <date> (Dn).), so its card stays open',
    ]);
  });

  test("a near miss on Closed alone does not hide the ruling", async () => {
    expect(await messagesFor(["- **O3** — Keep it? Closed 2026-10-08: B.", "- **D5** — The old path stays (O3 → B)."])).toEqual([
      'DecisionLog item O3 says "Closed" but no canonical close (Closed <date> (Dn).), so its card stays open',
      rules("D5", "O3"),
    ]);
  });

  for (const [name, decision] of [
    ["a mere mention with a verb", "- **D5** — Use the existing switch for everything here. O3 kan endre foo-delen. Kari, 01.10."],
    ["a mention in the first sentence", "- **O9** — O3 kan endre foo-delen."],
    ["a decision mentioning it in its first sentence", "- **D5** — O3 kan endre foo-delen, og resten står."],
    ["the arrow in the second sentence", "- **D5** — The old path stays for now. Later O3 → B may follow."],
    ["the arrow in a code span", "- **D5** — The form is `O3 → B` on every page."],
    ["another id", "- **D5** — The old path stays (O31 → B, PO3 → B, O3.1 → B)."],
    ["an id not right before the arrow", "- **D5** — O3 and the rest → B is the idea."],
    ["card without Answer", "- **D5** — See card O3 for the options."],
    ["Answer without card", "- **D5** — Answer O3 when the options are in."],
    ["a code span between id and arrow", "- **D5** — O3 `x` → B here."],
  ] as const) {
    test(`silent: ${name}`, async () => {
      expect(await messagesFor(["- **O3** — Keep it?", decision])).toEqual([]);
    });
  }

  test("silent: the ruling word only in a code span", async () => {
    expect(await messagesFor(["- **O3** — Keep it? The form is `answered A`."])).toEqual([]);
  });

  test("silent: a struck ruling with nothing replacing it", async () => {
    expect(await messagesFor(["- **O3** — Keep it?", "- **D5** — ~~O3 → A here.~~ Snudd 15.10."])).toEqual([]);
    expect(await messagesFor(["- **O3** — Keep it?", "- ~~**D5** — O3 → A here.~~"])).toEqual([]);
  });

  test("silent: a reopened card, whose ruling was taken back", async () => {
    expect(await messagesFor(["- **O3** — Keep it? Closed 2026-10-08 (D5). Reopened 2026-10-09.", "- **D5** — The old path stays (O3 → A)."])).toEqual([]);
  });

  test("a closed card is left alone", async () => {
    expect(await messagesFor(["- ~~**O3** — Keep it? decided A.~~", "- **D5** — The old path stays (O3 → A)."])).toEqual([]);
  });

  test("an id with no item gets only the missing-item finding", async () => {
    expect(await messagesFor(["- **D5** — The old path stays (O3 → A)."])).toEqual([
      '<Question id="O3"> has no item in the page\'s <DecisionLog>, so its card can never close',
    ]);
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
        { name: "Synne Testdal", ident: "X111111" },
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
      question: { questionsTo: [{ name: "Synne Testdal", ident: "X111111" }], language: "no", answerable: true },
    });
    expect(html).toContain('class="question q-decided"');
    expect(html).toContain('data-wiki-answerable="true"');
    expect(html).toContain('data-question-to="Synne Testdal"');
    expect(html).toContain("Avgjort → ");
    expect(html).toContain('<li class="dl-item" id="o3" data-q-state="decided">');
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
      'questions_to: ["Synne Testdal (X111111)", "Ola Nordmann"]',
      "questions_to:\n  - Synne Testdal (X111111)\n  - Ola Nordmann",
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

describe("fix round 2: a fact mark over the reopen phrase", () => {
  test("the near miss still says the item was reopened", async () => {
    await write(
      "plans/p.mdx",
      plan(
        ['<Question id="O3">'],
        ['- **O3** — Besvart 06.10. Closed 2026-10-08 (D99). <Fact n="2" v="ok">Reopened 2026-10-09</Fact>.'],
      ),
    );
    expect((await questionFindings()).map((x) => x.message)).toEqual([
      'DecisionLog item O3 says "Besvart" outside its canonical phrases; its last canonical phrase reopens it (Reopened <date>.), so its card stays open',
    ]);
  });
});
