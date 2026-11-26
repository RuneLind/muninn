/// <reference lib="dom" />
/**
 * A `#fragment` that names an element inside the rendered article: open every
 * closed `<details>` around it (a `<Fold>`, a resolved `<Callout>`, a query's
 * SQL), then scroll it into view. The article renders after the page load, so
 * the browser's own fragment scroll has already found nothing by then.
 *
 * Generic: any id in the article, not only a `<Query>` card.
 */

import { anchorSlug } from "../../../format/query-block.ts";

/** Dispatched (bubbling) on the element a hash names, before the folds open:
 *  a filter that hid it (the Query explorer) shows it again. */
export const REVEAL_EVENT = "wiki:reveal";

/** Set on the target for one tint animation. `:target` cannot do this on a
 *  fresh load: the article renders after the browser matched the hash. */
export const HASH_FLASH_CLASS = "wiki-hash-flash";

/** GitHub's slug for a heading, the id `ensureId` (`wiki-ref-links.ts`) gives
 *  a heading or an untitled fold: lower case, punctuation dropped, each white
 *  space a `-`, so it can lead or trail with one (`🎯 Next Steps` → `-next-steps`). */
export function headingSlug(text: string): string {
  return text
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** The ids a written fragment may name, in the order tried: as written, lower
 *  case, then each producer's slug of it as source text. A Query card,
 *  DecisionLog item or Fold is `anchorSlug` of its id, a case row `case-` and a
 *  RunChecklist step `<checklist anchor>-` before one, so a link to those
 *  writes the prefix; a Question card keeps a safe id lower-cased, dots and
 *  spaces included (not NFC); a heading is `headingSlug` of its text. The
 *  server passes a wikilink's `#anchor` through as written, since only the
 *  page knows which form exists. */
function hashCandidates(id: string): string[] {
  return [...new Set([id, id.toLowerCase(), anchorSlug(id), headingSlug(id)])].filter(Boolean);
}

/** The element inside `root` that a fragment's id names, by the first of its
 *  {@link hashCandidates} the page has; an id outside `root` (page chrome) never counts. */
export function hashTarget(root: Element, id: string): Element | null {
  for (const c of hashCandidates(id)) {
    const el = document.getElementById(c);
    if (el && root.contains(el)) return el;
  }
  return null;
}

/** Resolve a `#fragment` to an element inside `root` and reveal it
 *  ({@link revealElement}). Returns whether a target was found. */
export function revealHashTarget(root: Element, hash: string = location.hash): boolean {
  if (hash.length < 2) return false;
  let id: string;
  try {
    id = decodeURIComponent(hash.slice(1));
  } catch {
    return false;
  }
  const el = hashTarget(root, id);
  if (!el) return false;
  revealElement(root, el);
  return true;
}

/**
 * Every path that reveals an element goes through here (D3), except the Discuss
 * chip, which reveals a text range through {@link revealRange}: a `#id` in the
 * URL, a bare id link, a card's chip, a header pill. It dispatches
 * {@link REVEAL_EVENT} on the element first, so a filter or a lens that hid it
 * shows it again, then opens the folds around it, scrolls and flashes.
 */
export function revealElement(root: Element, el: Element): void {
  // A filter that hid the target (the Query explorer, the Overview lens)
  // shows it again first.
  el.dispatchEvent(new CustomEvent(REVEAL_EVENT, { bubbles: true }));
  // The target itself too: a `<Fold>` is addressed by its own id.
  for (let p: Element | null = el; p && p !== root; p = p.parentElement) {
    if (p instanceof HTMLDetailsElement) p.open = true;
  }
  el.scrollIntoView({ block: "start" });
  el.classList.remove(HASH_FLASH_CLASS);
  void (el as HTMLElement).offsetWidth; // restart the animation on a repeat
  el.classList.add(HASH_FLASH_CLASS);
  // Its own animation only: animationend bubbles up from any descendant.
  const end = (e: Event) => {
    if (e.target !== el) return;
    el.classList.remove(HASH_FLASH_CLASS);
    el.removeEventListener("animationend", end);
  };
  el.addEventListener("animationend", end);
}

/** The CSS highlight a revealed range is painted with (`::highlight(…)`). */
export const RANGE_FLASH_HIGHLIGHT = "wiki-range-flash";
/** How long the highlight stays, the element flash's length. */
const RANGE_FLASH_MS = 2000;
let rangeFlashTimer: ReturnType<typeof setTimeout> | null = null;

/** Whether `el` scrolls on that axis: an `auto`/`scroll`/`overlay` overflow with more to show. */
function scrollsOn(el: Element, axis: "x" | "y"): boolean {
  const o = axis === "y" ? getComputedStyle(el).overflowY : getComputedStyle(el).overflowX;
  if (o !== "auto" && o !== "scroll" && o !== "overlay") return false;
  return axis === "y" ? el.scrollHeight > el.clientHeight : el.scrollWidth > el.clientWidth;
}

/** How far to move a view `[lo, hi]` so `[a, b]` is inside it: 0 when it is,
 *  else the least move, the start winning when `[a, b]` is the longer. */
function nearestDelta(a: number, b: number, lo: number, hi: number): number {
  if (a >= lo && b <= hi) return 0;
  if (a < lo || b - a > hi - lo) return a - lo;
  return b - hi;
}

/**
 * The element the reveal event goes out from: the passage's own parent, or,
 * for text directly under `root` (`formatWebHtml` writes no `<p>`), the
 * nearest `<br>` or heading before it on that level; failing those, the
 * nearest element before it, then after it. That target can sit in the section
 * before a top-level Fold the text follows, and the fallback can be a block a
 * lens hides (a fence): both open follow-ups on the plan page. Never `root`: a listener that pins the
 * section holding the target reads the article as the first section.
 */
function revealTarget(root: Element, node: Node): Element | null {
  const own = node.nodeType === 1 ? (node as Element) : node.parentElement;
  if (own && own !== root) return own;
  let top: Node = node;
  while (top.parentNode && top.parentNode !== root) top = top.parentNode;
  let before: Element | null = null;
  for (let p = top.previousSibling; p; p = p.previousSibling) {
    if (p.nodeType !== 1) continue;
    const el = p as Element;
    if (el.tagName === "BR" || /^H[1-6]$/.test(el.tagName)) return el;
    before ??= el;
  }
  if (before) return before;
  for (let n = top.nextSibling; n; n = n.nextSibling) if (n.nodeType === 1) return n as Element;
  return null;
}

/**
 * Bring `range`'s own box into every scroller around it, innermost first and
 * on both axes, as `scrollIntoView` does for an element: the least move in an
 * inner scroller (a `.query-table-wrap`, a wide table's `.tablewrap`), and in
 * the first scroller around `root` (the article pane) the box a third down, or
 * centred when it is taller than a third (its top when taller than the pane). A sticky table header is not
 * allowed for (an open follow-up). The box is measured again after each move.
 */
function scrollRangeIntoView(root: Element, range: Range): void {
  const scrollers: Element[] = [];
  const startEl = range.startContainer.nodeType === 1 ? (range.startContainer as Element) : range.startContainer.parentElement;
  for (let p = startEl; p; p = p.parentElement) {
    if (p === document.scrollingElement || p === document.body) continue;
    if (scrollsOn(p, "x") || scrollsOn(p, "y")) scrollers.push(p);
  }
  const pane = scrollers.find((s) => s.contains(root) && s !== root) ?? null;
  for (const sc of scrollers) {
    const box = range.getBoundingClientRect();
    const r = sc.getBoundingClientRect();
    const top = r.top + sc.clientTop;
    const left = r.left + sc.clientLeft;
    if (scrollsOn(sc, "y")) {
      if (sc === pane) {
        const offset = Math.max(0, Math.min((sc.clientHeight - box.height) / 2, sc.clientHeight / 3));
        sc.scrollTop += box.top - top - offset;
      } else sc.scrollTop += nearestDelta(box.top, box.bottom, top, top + sc.clientHeight);
    }
    if (scrollsOn(sc, "x")) sc.scrollLeft += nearestDelta(box.left, box.right, left, left + sc.clientWidth);
  }
  // The document itself, when no pane holds the article.
  if (!pane) {
    const box = range.getBoundingClientRect();
    const offset = Math.max(0, Math.min((window.innerHeight - box.height) / 2, window.innerHeight / 3));
    const dx = nearestDelta(box.left, box.right, 0, document.documentElement.clientWidth);
    window.scrollBy(dx, box.top - offset);
  }
}

/**
 * Reveal a stretch of text, not an element: the reveal event (from the element
 * at the passage, {@link revealTarget}) and the fold opening of
 * {@link revealElement}, then the range's own box is scrolled into every
 * scroller around it on both axes ({@link scrollRangeIntoView}) and the range
 * alone is highlighted for a moment through the CSS Custom Highlight API,
 * which changes nothing in the DOM. Without that API, `fallback` (the smallest
 * block holding the range, when there is one) gets the element flash instead.
 */
export function revealRange(root: Element, range: Range, fallback: Element | null = null): void {
  revealTarget(root, range.startContainer)?.dispatchEvent(new CustomEvent(REVEAL_EVENT, { bubbles: true }));
  for (const n of [range.startContainer, range.endContainer]) {
    for (let p: Element | null = n.nodeType === 1 ? (n as Element) : n.parentElement; p && p !== root; p = p.parentElement) {
      if (p instanceof HTMLDetailsElement) p.open = true;
    }
  }
  scrollRangeIntoView(root, range);
  // Map-like in the browser; the dom lib types it without the Map methods.
  const highlights = (globalThis as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
  const Highlight = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (highlights && Highlight) {
    const h = new Highlight(range.cloneRange());
    highlights.set(RANGE_FLASH_HIGHLIGHT, h);
    if (rangeFlashTimer !== null) clearTimeout(rangeFlashTimer);
    rangeFlashTimer = setTimeout(() => {
      rangeFlashTimer = null;
      if (highlights.get(RANGE_FLASH_HIGHLIGHT) === h) highlights.delete(RANGE_FLASH_HIGHLIGHT);
    }, RANGE_FLASH_MS);
  } else if (fallback) {
    fallback.classList.remove(HASH_FLASH_CLASS);
    void (fallback as HTMLElement).offsetWidth;
    fallback.classList.add(HASH_FLASH_CLASS);
    const end = (e: Event) => {
      if (e.target !== fallback) return;
      fallback.classList.remove(HASH_FLASH_CLASS);
      fallback.removeEventListener("animationend", end);
    };
    fallback.addEventListener("animationend", end);
  }
}
