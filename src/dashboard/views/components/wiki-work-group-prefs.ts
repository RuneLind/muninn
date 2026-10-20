/**
 * The work-thread grouping preference record (plan
 * `muninn-wiki-work-thread-grouping`, «Manual boundaries and persistence»):
 * one versioned record per wiki holding the stop, the three evidence
 * booleans, page splits and kept-apart anchors. This module only PARSES and
 * VALIDATES it; storage and the record state machine are the reader's
 * (`wiki-work-group-record.ts`), and applying splits and anchors to
 * membership is `wiki-work-boundaries.ts`'.
 *
 * D1's defaults (Related, every box checked) apply at read time: wholesale by
 * {@link resolveWorkGroupPrefs} when no record of this version exists, and
 * per field inside one, so a saved `false` stays `false` and a record nobody
 * wrote stays absent.
 * Pure and DOM-free.
 */

import { normalizeRel } from "./wiki-nav.ts";

export const WORK_GROUP_PREFS_VERSION = 1;
/** Bounds on the stored arrays: applied on read (entries past them are
 *  dropped) and on write (an add past them is refused). */
export const WORK_GROUP_SPLITS_MAX = 100;
export const WORK_GROUP_KEPT_APART_MAX = 50;
const PAGE_PATH_MAX = 512;
const SPLIT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The four stops, finest first (D7). */
export const WORK_GROUP_STOPS = ["sessions", "threads", "related", "areas"] as const;
export type WorkGroupStop = (typeof WORK_GROUP_STOPS)[number];

/** The three evidence checkboxes. Project is not one: Areas always reads it. */
export interface WorkGroupEvidenceToggles {
  series: boolean;
  related: boolean;
  issue: boolean;
}

/** One Make own thread definition: a generated id and the canonical page path. */
export interface WorkGroupSplit {
  id: string;
  page: string;
}

export interface WorkGroupPrefs {
  version: typeof WORK_GROUP_PREFS_VERSION;
  stop: WorkGroupStop;
  evidence: WorkGroupEvidenceToggles;
  splits: WorkGroupSplit[];
  /** Pin-compatible page anchors (`threadPinAnchor`'s spelling: normalized
   *  relPaths) of the threads kept apart. */
  keptApart: string[];
}

/** D1: the Related stop with every evidence box checked. */
export const WORK_GROUP_DEFAULTS: Readonly<Pick<WorkGroupPrefs, "stop" | "evidence">> = Object.freeze({
  stop: "related",
  evidence: Object.freeze({ series: true, related: true, issue: true }),
});

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A canonical page path, or null: trimmed and spelled by `normalizeRel` (the
 *  reader's one spelling, which the boundaries and the pin compare with), then
 *  refused when nothing is left, it climbs out of the wiki (`..`), or it ends
 *  in `/`. A path that normalizes to a folder is not refused: `plans/.` reads
 *  back as `plans`, `a/b/..` as `a`. A record written under the old
 *  lower-case-only spelling reads back canonical here, so no migration. The
 *  parser and the record's list operations both match pages by it. */
export function workGroupPagePath(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const rel = normalizeRel(v.trim());
  if (!rel || rel.length > PAGE_PATH_MAX) return null;
  if (rel.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  return rel;
}

/** One stored split as this build reads it (its page canonical), or null for
 *  an entry it cannot read. Duplicates and the bound are the parser's. */
export function readWorkGroupSplit(s: unknown): WorkGroupSplit | null {
  if (!isRecord(s) || typeof s.id !== "string" || !SPLIT_ID_RE.test(s.id)) return null;
  const page = workGroupPagePath(s.page);
  return page ? { id: s.id, page } : null;
}

/** One stored kept-apart anchor as this build reads it, or null. */
export const readWorkGroupAnchor = workGroupPagePath;

/**
 * A stored record read back, or null when there is no valid preference: an
 * absent value, unparseable JSON, not an object, or another version. A null
 * makes the caller use D1.
 *
 * A record of this version is valid, and each field is validated on its own:
 * a missing or invalid stop, evidence boolean or array falls back to that
 * field's default (Related, `true`, empty) while every valid field — a saved
 * `false` included — is kept. Array entries are validated one by one: a
 * malformed split or anchor is dropped, a duplicate page (or split id) keeps
 * its first entry, and each list is cut at its bound.
 */
export function parseWorkGroupPrefs(raw: unknown): WorkGroupPrefs | null {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!isRecord(v) || v.version !== WORK_GROUP_PREFS_VERSION) return null;
  const stop =
    typeof v.stop === "string" && (WORK_GROUP_STOPS as readonly string[]).includes(v.stop) ? (v.stop as WorkGroupStop) : WORK_GROUP_DEFAULTS.stop;
  const ev = isRecord(v.evidence) ? v.evidence : {};
  const flag = (k: keyof WorkGroupEvidenceToggles) => (typeof ev[k] === "boolean" ? (ev[k] as boolean) : WORK_GROUP_DEFAULTS.evidence[k]);
  const evidence = { series: flag("series"), related: flag("related"), issue: flag("issue") };
  const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

  const splits: WorkGroupSplit[] = [];
  const splitPages = new Set<string>();
  const splitIds = new Set<string>();
  for (const entry of list(v.splits)) {
    if (splits.length >= WORK_GROUP_SPLITS_MAX) break;
    const s = readWorkGroupSplit(entry);
    if (!s || splitPages.has(s.page) || splitIds.has(s.id)) continue;
    splitPages.add(s.page);
    splitIds.add(s.id);
    splits.push(s);
  }
  const keptApart: string[] = [];
  for (const a of list(v.keptApart)) {
    if (keptApart.length >= WORK_GROUP_KEPT_APART_MAX) break;
    const page = readWorkGroupAnchor(a);
    if (page && !keptApart.includes(page)) keptApart.push(page);
  }
  return { version: WORK_GROUP_PREFS_VERSION, stop, evidence, splits, keptApart };
}

/** The settings in force: the record's when one is valid, else D1 with no
 *  splits or anchors. Never written back. */
export function resolveWorkGroupPrefs(prefs: WorkGroupPrefs | null): Omit<WorkGroupPrefs, "version"> {
  if (prefs) return { stop: prefs.stop, evidence: { ...prefs.evidence }, splits: prefs.splits, keptApart: prefs.keptApart };
  return { stop: WORK_GROUP_DEFAULTS.stop, evidence: { ...WORK_GROUP_DEFAULTS.evidence }, splits: [], keptApart: [] };
}
