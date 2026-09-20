import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildLintProposalRows, seedLintProposals } from "./lint-proposals.ts";
import { sha256 } from "./util.ts";
import type { LintFinding } from "../wiki/lint.ts";
import type { InsertWikiProposalParams } from "../db/wiki-proposals.ts";

/** The row builder and the seeder, over temp files and injected DB seams. */
describe("lint proposals", () => {
  let root: string;
  const GROUP = "lint:series-unnamed:0123456789ab";

  const deps = () => ({
    wikiDir: root,
    readFile: async (abs: string) => {
      try {
        return await Bun.file(abs).text();
      } catch {
        return null;
      }
    },
  });

  function seriesFinding(edits: NonNullable<LintFinding["fix"]>["edits"]): LintFinding {
    return {
      check: "series-unnamed",
      relPath: edits[0]!.relPath,
      message: "2 linked pages declare no series: — propose series: a",
      detail: "members: plans/a.mdx, plans/b.mdx",
      fix: { groupKey: GROUP, edits },
    };
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "lint-proposals-"));
    await Bun.write(path.join(root, "plans/a.mdx"), "---\ntitle: A\n---\n\nBody.\n");
    await Bun.write(path.join(root, "plans/b.mdx"), "---\ntitle: B\n---\n\nBody.\n");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("one row per PAGE, with the page's own base hash and topic key", async () => {
    const { rows, refusals } = await buildLintProposalRows(
      seriesFinding([
        { op: "frontmatter", relPath: "plans/a.mdx", key: "series", value: "a" },
        { op: "frontmatter", relPath: "plans/b.mdx", key: "series", value: "a" },
      ]),
      deps(),
    );
    expect(refusals).toEqual([]);
    expect(rows.map((r) => r.targetPath)).toEqual(["plans/a.mdx", "plans/b.mdx"]);
    expect(rows[0]!.topicKey).toBe(`${GROUP}:plans/a.mdx`);
    expect(rows.every((r) => r.groupKey === GROUP)).toBe(true);
    // The CAS base is the file's CURRENT bytes, so a page edited between the
    // lint and the approve goes `stale` rather than being overwritten.
    expect(rows[0]!.baseHash).toBe(sha256(await Bun.file(path.join(root, "plans/a.mdx")).text()));
    expect(rows[0]!.draft).toContain("series: a");
  });

  test("two edits on ONE page become ONE row carrying both lines", async () => {
    const { rows } = await buildLintProposalRows(
      seriesFinding([
        { op: "frontmatter", relPath: "plans/a.mdx", key: "series", value: "a" },
        { op: "frontmatter", relPath: "plans/a.mdx", key: "series_label", value: "A" },
      ]),
      deps(),
    );
    // Two rows on one `target_path` would race each other's CAS.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.draft).toContain("series: a");
    expect(rows[0]!.draft).toContain("series_label: A");
  });

  test("a page whose edit is already in place contributes NO row", async () => {
    await Bun.write(path.join(root, "plans/a.mdx"), "---\ntitle: A\nseries: a\n---\n\nBody.\n");
    const { rows } = await buildLintProposalRows(
      seriesFinding([
        { op: "frontmatter", relPath: "plans/a.mdx", key: "series", value: "a" },
        { op: "frontmatter", relPath: "plans/b.mdx", key: "series", value: "a" },
      ]),
      deps(),
    );
    expect(rows.map((r) => r.targetPath)).toEqual(["plans/b.mdx"]);
  });

  test("a page with no frontmatter fence is REFUSED, and the rest of the group still proposes", async () => {
    await Bun.write(path.join(root, "plans/a.mdx"), "# No fence\n\nBody.\n");
    const { rows, refusals } = await buildLintProposalRows(
      seriesFinding([
        { op: "frontmatter", relPath: "plans/a.mdx", key: "series", value: "a" },
        { op: "frontmatter", relPath: "plans/b.mdx", key: "series", value: "a" },
      ]),
      deps(),
    );
    expect(refusals.map((r) => r.relPath)).toEqual(["plans/a.mdx"]);
    expect(rows.map((r) => r.targetPath)).toEqual(["plans/b.mdx"]);
  });

  test("an unreadable page is a refusal, not a crash", async () => {
    const { rows, refusals } = await buildLintProposalRows(
      seriesFinding([{ op: "frontmatter", relPath: "plans/gone.mdx", key: "series", value: "a" }]),
      deps(),
    );
    expect(rows).toEqual([]);
    expect(refusals).toEqual([{ relPath: "plans/gone.mdx", reason: "page is unreadable" }]);
  });

  test("a see-also fix writes one bullet, and is a noop when the link is already there", async () => {
    await Bun.write(
      path.join(root, "plans/a.mdx"),
      "---\ntitle: A\n---\n\nBody.\n\n## See also\n- [[Other]]\n",
    );
    const fix: LintFinding = {
      check: "same-work-no-link",
      relPath: "plans/a.mdx",
      message: "same work",
      fix: { groupKey: GROUP, edits: [{ op: "see-also", relPath: "plans/a.mdx", title: "B" }] },
    };
    const { rows } = await buildLintProposalRows(fix, deps());
    expect(rows[0]!.draft).toContain("- [[Other]]\n- [[B]]");

    await Bun.write(path.join(root, "plans/a.mdx"), rows[0]!.draft);
    const again = await buildLintProposalRows(fix, deps());
    expect(again.rows).toEqual([]);
  });

  test("seed skips a group the wiki already holds rows for, in any status", async () => {
    const inserted: InsertWikiProposalParams[] = [];
    const result = await seedLintProposals(
      [seriesFinding([{ op: "frontmatter", relPath: "plans/a.mdx", key: "series", value: "a" }])],
      {
        ...deps(),
        wikiName: "lintwiki",
        // A dismissal leaves `rejected` rows in place; their key is here, which
        // is the entire mechanism that keeps a dismissed finding dismissed.
        usedGroupKeys: async () => new Set([GROUP]),
        insert: async (p) => {
          inserted.push(p);
          return null;
        },
      },
    );
    expect(result).toMatchObject({ proposed: 0, rows: 0, skipped: 1 });
    expect(inserted).toEqual([]);
  });

  test("seed writes lint-kind update rows keyed to the wiki under one group", async () => {
    const inserted: InsertWikiProposalParams[] = [];
    const result = await seedLintProposals(
      [
        seriesFinding([
          { op: "frontmatter", relPath: "plans/a.mdx", key: "series", value: "a" },
          { op: "frontmatter", relPath: "plans/b.mdx", key: "series", value: "a" },
        ]),
      ],
      {
        ...deps(),
        wikiName: "lintwiki",
        usedGroupKeys: async () => new Set<string>(),
        insert: async (p) => {
          inserted.push(p);
          return { id: String(inserted.length) } as never;
        },
      },
    );
    expect(result).toMatchObject({ proposed: 1, rows: 2, skipped: 0 });
    expect(inserted).toHaveLength(2);
    expect(inserted[0]).toMatchObject({
      botName: "lintwiki",
      wikiName: "lintwiki",
      groupKey: GROUP,
      kind: "lint",
      mode: "update",
      sourceDocs: [],
    });
  });
});
