/// <reference lib="dom" />
/**
 * The section bar under the reader's breadcrumb (plan muninn-wiki-render-richer
 * P3, D2): on a page with three or more sections it shows `n/N`, the current
 * section's title and how far down the page the reader is, and opens a menu of
 * the sections. Sections are the article's top heading level (its direct-child
 * headings, at the smallest level among them, or the level under one or two
 * `#` title headings, {@link sectionTargets}) plus the summary of each
 * top-level `<Fold>`; a fold's own heading sits inside the fold, so it is the
 * same section and never counted twice ({@link sectionTargets}).
 *
 * `#wikiSectionBar` is a sibling of `#wikiBreadcrumb`, between it and
 * `#articleWrap`, not a child: the breadcrumb is rebuilt with `innerHTML` on
 * every page render and its row's wrap rule is measured by
 * `e2e/wiki-copy-path.spec.ts`. The reader calls {@link mountSectionBar} once
 * per article render; nothing runs at import.
 *
 * State table (every row implemented; the risky ones are pinned by
 * `e2e/wiki-section-bar.spec.ts`):
 *
 * | Starting state         | Event                                   | Result                                                       |
 * |------------------------|-----------------------------------------|--------------------------------------------------------------|
 * | page, < 3 sections     | load                                    | no bar (`hidden`); breadcrumb as before                      |
 * | page, ≥ 3 sections     | load at the top                         | `1/N`, the first title, progress 0                           |
 * | any                    | scroll (wheel, keys, scrollbar)         | current = last visible section whose heading passed the      |
 * |                        |                                         | reading line (`READ_LINE` px below the pane's top); when a   |
 * |                        |                                         | foot heading never reaches it, the line slides to the pane's |
 * |                        |                                         | bottom over the last stretch, so the foot sections take over |
 * |                        |                                         | in order, the last at the very bottom; progress              |
 * |                        |                                         | follows; one update per frame (rAF), passive listener        |
 * | any                    | navigation (rail, wikilink, back/fwd)   | the new render calls mount: the old listeners and observers  |
 * |                        |                                         | go first, the menu closes, the bar is rebuilt or hidden      |
 * | any                    | lens switch (class on `.wiki-article`)  | sections recomputed from what is visible (Overview hides     |
 * |                        |                                         | dev folds, Agent hides the article: no bar)                  |
 * | a fold closed / open   | the reader toggles it                   | positions re-read on the next frame; the list is unchanged   |
 * | menu closed            | click / Enter / Space on the button     | menu opens, focus on the current entry                       |
 * | menu open              | Esc                                     | closes, focus back on the button                             |
 * | menu open              | click outside the bar                   | closes, focus stays where the click put it                   |
 * | menu open              | ↑ / ↓ / Home / End                      | focus moves between entries                                  |
 * | menu open              | pick a section (in a closed fold too)   | its fold opens, the pane scrolls it under the bar, the menu  |
 * |                        |                                         | closes, focus moves to its heading or summary (no scroll);   |
 * |                        |                                         | the picked section stays current until its heading moves     |
 * |                        |                                         | more than 2 px in the viewport                               |
 * | any                    | `#anchor` link, load with a hash, a     | the section holding the revealed element is current (also    |
 * |                        | card chip or pill (`wiki:reveal`)       | near the foot) until the pane scrolls again                  |
 * | any                    | 🧭 buttons, reader-only marks, size     | titles read without them (`[data-walkthrough-btn]`,          |
 * |                        | labels, `<Fact>` chips, new-since marks | `[data-reader-only]`, `.fold-summary`, `.gl-tip`, `.fc-chip`;|
 * |                        |                                         | a new-since mark is `::before`, not text)                    |
 * | any                    | rail drag, window resize, fold resize   | ResizeObserver on the pane and article schedules an update;  |
 * |                        |                                         | the bar writes the DOM only on a change, so no loop          |
 * | any                    | theme or palette flip                   | restyled by tokens, no rebuild                               |
 * | any                    | Ask answer, explainer, start view,      | the article leaves `#articleWrap`: torn down, hidden, no     |
 * |                        | error, graph (hides the article)        | listener left; graph hides it until the article shows again  |
 */

import { REVEAL_EVENT } from "./wiki-hash-target.ts";

/** The reading line, px below the pane's top edge: a section is current once
 *  its heading has passed it. The prototype's value (`proto.js`, `top + 140`);
 *  a jump lands a section `JUMP_GAP` px down, above it. */
const READ_LINE = 140;
const JUMP_GAP = 12;
/** Fewer sections than this: no bar. */
export const SECTION_BAR_MIN = 3;

export const SECTION_BAR_ID = "wikiSectionBar";
const MENU_ID = "wikiSectionMenu";

/** What a section title leaves out: the reader's own chrome beside a heading
 *  or in a fold summary (🧭, size labels, glossary tips, the teaser, a
 *  `<Fact>` chip). A new-since mark is `::before` content, never text. */
const TITLE_CHROME = "[data-walkthrough-btn], [data-reader-only], .fold-summary, .gl-tip, .fc-chip";

/** The article's sections in document order: its direct-child headings at
 *  the smallest level among them, plus each top-level fold's summary (a fold
 *  not inside another fold). `visible` filters (the lens hides some). Pure
 *  over the DOM it is given: no globals. */
export function sectionTargets(article: Element, visible: (el: Element) => boolean = () => true): Element[] {
  const heads = Array.from(article.children).filter((c) => /^H[2-6]$/.test(c.tagName) && visible(c));
  const level = (h: Element): number => Number(h.tagName[1]);
  const levels = [...new Set(heads.map(level))].sort();
  const count = (l: number | undefined): number => heads.filter((h) => level(h) === l).length;
  // `#` (rendered h2) headings are titles, not sections, when the first heading
  // is one and there are at most two: one kept `# Title` (the frontmatter title
  // differs, so the render keeps it), or a title plus a part heading over many
  // entries (`log.md`: `# Activity Log` … `# Log` over 1,211 `##` entries).
  const titles = levels[0] === 2 && level(heads[0]!) === 2 &&
    (count(2) === 1 || (count(2) === 2 && count(levels[1]) >= SECTION_BAR_MIN));
  const top = titles ? (levels[1] ?? 0) : (levels[0] ?? 0);
  const out: Element[] = [];
  for (const el of Array.from(article.querySelectorAll("h2, h3, h4, h5, h6, details.fold > summary"))) {
    if (el.tagName === "SUMMARY") {
      const fold = el.parentElement!;
      if (fold.parentElement?.closest("details") || !visible(el)) continue;
      out.push(el);
    } else if (el.parentElement === article && Number(el.tagName[1]) === top && visible(el)) {
      out.push(el);
    }
  }
  return out;
}

/** A section's title as the reader sees it, without {@link TITLE_CHROME}. */
export function sectionTitle(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll(TITLE_CHROME).forEach((n) => n.remove());
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Which section is current: the last whose heading has passed `line`, never
 *  before the first. `tops`, `line` and `bottom` (the pane's bottom edge) are
 *  viewport px, `tops` in document order; `scroll` and `max` are the pane's
 *  scrollTop and its largest value. When a heading at the foot cannot reach
 *  `line` even at `max`, the line slides from `line` to `bottom` over the last
 *  stretch of scroll, so the foot sections take over in order, in proportion
 *  to where their headings sit, and the bottom reads the last one. */
export function currentSection(tops: readonly number[], line: number, scroll: number, max: number, bottom: number): number {
  const stretch = Math.min(bottom - line, max);
  const stuck = stretch > 0 && tops.some((t) => t - line + scroll > max);
  const at = stuck ? line + (bottom - line) * Math.min(1, Math.max(0, (scroll - (max - stretch)) / stretch)) : line;
  let cur = 0;
  tops.forEach((t, k) => {
    if (t <= at) cur = k;
  });
  return cur;
}

/** The index of the section a revealed element sits in: the last section at
 *  or before it in document order, or the section it heads (a fold addressed by
 *  its own id holds its summary). */
export function sectionHolding(sections: readonly Element[], el: Element): number {
  let k = 0;
  for (const [i, s] of sections.entries()) {
    if (el.contains(s)) return i;
    if (s.compareDocumentPosition(el) & 4 /* el follows s, or sits in it */) k = i;
  }
  return k;
}

interface Mounted {
  article: HTMLElement;
  wrap: HTMLElement;
  bar: HTMLElement;
  sections: Element[];
  cur: number;
  frame: number;
  dirty: boolean;
  teardown: () => void;
}
let mounted: Mounted | null = null;

/** Drop the current bar: listeners, observers, frame; hide it. */
export function unmountSectionBar(): void {
  mounted?.teardown();
  mounted = null;
}

const isVisible = (el: Element): boolean => el.getClientRects().length > 0;

/** Bind the bar to the article just rendered into `wrap` (`#articleWrap`). */
export function mountSectionBar(wrap: HTMLElement): void {
  unmountSectionBar();
  const host = document.getElementById(SECTION_BAR_ID);
  const article = wrap.querySelector<HTMLElement>(":scope > .wiki-article");
  if (!host) return;
  const bar: HTMLElement = host;
  bar.hidden = true;
  bar.classList.remove("open");
  bar.innerHTML = "";
  if (!article) return;
  bar.innerHTML =
    `<button class="wiki-sec-btn" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="${MENU_ID}">` +
    `<span class="wiki-sec-n"></span><span class="wiki-sec-t"></span><span class="wiki-sec-caret" aria-hidden="true">▾</span></button>` +
    `<span class="wiki-sec-bar" aria-hidden="true"><i></i></span>` +
    `<ol class="wiki-sec-menu" id="${MENU_ID}" role="menu" aria-label="Sections" hidden></ol>`;
  const btn = bar.querySelector<HTMLButtonElement>(".wiki-sec-btn")!;
  const menu = bar.querySelector<HTMLOListElement>(".wiki-sec-menu")!;
  const nEl = bar.querySelector<HTMLElement>(".wiki-sec-n")!;
  const tEl = bar.querySelector<HTMLElement>(".wiki-sec-t")!;
  const fill = bar.querySelector<HTMLElement>(".wiki-sec-bar i")!;
  const m: Mounted = { article, wrap, bar, sections: [], cur: -1, frame: 0, dirty: true, teardown: () => {} };

  const rebuild = (): void => {
    const next = isVisible(article) ? sectionTargets(article, isVisible) : [];
    const same = next.length === m.sections.length && next.every((s, k) => s === m.sections[k]);
    if (same) return;
    m.sections = next;
    m.cur = -1;
    menu.innerHTML = "";
    next.forEach((s, k) => {
      const li = document.createElement("li");
      li.setAttribute("role", "none");
      const item = document.createElement("button");
      item.type = "button";
      item.className = "wiki-sec-item";
      item.setAttribute("role", "menuitem");
      item.tabIndex = -1;
      item.dataset.sec = String(k);
      item.innerHTML = `<span class="wiki-sec-k" aria-hidden="true"></span>`;
      item.firstElementChild!.textContent = String(k + 1);
      item.append(document.createTextNode(sectionTitle(s)));
      li.append(item);
      menu.append(li);
    });
    if (next.length < SECTION_BAR_MIN) closeMenu(false);
  };

  let lastWidth = "";
  // `top` is the anchor's viewport top when pinned: a reader's scroll moves it,
  // while a layout shift the browser's scroll anchoring absorbs does not (the
  // hash load's scrollTop moved 961 → 964 after the reveal, measured in e2e).
  let pin: { el: Element; anchor: Element; top: number } | null = null;
  let revealed: Element | null = null;
  const paint = (): void => {
    m.frame = 0;
    if (m.dirty) {
      m.dirty = false;
      rebuild();
    }
    const n = m.sections.length;
    const show = n >= SECTION_BAR_MIN;
    if (bar.hidden === show) bar.hidden = !show;
    if (!show) {
      revealed = null;
      return;
    }
    const box = wrap.getBoundingClientRect();
    const max = wrap.scrollHeight - wrap.clientHeight;
    const tops = m.sections.map((s) => s.getBoundingClientRect().top);
    let cur = currentSection(tops, box.top + READ_LINE, wrap.scrollTop, max, box.bottom);
    // A revealed element (a hash, a card chip) may sit where the pane cannot
    // bring it to the top: its section is current until the pane scrolls.
    if (revealed) {
      if (m.sections.length) {
        pin = { el: m.sections[sectionHolding(m.sections, revealed)]!, anchor: revealed, top: revealed.getBoundingClientRect().top };
      }
      revealed = null;
    }
    // A jump near the page's foot cannot scroll its section to the top: the
    // picked section stays current until the pane scrolls again.
    const pinned = pin && Math.abs(pin.anchor.getBoundingClientRect().top - pin.top) <= 2 ? m.sections.indexOf(pin.el) : -1;
    if (pinned >= 0) cur = pinned;
    else pin = null;
    if (cur !== m.cur) {
      m.cur = cur;
      nEl.textContent = `${cur + 1}/${n}`;
      tEl.textContent = sectionTitle(m.sections[cur]!);
      menu.querySelectorAll(".wiki-sec-item").forEach((it, k) => {
        if (k === cur) it.setAttribute("aria-current", "location");
        else it.removeAttribute("aria-current");
      });
    }
    const width = `${(max > 0 ? Math.min(1, wrap.scrollTop / max) * 100 : 0).toFixed(1)}%`;
    // Compared with the last written string: the style reads back normalised (`0%`).
    if (width !== lastWidth) fill.style.width = lastWidth = width;
  };
  const schedule = (): void => {
    if (!m.frame) m.frame = requestAnimationFrame(paint);
  };
  // What can change the list (a lens switch, a fold, a resize, the pane's
  // class) marks it dirty; a scroll only re-reads the positions.
  const relist = (): void => {
    m.dirty = true;
    schedule();
  };

  const items = (): HTMLElement[] => Array.from(menu.querySelectorAll<HTMLElement>(".wiki-sec-item"));
  const onOutside = (e: Event): void => {
    if (!bar.contains(e.target as Node)) closeMenu(false);
  };
  function openMenu(): void {
    if (!menu.hidden) return;
    menu.hidden = false;
    bar.classList.add("open");
    btn.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onOutside, true);
    (items()[Math.max(0, m.cur)] ?? items()[0])?.focus();
  }
  function closeMenu(refocus: boolean): void {
    document.removeEventListener("pointerdown", onOutside, true);
    if (menu.hidden) return;
    menu.hidden = true;
    bar.classList.remove("open");
    btn.setAttribute("aria-expanded", "false");
    if (refocus) btn.focus();
  }
  const jump = (k: number): void => {
    const target = m.sections[k];
    closeMenu(false);
    if (!target) return;
    // The fold a summary heads, and any fold around the target, open first.
    for (let d = target.closest("details"); d; d = d.parentElement?.closest("details") ?? null) d.open = true;
    wrap.scrollTop += target.getBoundingClientRect().top - wrap.getBoundingClientRect().top - JUMP_GAP;
    pin = { el: target, anchor: target, top: target.getBoundingClientRect().top };
    if (target.tagName !== "SUMMARY" && !target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    (target as HTMLElement).focus({ preventScroll: true });
    schedule();
  };

  btn.addEventListener("click", () => (menu.hidden ? openMenu() : closeMenu(true)));
  menu.addEventListener("click", (e) => {
    const it = (e.target as Element).closest<HTMLElement>(".wiki-sec-item");
    if (it) jump(Number(it.dataset.sec));
  });
  // On the host, which outlives this mount: teardown removes it.
  const onKey = (e: KeyboardEvent): void => {
    if (menu.hidden) return;
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    let to = -1;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(true);
      return;
    }
    if (e.key === "ArrowDown") to = (at + 1) % list.length;
    else if (e.key === "ArrowUp") to = (at - 1 + list.length) % list.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = list.length - 1;
    else if (e.key === "Tab") closeMenu(false);
    if (to < 0) return;
    e.preventDefault();
    list[to]!.focus();
  };
  bar.addEventListener("keydown", onKey);

  wrap.addEventListener("scroll", schedule, { passive: true });
  article.addEventListener("toggle", relist, true);
  // Fired before the reveal opens folds and scrolls: read on the next frame.
  const onReveal = (e: Event): void => {
    revealed = e.target as Element;
    schedule();
  };
  article.addEventListener(REVEAL_EVENT, onReveal);
  const lens = new MutationObserver(relist);
  lens.observe(article, { attributes: true, attributeFilter: ["class"] });
  // The article leaves the pane (another view), or the pane's class changes (graph).
  const pane = new MutationObserver(() => {
    if (!article.isConnected || article.parentElement !== wrap) unmountSectionBar();
    else relist();
  });
  pane.observe(wrap, { childList: true, attributes: true, attributeFilter: ["class"] });
  const sizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(relist);
  sizes?.observe(wrap);
  sizes?.observe(article);

  m.teardown = () => {
    if (m.frame) cancelAnimationFrame(m.frame);
    m.frame = 0;
    wrap.removeEventListener("scroll", schedule);
    article.removeEventListener("toggle", relist, true);
    article.removeEventListener(REVEAL_EVENT, onReveal);
    // A menu left open by a navigation closes with its mount.
    closeMenu(false);
    bar.removeEventListener("keydown", onKey);
    lens.disconnect();
    pane.disconnect();
    sizes?.disconnect();
    bar.hidden = true;
    bar.classList.remove("open");
    bar.innerHTML = "";
  };
  mounted = m;
  paint();
}

/** The bar's styles: tokens only, so a theme or palette flip restyles it. */
export function sectionBarCss(): string {
  return `
    .wiki-sec {
      flex-shrink: 0; position: relative; display: flex; align-items: center; gap: 10px;
      padding: 5px 24px 6px; border-bottom: 1px solid var(--border-primary);
      font-size: 12.5px; line-height: 1.3; color: var(--text-muted);
    }
    .wiki-sec[hidden] { display: none; }
    .wiki-sec-btn {
      all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; gap: 6px; align-items: center;
      min-width: 0; max-width: 72%; padding: 2px 6px; margin-left: -6px; border-radius: 6px;
    }
    .wiki-sec-btn:hover { background: var(--tint-neutral); }
    .wiki-sec-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .wiki-sec-n { font-variant-numeric: tabular-nums; color: var(--accent-light); font-weight: 650; flex-shrink: 0; }
    .wiki-sec-t { color: var(--text-primary); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .wiki-sec-caret { color: var(--text-muted); flex-shrink: 0; }
    .wiki-sec-bar { flex: 1; height: 3px; border-radius: 2px; background: var(--border-primary); overflow: hidden; }
    .wiki-sec-bar i { display: block; height: 100%; width: 0; background: var(--accent); }
    .wiki-sec-menu {
      position: absolute; top: calc(100% + 2px); left: 18px; z-index: 50; min-width: 300px; max-width: min(560px, calc(100% - 36px));
      max-height: 60vh; overflow-y: auto; margin: 0; padding: 6px 0; list-style: none;
      background: var(--bg-panel); border: 1px solid var(--border-primary); border-radius: 8px;
      box-shadow: 0 8px 22px rgba(0, 0, 0, .18);
    }
    .wiki-sec-menu[hidden] { display: none; }
    .wiki-sec-item {
      all: unset; box-sizing: border-box; display: flex; gap: 8px; width: 100%; padding: 5px 12px; cursor: pointer;
      color: var(--text-primary);
    }
    .wiki-sec-k { color: var(--text-muted); font-variant-numeric: tabular-nums; min-width: 1.6em; text-align: right; flex-shrink: 0; }
    .wiki-sec-item[aria-current] { color: var(--accent-light); font-weight: 650; }
    .wiki-sec-item:hover, .wiki-sec-item:focus-visible { background: var(--tint-neutral); outline: none; }
    /* Above phone width the breadcrumb and a shown bar are one head with the
       bar's divider only; the breadcrumb's tucks away with half its foot pad. */
    @media (min-width: 721px) {
      .wiki-breadcrumb:has(+ .wiki-sec:not([hidden])) { border-bottom-width: 0; padding-bottom: 4px; }
    }
    /* At phone width the progress becomes a line along the bar's foot, so the
       title keeps the row. */
    @media (max-width: 720px) {
      .wiki-sec { padding: 5px 14px 7px; }
      .wiki-sec-btn { max-width: 100%; }
      .wiki-sec-bar { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; border-radius: 0; }
      .wiki-sec-menu { left: 8px; min-width: 0; width: calc(100% - 16px); max-width: none; }
    }
  `;
}
