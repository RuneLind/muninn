/**
 * The grouping record's boundary rows (PR 4 of plan
 * `muninn-wiki-work-thread-grouping`, D17): splits and kept-apart anchors are
 * LIST OPERATIONS in a tab's patch, laid on the list as read at each write, so
 * two tabs never lose each other's entries; the anchor rows (A1–A3: a
 * re-anchor with and without focus, a split that takes a kept-apart anchor,
 * two anchors on one thread) and Reset. The table is in `src/wiki/CLAUDE.md`.
 */

import { describe, expect, test } from "bun:test";
import {
  applyWorkGroupEdit,
  mergeWorkGroupPatch,
  patchWorkGroupEdit,
  readWorkGroupRecord,
  serializeWorkGroupRecord,
  workGroupAddRefused,
  workGroupPrefsOf,
  workGroupRecordSettle,
  workGroupRecordStep,
  type WorkGroupEdit,
  type WorkGroupRecord,
  type WorkGroupRecordState,
} from "./wiki-work-group-record.ts";

const rec = (r: Omit<WorkGroupRecord, "version">): WorkGroupRecord => ({ version: 1, ...r });
const fresh: WorkGroupRecordState = { held: null, known: null, patch: null, failed: false };
const SX = { id: "sx", page: "plans/x.md" };
const SY = { id: "sy", page: "plans/y.md" };

function store(initial: WorkGroupRecord | null = null) {
  const s = { v: initial ? serializeWorkGroupRecord(initial) : (null as string | null), readable: true, writable: true, writes: 0 };
  return {
    s,
    read: (): WorkGroupRecord | null | undefined => (s.readable ? readWorkGroupRecord(s.v) : undefined),
    write: (r: WorkGroupRecord): boolean => {
      if (!s.writable) return false;
      s.v = serializeWorkGroupRecord(r);
      s.writes++;
      return true;
    },
    stored: () => readWorkGroupRecord(s.v),
  };
}

function tab(st: ReturnType<typeof store>) {
  let state = workGroupRecordStep(fresh, { kind: "boot", stored: st.read() }).state;
  const run = (t: Parameters<typeof workGroupRecordStep>[1]) => {
    const r = workGroupRecordStep(state, t);
    state = r.write ? workGroupRecordSettle(r.state, r.write.value, st.write(r.write.value)) : r.state;
    return r;
  };
  return {
    state: () => state,
    shown: () => workGroupPrefsOf(state.held),
    click: (edit: WorkGroupEdit) => run({ kind: "click", stored: st.read(), edit }),
    render: (focused = true, reanchor?: [string, string][]) => run({ kind: "render", stored: st.read(), focused, ...(reanchor ? { reanchor } : {}) }),
    event: () => run({ kind: "storage", stored: st.read(), booted: true }),
  };
}

describe("list edits are operations, applied by id or page", () => {
  test("add is idempotent by id and by page; remove matches either; an entry this build cannot read is kept", () => {
    const base = rec({ splits: [{ id: "old", page: "Plans/X.md" }, { weird: true }], keptApart: ["a.md", 7] });
    expect(applyWorkGroupEdit(base, { split: SX }).splits).toEqual(base.splits);
    expect(applyWorkGroupEdit(base, { split: SY }).splits).toEqual([...(base.splits as unknown[]), SY]);
    expect(applyWorkGroupEdit(base, { unsplit: { id: "zz", page: "plans/x.md" } }).splits).toEqual([{ weird: true }]);
    expect(applyWorkGroupEdit(base, { keepApart: "A.md" }).keptApart).toEqual(["a.md", 7]);
    expect(applyWorkGroupEdit(base, { allowGrouping: ["a.md"] }).keptApart).toEqual([7]);
  });

  test("a patch holds operations, never this tab's copy of a list", () => {
    let p = patchWorkGroupEdit(null, { split: SX });
    p = patchWorkGroupEdit(p, { stop: "areas" });
    expect(p).toEqual({ version: 1, listOps: [{ op: "addSplit", split: SX }], stop: "areas" });
    // Laid on another record's list, the other entry survives.
    expect(mergeWorkGroupPatch(rec({ splits: [SY] }), p)).toEqual(rec({ stop: "areas", splits: [SY, SX] }));
  });

  test("Reset clears the four preferences, keeps an unknown field and evidence key, and clears what the patch held before it", () => {
    const base = rec({ stop: "areas", evidence: { series: false, future: 1 }, splits: [SX], keptApart: ["a.md"], extra: "kept" });
    expect(applyWorkGroupEdit(base, { reset: true })).toEqual(rec({ evidence: { future: 1 }, extra: "kept" }));
    let p = patchWorkGroupEdit(null, { split: SY });
    // Reset clears what the tab's view holds: the record with the patch on top.
    p = patchWorkGroupEdit(p, { reset: true }, mergeWorkGroupPatch(base, p));
    p = patchWorkGroupEdit(p, { evidence: "issue", value: false });
    expect(mergeWorkGroupPatch(base, p)).toEqual(rec({ extra: "kept", evidence: { future: 1, issue: false } }));
  });
});

describe("two tabs (D17 with lists)", () => {
  test("T1: two tabs add different splits, one never having heard of the other's write: both stay", () => {
    const st = store();
    const a = tab(st);
    const b = tab(st);
    a.click({ split: SX });
    // B missed the storage event: its click reads the stored record, which
    // differs from what it knew, so its edit lands on THAT list.
    b.click({ split: SY });
    expect(workGroupPrefsOf(st.stored()).splits).toEqual([SX, SY]);
    b.event();
    a.event();
    expect(a.shown().splits).toEqual(b.shown().splits);
  });

  test("T2: one tab returns a split while another adds one: the return removes only its own", () => {
    const st = store(rec({ splits: [SX] }));
    const a = tab(st);
    const b = tab(st);
    a.click({ unsplit: SX });
    b.click({ split: SY });
    expect(workGroupPrefsOf(st.stored()).splits).toEqual([SY]);
  });

  test("T3: two tabs keep different threads apart and one allows a third to group again", () => {
    const st = store(rec({ keptApart: ["c.md"] }));
    const a = tab(st);
    const b = tab(st);
    a.click({ keepApart: "a.md" });
    b.click({ keepApart: "b.md" });
    a.click({ allowGrouping: ["c.md"] });
    expect(workGroupPrefsOf(st.stored()).keptApart.sort()).toEqual(["a.md", "b.md"]);
  });

  test("T4: a refused split stays in the tab and is written on the first focused render once storage takes it, onto the other tab's list", () => {
    const st = store();
    const a = tab(st);
    st.s.writable = false;
    a.click({ split: SX });
    expect(a.state().failed).toBe(true);
    st.s.writable = true;
    a.render(true);
    expect(workGroupPrefsOf(st.stored()).splits).toEqual([SX]);
    expect(a.state().failed).toBe(false);
  });
});

describe("the anchor rows (A1–A3)", () => {
  test("A1 a re-anchor on a focused render, storage = known: the move joins the patch and is written once", () => {
    const st = store(rec({ keptApart: ["old.md"] }));
    const a = tab(st);
    const r = a.render(true, [["old.md", "new.md"]]);
    expect(r.write).toEqual({ value: rec({ keptApart: ["new.md"] }) });
    expect(workGroupPrefsOf(st.stored()).keptApart).toEqual(["new.md"]);
    // The next render's re-anchor is empty: no second write.
    const writes = st.s.writes;
    a.render(true, []);
    expect(st.s.writes).toBe(writes);
  });

  test("A2 a re-anchor without focus moves the anchor in memory only; the first focused render writes it", () => {
    const st = store(rec({ keptApart: ["old.md"] }));
    const a = tab(st);
    expect(a.render(false, [["old.md", "new.md"]]).write).toBe(false);
    expect(a.shown().keptApart).toEqual(["new.md"]);
    expect(st.stored()).toEqual(rec({ keptApart: ["old.md"] }));
    a.render(true, []);
    expect(workGroupPrefsOf(st.stored()).keptApart).toEqual(["new.md"]);
  });

  test("A2' a re-anchor never overwrites another tab's newer record: R3 adopts first", () => {
    const st = store(rec({ keptApart: ["old.md"] }));
    const a = tab(st);
    st.write(rec({ keptApart: ["old.md", "other.md"] }));
    expect(a.render(true, [["old.md", "new.md"]]).write).toBe(false);
    expect(a.shown().keptApart).toEqual(["old.md", "other.md"]);
    // The next render re-anchors on the adopted record, leaving the other entry.
    a.render(true, [["old.md", "new.md"]]);
    expect(workGroupPrefsOf(st.stored()).keptApart).toEqual(["other.md", "new.md"]);
  });

  test("A3 two anchors that land on one thread collapse to one entry on the next write", () => {
    const st = store(rec({ keptApart: ["a.md", "b.md"] }));
    const a = tab(st);
    a.render(true, [["a.md", "c.md"], ["b.md", "c.md"]]);
    expect(st.stored()).toEqual(rec({ keptApart: ["c.md"] }));
    // One anchor already on the newest page: the other moves onto it.
    const st2 = store(rec({ keptApart: ["c.md", "b.md"] }));
    tab(st2).render(true, [["b.md", "c.md"]]);
    expect(st2.stored()).toEqual(rec({ keptApart: ["c.md"] }));
  });

  test("a re-anchor on an unreadable store or under a later build's record writes nothing", () => {
    const st = store(rec({ keptApart: ["old.md"] }));
    const a = tab(st);
    st.s.readable = false;
    expect(a.render(true, [["old.md", "new.md"]]).write).toBe(false);
    const st2 = store();
    st2.s.v = JSON.stringify({ version: 2, keptApart: ["old.md"] });
    expect(tab(st2).render(true, [["old.md", "new.md"]]).write).toBe(false);
  });
});

describe("list ops read the lists as the parser does (fix round 1, batch 3)", () => {
  const hundred = Array.from({ length: 100 }, (_, i) => ({ id: `s${String(i).padStart(3, "0")}`, page: `p/${i}.md` }));
  const fifty = Array.from({ length: 50 }, (_, i) => `k/${i}.md`);

  test("F1 an add past the bound is refused at write: the record stays at 100 splits and 50 anchors", () => {
    const st = store(rec({ splits: hundred, keptApart: fifty }));
    const a = tab(st);
    a.click({ split: { id: "snew", page: "q/new.md" } });
    a.click({ keepApart: "z/new.md" });
    const raw = JSON.parse(st.s.v!) as { splits: unknown[]; keptApart: unknown[] };
    expect(raw.splits).toHaveLength(100);
    expect(raw.keptApart).toHaveLength(50);
    // Returning one of the first 100 never wakes a hidden 101st.
    a.click({ unsplit: { id: "s000", page: "p/0.md" } });
    a.click({ allowGrouping: ["k/0.md"] });
    expect(workGroupPrefsOf(st.stored()).splits.some((s) => s.page === "q/new.md")).toBe(false);
    expect(workGroupPrefsOf(st.stored()).keptApart).not.toContain("z/new.md");
    // Below the bound the add goes through.
    a.click({ split: { id: "snew", page: "q/new.md" } });
    a.click({ keepApart: "z/new.md" });
    expect(workGroupPrefsOf(st.stored()).splits.some((s) => s.page === "q/new.md")).toBe(true);
    expect(workGroupPrefsOf(st.stored()).keptApart).toContain("z/new.md");
  });

  test("F1 a tab whose menu offered the add before another tab filled the list learns the bound refused it", () => {
    const st = store(rec({ splits: hundred.slice(0, 99), keptApart: fifty.slice(0, 49) }));
    const a = tab(st);
    const b = tab(st);
    a.click({ split: { id: "sa", page: "a/new.md" } });
    a.click({ keepApart: "a/kept.md" });
    // B never heard: its click reads the full lists and the add is refused.
    const add = { split: { id: "sb", page: "b/new.md" } };
    b.click(add);
    expect(workGroupAddRefused(b.state().held, add)).toBe("splits");
    b.click({ keepApart: "b/kept.md" });
    expect(workGroupAddRefused(b.state().held, { keepApart: "b/kept.md" })).toBe("keptApart");
    expect(JSON.parse(st.s.v!).splits).toHaveLength(100);
    // An add that landed, an add of a page already held, and any other edit are not refusals.
    expect(workGroupAddRefused(a.state().held, { split: { id: "sa", page: "a/new.md" } })).toBeNull();
    expect(workGroupAddRefused(b.state().held, { split: { id: "zz", page: "A/New.md" } })).toBeNull();
    expect(workGroupAddRefused(b.state().held, { unsplit: { id: "s000", page: "p/0.md" } })).toBeNull();
    expect(workGroupAddRefused(rec({ splits: hundred.slice(0, 99) }), add)).toBeNull();
    expect(workGroupAddRefused(rec({ keptApart: fifty.slice(0, 49) }), { keepApart: "b/kept.md" })).toBeNull();
  });

  test("F1 the bound counts the entries the parser reads, not unreadable ones", () => {
    const base = rec({ splits: [...hundred.slice(0, 99), { id: "BAD ID!", page: "b.md" }], keptApart: [...fifty.slice(0, 49), 7] });
    expect(workGroupPrefsOf(applyWorkGroupEdit(base, { split: { id: "snew", page: "q/new.md" } })).splits).toHaveLength(100);
    expect(workGroupPrefsOf(applyWorkGroupEdit(base, { keepApart: "z/new.md" })).keptApart).toHaveLength(50);
  });

  test("F2 a stored page with surrounding whitespace matches its canonical spelling in every op", () => {
    const base = rec({ keptApart: [" a.md"], splits: [{ id: "sx", page: " x.md" }] });
    expect(workGroupPrefsOf(base).keptApart).toEqual(["a.md"]);
    expect(workGroupPrefsOf(applyWorkGroupEdit(base, { allowGrouping: ["a.md"] })).keptApart).toEqual([]);
    expect(workGroupPrefsOf(applyWorkGroupEdit(base, { reanchor: [["a.md", "c.md"]] })).keptApart).toEqual(["c.md"]);
    expect(applyWorkGroupEdit(base, { split: { id: "sy", page: "x.md" } }).splits).toEqual(base.splits);
    expect(applyWorkGroupEdit(base, { keepApart: "a.md" }).keptApart).toEqual(base.keptApart);
    expect(workGroupPrefsOf(applyWorkGroupEdit(base, { unsplit: { id: "zz", page: "x.md" } })).splits).toEqual([]);
  });

  test("F2 two tabs: the re-anchor moves a whitespace-spelled anchor once, then stays put", () => {
    const st = store();
    st.s.v = JSON.stringify({ version: 1, keptApart: [" a.md"] });
    const a = tab(st);
    a.render(true, [["a.md", "c.md"]]);
    expect(workGroupPrefsOf(st.stored()).keptApart).toEqual(["c.md"]);
    const writes = st.s.writes;
    a.render(true, []);
    expect(st.s.writes).toBe(writes);
  });

  test("F3 an unreadable split on the page never blocks Make own thread; the add appends a readable one", () => {
    const st = store();
    st.s.v = JSON.stringify({ version: 1, splits: [{ id: "BAD ID!", page: "x.md" }] });
    const a = tab(st);
    a.click({ split: { id: "sgood", page: "x.md" } });
    expect(workGroupPrefsOf(st.stored()).splits).toEqual([{ id: "sgood", page: "x.md" }]);
    expect((st.stored()!.splits as unknown[])[0]).toEqual({ id: "BAD ID!", page: "x.md" });
  });

  test("F3 Return never deletes an entry this build cannot read", () => {
    const st = store();
    const bad = { id: "BAD ID!", page: "x.md", future: true };
    st.s.v = JSON.stringify({ version: 1, splits: [{ id: "sx", page: "x.md" }, bad] });
    tab(st).click({ unsplit: { id: "sx", page: "x.md" } });
    expect(st.stored()!.splits).toEqual([bad]);
    expect(workGroupPrefsOf(st.stored()).splits).toEqual([]);
    // Allow grouping likewise keeps an anchor it cannot read.
    expect(applyWorkGroupEdit(rec({ keptApart: ["a.md", "../a.md", 7] }), { allowGrouping: ["a.md"] }).keptApart).toEqual(["../a.md", 7]);
  });
});

describe("Reset and adoption keep what another tab or build holds (fix round 1, batch 4)", () => {
  test("B4-1 Reset removes only what this build reads: unknown evidence keys and unreadable list entries stay verbatim", () => {
    const unread = [{ weird: true }, { id: "BAD ID!", page: "x.md" }];
    const base = rec({ stop: "areas", evidence: { series: false, issue: true, future: 1 }, splits: [SX, ...unread], keptApart: ["a.md", 7, "../a.md"], extra: "kept" });
    const out = applyWorkGroupEdit(base, { reset: true });
    expect(out).toEqual(rec({ evidence: { future: 1 }, splits: unread, keptApart: [7, "../a.md"], extra: "kept" }));
    expect(workGroupPrefsOf(out)).toEqual(workGroupPrefsOf(null));
    // Nothing unknown: the bare version, no empty field left behind.
    expect(applyWorkGroupEdit(rec({ stop: "areas", evidence: { series: false }, splits: [SX], keptApart: ["a.md"] }), { reset: true })).toEqual(rec({}));
  });

  test("B4-1 the Reset a click writes keeps them too", () => {
    const st = store();
    st.s.v = JSON.stringify({ version: 1, stop: "areas", evidence: { related: false, future: 1 }, splits: [SX, { weird: true }], keptApart: ["a.md", 7] });
    tab(st).click({ reset: true });
    expect(JSON.parse(st.s.v!)).toEqual({ version: 1, evidence: { future: 1 }, splits: [{ weird: true }], keptApart: [7] });
  });

  test("B4-2 T4 two tabs, event heard: a refused split survives the other tab's write and lands on its list at the next focused render", () => {
    const st = store();
    const a = tab(st);
    const b = tab(st);
    st.s.writable = false;
    a.click({ split: SX });
    st.s.writable = true;
    b.click({ split: SY });
    a.event();
    expect(a.shown().splits).toEqual([SY, SX]);
    expect(a.state().failed).toBe(true);
    a.render(true);
    expect(workGroupPrefsOf(st.stored()).splits).toEqual([SY, SX]);
    expect(a.state().failed).toBe(false);
    b.event();
    expect(b.shown().splits).toEqual([SY, SX]);
  });

  test("B4-2 T4 two tabs, event missed: R3 adopts the other tab's record with the refused split on top, and the next focused render writes it", () => {
    const st = store();
    const a = tab(st);
    const b = tab(st);
    st.s.writable = false;
    a.click({ split: SX });
    st.s.writable = true;
    b.click({ split: SY });
    expect(a.render(true).write).toBe(false);
    expect(a.shown().splits).toEqual([SY, SX]);
    a.render(true);
    expect(workGroupPrefsOf(st.stored()).splits).toEqual([SY, SX]);
  });

  test("B4-2 a click after another tab's write keeps this tab's pending list ops", () => {
    const st = store();
    const a = tab(st);
    const b = tab(st);
    st.s.writable = false;
    a.click({ split: SX });
    st.s.writable = true;
    b.click({ split: SY });
    a.click({ keepApart: "k.md" });
    expect(workGroupPrefsOf(st.stored()).splits).toEqual([SY, SX]);
    expect(workGroupPrefsOf(st.stored()).keptApart).toEqual(["k.md"]);
  });

  test("B4-2 adoption still drops this tab's scalar fields: another tab's write is the newer choice", () => {
    const st = store();
    const a = tab(st);
    const b = tab(st);
    st.s.writable = false;
    a.click({ stop: "areas" });
    a.click({ split: SX });
    st.s.writable = true;
    b.click({ stop: "threads" });
    a.event();
    expect(a.shown().stop).toBe("threads");
    expect(a.shown().splits).toEqual([SX]);
    a.render(true);
    expect(st.stored()).toEqual(rec({ stop: "threads", splits: [SX] }));
    // A scalar-only patch goes whole: nothing is this tab's only.
    const st2 = store();
    const c = tab(st2);
    const d = tab(st2);
    st2.s.writable = false;
    c.click({ stop: "areas" });
    st2.s.writable = true;
    d.click({ split: SY });
    c.event();
    expect(c.state().patch).toBeNull();
    expect(c.state().failed).toBe(false);
  });

  test("B4-2 a pending re-anchor survives adoption only while the anchor it moves is still stored", () => {
    const st = store(rec({ keptApart: ["a.md"] }));
    const a = tab(st);
    const b = tab(st);
    a.render(false, [["a.md", "c.md"]]);
    b.render(true, [["a.md", "d.md"]]);
    a.event();
    expect(a.shown().keptApart).toEqual(["d.md"]);
    expect(a.state().patch).toBeNull();
    const writes = st.s.writes;
    a.render(true);
    expect(st.s.writes).toBe(writes);
  });

  test("B4-2 a pending Return kept across adoption never takes a split another tab made on the page since", () => {
    const st = store(rec({ splits: [SX] }));
    const a = tab(st);
    const b = tab(st);
    st.s.writable = false;
    a.click({ unsplit: SX });
    st.s.writable = true;
    b.click({ unsplit: SX });
    const again = { id: "sx2", page: SX.page };
    b.click({ split: again });
    a.event();
    a.render(true);
    expect(workGroupPrefsOf(st.stored()).splits).toEqual([again]);
    expect(a.shown().splits).toEqual([again]);
  });

  test("B4-2 P6 (round 2 batch 3) Allow grouping in a stale tab removes only the anchor it saw: one another tab moved since stays", () => {
    const st = store(rec({ keptApart: ["a.md", "b.md"] }));
    const a = tab(st);
    const b = tab(st);
    // B's listing grew: c.md is now the thread's newest focus page.
    b.render(true, [["a.md", "c.md"]]);
    a.click({ allowGrouping: ["a.md"] });
    // A never saw c.md: the thread stays kept apart, and A now shows it so.
    expect(workGroupPrefsOf(st.stored()).keptApart).toEqual(["b.md", "c.md"]);
    expect(a.shown().keptApart).toEqual(["b.md", "c.md"]);
    expect(a.state().patch).toBeNull();
    // A's older listing moves nothing back.
    expect(a.render(true, []).write).toBe(false);
  });

  test("B4-3 Reset in a stale tab clears only what that tab's view held: another tab's newer entries survive", () => {
    const st = store(rec({ stop: "areas", splits: [SY], keptApart: ["b.md"] }));
    const a = tab(st);
    const b = tab(st);
    a.click({ split: SX });
    a.click({ keepApart: "k.md" });
    // B never heard of SX or k.md.
    b.click({ reset: true });
    expect(st.stored()).toEqual(rec({ splits: [SX], keptApart: ["k.md"] }));
    expect(b.shown().splits).toEqual([SX]);
    // A current tab's Reset restores D1.
    a.event();
    a.click({ reset: true });
    expect(st.stored()).toEqual(rec({}));
  });

  test("B4-3 (round 2 batch 3) a stale Reset leaves an anchor another tab moved since its last read", () => {
    const st = store(rec({ keptApart: ["a.md"] }));
    const a = tab(st);
    const b = tab(st);
    b.render(true, [["a.md", "c.md"]]);
    a.click({ reset: true });
    expect(st.stored()).toEqual(rec({ keptApart: ["c.md"] }));
  });

  test("B4-3 a pending Reset keeps its list part across adoption and drops its scalar part", () => {
    const st = store(rec({ stop: "areas", splits: [SY] }));
    const a = tab(st);
    const b = tab(st);
    st.s.writable = false;
    a.click({ reset: true });
    st.s.writable = true;
    b.click({ stop: "threads" });
    b.click({ split: SX });
    a.event();
    expect(a.shown().stop).toBe("threads");
    expect(a.shown().splits).toEqual([SX]);
    a.render(true);
    expect(st.stored()).toEqual(rec({ stop: "threads", splits: [SX] }));
  });
});

describe("adoption drops a pending op the other tab's record already holds (fix round 1, batch 4)", () => {
  test("a refused split the other tab also made is dropped on adoption, so that tab's later Reset stands", () => {
    const st = store();
    const a = tab(st);
    const b = tab(st);
    st.s.writable = false;
    a.click({ split: SX });
    st.s.writable = true;
    b.click({ split: { id: "sx-b", page: SX.page } });
    a.event();
    expect(a.state().patch).toBeNull();
    expect(a.state().failed).toBe(false);
    b.click({ reset: true });
    a.event();
    a.render(true);
    expect(st.stored()).toEqual(rec({}));
  });
});

describe("split removals resolve to ids at the click (fix round 1, batch 4)", () => {
  test("a stale Return takes the split another tab made on the page before the click", () => {
    const st = store(rec({ splits: [SX] }));
    const a = tab(st);
    const b = tab(st);
    b.click({ unsplit: SX });
    b.click({ split: { id: "sx2", page: SX.page } });
    // A still shows SX's id: its Return is for the page it saw split.
    a.click({ unsplit: SX });
    expect(workGroupPrefsOf(st.stored()).splits).toEqual([]);
  });

  test("a stale Reset takes the split another tab made on a page it showed split", () => {
    const st = store(rec({ splits: [SX] }));
    const a = tab(st);
    const b = tab(st);
    b.click({ unsplit: SX });
    b.click({ split: { id: "sx2", page: SX.page } });
    b.click({ split: SY });
    a.click({ reset: true });
    // SY's page A never showed split: it stays.
    expect(st.stored()).toEqual(rec({ splits: [SY] }));
  });

  test("a pending op the adopted record already holds is dropped while the others stay", () => {
    const st = store();
    const a = tab(st);
    const b = tab(st);
    st.s.writable = false;
    a.click({ split: SX });
    a.click({ keepApart: "k.md" });
    st.s.writable = true;
    b.click({ split: { id: "sx-b", page: SX.page } });
    a.event();
    b.click({ reset: true });
    a.event();
    a.render(true);
    expect(st.stored()).toEqual(rec({ keptApart: ["k.md"] }));
  });
});

describe("fix round 2, batch 3: a removal takes only what the tab saw, and a no-op is no op", () => {
  const S1 = { id: "s1", page: "p1.md" };

  test("R2B3-1 a stale tab's Allow grouping removes the anchor it saw; another tab's newer anchor on the thread's page survives", () => {
    const st = store(rec({ keptApart: ["p2.md"] }));
    const a = tab(st);
    const b = tab(st);
    // B makes p1 its own thread and keeps that piece separate; A never hears.
    b.click({ split: S1 });
    b.click({ keepApart: "p1.md" });
    // A draws T = {p1, p2} kept apart by p2: the anchors its view held.
    a.click({ allowGrouping: ["p2.md"] });
    expect(st.stored()).toEqual(rec({ splits: [S1], keptApart: ["p1.md"] }));
  });

  test("R2B3-1 a stale tab's Reset leaves the anchor another tab added since its last read", () => {
    const st = store(rec({ keptApart: ["p2.md"] }));
    const a = tab(st);
    const b = tab(st);
    b.click({ split: S1 });
    b.click({ keepApart: "p1.md" });
    a.click({ reset: true });
    expect(st.stored()).toEqual(rec({ splits: [S1], keptApart: ["p1.md"] }));
  });

  test("R2B3-2 H1: a refused Return of a split another tab's Reset removed is dropped on the event: no «this tab only», no empty list written", () => {
    const st = store(rec({ splits: [SX] }));
    const a = tab(st);
    const b = tab(st);
    st.s.writable = false;
    a.click({ unsplit: SX });
    expect(a.state().failed).toBe(true);
    st.s.writable = true;
    b.click({ reset: true });
    expect(st.s.v).toBe('{"version":1}');
    a.event();
    expect(a.state().patch).toBeNull();
    expect(a.state().failed).toBe(false);
    const writes = st.s.writes;
    a.render(true);
    expect(st.s.writes).toBe(writes);
    expect(st.s.v).toBe('{"version":1}');
  });

  test("R2B3-2 H2: a pending unfocused re-anchor after another tab's Reset is dropped, and no empty list is written", () => {
    const st = store(rec({ keptApart: ["a.md"] }));
    const a = tab(st);
    const b = tab(st);
    a.render(false, [["a.md", "c.md"]]);
    b.click({ reset: true });
    a.event();
    expect(a.state().patch).toBeNull();
    a.render(true);
    expect(st.s.v).toBe('{"version":1}');
  });

  test("R2B3-2 a refused add then Return, adopted onto another tab's record, leaves nothing this tab's only (pins the adoption same-check)", () => {
    const st = store();
    const a = tab(st);
    const b = tab(st);
    st.s.writable = false;
    a.click({ split: SX });
    a.click({ unsplit: SX });
    st.s.writable = true;
    b.click({ stop: "threads" });
    a.event();
    expect(a.state().patch).toBeNull();
    expect(a.state().failed).toBe(false);
    a.render(true);
    expect(st.stored()).toEqual(rec({ stop: "threads" }));
  });

  test("R2B3-2 a removal or move that finds nothing changes nothing; one that empties a list drops the field", () => {
    expect(applyWorkGroupEdit(rec({}), { unsplit: SX })).toEqual(rec({}));
    expect(applyWorkGroupEdit(rec({}), { allowGrouping: ["a.md"] })).toEqual(rec({}));
    expect(applyWorkGroupEdit(rec({}), { reanchor: [["a.md", "c.md"]] })).toEqual(rec({}));
    // A value this build cannot read as a list is never replaced by a removal.
    expect(applyWorkGroupEdit(rec({ splits: "junk", keptApart: "junk" }), { unsplit: SX })).toEqual(rec({ splits: "junk", keptApart: "junk" }));
    expect(applyWorkGroupEdit(rec({ keptApart: "junk" }), { reanchor: [["a.md", "c.md"]] })).toEqual(rec({ keptApart: "junk" }));
    expect(applyWorkGroupEdit(rec({ splits: [SX], keptApart: ["a.md"] }), { unsplit: SX })).toEqual(rec({ keptApart: ["a.md"] }));
    expect(applyWorkGroupEdit(rec({ splits: [SX], keptApart: ["a.md"] }), { allowGrouping: ["a.md"] })).toEqual(rec({ splits: [SX] }));
  });

  test("R2B3-3 Forget removes one split by its id, never another definition on the same page", () => {
    const dup = { id: "sx2", page: SX.page };
    const st = store(rec({ splits: [SX, dup, SY] }));
    tab(st).click({ forgetSplit: "sx2" });
    expect(st.stored()).toEqual(rec({ splits: [SX, SY] }));
    // A stale tab's Forget of one entry leaves another tab's newer entries alone.
    const st2 = store(rec({ splits: [SX] }));
    const a = tab(st2);
    const b = tab(st2);
    b.click({ split: SY });
    a.click({ forgetSplit: SX.id });
    expect(st2.stored()).toEqual(rec({ splits: [SY] }));
  });
});

describe("fix round 2, batch 3: pins for the record's surviving mutants", () => {
  test("an op's page is canonical: a spelled path matches the stored entry and is stored canonical (opPage)", () => {
    expect(workGroupPrefsOf(applyWorkGroupEdit(rec({ keptApart: ["a.md", "b.md"] }), { allowGrouping: [" a.md "] })).keptApart).toEqual(["b.md"]);
    expect(applyWorkGroupEdit(rec({}), { split: { id: "sx", page: " x.md " } }).splits).toEqual([{ id: "sx", page: "x.md" }]);
    expect(applyWorkGroupEdit(rec({}), { keepApart: " k.md " }).keptApart).toEqual(["k.md"]);
    expect(workGroupPrefsOf(applyWorkGroupEdit(rec({ splits: [SX, SY] }), { unsplit: { id: "zz", page: " plans/x.md " } })).splits).toEqual([SY]);
  });

  test("Keep separate at the bound is no refusal when the page is already held", () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `k/${i}.md`);
    expect(workGroupAddRefused(rec({ keptApart: fifty }), { keepApart: "k/3.md" })).toBeNull();
    expect(workGroupAddRefused(rec({ keptApart: fifty }), { keepApart: "k/new.md" })).toBe("keptApart");
  });

  test("the bound counts entries in force: duplicates of a page are counted once", () => {
    const splits = [...Array.from({ length: 99 }, (_, i) => ({ id: `s${i}`, page: `p/${i}.md` })), { id: "sdup", page: "p/0.md" }];
    expect(workGroupPrefsOf(applyWorkGroupEdit(rec({ splits }), { split: { id: "snew", page: "q/new.md" } })).splits).toHaveLength(100);
    const keptApart = [...Array.from({ length: 49 }, (_, i) => `k/${i}.md`), "k/0.md"];
    expect(workGroupPrefsOf(applyWorkGroupEdit(rec({ keptApart }), { keepApart: "z/new.md" })).keptApart).toHaveLength(50);
  });

  test("a move to or from a path no entry can hold is skipped", () => {
    expect(applyWorkGroupEdit(rec({ keptApart: ["a.md"] }), { reanchor: [["a.md", "../c.md"]] })).toEqual(rec({ keptApart: ["a.md"] }));
    expect(applyWorkGroupEdit(rec({ keptApart: ["a.md"] }), { reanchor: [["", "c.md"]] })).toEqual(rec({ keptApart: ["a.md"] }));
  });

  test("a Reset keeps a Return still pending before it", () => {
    const st = store(rec({ stop: "areas", splits: [SX] }));
    const a = tab(st);
    st.s.writable = false;
    a.click({ unsplit: SX });
    a.click({ reset: true });
    st.s.writable = true;
    a.render(true);
    expect(st.stored()).toEqual(rec({}));
  });

  test("Reset drops an evidence value that is not an object", () => {
    expect(applyWorkGroupEdit(rec({ evidence: "junk", stop: "areas" }), { reset: true })).toEqual(rec({}));
  });
});
