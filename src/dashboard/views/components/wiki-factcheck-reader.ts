/// <reference lib="dom" />
/**
 * The /wiki reader's INTERACTIVE layer over the already-server-rendered
 * fact-check annotation (`web-format.ts`: `.fc-mark` + `.fc-chip` in the prose,
 * a collapsed `<details class="fc-block">` appendix of `<section id="fc-claim-N">`
 * evidence at the foot).
 *
 * Three behaviours, all additive — with this module absent the page still shows
 * every mark, every chip and the appendix, so the annotation degrades to
 * "readable, just not expandable" rather than breaking:
 *
 *  1. **Chip expand.** Activating a chip inserts an evidence card under the block
 *     containing its mark. The card's content is a CLONE of the appendix's
 *     matching `#fc-claim-N` section — the evidence lives on the page exactly
 *     once, rather than being stuffed into `data-` attributes on every chip
 *     (where arbitrary source/`Was:` markup would have to survive escaping).
 *  2. **Summary strip.** A toolbar above the article carrying the appendix's own
 *     rendered date + verdict counts (cloned from `summary.fc-strip`, never
 *     re-derived — one authority for the wording, including the "N not checked"
 *     count a deadline-truncated run leaves behind). Only on a page that HAS a
 *     `FactCheck` appendix.
 *  3. **Layer toggle.** A button in that toolbar flips one class on the article
 *     container, hiding the tints, chips, cards and appendix — the article must
 *     read clean underneath. CSS-class only; nothing is rebuilt, so toggling back
 *     restores the exact same DOM.
 *
 * Design mirrors the sibling enhancers (`code-tabs.ts`, `wiki-mermaid.ts`):
 * zero-cost on a page with no annotation, idempotent per container (an article
 * swap re-enhances the fresh node without double-binding), and fail-soft (a chip
 * whose claim section is missing simply does nothing).
 */

const ENHANCED = "data-fc-enhanced";
const LAYER_OFF = "fc-off";

/** The single open evidence card. One at a time by design: two cards for the same
 *  paragraph would push the prose apart and make the article unreadable, and
 *  "clicking another chip replaces it" is the behaviour the design asks for. */
let openCard: { card: HTMLElement; chip: HTMLElement } | null = null;

/** Close the open card, optionally returning focus to the chip that owns it
 *  (keyboard users must not be dropped at the top of the document). */
function closeCard(focusChip: boolean): void {
  if (!openCard) return;
  const { card, chip } = openCard;
  openCard = null;
  card.remove();
  chip.setAttribute("aria-expanded", "false");
  if (focusChip && chip.isConnected) chip.focus();
}

/** The article-level block containing `el` — the node whose parent IS the layer
 *  container. The card is inserted after it, so a chip inside a table cell, a
 *  callout or a list item still gets a full-width card rather than one wedged
 *  inside the structure it annotates. */
function topLevelBlock(el: Element, layer: Element): Element | null {
  let cur: Element | null = el;
  while (cur && cur.parentElement && cur.parentElement !== layer) cur = cur.parentElement;
  return cur && cur.parentElement === layer ? cur : null;
}

/** Build the evidence card from the appendix section. Every id is stripped from
 *  the clone — the original `#fc-claim-N` must stay the unique addressable one. */
function buildCard(n: string, section: Element): HTMLElement {
  const card = document.createElement("div");
  card.className = "fc-card";
  card.setAttribute("data-fc-card", n);
  card.setAttribute("role", "region");
  card.setAttribute("aria-label", "Evidence for claim " + n);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "fc-card-close";
  close.setAttribute("aria-label", "Close evidence");
  close.textContent = "✕";

  const body = document.createElement("div");
  body.className = "fc-card-body";
  const clone = section.cloneNode(true) as HTMLElement;
  clone.removeAttribute("id");
  clone.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
  body.appendChild(clone);

  card.append(close, body);
  return card;
}

/** Chip → card. A chip with no `data-fact`, or one whose claim section isn't on
 *  the page, closes whatever was open and otherwise does nothing: the pairing is
 *  one-way (a chip always has a section), but a dropped claim must degrade
 *  quietly rather than throw inside a click handler. */
function toggleChip(chip: HTMLElement, layer: Element): void {
  if (openCard && openCard.chip === chip) {
    closeCard(true);
    return;
  }
  closeCard(false);
  const n = chip.getAttribute("data-fact");
  if (!n) return;
  const section = document.getElementById("fc-claim-" + n);
  if (!section || !layer.contains(section)) return;
  const anchor = topLevelBlock(chip, layer) ?? chip.parentElement;
  if (!anchor) return;
  const card = buildCard(n, section);
  anchor.insertAdjacentElement("afterend", card);
  chip.setAttribute("aria-expanded", "true");
  openCard = { card, chip };
  chip.focus();
}

function setToggleLabel(btn: Element, off: boolean): void {
  btn.setAttribute("aria-pressed", off ? "false" : "true");
  btn.textContent = off ? "Show fact-check layer" : "Hide fact-check layer";
}

/** Flip the whole layer. The open card is closed rather than merely hidden, so
 *  turning the layer back on doesn't restore a card whose chip the reader has
 *  long since forgotten clicking. */
function toggleLayer(layer: Element, btn: Element): void {
  closeCard(false);
  setToggleLabel(btn, layer.classList.toggle(LAYER_OFF));
}

/** The toolbar: the appendix's own summary line, plus the layer toggle. Rendered
 *  only when the page carries a `FactCheck` appendix — on a page with stray marks
 *  and no appendix there is no date, no counts and nothing worth toggling. */
function buildToolbar(layer: Element): HTMLElement | null {
  const strip = layer.querySelector(".fc-block > summary.fc-strip");
  if (!strip) return null;

  const bar = document.createElement("div");
  bar.className = "fc-toolbar";

  const summary = document.createElement("span");
  summary.className = "fc-toolbar-summary";
  strip.childNodes.forEach((node) => summary.appendChild(node.cloneNode(true)));

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "fc-toolbar-toggle";
  setToggleLabel(toggle, false);

  bar.append(summary, toggle);
  return bar;
}

/**
 * Wire the fact-check layer inside `root` (the reader's `#articleWrap`).
 * No-op when the article carries no chips and no appendix.
 */
export function enhanceFactCheck(root: ParentNode): void {
  // A previous article's card is gone with its DOM; drop the stale reference
  // before anything can try to focus a detached chip.
  if (openCard && !openCard.card.isConnected) openCard = null;

  const layer = root.querySelector(".wiki-article");
  if (!layer || layer.getAttribute(ENHANCED)) return;
  if (!layer.querySelector(".fc-chip") && !layer.querySelector(".fc-block")) return;
  layer.setAttribute(ENHANCED, "1");

  const bar = buildToolbar(layer);
  if (bar) layer.insertBefore(bar, layer.firstChild);

  layer.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (!t || !t.closest) return;
    const toggle = t.closest(".fc-toolbar-toggle");
    if (toggle && layer.contains(toggle)) {
      toggleLayer(layer, toggle);
      return;
    }
    if (t.closest(".fc-card-close")) {
      closeCard(true);
      return;
    }
    const chip = t.closest(".fc-chip") as HTMLElement | null;
    if (chip && layer.contains(chip)) toggleChip(chip, layer);
  });
}

// Escape closes the open card wherever focus sits — registered once at module
// load (the reader's own Explain-pill dismissal listener is a separate handler;
// both are free to run).
document.addEventListener("keydown", (e) => {
  if ((e as KeyboardEvent).key === "Escape") closeCard(true);
});
