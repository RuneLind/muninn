/**
 * The find palette's markup, key predicates and CSS — pure string building, so
 * `bun test` loads it. The DOM half is `wiki-find-palette.ts`; the ranking is
 * `wiki-find.ts`.
 */

import { escHtml as esc } from "./escape.ts";
import { articleUrl, displayTitleOf, type WikiListing } from "./wiki-filter.ts";
import { highlightFind, type FindResult, type FindRow } from "./wiki-find.ts";
import type {
  FindEverywhereResponse,
  FindEverywhereResult,
  MarkedSnippet,
} from "../../../wiki/find-everywhere.ts";

export const FIND_ID = "wikiFind";
export const FIND_SCRIM_ID = "wikiFindScrim";
export const FIND_INPUT_ID = "wikiFindInput";
export const FIND_LIST_ID = "wikiFindList";
export const FIND_CHIPS_ID = "wikiFindChips";
/** The Everywhere section's container, inside the list. */
export const FIND_EVERY_ID = "wikiFindEvery";
/** How many series chips the palette shows above the rows. */
export const FIND_CHIPS_MAX = 6;

export const FIND_PLACEHOLDER = 'Find pages — words, in:"series", type:plan, age:<14, #tag';

/** Is this a Mac? Decides whether ⌘K or Ctrl-K opens the palette: on a Mac
 *  Ctrl-K is the text fields' native delete-to-end-of-line and stays theirs. */
export function isMacPlatform(platform: string): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

/** ⌘K on a Mac, Ctrl-K elsewhere — never both, never with Alt or Shift. */
export function isFindToggleKey(
  e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean },
  mac: boolean,
): boolean {
  if (e.key !== "k" && e.key !== "K") return false;
  if (e.altKey || e.shiftKey) return false;
  return mac ? !!e.metaKey && !e.ctrlKey : !!e.ctrlKey && !e.metaKey;
}

/** The dialog shell; the list and chips are filled per render. */
export function findPaletteHtml(): string {
  return (
    `<div class="wiki-find" id="${FIND_ID}" role="dialog" aria-modal="true" aria-label="Find pages" tabindex="-1">` +
    `<input class="wiki-find-input" id="${FIND_INPUT_ID}" type="text" role="combobox" aria-expanded="true" ` +
    `aria-controls="${FIND_LIST_ID}" aria-autocomplete="list" autocomplete="off" spellcheck="false" ` +
    `placeholder="${esc(FIND_PLACEHOLDER)}">` +
    `<div class="wiki-find-chips" id="${FIND_CHIPS_ID}"></div>` +
    `<div class="wiki-find-list" id="${FIND_LIST_ID}" role="listbox" aria-label="Results"></div>` +
    `<div class="wiki-find-foot">↑↓ move · ↵ open · ⇧↵ new tab · esc close</div>` +
    `</div>`
  );
}

/** The chip row: one button per series among ALL matches, count beside it. */
export function findChipsHtml(result: FindResult): string {
  return result.chips
    .slice(0, FIND_CHIPS_MAX)
    .map(
      (c) =>
        `<button type="button" class="wiki-find-chip" data-find-chip="${esc(c.token)}" ` +
        `title="Only this series (${esc(c.token)})">${esc(c.label)} <span class="wiki-find-chip-n">${c.count}</span></button>`,
    )
    .join("");
}

export const findRowId = (i: number): string => `wikiFindRow-${i}`;

/** The list before the reader's listing has arrived. */
export function findLoadingHtml(): string {
  return `<div class="wiki-find-empty">Loading pages…</div>`;
}

/** The list when the boot request for the listing failed. */
export function findFailedHtml(): string {
  return `<div class="wiki-find-empty">Couldn't load pages.</div>`;
}

/**
 * The result list. `hrefFor` gives each row a real link (middle-click and
 * Shift-Enter open it in a new tab); `titleOf` resolves a superseded page's
 * successor for its "superseded by" line.
 */
export function findListHtml(
  result: FindResult,
  query: string,
  active: number,
  hrefFor: (relPath: string) => string,
  titleOf: (relPath: string) => string | undefined,
): string {
  if (!query.trim()) return `<div class="wiki-find-empty">Type to find pages in this wiki.</div>`;
  if (!result.rows.length) return `<div class="wiki-find-empty">No pages match.</div>`;
  let html = "";
  let i = 0;
  for (const g of result.groups) {
    if (g.seriesKey) html += `<div class="wiki-find-group" role="presentation">${esc(g.seriesLabel)}</div>`;
    for (const r of g.rows) {
      html += findRowHtml(r, result.terms.length, i, i === active, hrefFor(r.page.relPath), titleOf);
      i++;
    }
  }
  if (result.total > result.rows.length) {
    html += `<div class="wiki-find-more">${result.total - result.rows.length} more — narrow the query</div>`;
  }
  return html;
}

function findRowHtml(
  r: FindRow,
  words: number,
  i: number,
  active: boolean,
  href: string,
  titleOf: (relPath: string) => string | undefined,
): string {
  const p: WikiListing = r.page;
  const terms = r.terms;
  const notes: string[] = [];
  if (p.pairedBy === "superseded" && p.parent) {
    notes.push(`superseded by ${esc(titleOf(p.parent) ?? p.parent)}`);
  }
  if (p.culled) notes.push("retired");
  return (
    `<a class="wiki-find-row${active ? " active" : ""}" id="${findRowId(i)}" role="option" ` +
    `aria-selected="${active}" data-find-row="${i}" data-relpath="${esc(p.relPath)}" href="${esc(href)}">` +
    `<span class="wiki-find-title">${highlightFind(displayTitleOf(p), terms)}</span>` +
    `<span class="wiki-find-meta">` +
    (r.partial
      ? `<span class="wiki-find-partial" title="Matches ${r.matched} of ${words} words">partial ${r.matched}/${words}</span>`
      : "") +
    `<span class="wiki-find-type">${esc(p.type)}</span>` +
    `<span class="wiki-find-path">${highlightFind(p.relPath, terms)}</span>` +
    (notes.length ? `<span class="wiki-find-note">${notes.join(" · ")}</span>` : "") +
    `</span></a>`
  );
}

// ── Everywhere (`GET /api/wiki/find-everywhere`) ─────────────────────────

/** The Everywhere section's state for the query on screen. */
export type FindEverywhereState =
  | { q: string; status: "pending" }
  | { q: string; status: "failed" }
  | { q: string; status: "done"; data: FindEverywhereResponse };

/** The reader URL of a page in any wiki. */
export function everywhereHref(wiki: string, relPath: string): string {
  return articleUrl(wiki, "relPath", relPath, "");
}

/** The Everywhere rows: fused rows not already shown as a local row. */
export function everywhereRows(
  data: FindEverywhereResponse,
  currentWiki: string,
  localRelPaths: ReadonlySet<string>,
): FindEverywhereResult[] {
  return data.results.filter((r) => !(r.wiki === currentWiki && localRelPaths.has(r.relPath)));
}

/** Fused rows of the current wiki, by relPath — the reasons a LOCAL row gets. */
export function localReasons(
  data: FindEverywhereResponse,
  currentWiki: string,
): Map<string, FindEverywhereResult> {
  return new Map(data.results.filter((r) => r.wiki === currentWiki).map((r) => [r.relPath, r]));
}

/** Escape a marked snippet and wrap its spans in `<mark>`. */
export function markedSnippetHtml(s: MarkedSnippet): string {
  let out = "";
  let at = 0;
  for (const [a, b] of [...s.marks].sort((x, y) => x[0] - y[0])) {
    if (a < at || b <= a) continue;
    out += esc(s.text.slice(at, a)) + `<mark>${esc(s.text.slice(a, b))}</mark>`;
    at = b;
  }
  return out + esc(s.text.slice(at));
}

/** Why a fused row is here: one chip per leg that found it. */
export function findReasonChipsHtml(r: FindEverywhereResult): string {
  const chips: string[] = [];
  if (r.head) chips.push(`<span class="wiki-find-reason head" title="First in at least one source">leg #1</span>`);
  if (r.legs.text) chips.push(`<span class="wiki-find-reason" title="Title, tags or notes match">text #${r.legs.text.rank}</span>`);
  if (r.legs.huginn) {
    chips.push(`<span class="wiki-find-reason" title="${esc(r.legs.huginn.snippet || "Huginn search")}">huginn #${r.legs.huginn.rank}</span>`);
  }
  for (const s of r.legs.sessions ?? []) {
    const tip = s.title ? `Session: ${s.title}` : `Session ${s.id}`;
    chips.push(`<span class="wiki-find-reason session" title="${esc(tip)}">session ${esc(s.id.slice(0, 8))} #${s.rank}</span>`);
  }
  return chips.length ? `<span class="wiki-find-reasons">${chips.join("")}</span>` : "";
}

/** The legs that failed or are not configured, as one quiet line. */
export function findDegradeNote(data: FindEverywhereResponse): string {
  const out: string[] = [];
  const names = { huginn: "huginn", sessions: "session search" } as const;
  for (const leg of ["huginn", "sessions"] as const) {
    const st = data.sources[leg];
    if (st.status === "error") out.push(`${names[leg]} unavailable`);
    else if (st.status === "unconfigured") out.push(`${names[leg]} not configured`);
  }
  return out.length ? `Partial results — ${out.join(" · ")}.` : "";
}

/**
 * The Everywhere section. Rows continue the local rows' numbering from
 * `start`, so one `active` index walks both sections.
 */
export function findEverywhereHtml(
  state: FindEverywhereState | null,
  rows: readonly FindEverywhereResult[],
  start: number,
  active: number,
): string {
  if (!state) return "";
  const head = `<div class="wiki-find-group wiki-find-every-head" role="presentation">Everywhere</div>`;
  if (state.status === "pending") return head + `<div class="wiki-find-every-note">Searching everywhere…</div>`;
  if (state.status === "failed") return head + `<div class="wiki-find-every-note">Couldn't search everywhere.</div>`;
  const note = findDegradeNote(state.data);
  const noteHtml = note ? `<div class="wiki-find-every-note" data-find-degrade>${esc(note)}</div>` : "";
  if (!rows.length) return head + noteHtml + `<div class="wiki-find-every-note">Nothing more in other wikis or sessions.</div>`;
  let html = head;
  rows.forEach((r, j) => {
    const i = start + j;
    const on = i === active;
    const snippet = r.legs.sessions?.[0]?.snippet.text
      ? markedSnippetHtml(r.legs.sessions[0].snippet)
      : r.legs.huginn?.snippet
        ? esc(r.legs.huginn.snippet)
        : "";
    html +=
      `<a class="wiki-find-row wiki-find-every-row${on ? " active" : ""}" id="${findRowId(i)}" role="option" ` +
      `aria-selected="${on}" data-find-row="${i}" data-find-every="${j}" data-relpath="${esc(r.relPath)}" ` +
      `href="${esc(everywhereHref(r.wiki, r.relPath))}">` +
      `<span class="wiki-find-title">${esc(r.title)}</span>` +
      `<span class="wiki-find-meta"><span class="wiki-find-wiki">${esc(r.wiki)}</span>` +
      `<span class="wiki-find-type">${esc(r.type)}</span>` +
      `<span class="wiki-find-path">${esc(r.relPath)}</span>${findReasonChipsHtml(r)}</span>` +
      (snippet ? `<span class="wiki-find-snippet">${snippet}</span>` : "") +
      `</a>`;
  });
  return html + noteHtml;
}

/** Semantic tokens only, so both themes follow the palette. Closed is
 *  REMOVED from the DOM — never opacity/visibility, which keep client rects
 *  and would leave `modalOpen` true. */
export function findPaletteStyles(): string {
  return `
    .wiki-find-scrim {
      position: fixed; inset: 0; z-index: 70; background: rgba(0, 0, 0, 0.45);
      display: flex; justify-content: center; align-items: flex-start; padding: 10vh 16px 16px;
    }
    .wiki-find {
      width: min(640px, 100%); max-height: 75vh; display: flex; flex-direction: column;
      background: var(--bg-panel); color: var(--text-secondary);
      border: 1px solid var(--border-secondary); border-radius: 10px;
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.35); outline: none; overflow: hidden;
    }
    .wiki-find-input {
      font: inherit; font-size: 15px; padding: 12px 14px; border: none;
      border-bottom: 1px solid var(--border-secondary); background: var(--bg-surface);
      color: var(--text-primary); outline: none;
    }
    .wiki-find-input::placeholder { color: var(--text-muted); }
    .wiki-find-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 12px 0; }
    .wiki-find-chips:empty { display: none; }
    .wiki-find-chip {
      font: inherit; font-size: 11.5px; padding: 2px 8px; border-radius: 999px; cursor: pointer;
      border: 1px solid var(--border-secondary); background: var(--bg-surface); color: var(--text-secondary);
    }
    .wiki-find-chip:hover, .wiki-find-chip:focus-visible { border-color: var(--accent); outline: none; }
    .wiki-find-chip-n { color: var(--text-muted); }
    .wiki-find-list { overflow-y: auto; padding: 6px 0; min-height: 0; }
    .wiki-find-group {
      font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em;
      color: var(--text-muted); padding: 8px 14px 2px;
    }
    .wiki-find-row {
      display: flex; flex-direction: column; gap: 1px; padding: 6px 14px;
      color: var(--text-secondary); text-decoration: none; border-left: 2px solid transparent;
    }
    .wiki-find-row:hover { background: var(--bg-hover); }
    .wiki-find-row.active, .wiki-find-row:focus-visible {
      background: var(--bg-hover); border-left-color: var(--accent); outline: none;
    }
    .wiki-find-title { font-size: 13.5px; color: var(--text-primary); }
    .wiki-find-meta { display: flex; gap: 8px; font-size: 11px; color: var(--text-muted); min-width: 0; }
    .wiki-find-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .wiki-find-type { flex-shrink: 0; }
    .wiki-find-partial {
      flex-shrink: 0; padding: 0 6px; border-radius: 999px; font-size: 10.5px;
      border: 1px solid var(--border-secondary); background: var(--bg-surface); color: var(--text-muted);
    }
    .wiki-find-note { flex-shrink: 0; color: var(--text-soft); }
    .wiki-find mark { background: none; color: var(--accent-light); font-weight: 600; }
    .wiki-find-empty, .wiki-find-more { padding: 10px 14px; font-size: 12.5px; color: var(--text-muted); }
    .wiki-find-every-head { border-top: 1px solid var(--border-secondary); margin-top: 4px; padding-top: 10px; }
    .wiki-find-every-note { padding: 4px 14px 8px; font-size: 12px; color: var(--text-muted); }
    .wiki-find-reasons { display: inline-flex; flex-wrap: wrap; gap: 4px; flex-shrink: 0; }
    .wiki-find-reason {
      padding: 0 6px; border-radius: 999px; font-size: 10.5px; white-space: nowrap;
      border: 1px solid var(--border-secondary); background: var(--bg-surface); color: var(--text-muted);
    }
    .wiki-find-reason.head { border-color: var(--accent); color: var(--text-secondary); }
    .wiki-find-wiki { flex-shrink: 0; color: var(--text-secondary); font-weight: 600; }
    .wiki-find-snippet {
      font-size: 11.5px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; min-width: 0;
    }
    .wiki-find-foot {
      padding: 6px 14px; font-size: 11px; color: var(--text-muted);
      border-top: 1px solid var(--border-secondary);
    }
  `;
}
