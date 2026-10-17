/**
 * `buildWorkEvidence` over synthetic pages (plan
 * `muninn-wiki-work-thread-grouping`, «Evidence and payload»): the witnesses
 * per kind, the owner rule (D4, D13) and the bounds.
 */

import { describe, expect, test } from "bun:test";
import { buildWorkEvidence, WORK_EVIDENCE_CONTRIBUTIONS_MAX, WORK_EVIDENCE_RELATIONS_MAX } from "./work-evidence.ts";
import type { WikiPageMeta } from "./store.ts";
import type { WorkContribution, WorkThread } from "./work-focus.ts";

function meta(relPath: string, over: Partial<WikiPageMeta> = {}): WikiPageMeta {
  const name = relPath.split("/").pop()!.replace(/\.[^.]+$/, "");
  return { name, title: name, type: "plan", domain: "ai", tags: [], aliases: [], relPath, ...over } as WikiPageMeta;
}
const thread = (key: string, pages: string[]): WorkThread => ({ key, pages, touched: [], sessions: [] });

function build(pages: WikiPageMeta[], threads: WorkThread[], over: { contributions?: WorkContribution[]; ledgerTruncated?: boolean; candidates?: number } = {}) {
  return buildWorkEvidence({
    threads,
    candidates: over.candidates ?? threads.length,
    contributions: over.contributions ?? [],
    ledgerTruncated: over.ledgerTruncated ?? false,
    pages,
  });
}

describe("relations", () => {
  test("series and projects: focus pages only, the series by its census key and membership", () => {
    const pages = [
      meta("p/a.mdx", { series: "Alpha ", project: "muninn" }),
      meta("p/b.mdx", { series: "alpha", project: "huginn" }),
      meta("p/a-prototype.html", { series: "alpha", parent: "p/a.mdx", pairedBy: "suffix" }),
      meta("p/c.mdx", { series: "alpha" }),
    ];
    const e = build(pages, [thread("p/a.mdx", ["p/a.mdx", "p/a-prototype.html"]), thread("p/b.mdx", ["p/b.mdx"])]);
    // An attachment child is no series member; p/c is no focus page.
    expect(e.relations.series).toEqual({ "p/a.mdx": "alpha", "p/b.mdx": "alpha" });
    expect(e.relations.projects).toEqual({ "p/a.mdx": "muninn", "p/b.mdx": "huginn" });
  });

  test("related: authored pairs between focus pages, either thread, hubs included; skips are summed", () => {
    const pages = [
      meta("p/a.mdx", { related: ["p/b.mdx", "p/out.mdx", "p/hub.mdx"], relatedSkipped: 2 }),
      meta("p/b.mdx", { related: ["p/a.mdx"], relatedAmbiguous: 1 }),
      meta("p/hub.mdx"),
      meta("p/out.mdx", { related: ["p/a.mdx"], relatedSkipped: 5 }),
    ];
    const e = build(pages, [thread("p/a.mdx", ["p/a.mdx"]), thread("p/b.mdx", ["p/b.mdx", "p/hub.mdx"])]);
    expect(e.relations.related).toEqual([
      ["p/a.mdx", "p/b.mdx"],
      ["p/a.mdx", "p/hub.mdx"],
      ["p/b.mdx", "p/a.mdx"],
    ]);
    expect(e.relations.relatedSkipped).toEqual({ skipped: 2, ambiguous: 1 });
  });

  test("owned issue: the unique owner and every focus page naming the key by a ref that counts", () => {
    const pages = [
      meta("p/owner.mdx", { owns: ["ABC-1"] }),
      meta("p/stamped.mdx", { jira: ["ABC-1"] }),
      meta("p/inferred.mdx", { issues: [{ tracker: "jira", key: "ABC-1", relations: ["title"] }] }),
      meta("p/linked.mdx", { issues: [{ tracker: "jira", key: "ABC-1", relations: ["link", "mention"] }] }),
    ];
    const focus = ["p/owner.mdx", "p/stamped.mdx", "p/inferred.mdx", "p/linked.mdx"];
    const e = build(pages, focus.map((p) => thread(p, [p])));
    expect(e.relations.issues).toEqual([
      ["ABC-1", "p/owner.mdx", "p/stamped.mdx"],
      ["ABC-1", "p/owner.mdx", "p/inferred.mdx"],
    ]);
    expect(e.relations.ambiguousIssues).toEqual([]);
  });

  test("two owners: no edge, reported as ambiguous; no owner: nothing", () => {
    const pages = [
      meta("p/o1.mdx", { owns: ["ABC-1"] }),
      meta("archive/o2.mdx", { owns: ["ABC-1"] }),
      meta("p/ref.mdx", { jira: ["ABC-1", "ABC-9"] }),
    ];
    const e = build(pages, [thread("p/o1.mdx", ["p/o1.mdx"]), thread("p/ref.mdx", ["p/ref.mdx"])]);
    expect(e.relations.issues).toEqual([]);
    expect(e.relations.ambiguousIssues).toEqual([{ key: "ABC-1", owners: ["archive/o2.mdx", "p/o1.mdx"] }]);
  });

  test("reserved and culled pages own nothing; an owner outside the focus set gives no edge", () => {
    const pages = [
      meta("plans/index.md", { name: "index", owns: ["ABC-1"] }),
      meta("p/retired.mdx", { owns: ["ABC-2"], culled: true }),
      meta("p/elsewhere.mdx", { owns: ["ABC-3"] }),
      meta("p/real.mdx", { owns: ["ABC-1", "ABC-2"] }),
      meta("p/ref.mdx", { jira: ["ABC-1", "ABC-2", "ABC-3"] }),
    ];
    const e = build(pages, [thread("p/real.mdx", ["p/real.mdx", "plans/index.md"]), thread("p/ref.mdx", ["p/ref.mdx"])]);
    expect(e.relations.issues).toEqual([
      ["ABC-1", "p/real.mdx", "p/ref.mdx"],
      ["ABC-2", "p/real.mdx", "p/ref.mdx"],
    ]);
    expect(e.relations.ambiguousIssues).toEqual([]);
  });
});

describe("completeness and bounds", () => {
  test("complete by default; the thread cut is reported apart, not as incompleteness", () => {
    const e = build([meta("p/a.mdx")], [thread("p/a.mdx", ["p/a.mdx"])], { candidates: 25 });
    expect(e.version).toBe(1);
    expect(e.threads).toEqual({ candidates: 25, shipped: 1 });
    expect(e.relations).toMatchObject({ complete: true, reasons: [] });
    expect(e.contributions).toMatchObject({ complete: true, reasons: [] });
  });

  test("a clipped ledger makes the contributions incomplete, not the relations", () => {
    const e = build([meta("p/a.mdx")], [thread("p/a.mdx", ["p/a.mdx"])], { ledgerTruncated: true });
    expect(e.contributions).toMatchObject({ complete: false, reasons: ["ledger-truncated"] });
    expect(e.relations.complete).toBe(true);
  });

  test("each bound cuts its list and says so", () => {
    const n = WORK_EVIDENCE_RELATIONS_MAX + 1;
    const focus = Array.from({ length: n + 1 }, (_, i) => `p/x${i}.mdx`);
    const pages = focus.map((p, i) => meta(p, i === 0 ? { related: focus.slice(1) } : {}));
    const rows: WorkContribution[] = Array.from({ length: WORK_EVIDENCE_CONTRIBUTIONS_MAX + 1 }, (_, i) => [
      `claude:s${i}`,
      "p/x0.mdx",
      "p/x0.mdx",
      "focus",
      1,
      i,
      i,
    ]);
    const e = build(pages, [thread("p/x0.mdx", focus)], { contributions: rows });
    expect(e.relations.related).toHaveLength(WORK_EVIDENCE_RELATIONS_MAX);
    expect(e.relations).toMatchObject({ complete: false, reasons: ["relations-cap"] });
    expect(e.contributions.rows).toHaveLength(WORK_EVIDENCE_CONTRIBUTIONS_MAX);
    expect(e.contributions).toMatchObject({ complete: false, reasons: ["contributions-cap"] });
  });
});
