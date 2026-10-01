/// <reference lib="dom" />
/**
 * A `#fragment` that names an element inside the rendered article: open every
 * closed `<details>` around it (a `<Fold>`, a resolved `<Callout>`, a query's
 * SQL), then scroll it into view. The article renders after the page load, so
 * the browser's own fragment scroll has already found nothing by then.
 *
 * Generic: any id in the article, not only a `<Query>` card. Returns whether a
 * target was found.
 */

/** Dispatched (bubbling) on the element a hash names, before the folds open:
 *  a filter that hid it (the Query explorer) shows it again. */
export const REVEAL_EVENT = "wiki:reveal";

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
  // A filter that hid the target (the Query explorer) shows it again first.
  el.dispatchEvent(new CustomEvent(REVEAL_EVENT, { bubbles: true }));
  for (let p = el.parentElement; p && p !== root; p = p.parentElement) {
    if (p instanceof HTMLDetailsElement) p.open = true;
  }
  el.scrollIntoView({ block: "start" });
  return true;
}
