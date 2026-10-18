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
const fresh: WorkGroupRecordState = { held: null, known: null, failed: false };

describe("readWorkGroupRecord: the sparse record", () => {
  test("none for absent, unparseable, non-object and other-version values", () => {
    expect(readWorkGroupRecord(null)).toBeNull();
    expect(readWorkGroupRecord(undefined)).toBeNull();
    expect(readWorkGroupRecord("{")).toBeNull();
    expect(readWorkGroupRecord("[]")).toBeNull();
    expect(readWorkGroupRecord('"related"')).toBeNull();
    expect(readWorkGroupRecord(JSON.stringify({ version: 2, stop: "areas" }))).toBeNull();
  });

  test("keeps only the fields present and valid; a saved false stays false", () => {
    const r = readWorkGroupRecord(JSON.stringify({ version: 1, stop: "sideways", evidence: { series: false, related: "yes" } }));
    expect(r).toEqual({ version: 1, evidence: { series: false } });
    // D1 fills the rest at read time and is never stored.
    expect(workGroupPrefsOf(r)).toEqual({
      stop: "related",
      evidence: { series: false, related: true, issue: true },
      splits: [],
      keptApart: [],
    });
  });

  test("keeps a later build's split and anchor lists through the parser's bounds", () => {
    const r = readWorkGroupRecord(
      JSON.stringify({ version: 1, splits: [{ id: "s1", page: "Plans/A.md" }, { id: "bad id", page: "x.md" }], keptApart: ["b.md", "b.md"], extra: 1 }),
    );
    expect(r).toEqual({ version: 1, splits: [{ id: "s1", page: "plans/a.md" }], keptApart: ["b.md"] });
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
      state: { held: AREAS, known: AREAS, failed: false },
      write: false,
      repaint: false,
    });
  });

  test("B2: boot, storage unreadable — no record, known unknown", () => {
    expect(workGroupRecordStep(fresh, { kind: "boot", stored: undefined }).state).toEqual({ held: null, known: undefined, failed: false });
  });

  test("E1–E4: a storage event adopts without writing; repaints only once rendered and on a change", () => {
    const s = { held: null, known: null, failed: false };
    expect(workGroupRecordStep(s, { kind: "storage", stored: AREAS, booted: true })).toEqual({
      state: { held: AREAS, known: AREAS, failed: false },
      write: false,
      repaint: true,
    });
    expect(workGroupRecordStep(s, { kind: "storage", stored: AREAS, booted: false }).repaint).toBe(false);
    // The same record in another spelling is no change.
    const same = { held: AREAS, known: AREAS, failed: false };
    expect(workGroupRecordStep(same, { kind: "storage", stored: { stop: "areas", version: 1 }, booted: true }).repaint).toBe(false);
    // A clear() in another tab: back to D1.
    expect(workGroupRecordStep(same, { kind: "storage", stored: null, booted: true })).toEqual({
      state: { held: null, known: null, failed: false },
      write: false,
      repaint: true,
    });
  });

  test("E5: a storage event while storage is unreadable changes nothing", () => {
    const s = { held: AREAS, known: AREAS, failed: false };
    expect(workGroupRecordStep(s, { kind: "storage", stored: undefined, booted: true })).toEqual({ state: s, write: false, repaint: false });
  });

  test("C1: a click merges the edit onto the record as read NOW and writes it; known is that read", () => {
    // This tab holds Threads; another tab has since written an unchecked series box.
    const s = { held: THREADS, known: THREADS, failed: false };
    const r = workGroupRecordStep(s, { kind: "click", stored: NO_SERIES, edit: { stop: "areas" } });
    expect(r.write).toEqual({ value: rec({ stop: "areas", evidence: { series: false } }) });
    expect(r.state).toEqual({ held: rec({ stop: "areas", evidence: { series: false } }), known: NO_SERIES, failed: false });
    expect(workGroupRecordSettle(r.state, r.write ? r.write.value : AREAS, true)).toEqual({
      held: rec({ stop: "areas", evidence: { series: false } }),
      known: rec({ stop: "areas", evidence: { series: false } }),
      failed: false,
    });
  });

  test("C2: a refused write keeps the held record and marks it this tab only", () => {
    const r = workGroupRecordStep(fresh, { kind: "click", stored: null, edit: { stop: "areas" } });
    const after = workGroupRecordSettle(r.state, AREAS, false);
    expect(after).toEqual({ held: AREAS, known: null, failed: true });
  });

  test("C3: a click while storage is unreadable merges onto this tab's own record", () => {
    const s = { held: NO_SERIES, known: undefined, failed: false };
    const r = workGroupRecordStep(s, { kind: "click", stored: undefined, edit: { stop: "areas" } });
    expect(r.state.held).toEqual(rec({ stop: "areas", evidence: { series: false } }));
    expect(r.state.known).toBeUndefined();
    expect(r.write).not.toBe(false);
  });

  test("R1: a render with storage unreadable writes nothing and keeps the held record", () => {
    const s = { held: AREAS, known: undefined, failed: true };
    expect(workGroupRecordStep(s, { kind: "render", stored: undefined, focused: true })).toEqual({ state: s, write: false, repaint: false });
  });

  test("R2: storage readable for the first time — known is what it holds; this tab's own record stays", () => {
    expect(workGroupRecordStep({ held: AREAS, known: undefined, failed: true }, { kind: "render", stored: null, focused: true }).state).toEqual({
      held: AREAS,
      known: null,
      failed: true,
    });
    expect(workGroupRecordStep({ held: null, known: undefined, failed: false }, { kind: "render", stored: NO_SERIES, focused: true }).state).toEqual({
      held: NO_SERIES,
      known: NO_SERIES,
      failed: false,
    });
  });

  test("R2 then R6: a choice made while storage was unreadable is written on the next focused render", () => {
    let s: WorkGroupRecordState = { held: AREAS, known: undefined, failed: true };
    s = workGroupRecordStep(s, { kind: "render", stored: null, focused: true }).state;
    const r = workGroupRecordStep(s, { kind: "render", stored: null, focused: true });
    expect(r.write).toEqual({ value: AREAS });
  });

  test("R3: stored ≠ known — another tab wrote and this tab missed it: adopted, never overwritten", () => {
    const s = { held: AREAS, known: AREAS, failed: false };
    expect(workGroupRecordStep(s, { kind: "render", stored: THREADS, focused: true })).toEqual({
      state: { held: THREADS, known: THREADS, failed: false },
      write: false,
      repaint: false,
    });
  });

  test("R3 drops a change that only lived in memory after a refused write (accepted: the other tab's write is newer)", () => {
    const s = { held: AREAS, known: null, failed: true };
    expect(workGroupRecordStep(s, { kind: "render", stored: THREADS, focused: true }).state).toEqual({ held: THREADS, known: THREADS, failed: false });
  });

  test("R4: stored = known, no focus — nothing is written", () => {
    const s = { held: AREAS, known: null, failed: true };
    expect(workGroupRecordStep(s, { kind: "render", stored: null, focused: false })).toEqual({ state: s, write: false, repaint: false });
  });

  test("R5: stored = known = held — nothing to write", () => {
    const s = { held: AREAS, known: AREAS, failed: false };
    expect(workGroupRecordStep(s, { kind: "render", stored: AREAS, focused: true }).write).toBe(false);
    // No record anywhere: D1 is never written.
    expect(workGroupRecordStep(fresh, { kind: "render", stored: null, focused: true }).write).toBe(false);
  });

  test("R6: stored = known, focus, held differs — a refused write is retried; success clears the note", () => {
    const s = { held: AREAS, known: null, failed: true };
    const r = workGroupRecordStep(s, { kind: "render", stored: null, focused: true });
    expect(r.write).toEqual({ value: AREAS });
    expect(workGroupRecordSettle(r.state, AREAS, true)).toEqual({ held: AREAS, known: AREAS, failed: false });
    expect(workGroupRecordSettle(r.state, AREAS, false)).toEqual({ held: AREAS, known: null, failed: true });
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
