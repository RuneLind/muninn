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
 *  1. **Chip expand.** Activating a chip inserts an evidence card after the block
 *     run containing its mark. The card's content is a CLONE of the appendix's
 *     matching `#fc-claim-N` section — the evidence lives on the page exactly
 *     once, rather than being stuffed into `data-` attributes on every chip
 *     (where arbitrary source/`Was:` markup would have to survive escaping).
 *  2. **Summary strip.** A toolbar above the article carrying the appendix's own
 *     rendered date + verdict counts (cloned from `summary.fc-strip`, never
 *     re-derived — one authority for the wording, including the "N not checked"
 *     count a deadline-truncated run leaves behind). A page with marks but NO
 *     appendix still gets the toolbar, toggle-only: without it those chips would
 *     be inert with no way to turn the layer off.
 *  3. **Layer toggle.** A button in that toolbar flips one class on the article
 *     container, hiding the tints, chips, cards, the toolbar's own summary and
 *     the appendix — the article must read clean underneath. CSS-class only;
 *     nothing is rebuilt, so toggling back restores the exact same DOM.
 *
 * Design mirrors the sibling enhancers (`code-tabs.ts`, `wiki-mermaid.ts`):
 * zero-cost on a page with no annotation, idempotent per container (an article
 * swap re-enhances the fresh node without double-binding), fail-soft (a chip
 * whose claim section is missing simply does nothing), and — deliberately —
 * DOM-free at import time, so the module can be unit-tested against a shim.
 */

import { enhanceCodeTabs } from "./code-tabs.ts";

const ENHANCED = "data-fc-enhanced";
const LAYER_OFF = "fc-off";

/** Tags that occupy their own line in the reader's article markup. Used to find
 *  the end of an inline run — `formatWebHtml` emits NO `<p>`, so top-level prose
 *  is bare text nodes with inline `.fc-mark`/`.fc-chip` as DIRECT children of
 *  the layer: without this, "the block containing the chip" resolves to the chip
 *  itself and the card is spliced mid-sentence. The block `Fact` form renders as
 *  a `div`, so no computed-style probe is needed. */
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DETAILS", "DIALOG", "DD", "DIV",
  "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2",
  "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE",
  "SECTION", "TABLE", "UL",
]);

/** The single open evidence card. One at a time by design: two cards for the same
 *  paragraph would push the prose apart and make the article unreadable, and
 *  "clicking another chip replaces it" is the behaviour the design asks for. */
let openCard: { card: HTMLElement; chip: HTMLElement } | null = null;

/** The document keydown listener is registered on first enhance, never at module
 *  scope — importing this module must not touch `document`. */
let keydownBound = false;

function isBlockNode(node: Node | null): boolean {
  return !!node && node.nodeType === 1 && BLOCK_TAGS.has((node as Element).tagName.toUpperCase());
}

/**
 * Where the evidence card goes, expressed as the layer child to insert BEFORE
 * (`null` ⇒ append at the end of the layer).
 *
 * The walk first finds the layer-level node owning `el`. When that node is a
 * real block (a list, a table, a callout `div`) the card follows it, so a chip
 * inside a table cell still gets a full-width card rather than one wedged inside
 * the structure it annotates. When it is an INLINE element or a text node — the
 * common case, since top-level prose is unwrapped — we advance through the
 * following siblings to the next block, so the card lands after the whole inline
 * run instead of splitting the sentence the chip sits in.
 */
export function resolveInsertionPoint(el: Element, layer: Element): { before: Node | null } | null {
  let cur: Element | null = el;
  while (cur && cur.parentElement && cur.parentElement !== layer) cur = cur.parentElement;
  if (!cur || cur.parentElement !== layer) return null;
  if (isBlockNode(cur)) return { before: cur.nextSibling };
  let node: Node | null = cur.nextSibling;
  while (node && !isBlockNode(node)) node = node.nextSibling;
  return { before: node };
}

/** Replace every `h1`–`h6` in the clone with a `div role="heading"` carrying the
 *  same level. The card is inserted INTO the prose, and the reader's
 *  Explain-selection helper finds a selection's section by walking previous
 *  siblings for a heading tag — a real `<h3>❌ Claim 4/8 …</h3>` sitting in the
 *  article would be picked up as the section heading for everything after it. */
function demoteHeadings(clone: Element): void {
  const heads = Array.from(clone.querySelectorAll("h1,h2,h3,h4,h5,h6"));
  for (const h of heads) {
    const div = document.createElement("div");
    div.setAttribute("role", "heading");
    div.setAttribute("aria-level", h.tagName.slice(1));
    if (h.className) div.className = h.className;
    while (h.firstChild) div.appendChild(h.firstChild);
    h.parentNode?.replaceChild(div, h);
  }
}

/** The verdict suffix (`ok`/`warn`/`bad`/`unknown`) carried by a chip, so the
 *  card's left rail can be tinted to match the claim instead of a flat accent. */
export function chipVerdict(chip: Element): string {
  for (const v of ["ok", "warn", "bad", "unknown"]) {
    if (chip.classList && chip.classList.contains("fc-chip-" + v)) return v;
  }
  return "unknown";
}

/** Build the evidence card from the appendix section. Every id is stripped from
 *  the clone — the original `#fc-claim-N` must stay the unique addressable one —
 *  and the card gets its own id so the chip can point `aria-controls` at it. */
export function buildCard(n: string, section: Element, verdict: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "fc-card fc-card-" + verdict;
  card.id = "fc-card-" + n;
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
  // A cloned CodeTabs widget carries the enhancer's idempotency marker but none
  // of its listeners, so it would be permanently stuck on its first tab.
  clone.removeAttribute("data-code-tabs-enhanced");
  clone
    .querySelectorAll("[data-code-tabs-enhanced]")
    .forEach((el) => el.removeAttribute("data-code-tabs-enhanced"));
  demoteHeadings(clone);
  body.appendChild(clone);

  card.append(close, body);
  enhanceCodeTabs(card);
  return card;
}

/** Close the open card, optionally returning focus to the chip that owns it
 *  (keyboard users must not be dropped at the top of the document). Focus is
 *  restored WITHOUT scrolling unless the close came from the keyboard inside the
 *  card — a mouse close must not yank the viewport to a chip far up the page. */
function closeCard(focusChip: boolean, keyboardFromCard = false): void {
  if (!openCard) return;
  const { card, chip } = openCard;
  openCard = null;
  card.remove();
  chip.setAttribute("aria-expanded", "false");
  chip.removeAttribute("aria-controls");
  if (focusChip && chip.isConnected) {
    if (keyboardFromCard) chip.focus();
    else chip.focus({ preventScroll: true });
  }
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
  const point = resolveInsertionPoint(chip, layer);
  if (!point) return;
  const card = buildCard(n, section, chipVerdict(chip));
  layer.insertBefore(card, point.before);
  chip.setAttribute("aria-expanded", "true");
  chip.setAttribute("aria-controls", card.id);
  openCard = { card, chip };
  chip.focus({ preventScroll: true });
  // The card can land well below the chip (a chip inside a wide table), so make
  // sure the evidence the reader just asked for is actually on screen.
  if (typeof card.scrollIntoView === "function") card.scrollIntoView({ block: "nearest" });
}

/** The toggle's own label carries its state, so it deliberately has NO
 *  `aria-pressed` — a toggle button with both announces "Hide…, pressed". */
export function toggleLabelText(off: boolean): string {
  return off ? "Show fact-check layer" : "Hide fact-check layer";
}

function setToggleLabel(btn: Element, off: boolean): void {
  btn.textContent = toggleLabelText(off);
}

/** Flip the whole layer. The open card is closed rather than merely hidden, so
 *  turning the layer back on doesn't restore a card whose chip the reader has
 *  long since forgotten clicking. */
function toggleLayer(layer: Element, btn: Element): void {
  closeCard(false);
  setToggleLabel(btn, layer.classList.toggle(LAYER_OFF));
}

/** The toolbar: the appendix's own summary line (when there IS an appendix),
 *  plus the layer toggle. On a page carrying marks but no `FactCheck` block
 *  there is no date and no counts to clone — but the toggle still ships, since
 *  otherwise those chips are inert with no way to turn them off. */
function buildToolbar(layer: Element): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "fc-toolbar";

  const strip = layer.querySelector(".fc-block > summary.fc-strip");
  if (strip) {
    const summary = document.createElement("span");
    summary.className = "fc-toolbar-summary";
    strip.childNodes.forEach((node) => summary.appendChild(node.cloneNode(true)));
    bar.appendChild(summary);
  }

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "fc-toolbar-toggle";
  setToggleLabel(toggle, false);
  bar.appendChild(toggle);
  return bar;
}

/** Escape closes the open card — but ONLY when focus is already inside the
 *  annotation (the card, its chip, or the article). Acting unconditionally stole
 *  focus from the reader's search box / Ask textarea and scrolled the page to a
 *  chip the reader wasn't looking at. */
function onDocumentKeydown(e: KeyboardEvent): void {
  if (e.key !== "Escape" || !openCard) return;
  const { card, chip } = openCard;
  const active = document.activeElement;
  if (!active) return;
  const layer = card.closest(".wiki-article");
  const inCard = card.contains(active);
  const inScope = inCard || chip === active || chip.contains(active) || !!layer?.contains(active);
  if (!inScope) return;
  closeCard(true, inCard);
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

  layer.insertBefore(buildToolbar(layer), layer.firstChild);

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

  if (!keydownBound) {
    keydownBound = true;
    document.addEventListener("keydown", onDocumentKeydown as EventListener);
  }
}
