/**
 * The rail's issue pills: up to two keys per row plus a `+N`, drawn INSIDE the
 * row's title element so the row keeps its six budgeted flex items
 * (`wiki-rail-width.ts`; `e2e/wiki-rail-series.spec.ts` pins the child count).
 *
 * Pure string building, in its own module because `wiki-browser.ts` touches
 * `document` at import time and `bun test` cannot load it.
 */

import { escHtml as esc } from "./escape.ts";
import type { ListingIssueRef } from "./wiki-filter.ts";

/** How many pills a row shows before the `+N`. */
export const RAIL_ISSUE_PILLS_MAX = 2;

/** What each relation is called on a hover. `created` reads "created here". */
const RELATION_WORDS: Readonly<Record<string, string>> = {
  stamped: "stamped",
  declared: "declared",
  created: "created here",
  title: "title",
  stem: "file name",
  link: "link",
  tag: "tag",
  mention: "mention",
};

export function relationWord(rel: string): string {
  return RELATION_WORDS[rel] ?? rel;
}

/**
 * A stamped key is the page's own claim and renders solid; every other
 * relation is inferred and renders dashed. The strongest relation decides.
 */
export function issueRefInferred(ref: ListingIssueRef): boolean {
  return ref.relations[0] !== "stamped";
}

function pillTitle(ref: ListingIssueRef): string {
  const how = ref.relations.map(relationWord).join(", ");
  return `${ref.key} — ${issueRefInferred(ref) ? "inferred: " : ""}${how}`;
}

/**
 * The pill run for one row, `""` when the page carries no issue. The refs
 * arrive strongest first, so the two shown are the page's strongest ties.
 */
export function railIssuePillsHtml(issues: readonly ListingIssueRef[] | undefined): string {
  if (!issues || issues.length === 0) return "";
  const shown = issues.slice(0, RAIL_ISSUE_PILLS_MAX);
  const rest = issues.slice(RAIL_ISSUE_PILLS_MAX);
  let html = "";
  for (const ref of shown) {
    html +=
      `<span class="wiki-issue-pill${issueRefInferred(ref) ? " inferred" : ""}"` +
      ` data-issue-key="${esc(ref.key)}" data-issue-rel="${esc(ref.relations[0] ?? "")}"` +
      ` title="${esc(pillTitle(ref))}">${esc(ref.key)}</span>`;
  }
  if (rest.length) {
    html +=
      `<span class="wiki-issue-pill more" title="${esc(rest.map(pillTitle).join("\n"))}">+${rest.length}</span>`;
  }
  return `<span class="wiki-issue-pills">${html}</span>`;
}
