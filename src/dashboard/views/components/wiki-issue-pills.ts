/**
 * The rail's issue pills: up to two keys per row plus a `+N`, in a column of
 * their own at the right of the row's title element — beside the clamped title
 * text, never inside the clamp, so a two-line title cannot push them out of
 * sight. They stay inside `.wiki-list-title` so the row keeps its six budgeted
 * flex items (`wiki-rail-width.ts`; `e2e/wiki-rail-series.spec.ts` pins the
 * child count).
 *
 * Pure string building, in its own module because `wiki-browser.ts` touches
 * `document` at import time and `bun test` cannot load it.
 */

import { escHtml as esc } from "./escape.ts";
import type { ListingIssueRef } from "./wiki-filter.ts";
import type { IssueRelation } from "../../../wiki/trackers/types.ts";

/** How many pills a row shows before the `+N`. */
export const RAIL_ISSUE_PILLS_MAX = 2;

/** What each relation is called on a hover. `created` reads "created here". */
const RELATION_WORDS: Readonly<Record<IssueRelation, string>> = {
  stamped: "stamped",
  declared: "declared",
  created: "created here",
  title: "title",
  stem: "file name",
  link: "link",
  tag: "tag",
  mention: "mention",
};

export function relationWord(rel: IssueRelation): string {
  return RELATION_WORDS[rel] ?? rel;
}

/**
 * A stamped key is the page's own claim and renders solid; every other
 * relation is inferred and renders dashed. The strongest relation decides.
 */
export function issueRefInferred(ref: ListingIssueRef): boolean {
  return ref.relations[0] !== "stamped";
}

/** `Jira DEMO-104 — inferred (title)`, `… — stamped`, or `… — stamped (also
 *  title)`: every relation the key has, not only the strongest. */
function pillTitle(ref: ListingIssueRef, label: string): string {
  const name = label ? `${label} ${ref.key}` : ref.key;
  if (issueRefInferred(ref)) return `${name} — inferred (${ref.relations.map(relationWord).join(", ")})`;
  const also = ref.relations.slice(1).map(relationWord);
  return also.length ? `${name} — stamped (also ${also.join(", ")})` : `${name} — stamped`;
}

/**
 * A key with one break opportunity, after its project's `-`: a title cell
 * narrower than the whole key (a long project name at the title's floor) wraps
 * the pill there instead of pushing it out of the cell. Nowhere else — a line
 * break never falls inside the number.
 */
function keyHtml(key: string): string {
  const cut = key.indexOf("-") + 1;
  return cut > 0 ? `${esc(key.slice(0, cut))}<wbr>${esc(key.slice(cut))}` : esc(key);
}

/**
 * The pill column for one row, `""` when the page carries no issue. The refs
 * arrive strongest first, so the two shown are the page's strongest ties.
 * `labelOf` names a tracker id the way the UI calls it (`Jira`).
 */
export function railIssuePillsHtml(
  issues: readonly ListingIssueRef[] | undefined,
  labelOf: (trackerId: string) => string = () => "",
): string {
  if (!issues || issues.length === 0) return "";
  const shown = issues.slice(0, RAIL_ISSUE_PILLS_MAX);
  const rest = issues.slice(RAIL_ISSUE_PILLS_MAX);
  let html = "";
  for (const ref of shown) {
    html +=
      `<span class="wiki-issue-pill${issueRefInferred(ref) ? " inferred" : ""}"` +
      ` data-issue-key="${esc(ref.key)}" data-issue-rel="${esc(ref.relations[0] ?? "")}"` +
      ` title="${esc(pillTitle(ref, labelOf(ref.tracker)))}">${keyHtml(ref.key)}</span>`;
  }
  if (rest.length) {
    const titles = rest.map((r) => pillTitle(r, labelOf(r.tracker)));
    // The hidden keys are in the ACCESSIBLE NAME too, not only on a hover a
    // keyboard or screen-reader user never triggers.
    html +=
      `<span class="wiki-issue-pill more" role="img"` +
      ` aria-label="${esc(`${rest.length} more: ${titles.join("; ")}`)}"` +
      ` title="${esc(titles.join("\n"))}">+${rest.length}</span>`;
  }
  return `<span class="wiki-issue-pills">${html}</span>`;
}
