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
      'questions_to: names "jus", which is not in .wiki-reader.json roleKeys (fag); a question to it asks nobody',
      '<Question to=> names "utvikler", which is not in .wiki-reader.json roleKeys (fag); a question to it asks nobody',
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
});
