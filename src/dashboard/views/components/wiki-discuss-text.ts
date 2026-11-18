/**
 * The text of the reader's article as Discuss counts it (mimir plan
 * muninn-wiki-discuss, P1): the selection's occurrence number, and the
 * heading above it. Pure DOM (no globals: the document comes from the nodes),
 * so a test drives it in a happy-dom `Window` of its own.
 *
 * The server locates the selection in the page source collapsed toward the
 * render (`src/wiki/discuss-locate.ts`). For the occurrence number to mean the
 * same thing on both sides, this reads the article as that collapse reads the
 * source: in authored order (a DecisionLog's items by `data-dl-order`, since the
 * reader moves them newest first), without what the reader adds and the source
 * does not hold ({@link DISCUSS_TEXT_SKIP}). `wiki-discuss-parity.test.ts` holds
 * the two readings equal on a fixture page, and lists where they differ on purpose.
 */

import { DL_ORDER_ATTR, DL_SEP_ATTR, READER_ONLY_ATTR } from "../../../format/reader-lens.ts";
import { occurrenceIn } from "../../../wiki/locate-key.ts";
import { FACT_CHIP_SELECTOR, PEEK_CLASS } from "./wiki-ref-dom.ts";

/**
 * Elements whose text the source does not hold where the article shows it,
 * measured on real mimir and melosys-kode-wiki renders:
 *  - the reader's own additions: `data-reader-only`, every button (a
 *    fact-check chip's verdict, 🧭, toggles), live chips, a peek card, a
 *    glossary tooltip, the TL;DR and «More about this» labels, a lane's head,
 *    a question card's head, the Historic stamp, a chart's head and plot, a
 *    DeltaTable's change column, a Query card's head and SQL label;
 *  - text from a page's sibling files: a CaseBoard, a Query result;
 *  - copies of text that sits elsewhere in the source: the decision views
 *    (`dc-view`: the chain, the PR strip, the question grid);
 *  - text the source holds somewhere else: a `<Question>` card a Follow-up
 *    lane holds (`views` moves it there from its place in the source);
 *  - what the client redraws: a mermaid fence (an SVG once drawn), an Embed.
 * The server's collapse drops the source side of the last two, and keeps a
 * moved card where the source has it: a selection's text that also sits in a
 * moved card makes the two totals differ, and the locator falls back.
 */
export const DISCUSS_TEXT_SKIP = [
  `[${READER_ONLY_ATTR}]`,
  "button",
  "svg",
  "script",
  "style",
  "textarea",
  "input",
  FACT_CHIP_SELECTOR,
  `.${PEEK_CLASS}`,
  ".gl-tip",
  ".tldr-label",
  ".tldr-more > summary",
  ".nm-head",
  ".dc-view",
  ".q-head",
  ".q-for",
  ".historic-stamp",
  ".meter-value",
  ".vc-head",
  ".vc-plot",
  ".dt-delta",
  ".caseboard",
  ".query-head",
  ".query-sql > summary",
  ".query-result",
  ".query-table-wrap",
  ".rc-head",
  ".embed",
  "code.language-mermaid",
  ".mermaid",
].join(", ");

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** A boundary to stop reading at: a node and an offset into it, as a Range holds. */
export interface TextStop {
  node: Node;
  offset: number;
}

function childrenInOrder(el: Element): Node[] {
  const kids = Array.from(el.childNodes);
  if (kids.length > 1 && kids.every((k) => k.nodeType !== ELEMENT_NODE || (k as Element).hasAttribute(DL_ORDER_ATTR))) {
    const items = kids.filter((k): k is Element => k.nodeType === ELEMENT_NODE);
    if (items.length > 1) {
      const sorted = [...items].sort((x, y) => Number(x.getAttribute(DL_ORDER_ATTR)) - Number(y.getAttribute(DL_ORDER_ATTR)));
      return sorted;
    }
  }
  return kids;
}

/**
 * The article's text in authored order, up to `stop` when given. A stop inside
 * a skipped element ends the read at that element.
 */
export function discussText(root: Node, stop?: TextStop): string {
  return readText(root, stop).text;
}

/** A `<Question>` card the reader moved into a Follow-up lane, keyed by id, for
 *  each id a moved-card line (`p.q-moved[data-q-moved-ids]`) names: the card
 *  is read at that line, where the source has it, and not in the lane. A card
 *  no line names (one right after the lane that took it) is read in the lane,
 *  which is where the source has it too. */
function movedCards(root: Node): Map<string, Element> {
  const out = new Map<string, Element>();
  if (root.nodeType !== ELEMENT_NODE) return out;
  const el = root as Element;
  for (const stub of Array.from(el.querySelectorAll(`[${MOVED_IDS_ATTR}]`))) {
    for (const id of (stub.getAttribute(MOVED_IDS_ATTR) ?? "").split(/\s+/).filter(Boolean)) {
      const card = Array.from(el.querySelectorAll(".next-moves section.question[data-question-id]")).find((c) => c.getAttribute("data-question-id") === id);
      if (card) out.set(id, card);
    }
  }
  return out;
}

const MOVED_IDS_ATTR = "data-q-moved-ids";

function readText(root: Node, stop?: TextStop): { text: string; stopSkipped: boolean } {
  const out: string[] = [];
  let done = false;
  let stopSkipped = false;
  const moved = movedCards(root);
  const movedSet = new Set(moved.values());
  let fromStub = 0;
  const visit = (node: Node): void => {
    if (done) return;
    if (node.nodeType === TEXT_NODE) {
      const data = (node as Text).data;
      if (stop && stop.node === node) {
        out.push(data.slice(0, stop.offset));
        done = true;
        return;
      }
      out.push(data);
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    const el = node as Element;
    const ids = el.getAttribute(MOVED_IDS_ATTR);
    if (ids !== null) {
      fromStub++;
      for (const id of ids.split(/\s+/)) {
        const card = moved.get(id);
        if (card) visit(card);
        if (done) break;
      }
      fromStub--;
      return;
    }
    // Read at its line instead; a stop inside it is reached there.
    if (fromStub === 0 && movedSet.has(el)) return;
    if (el !== root && el.matches(DISCUSS_TEXT_SKIP)) {
      if (stop && (el === stop.node || el.contains(stop.node))) done = stopSkipped = true;
      return;
    }
    // A DecisionLog item's separator (` — `) is an attribute in the render
    // and text in the source: read it back, as `spellAsSource` does.
    const sep = el.getAttribute(DL_SEP_ATTR);
    if (sep) out.push(sep);
    const kids = childrenInOrder(el);
    if (stop && stop.node === el) {
      // An element boundary: the children before `offset`, in DOM order.
      const before = new Set<Node>(Array.from(el.childNodes).slice(0, stop.offset));
      for (const k of kids) if (before.has(k)) visit(k);
      done = true;
      return;
    }
    for (const k of kids) {
      visit(k);
      if (done) return;
    }
  };
  visit(root);
  return { text: out.join(""), stopSkipped };
}

/**
 * The selection's occurrence number in the article and the article's match
 * count, as `POST /api/wiki/discuss/handoff` takes them. `occurrence` is null
 * when the selection starts inside text this reading leaves out (a moved
 * question card, a peek): no count before it means anything then.
 */
export function selectionOccurrence(article: Element, range: Range, selection: string): { occurrence: number | null; total: number } {
  const before = readText(article, { node: range.startContainer, offset: range.startOffset });
  const counted = occurrenceIn(before.text, discussText(article), selection);
  return before.stopSkipped ? { occurrence: null, total: counted.total } : counted;
}

/** The nearest h1–h4 above the range inside the article, read as
 *  {@link discussText} reads it (no 🧭, no reader additions). "" when none. */
export function discussHeading(article: Element, range: Range): string {
  // From the boundary node itself, not its parent element: prose is bare text
  // at the article's top level, so the parent of a selection there is the
  // article and a walk from it finds nothing.
  let node: Node | null = range.startContainer;
  if (!article.contains(node)) return "";
  const HEAD = /^H[1-4]$/;
  while (node && node !== article) {
    if (node.nodeType === ELEMENT_NODE && HEAD.test((node as Element).tagName)) return discussText(node).trim();
    for (let sib = node.previousSibling; sib; sib = sib.previousSibling) {
      if (sib.nodeType !== ELEMENT_NODE) continue;
      const el = sib as Element;
      if (HEAD.test(el.tagName)) return discussText(el).trim();
      const inner = el.querySelectorAll("h1,h2,h3,h4");
      if (inner.length) return discussText(inner[inner.length - 1]!).trim();
    }
    node = node.parentNode;
  }
  return "";
}
