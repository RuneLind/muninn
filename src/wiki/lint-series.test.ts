import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildWikiIndex } from "./store.ts";
import { lintWiki, type LintFinding } from "./lint.ts";
import { SERIES_CLUSTER_MAX, type LintPageEdit } from "./lint-series.ts";
import { RELATED_DIGEST_PRS, RELATED_HUB_BACKLINKS } from "./related-constants.ts";

/**
 * Check 8 over temp-dir wiki fixtures.
 *
 * Every page carries a `status_date:`, deliberately: `bySeriesDateDesc` falls
 * back to the git touch date and then to mtime, and a fixture written in one
 * `beforeEach` has ~identical mtimes for every file — so "the newer page" would
 * be decided by the relPath tie-break rather than by the rule under test.
 *
 * The cut cases SIZE themselves from `related-constants.ts` rather than
 * re-typing 25 and 15, so a re-measured threshold does not silently turn a cut
 * case into a no-op.
 */
describe("checkSeries", () => {
  let root: string;
  const write = (rel: string, content: string) => Bun.write(path.join(root, rel), content);

  /** A page with frontmatter. `extra` lines go inside the fence; `body` after it. */
  function page(
    title: string,
    opts: { date: string; plan?: boolean; series?: string; label?: string; sessions?: string[] },
    body = "Body.",
  ): string {
    return [
      "---",
      `title: ${title}`,
      `status_date: ${opts.date}`,
      ...(opts.plan ? ["plan_status: in-flight"] : []),
      ...(opts.series ? [`series: ${opts.series}`] : []),
      ...(opts.label ? [`series_label: ${opts.label}`] : []),
      ...(opts.sessions ? [`sessions: [${opts.sessions.join(", ")}]`] : []),
      "---",
      "",
      body,
      "",
    ].join("\n");
  }

  async function findings(check?: string): Promise<LintFinding[]> {
    const index = await buildWikiIndex(root);
    const { findings: all } = await lintWiki(index, { now: () => Date.parse("2026-09-20T12:00:00Z") });
    return check ? all.filter((f) => f.check === check) : all;
  }

  /** The fix's edits, sorted so an assertion does not depend on map order. */
  function edits(f: LintFinding): LintPageEdit[] {
    return [...(f.fix?.edits ?? [])].sort((a, b) =>
      (a.relPath + ("key" in a ? a.key : "")).localeCompare(b.relPath + ("key" in b ? b.key : "")),
    );
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-lint-series-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // ── 8.1 same work, no link ────────────────────────────────────────────────

  test("two shared PR refs with no link either way is a finding on the NEWER page", async () => {
    await write(
      "plans/newer.mdx",
      page("Newer plan", { date: "2026-09-10", plan: true }, "Landed RuneLind/muninn#553 and RuneLind/muninn#552."),
    );
    await write(
      "plans/older.mdx",
      page("Older plan", { date: "2026-09-01", plan: true }, "See RuneLind/muninn#552 and RuneLind/muninn#553."),
    );

    const [f, ...rest] = await findings("same-work-no-link");
    expect(rest).toHaveLength(0);
    expect(f!.relPath).toBe("plans/newer.mdx");
    expect(f!.detail).toContain("plans/older.mdx");
    expect(f!.detail).toContain("shares RuneLind/muninn#553, RuneLind/muninn#552");
    // The fix is ONE See-also line, on the newer page, naming the older page.
    expect(edits(f!)).toEqual([
      { op: "see-also", relPath: "plans/newer.mdx", title: "Older plan" },
    ]);
  });

  test("ONE shared PR ref is not enough", async () => {
    await write("plans/a.mdx", page("A", { date: "2026-09-10" }, "RuneLind/muninn#553."));
    await write("plans/b.mdx", page("B", { date: "2026-09-01" }, "RuneLind/muninn#553."));
    expect(await findings("same-work-no-link")).toHaveLength(0);
  });

  test("a pair already wikilinked ONE way is not a finding", async () => {
    await write(
      "plans/newer.mdx",
      page("Newer plan", { date: "2026-09-10" }, "Landed RuneLind/muninn#553, RuneLind/muninn#552. See [[Older plan]]."),
    );
    await write(
      "plans/older.mdx",
      page("Older plan", { date: "2026-09-01" }, "RuneLind/muninn#552 and RuneLind/muninn#553."),
    );
    expect(await findings("same-work-no-link")).toHaveLength(0);
  });

  test("a shared session id pairs two pages that share no PR ref", async () => {
    await write("plans/a.mdx", page("A", { date: "2026-09-10", sessions: ["claude-code:abc-123"] }));
    await write("plans/b.mdx", page("B", { date: "2026-09-01", sessions: ["claude-code:abc-123"] }));
    const [f] = await findings("same-work-no-link");
    expect(f!.relPath).toBe("plans/a.mdx");
    expect(f!.detail).toContain("same session claude-code:abc-123");
  });

  test("a superseded_by chain pairs a retired plan with its successor", async () => {
    await write("plans/successor.mdx", page("Successor", { date: "2026-09-10" }));
    await write(
      "plans/retired.mdx",
      [
        "---",
        "title: Retired",
        "status_date: 2026-09-01",
        "superseded_by: successor",
        "---",
        "",
        "Body.",
        "",
      ].join("\n"),
    );
    const [f] = await findings("same-work-no-link");
    expect(f!.relPath).toBe("plans/successor.mdx");
    expect(f!.detail).toContain("superseded_by chain");
  });

  test("a PR DIGEST is cut from the shared-ref rule on either end of the pair", async () => {
    const manyRefs = Array.from(
      { length: RELATED_DIGEST_PRS + 1 },
      (_, i) => `RuneLind/muninn#${600 + i}`,
    ).join(" ");
    await write("plans/digest.mdx", page("Digest", { date: "2026-09-10" }, manyRefs));
    await write(
      "plans/small.mdx",
      page("Small", { date: "2026-09-01" }, "RuneLind/muninn#600 and RuneLind/muninn#601."),
    );
    expect(await findings("same-work-no-link")).toHaveLength(0);
  });

  test("a HUB is cut from every rule", async () => {
    // One page over the backlink threshold, paired by two shared refs with a page
    // that links nothing. The fillers only link the hub, so nothing else pairs.
    await write("plans/hub.mdx", page("Hub", { date: "2026-09-10" }, "RuneLind/muninn#700 RuneLind/muninn#701."));
    await write("plans/peer.mdx", page("Peer", { date: "2026-09-01" }, "RuneLind/muninn#700 RuneLind/muninn#701."));
    for (let i = 0; i < RELATED_HUB_BACKLINKS + 1; i++) {
      await write(`notes/filler-${i}.md`, page(`Filler ${i}`, { date: "2026-08-01" }, "See [[Hub]]."));
    }
    expect(await findings("same-work-no-link")).toHaveLength(0);
  });

  test("a BOOKKEEPING page is cut, by stem, in any folder", async () => {
    await write("plans/index.md", page("Plans index", { date: "2026-09-10" }, "RuneLind/muninn#800 RuneLind/muninn#801."));
    await write("plans/real.mdx", page("Real", { date: "2026-09-01" }, "RuneLind/muninn#800 RuneLind/muninn#801."));
    expect(await findings("same-work-no-link")).toHaveLength(0);
  });

  // ── 8.2 series unnamed ────────────────────────────────────────────────────

  test("a mutually-linked trio with no series: proposes a key on all three and a label on the head", async () => {
    await write(
      "plans/lead.mdx",
      page("Rail grouping", { date: "2026-09-18", plan: true }, "See [[Follow up]] and [[Rail explained]]."),
    );
    await write(
      "plans/follow.mdx",
      page("Follow up", { date: "2026-09-10" }, "See [[Rail grouping]]."),
    );
    await write(
      "blogs/explained.mdx",
      page("Rail explained", { date: "2026-09-05" }, "See [[Rail grouping]]."),
    );

    const [f, ...rest] = await findings("series-unnamed");
    expect(rest).toHaveLength(0);
    // The head is the newest non-terminal PLAN, and the key is its page stem.
    expect(f!.relPath).toBe("plans/lead.mdx");
    expect(f!.message).toContain("series: lead");
    expect(f!.detail).toContain("blogs/explained.mdx");
    expect(edits(f!)).toEqual([
      { op: "frontmatter", relPath: "blogs/explained.mdx", key: "series", value: "lead" },
      { op: "frontmatter", relPath: "plans/follow.mdx", key: "series", value: "lead" },
      { op: "frontmatter", relPath: "plans/lead.mdx", key: "series", value: "lead" },
      { op: "frontmatter", relPath: "plans/lead.mdx", key: "series_label", value: "Rail grouping" },
    ]);
  });

  test("ONE wikilink plus ONE shared PR ref is a cluster edge; a bare link is not", async () => {
    await write("plans/a.mdx", page("A", { date: "2026-09-10", plan: true }, "See [[B]] — RuneLind/muninn#900."));
    await write("plans/b.mdx", page("B", { date: "2026-09-05" }, "RuneLind/muninn#900."));
    // A bare one-way link with no shared ref: its own page, never a cluster.
    await write("plans/c.mdx", page("C", { date: "2026-09-04" }, "See [[A]]."));
    const [f, ...rest] = await findings("series-unnamed");
    expect(rest).toHaveLength(0);
    expect(edits(f!).map((e) => e.relPath)).toEqual(["plans/a.mdx", "plans/a.mdx", "plans/b.mdx"]);
  });

  test("a component over the cap proposes its 12 newest and names the cut in detail", async () => {
    const n = SERIES_CLUSTER_MAX + 3;
    // A star of mutual links around the head keeps the whole set one component.
    const links = Array.from({ length: n - 1 }, (_, i) => `[[Spoke ${i}]]`).join(" ");
    await write("plans/head.mdx", page("Head", { date: "2026-09-30", plan: true }, links));
    for (let i = 0; i < n - 1; i++) {
      // Older as i grows, so the cut is the LAST three.
      const day = String(20 - i).padStart(2, "0");
      await write(`plans/spoke-${i}.mdx`, page(`Spoke ${i}`, { date: `2026-09-${day}` }, "See [[Head]]."));
    }

    const [f] = await findings("series-unnamed");
    expect(f!.fix!.edits.filter((e) => e.op === "frontmatter" && e.key === "series")).toHaveLength(
      SERIES_CLUSTER_MAX,
    );
    expect(f!.detail).toContain(`${n - SERIES_CLUSTER_MAX} more cut:`);
    expect(f!.detail).toContain("plans/spoke-13.mdx");
  });

  test("a component touching TWO named series is never merged and proposes nothing", async () => {
    await write(
      "plans/bridge.mdx",
      page("Bridge", { date: "2026-09-18", plan: true }, "See [[Alpha member]] and [[Beta member]]."),
    );
    await write(
      "plans/alpha.mdx",
      page("Alpha member", { date: "2026-09-10", series: "alpha" }, "See [[Bridge]]."),
    );
    await write(
      "plans/beta.mdx",
      page("Beta member", { date: "2026-09-08", series: "beta" }, "See [[Bridge]]."),
    );
    expect(await findings("series-unnamed")).toHaveLength(0);
    expect(await findings("series-inconsistent")).toHaveLength(0);
  });

  test("a component touching exactly ONE named series joins that key (8.3c), not a new one", async () => {
    await write(
      "plans/named.mdx",
      page("Named", { date: "2026-09-18", plan: true, series: "wiki-provenance" }, "See [[Joiner]]."),
    );
    await write("plans/joiner.mdx", page("Joiner", { date: "2026-09-10" }, "See [[Named]]."));

    expect(await findings("series-unnamed")).toHaveLength(0);
    const [f] = await findings("series-inconsistent");
    expect(f!.message).toContain("wiki-provenance");
    expect(edits(f!)).toEqual([
      { op: "frontmatter", relPath: "plans/joiner.mdx", key: "series", value: "wiki-provenance" },
    ]);
  });

  test("an already-named cluster with no unnamed member proposes nothing", async () => {
    await write(
      "plans/one.mdx",
      page("One", { date: "2026-09-18", plan: true, series: "prov" }, "See [[Two]]."),
    );
    await write("plans/two.mdx", page("Two", { date: "2026-09-10", series: "prov" }, "See [[One]]."));
    expect(await findings("series-unnamed")).toHaveLength(0);
    expect(await findings("series-inconsistent")).toHaveLength(0);
  });

  // ── 8.3 series inconsistent ───────────────────────────────────────────────

  test("two spellings of one key normalise to the head's spelling", async () => {
    await write("plans/head.mdx", page("Head", { date: "2026-09-18", plan: true, series: "prov" }));
    await write("plans/variant.mdx", page("Variant", { date: "2026-09-10", series: "Prov" }));

    const [f] = await findings("series-inconsistent");
    expect(f!.relPath).toBe("plans/head.mdx");
    expect(f!.message).toContain("spelled 2 ways");
    expect(edits(f!)).toEqual([
      { op: "frontmatter", relPath: "plans/variant.mdx", key: "series", value: "prov" },
    ]);
  });

  test("two series_label heads: the newest labelled member keeps its label", async () => {
    await write(
      "plans/head.mdx",
      page("Head", { date: "2026-09-18", plan: true, series: "prov", label: "Wiki provenance" }),
    );
    await write(
      "plans/other.mdx",
      page("Other", { date: "2026-09-10", plan: true, series: "prov", label: "Provenance work" }),
    );

    const [f, ...rest] = await findings("series-inconsistent");
    expect(rest).toHaveLength(0);
    expect(f!.relPath).toBe("plans/head.mdx");
    expect(f!.message).toContain("2 series_label: heads");
    expect(edits(f!)).toEqual([
      { op: "frontmatter", relPath: "plans/other.mdx", key: "series_label", value: null },
    ]);
  });

  test("group keys are deterministic and distinct per sub-rule", async () => {
    await write("plans/head.mdx", page("Head", { date: "2026-09-18", plan: true, series: "prov", label: "P" }));
    await write("plans/other.mdx", page("Other", { date: "2026-09-10", plan: true, series: "Prov", label: "Q" }));

    const first = await findings("series-inconsistent");
    const second = await findings("series-inconsistent");
    expect(first.map((f) => f.fix!.groupKey)).toEqual(second.map((f) => f.fix!.groupKey));
    // (a) spelling and (b) duplicate label cover the SAME member here — the two
    // group keys must still differ, or the rows collide on one topic_key.
    expect(new Set(first.map((f) => f.fix!.groupKey)).size).toBe(first.length);
    expect(first).toHaveLength(2);
  });
});
