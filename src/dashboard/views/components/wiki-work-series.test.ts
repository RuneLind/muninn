/**
 * Save as series' plan (`wiki-work-series.ts`, D14) and the series write loop
 * it shares with the ⋯ series menu (`wiki-series-write.ts`). Synthetic pages.
 */

import { describe, expect, test } from "bun:test";
import { checkNewSeriesKey, saveAsSeriesPlan } from "./wiki-work-series.ts";
import { loadSeriesBaseMap, runSeriesWrites, type SeriesPostAnswer } from "./wiki-series-write.ts";
import type { WikiListing } from "./wiki-filter.ts";
import type { WorkGroupChild } from "./wiki-work-groups.ts";
import { coinSeriesKey, isNarrativePage, seriesPageStem } from "../../../wiki/series-rules.ts";
import * as lint from "../../../wiki/lint-series.ts";



function page(relPath: string, o: Partial<WikiListing> = {}): WikiListing {
  return { relPath, name: relPath, title: `T ${relPath}`, type: "plan", domain: "ai", tags: [], aliases: [], linkCount: 0, backlinkCount: 0, ...o } as WikiListing;
}
function child(key: string, pages: string[], name = key): Pick<WorkGroupChild, "unit" | "name" | "key"> {
  return { key, name, unit: { key, index: 0, sub: 0, isolated: false, rank: { key, pages, touched: [], sessions: [] }, thread: { key, pages, touched: [], sessions: [] } } } as never;
}
const plan = (children: ReturnType<typeof child>[], pages: WikiListing[]) => saveAsSeriesPlan({ children: children as WorkGroupChild[] }, pages);

describe("series-rules (IO-free, re-exported by lint-series)", () => {
  test("the linter re-exports the same functions", () => {
    expect(lint.isNarrativePage).toBe(isNarrativePage);
    expect(lint.coinSeriesKey).toBe(coinSeriesKey);
  });
  test("coinSeriesKey mutates its taken set; a fresh set per caller", () => {
    const taken = new Set(["a"]);
    expect(coinSeriesKey("a", taken)).toBe("a-2");
    expect(coinSeriesKey("A", taken)).toBe("A-3");
    expect([...taken]).toEqual(["a", "a-2", "a-3"]);
    expect(seriesPageStem("plans/x/My-plan.mdx")).toBe("My-plan");
  });
  test("isNarrativePage reads status_date too", () => {
    expect(isNarrativePage({ relPath: "projects/x.md", type: "note" })).toBe(false);
    expect(isNarrativePage({ relPath: "projects/x.md", type: "note", status_date: "2026-10-01" })).toBe(true);
  });
});

describe("saveAsSeriesPlan", () => {
  test("no series among the pages: a coined key from the head's stem, unique under the census", () => {
    const pages = [page("plans/living.md", { plan_status: "active", status_date: "2026-10-10" }), page("plans/lenses.md", { plan_status: "active", status_date: "2026-10-01" }), page("plans/other.md", { series: "living" })];
    const p = plan([child("plans/living.md", ["plans/living.md"]), child("plans/lenses.md", ["plans/lenses.md"])], pages);
    expect(p).toMatchObject({ available: true, mode: "coin", key: "living-2" });
    expect(p.writes.map((w) => w.relPath)).toEqual(["plans/living.md", "plans/lenses.md"]);
    expect(checkNewSeriesKey(p, "Living")).toEqual({ error: '"Living" is already a series here — pick another key' });
    expect(checkNewSeriesKey(p, " fresh ")).toEqual({ key: "fresh" });
    expect(checkNewSeriesKey(p, "  ")).toEqual({ error: "Type a series key" });
  });

  test("exactly one series among the pages: join it (its head's spelling), writing only the pages in none", () => {
    const pages = [page("plans/a.md", { series: "Alpha", seriesLabel: "Alpha work" }), page("plans/b.md")];
    const p = plan([child("plans/a.md", ["plans/a.md"]), child("plans/b.md", ["plans/b.md"])], pages);
    expect(p).toMatchObject({ available: true, mode: "join", key: "Alpha", label: "Alpha work" });
    expect(p.children.map((c) => [c.joined.map((x) => x.relPath), c.write.map((x) => x.relPath)])).toEqual([
      [["plans/a.md"], []],
      [[], ["plans/b.md"]],
    ]);
  });

  test("two series: refused, naming both", () => {
    const pages = [page("plans/a.md", { series: "alpha" }), page("plans/b.md", { series: "beta", seriesLabel: "Beta" }), page("plans/c.md")];
    const p = plan([child("plans/a.md", ["plans/a.md", "plans/c.md"]), child("plans/b.md", ["plans/b.md"])], pages);
    expect(p).toMatchObject({ available: false, block: { kind: "several-series", labels: ["Beta", "alpha"] } });
  });

  test("a child with no writable or joined page leaves the action disabled, naming it; reference, reserved and retired pages are skipped with why", () => {
    const pages = [page("plans/a.md"), page("projects/overview.md", { type: "note" }), page("plans/index.md"), page("plans/old.md", { culled: true })];
    const p = plan([child("plans/a.md", ["plans/a.md"]), child("x", ["projects/overview.md", "plans/index.md", "plans/old.md"], "Reference thread")], pages);
    expect(p).toMatchObject({ available: false, block: { kind: "uncovered", children: ["Reference thread"] } });
    expect(p.children[1]!.skipped.map((s) => s.why)).toEqual(["not-narrative", "not-editable", "retired"]);
  });

  test("an .html twin writes its markdown parent; a page in another series is listed and left alone; a key the rail does not count is skipped", () => {
    const pages = [
      page("plans/a.md", { series: "alpha" }),
      page("plans/b.md"),
      page("plans/b.html", { parent: "plans/b.md", pairedBy: "stem" }),
      page("plans/new.md", { series: "alpha", seriesLabel: "Alpha" }),
      page("plans/gone.md", { series: "zeta", parent: "plans/nowhere.md", pairedBy: "superseded" }),
    ];
    const p = plan([child("plans/a.md", ["plans/a.md"]), child("plans/b.html", ["plans/b.html", "plans/gone.md"])], pages);
    expect(p.mode).toBe("join");
    expect(p.children[1]!.write.map((w) => w.relPath)).toEqual(["plans/b.md"]);
    expect(p.children[1]!.skipped.map((s) => [s.relPath, s.why])).toEqual([["plans/gone.md", "not-counted"]]);
    const other = plan([child("plans/a.md", ["plans/a.md"]), child("plans/b.md", ["plans/b.md"])], [page("plans/a.md", { series: "alpha" }), page("plans/b.md")]);
    expect(other.available).toBe(true);
  });
});

describe("runSeriesWrites: one page per call, stop at the first failure", () => {
  const ok = (hash: string): SeriesPostAnswer => ({ ok: true, status: 200, body: { hash, written: true } });
  test("all land: written N of N, hashes recorded", async () => {
    const posted: string[] = [];
    const r = await runSeriesWrites(
      [{ relPath: "a.md", series: "k" }, { relPath: "b.md", series: "k" }],
      new Map([["a.md", "h1"], ["b.md", "h2"]]),
      async (b) => (posted.push(`${b.relPath}@${b.baseHash}`), ok(`n-${b.relPath}`)),
    );
    expect(posted).toEqual(["a.md@h1", "b.md@h2"]);
    expect(r).toMatchObject({ written: 2, total: 2, wrote: true });
    expect([...r.hashes]).toEqual([["a.md", "n-a.md"], ["b.md", "n-b.md"]]);
  });
  test("a refused write stops the sequence: k of N, the failing write named, later pages never posted", async () => {
    const posted: string[] = [];
    const r = await runSeriesWrites(
      [{ relPath: "a.md", series: "k" }, { relPath: "b.md", series: "k" }, { relPath: "c.md", series: "k" }],
      new Map([["a.md", "h"], ["b.md", "h"], ["c.md", "h"]]),
      async (b) => (posted.push(b.relPath), b.relPath === "b.md" ? { ok: false, status: 409, body: { error: "changed" } } : ok("x")),
    );
    expect(posted).toEqual(["a.md", "b.md"]);
    expect(r).toMatchObject({ written: 1, total: 3, failure: { write: { relPath: "b.md" }, status: 409, error: "changed" } });
  });
  test("a missing base stops before posting that page", async () => {
    const r = await runSeriesWrites([{ relPath: "a.md", series: "k" }], new Map(), async () => ok("x"));
    expect(r).toMatchObject({ written: 0, failure: { status: 0, error: "Could not read a.md" } });
  });
  test("loadSeriesBaseMap reads every base first and names the missing ones", async () => {
    const r = await loadSeriesBaseMap(["b.md", "a.md", "b.md"], async (rel) => (rel === "a.md" ? null : "h"));
    expect([...r.bases]).toEqual([["b.md", "h"]]);
    expect(r.missing).toEqual(["a.md"]);
  });
});


