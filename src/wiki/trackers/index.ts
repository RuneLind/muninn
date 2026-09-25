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
  relationsCount,
  STATUS_CATEGORIES,
  type IssueRef,
  type StatusCategory,
  type TrackerAdapter,
  type TrackerConfig,
  type TrackerPage,
} from "./types.ts";

export type { IssueRef, IssueRelation, StatusCategory, TrackerAdapter, TrackerConfig, TrackerPage } from "./types.ts";
export { DEMOTED_RELATIONS, RELATION_STRENGTH, relationsCount, STATUS_CATEGORIES } from "./types.ts";

/** Every adapter muninn ships, by id. A second tracker adds a file and a line. */
export const TRACKER_ADAPTERS: Readonly<Record<string, TrackerAdapter>> = Object.freeze({
  [jiraAdapter.id]: jiraAdapter,
});

export function trackerAdapter(id: string): TrackerAdapter | undefined {
  return Object.prototype.hasOwnProperty.call(TRACKER_ADAPTERS, id) ? TRACKER_ADAPTERS[id] : undefined;
}

/**
 * How a parse reports a dropped field: the config KEY it is about
 * (`trackers[0].projects`) and the reason, kept apart so the log sink can group
 * a wiki's warnings by cause (the `activity` block's convention in `store.ts`).
 */
export type TrackerConfigWarn = (warning: { key: string; reason: string }) => void;

/** A project prefix: `JIRA_KEY_SOURCE`'s prefix shape, 2–16 characters, so a
 *  configured project is one the mention scanner can also find. */
const PROJECT_RE = /^[A-Z][A-Z0-9]{1,15}$/;
/** A bare hostname, optionally with a port — what a `browse/` link's host is
 *  compared against. A URL or a path never matches one, so it is refused. */
const HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::[0-9]{1,5})?$/;

function compileRe(v: unknown, key: string, warn: TrackerConfigWarn): RegExp | null {
  if (v === undefined) return null;
  if (typeof v !== "string" || !v.trim()) {
    warn({ key, reason: "is not a non-empty string — ignoring it" });
    return null;
  }
  try {
    return new RegExp(v, "iu");
  } catch (err) {
    warn({ key, reason: `is not a valid regular expression (${err instanceof Error ? err.message : String(err)}) — ignoring it` });
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
    warn({ key: "trackers", reason: "is not an array — ignoring it" });
    return [];
  }
  const out: TrackerConfig[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, i) => {
    const at = (field?: string) => `trackers[${i}]${field ? "." + field : ""}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      warn({ key: at(), reason: "is not an object — dropping it" });
      return;
    }
    const o = entry as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    const adapter = trackerAdapter(id);
    if (!adapter) {
      warn({ key: at("id"), reason: `${JSON.stringify(o.id)} names no known tracker — dropping the entry` });
      return;
    }
    if (seen.has(id)) {
      warn({ key: at(), reason: `is a second "${id}" entry — dropping it` });
      return;
    }
    /** An array field, element by element: a bad element warns and drops alone. */
    const list = (field: string, accept: (s: string) => boolean = () => true, what = "a string"): string[] => {
      const v = o[field];
      if (v === undefined) return [];
      if (!Array.isArray(v)) {
        warn({ key: at(field), reason: `is not an array (write ${JSON.stringify([typeof v === "string" ? v : "…"])}) — ignoring it` });
        return [];
      }
      const kept: string[] = [];
      v.forEach((x, j) => {
        const s = typeof x === "string" ? x.trim() : "";
        if (typeof x === "string" && s === "") return;
        if (typeof x !== "string" || !accept(s)) {
          warn({ key: `${at(field)}[${j}]`, reason: `${JSON.stringify(x)} is not ${what} — dropping it` });
          return;
        }
        kept.push(s);
      });
      return kept;
    };
    const projects = list("projects", (s) => PROJECT_RE.test(s.toUpperCase()), "a key prefix").map((p) =>
      p.toUpperCase(),
    );
    if (projects.length === 0) {
      warn({
        key: at("projects"),
        reason: "names no usable key prefix, and every inferred key is bounded by it — dropping the entry",
      });
      return;
    }
    const statusMap: Record<string, StatusCategory> = { ...adapter.defaultStatusMap };
    if (o.statusMap !== undefined) {
      if (!o.statusMap || typeof o.statusMap !== "object" || Array.isArray(o.statusMap)) {
        warn({ key: at("statusMap"), reason: "is not an object — using the tracker's defaults" });
      } else {
        for (const [status, cat] of Object.entries(o.statusMap as Record<string, unknown>)) {
          if (typeof cat === "string" && (STATUS_CATEGORIES as readonly string[]).includes(cat)) {
            statusMap[status] = cat as StatusCategory;
          } else {
            warn({
              key: `${at("statusMap")}.${status}`,
              reason: `maps to ${JSON.stringify(cat)}, not one of ${STATUS_CATEGORIES.join("/")} — dropping it`,
            });
          }
        }
      }
    }
    seen.add(id);
    out.push({
      id,
      projects: [...new Set(projects)],
      hosts: list("hosts", (s) => HOST_RE.test(s.toLowerCase()), "a bare hostname (optionally :port)").map((h) =>
        h.toLowerCase(),
      ),
      frontmatterKeys: list("frontmatterKeys"),
      planTitle: compileRe(o.planTitle, at("planTitle"), warn),
      planTitleExclude: compileRe(o.planTitleExclude, at("planTitleExclude"), warn),
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
 * A page's refs as the HOT listing ships them: only a ref that COUNTS
 * (`relationsCount` — something besides `link` and `mention`), with its
 * `mention` relation dropped. Undefined when nothing is left, so the field
 * stays absent rather than `[]`. The rail's pills and the Jira facet read this
 * copy; a link-only or mention-only key is neither.
 */
export function compactIssues(issues: readonly IssueRef[] | undefined): IssueRef[] | undefined {
  if (!issues) return undefined;
  const out: IssueRef[] = [];
  for (const r of issues) {
    if (!relationsCount(r.relations)) continue;
    out.push({ tracker: r.tracker, key: r.key, relations: r.relations.filter((rel) => rel !== "mention") });
  }
  return out.length ? out : undefined;
}

/** Does this title read as a plan under this tracker's config? */
export function isPlanTitle(title: string, config: TrackerConfig): boolean {
  if (!config.planTitle || !config.planTitle.test(title)) return false;
  return !(config.planTitleExclude && config.planTitleExclude.test(title));
}
