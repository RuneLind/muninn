import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildLintProposalRows, seedLintProposals } from "./lint-proposals.ts";
import { sha256 } from "./util.ts";
import type { LintFinding } from "../wiki/lint.ts";
import type { InsertWikiProposalParams, LintGroupRow } from "../db/wiki-proposals.ts";

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

  test("seed skips a group the wiki already holds a REJECTED row for", async () => {
    const inserted: InsertWikiProposalParams[] = [];
    const result = await seedLintProposals(
      [seriesFinding([{ op: "frontmatter", relPath: "plans/a.mdx", key: "series", value: "a" }])],
      {
        ...deps(),
        wikiName: "lintwiki",
        // A dismissal leaves `rejected` rows in place; their key is here, which
        // is the entire mechanism that keeps a dismissed finding dismissed.
        listGroupRows: async () => [
          { groupKey: GROUP, targetPath: "plans/a.mdx", status: "rejected" },
        ],
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
        seededBy: "lint-proposals",
        listGroupRows: async () => [],
        insert: async (p) => {
          inserted.push(p);
          return { id: String(inserted.length) } as never;
        },
      },
    );
    expect(result).toMatchObject({ proposed: 1, rows: 2, skipped: 0, claimed: 0, staled: 0 });
    expect(inserted).toHaveLength(2);
    expect(inserted[0]).toMatchObject({
      botName: "lintwiki",
      wikiName: "lintwiki",
      groupKey: GROUP,
      kind: "lint",
      mode: "update",
      // The seeder marker the apply's log.md entry is attributed from.
      sourceDocs: [],
      lintMeta: { seededBy: "lint-proposals", findingRelPath: "plans/a.mdx" },
    });
  });

  // ── one page, one live group ──────────────────────────────────────────────

  /** A seed run over injected rows, collecting what it inserted and staled. */
  async function seed(
    findings: LintFinding[],
    existing: LintGroupRow[],
  ): Promise<{
    result: Awaited<ReturnType<typeof seedLintProposals>>;
    inserted: InsertWikiProposalParams[];
    staled: string[];
  }> {
    const inserted: InsertWikiProposalParams[] = [];
    const staled: string[] = [];
    const result = await seedLintProposals(findings, {
      ...deps(),
      wikiName: "lintwiki",
      listGroupRows: async () => existing,
      markGroupStale: async (_wiki, key) => {
        staled.push(key);
        return 1;
      },
      insert: async (p) => {
        inserted.push(p);
        return { id: String(inserted.length) } as never;
      },
    });
    return { result, inserted, staled };
  }

  const PAIR = "lint:same-work-no-link:ffffffffffff";
  function pairFinding(relPath: string, groupKey = PAIR): LintFinding {
    return {
      check: "same-work-no-link",
      relPath,
      message: "same work",
      fix: { groupKey, edits: [{ op: "see-also", relPath, title: "B" }] },
    };
  }

  test("a finding touching a page a LIVE row already holds is skipped and counted", async () => {
    // The cluster group is still a current finding, so the self-heal leaves it —
    // and its `draft` row CLAIMS plans/a.mdx for as long as it lives.
    const cluster = seriesFinding([
      { op: "frontmatter", relPath: "plans/a.mdx", key: "series", value: "a" },
      { op: "frontmatter", relPath: "plans/b.mdx", key: "series", value: "a" },
    ]);
    const { result, inserted } = await seed(
      [cluster, pairFinding("plans/a.mdx")],
      [
        { groupKey: GROUP, targetPath: "plans/a.mdx", status: "draft" },
        { groupKey: GROUP, targetPath: "plans/b.mdx", status: "draft" },
      ],
    );
    // One live group is skipped by KEY; the pair is skipped because the page it
    // would edit is already in that group — two live rows on one page is the
    // state where applying either one stales the other forever.
    expect(result).toMatchObject({ proposed: 0, rows: 0, skipped: 1, claimed: 1 });
    expect(inserted).toEqual([]);
  });

  test("CLUSTER findings are processed before 8.1 pairs on the same page", async () => {
    const cluster = seriesFinding([
      { op: "frontmatter", relPath: "plans/a.mdx", key: "series", value: "a" },
      { op: "frontmatter", relPath: "plans/b.mdx", key: "series", value: "a" },
    ]);
    // The pair comes FIRST in the findings list, as `checkSeries` returns it.
    const { result, inserted } = await seed([pairFinding("plans/a.mdx"), cluster], []);
    // The cluster wins the page. Taken in list order the pair would claim
    // plans/a.mdx and starve a three-page series of its head.
    expect(result).toMatchObject({ proposed: 1, rows: 2, claimed: 1 });
    expect(inserted.map((p) => p.targetPath)).toEqual(["plans/a.mdx", "plans/b.mdx"]);
    expect(inserted.every((p) => p.groupKey === GROUP)).toBe(true);
  });

  test("an APPLIED or STALE group does not block a re-proposal", async () => {
    const { result, inserted } = await seed(
      [
        seriesFinding([
          { op: "frontmatter", relPath: "plans/a.mdx", key: "series", value: "a" },
          { op: "frontmatter", relPath: "plans/b.mdx", key: "series", value: "a" },
        ]),
      ],
      [
        { groupKey: GROUP, targetPath: "plans/a.mdx", status: "applied" },
        { groupKey: GROUP, targetPath: "plans/b.mdx", status: "stale" },
      ],
    );
    // The remaining pages get fresh rows with fresh hashes; the partial unique
    // index covers live rows only, so `topic_key` cannot collide.
    expect(result).toMatchObject({ proposed: 1, rows: 2, skipped: 0, claimed: 0 });
    expect(inserted).toHaveLength(2);
  });

  test("the self-heal retires a live DRAFT group no current finding carries", async () => {
    const { result, staled, inserted } = await seed(
      [
        seriesFinding([
          { op: "frontmatter", relPath: "plans/a.mdx", key: "series", value: "a" },
          { op: "frontmatter", relPath: "plans/b.mdx", key: "series", value: "a" },
        ]),
      ],
      [
        // A superseded 8.2 group: the same two pages, under a key the current
        // clustering no longer mints (a sibling fix grew the member set).
        { groupKey: "lint:series-unnamed:oldoldoldold", targetPath: "plans/a.mdx", status: "draft" },
        { groupKey: "lint:series-unnamed:oldoldoldold", targetPath: "plans/b.mdx", status: "draft" },
      ],
    );
    expect(staled).toEqual(["lint:series-unnamed:oldoldoldold"]);
    expect(result.staled).toBe(1);
    // …and the pages it held are released IN THE SAME PASS, so the successor
    // group is proposed rather than waiting a week behind a dead card.
    expect(result).toMatchObject({ proposed: 1, rows: 2, claimed: 0 });
    expect(inserted).toHaveLength(2);
  });

  test("an APPROVED group is neither staled nor re-proposed", async () => {
    const { result, staled } = await seed(
      [seriesFinding([{ op: "frontmatter", relPath: "plans/a.mdx", key: "series", value: "a" }])],
      // Mid-apply under another key: the apply's own terminal CAS owns it.
      [{ groupKey: "lint:series-unnamed:midapply1234", targetPath: "plans/a.mdx", status: "approved" }],
    );
    expect(staled).toEqual([]);
    expect(result).toMatchObject({ staled: 0, claimed: 1, proposed: 0 });
  });

  test("a finding every page of which refuses is counted ONCE per pass", async () => {
    await Bun.write(path.join(root, "plans/a.mdx"), "# No fence\n\nBody.\n");
    const { result, inserted } = await seed(
      [seriesFinding([{ op: "frontmatter", relPath: "plans/a.mdx", key: "series", value: "a" }])],
      [],
    );
    expect(result).toMatchObject({ proposed: 0, rows: 0, refused: 1 });
    expect(result.refusals).toHaveLength(1);
    expect(inserted).toEqual([]);
  });
});
