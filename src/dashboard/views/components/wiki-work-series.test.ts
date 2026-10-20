/**
 * Save as series' plan (`wiki-work-series.ts`, D14) and the series write loop
 * it shares with the ⋯ series menu (`wiki-series-write.ts`). Synthetic pages.
 */

import { describe, expect, test } from "bun:test";
import { checkNewSeriesKey, recheckSaveAsSeries, saveAsSeriesPlan } from "./wiki-work-series.ts";
import { buildWorkEvidence } from "../../../wiki/work-evidence.ts";
import type { WikiPageMeta } from "../../../wiki/store.ts";
import { loadSeriesBaseMap, openPageChanged, openPageRefusal, runSeriesWrites, writeSeriesUnlessOpenChanged, type SeriesPostAnswer } from "./wiki-series-write.ts";
// Namespace import for the fix-round-2 batch-2 seams, so each case reports its
// own failure rather than the whole file failing to link.
import * as seriesWrite from "./wiki-series-write.ts";
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
describe("openPageChanged: the open page's fresh base against the hash it loaded with", () => {
  const bases = new Map([["plans/a.md", "a2"], ["plans/open.md", "open-now"]]);
  test("changed since it loaded: named as the bases hold it", () => {
    expect(openPageChanged({ relPath: "Plans/Open.md", loadedHash: "open-at-load" }, bases)).toBe("plans/open.md");
  });
  test("unchanged, outside the bases, or no loaded hash: nothing named", () => {
    expect(openPageChanged({ relPath: "plans/open.md", loadedHash: "open-now" }, bases)).toBeNull();
    expect(openPageChanged({ relPath: "plans/gone.md", loadedHash: "old" }, bases)).toBeNull();
    expect(openPageChanged({ relPath: "plans/open.md", loadedHash: null }, bases)).toBeNull();
    expect(openPageChanged({ relPath: null, loadedHash: "old" }, bases)).toBeNull();
  });
});

// Fix round 2 (finding 3): the one write entry both the ⋯ menu and Save as
// series call, so the refusal is pinned here rather than in the browser glue.
describe("writeSeriesUnlessOpenChanged: refuse before any write, else run the loop", () => {
  const ok: SeriesPostAnswer = { ok: true, status: 200, body: { hash: "new", written: true } };
  const writes = [{ relPath: "plans/a.md", series: "k" }, { relPath: "plans/open.md", series: "k" }];
  const bases = new Map([["plans/a.md", "a2"], ["plans/open.md", "open-now"]]);
  const recorder = () => {
    const sent: string[] = [];
    return { sent, post: async (b: { relPath: string; baseHash: string }) => (sent.push(`${b.relPath}@${b.baseHash}`), ok) };
  };
  test("the open page changed since it loaded and is written: refused, nothing posted", async () => {
    const r = recorder();
    const out = await writeSeriesUnlessOpenChanged({ writes, bases, open: { relPath: "plans/open.md", loadedHash: "open-at-load" }, post: r.post });
    expect(out.refusal).toBe("plans/open.md changed since you opened it — reload it; nothing written");
    expect(out.run).toBeUndefined();
    expect(r.sent).toEqual([]);
  });
  test("unchanged: every write posted with its fresh base", async () => {
    const r = recorder();
    const out = await writeSeriesUnlessOpenChanged({ writes, bases, open: { relPath: "plans/open.md", loadedHash: "open-now" }, post: r.post });
    expect(out.refusal).toBeNull();
    expect(out.run?.written).toBe(2);
    expect(r.sent).toEqual(["plans/a.md@a2", "plans/open.md@open-now"]);
  });
  test("a changed open page the sequence does not write: the sequence runs", async () => {
    const r = recorder();
    const out = await writeSeriesUnlessOpenChanged({ writes: writes.slice(0, 1), bases, open: { relPath: "plans/open.md", loadedHash: "open-at-load" }, post: r.post });
    expect(out.refusal).toBeNull();
    expect(r.sent).toEqual(["plans/a.md@a2"]);
  });
});

// Fix round 1 (finding I): the refusal `writeSeriesUnlessOpenChanged` makes
// before any write — for Save as series and the ⋯ menu alike.
describe("openPageRefusal: an open page changed on disk refuses the whole sequence", () => {
  const writes = [{ relPath: "plans/a.md", series: "k" }, { relPath: "plans/open.md", series: "k" }];
  test("changed and among the writes: refused, naming the page", () => {
    expect(openPageRefusal("plans/open.md", writes)).toBe("plans/open.md changed since you opened it — reload it; nothing written");
  });
  test("changed and among the writes under another spelling: still refused", () => {
    expect(openPageRefusal("Plans/Open.md", writes)).toContain("changed since you opened it");
  });
  test("changed but NOT among the writes: proceeds", () => {
    expect(openPageRefusal("plans/elsewhere.md", writes)).toBeNull();
  });
  test("unchanged: proceeds", () => {
    expect(openPageRefusal(null, writes)).toBeNull();
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

// Fix round 2 batch 2, finding 1: the reader's OWN write moved the open page's
// bytes before its answer moved the load-time hash, so a menu opened in that
// window blamed the reader for the change. A base read now waits for every
// sequence in flight when it starts, and snapshots the open page after them.
describe("readSeriesBasesAfterWrites: the reader's own writes settle before a base read", () => {
  test("a read started while a write is in flight sees the hash that write's answer adopted", async () => {
    let disk = "h0";
    let loaded = "h0";
    let answer!: () => void;
    const answered = new Promise<void>((r) => (answer = r));
    // The POST lands on disk at once; its answer, which moves the reader's
    // load-time hash, arrives later.
    const write = seriesWrite.trackSeriesWrite(async () => {
      disk = "h1";
      await answered;
      loaded = "h1";
    });
    const read = seriesWrite.readSeriesBasesAfterWrites(["plans/open.md"], async () => disk, () => ({ relPath: "plans/open.md", loadedHash: loaded }));
    answer();
    await write;
    const out = await read;
    expect(out.open.loadedHash).toBe("h1");
    expect(out.bases.get("plans/open.md")).toBe("h1");
    expect(openPageChanged(out.open, out.bases)).toBeNull();
  });

  test("a sequence that failed still releases the read, and its caller still sees the failure", async () => {
    const write = seriesWrite.trackSeriesWrite(async () => {
      throw new Error("refused");
    });
    const read = seriesWrite.readSeriesBasesAfterWrites(["plans/a.md"], async () => "a1", () => ({ relPath: null, loadedHash: null }));
    await expect(write).rejects.toThrow("refused");
    expect((await read).bases.get("plans/a.md")).toBe("a1");
  });

  test("a read does not wait for a sequence that started after it, so a sequence may await its own earlier read", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const read = seriesWrite.readSeriesBasesAfterWrites(["plans/a.md"], async () => (await gate, "a1"), () => ({ relPath: null, loadedHash: null }));
    const write = seriesWrite.trackSeriesWrite(async () => (await read).bases.get("plans/a.md"));
    release();
    const settled = await Promise.race([write, new Promise((r) => setTimeout(() => r("deadlock"), 500))]);
    expect(settled).toBe("a1");
  });
});

// Fix round 2 batch 2, finding 2: a 409 told the reader to close and reopen
// the menu even when the page was the OPEN one — whose reopen then refused
// with "reload it". The step now follows the page.
describe("seriesConflictCopy: a 409 names the step that clears it", () => {
  test("the open page: reload, since a reopen compares it with the hash it loaded with", () => {
    const c = seriesWrite.seriesConflictCopy("plans/open.md", "Plans/Open.md");
    expect(c.note).toBe("plans/open.md changed since this menu opened — reload it");
    expect(c.again).toBe("Reload the page — it has changed");
  });
  test("any other page, or no page open: close and reopen, which reads its base fresh", () => {
    for (const open of ["plans/elsewhere.md", null]) {
      const c = seriesWrite.seriesConflictCopy("plans/a.md", open);
      expect(c.note).toBe("plans/a.md changed since this menu opened — close and reopen it");
      expect(c.again).toBe("Close and reopen this menu — the page has changed");
    }
  });
});
