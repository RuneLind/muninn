/**
 * The work-thread card's markup (plan `muninn-wiki-work-threads`, PR 5): the
 * header (thread glyph, name, sessions and span, ✋, «Show N pages», 📌) and
 * the `touched:` line, plus the series ghost row and its note, for a pin's
 * ghost and a thread's. Pure string
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

/** A card's span as its two ends: `from` and `to` are each "" with no
 *  sessions. A span inside one day names the day once (`today 14:21` → `16:51`).
 *  `compact` drops the weekday (`30.09 05:21`), the meta line's form. */
function threadSpanEnds(card: Pick<RailThreadCard, "sessions">, now: number, compact: boolean): { from: string; to: string } {
  if (!card.sessions.length) return { from: "", to: "" };
  const first = Math.min(...card.sessions.map((s) => s.first));
  const last = Math.max(...card.sessions.map((s) => s.last));
  const label = (ms: number) => {
    const l = threadInstantLabel(ms, now);
    return compact ? l.replace(/^[a-z]{3} (?=\d)/, "") : l;
  };
  const to = label(last);
  const sameDay = localDay(new Date(first)) === localDay(new Date(last));
  return { from: label(first), to: sameDay ? to.slice(to.lastIndexOf(" ") + 1) : to };
}

/** `first → last` over a card's sessions, or "" with none. */
export function threadSpanLabel(card: Pick<RailThreadCard, "sessions">, now: number, compact = false): string {
  const { from, to } = threadSpanEnds(card, now, compact);
  return from ? `${from} → ${to}` : "";
}

/** The meta line's parts, in the meta's compact date form; `from`/`to` and
 *  `moves` are "" when absent. */
function threadMetaParts(card: RailThreadCard, now: number, showMoves: boolean): { count: string; from: string; to: string; moves: string } {
  const n = card.sessions.length;
  return {
    count: `${n} ${n === 1 ? "session" : "sessions"}`,
    ...threadSpanEnds(card, now, true),
    moves: showMoves && card.movesYou > 0 ? `✋ ${card.movesYou}` : "",
  };
}

/** The meta as one plain line, `N sessions · first → last · ✋ M` (the replay
 *  script's form; the card draws it on two lines). */
export function threadMetaLine(card: RailThreadCard, now: number, showMoves: boolean): string {
  const { count, from, to, moves } = threadMetaParts(card, now, showMoves);
  return [count, from && `${from} → ${to}`, moves].filter(Boolean).join(" · ");
}

/** A visually hidden ` · ` for the fold's accessible name, which is its
 *  content: without it a screen reader runs the name and the two meta lines
 *  together («✋ 12 today 16:20» reads as one run of numbers). */
const SR_SEP = `<span class="wiki-sr-only"> · </span>`;

/** The meta as markup: two lines, `N sessions · ✋ M` over `first → last`,
 *  laid out from the width table in `src/wiki/CLAUDE.md` (Work threads): each
 *  line fits on one line at the 260 and 300 px rails on macOS and Linux fonts,
 *  so nothing is cut. Each part is an inline block, so a rail narrower than
 *  260 (the viewport bound) breaks a line between parts, at ` · ` or ` → `,
 *  and only wraps inside a part when the part alone is wider than the rail. */
function threadMetaHtml(card: RailThreadCard, now: number, showMoves: boolean): string {
  const { count, from, to, moves } = threadMetaParts(card, now, showMoves);
  return (
    `<span class="wiki-thread-line wiki-thread-tally"><span class="wiki-thread-count">${esc(count)}</span>` +
    (moves ? ` <span class="wiki-thread-moves">· ${esc(moves)}</span>` : "") +
    `</span>` +
    (from
      ? `${SR_SEP} <span class="wiki-thread-line wiki-thread-span"><span class="wiki-thread-from">${esc(from)}</span>` +
        ` <span class="wiki-thread-to">→ ${esc(to)}</span></span>`
      : "")
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

/** The fold's third line, which says what a click does: `▸ Show 3 pages` on
 *  a closed card, `▾ Hide 3 pages` (`▾ Hide page` for one) on an open one.
 *  It is what tells a header from a page row, whose click opens the page. */
export function threadDiscloseLabel(folded: boolean, pages: number): string {
  if (pages < 1) return folded ? "Show pages" : "Hide pages";
  if (pages === 1) return folded ? "Show 1 page" : "Hide page";
  return `${folded ? "Show" : "Hide"} ${pages} pages`;
}

/** The timeline glyph that marks a header as a THREAD (sessions on a line),
 *  in the slot a page row gives its type icon. */
const THREAD_GLYPH =
  `<svg class="wiki-thread-glyph" viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor"` +
  ` stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M3.5 1.5v11"/>` +
  `<circle cx="3.5" cy="3" r="1.6" fill="currentColor"/><circle cx="3.5" cy="7" r="1.6" fill="currentColor"/>` +
  `<circle cx="3.5" cy="11" r="1.6" fill="currentColor"/><path d="M7 3h5.5M7 7h4M7 11h5"/></svg>`;

/** The card header: a fold button and the 📌 beside it (two sibling buttons —
 *  a button may not hold one). The fold writes `toggleKey`, so the generic
 *  `[data-fold-key]` handler toggles a card like any group. `pages` is the
 *  rail entry's count (`buildRail`); it defaults to the card's focus pages. */
export function threadCardHeaderHtml(
  card: RailThreadCard,
  folded: boolean,
  now: number,
  showMoves: boolean,
  pages: number = card.focus.length,
): string {
  const hover = threadHover(card, now);
  const why = folded ? "Show this work thread" : "Hide this work thread";
  // No aria-label on the fold: its name is its content (name + meta) and
  // aria-expanded carries the state. Its title, the accessible description,
  // leaves the meta out so a screen reader hears it once; the session lines
  // give a mouse user each session's own start and end.
  // The 📌's NAME is fixed and aria-pressed carries the state (a flipping
  // name reads "Unpin …, pressed", a double negation). Its title is the
  // visible hover, so it says the state and what a click does.
  const pinLabel = "Pin this work thread first";
  const pinTitle = card.pinned ? "Pinned first. Click to unpin" : pinLabel;
  return (
    `<div class="wiki-thread-card${folded ? "" : " open"}${card.pinned ? " pinned" : ""}" data-section="threads" data-thread="${esc(card.foldKey)}">` +
    `<button type="button" class="wiki-thread-fold${folded ? " folded" : ""}"` +
    ` data-fold-key="${esc(card.toggleKey)}" aria-expanded="${folded ? "false" : "true"}"` +
    ` title="${esc(hover + "\n" + why)}">` +
    THREAD_GLYPH +
    `<span class="wiki-thread-label">` +
    `<span class="wiki-thread-name">${esc(card.name)}</span>${SR_SEP}` +
    `<small class="wiki-thread-meta">${threadMetaHtml(card, now, showMoves)}</small>${SR_SEP}` +
    `<span class="wiki-thread-disclose"><span aria-hidden="true">${folded ? "▸" : "▾"} </span>` +
    `${esc(threadDiscloseLabel(folded, pages))}</span>` +
    `</span>` +
    `</button>` +
    `<button type="button" class="wiki-thread-pin${card.pinned ? " on" : ""}" data-thread-pin="${esc(card.pinAnchor)}"` +
    ` data-thread-pinned="${card.pinned ? "1" : "0"}" aria-pressed="${card.pinned}"` +
    ` aria-label="${esc(pinLabel)}" title="${esc(pinTitle)}">📌</button>` +
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
