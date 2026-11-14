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
  expect(foldedIntoNamed("  folded_into: none")).toBe(false);
  expect(foldedIntoNamed("not_folded_into: none")).toBe(false);
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
