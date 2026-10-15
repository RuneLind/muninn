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

/** One instant as a card shows it, in the viewer's zone: `today 08:01`,
 *  `yesterday 21:26`, else `mon 12.10 15:04`. */
export function threadInstantLabel(ms: number, now: number): string {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const day = localDay(d);
  if (day === localDay(new Date(now))) return `today ${hm}`;
  // The previous CALENDAR day: `now - 24h` lands two days back after a 23-hour
  // spring-forward day. Local noon minus one date never crosses a DST hour.
  const yesterday = new Date(now);
  yesterday.setHours(12, 0, 0, 0);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === localDay(yesterday)) return `yesterday ${hm}`;
  const wd = d.toLocaleDateString("en-GB", { weekday: "short" }).toLowerCase();
  return `${wd} ${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")} ${hm}`;
}

/** `first → last` over a card's sessions, or "" with none. A span inside one
 *  day names the day once (`today 14:21 → 16:51`). */
export function threadSpanLabel(card: Pick<RailThreadCard, "sessions">, now: number): string {
  if (!card.sessions.length) return "";
  const first = Math.min(...card.sessions.map((s) => s.first));
  const last = Math.max(...card.sessions.map((s) => s.last));
  const from = threadInstantLabel(first, now);
  const to = threadInstantLabel(last, now);
  const sameDay = localDay(new Date(first)) === localDay(new Date(last));
  return `${from} → ${sameDay ? to.slice(to.lastIndexOf(" ") + 1) : to}`;
}

/** The meta line's three parts; `span` and `moves` are "" when absent. */
function threadMetaParts(card: RailThreadCard, now: number, showMoves: boolean): { count: string; span: string; moves: string } {
  const n = card.sessions.length;
  return {
    count: `${n} ${n === 1 ? "session" : "sessions"}`,
    span: threadSpanLabel(card, now),
    moves: showMoves && card.movesYou > 0 ? `✋ ${card.movesYou}` : "",
  };
}

/** The header's second line: `N sessions · first → last · ✋ M`. */
export function threadMetaLine(card: RailThreadCard, now: number, showMoves: boolean): string {
  const { count, span, moves } = threadMetaParts(card, now, showMoves);
  return [count, span, moves].filter(Boolean).join(" · ");
}

/** The meta line as markup: one span per part, so the CSS can keep it on one
 *  line and let only the time span give way (ellipsis) at a narrow rail. */
function threadMetaHtml(card: RailThreadCard, now: number, showMoves: boolean): string {
  const { count, span, moves } = threadMetaParts(card, now, showMoves);
  return (
    `<span class="wiki-thread-count">${esc(count)}</span>` +
    (span ? `<span class="wiki-thread-span"> · ${esc(span)}</span>` : "") +
    (moves ? `<span class="wiki-thread-moves"> · ${esc(moves)}</span>` : "")
  );
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
  const meta = threadMetaLine(card, now, showMoves);
  const hover = threadHover(card, now);
  const why = folded ? "Show this work thread" : "Hide this work thread";
  // No aria-label on either button. The fold's name is its content (name +
  // meta) and aria-expanded carries the state. The 📌's label is fixed and
  // aria-pressed carries the state: a label that flips as well reads "Unpin
  // …, pressed", a double negation.
  const pinLabel = "Pin this work thread first";
  return (
    `<div class="wiki-thread-card${folded ? "" : " open"}${card.pinned ? " pinned" : ""}" data-section="threads" data-thread="${esc(card.foldKey)}">` +
    `<button type="button" class="wiki-thread-fold${folded ? " folded" : ""}"` +
    ` data-fold-key="${esc(card.toggleKey)}" aria-expanded="${folded ? "false" : "true"}"` +
    ` title="${esc(hover + "\n" + meta + "\n" + why)}">` +
    `<span class="wiki-fold-caret" aria-hidden="true">▸</span>` +
    `<span class="wiki-thread-label">` +
    `<span class="wiki-thread-name">${esc(card.name)}</span>` +
    `<small class="wiki-thread-meta">${threadMetaHtml(card, now, showMoves)}</small>` +
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

/** A ghost row's note: which section above holds the real row. */
export function railGhostNote(reason: "pinned" | "thread"): string {
  return reason === "thread" ? "in a work thread above" : "pinned above";
}

/** A series GHOST row (see `renderList`): a dim placeholder for a member lifted
 *  by a pin or an open work-thread card. `data-ghost-reason` rides only the
 *  thread case, so a pin's ghost is byte-identical to the markup before work
 *  threads (D11). */
export function railGhostHtml(relPath: string, title: string, reason: "pinned" | "thread"): string {
  const where =
    reason === "thread"
      ? "in an open work thread — its row is under Work threads, above"
      : "pinned — its row is under Pinned, above";
  return (
    `<div class="wiki-list-ghost wiki-series-cont" data-ghost-relpath="${esc(relPath)}"` +
    (reason === "thread" ? ` data-ghost-reason="thread"` : "") +
    ` title="${esc(title + "\n" + where)}">` +
    `<div class="wiki-list-ghost-title">${esc(title)}</div>` +
    `<div class="wiki-list-ghost-note">${railGhostNote(reason)}</div>` +
    `</div>`
  );
}
