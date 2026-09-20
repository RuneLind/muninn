/**
 * The series editor's PURE half: which series the menu offers, what it says
 * about the page it was opened on, and the two writes a head move is.
 *
 * Everything here is a fact about the listing, so it is testable without a
 * browser — which is the whole reason the module exists apart from
 * `wiki-browser.ts`.
 */

import { describe, expect, test } from "bun:test";
import {
  buildSeriesMenu,
  headMoveWrites,
  seriesMenuHtml,
  SERIES_MENU_MAX,
} from "./wiki-series-menu.ts";
import { normalizeSeriesKey } from "./wiki-groups.ts";
import type { WikiListing } from "./wiki-filter.ts";

function page(relPath: string, over: Partial<WikiListing> = {}): WikiListing {
  return {
    name: relPath.replace(/^.*\//, "").replace(/\.mdx?$/, ""),
    relPath,
    title: over.title ?? relPath,
    type: "note",
    tags: [],
    linkCount: 0,
    backlinkCount: 0,
    ...over,
  } as WikiListing;
}

/** Four pages: a labelled head, a member sharing the key in another case, a
 *  member of a second series, and a page in none. */
const PAGES: WikiListing[] = [
  page("plans/alpha.mdx", {
    title: "Alpha plan",
    series: "prov",
    seriesLabel: "Wiki provenance",
    plan_status: "in-flight",
    status_date: "2026-09-02",
  }),
  page("plans/beta.mdx", {
    title: "Beta plan",
    series: "Prov",
    plan_status: "shipped",
    status_date: "2026-09-01",
  }),
  page("plans/rail.mdx", {
    title: "Rail plan",
    series: "rail",
    plan_status: "shipped",
    status_date: "2026-05-01",
  }),
  page("plans/lone.mdx", { title: "Lone plan", plan_status: "proposed" }),
];

describe("buildSeriesMenu", () => {
  test("is undefined for a relPath the listing does not hold", () => {
    expect(buildSeriesMenu(PAGES, "plans/ghost.mdx")).toBeUndefined();
  });

  test("reports the open page's own series, its label and the labelled member", () => {
    const m = buildSeriesMenu(PAGES, "plans/beta.mdx")!;
    expect(m.current).toBe("Prov");
    expect(m.label).toBe("Wiki provenance");
    // The RAW relPath, not the lower-cased comparison form — it is a write
    // target that goes back over the wire.
    expect(m.headRel).toBe("plans/alpha.mdx");
    expect(m.members.map((r) => r.relPath)).toEqual(["plans/alpha.mdx", "plans/beta.mdx"]);
    expect(m.members.find((r) => r.open)!.relPath).toBe("plans/beta.mdx");
    expect(m.members.find((r) => r.head)!.relPath).toBe("plans/alpha.mdx");
  });

  test("a page in no series has no members, no label and no head", () => {
    const m = buildSeriesMenu(PAGES, "plans/lone.mdx")!;
    expect(m.current).toBe("");
    expect(m.label).toBe("");
    expect(m.headRel).toBe("");
    expect(m.members).toEqual([]);
  });

  test("offers every series the wiki holds, newest-worked-on first", () => {
    const m = buildSeriesMenu(PAGES, "plans/lone.mdx")!;
    expect(m.options.map((o) => o.label)).toEqual(["Wiki provenance", "rail"]);
    expect(m.options.map((o) => o.count)).toEqual([2, 1]);
    // Nothing is `current` — the page is in no series.
    expect(m.options.some((o) => o.current)).toBe(false);
  });

  test("marks the open page's own series current, folding the case", () => {
    // `beta` spells the key `Prov` and the head spells it `prov`.
    const m = buildSeriesMenu(PAGES, "plans/beta.mdx")!;
    const prov = m.options.find((o) => o.label === "Wiki provenance")!;
    expect(prov.current).toBe(true);
    expect(prov.key).toBe("prov");
    expect(m.options.filter((o) => o.current)).toHaveLength(1);
  });

  test("caps the list but never drops the page's OWN series", () => {
    const many: WikiListing[] = [];
    for (let i = 0; i < SERIES_MENU_MAX + 3; i++) {
      many.push(
        page(`plans/s${i}.mdx`, {
          title: `S${i}`,
          series: `s${i}`,
          plan_status: "shipped",
          // Newest first by index, so `old` below sorts last of all.
          status_date: `2026-09-${String(20 - i).padStart(2, "0")}`,
        }),
      );
    }
    const old = page("plans/old.mdx", {
      title: "Old",
      series: "ancient",
      plan_status: "shipped",
      status_date: "2020-01-01",
    });
    const m = buildSeriesMenu([...many, old], "plans/old.mdx")!;
    expect(m.options).toHaveLength(SERIES_MENU_MAX);
    const current = m.options.filter((o) => o.current);
    expect(current).toHaveLength(1);
    expect(current[0]!.key).toBe("ancient");
  });
});

describe("headMoveWrites", () => {
  test("clears the old head FIRST, then sets the new one", () => {
    const m = buildSeriesMenu(PAGES, "plans/alpha.mdx")!;
    expect(headMoveWrites(m, "plans/beta.mdx", "Wiki provenance")).toEqual([
      { relPath: "plans/alpha.mdx", series: "prov", seriesLabel: null },
      { relPath: "plans/beta.mdx", series: "prov", seriesLabel: "Wiki provenance" },
    ]);
  });

  test("is ONE write when the target already is the head", () => {
    const m = buildSeriesMenu(PAGES, "plans/alpha.mdx")!;
    expect(headMoveWrites(m, "plans/alpha.mdx", "Renamed")).toEqual([
      { relPath: "plans/alpha.mdx", series: "prov", seriesLabel: "Renamed" },
    ]);
  });

  test("is ONE write when no member carries a label yet", () => {
    const unlabelled = PAGES.map((p) =>
      p.relPath === "plans/alpha.mdx" ? { ...p, seriesLabel: undefined } : p,
    );
    const m = buildSeriesMenu(unlabelled, "plans/beta.mdx")!;
    expect(m.headRel).toBe("");
    expect(headMoveWrites(m, "plans/beta.mdx", "New name")).toEqual([
      { relPath: "plans/beta.mdx", series: "Prov", seriesLabel: "New name" },
    ]);
  });
});

describe("normalizeSeriesKey", () => {
  test("answers an existing member's spelling for any case variant", () => {
    expect(normalizeSeriesKey(PAGES, "PROV")).toBe("prov");
    expect(normalizeSeriesKey(PAGES, "  prov  ")).toBe("prov");
  });

  test("answers the trimmed input for a key nothing holds", () => {
    expect(normalizeSeriesKey(PAGES, "  Brand New  ")).toBe("Brand New");
  });

  test("answers `` for a blank key", () => {
    expect(normalizeSeriesKey(PAGES, "   ")).toBe("");
  });
});

describe("seriesMenuHtml", () => {
  test("the rail view offers the series list and the new-key field, no head verbs", () => {
    const html = seriesMenuHtml(buildSeriesMenu(PAGES, "plans/lone.mdx")!, false);
    expect(html).toContain('data-series-cmd="join"');
    expect(html).toContain('data-series-form="new"');
    expect(html).not.toContain('data-series-cmd="head"');
    expect(html).not.toContain('data-series-form="label"');
    // Nothing to remove — the page is in no series.
    expect(html).not.toContain('data-series-cmd="remove"');
  });

  test("the edit view adds the label field, the head verbs and remove", () => {
    const html = seriesMenuHtml(buildSeriesMenu(PAGES, "plans/beta.mdx")!, true);
    expect(html).toContain('data-series-form="label"');
    expect(html).toContain('value="Wiki provenance"');
    expect(html).toContain('data-series-cmd="head" data-series-arg="plans/beta.mdx"');
    expect(html).toContain('data-series-cmd="remove"');
    // The member that already IS the head gets no "make head" row.
    expect(html).not.toContain('data-series-arg="plans/alpha.mdx"');
  });

  test("the page's own series renders INERT, not as a live join", () => {
    const html = seriesMenuHtml(buildSeriesMenu(PAGES, "plans/beta.mdx")!, false);
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain('data-series-cmd="join" data-series-arg="prov"');
    // The other series is still joinable.
    expect(html).toContain('data-series-cmd="join" data-series-arg="rail"');
  });

  test("escapes a title, a label and a key into every sink", () => {
    const nasty = [
      page("plans/x.mdx", {
        title: '<img src=x onerror="a">',
        series: '"><script>',
        seriesLabel: "<b>lab</b>",
        plan_status: "shipped",
        status_date: "2026-01-01",
      }),
    ];
    const html = seriesMenuHtml(buildSeriesMenu(nasty, "plans/x.mdx")!, true);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>lab</b>");
  });
});
