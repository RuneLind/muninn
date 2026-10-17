/**
 * The work-thread grouping preference record (plan
 * `muninn-wiki-work-thread-grouping`, «Manual boundaries and persistence»):
 * one versioned record per wiki holding the stop, the three evidence
 * booleans, page splits and kept-apart anchors. This module only PARSES and
 * VALIDATES it; storage and the record state machine are the reader's (PR 3),
 * and applying splits and anchors to membership is PR 4's.
 *
 * D1's defaults (Related, every box checked) are computed at read time by
 * {@link resolveWorkGroupPrefs} and are never part of a parsed record, so a
 * saved `false` stays `false` and a record nobody wrote stays absent.
 * Pure and DOM-free.
 */

import { normalizeRel } from "./wiki-nav.ts";

export const WORK_GROUP_PREFS_VERSION = 1;
/** Bounds on the stored arrays, applied on read: entries past them are dropped. */
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

/** A canonical page path, or null: a relative, non-empty path with no `..`
 *  segment, normalized the way pins are (`normalizeRel`). */
function pagePath(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const rel = normalizeRel(v.trim());
  if (!rel || rel.length > PAGE_PATH_MAX || rel.startsWith("/")) return null;
  if (rel.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  return rel;
}

/**
 * A stored record read back, or null when there is no valid preference: an
 * absent value, unparseable JSON, another version, an unknown stop, or an
 * evidence block without all three booleans. A null makes the caller use D1.
 *
 * The arrays are validated per entry rather than as a whole: a malformed split
 * or anchor is dropped, a duplicate page (or split id) keeps its first entry,
 * and each list is cut at its bound. An absent array reads as empty; a
 * present non-array makes the record invalid.
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
  const stop = v.stop;
  if (typeof stop !== "string" || !(WORK_GROUP_STOPS as readonly string[]).includes(stop)) return null;
  const ev = v.evidence;
  if (!isRecord(ev)) return null;
  const { series, related, issue } = ev;
  if (typeof series !== "boolean" || typeof related !== "boolean" || typeof issue !== "boolean") return null;
  if (v.splits !== undefined && !Array.isArray(v.splits)) return null;
  if (v.keptApart !== undefined && !Array.isArray(v.keptApart)) return null;

  const splits: WorkGroupSplit[] = [];
  const splitPages = new Set<string>();
  const splitIds = new Set<string>();
  for (const s of (v.splits as unknown[] | undefined) ?? []) {
    if (splits.length >= WORK_GROUP_SPLITS_MAX) break;
    if (!isRecord(s) || typeof s.id !== "string" || !SPLIT_ID_RE.test(s.id)) continue;
    const page = pagePath(s.page);
    if (!page || splitPages.has(page) || splitIds.has(s.id)) continue;
    splitPages.add(page);
    splitIds.add(s.id);
    splits.push({ id: s.id, page });
  }
  const keptApart: string[] = [];
  for (const a of (v.keptApart as unknown[] | undefined) ?? []) {
    if (keptApart.length >= WORK_GROUP_KEPT_APART_MAX) break;
    const page = pagePath(a);
    if (page && !keptApart.includes(page)) keptApart.push(page);
  }
  return { version: WORK_GROUP_PREFS_VERSION, stop: stop as WorkGroupStop, evidence: { series, related, issue }, splits, keptApart };
}

/** The settings in force: the record's when one is valid, else D1 with no
 *  splits or anchors. Never written back. */
export function resolveWorkGroupPrefs(prefs: WorkGroupPrefs | null): Omit<WorkGroupPrefs, "version"> {
  if (prefs) return { stop: prefs.stop, evidence: { ...prefs.evidence }, splits: prefs.splits, keptApart: prefs.keptApart };
  return { stop: WORK_GROUP_DEFAULTS.stop, evidence: { ...WORK_GROUP_DEFAULTS.evidence }, splits: [], keptApart: [] };
}
