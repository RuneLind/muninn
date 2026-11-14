import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDir } from "../test/temp-dir.ts";
import { checkPlanFold, foldedIntoNamed, parseFoldCheck } from "./lint-fold.ts";
import { LINT_CHECKS, lintWiki } from "./lint.ts";
import { buildWikiIndex } from "./store.ts";

const CFG = { since: "2026-11-14" };
const shipped = (status_date: string | undefined, relPath = "plans/p.mdx") => ({ relPath, plan_status: "shipped", status_date });

test("foldedIntoNamed: a flow list, a bare link, `none` and a block list name something", () => {
  expect(foldedIntoNamed('title: P\nfolded_into: ["[[projects/x/reader]]"]\ntags: [a]')).toBe(true);
  expect(foldedIntoNamed('folded_into: "[[projects/x/reader]]"')).toBe(true);
  expect(foldedIntoNamed("folded_into: none")).toBe(true);
  expect(foldedIntoNamed("folded_into : none # a one-off run")).toBe(true);
  expect(foldedIntoNamed('folded_into:\n  - "[[projects/x/reader]]"\ntags: [a]')).toBe(true);
  expect(foldedIntoNamed('folded_into:\r\n  - "[[a]]"\r\n')).toBe(true);
});

test("foldedIntoNamed: no key, a bare key, an empty list, a comment and another key's lines name nothing", () => {
  expect(foldedIntoNamed(null)).toBe(false);
  expect(foldedIntoNamed("title: P\ntags: [a]")).toBe(false);
  expect(foldedIntoNamed("folded_into:\ntags: [a]")).toBe(false);
  expect(foldedIntoNamed("folded_into: []")).toBe(false);
  expect(foldedIntoNamed('folded_into: ""')).toBe(false);
  expect(foldedIntoNamed("folded_into: # todo")).toBe(false);
  expect(foldedIntoNamed("folded_into:\n  # todo\ntags:\n  - a")).toBe(false);
  expect(foldedIntoNamed("title: P\n  folded_into: none")).toBe(false);
  expect(foldedIntoNamed("not_folded_into: none")).toBe(false);
});

test("foldedIntoNamed reads the key as YAML does: the last of two keys wins, and an entry that holds nothing names nothing", () => {
  // Review finding 2: YAML keeps the last duplicate.
  expect(foldedIntoNamed("folded_into:\nfolded_into: none")).toBe(true);
  expect(foldedIntoNamed("folded_into: none\nfolded_into:")).toBe(false);
  // Review finding 3: forms that hold no page.
  for (const empty of ["folded_into:\n  -", 'folded_into:\n  - ""', 'folded_into: [""]', "folded_into: [\n]", "folded_into: null", "folded_into: ~", "folded_into: >\ntags: [a]", "folded_into: {}"]) {
    expect(foldedIntoNamed(empty), JSON.stringify(empty)).toBe(false);
  }
  expect(foldedIntoNamed('folded_into:\n  - ""\n  - "[[projects/x]]"')).toBe(true);
  expect(foldedIntoNamed("folded_into: [[projects/x]]")).toBe(true);
});

test("when the frontmatter is not YAML, the key's own entry is still read: last key, its block list, CRLF, a quoted key", () => {
  const broken = "status_note: PR 1: merged";
  expect(() => Bun.YAML.parse(broken)).toThrow();
  expect(foldedIntoNamed(`${broken}\nfolded_into: none`)).toBe(true);
  expect(foldedIntoNamed(`folded_into:\n  - "[[projects/x]]"\n${broken}`)).toBe(true);
  expect(foldedIntoNamed(`${broken}\r\nfolded_into: none\r`)).toBe(true);
  expect(foldedIntoNamed(`${broken}\n"folded_into": none`)).toBe(true);
  expect(foldedIntoNamed(`folded_into:\n${broken}\nfolded_into: none`)).toBe(true);
  expect(foldedIntoNamed(`folded_into: none\n${broken}\nfolded_into:`)).toBe(false);
  expect(foldedIntoNamed(`${broken}\nfolded_into:\ntags: [a]`)).toBe(false);
  expect(foldedIntoNamed(`${broken}\n  folded_into: none`)).toBe(false);
  expect(foldedIntoNamed(broken)).toBe(false);
});

test("a CRLF plan whose frontmatter ends with the key is read like an LF one", async () => {
  // Review finding 1: `splitFrontmatter` leaves the `\r` on the frontmatter's last line.
  const root = await testTempDir(path.join(tmpdir(), "wiki-lint-fold-crlf-"));
  const page = (last: string) => ["---", "title: P", "updated: 2026-11-14", "plan_status: shipped", "status_date: 2026-11-14", last, "---", "", "# P", "", "Body.", "", "## Sources", "", "- x", ""].join("\r\n");
  await Bun.write(path.join(root, "plans/crlf-none.md"), page("folded_into: none"));
  await Bun.write(path.join(root, "plans/crlf-link.md"), page('folded_into: ["[[plans/crlf-none]]"]'));
  await Bun.write(path.join(root, "plans/crlf-bare.md"), page("folded_into:"));
  await Bun.write(path.join(root, ".wiki-reader.json"), JSON.stringify({ foldCheck: { since: "2026-11-14" } }));
  const got = (await lintWiki(await buildWikiIndex(root))).findings.filter((f) => f.check === "plan-not-folded").map((f) => f.relPath);
  expect(got).toEqual(["plans/crlf-bare.md"]);
});

test("checkPlanFold: only a shipped plan under plans/, dated on or after the cutoff, with no entry", () => {
  expect(checkPlanFold(shipped("2026-11-14"), "title: P", CFG)).toContain("folded_into");
  expect(checkPlanFold(shipped("2026-12-01"), "folded_into:", CFG)).not.toBeNull();
  expect(checkPlanFold(shipped("2026-11-14"), "folded_into: none", CFG)).toBeNull();
  expect(checkPlanFold(shipped("2026-11-13"), "title: P", CFG)).toBeNull();
  expect(checkPlanFold(shipped(undefined), "title: P", CFG)).toBeNull();
  expect(checkPlanFold(shipped("2026-11-14", "archive/x/p.mdx"), "title: P", CFG)).toBeNull();
  expect(checkPlanFold({ relPath: "plans/p.mdx", plan_status: "in-flight", status_date: "2026-11-14" }, "title: P", CFG)).toBeNull();
});

test("parseFoldCheck: absent is silent; anything but {since: a real day} warns and is null", () => {
  expect(parseFoldCheck(undefined)).toEqual({ config: null, warnings: [] });
  expect(parseFoldCheck({ since: "2026-11-14" })).toEqual({ config: { since: "2026-11-14" }, warnings: [] });
  for (const bad of ["2026-11-14", ["2026-11-14"], null, {}, { since: "14.11.2026" }, { since: "2026-02-30" }, { since: 20261114 }]) {
    const got = parseFoldCheck(bad);
    expect(got.config, JSON.stringify(bad)).toBeNull();
    expect(got.warnings, JSON.stringify(bad)).toHaveLength(1);
  }
});

test("lintWiki reports plan-not-folded only when the wiki declares foldCheck, and only on the unfolded plan in scope", async () => {
  expect(LINT_CHECKS).toContain("plan-not-folded");
  const root = await testTempDir(path.join(tmpdir(), "wiki-lint-fold-"));
  const plan = (extra: string) => `---\ntitle: P\nupdated: 2026-11-14\nplan_status: shipped\n${extra}---\n\n# P\n\nBody.\n\n## Sources\n\n- x\n`;
  await Bun.write(path.join(root, "plans/unfolded.md"), plan("status_date: 2026-11-14\n"));
  await Bun.write(path.join(root, "plans/bare-key.md"), plan("status_date: 2026-11-15\nfolded_into:\n"));
  await Bun.write(path.join(root, "plans/folded.md"), plan('status_date: 2026-11-14\nfolded_into: ["[[projects/reader]]"]\n'));
  await Bun.write(path.join(root, "plans/block-list.md"), plan('status_date: 2026-11-14\nfolded_into:\n  - "[[projects/reader]]"\n'));
  await Bun.write(path.join(root, "plans/none.md"), plan("status_date: 2026-11-14\nfolded_into: none\n"));
  await Bun.write(path.join(root, "plans/old.md"), plan("status_date: 2026-11-13\n"));
  await Bun.write(path.join(root, "plans/in-flight.md"), plan("status_date: 2026-11-14\n").replace("shipped", "in-flight"));
  await Bun.write(path.join(root, "projects/reader.md"), "---\ntitle: Reader\nupdated: 2026-11-14\n---\n\n# Reader\n\nBody.\n");
  const got = async () => (await lintWiki(await buildWikiIndex(root))).findings.filter((f) => f.check === "plan-not-folded").map((f) => f.relPath).sort();
  expect(await got()).toEqual([]);
  await Bun.write(path.join(root, ".wiki-reader.json"), JSON.stringify({ foldCheck: { since: "2026-11-14" } }));
  expect(await got()).toEqual(["plans/bare-key.md", "plans/unfolded.md"]);
});
