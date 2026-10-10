import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildWikiIndex } from "./store.ts";
import { lintWiki } from "./lint.ts";

const NOW = Date.parse("2026-10-09T12:00:00Z");
let root: string;
const write = (rel: string, content: string) => Bun.write(path.join(root, rel), content);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "wiki-case-board-lint-"));
  await mkdir(path.join(root, "plans"), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const page = (fm: string[], body: string[]) =>
  ["---", "title: A plan", "type: plan", "updated: 2026-10-01", ...fm, "---", "", ...body, ""].join("\n");

// Check 13, `case-board-labels` (D42): a `<CaseBoard labels=>` entry that is
// not `status:label` with a case status.
describe("lint: case-board-labels", () => {
  const findings = async () => {
    const index = await buildWikiIndex(root);
    return (await lintWiki(index, { now: () => NOW })).findings.filter((f) => f.check === "case-board-labels");
  };

  test("an unknown key and a malformed entry are named on the board's line; status keys are clean", async () => {
    await write(
      "plans/p.mdx",
      page([], ["Tekst.", "", '<CaseBoard src="c.yaml" labels="hold:holdt ute,venter:x,ok:ok,none" />']),
    );
    const f = await findings();
    expect(f.map((x) => x.message.split(" is not")[0])).toEqual([
      '<CaseBoard labels=> entry "venter:x"',
      '<CaseBoard labels=> entry "none"',
    ]);
    expect(f[0]!.message).toContain("hold, wait, wrong, none, ok");
    // 5 frontmatter lines + blank, then the body's third line.
    expect(f[0]!.line).toBe(6 + 1 + 2);
  });

  test("a board with valid labels, or none, and one quoted in a fence are clean", async () => {
    await write(
      "plans/p.mdx",
      page([], [
        '<CaseBoard src="c.yaml" labels="hold:holdt ute,wait:venter,wrong:feil,none:ikke kandidat,ok:ok" />',
        "",
        '<CaseBoard src="d.yaml" />',
        "",
        "```",
        '<CaseBoard src="c.yaml" labels="bogus:x" />',
        "```",
      ]),
    );
    expect(await findings()).toEqual([]);
  });

  test("fix round 1, item 18: a key given twice is named; the last label applies", async () => {
    await write("plans/p.mdx", page([], ['<CaseBoard src="c.yaml" labels="hold:holdt ute,wait:venter,HOLD:holdt" />']));
    const f = await findings();
    expect(f.map((x) => x.message)).toEqual([
      '<CaseBoard labels=> key "hold" is given more than once; the last label, "holdt", applies',
    ]);
    expect(f[0]!.line).toBe(6 + 1);
  });
});
