/// <reference lib="dom" />
/**
 * The page list's and the article header's shared row markers: the
 * `plan_status` pill and the open-follow-ups flag. A leaf both the shell
 * (`wiki-browser.ts`) and the rail (`wiki-rail-controller.ts`) import; importing
 * it runs nothing.
 */
import { escHtml as esc } from "./escape.ts";
import { pageFollowups, type WikiListing } from "./wiki-filter.ts";

/** A colored `plan_status` pill — the ONE spelling shared by the page list and the
 *  article header, so the two never drift. Empty string for a page without one. */
export function statusPillHtml(p: WikiListing): string {
  if (!p.plan_status) return "";
  // `status_note` arrives UNESCAPED from the server (free prose, no validator) —
  // esc() before it reaches this attribute sink.
  const note = [p.status_date, p.status_note].filter(Boolean).join(" — ");
  const title = note ? ` title="${esc(note)}"` : "";
  return `<span class="wiki-status plan-${esc(p.plan_status)}"${title}>${esc(p.plan_status)}</span>`;
}

/** The open-follow-ups marker — deliberately separate from the status pill so the
 *  two axes stay distinguishable, and independent of `plan_status` (a page can
 *  declare follow-ups without a status). */
export function followupFlagHtml(p: WikiListing): string {
  return pageFollowups(p) === "open"
    ? '<span class="wiki-followup-flag" title="has open follow-ups">⚑</span>'
    : "";
}
