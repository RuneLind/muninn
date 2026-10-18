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
import type { RailGroupCard, RailThreadCard, RailWorkControl } from "./wiki-recents.ts";
import type { WorkGroupEvidenceToggles, WorkGroupStop } from "./wiki-work-group-prefs.ts";

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

/** A thread card's tally parts: `N sessions`, then `✋ M`. */
function threadTallyParts(card: RailThreadCard, showMoves: boolean): HeaderTally {
  const n = card.sessions.length;
  return {
    counts: [`${n} ${n === 1 ? "session" : "sessions"}`],
    moves: showMoves && card.movesYou > 0 ? `✋ ${card.movesYou}` : "",
  };
}

/** The meta as one plain line, `N sessions · first → last · ✋ M` (the replay
 *  script's form; the card draws it on two lines). */
export function threadMetaLine(card: RailThreadCard, now: number, showMoves: boolean): string {
  const { counts, moves } = threadTallyParts(card, showMoves);
  const { from, to } = threadSpanEnds(card, now, true);
  return [...counts, from && `${from} → ${to}`, moves].filter(Boolean).join(" · ");
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
function threadMetaHtml(tally: HeaderTally, from: string, to: string): string {
  return (
    `<span class="wiki-thread-line wiki-thread-tally">` +
    tally.counts.map((c, i) => `${i ? " " : ""}<span class="wiki-thread-count">${i ? "· " : ""}${esc(c)}</span>`).join("") +
    (tally.moves ? ` <span class="wiki-thread-moves">· ${esc(tally.moves)}</span>` : "") +
    `</span>` +
    (from
      ? `${SR_SEP} <span class="wiki-thread-line wiki-thread-span"><span class="wiki-thread-from">${esc(from)}</span>` +
        ` <span class="wiki-thread-to">→ ${esc(to)}</span></span>`
      : "")
  );
}

/** A header's tally line: its counts (`N sessions`, or `N threads`, `M
 *  sessions`), then `✋ K`, which is "" when it does not show. */
interface HeaderTally {
  counts: string[];
  moves: string;
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
 *  rail entry's count (`buildRail`); it defaults to the card's focus pages.
 *  A GROUP card (`threadGroupHeaderHtml`) takes the same shell: its glyph, a
 *  kind label before the name, `N threads · M sessions · ✋ K`, a hidden
 *  anchor's line, `Show N threads`, and a 📌 that pins its anchor child;
 *  `pages` does not apply to it. */
export function threadCardHeaderHtml(
  card: RailThreadCard | RailGroupCard,
  folded: boolean,
  now: number,
  showMoves: boolean,
  pages?: number,
): string {
  const group = "group" in card;
  const k = group
    ? {
        kind: " wiki-thread-group",
        attr: "data-thread-group",
        glyph: GROUP_GLYPH,
        name: `<span class="wiki-thread-kind">${esc(card.label)}</span> ${esc(card.name)}`,
        hover: [card.name + (card.pinned ? " (pinned first)" : ""), ...card.witnesses].join("\n"),
        what: "this group of work threads",
        tally: threadGroupTallyParts(card, showMoves),
        line: card.anchorVisible ? "" : `${SR_SEP} <span class="wiki-thread-line wiki-thread-why">anchor outside the filters</span>`,
        disclose: threadGroupDiscloseLabel(folded, card.threads),
        pinLabel: "Pin this work group first",
      }
    : {
        kind: card.child ? " wiki-thread-child" : "",
        attr: "data-thread",
        glyph: THREAD_GLYPH,
        name: esc(card.name),
        hover: threadHover(card, now),
        what: "this work thread",
        tally: threadTallyParts(card, showMoves),
        line: card.child ? threadChildLineHtml(card.child) : "",
        disclose: threadDiscloseLabel(folded, pages ?? card.focus.length),
        pinLabel: "Pin this work thread first",
      };
  const { from, to } = threadSpanEnds(card, now, true);
  const why = `${folded ? "Show" : "Hide"} ${k.what}`;
  // No aria-label on the fold: its name is its content (name + meta) and
  // aria-expanded carries the state. Its title, the accessible description,
  // leaves the meta out so a screen reader hears it once; the session lines
  // give a mouse user each session's own start and end.
  // The 📌's NAME is fixed and aria-pressed carries the state (a flipping
  // name reads "Unpin …, pressed", a double negation). Its title is the
  // visible hover, so it says the state and what a click does.
  const pinTitle = card.pinned ? "Pinned first. Click to unpin" : k.pinLabel;
  return (
    `<div class="wiki-thread-card${k.kind}${folded ? "" : " open"}${card.pinned ? " pinned" : ""}" data-section="threads" ${k.attr}="${esc(card.foldKey)}">` +
    `<button type="button" class="wiki-thread-fold${folded ? " folded" : ""}"` +
    ` data-fold-key="${esc(card.toggleKey)}" aria-expanded="${folded ? "false" : "true"}"` +
    ` title="${esc(k.hover + "\n" + why)}">` +
    k.glyph +
    `<span class="wiki-thread-label">` +
    `<span class="wiki-thread-name">${k.name}</span>${SR_SEP}` +
    `<small class="wiki-thread-meta">${threadMetaHtml(k.tally, from, to)}${k.line}</small>${SR_SEP}` +
    `<span class="wiki-thread-disclose"><span aria-hidden="true">${folded ? "▸" : "▾"} </span>` +
    `${esc(k.disclose)}</span>` +
    `</span>` +
    `</button>` +
    `<button type="button" class="wiki-thread-pin${card.pinned ? " on" : ""}" data-thread-pin="${esc(card.pinAnchor)}"` +
    ` data-thread-pinned="${card.pinned ? "1" : "0"}" aria-pressed="${card.pinned}"` +
    ` aria-label="${esc(k.pinLabel)}" title="${esc(pinTitle)}">📌</button>` +
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

// ── Grouped Work threads (plan `muninn-wiki-work-thread-grouping`, PR 3) ─────

/** The `also` chip's label budget, in characters. */
const ALSO_LABEL_MAX = 24;

/** A child card's third meta line: why it joined (`↔ 5 links · series`) or
 *  `anchor`, then the `also <series>` chip. The hover lists the witnesses. */
function threadChildLineHtml(child: NonNullable<RailThreadCard["child"]>): string {
  // The chip names the first series, cut to fit one line of the 260 px rail
  // (width table, src/wiki/CLAUDE.md); the hover names them all in full.
  // Counted and cut by code point, so an emoji is one character and never split.
  const first = [...(child.also[0] ?? "")];
  const label = first.length > ALSO_LABEL_MAX ? first.slice(0, ALSO_LABEL_MAX - 1).join("") + "…" : first.join("");
  const also = child.also.length
    ? ` <span class="wiki-thread-chip" title="${esc("Some of its pages are also in: " + child.also.join(", "))}">` +
      `also ${esc(label)}${child.also.length > 1 ? ` +${child.also.length - 1}` : ""}</span>`
    : "";
  if (!child.why && !also) return "";
  const title = child.witnesses.length ? ` title="${esc("Joined by:\n" + child.witnesses.join("\n"))}"` : "";
  return (
    `${SR_SEP} <span class="wiki-thread-line wiki-thread-why"${title}>` +
    // Each part an inline block, so a narrow rail breaks between parts.
    child.why
      .split(" · ")
      .filter(Boolean)
      .map((part, i) => `${i ? " " : ""}<span class="wiki-thread-why-part">${i ? "· " : ""}${esc(part)}</span>`)
      .join("") +
    also +
    `</span>`
  );
}

/** The group glyph: stacked cards, in the slot a thread card gives its timeline. */
const GROUP_GLYPH =
  `<svg class="wiki-thread-glyph" viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor"` +
  ` stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><rect x="1.5" y="1.5" width="11" height="3" rx="1"/>` +
  `<rect x="1.5" y="5.5" width="11" height="3" rx="1"/><rect x="1.5" y="9.5" width="11" height="3" rx="1"/></svg>`;

/** The group fold's third line: `▸ Show 3 threads` / `▾ Hide 3 threads`. */
export function threadGroupDiscloseLabel(folded: boolean, threads: number): string {
  return `${folded ? "Show" : "Hide"} ${threads} ${threads === 1 ? "thread" : "threads"}`;
}

/** A group header's tally parts: `N threads`, `M sessions`, then `✋ K`. */
function threadGroupTallyParts(card: Pick<RailGroupCard, "threads" | "sessions" | "movesYou">, showMoves: boolean): HeaderTally {
  const s = card.sessions.length;
  return {
    counts: [`${card.threads} ${card.threads === 1 ? "thread" : "threads"}`, `${s} ${s === 1 ? "session" : "sessions"}`],
    moves: showMoves && card.movesYou > 0 ? `✋ ${card.movesYou}` : "",
  };
}

/** A group header's tally as one line, `N threads · M sessions · ✋ K` (the
 *  replay script's form; the header draws the same parts). */
export function threadGroupTally(card: Pick<RailGroupCard, "threads" | "sessions" | "movesYou">, showMoves: boolean): string {
  const { counts, moves } = threadGroupTallyParts(card, showMoves);
  return [...counts, moves].filter(Boolean).join(" · ");
}

/**
 * A GROUP card's header (D10): `threadCardHeaderHtml`'s shell, stacked by
 * CSS. Its 📌 pins the anchor child (or clears the pin when a child holds
 * it); the hover lists the witnesses that joined the group.
 */
export function threadGroupHeaderHtml(card: RailGroupCard, folded: boolean, now: number, showMoves: boolean): string {
  return threadCardHeaderHtml(card, folded, now, showMoves);
}

/** An open group's body opens here; `threadGroupEndHtml` closes it. */
export function threadGroupBodyStartHtml(foldKey: string): string {
  return `<div class="wiki-thread-gbody" data-section="threads" data-thread-group-body="${esc(foldKey)}">`;
}

/** How many shared-context links show before `+N`. */
const CONTEXT_SHOWN = 3;

/** The end of an open group's body: `+ N more threads`, then the shared
 *  context line (links, not rows), then the body's close. Both overflow
 *  controls are buttons whose accessible name adds the group's `name`
 *  (screen-reader-only), so two groups' buttons are told apart while the
 *  visible text still starts the name. `contextOpen` draws every context link. */
export function threadGroupEndHtml(
  foldKey: string,
  hidden: number,
  context: readonly WikiListing[],
  hrefFor: (relPath: string) => string,
  name: string,
  contextOpen = false,
): string {
  const inGroup = `<span class="wiki-sr-only"> in ${esc(name)}</span>`;
  const more =
    hidden > 0
      ? `<button type="button" class="wiki-thread-more" data-thread-more="${esc(foldKey)}">+ ${hidden} more ${hidden === 1 ? "thread" : "threads"}${inGroup}</button>`
      : "";
  let ctx = "";
  if (context.length) {
    const cut = contextOpen ? context.length : CONTEXT_SHOWN;
    const shown = context.slice(0, cut);
    const rest = context.slice(cut);
    const links = shown
      .map(
        (p) =>
          `<a class="wiki-thread-link" href="${esc(hrefFor(p.relPath))}" data-page="${esc(p.name)}"` +
          ` data-relpath="${esc(p.relPath)}" title="${esc(displayTitleOf(p))}">${esc(displayTitleOf(p))}</a>`,
      )
      .join(`<span class="wiki-thread-sep" aria-hidden="true"> · </span>`);
    const tail = rest.length
      ? `<span class="wiki-thread-sep" aria-hidden="true"> · </span><button type="button" class="wiki-thread-ctx-more" data-thread-ctx-more="${esc(foldKey)}"` +
        ` title="${esc(rest.map(displayTitleOf).join("\n"))}">+${rest.length}<span class="wiki-sr-only"> more shared ${rest.length === 1 ? "page" : "pages"} in ${esc(name)}</span></button>`
      : "";
    ctx =
      `<div class="wiki-thread-context" data-section="threads" data-thread-group="${esc(foldKey)}">` +
      `<span class="wiki-thread-touched-label">Shared context:</span> ${links}${tail}</div>`;
  }
  return more + ctx + `</div>`;
}

/** The four stops' names and what each does, for the Group menu. */
const STOP_TEXT: Record<WorkGroupStop, { name: string; what: string }> = {
  sessions: { name: "Sessions", what: "Each agent session on its own" },
  threads: { name: "Threads", what: "Sessions that worked on the same page" },
  related: { name: "Related", what: "Threads that link each other, share an issue or a series" },
  areas: { name: "Areas", what: "Related, plus the same project" },
};

export function workStopName(stop: WorkGroupStop): string {
  return STOP_TEXT[stop].name;
}

/** The evidence boxes, in the menu's order. */
const EVIDENCE_TEXT: readonly [keyof WorkGroupEvidenceToggles, string][] = [
  ["related", "Explicit related page"],
  ["issue", "Same owned issue"],
  ["series", "Same series"],
];

const REASON_TEXT: Record<string, string> = {
  "no-threads": "there are no work threads",
  "evidence-absent": "this server sends no grouping evidence",
  "evidence-unreadable": "the grouping evidence could not be read",
  "relations-cap": "the relation lists hit their limit",
  "ledger-truncated": "the session ledger was cut short",
  "contributions-cap": "the contribution rows hit their limit",
};

/** Why a stop is unavailable, in words. An unknown reason (a newer server)
 *  is named as-is, never rendered as `undefined`. */
export function workReasonLabel(reason: string): string {
  return REASON_TEXT[reason] ?? `unknown reason (${reason})`;
}

/**
 * The Work threads section label with the Group control (D10): the label,
 * then `Related ▾` at the right. A drawn stop that is not the chosen one
 * (relations incomplete) says so on the button. `local` marks a choice that
 * lives in this tab only (a refused write).
 */
export function workSectionHeaderHtml(label: string, control: RailWorkControl, menuOpen: boolean, local: boolean): string {
  // The open menu sits inside the label row, positioned under the button.
  const fellBack = control.stop !== control.requested;
  const reasons = control.stops.find((x) => x.stop === control.requested)?.reasons ?? [];
  const title = fellBack
    ? `${workStopName(control.requested)} is unavailable (${reasons.map(workReasonLabel).join("; ")}), so this shows ${workStopName(control.stop)}. Your choice is kept.`
    : "Choose how work threads are grouped";
  return (
    `<div class="wiki-list-sec wiki-work-sec" data-section="threads">` +
    `<span class="wiki-sec-label">${esc(label)}</span>` +
    (local ? `<span class="wiki-work-local" title="Storage refused the change, so it lasts until this tab closes">this tab only</span>` : "") +
    `<button type="button" class="wiki-work-group-btn${fellBack ? " fell-back" : ""}" data-work-group-menu` +
    ` aria-haspopup="menu" aria-expanded="${menuOpen ? "true" : "false"}" aria-controls="wikiWorkMenu" title="${esc(title)}">` +
    `${esc(workStopName(control.stop))}${fellBack ? " !" : ""} <span aria-hidden="true">▾</span></button>` +
    (menuOpen ? workGroupMenuHtml(control, local) : "") +
    `</div>`
  );
}

/** The disabled evidence boxes' reason; one menu exists at a time. */
const WORK_MENU_WHY_ID = "wikiWorkMenuWhy";

/** The Group menu (D10): the stops with their card counts, then the evidence
 *  boxes, disabled where they do not apply (they keep their values). Menu
 *  items are buttons, so Enter and Space work as clicks; the reader's key
 *  handler moves focus with the arrows. */
export function workGroupMenuHtml(control: RailWorkControl, local: boolean): string {
  const stops = control.stops
    .map((x) => {
      const on = x.stop === control.requested;
      const why = x.available ? "" : `Unavailable: ${x.reasons.map(workReasonLabel).join("; ")}`;
      return (
        `<button type="button" role="menuitemradio" class="wiki-work-opt${x.available ? "" : " off"}" data-work-stop="${x.stop}"` +
        ` aria-checked="${on ? "true" : "false"}"${why ? ` title="${esc(why)}"` : ""}>` +
        `<span class="wiki-work-dot" aria-hidden="true">${on ? "●" : "○"}</span>` +
        `<span class="wiki-work-opt-text">${esc(STOP_TEXT[x.stop].name)}<small>${esc(x.available ? STOP_TEXT[x.stop].what : why)}</small></span>` +
        `<span class="wiki-work-n">${x.available ? x.cards : "—"}</span></button>`
      );
    })
    .join("");
  // A disabled box names its reason through `aria-describedby`: arrow keys in a
  // menu never reach a note, so the description is the only way it is heard.
  const disabled = control.evidenceApplies ? "" : ` aria-disabled="true" aria-describedby="${WORK_MENU_WHY_ID}"`;
  const boxes = EVIDENCE_TEXT.map(([k, name]) => {
    const on = control.evidence[k];
    return (
      `<button type="button" role="menuitemcheckbox" class="wiki-work-opt wiki-work-box${control.evidenceApplies ? "" : " off"}" data-work-evidence="${k}"` +
      ` aria-checked="${on ? "true" : "false"}"${disabled}>` +
      `<span class="wiki-work-dot" aria-hidden="true">${on ? "☑" : "☐"}</span>` +
      `<span class="wiki-work-opt-text">${esc(name)}</span></button>`
    );
  }).join("");
  const fellBack = control.stop !== control.requested;
  // The disabled boxes' reason is its own note, shown after a fallback note too.
  const notes = [
    fellBack ? `<div class="wiki-work-note" role="presentation">${esc(`${workStopName(control.requested)} is unavailable, so this shows ${workStopName(control.stop)}. Your choice is kept.`)}</div>` : "",
    control.evidenceApplies
      ? fellBack ? "" : `<div class="wiki-work-note" role="presentation">A thread joins a group through a direct connection to its first thread.</div>`
      : `<div class="wiki-work-note" id="${WORK_MENU_WHY_ID}" role="presentation">Applies to Related and Areas.</div>`,
  ].join("");
  // Each set is a labelled `group` (allowed inside `menu`), so the radios and
  // the boxes are announced with their heading.
  return (
    `<div class="wiki-work-menu" id="wikiWorkMenu" role="menu" aria-label="Group work threads">` +
    `<div role="group" aria-labelledby="wikiWorkMenuStops"><div class="wiki-work-h" id="wikiWorkMenuStops" role="presentation" aria-hidden="true">Group work by</div>${stops}</div>` +
    `<div class="wiki-work-hr" role="separator"></div>` +
    `<div role="group" aria-labelledby="wikiWorkMenuBoxes"><div class="wiki-work-h" id="wikiWorkMenuBoxes" role="presentation" aria-hidden="true">Connect threads by</div>${boxes}</div>` +
    notes +
    (local ? `<div class="wiki-work-note wiki-work-local-note" role="presentation">This tab only: storage refused the change.</div>` : "") +
    `</div>`
  );
}
