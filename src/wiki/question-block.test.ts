import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildWikiIndex } from "./store.ts";
import { lintWiki, type LintFinding } from "./lint.ts";
import { questionRenderOptionsFor, renderWikiHtml } from "./render.ts";

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
    expect(html).toContain('data-question-to="Yvonne Jacobs (X111111)"');
    expect(html).toContain("Avgjort → ");
    expect(html).toContain('<li class="dl-item" id="o3">');
    // Without the option the same page renders the plain question.
    expect(renderWikiHtml(md, resolve)).toContain('class="question question-plain"');
  });
});
