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

  test("Reset clears the four preferences, keeps an unknown field, and supersedes what the patch held before it", () => {
    const base = rec({ stop: "areas", evidence: { series: false, future: 1 }, splits: [SX], keptApart: ["a.md"], extra: "kept" });
    expect(applyWorkGroupEdit(base, { reset: true })).toEqual(rec({ extra: "kept" }));
    let p = patchWorkGroupEdit(null, { split: SY });
    p = patchWorkGroupEdit(p, { reset: true });
    p = patchWorkGroupEdit(p, { evidence: "issue", value: false });
    expect(mergeWorkGroupPatch(base, p)).toEqual(rec({ extra: "kept", evidence: { issue: false } }));
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
