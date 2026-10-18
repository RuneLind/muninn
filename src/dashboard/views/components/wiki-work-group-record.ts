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
 * It is also held VERBATIM: a field, evidence key or list entry this build
 * does not understand is kept and written back untouched, so an old tab and a
 * new tab never erase each other's data, and a record of a later version (an
 * integer above 1) is never written over (`foreignWorkGroupRecord`); a
 * malformed version reads as none and the first click replaces it.
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
  readWorkGroupAnchor,
  readWorkGroupSplit,
  resolveWorkGroupPrefs,
  WORK_GROUP_KEPT_APART_MAX,
  WORK_GROUP_PREFS_VERSION,
  WORK_GROUP_SPLITS_MAX,
  workGroupPagePath,
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

/** The stored record as stored: the fields a reader set, valid or not, and
 *  any field a later build added. `workGroupPrefsOf` validates on read. */
export interface WorkGroupRecord {
  /** `WORK_GROUP_PREFS_VERSION` for a record this build writes; an integer
   *  above it is a later build's record (`foreignWorkGroupRecord`). */
  version: unknown;
  /** A `WorkGroupStop`, `Partial<WorkGroupEvidenceToggles>`, `WorkGroupSplit[]`
   *  and `string[]` when valid; read only through `workGroupPrefsOf`. */
  stop?: unknown;
  evidence?: unknown;
  splits?: unknown;
  keptApart?: unknown;
  [field: string]: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * A stored value read back verbatim, or null for none: absent, unparseable,
 * not an object, or an object whose `version` is neither this build's nor a
 * later build's (missing, `null`, a string, 0, a fraction…: malformed, D1
 * applies and a click replaces it). A record of this or a later version is
 * kept whole; `workGroupPrefsOf` validates it (a later version reads as D1, an
 * invalid field as its default), so a default is never mistaken for a choice
 * and nothing this build does not understand is lost on a write.
 */
export function readWorkGroupRecord(raw: string | null | undefined): WorkGroupRecord | null {
  if (typeof raw !== "string") return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(v) || (v.version !== WORK_GROUP_PREFS_VERSION && !laterVersion(v.version))) return null;
  return v as WorkGroupRecord;
}

/** A version only a later build writes: an integer above this build's. */
const laterVersion = (v: unknown): boolean => Number.isInteger(v) && (v as number) > WORK_GROUP_PREFS_VERSION;

/** A later build's record: read as D1, never written over. */
export function foreignWorkGroupRecord(record: WorkGroupRecord | null | undefined): boolean {
  return !!record && laterVersion(record.version);
}

/** The settings a record puts in force: its valid fields, D1 for the rest. */
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

/**
 * One explicit edit: a stop or a box from the Group menu, or (PR 4) a
 * boundary from a ⋯ menu — a page split added or removed, a thread kept apart
 * or allowed to group again, the kept-apart anchors moved (a render's
 * re-anchor), or Reset, which clears the stop, the boxes, the splits and the
 * anchors (D1) and keeps every field this build does not understand.
 */
export type WorkGroupEdit =
  | { stop: WorkGroupStop }
  | { evidence: keyof WorkGroupEvidenceToggles; value: boolean }
  | { split: WorkGroupSplit }
  | { unsplit: { id: string; page: string } }
  | { keepApart: string }
  | { allowGrouping: readonly string[] }
  | { reanchor: readonly (readonly [string, string])[] }
  | { reset: true };

/**
 * A list edit as the patch holds it: an OPERATION by id or page, never the
 * list as this tab last saw it. Every write lays the operations, in order, on
 * the list as read at that moment, so two tabs that add different splits keep
 * both, and an entry this build does not understand is never touched.
 * Operations read entries as the parser does (`readWorkGroupSplit`,
 * `readWorkGroupAnchor`: pages trimmed and canonical), and an add past
 * `WORK_GROUP_SPLITS_MAX` / `WORK_GROUP_KEPT_APART_MAX` is refused, so the
 * stored lists stay bounded and no entry hides past the bound.
 */
export type WorkGroupListOp =
  | { op: "addSplit"; split: WorkGroupSplit }
  | { op: "removeSplit"; id: string; page: string }
  | { op: "addAnchor"; page: string }
  | { op: "removeAnchors"; pages: string[] }
  | { op: "moveAnchors"; moves: [string, string][] }
  | { op: "reset" };

/** The patch's list operations, under a key no stored record carries: the
 *  merge reads it and never copies it into a record. */
export const WORK_GROUP_PATCH_OPS = "listOps";

/** A record's evidence object, or none when it holds no object there. */
const evidenceOf = (r: WorkGroupRecord | null | undefined): Record<string, unknown> => (r && isRecord(r.evidence) ? r.evidence : {});

const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A page as the ops carry it: canonical (`workGroupPagePath`), or "" for a
 *  path no entry can hold, which matches nothing and adds nothing. */
const opPage = (p: string): string => workGroupPagePath(p) ?? "";

/** The list ops an edit is, or null for a stop or a box. */
function listOpOf(edit: WorkGroupEdit): WorkGroupListOp | null {
  if ("split" in edit) return { op: "addSplit", split: { id: edit.split.id, page: opPage(edit.split.page) } };
  if ("unsplit" in edit) return { op: "removeSplit", id: edit.unsplit.id, page: opPage(edit.unsplit.page) };
  if ("keepApart" in edit) return { op: "addAnchor", page: opPage(edit.keepApart) };
  if ("allowGrouping" in edit) return { op: "removeAnchors", pages: edit.allowGrouping.map(opPage) };
  if ("reanchor" in edit) return { op: "moveAnchors", moves: edit.reanchor.map(([a, b]) => [opPage(a), opPage(b)]) };
  if ("reset" in edit) return { op: "reset" };
  return null;
}

/** `rec` (a record of this version, mutated) with one list op applied. Only
 *  entries this build reads are matched (by id or canonical page) or counted
 *  against the bound; an entry it cannot read is kept where it is. */
function applyListOp(rec: WorkGroupRecord, op: WorkGroupListOp): void {
  const anchor = readWorkGroupAnchor;
  /** The lists in force: the parser's, deduplicated and bounded. */
  const inForce = () => parseWorkGroupPrefs({ version: WORK_GROUP_PREFS_VERSION, splits: rec.splits, keptApart: rec.keptApart })!;
  switch (op.op) {
    case "addSplit": {
      const split = readWorkGroupSplit(op.split);
      if (!split) return;
      const read = inForce().splits;
      // Idempotent: another tab's split of the same page (or id) stands.
      if (read.some((x) => x.id === split.id || x.page === split.page)) return;
      // Full: refused, never stored past the bound (the row ⋯ says why).
      if (read.length >= WORK_GROUP_SPLITS_MAX) return;
      rec.splits = [...listOf(rec.splits), split];
      return;
    }
    case "removeSplit":
      // Every readable entry on the id or page, a shadowed duplicate included,
      // so a Return never leaves another definition of the page behind.
      rec.splits = listOf(rec.splits).filter((x) => {
        const s = readWorkGroupSplit(x);
        return !s || !(s.id === op.id || s.page === op.page);
      });
      return;
    case "addAnchor": {
      const read = inForce().keptApart;
      if (!op.page || read.includes(op.page) || read.length >= WORK_GROUP_KEPT_APART_MAX) return;
      rec.keptApart = [...listOf(rec.keptApart), op.page];
      return;
    }
    case "removeAnchors":
      rec.keptApart = listOf(rec.keptApart).filter((x) => !op.pages.includes(anchor(x) ?? "\u0000"));
      return;
    case "moveAnchors": {
      // Two anchors moved onto one page collapse to one entry.
      let cur = listOf(rec.keptApart);
      for (const [from, to] of op.moves) {
        if (!from || !to || !cur.some((x) => anchor(x) === from)) continue;
        cur = cur.filter((x) => anchor(x) !== from);
        if (!cur.some((x) => anchor(x) === to)) cur.push(to);
      }
      rec.keptApart = cur;
      return;
    }
    case "reset":
      delete rec.stop;
      delete rec.evidence;
      delete rec.splits;
      delete rec.keptApart;
      return;
  }
}

/** Which bound refused `edit` on `record` (the record a click left held):
 *  a Make own thread or Keep separate it does not hold while that list is
 *  full. A tab whose menu offered the add before another tab filled the list
 *  says so instead of a click that does nothing. */
export function workGroupAddRefused(record: WorkGroupRecord | null, edit: WorkGroupEdit): "splits" | "keptApart" | null {
  const prefs = workGroupPrefsOf(record);
  if ("split" in edit) {
    const page = opPage(edit.split.page);
    return prefs.splits.length >= WORK_GROUP_SPLITS_MAX && !prefs.splits.some((s) => s.page === page) ? "splits" : null;
  }
  if ("keepApart" in edit) {
    const page = opPage(edit.keepApart);
    return prefs.keptApart.length >= WORK_GROUP_KEPT_APART_MAX && !prefs.keptApart.includes(page) ? "keptApart" : null;
  }
  return null;
}

/** `base` with `edit` applied; every other field of `base` is kept verbatim,
 *  unknown evidence keys and list entries included. A later build's record is
 *  no base: the edit starts a record of this version. */
export function applyWorkGroupEdit(base: WorkGroupRecord | null, edit: WorkGroupEdit): WorkGroupRecord {
  const own = foreignWorkGroupRecord(base) ? null : base;
  const out: WorkGroupRecord = { ...(own ?? {}), version: WORK_GROUP_PREFS_VERSION };
  const op = listOpOf(edit);
  if (op) applyListOp(out, op);
  else if ("stop" in edit) out.stop = edit.stop;
  else if ("evidence" in edit) out.evidence = { ...evidenceOf(own), [edit.evidence]: edit.value };
  return out;
}

/** A tab's patch with one more edit: a stop or a box as the field itself, a
 *  list edit as one more operation. Reset supersedes everything the patch
 *  held before it. */
export function patchWorkGroupEdit(patch: WorkGroupRecord | null, edit: WorkGroupEdit): WorkGroupRecord {
  const op = listOpOf(edit);
  if (!op) return applyWorkGroupEdit(patch, edit);
  if (op.op === "reset") return { version: WORK_GROUP_PREFS_VERSION, [WORK_GROUP_PATCH_OPS]: [op] };
  const ops = listOf(patch?.[WORK_GROUP_PATCH_OPS]) as WorkGroupListOp[];
  return { ...(patch ?? {}), version: WORK_GROUP_PREFS_VERSION, [WORK_GROUP_PATCH_OPS]: [...ops, op] };
}

/** `base` with a tab's unpersisted fields (`patch`) laid on top: a reset in
 *  the patch first, then each field the patch holds wins (evidence box by
 *  box), then its list operations in order on the lists as `base` holds
 *  them; every other field of `base` is kept verbatim. A later build's record
 *  is no base (the patch alone). No patch: `base` itself. */
export function mergeWorkGroupPatch(base: WorkGroupRecord | null, patch: WorkGroupRecord | null): WorkGroupRecord | null {
  if (!patch) return base;
  const own = foreignWorkGroupRecord(base) ? null : base;
  const ops = listOf(patch[WORK_GROUP_PATCH_OPS]) as WorkGroupListOp[];
  const out: WorkGroupRecord = { ...(own ?? {}), version: WORK_GROUP_PREFS_VERSION };
  if (ops[0]?.op === "reset") applyListOp(out, ops[0]);
  const baseEvidence = evidenceOf(out);
  const fields: WorkGroupRecord = { ...patch };
  delete fields[WORK_GROUP_PATCH_OPS];
  Object.assign(out, fields, { version: WORK_GROUP_PREFS_VERSION });
  if (isRecord(patch.evidence)) out.evidence = { ...baseEvidence, ...patch.evidence };
  for (const op of ops) if (op.op !== "reset") applyListOp(out, op);
  return out;
}

/**
 * One tab's view of the record. `held` is what the rail renders from (null:
 * no record, D1). `known` is the record this tab last READ from storage or
 * WROTE successfully — `undefined` while storage has never been readable.
 * `patch` holds the fields this tab's clicks set that storage does not hold
 * yet (null: none), so `held` is `known` (or the read record) with `patch` on
 * top; every write is the record as read with `patch` on top. It clears on a
 * successful write, on a render that finds storage already holding `held`
 * (R2, R5), and when another tab's newer record arrives (R3, a `storage`
 * event, or a click whose read differs from `known`). `failed` is set while
 * the held record lives in this tab only (its write was refused), so the menu
 * says so.
 */
export interface WorkGroupRecordState {
  held: WorkGroupRecord | null;
  known: WorkGroupRecord | null | undefined;
  patch: WorkGroupRecord | null;
  failed: boolean;
}

/** What asks the record to decide. `stored` is the record as read now,
 *  `undefined` when the read threw. */
export type WorkGroupRecordTrigger =
  | { kind: "boot"; stored: WorkGroupRecord | null | undefined }
  | { kind: "storage"; stored: WorkGroupRecord | null | undefined; booted: boolean }
  | { kind: "click"; stored: WorkGroupRecord | null | undefined; edit: WorkGroupEdit }
  | {
      kind: "render";
      stored: WorkGroupRecord | null | undefined;
      focused: boolean;
      /** PR 4: the kept-apart anchors this render re-anchors
       *  (`applyWorkBoundaries`' `reanchor`, over `held`). */
      reanchor?: readonly (readonly [string, string])[];
    };

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
  const adopt = (stored: WorkGroupRecord | null): WorkGroupRecordState => ({ held: stored, known: stored, patch: null, failed: false });
  switch (t.kind) {
    case "boot":
      // B1, B2.
      return none(t.stored === undefined ? { held: null, known: undefined, patch: null, failed: false } : adopt(t.stored));
    case "storage": {
      // E5: unreadable — nothing to adopt.
      if (t.stored === undefined) return none(state);
      // E1–E4: adopt (another tab's write is the newer choice, so this tab's
      // patch goes), never write; repaint once rendered, on a change of the
      // record or of the «this tab only» note.
      return {
        state: adopt(t.stored),
        write: false,
        repaint: t.booted && (state.failed || !sameWorkGroupRecord(t.stored, state.held)),
      };
    }
    case "click": {
      // C1–C3: the edit joins this tab's patch, and the patch is merged onto
      // the record as read NOW (this tab's own when storage is unreadable),
      // written whatever storage holds. A read that differs from `known` is
      // another tab's newer record, so the patch goes first (R3's rule).
      // `known` becomes that read, so a refused write is retried by R6 rather
      // than dropped by R3 for a record storage already holds.
      if (t.stored === undefined) {
        const patch = patchWorkGroupEdit(state.patch, t.edit);
        const held = applyWorkGroupEdit(state.held, t.edit);
        // C4: storage last held a later build's record — never written over.
        if (foreignWorkGroupRecord(state.known)) return none({ held, known: state.known, patch, failed: true });
        return { state: { held, known: undefined, patch, failed: state.failed }, write: { value: held }, repaint: false };
      }
      const kept = state.known === undefined || sameWorkGroupRecord(t.stored, state.known) ? state.patch : null;
      const patch = patchWorkGroupEdit(kept, t.edit);
      const held = mergeWorkGroupPatch(t.stored, patch)!;
      // C4: storage holds a later build's record. Never written over: the
      // edit lives in this tab (D1 plus the patch), «this tab only».
      if (foreignWorkGroupRecord(t.stored)) return none({ held, known: t.stored, patch, failed: true });
      return { state: { held, known: t.stored, patch, failed: state.failed }, write: { value: held }, repaint: false };
    }
    case "render": {
      // R1: unreadable — no compare is possible.
      if (t.stored === undefined) return none(state);
      // R2: readable for the first time — what it holds is known; this tab's
      // patch (a click whose write failed) is laid on top, written by R6.
      if (state.known === undefined) {
        const held = mergeWorkGroupPatch(t.stored, state.patch);
        // Storage already holds what this tab holds: nothing is this tab's only.
        if (sameWorkGroupRecord(held, t.stored)) return none(adopt(t.stored));
        return none({ held, known: t.stored, patch: state.patch, failed: state.failed });
      }
      // R3: another tab wrote and this tab never heard — adopt it. A change
      // that lived only in memory after a refused write is dropped here.
      if (!sameWorkGroupRecord(t.stored, state.known)) return none(adopt(t.stored));
      // A1–A3: a kept-apart anchor moved to its thread's newest focus page.
      // The move joins the patch like an edit (a list operation, so another
      // tab's anchors are never touched) and is written by R6 below while this
      // tab has focus; without focus it lives in memory (R4).
      if (t.reanchor?.length && !foreignWorkGroupRecord(t.stored)) {
        const edit: WorkGroupEdit = { reanchor: t.reanchor };
        const held = applyWorkGroupEdit(state.held, edit);
        if (!sameWorkGroupRecord(held, state.held)) {
          const moved = { held, known: state.known, patch: patchWorkGroupEdit(state.patch, edit), failed: state.failed };
          if (!t.focused) return none(moved);
          return { state: moved, write: { value: held }, repaint: false };
        }
      }
      // R5: storage already holds `held` (the refused write was of a record
      // storage held already): the patch is persisted, so it and the note clear.
      if (sameWorkGroupRecord(state.held, t.stored)) return none(state.patch === null && !state.failed ? state : adopt(t.stored));
      // R4: no focus, or nothing to write. Here `held` is `known` (= the read)
      // with `patch` on top: every row that sets `known` keeps that.
      if (!t.focused || state.patch === null || state.held === null) return none(state);
      // R7: storage holds a later build's record — no retry over it (C4).
      if (foreignWorkGroupRecord(t.stored)) return none(state);
      // R6: storage still holds `known` and this tab holds a patch on it.
      return { state, write: { value: state.held }, repaint: false };
    }
  }
}

/** After the write a step asked for: storage holds `value` only when it took,
 *  and then the patch is in storage. */
export function workGroupRecordSettle(state: WorkGroupRecordState, value: WorkGroupRecord, ok: boolean): WorkGroupRecordState {
  return ok ? { held: state.held, known: value, patch: null, failed: false } : { ...state, failed: true };
}

/** The stored spelling of a record: plain JSON, field order as written.
 *  Comparison never reads it raw (`sameWorkGroupRecord`). */
export function serializeWorkGroupRecord(record: WorkGroupRecord): string {
  return JSON.stringify(record);
}
