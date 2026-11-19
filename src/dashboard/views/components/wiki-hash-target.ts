/// <reference lib="dom" />
/**
 * A `#fragment` that names an element inside the rendered article: open every
 * closed `<details>` around it (a `<Fold>`, a resolved `<Callout>`, a query's
 * SQL), then scroll it into view. The article renders after the page load, so
 * the browser's own fragment scroll has already found nothing by then.
 *
 * Generic: any id in the article, not only a `<Query>` card.
 */

/** Dispatched (bubbling) on the element a hash names, before the folds open:
 *  a filter that hid it (the Query explorer) shows it again. */
export const REVEAL_EVENT = "wiki:reveal";

/** Set on the target for one tint animation. `:target` cannot do this on a
 *  fresh load: the article renders after the browser matched the hash. */
export const HASH_FLASH_CLASS = "wiki-hash-flash";

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
  const el = document.getElementById(id);
  if (!el || !root.contains(el)) return false;
  revealElement(root, el);
  return true;
}

/**
 * Every path that reveals an element goes through here (D3): a `#id` in the
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

/** The nearest ancestor of `el` that scrolls, else the document's scroller. */
function scrollerOf(el: Element): Element | null {
  for (let p: Element | null = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if ((y === "auto" || y === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return document.scrollingElement;
}

/**
 * Reveal a stretch of text, not an element: the same reveal event and fold
 * opening as {@link revealElement}, then the range's own box is scrolled into
 * its scroller (a third down, or its top when it is taller) and the range alone
 * is highlighted for a moment through the CSS Custom Highlight API, which
 * changes nothing in the DOM. Without that API, `fallback` (the smallest block
 * holding the range, when there is one) gets the element flash instead.
 */
export function revealRange(root: Element, range: Range, fallback: Element | null = null): void {
  const start = range.startContainer.nodeType === 1 ? (range.startContainer as Element) : range.startContainer.parentElement;
  if (!start) return;
  start.dispatchEvent(new CustomEvent(REVEAL_EVENT, { bubbles: true }));
  for (const n of [range.startContainer, range.endContainer]) {
    for (let p: Element | null = n.nodeType === 1 ? (n as Element) : n.parentElement; p && p !== root; p = p.parentElement) {
      if (p instanceof HTMLDetailsElement) p.open = true;
    }
  }
  const box = range.getBoundingClientRect();
  const sc = scrollerOf(start);
  if (sc) {
    const doc = sc === document.scrollingElement;
    const top = doc ? 0 : sc.getBoundingClientRect().top;
    const height = doc ? window.innerHeight : sc.clientHeight;
    const offset = Math.max(0, Math.min((height - box.height) / 2, height / 3));
    sc.scrollTop += box.top - top - offset;
  }
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
