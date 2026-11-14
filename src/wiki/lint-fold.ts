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
 * left alone: mimir held 222 shipped plans on 2026-11-14, none with the key.
 * The check reads only whether the key names something; it does not resolve
 * the links (check 1 reads body links, not frontmatter).
 */

import { isCalendarDay } from "../format/calendar-day.ts";
import { readLinkList } from "./frontmatter-lists.ts";

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

/** The key's own line, bare or quoted. */
const KEY_RE = /^(["']?)folded_into\1\s*:/;

/**
 * Whether the page's `folded_into:` names something. The key is read by the
 * reader `related:` has (`readLinkList`, `frontmatter-lists.ts`), so it takes
 * every form pages write there. It names something when that read holds a
 * link or a text entry (`none`, a path); an entry the reader cannot place (a
 * number, a boolean, a mapping without a link) names nothing, and neither do
 * a bare key, `null`, an empty list or empty strings.
 */
export function foldedIntoNamed(content: string): boolean {
  return readLinkList(content, "folded_into", KEY_RE).entries.some((e) => e.kind !== "unread");
}

export interface FoldPage {
  relPath: string;
  plan_status?: string;
  status_date?: string;
}

/** The finding's message for a shipped plan in scope with no entry, else null. */
export function checkPlanFold(page: FoldPage, content: string, cfg: FoldCheckConfig): string | null {
  if (!page.relPath.startsWith("plans/") || page.plan_status !== "shipped") return null;
  // No date to hold against the cutoff: not judged.
  if (!page.status_date || page.status_date < cfg.since) return null;
  if (foldedIntoNamed(content)) return null;
  return "shipped plan names no durable page for its result — write the result into that page and add folded_into: with a link to it, or folded_into: none";
}
