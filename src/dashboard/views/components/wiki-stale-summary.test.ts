/**
 * The Stale check's counts outside the STALE tab (PR 2b): every surface says
 * the tab's two numbers (D26) in the tab's words.
 */
import { describe, expect, test } from "bun:test";
import { staleCountMap, staleHomeBodyHtml, staleHomeLineHtml, stalePillHtml, staleRailBadgeHtml, type StaleSummaryView } from "./wiki-stale-summary.ts";
import { staleBodyHtml, staleCountsText, type StaleReportView } from "./wiki-stale-tab.ts";

const report: StaleReportView = {
  page: { relPath: "hub.md", title: "Hub" },
  hits: [
    { line: 3, target: "plans/p.md", said: ["in-flight"], now: "shipped", text: "- [[p]] is in-flight", confirmation: { verdict: "stale" } },
    { line: 4, target: "plans/p.md", said: ["proposed"], now: "shipped", text: "- [[p]] is a draft", confirmation: "unconfirmed" },
    { line: 5, target: "plans/p.md", said: ["blocked"], now: "shipped", text: "- [[p]] is blocked", confirmation: { verdict: "not-status", checkedBy: "reader" } },
  ],
  buckets: { counts: { toCheck: 2 }, linking: [] },
};

const summary: StaleSummaryView = {
  pages: [
    { relPath: "hub.md", title: "Hub", staleLines: 1, toCheck: 2, changed: true },
    { relPath: "b<x>.md", title: "B <x>", staleLines: 1, toCheck: 0, changed: false },
    { relPath: "quiet.md", title: "Quiet", staleLines: 0, toCheck: 0, changed: true },
  ],
  totals: { staleLines: 2, toCheck: 2 },
};

describe("the counts everywhere (PR 2b)", () => {
  test("the pill says what the tab's head says, from the same report", () => {
    const head = /<div class="wiki-stale-head"[^>]*>([^<]*)<\/div>/.exec(staleBodyHtml(report))![1];
    expect(head).toBe("⚠ 1 stale status line · 2 linking pages to check");
    expect(stalePillHtml(report)).toContain(`>${head}</button>`);
    expect(stalePillHtml(report)).toContain('data-stale-pill="1·2"');
  });

  test("no pill before the report loads or when it failed; ✓ when nothing is stale", () => {
    expect(stalePillHtml(null)).toBe("");
    expect(stalePillHtml({ error: "x" })).toBe("");
    expect(stalePillHtml({ hits: [], buckets: null })).toContain("✓ nothing stale");
    expect(staleCountsText({ staleLines: 0, toCheck: 0 })).toBe("✓ nothing stale");
  });

  test("the rail badge carries both numbers, and nothing at 0 · 0", () => {
    expect(staleRailBadgeHtml({ staleLines: 1, toCheck: 2 })).toContain(">⚠ 1 · 2</span>");
    expect(staleRailBadgeHtml({ staleLines: 1, toCheck: 2 })).toContain('title="1 stale status line · 2 linking pages to check"');
    expect(staleRailBadgeHtml({ staleLines: 0, toCheck: 0 })).toBe("");
    expect(staleRailBadgeHtml(undefined)).toBe("");
  });

  test("the count map keeps every row, and an error or a bad answer is empty", () => {
    const m = staleCountMap(summary);
    expect(m.get("hub.md")).toEqual({ staleLines: 1, toCheck: 2 });
    expect(m.get("quiet.md")).toEqual({ staleLines: 0, toCheck: 0 });
    expect(staleCountMap({ error: "x" }).size).toBe(0);
    expect(staleCountMap({} as StaleSummaryView).size).toBe(0);
    expect(staleCountMap(null).size).toBe(0);
  });

  test("the home line totals the rows and the home tab lists the stale ones, escaped", () => {
    expect(staleHomeLineHtml(summary)).toContain(">⚠ 2 stale status lines · 2 linking pages to check on 2 pages<");
    expect(staleHomeLineHtml(summary)).toContain("data-stale-home-open");
    expect(staleHomeLineHtml({ pages: [], totals: { staleLines: 0, toCheck: 0 } })).toContain("✓ nothing stale");
    expect(staleHomeLineHtml({ pages: [] })).not.toContain("data-stale-home-open");
    expect(staleHomeLineHtml(null)).toContain("Loading…");
    const body = staleHomeBodyHtml(summary);
    expect(body).toContain('data-relpath="hub.md"');
    expect(body).toContain("⚠ 1 stale status line · 2 linking pages to check");
    expect(body).toContain("B &lt;x&gt;");
    expect(body).not.toContain('data-relpath="quiet.md"');
    expect(body).toContain("+ 1 changed page with nothing stale.");
    expect(staleHomeBodyHtml({ ...summary, verdicts: "unavailable" })).toContain("Verdicts are unavailable");
  });

  test("«+ N changed pages» counts changed pages only, not an unchanged page whose hits are unconfirmed", () => {
    // The route sends an unchanged page with a hit as `changed: false`, its
    // `staleLines` 0 until the hit is confirmed stale.
    const withUnconfirmed: StaleSummaryView = {
      ...summary,
      pages: [...summary.pages!, { relPath: "u.md", title: "U", staleLines: 0, toCheck: 0, changed: false }],
    };
    expect(staleHomeBodyHtml(withUnconfirmed)).toContain("+ 1 changed page with nothing stale.");
    expect(staleHomeBodyHtml({ ...withUnconfirmed, pages: withUnconfirmed.pages!.filter((r) => r.relPath !== "quiet.md") })).not.toContain("with nothing stale");
  });
});

describe("PR 3: the ⧗ «in review» states (D31)", () => {
  test("the rail badge adds ⧗ K beside the counts, and shows ⧗ K alone on a page with nothing else stale", () => {
    expect(staleRailBadgeHtml({ staleLines: 1, toCheck: 2, inReview: 3 })).toContain('data-stale-review="3"');
    expect(staleRailBadgeHtml({ staleLines: 1, toCheck: 2, inReview: 3 })).toContain("⚠ 1 · 2 <span class=\"wiki-stale-rail-review\">⧗ 3</span>");
    const alone = staleRailBadgeHtml({ staleLines: 0, toCheck: 0, inReview: 2 });
    expect(alone).toContain("review-only");
    expect(alone).toContain("⧗ 2");
    expect(alone).not.toContain("⚠");
    expect(alone).toContain('title="2 fixes in review in the Gardener"');
    // No fixes in review: the PR 2b badge, unchanged.
    expect(staleRailBadgeHtml({ staleLines: 1, toCheck: 2 })).not.toContain("⧗");
  });

  test("the pill gains «⧗ N fixes in review» from the page report", () => {
    const html = stalePillHtml({ ...report, inReview: { fixes: 2 } });
    expect(html).toContain('data-stale-pill-review="2"');
    expect(html).toContain("⧗ 2 fixes in review");
    expect(stalePillHtml({ ...report, inReview: { fixes: 1 } })).toContain("⧗ 1 fix in review");
    expect(stalePillHtml(report)).not.toContain("⧗");
  });

  test("the summary's count map carries each row's fixes in review", () => {
    const m = staleCountMap({ pages: [{ relPath: "hub.md", title: "Hub", staleLines: 0, toCheck: 1, inReview: 2 }] });
    expect(m.get("hub.md")).toEqual({ staleLines: 0, toCheck: 1, inReview: 2 });
  });
});
