/**
 * The tracker registry: which adapters exist, how a wiki's `trackers` block in
 * `.wiki-reader.json` is validated, and the one call the store makes per page.
 *
 * ```json
 * "trackers": [
 *   { "id": "jira", "projects": ["DEMO"], "hosts": ["example.invalid"],
 *     "frontmatterKeys": ["issue"], "planTitle": "plan(er|en)?(?!\\p{L})",
 *     "planTitleExclude": "testplan", "createdMarkers": ["created"],
 *     "statusMap": { "Ferdig": "done" } }
 * ]
 * ```
 *
 * Validation follows the rule every other block in that file follows: a bad
 * field warns and is dropped, and discovery never aborts. An entry is dropped
 * WHOLE only when it names no known adapter or no usable project, because
 * `projects` is what bounds every inferred key — without it the entry could
 * only guess. A wiki with no usable entry has no tracker, which is today's
 * behaviour byte for byte.
 */

import { jiraAdapter } from "./jira.ts";
import {
  STATUS_CATEGORIES,
  type IssueRef,
  type StatusCategory,
  type TrackerAdapter,
  type TrackerConfig,
  type TrackerPage,
} from "./types.ts";

export type { IssueRef, IssueRelation, StatusCategory, TrackerAdapter, TrackerConfig, TrackerPage } from "./types.ts";
export { RELATION_STRENGTH, STATUS_CATEGORIES } from "./types.ts";

/** Every adapter muninn ships, by id. A second tracker adds a file and a line. */
export const TRACKER_ADAPTERS: Readonly<Record<string, TrackerAdapter>> = Object.freeze({
  [jiraAdapter.id]: jiraAdapter,
});

export function trackerAdapter(id: string): TrackerAdapter | undefined {
  return Object.prototype.hasOwnProperty.call(TRACKER_ADAPTERS, id) ? TRACKER_ADAPTERS[id] : undefined;
}

/** How a parse reports a dropped field: a sentence and the entry it is about. */
export type TrackerConfigWarn = (message: string, index: number) => void;

const PROJECT_RE = /^[A-Z][A-Z0-9]*$/;

function stringList(v: unknown): string[] | null {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) return null;
  return (v as string[]).map((s) => s.trim()).filter((s) => s.length > 0);
}

function compileRe(v: unknown, field: string, i: number, warn: TrackerConfigWarn): RegExp | null {
  if (v === undefined) return null;
  if (typeof v !== "string" || !v.trim()) {
    warn(`${field} is not a non-empty string — ignoring it`, i);
    return null;
  }
  try {
    return new RegExp(v, "iu");
  } catch (err) {
    warn(`${field} is not a valid regular expression (${err instanceof Error ? err.message : String(err)}) — ignoring it`, i);
    return null;
  }
}

/**
 * Validate a `trackers` value. Absent ⇒ `[]` with no warning; anything that is
 * not an array ⇒ `[]` with one.
 */
export function parseTrackersConfig(raw: unknown, warn: TrackerConfigWarn): TrackerConfig[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warn("trackers is not an array — ignoring it", -1);
    return [];
  }
  const out: TrackerConfig[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      warn("entry is not an object — dropping it", i);
      return;
    }
    const o = entry as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    const adapter = trackerAdapter(id);
    if (!adapter) {
      warn(`id ${JSON.stringify(o.id)} names no known tracker — dropping the entry`, i);
      return;
    }
    if (seen.has(id)) {
      warn(`a second "${id}" entry — dropping it`, i);
      return;
    }
    const projectsRaw = stringList(o.projects);
    const projects = (projectsRaw ?? []).map((p) => p.toUpperCase()).filter((p) => {
      if (PROJECT_RE.test(p)) return true;
      warn(`project ${JSON.stringify(p)} is not a key prefix — dropping it`, i);
      return false;
    });
    if (projects.length === 0) {
      warn("projects names no usable key prefix, and every inferred key is bounded by it — dropping the entry", i);
      return;
    }
    const list = (field: string): string[] => {
      if (o[field] === undefined) return [];
      const v = stringList(o[field]);
      if (v === null) {
        warn(`${field} is not an array of strings — ignoring it`, i);
        return [];
      }
      return v;
    };
    const statusMap: Record<string, StatusCategory> = { ...adapter.defaultStatusMap };
    if (o.statusMap !== undefined) {
      if (!o.statusMap || typeof o.statusMap !== "object" || Array.isArray(o.statusMap)) {
        warn("statusMap is not an object — using the tracker's defaults", i);
      } else {
        for (const [status, cat] of Object.entries(o.statusMap as Record<string, unknown>)) {
          if (typeof cat === "string" && (STATUS_CATEGORIES as readonly string[]).includes(cat)) {
            statusMap[status] = cat as StatusCategory;
          } else {
            warn(`statusMap ${JSON.stringify(status)} maps to ${JSON.stringify(cat)}, not one of ${STATUS_CATEGORIES.join("/")} — dropping it`, i);
          }
        }
      }
    }
    seen.add(id);
    out.push({
      id,
      projects: [...new Set(projects)],
      hosts: list("hosts").map((h) => h.toLowerCase()),
      frontmatterKeys: list("frontmatterKeys"),
      planTitle: compileRe(o.planTitle, "planTitle", i, warn),
      planTitleExclude: compileRe(o.planTitleExclude, "planTitleExclude", i, warn),
      createdMarkers: list("createdMarkers"),
      statusMap,
    });
  });
  return out;
}

/**
 * Every issue ref a page carries across the wiki's trackers, or `undefined` —
 * never `[]` — when it carries none.
 */
export function inferIssues(page: TrackerPage, trackers: readonly TrackerConfig[]): IssueRef[] | undefined {
  const out: IssueRef[] = [];
  for (const config of trackers) {
    const adapter = trackerAdapter(config.id);
    if (adapter) out.push(...adapter.inferFrom(page, config));
  }
  return out.length ? out : undefined;
}

/**
 * A page's refs as the HOT listing ships them: `mention` dropped, and a ref
 * left with no relation dropped with it. Undefined when nothing is left, so the
 * field stays absent rather than `[]`. The rail's pills and the Jira facet read
 * this copy; a mention is neither.
 */
export function compactIssues(issues: readonly IssueRef[] | undefined): IssueRef[] | undefined {
  if (!issues) return undefined;
  const out: IssueRef[] = [];
  for (const r of issues) {
    const relations = r.relations.filter((rel) => rel !== "mention");
    if (relations.length) out.push({ tracker: r.tracker, key: r.key, relations });
  }
  return out.length ? out : undefined;
}

/** Does this title read as a plan under this tracker's config? */
export function isPlanTitle(title: string, config: TrackerConfig): boolean {
  if (!config.planTitle || !config.planTitle.test(title)) return false;
  return !(config.planTitleExclude && config.planTitleExclude.test(title));
}
