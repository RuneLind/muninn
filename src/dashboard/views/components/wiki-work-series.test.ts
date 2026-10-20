/**
 * Save as series' plan (`wiki-work-series.ts`, D14) and the series write loop
 * it shares with the ⋯ series menu (`wiki-series-write.ts`). Synthetic pages.
 */

import { describe, expect, test } from "bun:test";
import { checkNewSeriesKey, recheckSaveAsSeries, saveAsSeriesPlan } from "./wiki-work-series.ts";
import { buildWorkEvidence } from "../../../wiki/work-evidence.ts";
import type { WikiPageMeta } from "../../../wiki/store.ts";
import { loadSeriesBaseMap, prepareSeriesSave, runSeriesWrites, type SeriesPostAnswer } from "./wiki-series-write.ts";
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

describe("an .html-twin child: the plan and the rail's membership agree", () => {
  test("after the plan's writes land on the parent, the evidence counts the twin focus page in the series, so the plan reads it as joined", () => {
    const before = [
      page("plans/a.md", { plan_status: "active", status_date: "2026-10-14" }),
      page("plans/a.html", { parent: "plans/a.md", pairedBy: "stem" }),
      page("plans/b.md", { plan_status: "active", status_date: "2026-10-10" }),
    ];
    const kids = [child("plans/a.html", ["plans/a.html"]), child("plans/b.md", ["plans/b.md"])];
    const p = plan(kids, before);
    expect(p).toMatchObject({ available: true, mode: "coin", key: "a" });
    expect(p.writes.map((w) => w.relPath)).toEqual(["plans/a.md", "plans/b.md"]);
    // The writes land: series: on both markdown pages, none on the twin.
    const after = before.map((x) => (x.relPath.endsWith(".md") ? { ...x, series: p.key } : x));
    const e = buildWorkEvidence({
      threads: kids.map((k) => k.unit.thread),
      candidates: 2,
      contributions: [],
      ledgerTruncated: false,
      pages: after as unknown as WikiPageMeta[],
    });
    // Every child's focus page is in the series the plan joined.
    expect(e.relations.series).toEqual({ "plans/a.html": "a", "plans/b.md": "a" });
    const again = plan(kids, after);
    expect(again.children.map((c) => c.joined.length)).toEqual([1, 1]);
  });
});

describe("recheckSaveAsSeries: the plan against a listing read after the bases", () => {
  const two = () => [
    page("plans/a.md", { plan_status: "active", status_date: "2026-10-14" }),
    page("plans/b.md", { plan_status: "active", status_date: "2026-10-10" }),
    page("plans/b2.md", { plan_status: "active", status_date: "2026-10-09" }),
    page("notes/s1.md", { series: "other" }),
  ];
  const kids = [child("plans/a.md", ["plans/a.md"]), child("plans/b.md", ["plans/b.md", "plans/b2.md"])];
  test("nothing moved: every planned write stays", () => {
    const p = plan(kids, two());
    const r = recheckSaveAsSeries(p, p.key, two());
    expect(r.error).toBeUndefined();
    expect(r.writes.map((w) => w.relPath)).toEqual(["plans/a.md", "plans/b.md", "plans/b2.md"]);
    expect(r.moved).toEqual([]);
  });
  test("a page put into another series since the menu opened is skipped and named; its child still has a page, so the rest is written", () => {
    const p = plan(kids, two());
    const fresh = two().map((x) => (x.relPath === "plans/b.md" ? { ...x, series: "other", seriesLabel: "Other work" } : x));
    const r = recheckSaveAsSeries(p, p.key, fresh);
    expect(r.error).toBeUndefined();
    expect(r.writes.map((w) => w.relPath)).toEqual(["plans/a.md", "plans/b2.md"]);
    expect(r.moved).toEqual([{ relPath: "plans/b.md", title: "T plans/b.md", series: "Other work" }]);
  });
  test("a child left with no page writes nothing at all (a half series would name no group)", () => {
    const k1 = [child("plans/a.md", ["plans/a.md"]), child("plans/b.md", ["plans/b.md"])];
    const p = plan(k1, two());
    const fresh = two().map((x) => (x.relPath === "plans/b.md" ? { ...x, series: "other", seriesLabel: "Other work" } : x));
    const r = recheckSaveAsSeries(p, p.key, fresh);
    expect(r.writes).toEqual([]);
    expect(r.error).toBe("Nothing written — joined another series since this menu opened: T plans/b.md (in «Other work»)");
  });
  test("a page that reached the planned key itself since is already in: not rewritten, still covers its child", () => {
    const p = plan(kids, two());
    const fresh = two().map((x) => (x.relPath === "plans/b.md" ? { ...x, series: p.key } : x));
    const r = recheckSaveAsSeries(p, p.key, fresh);
    expect(r.error).toBeUndefined();
    expect(r.writes.map((w) => w.relPath)).toEqual(["plans/a.md", "plans/b2.md"]);
  });
  test("join: a child covered by its already-joined page keeps the write going; that page leaving the series since leaves it uncovered", () => {
    const base = () => two().map((x) => (x.relPath === "plans/a.md" ? { ...x, series: "alpha", seriesLabel: "Alpha" } : x));
    const p = plan(kids, base());
    expect(p).toMatchObject({ mode: "join", key: "alpha" });
    const moved = base().map((x) => (x.relPath === "plans/b.md" ? { ...x, series: "other" } : x));
    const r = recheckSaveAsSeries(p, p.key, moved);
    expect(r.error).toBeUndefined();
    expect(r.writes.map((w) => w.relPath)).toEqual(["plans/b2.md"]);
    const left = moved.map((x) => (x.relPath === "plans/a.md" ? { ...x, series: "other" } : x));
    expect(recheckSaveAsSeries(p, p.key, left).error).toMatch(/^Nothing written/);
  });
  test("a new key that became a series elsewhere since the menu opened is refused, nothing written", () => {
    const p = plan(kids, two());
    expect(p.mode).toBe("coin");
    const fresh = [...two(), page("notes/late.md", { series: "Fresh" })];
    const r = recheckSaveAsSeries(p, "fresh", fresh);
    expect(r.writes).toEqual([]);
    expect(r.error).toBe('"fresh" became a series here since this menu opened — nothing written; pick another key');
    // A joined series' own members are no collision.
    const j = plan(kids, [...two(), page("plans/x.md", { series: "alpha" })].map((x) => (x.relPath === "plans/a.md" ? { ...x, series: "alpha" } : x)));
    expect(j.mode).toBe("join");
    expect(recheckSaveAsSeries(j, j.key, [...two(), page("plans/x.md", { series: "alpha" })].map((x) => (x.relPath === "plans/a.md" ? { ...x, series: "alpha" } : x))).error).toBeUndefined();
  });
});

describe("recheckSaveAsSeries: an already-joined page drifting since the click (fix round 2)", () => {
  // The head a.md is the joined page; b.md is the only planned write.
  const base = () => [
    page("plans/a.md", { plan_status: "active", status_date: "2026-10-14", series: "alpha", seriesLabel: "Alpha work" }),
    page("plans/b.md", { plan_status: "active", status_date: "2026-10-10" }),
    page("notes/o.md", { series: "other", seriesLabel: "Other" }),
  ];
  const kids = [child("plans/a.md", ["plans/a.md"]), child("plans/b.md", ["plans/b.md"])];
  const with_ = (o: Partial<WikiListing>) => base().map((x) => (x.relPath === "plans/a.md" ? { ...x, ...o } : x));
  test("the joined page moved to another series: nothing written, the page and its series named", () => {
    const p = plan(kids, base());
    expect(p).toMatchObject({ available: true, mode: "join", key: "alpha" });
    expect(p.writes.map((w) => w.relPath)).toEqual(["plans/b.md"]);
    const r = recheckSaveAsSeries(p, p.key, with_({ series: "other", seriesLabel: undefined }));
    expect(r.writes).toEqual([]);
    expect(r.error).toBe("Nothing written — left «Alpha work» since this menu opened: T plans/a.md (now in «Other»)");
    expect(r.retry).toBeUndefined();
  });
  test("the joined page's series: cleared: nothing written", () => {
    const p = plan(kids, base());
    const r = recheckSaveAsSeries(p, p.key, with_({ series: undefined }));
    expect(r.writes).toEqual([]);
    expect(r.error).toBe("Nothing written — left «Alpha work» since this menu opened: T plans/a.md (now in no series)");
  });
  test("a joined page that left, even with its child still covered by a write: nothing written (the group would span two series)", () => {
    const pages = () => [...base(), page("plans/a2.md", { plan_status: "active", status_date: "2026-10-12" })];
    const k2 = [child("plans/a.md", ["plans/a.md", "plans/a2.md"]), child("plans/b.md", ["plans/b.md"])];
    const p = plan(k2, pages());
    expect(p.writes.map((w) => w.relPath)).toEqual(["plans/a2.md", "plans/b.md"]);
    const r = recheckSaveAsSeries(p, p.key, pages().map((x) => (x.relPath === "plans/a.md" ? { ...x, series: "other" } : x)));
    expect(r.writes).toEqual([]);
    expect(r.error).toMatch(/^Nothing written — left «Alpha work»/);
  });
  test("the joined page still in the series under another spelling of the key: the write goes ahead", () => {
    const p = plan(kids, base());
    const r = recheckSaveAsSeries(p, p.key, with_({ series: "Alpha" }));
    expect(r.error).toBeUndefined();
    expect(r.writes.map((w) => w.relPath)).toEqual(["plans/b.md"]);
  });
});

describe("recheckSaveAsSeries: which refusals the reader can resolve in place", () => {
  const two = () => [page("plans/a.md", { plan_status: "active", status_date: "2026-10-14" }), page("plans/b.md", { plan_status: "active", status_date: "2026-10-10" })];
  const kids = [child("plans/a.md", ["plans/a.md"]), child("plans/b.md", ["plans/b.md"])];
  test("a key clash is retryable (pick another key); a page that moved is not", () => {
    const p = plan(kids, two());
    expect(recheckSaveAsSeries(p, "k", [...two(), page("notes/late.md", { series: "k" })])).toMatchObject({ retry: true });
    const moved = recheckSaveAsSeries(p, p.key, two().map((x) => (x.relPath === "plans/b.md" ? { ...x, series: "zz" } : x)));
    expect(moved.error).toMatch(/^Nothing written/);
    expect(moved.retry).toBeUndefined();
  });
});

describe("runSeriesWrites: one page per call, stop at the first failure", () => {
  test("a poster that rejects (network error) stops the sequence as a failed write, never a throw", async () => {
    const posted: string[] = [];
    const r = await runSeriesWrites(
      [{ relPath: "a.md", series: "k" }, { relPath: "b.md", series: "k" }, { relPath: "c.md", series: "k" }],
      new Map([["a.md", "h"], ["b.md", "h"], ["c.md", "h"]]),
      async (b) => {
        posted.push(b.relPath);
        if (b.relPath === "b.md") throw new TypeError("Failed to fetch");
        return { ok: true, status: 200, body: { hash: "x", written: true } };
      },
    );
    expect(posted).toEqual(["a.md", "b.md"]);
    expect(r).toMatchObject({ written: 1, total: 3, wrote: true, failure: { write: { relPath: "b.md" }, status: 0, error: "Network error: Failed to fetch" } });
  });

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



// Arch review 2026-10, finding 66: Save as series sent the hash the reader
// LOADED as the open page's CAS base, so a page changed on disk since then
// 409ed mid-sequence, after the pages before it were written.
describe("prepareSeriesSave: every base fresh, the open page included", () => {
  const disk = new Map([["plans/a.md", "a2"], ["plans/open.md", "open-now"], ["plans/c.md", "c1"]]);
  const hashOf = async (rel: string) => disk.get(rel) ?? null;
  test("the open page changed since it loaded: its fresh base is used and the change is named", async () => {
    const asked: string[] = [];
    const r = await prepareSeriesSave({
      relPaths: ["plans/a.md", "plans/open.md", "plans/c.md"],
      openRelPath: "Plans/Open.md",
      loadedHash: "open-at-load",
      hashOf: async (rel) => (asked.push(rel), hashOf(rel)),
    });
    expect(asked.sort()).toEqual(["plans/a.md", "plans/c.md", "plans/open.md"]);
    expect(r.bases.get("plans/open.md")).toBe("open-now");
    expect(r.openChanged).toBe("plans/open.md");
  });
  test("an unchanged open page saves: no change named", async () => {
    const r = await prepareSeriesSave({ relPaths: ["plans/a.md", "plans/open.md"], openRelPath: "plans/open.md", loadedHash: "open-now", hashOf });
    expect(r.openChanged).toBeNull();
    expect([...r.bases.keys()].sort()).toEqual(["plans/a.md", "plans/open.md"]);
  });
  test("an open page outside the plan, or no loaded hash, names nothing", async () => {
    expect((await prepareSeriesSave({ relPaths: ["plans/a.md"], openRelPath: "plans/open.md", loadedHash: "old", hashOf })).openChanged).toBeNull();
    expect((await prepareSeriesSave({ relPaths: ["plans/open.md"], openRelPath: "plans/open.md", loadedHash: null, hashOf })).openChanged).toBeNull();
  });
  test("an open page that cannot be read is missing, not changed", async () => {
    const r = await prepareSeriesSave({ relPaths: ["plans/gone.md"], openRelPath: "plans/gone.md", loadedHash: "old", hashOf });
    expect(r.missing).toEqual(["plans/gone.md"]);
    expect(r.openChanged).toBeNull();
  });
});

describe("runSeriesWrites batch marks (finding 75)", () => {
  const ok: SeriesPostAnswer = { ok: true, status: 200, body: { hash: "x", written: true } };
  const writes = [{ relPath: "a.md", series: "k" }, { relPath: "b.md", series: "k" }, { relPath: "c.md", series: "k" }];
  const bases = new Map([["a.md", "h"], ["b.md", "h"], ["c.md", "h"]]);
  test("a batch marks every write but the last defer, the last last", async () => {
    const sent: (string | undefined)[] = [];
    await runSeriesWrites(writes, bases, async (b) => (sent.push(b.batch), ok), { batch: true });
    expect(sent).toEqual(["defer", "defer", "last"]);
  });
  test("one write, or no batch option, sends no mark", async () => {
    const sent: (string | undefined)[] = [];
    await runSeriesWrites(writes.slice(0, 1), bases, async (b) => (sent.push(b.batch), ok), { batch: true });
    await runSeriesWrites(writes, bases, async (b) => (sent.push(b.batch), ok));
    expect(sent).toEqual([undefined, undefined, undefined, undefined]);
  });
});
