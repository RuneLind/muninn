/**
 * Connections rows: the wiki-wide key map `buildWikiIndex` builds once, and the
 * index-local half of one page's rows read off it. PURE over the index — the
 * network-joined half (status, title, ledger) is `provenance-service.ts`'s.
 */

import { getLog } from "../../logging.ts";
import { isPlanTitle, trackerAdapter } from "./index.ts";
import {
  COVERAGE_RELATIONS,
  relationsCount,
  type IssueKeyEntry,
  type IssueRef,
  type IssueRow,
  type StatusCategory,
  type TrackerConfig,
} from "./types.ts";

const log = getLog("wiki", "trackers");

/** The fields of a page the key map reads. */
export interface IssuePageInput {
  relPath: string;
  title: string;
  type: string;
  issues?: IssueRef[];
}

/** `tracker:key`, the map's key — the way a session ref is `provider:id`. */
const issueKeyId = (tracker: string, key: string): string => `${tracker}:${key}`;

/**
 * Is this page a plan under this tracker's config? Its resolved type is `plan`
 * (a `type: plan` line, or the wiki's `typeMap` for its folder), it sits in a
 * top-level `plans/` folder, or its title reads as a plan (`planTitle`, minus
 * `planTitleExclude`).
 */
export function isPlanPage(page: { relPath: string; title: string; type: string }, config: TrackerConfig): boolean {
  if (page.type === "plan") return true;
  if (page.relPath.split("/")[0] === "plans") return true;
  return isPlanTitle(page.title, config);
}

/**
 * key → every page related to it, with that page's relations and whether it
 * is a plan. Demoted ties are kept (a later graph reads them); counts and
 * coverage filter them out.
 */
export function buildIssueKeyIndex(
  pages: readonly IssuePageInput[],
  trackers: readonly TrackerConfig[],
): Map<string, IssueKeyEntry> {
  const out = new Map<string, IssueKeyEntry>();
  if (!trackers.length) return out;
  const configOf = new Map(trackers.map((t) => [t.id, t]));
  const sorted = [...pages].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  for (const page of sorted) {
    for (const ref of page.issues ?? []) {
      const config = configOf.get(ref.tracker);
      if (!config) continue;
      const id = issueKeyId(ref.tracker, ref.key);
      let entry = out.get(id);
      if (!entry) out.set(id, (entry = { tracker: ref.tracker, key: ref.key, pages: [] }));
      entry.pages.push({
        relPath: page.relPath,
        title: page.title,
        relations: ref.relations,
        plan: isPlanPage(page, config),
      });
    }
  }
  return out;
}

/** The plans that cover a key: a plan page with a coverage relation to it. */
function coveringPlans(entry: IssueKeyEntry | undefined): { relPath: string; title: string }[] {
  if (!entry) return [];
  return entry.pages
    .filter((p) => p.plan && p.relations.some((r) => (COVERAGE_RELATIONS as readonly string[]).includes(r)))
    .map((p) => ({ relPath: p.relPath, title: p.title }));
}

/**
 * The index-local half of a page's rows, in the page's own order (strongest
 * relation first). Every ref is a row — demoted ones included — because
 * Connections lists link-only and mention-only keys on lines of their own.
 * `[]` on a page with no issues or a wiki with no tracker.
 */
export function issueRowsFor(
  page: { issues?: IssueRef[] },
  keyIndex: ReadonlyMap<string, IssueKeyEntry> | undefined,
  trackers: readonly TrackerConfig[],
): IssueRow[] {
  if (!page.issues?.length || !trackers.length) return [];
  const configOf = new Map(trackers.map((t) => [t.id, t]));
  const out: IssueRow[] = [];
  for (const ref of page.issues) {
    const config = configOf.get(ref.tracker);
    const adapter = trackerAdapter(ref.tracker);
    if (!config || !adapter) continue;
    const entry = keyIndex?.get(issueKeyId(ref.tracker, ref.key));
    out.push({
      tracker: ref.tracker,
      key: ref.key,
      url: adapter.urlFor(ref.key, config),
      field: adapter.frontmatterKey,
      relations: [...ref.relations],
      pageCount: entry ? entry.pages.filter((p) => relationsCount(p.relations)).length : 0,
      planPages: coveringPlans(entry),
    });
  }
  return out;
}

/** Raw statuses already logged as unmapped, per wiki and tracker. Bounded by
 *  the corpus's own status vocabulary (tens of values), never by requests. */
const warnedStatuses = new Set<string>();

/** A raw status through the wiki's merged `statusMap`. Unmapped ⇒ `unknown`,
 *  logged once per wiki and value so that wiki's operator can extend its map. */
export function statusCategory(status: string | undefined, config: TrackerConfig, wikiRoot = ""): StatusCategory {
  if (!status) return "unknown";
  if (Object.prototype.hasOwnProperty.call(config.statusMap, status)) return config.statusMap[status]!;
  const seen = JSON.stringify([wikiRoot, config.id, status]);
  if (!warnedStatuses.has(seen)) {
    warnedStatuses.add(seen);
    log.info("tracker {tracker} on {wiki}: status {status} is in no statusMap — shown as unknown", {
      tracker: config.id,
      wiki: wikiRoot,
      status,
    });
  }
  return "unknown";
}
