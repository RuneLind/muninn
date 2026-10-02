/**
 * The rail's issue mark: ONE ticket glyph per row, plus a count when the page
 * carries more than one key, at the right of the row's title element — beside
 * the clamped title text, never inside the clamp. The keys themselves live on
 * the hover and in the accessible name: two `PROJECT-1234` pills took a third
 * of a 300px rail. It stays inside `.wiki-list-title` so the row keeps its six
 * budgeted flex items (`wiki-rail-width.ts`; `e2e/wiki-rail-series.spec.ts`
 * pins the child count).
 *
 * Pure string building, in its own module because `wiki-browser.ts` touches
 * `document` at import time and `bun test` cannot load it.
 */

import { escHtml as esc } from "./escape.ts";
import type { ListingIssueRef } from "./wiki-filter.ts";
import type { IssueRelation } from "../../../wiki/trackers/types.ts";

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
 * A stamped key is the page's own claim and renders filled; every other
 * relation is inferred and renders as an outline. The strongest relation decides.
 */
export function issueRefInferred(ref: ListingIssueRef): boolean {
  return ref.relations[0] !== "stamped";
}

/** `Jira DEMO-104 — inferred (title)`, `… — stamped`, or `… — stamped (also
 *  title)`: every relation the key has, not only the strongest. */
function keyLine(ref: ListingIssueRef, label: string): string {
  const name = label ? `${label} ${ref.key}` : ref.key;
  if (issueRefInferred(ref)) return `${name} — inferred (${ref.relations.map(relationWord).join(", ")})`;
  const also = ref.relations.slice(1).map(relationWord);
  return also.length ? `${name} — stamped (also ${also.join(", ")})` : `${name} — stamped`;
}

/** A ticket in the type icon's stroke style. CSS fills it (`.tk`) for a
 *  stamped key, which hides the perforation, and leaves it open for an
 *  inferred one. */
const TICKET_GLYPH =
  `<svg class="wiki-issue-glyph" viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor"` +
  ` stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
  `<path class="tk" d="M1.5 4h11v1.8a1.3 1.3 0 0 0 0 2.4V10h-11V8.2a1.3 1.3 0 0 0 0-2.4z"/>` +
  `<path d="M9 4.3v5.4" stroke-dasharray="1.2 1.2"/></svg>`;

/**
 * The mark for one row, `""` when the page carries no issue. The refs arrive
 * strongest first, so the first one decides filled (stamped) or outline
 * (inferred) and names `data-issue-key`/`data-issue-rel`; `data-issue-keys`
 * lists them all. `labelOf` names a tracker id the way the UI calls it (`Jira`).
 */
export function railIssuePillsHtml(
  issues: readonly ListingIssueRef[] | undefined,
  labelOf: (trackerId: string) => string = () => "",
): string {
  if (!issues || issues.length === 0) return "";
  const first = issues[0]!;
  const titles = issues.map((r) => keyLine(r, labelOf(r.tracker)));
  const count = issues.length > 1 ? `<span class="wiki-issue-count">${issues.length}</span>` : "";
  return (
    `<span class="wiki-issue-pills"><span class="wiki-issue-pill${issueRefInferred(first) ? " inferred" : ""}" role="img"` +
    ` data-issue-key="${esc(first.key)}" data-issue-rel="${esc(first.relations[0] ?? "")}"` +
    ` data-issue-keys="${esc(issues.map((r) => r.key).join(" "))}"` +
    ` aria-label="${esc(titles.join("; "))}" title="${esc(titles.join("\n"))}">${TICKET_GLYPH}${count}</span></span>`
  );
}
