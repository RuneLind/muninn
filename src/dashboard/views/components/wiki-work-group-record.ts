/**
 * The work-thread grouping preference RECORD in storage (plan
 * `muninn-wiki-work-thread-grouping`, «Manual boundaries and persistence»,
 * D17): one versioned record per wiki under `muninn.wiki.workGroup.v1:<wiki>`,
 * and the state table every read and write of it goes through.
 *
 * The record is SPARSE: it holds only the fields a reader set, so D1's
 * defaults are computed at read time (`resolveWorkGroupPrefs`) and are never
 * held or written. A record exists only after an explicit edit.
 *
 * The table is the thread pin's (`threadPinStep`, `wiki-recents.ts`) over the
 * whole record: records compare by a canonical serialization, a `storage`
 * event adopts without writing, a render adopts a record it did not last read
 * or write (R3) and writes only while storage still holds `known` (R6), and a
 * click writes the reader's edit merged onto the record as read at that
 * moment. Pure and DOM-free; the reader does the storage IO.
 */

import {
  parseWorkGroupPrefs,
  resolveWorkGroupPrefs,
  WORK_GROUP_PREFS_VERSION,
  type WorkGroupEvidenceToggles,
  type WorkGroupPrefs,
  type WorkGroupSplit,
  type WorkGroupStop,
} from "./wiki-work-group-prefs.ts";

export const WORK_GROUP_KEY_PREFIX = "muninn.wiki.workGroup.v1:";

/** The record's key for one wiki (the reader's `WIKI`). */
export function workGroupKey(wiki: string): string {
  return WORK_GROUP_KEY_PREFIX + wiki;
}

/** Does a `storage` event concern this wiki's record? `null` is a `clear()`. */
export function storageEventTouchesWorkGroup(key: string | null, wiki: string): boolean {
  return key === null || key === workGroupKey(wiki);
}

/** The stored record: only the fields a reader set, each valid. */
export interface WorkGroupRecord {
  version: typeof WORK_GROUP_PREFS_VERSION;
  stop?: WorkGroupStop;
  evidence?: Partial<WorkGroupEvidenceToggles>;
  splits?: WorkGroupSplit[];
  keptApart?: string[];
}

const EVIDENCE_KEYS = ["series", "related", "issue"] as const;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * A stored value read back as a sparse record, or null for none: absent,
 * unparseable, not an object, or another version (D1 applies). Each field is
 * validated by `parseWorkGroupPrefs`, and only the fields PRESENT and valid
 * in the stored value are kept, so a default is never mistaken for a choice.
 */
export function readWorkGroupRecord(raw: string | null | undefined): WorkGroupRecord | null {
  if (typeof raw !== "string") return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  const full = parseWorkGroupPrefs(v);
  if (!full || !isRecord(v)) return null;
  const out: WorkGroupRecord = { version: WORK_GROUP_PREFS_VERSION };
  if (v.stop === full.stop) out.stop = full.stop;
  if (isRecord(v.evidence)) {
    const ev: Partial<WorkGroupEvidenceToggles> = {};
    for (const k of EVIDENCE_KEYS) if (typeof v.evidence[k] === "boolean") ev[k] = v.evidence[k] as boolean;
    if (Object.keys(ev).length) out.evidence = ev;
  }
  if (Array.isArray(v.splits)) out.splits = full.splits;
  if (Array.isArray(v.keptApart)) out.keptApart = full.keptApart;
  return out;
}

/** The settings a record puts in force: its fields, D1 for the rest. */
export function workGroupPrefsOf(record: WorkGroupRecord | null): Omit<WorkGroupPrefs, "version"> {
  return resolveWorkGroupPrefs(record ? parseWorkGroupPrefs(record) : null);
}

/** The canonical serialization records compare by: sorted keys at every
 *  level and sorted arrays, so two spellings of one record are one string. */
export function canonicalWorkGroupRecord(record: WorkGroupRecord | null | undefined): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon).sort((a, b) => {
      const x = JSON.stringify(a);
      const y = JSON.stringify(b);
      return x < y ? -1 : x > y ? 1 : 0;
    });
    if (isRecord(v)) {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) if (v[k] !== undefined) o[k] = canon(v[k]);
      return o;
    }
    return v;
  };
  return record === undefined ? "<unreadable>" : JSON.stringify(canon(record));
}

/** Two records (or none, or unreadable) are the same choice. */
export function sameWorkGroupRecord(a: WorkGroupRecord | null | undefined, b: WorkGroupRecord | null | undefined): boolean {
  return canonicalWorkGroupRecord(a) === canonicalWorkGroupRecord(b);
}

/** One explicit edit from the Group menu. PR 4 adds splits and anchors. */
export type WorkGroupEdit = { stop: WorkGroupStop } | { evidence: keyof WorkGroupEvidenceToggles; value: boolean };

/** `base` with `edit` applied; every other field of `base` is kept. */
export function applyWorkGroupEdit(base: WorkGroupRecord | null, edit: WorkGroupEdit): WorkGroupRecord {
  const out: WorkGroupRecord = { ...(base ?? {}), version: WORK_GROUP_PREFS_VERSION };
  if ("stop" in edit) out.stop = edit.stop;
  else out.evidence = { ...(base?.evidence ?? {}), [edit.evidence]: edit.value };
  return out;
}

/**
 * One tab's view of the record. `held` is what the rail renders from (null:
 * no record, D1). `known` is the record this tab last READ from storage or
 * WROTE successfully — `undefined` while storage has never been readable.
 * `failed` is set while the held record lives in this tab only (its write was
 * refused), so the menu says so.
 */
export interface WorkGroupRecordState {
  held: WorkGroupRecord | null;
  known: WorkGroupRecord | null | undefined;
  failed: boolean;
}

/** What asks the record to decide. `stored` is the record as read now,
 *  `undefined` when the read threw. */
export type WorkGroupRecordTrigger =
  | { kind: "boot"; stored: WorkGroupRecord | null | undefined }
  | { kind: "storage"; stored: WorkGroupRecord | null | undefined; booted: boolean }
  | { kind: "click"; stored: WorkGroupRecord | null | undefined; edit: WorkGroupEdit }
  | { kind: "render"; stored: WorkGroupRecord | null | undefined; focused: boolean };

export interface WorkGroupRecordStep {
  state: WorkGroupRecordState;
  write: false | { value: WorkGroupRecord };
  repaint: boolean;
}

/**
 * The record's state table (D17), one row per branch — the rows are in
 * `src/wiki/CLAUDE.md` («The grouping record's state table»). The pin's two
 * rules carry it: only a click or a focused render this tab caused writes, so
 * no write loop is possible between tabs; and a render writes only while
 * storage still holds `known`, so a record another tab wrote is adopted,
 * never overwritten.
 */
export function workGroupRecordStep(state: WorkGroupRecordState, t: WorkGroupRecordTrigger): WorkGroupRecordStep {
  const none = (s: WorkGroupRecordState): WorkGroupRecordStep => ({ state: s, write: false, repaint: false });
  switch (t.kind) {
    case "boot":
      // B1, B2.
      return none(t.stored === undefined ? { held: null, known: undefined, failed: false } : { held: t.stored, known: t.stored, failed: false });
    case "storage": {
      // E5: unreadable — nothing to adopt.
      if (t.stored === undefined) return none(state);
      // E1–E4: adopt, never write; repaint once rendered and only on a change.
      return {
        state: { held: t.stored, known: t.stored, failed: false },
        write: false,
        repaint: t.booted && !sameWorkGroupRecord(t.stored, state.held),
      };
    }
    case "click": {
      // C1–C3: the reader's edit merged onto the record as read NOW (this
      // tab's own when storage is unreadable), written whatever storage holds.
      // `known` becomes that read, so a refused write is retried by R6 rather
      // than dropped by R3 for a record storage already holds.
      const base = t.stored === undefined ? state.held : t.stored;
      const held = applyWorkGroupEdit(base, t.edit);
      return { state: { held, known: t.stored, failed: state.failed }, write: { value: held }, repaint: false };
    }
    case "render": {
      // R1: unreadable — no compare is possible.
      if (t.stored === undefined) return none(state);
      // R2: readable for the first time — what it holds is known; this tab's
      // own record (a click whose write failed) stays, written by a later R6.
      if (state.known === undefined) return none({ held: state.held ?? t.stored, known: t.stored, failed: state.failed });
      // R3: another tab wrote and this tab never heard — adopt it. A change
      // that lived only in memory after a refused write is dropped here.
      if (!sameWorkGroupRecord(t.stored, state.known)) return none({ held: t.stored, known: t.stored, failed: false });
      // R4/R5: no focus, or nothing to write.
      if (!t.focused || state.held === null || sameWorkGroupRecord(state.held, t.stored)) return none(state);
      // R6: storage still holds `known` and this tab holds another record.
      return { state, write: { value: state.held }, repaint: false };
    }
  }
}

/** After the write a step asked for: storage holds `value` only when it took. */
export function workGroupRecordSettle(state: WorkGroupRecordState, value: WorkGroupRecord, ok: boolean): WorkGroupRecordState {
  return ok ? { held: state.held, known: value, failed: false } : { ...state, failed: true };
}

/** The stored spelling of a record: plain JSON, field order as written.
 *  Comparison never reads it raw (`sameWorkGroupRecord`). */
export function serializeWorkGroupRecord(record: WorkGroupRecord): string {
  return JSON.stringify(record);
}
