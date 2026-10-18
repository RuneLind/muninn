/**
 * The grouping record's storage form and its state table (D17,
 * `wiki-work-group-record.ts`): one case per row of the table in
 * `src/wiki/CLAUDE.md`, the sparse reader, the canonical compare, and a
 * many-tab simulation that proves no write loop.
 */

import { describe, expect, test } from "bun:test";
import {
  applyWorkGroupEdit,
  canonicalWorkGroupRecord,
  readWorkGroupRecord,
  sameWorkGroupRecord,
  serializeWorkGroupRecord,
  storageEventTouchesWorkGroup,
  workGroupKey,
  workGroupPrefsOf,
  workGroupRecordSettle,
  workGroupRecordStep,
  type WorkGroupRecord,
  type WorkGroupRecordState,
} from "./wiki-work-group-record.ts";

const rec = (r: Omit<WorkGroupRecord, "version">): WorkGroupRecord => ({ version: 1, ...r });
const AREAS = rec({ stop: "areas" });
const NO_SERIES = rec({ evidence: { series: false } });
const THREADS = rec({ stop: "threads" });
const fresh: WorkGroupRecordState = { held: null, known: null, patch: null, failed: false };

describe("readWorkGroupRecord: the sparse record, held verbatim", () => {
  test("none for absent, unparseable, non-object and versionless values; another version is held but reads as D1", () => {
    expect(readWorkGroupRecord(null)).toBeNull();
    expect(readWorkGroupRecord(undefined)).toBeNull();
    expect(readWorkGroupRecord("{")).toBeNull();
    expect(readWorkGroupRecord("[]")).toBeNull();
    expect(readWorkGroupRecord('"related"')).toBeNull();
    const v2 = readWorkGroupRecord(JSON.stringify({ version: 2, stop: "areas" }));
    expect(v2).toEqual({ version: 2, stop: "areas" });
    expect(workGroupPrefsOf(v2)).toEqual(workGroupPrefsOf(null));
  });

  test("an invalid field is held but reads as its default; a saved false stays false", () => {
    const r = readWorkGroupRecord(JSON.stringify({ version: 1, stop: "sideways", evidence: { series: false, related: "yes" } }));
    expect(r).toEqual({ version: 1, stop: "sideways", evidence: { series: false, related: "yes" } });
    // D1 fills the rest at read time and is never stored.
    expect(workGroupPrefsOf(r)).toEqual({
      stop: "related",
      evidence: { series: false, related: true, issue: true },
      splits: [],
      keptApart: [],
    });
  });

  test("reads a later build's split and anchor lists through the parser's bounds, and holds them whole", () => {
    const stored = { version: 1, splits: [{ id: "s1", page: "Plans/A.md" }, { id: "bad id", page: "x.md" }], keptApart: ["b.md", "b.md"], extra: 1 };
    const r = readWorkGroupRecord(JSON.stringify(stored));
    expect(r).toEqual(stored);
    expect(workGroupPrefsOf(r)).toMatchObject({ splits: [{ id: "s1", page: "plans/a.md" }], keptApart: ["b.md"] });
  });

  test("no record ⇒ D1: Related with every box checked", () => {
    expect(workGroupPrefsOf(null).stop).toBe("related");
    expect(workGroupPrefsOf(null).evidence).toEqual({ series: true, related: true, issue: true });
  });

  test("a record written by this build reads back as itself (a reload keeps an unchecked box)", () => {
    const r = applyWorkGroupEdit(applyWorkGroupEdit(null, { stop: "areas" }), { evidence: "issue", value: false });
    expect(readWorkGroupRecord(serializeWorkGroupRecord(r))).toEqual(r);
    expect(workGroupPrefsOf(readWorkGroupRecord(serializeWorkGroupRecord(r))).evidence.issue).toBe(false);
  });
});

describe("canonical compare", () => {
  test("key order and array order do not make two records differ", () => {
    const a = { version: 1, stop: "areas", evidence: { series: false, issue: true }, keptApart: ["b.md", "a.md"] } as WorkGroupRecord;
    const b = { keptApart: ["a.md", "b.md"], evidence: { issue: true, series: false }, stop: "areas", version: 1 } as WorkGroupRecord;
    expect(canonicalWorkGroupRecord(a)).toBe(canonicalWorkGroupRecord(b));
    expect(sameWorkGroupRecord(a, b)).toBe(true);
  });

  test("none, unreadable and a record are three different values", () => {
    expect(sameWorkGroupRecord(null, undefined)).toBe(false);
    expect(sameWorkGroupRecord(null, rec({}))).toBe(false);
    expect(sameWorkGroupRecord(undefined, undefined)).toBe(true);
  });
});

describe("applyWorkGroupEdit", () => {
  test("merges one edit onto the base and keeps every other field", () => {
    const base = rec({ stop: "areas", evidence: { series: false }, keptApart: ["x.md"] });
    expect(applyWorkGroupEdit(base, { evidence: "issue", value: false })).toEqual(
      rec({ stop: "areas", evidence: { series: false, issue: false }, keptApart: ["x.md"] }),
    );
    expect(applyWorkGroupEdit(base, { stop: "threads" })).toEqual(rec({ stop: "threads", evidence: { series: false }, keptApart: ["x.md"] }));
  });

  test("the first edit creates a record holding only that edit", () => {
    expect(applyWorkGroupEdit(null, { evidence: "series", value: false })).toEqual(NO_SERIES);
  });
});

describe("the record's state table (D17)", () => {
  test("B1: boot, storage readable — held and known are what storage holds", () => {
    expect(workGroupRecordStep(fresh, { kind: "boot", stored: AREAS })).toEqual({
      state: { held: AREAS, known: AREAS, patch: null, failed: false },
      write: false,
      repaint: false,
    });
  });

  test("B2: boot, storage unreadable — no record, known unknown", () => {
    expect(workGroupRecordStep(fresh, { kind: "boot", stored: undefined }).state).toEqual({ held: null, known: undefined, patch: null, failed: false });
  });

  test("E1–E4: a storage event adopts without writing; repaints only once rendered and on a change", () => {
    const s = { held: null, known: null, patch: null, failed: false };
    expect(workGroupRecordStep(s, { kind: "storage", stored: AREAS, booted: true })).toEqual({
      state: { held: AREAS, known: AREAS, patch: null, failed: false },
      write: false,
      repaint: true,
    });
    expect(workGroupRecordStep(s, { kind: "storage", stored: AREAS, booted: false }).repaint).toBe(false);
    // The same record in another spelling is no change.
    const same = { held: AREAS, known: AREAS, patch: null, failed: false };
    expect(workGroupRecordStep(same, { kind: "storage", stored: { stop: "areas", version: 1 }, booted: true }).repaint).toBe(false);
    // A clear() in another tab: back to D1.
    expect(workGroupRecordStep(same, { kind: "storage", stored: null, booted: true })).toEqual({
      state: { held: null, known: null, patch: null, failed: false },
      write: false,
      repaint: true,
    });
  });

  test("E5: a storage event while storage is unreadable changes nothing", () => {
    const s = { held: AREAS, known: AREAS, patch: null, failed: false };
    expect(workGroupRecordStep(s, { kind: "storage", stored: undefined, booted: true })).toEqual({ state: s, write: false, repaint: false });
  });

  test("C1: a click merges the edit onto the record as read NOW and writes it; known is that read", () => {
    // This tab holds Threads; another tab has since written an unchecked series box.
    const s = { held: THREADS, known: THREADS, patch: null, failed: false };
    const r = workGroupRecordStep(s, { kind: "click", stored: NO_SERIES, edit: { stop: "areas" } });
    expect(r.write).toEqual({ value: rec({ stop: "areas", evidence: { series: false } }) });
    expect(r.state).toEqual({ held: rec({ stop: "areas", evidence: { series: false } }), known: NO_SERIES, patch: AREAS, failed: false });
    expect(workGroupRecordSettle(r.state, r.write ? r.write.value : AREAS, true)).toEqual({
      held: rec({ stop: "areas", evidence: { series: false } }),
      known: rec({ stop: "areas", evidence: { series: false } }),
      patch: null,
      failed: false,
    });
  });

  test("C2: a refused write keeps the held record and marks it this tab only", () => {
    const r = workGroupRecordStep(fresh, { kind: "click", stored: null, edit: { stop: "areas" } });
    const after = workGroupRecordSettle(r.state, AREAS, false);
    expect(after).toEqual({ held: AREAS, known: null, patch: AREAS, failed: true });
  });

  test("C3: a click while storage is unreadable merges onto this tab's own record", () => {
    const s = { held: NO_SERIES, known: undefined, patch: NO_SERIES, failed: false };
    const r = workGroupRecordStep(s, { kind: "click", stored: undefined, edit: { stop: "areas" } });
    expect(r.state.held).toEqual(rec({ stop: "areas", evidence: { series: false } }));
    expect(r.state.known).toBeUndefined();
    expect(r.write).not.toBe(false);
  });

  test("R1: a render with storage unreadable writes nothing and keeps the held record", () => {
    const s = { held: AREAS, known: undefined, patch: AREAS, failed: true };
    expect(workGroupRecordStep(s, { kind: "render", stored: undefined, focused: true })).toEqual({ state: s, write: false, repaint: false });
  });

  test("R2: storage readable for the first time — known is what it holds; this tab's own record stays", () => {
    expect(
      workGroupRecordStep({ held: AREAS, known: undefined, patch: AREAS, failed: true }, { kind: "render", stored: null, focused: true }).state,
    ).toEqual({
      held: AREAS,
      known: null,
      patch: AREAS,
      failed: true,
    });
    expect(
      workGroupRecordStep({ held: null, known: undefined, patch: null, failed: false }, { kind: "render", stored: NO_SERIES, focused: true }).state,
    ).toEqual({
      held: NO_SERIES,
      known: NO_SERIES,
      patch: null,
      failed: false,
    });
  });

  test("R2 then R6: a choice made while storage was unreadable is written on the next focused render", () => {
    let s: WorkGroupRecordState = { held: AREAS, known: undefined, patch: AREAS, failed: true };
    s = workGroupRecordStep(s, { kind: "render", stored: null, focused: true }).state;
    const r = workGroupRecordStep(s, { kind: "render", stored: null, focused: true });
    expect(r.write).toEqual({ value: AREAS });
  });

  test("R3: stored ≠ known — another tab wrote and this tab missed it: adopted, never overwritten", () => {
    const s = { held: AREAS, known: AREAS, patch: null, failed: false };
    expect(workGroupRecordStep(s, { kind: "render", stored: THREADS, focused: true })).toEqual({
      state: { held: THREADS, known: THREADS, patch: null, failed: false },
      write: false,
      repaint: false,
    });
  });

  test("R3 drops a change that only lived in memory after a refused write (accepted: the other tab's write is newer)", () => {
    const s = { held: AREAS, known: null, patch: AREAS, failed: true };
    expect(workGroupRecordStep(s, { kind: "render", stored: THREADS, focused: true }).state).toEqual({
      held: THREADS,
      known: THREADS,
      patch: null,
      failed: false,
    });
  });

  test("R4: stored = known, no focus — nothing is written", () => {
    const s = { held: AREAS, known: null, patch: AREAS, failed: true };
    expect(workGroupRecordStep(s, { kind: "render", stored: null, focused: false })).toEqual({ state: s, write: false, repaint: false });
  });

  test("R5: stored = known = held — nothing to write", () => {
    const s = { held: AREAS, known: AREAS, patch: null, failed: false };
    expect(workGroupRecordStep(s, { kind: "render", stored: AREAS, focused: true }).write).toBe(false);
    // No record anywhere: D1 is never written.
    expect(workGroupRecordStep(fresh, { kind: "render", stored: null, focused: true }).write).toBe(false);
  });

  test("R6: stored = known, focus, held differs — a refused write is retried; success clears the note", () => {
    const s = { held: AREAS, known: null, patch: AREAS, failed: true };
    const r = workGroupRecordStep(s, { kind: "render", stored: null, focused: true });
    expect(r.write).toEqual({ value: AREAS });
    expect(workGroupRecordSettle(r.state, AREAS, true)).toEqual({ held: AREAS, known: AREAS, patch: null, failed: false });
    expect(workGroupRecordSettle(r.state, AREAS, false)).toEqual({ held: AREAS, known: null, patch: AREAS, failed: true });
  });

  test("a storage event concerns this wiki's key or a clear(), nothing else", () => {
    expect(storageEventTouchesWorkGroup(null, "w")).toBe(true);
    expect(storageEventTouchesWorkGroup(workGroupKey("w"), "w")).toBe(true);
    expect(storageEventTouchesWorkGroup(workGroupKey("other"), "w")).toBe(false);
    expect(workGroupKey("w")).toBe("muninn.wiki.workGroup.v1:w");
  });
});

describe("many tabs: no write loop, no lost edit", () => {
  /** One storage, N tabs. A write fires a storage event in every OTHER tab,
   *  which runs the storage row and repaints without a render step. */
  function world(n: number) {
    let stored: WorkGroupRecord | null = null;
    let writes = 0;
    const tabs: WorkGroupRecordState[] = [];
    const deliver = (from: number) => {
      tabs.forEach((s, i) => {
        if (i === from) return;
        tabs[i] = workGroupRecordStep(s, { kind: "storage", stored, booted: true }).state;
      });
    };
    const run = (i: number, t: Parameters<typeof workGroupRecordStep>[1]) => {
      const r = workGroupRecordStep(tabs[i]!, t);
      if (r.write) {
        stored = r.write.value;
        writes++;
        tabs[i] = workGroupRecordSettle(r.state, r.write.value, true);
        deliver(i);
      } else tabs[i] = r.state;
    };
    for (let i = 0; i < n; i++) tabs.push(workGroupRecordStep(fresh, { kind: "boot", stored }).state);
    return {
      tabs,
      writes: () => writes,
      stored: () => stored,
      click: (i: number, edit: Parameters<typeof applyWorkGroupEdit>[1]) => run(i, { kind: "click", stored, edit }),
      render: (i: number, focused: boolean) => run(i, { kind: "render", stored, focused }),
    };
  }

  test("two tabs' edits to different fields both survive, and renders write nothing more", () => {
    const w = world(3);
    w.click(0, { stop: "areas" });
    w.click(1, { evidence: "series", value: false });
    expect(w.stored()).toEqual(rec({ stop: "areas", evidence: { series: false } }));
    const before = w.writes();
    for (let round = 0; round < 5; round++) for (let i = 0; i < 3; i++) w.render(i, true);
    expect(w.writes()).toBe(before);
    for (const t of w.tabs) expect(sameWorkGroupRecord(t.held, w.stored())).toBe(true);
  });
});

describe("a tab's unpersisted edits (fix round 1: refused writes, first-readable storage)", () => {
  /** One storage that can refuse reads or writes, shared by tabs that do
   *  their own IO the way the reader does (`stepWorkGroup`). */
  function store(initial: WorkGroupRecord | null = null) {
    const s = { v: initial ? serializeWorkGroupRecord(initial) : (null as string | null), readable: true, writable: true };
    return {
      s,
      read: (): WorkGroupRecord | null | undefined => (s.readable ? readWorkGroupRecord(s.v) : undefined),
      write: (r: WorkGroupRecord): boolean => {
        if (!s.writable) return false;
        s.v = serializeWorkGroupRecord(r);
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
      click: (edit: Parameters<typeof applyWorkGroupEdit>[1]) => run({ kind: "click", stored: st.read(), edit }),
      render: (focused = true) => run({ kind: "render", stored: st.read(), focused }),
      event: () => run({ kind: "storage", stored: st.read(), booted: true }),
    };
  }

  test("C2 then C2: a second refused edit keeps the first (finding 1)", () => {
    const st = store();
    st.s.writable = false;
    const a = tab(st);
    a.click({ evidence: "series", value: false });
    a.render(true);
    a.click({ evidence: "related", value: false });
    a.render(true);
    expect(a.shown().evidence).toEqual({ series: false, related: false, issue: true });
    expect(a.state().failed).toBe(true);
  });

  test("C2 then C1: the written edit carries the earlier refused one (finding 1)", () => {
    const st = store();
    st.s.writable = false;
    const a = tab(st);
    a.click({ evidence: "series", value: false });
    st.s.writable = true;
    a.click({ stop: "areas" });
    expect(st.stored()).toEqual(rec({ stop: "areas", evidence: { series: false } }));
    expect(a.state().failed).toBe(false);
  });

  test("R2 then R6: a choice made while unreadable is merged onto the stored record, not written whole (finding 2)", () => {
    const st = store(NO_SERIES);
    st.s.readable = false;
    st.s.writable = false;
    const a = tab(st);
    a.click({ stop: "areas" });
    st.s.readable = true;
    st.s.writable = true;
    a.render(true);
    // R2 shows the other tab's field at once, with this tab's choice on top.
    expect(a.shown()).toMatchObject({ stop: "areas", evidence: { series: false } });
    a.render(true);
    expect(st.stored()).toEqual(rec({ stop: "areas", evidence: { series: false } }));
    expect(a.state().failed).toBe(false);
  });

  test("C1 after another tab's newer record: the patch goes (R3's rule), the new edit is merged onto that record", () => {
    const st = store();
    st.s.writable = false;
    const a = tab(st);
    a.click({ evidence: "series", value: false });
    // Another tab writes; this tab's event is not delivered before the click.
    st.s.v = serializeWorkGroupRecord(THREADS);
    st.s.writable = true;
    a.click({ evidence: "issue", value: false });
    expect(st.stored()).toEqual(rec({ stop: "threads", evidence: { issue: false } }));
  });

  test("E1–E4: an event that clears «this tab only» repaints even when the record is unchanged (finding 3)", () => {
    const st = store();
    st.s.writable = false;
    const a = tab(st);
    a.click({ stop: "areas" });
    expect(a.state().failed).toBe(true);
    // Another tab writes exactly this tab's record.
    st.s.v = serializeWorkGroupRecord(AREAS);
    const r = a.event();
    expect(r.state.failed).toBe(false);
    expect(r.repaint).toBe(true);
  });
});

describe("a mixed-build pair of tabs: a write keeps what this build does not understand (fix round 1, finding 1)", () => {
  const click = (raw: string, edit: Parameters<typeof applyWorkGroupEdit>[1]) => {
    const stored = readWorkGroupRecord(raw);
    const booted = workGroupRecordStep(fresh, { kind: "boot", stored }).state;
    return workGroupRecordStep(booted, { kind: "click", stored: readWorkGroupRecord(raw), edit });
  };

  test("an evidence click keeps unknown fields, unknown evidence keys and every stored split and anchor verbatim", () => {
    const later = {
      version: 1,
      stop: "sessions",
      evidence: { series: false, project: false },
      splits: [{ id: "a", page: "x/y.md", label: "L" }, { id: "bad id", page: "z.md" }, { id: "a", page: "x/y.md" }],
      keptApart: ["a.md", "A.md"],
      groups: [["a", "b"]],
    };
    const r = click(JSON.stringify(later), { evidence: "issue", value: false });
    expect(r.write).not.toBe(false);
    const written = JSON.parse(serializeWorkGroupRecord((r.write as { value: WorkGroupRecord }).value));
    expect(written).toEqual({ ...later, evidence: { series: false, project: false, issue: false } });
    // This build still reads only what it understands from it.
    expect(workGroupPrefsOf(readWorkGroupRecord(JSON.stringify(written)))).toEqual({
      stop: "sessions",
      evidence: { series: false, related: true, issue: false },
      splits: [{ id: "a", page: "x/y.md" }],
      keptApart: ["a.md"],
    });
  });

  test("a stop click keeps an unknown top-level field", () => {
    const r = click(JSON.stringify({ version: 1, evidence: { related: false }, newThing: { n: 1 } }), { stop: "areas" });
    expect((r.write as { value: WorkGroupRecord }).value).toEqual({ version: 1, stop: "areas", evidence: { related: false }, newThing: { n: 1 } });
  });

  test("the canonical compare sees the preserved fields: a record differing only in one is another record", () => {
    const a = readWorkGroupRecord(JSON.stringify({ version: 1, stop: "areas", groups: [["a", "b"]] }));
    const b = readWorkGroupRecord(JSON.stringify({ groups: [["a", "b"]], stop: "areas", version: 1 }));
    const c = readWorkGroupRecord(JSON.stringify({ version: 1, stop: "areas", groups: [["a", "c"]] }));
    expect(sameWorkGroupRecord(a, b)).toBe(true);
    expect(sameWorkGroupRecord(a, c)).toBe(false);
  });

  test("a record of another version is never written over: the click stays in this tab, D1 plus the edit", () => {
    const v2 = JSON.stringify({ version: 2, stop: "areas", newThing: 1 });
    expect(workGroupPrefsOf(readWorkGroupRecord(v2))).toEqual(workGroupPrefsOf(null));
    const r = click(v2, { evidence: "series", value: false });
    expect(r.write).toBe(false);
    expect(r.state.failed).toBe(true);
    expect(workGroupPrefsOf(r.state.held)).toEqual({ ...workGroupPrefsOf(null), evidence: { series: false, related: true, issue: true } });
    // A focused render later still does not write it (R6 is the retry path).
    const later = workGroupRecordStep(r.state, { kind: "render", stored: readWorkGroupRecord(v2), focused: true });
    expect(later.write).toBe(false);
    expect(workGroupPrefsOf(later.state.held).evidence.series).toBe(false);
    // Another tab's write of this version is adopted, and then clicks write again.
    const adopted = workGroupRecordStep(later.state, { kind: "storage", stored: rec({ stop: "threads" }), booted: true }).state;
    const next = workGroupRecordStep(adopted, { kind: "click", stored: rec({ stop: "threads" }), edit: { stop: "areas" } });
    expect(next.write).toEqual({ value: rec({ stop: "areas" }) });
  });

  test("a versionless object is malformed, not another version: it reads as none and a click replaces it", () => {
    expect(readWorkGroupRecord(JSON.stringify({ stop: "areas" }))).toBeNull();
    expect(click(JSON.stringify({ stop: "areas" }), { stop: "threads" }).write).toEqual({ value: rec({ stop: "threads" }) });
  });
});
