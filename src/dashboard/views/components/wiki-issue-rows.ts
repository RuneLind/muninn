/**
 * Connections' issue section: one row per key the open page counts toward,
 * then an "also linked" line (link-only keys) and a "mentioned" line. Pure
 * string building, in its own module because `wiki-browser.ts` touches
 * `document` at import time and `bun test` cannot load it.
 *
 * The rows arrive twice — the index-local half inline with the page, then the
 * whole row from the deferred provenance fetch — and this renders either: a
 * field the first half lacks simply renders nothing yet.
 */

import { escHtml as esc } from "./escape.ts";
import { relationWord } from "./wiki-issue-pills.ts";
import {
  LINK_ALL_RELATIONS,
  relationsCount,
  type IssueLedgerView,
  type IssueRow,
} from "../../../wiki/trackers/types.ts";

/** The section's id — the one writer replaces it in place. */
export const CONN_ISSUES_ID = "wikiConnIssues";
/** A row's Link button carries its key here; Link all carries the flag. */
export const ISSUE_LINK_ATTR = "data-issue-link";
export const ISSUE_LINK_ALL_ATTR = "data-issue-link-all";
/** Draft plan carries its key; the chat dialog's delegate opens on it. */
export const DRAFT_PLAN_ATTR = "data-draft-plan";

/** What a row shows beside its buttons after a Link attempt. */
export type IssueRowState = { kind: "busy" } | { kind: "refused"; reason: string } | { kind: "error"; text: string };

export interface IssueSectionOptions {
  /** The tracker's UI label (`Jira`), by tracker id. */
  labelOf: (trackerId: string) => string;
  /** The deferred payload said this instance may write this page. */
  stampable: boolean;
  /** The open page is markdown — an `.html` page gets rows but no Link. */
  markdown: boolean;
  /** The open page's relPath, so a plan that IS this page says so. */
  relPath: string;
  /** Per-key Link state, from the last attempt. */
  states?: ReadonlyMap<string, IssueRowState>;
  /** The Discuss dialog can open here (false on a read-only wiki, which seeds
   *  no chat) — gates Draft plan. Default true. */
  discuss?: boolean;
  /** A Link or Link all on this page is in flight: every Link control renders
   *  disabled, so two POSTs never race for one `jira:` line. */
  locked?: boolean;
}

const isStamped = (r: IssueRow) => r.relations.includes("stamped");
const isLocked = (opts: IssueSectionOptions) =>
  opts.locked === true || [...(opts.states?.values() ?? [])].some((s) => s.kind === "busy");

/** May this row be Linked one at a time? Not stamped already, and the page
 *  can be written. A mention is not offered (see `issueSectionHtml`). */
export function linkOffered(row: IssueRow, opts: Pick<IssueSectionOptions, "stampable" | "markdown">): boolean {
  return opts.stampable && opts.markdown && !isStamped(row) && !row.relations.every((r) => r === "mention");
}

/** The keys **Link all** writes: counting, not yet stamped, and tied by a
 *  relation that already counts toward coverage (so Link all never changes a
 *  coverage verdict). Each of those relations is project-bounded upstream. */
export function linkAllKeys(rows: readonly IssueRow[], opts: Pick<IssueSectionOptions, "stampable" | "markdown">): string[] {
  if (!opts.stampable || !opts.markdown) return [];
  return rows
    .filter(
      (r) =>
        !isStamped(r) &&
        relationsCount(r.relations) &&
        r.relations.some((rel) => (LINK_ALL_RELATIONS as readonly string[]).includes(rel)),
    )
    .map((r) => r.key);
}

/** Draft plan: an uncovered counting key whose status says work is ahead. */
export function draftPlanOffered(row: IssueRow): boolean {
  return (
    relationsCount(row.relations) &&
    row.planPages.length === 0 &&
    (row.category === "todo" || row.category === "active")
  );
}

/** The ledger's figure as one phrase, or `""` when there is nothing to say. */
export function ledgerLabel(l: IssueLedgerView | undefined): string {
  if (!l) return "";
  if (l.state === "priced") {
    const n = l.truncated ? `${l.sessions}+` : String(l.sessions);
    const noun = l.sessions === 1 && !l.truncated ? "session mentions" : "sessions mention";
    return `${n} ${noun} it · $${l.totalCost.toFixed(2)}`;
  }
  if (l.state === "not-tracked") return "not tracked";
  switch (l.reason) {
    case "cap":
      return "cost not read";
    case "deadline":
      return "cost not read (timed out)";
    case "unreachable":
      return "cost unavailable";
    default:
      return "";
  }
}

function ledgerTitle(l: IssueLedgerView | undefined): string {
  if (!l) return "";
  if (l.state === "not-tracked") return "the session ledger records mentions only for some projects, not this one";
  if (l.state === "unpriced" && l.reason === "cap") return "only the page's first keys are priced";
  if (l.state === "priced") return "every session that mentions the key, at its full cost — a session mentioning several keys counts under each";
  return "";
}

/** The refusal sentence for a Link the stamper skipped. */
export function linkRefusalHtml(reason: string, field: string): string {
  const f = `<code>${esc(field)}:</code>`;
  switch (reason) {
    case "not-inline-list":
      return `the ${f} line is not an inline <code>[...]</code> list; edit it by hand`;
    case "duplicate-key":
      return `the page has two ${f} lines; edit it by hand`;
    case "skip-list":
      return "this page is on the stamper's skip list";
    default:
      return `not linked: ${esc(reason)}`;
  }
}

function statusHtml(row: IssueRow, label: string): string {
  if (!row.category) return "";
  const when = row.updated ? row.updated.slice(0, 10) : "";
  const title = when
    ? `${label} last updated ${when}, as of huginn's last capture`
    : `as of huginn's last capture`;
  if (row.known === false) {
    return `<span class="wiki-issue-status cat-unknown" title="${esc(`huginn holds no ${label} issue with this key`)}">not in huginn</span>`;
  }
  const text = row.status || "no status";
  return `<span class="wiki-issue-status cat-${esc(row.category)}" data-status-cat="${esc(row.category)}" title="${esc(title)}">${esc(text)}</span>`;
}

function coverHtml(row: IssueRow, relPath: string): string {
  if (!row.planPages.length) return `<span class="wiki-issue-cover none">no plan</span>`;
  const [first, ...rest] = row.planPages;
  const more = rest.length ? ` <span class="wiki-issue-more" title="${esc(rest.map((p) => p.title).join("\n"))}">+${rest.length}</span>` : "";
  if (first!.relPath === relPath) return `<span class="wiki-issue-cover covered">this page is the plan</span>${more}`;
  return (
    `<span class="wiki-issue-cover covered">plan: <a class="wiki-issue-plan" href="#" data-relpath="${esc(first!.relPath)}">` +
    `${esc(first!.title)}</a></span>${more}`
  );
}

function stateHtml(state: IssueRowState | undefined, field: string): string {
  if (!state) return `<span class="wiki-issue-msg" hidden></span>`;
  if (state.kind === "busy") return `<span class="wiki-issue-msg">linking…</span>`;
  const text = state.kind === "refused" ? linkRefusalHtml(state.reason, field) : esc(state.text);
  return `<span class="wiki-issue-msg err" data-issue-state="${esc(state.kind === "refused" ? state.reason : "error")}">${text}</span>`;
}

function linkButton(row: IssueRow, state: IssueRowState | undefined, locked: boolean): string {
  const busy = locked || state?.kind === "busy";
  return (
    `<button type="button" class="wiki-issue-btn" ${ISSUE_LINK_ATTR}="${esc(row.key)}"` +
    ` data-issue-tracker="${esc(row.tracker)}"${busy ? " disabled" : ""}` +
    ` title="${esc(`Write ${row.key} to this page's ${row.field}: line`)}">Link</button>`
  );
}

function rowHtml(row: IssueRow, opts: IssueSectionOptions): string {
  const label = opts.labelOf(row.tracker);
  const state = opts.states?.get(row.key);
  const rel = row.relations[0]!;
  const rels = row.relations.map(relationWord).join(", ");
  const key = row.url
    ? `<a class="wiki-issue-key" href="${esc(row.url)}" target="_blank" rel="noopener" title="${esc(`Open ${row.key} in ${label}`)}">${esc(row.key)}</a>`
    : `<span class="wiki-issue-key">${esc(row.key)}</span>`;
  const ledger = ledgerLabel(row.ledger);
  const meta = [
    coverHtml(row, opts.relPath),
    ledger ? `<span class="wiki-issue-ledger" title="${esc(ledgerTitle(row.ledger))}">${esc(ledger)}</span>` : "",
    row.pageCount > 1 ? `<span class="wiki-issue-pages">${row.pageCount} pages</span>` : "",
  ].filter(Boolean);
  const actions: string[] = [];
  if (opts.discuss !== false && draftPlanOffered(row)) {
    actions.push(
      `<button type="button" class="wiki-issue-btn" ${DRAFT_PLAN_ATTR}="${esc(row.key)}"` +
        ` title="${esc(`Discuss this page with a starter question to draft a plan for ${row.key}`)}">Draft plan</button>`,
    );
  }
  if (linkOffered(row, opts)) actions.push(linkButton(row, state, isLocked(opts)));
  return (
    `<div class="wiki-issue-row${isStamped(row) ? " stamped" : " inferred"}" data-issue-row="${esc(row.key)}">` +
    `<div class="wiki-issue-head">${key}` +
    `<span class="wiki-issue-rel" data-issue-rel="${esc(rel)}" title="${esc(isStamped(row) ? `stamped${row.relations.length > 1 ? ` (also ${row.relations.slice(1).map(relationWord).join(", ")})` : ""}` : `inferred: ${rels}`)}">${esc(relationWord(rel))}</span>` +
    statusHtml(row, label) +
    `</div>` +
    (row.title ? `<div class="wiki-issue-title">${esc(row.title)}</div>` : "") +
    (row.epic ? `<div class="wiki-issue-epic" title="${esc(row.epic.summary ?? "")}">epic ${esc(row.epic.key)}${row.epic.summary ? ` — ${esc(row.epic.summary)}` : ""}</div>` : "") +
    `<div class="wiki-issue-meta">${meta.join('<span class="wiki-issue-sep"> · </span>')}</div>` +
    (actions.length || state ? `<div class="wiki-issue-actions">${actions.join("")}${stateHtml(state, row.field)}</div>` : "") +
    `</div>`
  );
}

/** A demoted key on the "also linked" line, with its own Link to promote it. */
function alsoHtml(row: IssueRow, opts: IssueSectionOptions): string {
  const state = opts.states?.get(row.key);
  const key = row.url
    ? `<a class="wiki-issue-key" href="${esc(row.url)}" target="_blank" rel="noopener">${esc(row.key)}</a>`
    : `<span class="wiki-issue-key">${esc(row.key)}</span>`;
  const link = linkOffered(row, opts) ? linkButton(row, state, isLocked(opts)) : "";
  return `<span class="wiki-issue-also-item" data-issue-row="${esc(row.key)}">${key}${link}${state ? stateHtml(state, row.field) : ""}</span>`;
}

/**
 * The whole section, or `""` for a page with no rows. Counting keys are rows;
 * link-only keys go on "also linked", each with a Link that promotes it (a
 * deliberate claim that the page serves the key, which then counts toward
 * coverage); mention-only keys go on "mentioned" with no Link — a bare
 * mention is the weakest tie and not one to write with a click.
 */
export function issueSectionHtml(rows: readonly IssueRow[] | undefined, opts: IssueSectionOptions): string {
  if (!rows?.length) return "";
  const counting = rows.filter((r) => relationsCount(r.relations));
  const linkOnly = rows.filter((r) => !relationsCount(r.relations) && r.relations.includes("link"));
  const mentions = rows.filter((r) => !relationsCount(r.relations) && !r.relations.includes("link"));
  const label = opts.labelOf(rows[0]!.tracker) || "Issues";
  const all = linkAllKeys(counting, opts);
  const busy = isLocked(opts);
  // `tabindex="-1"`: while every Link is disabled, focus waits on the section
  // itself rather than falling to <body>.
  let html =
    `<div class="wiki-conn-section wiki-conn-issues" id="${CONN_ISSUES_ID}" tabindex="-1">` +
    `<div class="wiki-conn-title">${esc(label)} (${counting.length})` +
    (all.length > 1
      ? ` <button type="button" class="wiki-issue-btn wiki-issue-linkall" ${ISSUE_LINK_ALL_ATTR}="1"${busy ? " disabled" : ""}` +
        ` title="${esc(`Write ${all.join(", ")} to this page`)}">Link all (${all.length})</button>`
      : "") +
    `</div>`;
  if (!counting.length) html += `<div class="wiki-conn-empty">None counted</div>`;
  for (const row of counting) html += rowHtml(row, opts);
  if (linkOnly.length) {
    html += `<div class="wiki-issue-also"><span class="wiki-issue-line-label">also linked:</span> ${linkOnly.map((r) => alsoHtml(r, opts)).join(" ")}</div>`;
  }
  if (mentions.length) {
    html +=
      `<div class="wiki-issue-mentions"><span class="wiki-issue-line-label">mentioned:</span> ` +
      mentions.map((r) => `<span class="wiki-issue-mention" data-issue-row="${esc(r.key)}">${esc(r.key)}</span>`).join(", ") +
      `</div>`;
  }
  return html + `</div>`;
}
