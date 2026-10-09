import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildWikiIndex } from "./store.ts";
import { lintWiki, type LintFinding } from "./lint.ts";

// Check 12, `role-key` (D32): `<Lane role=>` and role entries in `to=` and
// `questions_to:` against `.wiki-reader.json` `roleKeys`. Synthetic fixtures.

const NOW = Date.parse("2026-10-09T12:00:00Z");
let root: string;
const write = (rel: string, content: string) => Bun.write(path.join(root, rel), content);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "wiki-role-key-"));
  await mkdir(path.join(root, "plans"), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const page = (fm: string[], body: string[]) =>
  ["---", "title: A plan", "type: plan", "updated: 2026-10-01", ...fm, "---", "", ...body, ""].join("\n");

const LANES = [
  "<NextMoves>",
  "",
  '<Lane kind="waiting" role="fag">',
  "",
  "- **S1** — A eller B?",
  "",
  "</Lane>",
  "",
  '<Lane kind="you" role="jurist">',
  "",
  "- Do it.",
  "",
  "</Lane>",
  "",
  "</NextMoves>",
];

async function roleFindings(): Promise<LintFinding[]> {
  const index = await buildWikiIndex(root);
  return (await lintWiki(index, { now: () => NOW })).findings.filter((f) => f.check === "role-key");
}

describe("lint: role-key", () => {
  test("a role= outside roleKeys is named with its line; a listed one is clean", async () => {
    await write(".wiki-reader.json", JSON.stringify({ roleKeys: ["fag", "utvikler"] }));
    await write("plans/p.mdx", page([], LANES));
    const f = await roleFindings();
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toContain('<Lane role="jurist">');
    expect(f[0]!.message).toContain("roleKeys (fag, utvikler)");
    // Line of the jurist tag: 5 frontmatter lines + blank, then LANES[8].
    expect(f[0]!.line).toBe(6 + 1 + 8);
  });

  test("a wiki with no roleKeys flags every role= and nothing in to=/questions_to:", async () => {
    await write(
      "plans/p.mdx",
      page(['questions_to: ["fag"]'], [...LANES, "", '<Question id="S1" to="fag">', "Q?", "</Question>"]),
    );
    const f = await roleFindings();
    expect(f.map((x) => x.message.slice(0, 22))).toEqual(['<Lane role="fag"> name', '<Lane role="jurist"> n']);
    expect(f[0]!.message).toContain("declares none");
  });

  test("to= and questions_to: role entries are checked; names and ident entries are not", async () => {
    await write(".wiki-reader.json", JSON.stringify({ roleKeys: ["fag"] }));
    await write(
      "plans/p.mdx",
      page(
        ['questions_to: ["fag", "jus", "Kari Nordmann", "Ola (X111111)"]'],
        ['<Question id="S1" to="fag|utvikler|Rune">', "Q?", "</Question>"],
      ),
    );
    const f = await roleFindings();
    expect(f.map((x) => x.message)).toEqual([
      'questions_to: names "jus", which is not in .wiki-reader.json roleKeys (fag); add it to roleKeys if it is a WIKI_ANSWER_GROUPS group key, or write a person as Name (IDENT)',
      '<Question to=> names "utvikler", which is not in .wiki-reader.json roleKeys (fag); add it to roleKeys if it is a WIKI_ANSWER_GROUPS group key, or write a person as Name (IDENT)',
    ]);
    expect(f[0]!.line).toBe(5);
  });

  test("a role= that is no key says the lane falls back to who=", async () => {
    await write(".wiki-reader.json", JSON.stringify({ roleKeys: ["fag"] }));
    await write("plans/p.mdx", page([], ["<NextMoves>", "", '<Lane kind="you" role="two words" who="Du">', "", "- x", "", "</Lane>", "", "</NextMoves>"]));
    const f = await roleFindings();
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toContain("is not a role key");
  });

  test("each finding names its own line: the second question, the questions_to: entry, each lane", async () => {
    await write(".wiki-reader.json", JSON.stringify({ roleKeys: ["utvikler"] }));
    await write(
      "plans/p.mdx",
      page(
        ["tags: [fagavklaring, fag]", 'questions_to: ["Kari Nordmann", "fag"]'],
        [
          '<Question id="S1" to="utvikler">',
          "Q?",
          "</Question>",
          "",
          '<Question id="S2" to="jus">',
          "Q?",
          "</Question>",
          "",
          "```",
          '<Lane kind="you" role="kode">',
          "```",
          "",
          "<NextMoves>",
          "",
          '<Lane kind="you" role="jurist">',
          "",
          "- a",
          "",
          "</Lane>",
          "",
          '<Lane kind="waiting" who="Venter" role="jurist">',
          "",
          "- b",
          "",
          "</Lane>",
          "",
          "</NextMoves>",
        ],
      ),
    );
    const f = await roleFindings();
    // Frontmatter is lines 1–7 (tags on 5, questions_to on 6), a blank on 8;
    // body line k is 9 + k. The fenced <Lane> is no lane.
    expect(f.map((x) => [x.message.slice(0, 18), x.line])).toEqual([
      ["questions_to: name", 6],
      ["<Question to=> nam", 13],
      ['<Lane role="jurist', 23],
      ['<Lane role="jurist', 29],
    ]);
  });

  test("the messages say what to do and claim no effect the reader does not have", async () => {
    await write(".wiki-reader.json", JSON.stringify({ roleKeys: ["fag"] }));
    await write("plans/p.mdx", page(['questions_to: ["jus"]'], [...LANES, "", '<Question id="S1" to="utvikler">', "Q?", "</Question>"]));
    const messages = (await roleFindings()).map((x) => x.message);
    for (const m of messages) {
      expect(m).toContain("not in .wiki-reader.json roleKeys (fag)");
      expect(m).not.toMatch(/asks nobody|no viewer's lane is marked/);
    }
    expect(messages.find((m) => m.startsWith("<Lane"))).toContain("add it to roleKeys if it is a WIKI_ANSWER_GROUPS group key");
    expect(messages.find((m) => m.startsWith("<Question"))).toContain("write a person as Name (IDENT)");
  });
});
