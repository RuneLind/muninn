/**
 * Lint check 28, `plan-not-folded`: a shipped plan that names no durable page
 * for its result (warning).
 *
 * A plan records work; a durable page says how the thing works now. At the flip
 * to `shipped` the plan's result is written into that page and the plan names
 * it in `folded_into:` (a list of wikilinks, or the bare word `none`). This
 * check finds a page under `plans/` with `plan_status: shipped`, a
 * `status_date` on or after the wiki's cutoff, and no `folded_into:` entry.
 *
 * The cutoff is `.wiki-reader.json` `foldCheck`: `{ "since": "YYYY-MM-DD" }`. A
 * wiki that declares none is not checked, and a plan shipped before the day is
 * left alone: mimir held 223 shipped plans on 2026-11-13, none with the key.
 * The check reads only whether the key names something; it does not resolve
 * the links (check 1 reads body links, not frontmatter).
 */

import { isCalendarDay } from "../format/calendar-day.ts";

export const FOLD_LINT_CHECKS = ["plan-not-folded"] as const;

export interface FoldCheckConfig {
  /** Plans whose `status_date` is before this day are not checked. */
  since: string;
}

/** `.wiki-reader.json` `foldCheck`. A malformed block warns and is null. */
export function parseFoldCheck(value: unknown): { config: FoldCheckConfig | null; warnings: string[] } {
  if (value === undefined) return { config: null, warnings: [] };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { config: null, warnings: ["must be an object {since} — ignoring it"] };
  const since = (value as Record<string, unknown>).since;
  if (typeof since === "string" && isCalendarDay(since)) return { config: { since }, warnings: [] };
  return { config: null, warnings: [`since ${JSON.stringify(since)} is not a YYYY-MM-DD day — ignoring the block`] };
}

const KEY_RE = /^folded_into[ \t]*:(.*)$/;
/** A line that starts a new top-level key: column 0, not a comment or a list item. */
const TOP_LEVEL_RE = /^[^\s#-]/;

/**
 * Whether the frontmatter's `folded_into:` names something: text after the
 * colon, or a line under the key before the next top-level key (a block list).
 * Read from the raw lines because `parseFrontmatter` returns no key for a bare
 * `folded_into:` or a block list.
 */
export function foldedIntoNamed(frontmatter: string | null): boolean {
  if (frontmatter === null) return false;
  const lines = frontmatter.split(/\r?\n/);
  const at = lines.findIndex((l) => KEY_RE.test(l));
  if (at === -1) return false;
  // An empty list or an empty string names nothing; a comment is not an entry.
  const entry = (text: string) => {
    const t = text.replace(/(^|\s)#.*$/, "").trim();
    return t !== "" && !/^(\[\s*\]|""|'')$/.test(t);
  };
  if (entry(KEY_RE.exec(lines[at]!)![1]!)) return true;
  for (let i = at + 1; i < lines.length && !TOP_LEVEL_RE.test(lines[i]!); i++) {
    if (entry(lines[i]!)) return true;
  }
  return false;
}

export interface FoldPage {
  relPath: string;
  plan_status?: string;
  status_date?: string;
}

/** The finding's message for a shipped plan in scope with no entry, else null. */
export function checkPlanFold(page: FoldPage, frontmatter: string | null, cfg: FoldCheckConfig): string | null {
  if (!page.relPath.startsWith("plans/") || page.plan_status !== "shipped") return null;
  // No date to hold against the cutoff: not judged.
  if (!page.status_date || page.status_date < cfg.since) return null;
  if (foldedIntoNamed(frontmatter)) return null;
  return "shipped plan names no durable page for its result — write the result into that page and add folded_into: with a link to it, or folded_into: none";
}
