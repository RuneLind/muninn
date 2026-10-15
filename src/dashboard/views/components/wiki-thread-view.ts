/**
 * The work-thread card's markup (plan `muninn-wiki-work-threads`, PR 5): the
 * header (name, sessions and span, ✋, 📌) and the `touched:` line. Pure string
 * building, in its own module because `wiki-browser.ts` touches `document` at
 * import time and `bun test` cannot load it (the `wiki-related-view.ts` split).
 * The focus rows are ordinary rail rows, painted by `renderList`.
 */

import { escHtml as esc } from "./escape.ts";
import { displayTitleOf, localDay, type WikiListing } from "./wiki-filter.ts";
import type { RailThreadCard } from "./wiki-recents.ts";

const DAY_MS = 86_400_000;

/** One instant as a card shows it, in the viewer's zone: `today 08:01`,
 *  `yesterday 21:26`, else `mon 12.10 15:04`. */
export function threadInstantLabel(ms: number, now: number): string {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const day = localDay(d);
  if (day === localDay(new Date(now))) return `today ${hm}`;
  if (day === localDay(new Date(now - DAY_MS))) return `yesterday ${hm}`;
  const wd = d.toLocaleDateString("en-GB", { weekday: "short" }).toLowerCase();
  return `${wd} ${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")} ${hm}`;
}

/** `first → last` over a card's sessions, or "" with none. */
export function threadSpanLabel(card: Pick<RailThreadCard, "sessions">, now: number): string {
  if (!card.sessions.length) return "";
  const first = Math.min(...card.sessions.map((s) => s.first));
  const last = Math.max(...card.sessions.map((s) => s.last));
  return `${threadInstantLabel(first, now)} → ${threadInstantLabel(last, now)}`;
}

/** The header's second line: `N sessions · first → last · ✋ M`. */
export function threadMetaLine(card: RailThreadCard, now: number, showMoves: boolean): string {
  const n = card.sessions.length;
  const parts = [`${n} ${n === 1 ? "session" : "sessions"}`];
  const span = threadSpanLabel(card, now);
  if (span) parts.push(span);
  if (showMoves && card.movesYou > 0) parts.push(`✋ ${card.movesYou}`);
  return parts.join(" · ");
}

/** The header's hover: the name, then one line per session (newest first). */
export function threadHover(card: RailThreadCard, now: number): string {
  const lines = [card.name + (card.pinned ? " (pinned first)" : "")];
  for (const s of card.sessions) {
    const span = `${threadInstantLabel(s.first, now)} → ${threadInstantLabel(s.last, now)}`;
    lines.push(`• ${s.title || s.id}${s.provider ? ` (${s.provider})` : ""}, ${span}`);
  }
  return lines.join("\n");
}

/** The card header: a fold button and the 📌 beside it (two sibling buttons —
 *  a button may not hold one). The fold writes `toggleKey`, so the generic
 *  `[data-fold-key]` handler toggles a card like any group. */
export function threadCardHeaderHtml(
  card: RailThreadCard,
  folded: boolean,
  now: number,
  showMoves: boolean,
): string {
  const hover = threadHover(card, now);
  const why = folded ? "Show this work thread" : "Hide this work thread";
  const pinLabel = card.pinned ? "Unpin this work thread" : "Pin this work thread first";
  return (
    `<div class="wiki-thread-card${folded ? "" : " open"}${card.pinned ? " pinned" : ""}" data-section="threads" data-thread="${esc(card.foldKey)}">` +
    `<button type="button" class="wiki-thread-fold${folded ? " folded" : ""}"` +
    ` data-fold-key="${esc(card.toggleKey)}" aria-expanded="${folded ? "false" : "true"}"` +
    ` aria-label="${esc(card.name + " · " + why)}" title="${esc(hover + "\n" + why)}">` +
    `<span class="wiki-fold-caret" aria-hidden="true">▸</span>` +
    `<span class="wiki-thread-label">` +
    `<span class="wiki-thread-name">${esc(card.name)}</span>` +
    `<small class="wiki-thread-meta">${esc(threadMetaLine(card, now, showMoves))}</small>` +
    `</span>` +
    `</button>` +
    `<button type="button" class="wiki-thread-pin${card.pinned ? " on" : ""}" data-thread-pin="${esc(card.pinAnchor)}"` +
    ` data-thread-pinned="${card.pinned ? "1" : "0"}" aria-pressed="${card.pinned}"` +
    ` aria-label="${esc(pinLabel)}" title="${esc(pinLabel)}">📌</button>` +
    `</div>`
  );
}

/** An open card's `touched:` line — links, not rows, so they claim nothing and
 *  `#wikiCount` does not count them. Each carries `data-relpath`, so the
 *  reader's one nav delegate opens it. */
export function threadTouchedHtml(foldKey: string, pages: readonly WikiListing[], hrefFor: (relPath: string) => string): string {
  if (!pages.length) return "";
  const links = pages
    .map(
      (p) =>
        `<a class="wiki-thread-link" href="${esc(hrefFor(p.relPath))}" data-page="${esc(p.name)}"` +
        ` data-relpath="${esc(p.relPath)}" title="${esc(displayTitleOf(p))}">${esc(displayTitleOf(p))}</a>`,
    )
    .join(`<span class="wiki-thread-sep" aria-hidden="true"> · </span>`);
  return (
    `<div class="wiki-thread-touched" data-section="threads" data-thread="${esc(foldKey)}">` +
    `<span class="wiki-thread-touched-label">touched:</span> ${links}</div>`
  );
}
