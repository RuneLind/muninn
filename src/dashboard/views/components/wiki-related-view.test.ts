/**
 * `relatedSectionHtml` — the block's empty guard and the row markup the panel's
 * delegated handler keys on.
 *
 * The guard is the shape a Playwright spec cannot reach: an omitted block has
 * no element to assert on, so "the section is absent" and "the page has no
 * related work" are the same DOM either way. Pinned here instead.
 */

import { describe, expect, test } from "bun:test";
import {
  orderRelated,
  relatedAgeHtml,
  relatedHopHtml,
  relatedSectionHtml,
  strengthBarHtml,
  type RelatedListing,
} from "./wiki-related-view.ts";
import { STRENGTH_MAX } from "../../../wiki/related-constants.ts";

const DAY = 86_400_000;
/** One fixed instant: every age below is relative to it. */
const NOW = Date.parse("2026-10-04T12:00:00Z");

function row(over: Partial<RelatedListing> = {}): RelatedListing {
  return {
    name: "citer",
    relPath: "plans/citer.md",
    title: "Citing plan",
    type: "plan",
    why: "cites this page",
    ...over,
  } as RelatedListing;
}

describe("relatedSectionHtml", () => {
  test("NO block at all for an empty list — not a row saying nothing", () => {
    expect(relatedSectionHtml([])).toBe("");
  });

  test("a row carries both open keys and the count in the title", () => {
    const html = relatedSectionHtml([row()]);
    expect(html).toContain('<span class="wiki-rel-count">Related work (1)</span>');
    expect(html).toContain('data-page="citer"');
    expect(html).toContain('data-relpath="plans/citer.md"');
    expect(html).toContain("Citing plan");
  });

  test("each reason is its own `<em>` and the separators sit outside them", () => {
    const html = relatedSectionHtml([
      row({ why: "cites this page · shares RuneLind/muninn#549, RuneLind/muninn#550" }),
    ]);
    expect(html).toContain(
      "<em>cites this page</em> · <em>shares RuneLind/muninn#549, RuneLind/muninn#550</em>",
    );
  });

  test("the series opener renders per ROW, and only where a series may land", () => {
    const rows = [
      row({ relPath: "plans/citer.md" }),
      // An `.html` explainer (mimir carries 94) and the wiki's own bookkeeping
      // page: the route refuses both, so an opener on them can only produce a
      // refusal.
      row({ name: "report", relPath: "blogs/report.html" }),
      row({ name: "index", relPath: "plans/index.md" }),
    ];
    const html = relatedSectionHtml(rows, true);
    expect(html).toContain('data-series-menu="plans/citer.md"');
    expect(html).not.toContain('data-series-menu="blogs/report.html"');
    expect(html).not.toContain('data-series-menu="plans/index.md"');
    expect(html.match(/data-series-menu=/g) ?? []).toHaveLength(1);
    // Not editable ⇒ no opener at all, on any row — a visible control that
    // cannot act is the dead control #557's F2 decision rejected.
    expect(relatedSectionHtml(rows, false)).not.toContain("data-series-menu");
    expect(relatedSectionHtml(rows)).not.toContain("data-series-menu");
  });

  test("a `shares session` reason wraps each ref in its own span, text whole", () => {
    const html = relatedSectionHtml([row({ why: "cites this page · shares session claude-code:abc, def" })]);
    expect(html).toContain(
      '<em>shares session <span class="wiki-why-sess" title="claude-code:abc">claude-code:abc</span>, ' +
        '<span class="wiki-why-sess" title="def">def</span></em>',
    );
    expect(html).toContain("<em>cites this page</em>");
  });

  test("the why line and the title are escaped", () => {
    const html = relatedSectionHtml([row({ title: "<script>", why: "<b>why</b>" })]);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>why</b>");
    expect(html).toContain("&lt;b&gt;why&lt;/b&gt;");
  });

  test("the session refs come from `signals.sessions` when the row carries them", () => {
    const html = relatedSectionHtml([
      row({
        // The why text is cut at two refs; the signals carry the full ids.
        why: "shares session claude-code:abc",
        signals: { link: null, prs: [], sessions: ["claude-code:abc-full"] },
        strength: 1.2,
      }),
    ]);
    expect(html).toContain('<span class="wiki-why-sess" title="claude-code:abc-full">claude-code:abc-full</span>');
  });

  test("the toggle renders once there are two rows, with the chosen order pressed", () => {
    expect(relatedSectionHtml([row()])).not.toContain("data-rel-order");
    const html = relatedSectionHtml([row(), row({ relPath: "plans/b.md", name: "b" })], false, { order: "newest" });
    expect(html).toContain('data-rel-order="strongest" aria-pressed="false"');
    expect(html).toContain('data-rel-order="newest" aria-pressed="true"');
  });

  test("▸ renders per row, with its own hop body beside the row, only when asked", () => {
    expect(relatedSectionHtml([row()])).not.toContain("data-rel-hop");
    const html = relatedSectionHtml([row()], false, { hops: true });
    expect(html).toContain('data-rel-hop="plans/citer.md" aria-expanded="false"');
    expect(html).toContain(
      '<div class="wiki-rel-hop-body" id="wiki-rel-hop-0" data-rel-hop-for="plans/citer.md" aria-live="polite" hidden></div>',
    );
  });
});

describe("the strength bar", () => {
  test("one segment per counting signal, on the fixed STRENGTH_MAX scale", () => {
    const html = strengthBarHtml(
      row({ strength: 2.8, signals: { link: "both", prs: [], sessions: ["s1"] } }),
    );
    // 1.6 / 5.8 and 1.2 / 5.8, to one decimal of a percent.
    expect(html).toContain(`seg-link" style="width:${Math.round((1.6 / STRENGTH_MAX) * 1000) / 10}%"`);
    expect(html).toContain(`seg-sess" style="width:${Math.round((1.2 / STRENGTH_MAX) * 1000) / 10}%"`);
    expect(html).not.toContain("seg-pr");
    expect(html).toContain('<span class="wiki-rel-score"');
    expect(html).toContain(">2.8</span>");
  });

  test("shared PRs draw a segment only when the signal counts (none for a digest's empty list)", () => {
    expect(strengthBarHtml(row({ strength: 2.2, signals: { link: "in", prs: ["a#1", "a#2"], sessions: [] } }))).toContain(
      "seg-pr",
    );
    expect(strengthBarHtml(row({ strength: 1, signals: { link: "in", prs: [], sessions: [] } }))).not.toContain("seg-pr");
  });

  test("an older server's row (no signals) draws no bar", () => {
    expect(strengthBarHtml(row())).toBe("");
  });
});

describe("the neighbour's age", () => {
  const worked = row({ workedMs: NOW - 3 * DAY, mtimeMs: NOW - 3 * DAY } as Partial<RelatedListing>);
  const unworked = row({ mtimeMs: NOW - 5 * DAY } as Partial<RelatedListing>);

  test("off the ledger, the age carries no source marking", () => {
    expect(relatedAgeHtml(worked, NOW, false)).toMatch(/^<span class="wiki-rel-age" title="[^"]+">3d<\/span>$/);
    expect(relatedAgeHtml(unworked, NOW, false)).toMatch(/^<span class="wiki-rel-age" title="[^"]+">5d<\/span>$/);
  });

  test("on a covered wiki, it marks worked vs fallback the way the rail does", () => {
    expect(relatedAgeHtml(worked, NOW, true)).toContain('class="wiki-rel-age worked"');
    expect(relatedAgeHtml(unworked, NOW, true)).toContain('class="wiki-rel-age fallback"');
  });
});

describe("orderRelated", () => {
  const a = row({ relPath: "a.md", strength: 2.8, workedMs: NOW - 9 * DAY } as Partial<RelatedListing>);
  const b = row({ relPath: "b.md", strength: 1, workedMs: NOW - 1 * DAY } as Partial<RelatedListing>);
  const c = row({ relPath: "c.md", strength: 1.2, mtimeMs: NOW - 4 * DAY } as Partial<RelatedListing>);

  test("strongest keeps the server's order", () => {
    expect(orderRelated([a, c, b], "strongest", NOW).map((p) => p.relPath)).toEqual(["a.md", "c.md", "b.md"]);
  });

  test("newest sorts on the worked-on axis the age shows, update date as the fallback", () => {
    expect(orderRelated([a, c, b], "newest", NOW).map((p) => p.relPath)).toEqual(["b.md", "c.md", "a.md"]);
  });
});

describe("relatedHopHtml", () => {
  test("loading, error, empty and rows", () => {
    expect(relatedHopHtml("Hop", null)).toContain("Loading");
    expect(relatedHopHtml("Hop", { related: [], total: 0, error: "x" })).toContain("unavailable");
    expect(relatedHopHtml("Hop", { related: [], total: 0 })).toContain("Nothing else is related to Hop");
    const html = relatedHopHtml("Hop", { related: [row()], total: 3 }, { now: NOW });
    expect(html).toContain("Related to Hop · 1 of 3");
    // A hop row opens its page, and carries no ▸ and no series opener.
    expect(html).toContain('class="wiki-conn-item wiki-rel-hop-row" data-page="citer" data-relpath="plans/citer.md"');
    expect(html).not.toContain("data-rel-hop=");
    expect(html).not.toContain("data-series-menu");
  });
});

describe("fix round 1 — hop a11y, open state and order", () => {
  test("▸ names the body it controls, and the body announces Loading → rows", () => {
    const html = relatedSectionHtml([row(), row({ name: "b", relPath: "plans/b.md" })], false, { hops: true });
    const controls = [...html.matchAll(/data-rel-hop="[^"]+"[^>]*aria-controls="([^"]+)"/g)].map((m) => m[1]);
    expect(controls).toHaveLength(2);
    expect(new Set(controls).size).toBe(2);
    for (const id of controls) {
      expect(html).toMatch(new RegExp(`<div class="wiki-rel-hop-body" id="${id}" [^>]*aria-live="polite"`));
    }
  });

  test("an open hop renders open — expanded, ▾, body shown with its rows — across a re-render", () => {
    const hop = { related: [row({ name: "deep", relPath: "plans/deep.md", title: "Deep page" })], total: 1 };
    const html = relatedSectionHtml([row()], false, {
      hops: true,
      now: NOW,
      hopState: (rel) => (rel === "plans/citer.md" ? hop : undefined),
    });
    expect(html).toMatch(/data-rel-hop="plans\/citer.md" aria-expanded="true"[^>]*>▾<\/button>/);
    expect(html).not.toMatch(/data-rel-hop-for="plans\/citer.md"[^>]*hidden/);
    expect(html).toContain("Deep page");
    // In flight: open, Loading.
    const loading = relatedSectionHtml([row()], false, { hops: true, hopState: () => null });
    expect(loading).toContain('aria-expanded="true"');
    expect(loading).toContain("Loading");
  });

  test("hop rows follow the block's order toggle", () => {
    const strong = row({ name: "s", relPath: "s.md", title: "Strong old", strength: 2.8, workedMs: NOW - 9 * DAY } as Partial<RelatedListing>);
    const fresh = row({ name: "f", relPath: "f.md", title: "Weak new", strength: 1, workedMs: NOW - 1 * DAY } as Partial<RelatedListing>);
    const body = { related: [strong, fresh], total: 2 };
    const at = (html: string) => [html.indexOf("Strong old"), html.indexOf("Weak new")];
    const [s1, f1] = at(relatedHopHtml("Hop", body, { now: NOW, order: "strongest" }));
    expect(s1!).toBeLessThan(f1!);
    const [s2, f2] = at(relatedHopHtml("Hop", body, { now: NOW, order: "newest" }));
    expect(f2!).toBeLessThan(s2!);
  });
});
