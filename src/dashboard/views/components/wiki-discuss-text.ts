/**
 * What Discuss's client reads around a selection in the reader's article
 * (mimir plan muninn-wiki-discuss, P1): the text just before and just after it,
 * the heading above it, and whether it starts or ends in text the reader added.
 * Pure DOM (no globals: the document comes from the nodes), so a test drives it
 * in a happy-dom `Window` of its own.
 *
 * The server takes a match only when the source's neighbours of that match
 * agree with this context (`src/wiki/discuss-locate.ts`). So the context leaves
 * out what the reader adds and the source does not hold ({@link DISCUSS_TEXT_SKIP},
 * {@link DISCUSS_TEXT_HIDDEN}), and reads a list the reader reorders (a
 * DecisionLog's items by `data-dl-order`, an «Oppfølging» block's lanes by
 * `data-nm-order`) in its authored order. Only the few dozen characters next
 * to the selection matter; an addition this reading does not know of makes the
 * context disagree, and the server falls back to the heading's section.
 */

import { DL_ORDER_ATTR, DL_SEP_ATTR, READER_ONLY_ATTR } from "../../../format/reader-lens.ts";
import { DISCUSS_CONTEXT_KEY_CHARS, HANDOFF_CONTEXT_MAX } from "../../../wiki/discuss-bounds.ts";
import { locateKey } from "../../../wiki/locate-key.ts";
import { FACT_CHIP_SELECTOR, PEEK_CLASS } from "./wiki-ref-dom.ts";

/**
 * Elements whose text the source does not hold where the article shows it,
 * found by diffing real mimir and melosys-kode-wiki renders, after the reader's
 * whole enhancer chain, against the collapse; the parity test's fixture holds
 * each component that adds one. A selection that starts or ends in one goes
 * to the section. A
 * Lane outside an «Oppfølging» block shows its `who` and `since` in a plain
 * paragraph with no class: there the context check is what falls back.
 *  - the reader's own additions: every button and a standalone code tab's
 *    label, a peek card, a glossary tooltip, the TL;DR and «More about this»
 *    labels, a lane's head (its `who` and `since`), a question card's head,
 *    the Historic stamp, a chart's head and plot, a DeltaTable's change
 *    column, a Query card's head and SQL, a FactCheck strip's date, a
 *    Figure's caption, and the line a DeltaTable, Diagram or Steps shows for
 *    its `src` when it cannot draw it, the Query explorer's bar (its search
 *    box, `uses` chips and «N of M queries» count);
 *  - text from a page's sibling files: a CaseBoard, a Query result;
 *  - copies of text that sits elsewhere in the source: the decision views
 *    (`dc-view`: the chain, the PR strip, the question grid);
 *  - what the client redraws: a mermaid fence (an SVG once drawn), an Embed.
 */
export const DISCUSS_TEXT_SKIP = [
  "button",
  "svg",
  "script",
  "style",
  "textarea",
  "input",
  "select",
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
  ".dt-unavailable",
  ".caseboard",
  ".query-head",
  ".query-sql",
  ".query-result",
  ".query-table-wrap",
  ".qx-bar",
  ".rc-head",
  ".stp-unavailable",
  ".dgm-unavailable",
  ".fc-strip-lead",
  ".code-tab-label",
  "figcaption",
  ".embed",
  "code.language-mermaid",
  ".mermaid",
].join(", ");

/**
 * Text the selection's own reading leaves out (`readerSelectionText` under the
 * `discuss-reading` class): the reader-only additions, fact chips, a code
 * fence's bar (its language label and Copy button, added by `enhanceCodeBlocks`),
 * and a checklist row's ✓/✗ mark and a RunChecklist step's number, which stand
 * where the source has `[x]`/`[ ]` and `1.` (the collapse drops those).
 * A selection may run through these; the context skips them too.
 */
export const DISCUSS_TEXT_HIDDEN = [
  `[${READER_ONLY_ATTR}]`,
  FACT_CHIP_SELECTOR,
  ".fc-chip",
  ".fact-chip",
  ".fence-bar",
  ".check-mark",
  ".rc-num",
].join(", ");

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
const HEAD_RE = /^H[1-4]$/;
/** The attribute `applyLaneRoles` keeps each lane's authored place in. */
const NM_ORDER_ATTR = "data-nm-order";

/** One piece of the reading: a text node (or a DecisionLog separator, which
 *  the render keeps in an attribute), in authored order. */
interface Unit {
  node: Text | null;
  text: string;
  /** Inside {@link DISCUSS_TEXT_SKIP}: reader-added. */
  skipped: boolean;
  /** Inside {@link DISCUSS_TEXT_HIDDEN}: out of the selection's reading. */
  hidden: boolean;
  /** The nearest h1–h4 entered before it in authored order (itself included). */
  heading: Element | null;
}

function orderOf(el: Element): number | null {
  const v = el.getAttribute(DL_ORDER_ATTR) ?? el.getAttribute(NM_ORDER_ATTR);
  return v === null || !/^\d+$/.test(v) ? null : Number(v);
}

/** An element's children in authored order: the ones carrying an authored
 *  place (`data-dl-order`, `data-nm-order`) are put back in that order in the
 *  slots they occupy; every other child keeps its place. */
function childrenInOrder(el: Element): Node[] {
  const kids = Array.from(el.childNodes);
  const slots: number[] = [];
  const placed: Element[] = [];
  kids.forEach((k, i) => {
    if (k.nodeType === ELEMENT_NODE && orderOf(k as Element) !== null) {
      slots.push(i);
      placed.push(k as Element);
    }
  });
  if (placed.length < 2) return kids;
  placed.sort((a, b) => orderOf(a)! - orderOf(b)!);
  slots.forEach((slot, j) => (kids[slot] = placed[j]!));
  return kids;
}

function readingUnits(article: Element): Unit[] {
  const units: Unit[] = [];
  let heading: Element | null = null;
  const visit = (node: Node, skipped: boolean, hidden: boolean): void => {
    if (node.nodeType === TEXT_NODE) {
      units.push({ node: node as Text, text: (node as Text).data, skipped, hidden, heading });
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    const el = node as Element;
    const s = skipped || (el !== article && el.matches(DISCUSS_TEXT_SKIP));
    const h = hidden || (el !== article && el.matches(DISCUSS_TEXT_HIDDEN));
    if (!s && !h && HEAD_RE.test(el.tagName)) heading = el;
    // A DecisionLog item's separator (` — `) is an attribute in the render and
    // text in the source: read it back, as `readerSelectionText` does.
    const sep = el.getAttribute(DL_SEP_ATTR);
    if (sep) units.push({ node: null, text: sep, skipped: s, hidden: h, heading });
    for (const k of childrenInOrder(el)) visit(k, s, h);
  };
  visit(article, false, false);
  return units;
}

/** `root`'s text as the context reads it: authored order, without the
 *  reader's additions or the hidden parts. */
export function discussText(root: Element): string {
  return readingUnits(root)
    .filter((u) => !u.skipped && !u.hidden)
    .map((u) => u.text)
    .join("");
}

/** Text nodes under `root` in document order. */
function domTexts(root: Node): Text[] {
  const out: Text[] = [];
  const walk = (n: Node): void => {
    if (n.nodeType === TEXT_NODE) out.push(n as Text);
    else for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
  };
  walk(root);
  return out;
}

export interface DiscussContext {
  /** The text just before the selection (at most {@link DISCUSS_CONTEXT_KEY_CHARS} key characters). */
  before: string;
  /** The text just after it. */
  after: string;
  /** `before` reached the article's start. */
  atStart: boolean;
  /** `after` reached the article's end. */
  atEnd: boolean;
  /** The selection starts or ends in reader-added text, or spans reordered lanes. */
  edge: "added" | "reordered" | null;
  /** The nearest h1–h4 above the selection, read as the context reads (no 🧭). "" when none. */
  heading: string;
}

/** Read `count` key characters outward from a position, over the readable
 *  units. Returns the raw text read and whether the article's edge was hit. */
function readOutward(units: readonly Unit[], at: number, offset: number, dir: -1 | 1): { text: string; edge: boolean } {
  const parts: string[] = [];
  let keyLen = 0;
  let raw = 0;
  const take = (s: string): boolean => {
    if (!s) return false;
    parts.push(s);
    keyLen += locateKey(s).length;
    raw += s.length;
    return keyLen >= DISCUSS_CONTEXT_KEY_CHARS || raw >= HANDOFF_CONTEXT_MAX;
  };
  const usable = (u: Unit) => !u.skipped && !u.hidden;
  const first = units[at]!;
  if (usable(first) && take(dir < 0 ? first.text.slice(0, offset) : first.text.slice(offset))) return { text: join(parts, dir), edge: false };
  for (let i = at + dir; i >= 0 && i < units.length; i += dir) {
    if (usable(units[i]!) && take(units[i]!.text)) return { text: join(parts, dir), edge: false };
  }
  return { text: join(parts, dir), edge: true };
}

/** The pieces in reading order, cut to the bounds on the side away from the selection. */
function join(parts: string[], dir: -1 | 1): string {
  const s = dir < 0 ? parts.reverse().join("") : parts.join("");
  if (s.length <= HANDOFF_CONTEXT_MAX) return s;
  return dir < 0 ? s.slice(-HANDOFF_CONTEXT_MAX) : s.slice(0, HANDOFF_CONTEXT_MAX);
}

/** Whether a range holds text of `el`, not only a boundary at its edge. */
function holdsText(range: Range, el: Element, texts: readonly Text[]): boolean {
  if (!range.intersectsNode(el)) return false;
  return texts.some((t) => el.contains(t) && selectedPart(range, t).trim() !== "");
}

/** The part of a text node a range selects ("" when none). */
function selectedPart(range: Range, t: Text): string {
  if (!range.intersectsNode(t)) return "";
  const a = t === range.startContainer ? range.startOffset : 0;
  const b = t === range.endContainer ? range.endOffset : t.data.length;
  return a < b ? t.data.slice(a, b) : "";
}

/**
 * The context of `range` inside `article`, or null when the range selects no
 * text the reading shows or touches a peek card. The selection's own text is the caller's
 * (`readerSelectionText`); this reads only around it.
 */
export function discussContext(article: Element, range: Range): DiscussContext | null {
  const units = readingUnits(article);
  const indexOf = new Map<Node, number>();
  units.forEach((u, i) => {
    if (u.node) indexOf.set(u.node, i);
  });
  const texts = domTexts(article);
  // A peek card previews another place, appended at the article's end: a
  // selection touching it is not on the page, and its heading would be the last.
  if (Array.from(article.querySelectorAll(`.${PEEK_CLASS}`)).some((p) => range.intersectsNode(p))) return null;
  const isHidden = (t: Text) => units[indexOf.get(t)!]!.hidden;

  // The first and last characters the selection's reading holds: the first
  // non-blank selected character outside the hidden parts, and the last.
  let start: { t: Text; off: number } | null = null;
  let end: { t: Text; off: number } | null = null;
  for (const t of texts) {
    if (isHidden(t) || !range.intersectsNode(t)) continue;
    const a = t === range.startContainer ? range.startOffset : 0;
    const b = t === range.endContainer ? range.endOffset : t.data.length;
    for (let k = a; k < b; k++) {
      if (/\S/.test(t.data[k]!)) {
        if (!start) start = { t, off: k };
        end = { t, off: k + 1 };
      }
    }
  }
  if (!start || !end) return null;

  const startUnit = units[indexOf.get(start.t)!]!;
  const endUnit = units[indexOf.get(end.t)!]!;
  let edge: DiscussContext["edge"] = startUnit.skipped || endUnit.skipped ? "added" : null;

  // Lanes the reader reordered: a selection over two of them is not one
  // stretch of the source.
  const laneOf = (n: Node) => (n.parentElement ?? null)?.closest(".nm-lane") ?? null;
  const ls = laneOf(start.t);
  const le = laneOf(end.t);
  if (!edge && ls && le && ls !== le && ls.parentElement === le.parentElement) {
    const lanes = Array.from(ls.parentElement!.children).filter((c) => c.classList.contains("nm-lane"));
    if (lanes.some((l, i) => orderOf(l) !== null && orderOf(l) !== i)) edge = "reordered";
  }

  // A selection over DecisionLog items reads as the source spells them, one
  // stretch from the first item it touches in authored order to the last
  // (`readerSelectionText`): a boundary not in that first (or last) item
  // moves to its start (or end).
  let sAt = indexOf.get(start.t)!;
  let sOff = start.off;
  let eAt = indexOf.get(end.t)!;
  let eOff = end.off;
  const items = Array.from(article.querySelectorAll(`section.decision-log > .dl-list > li[${DL_ORDER_ATTR}]`)).filter(
    (li) => !li.closest(`.${PEEK_CLASS}`) && holdsText(range, li, texts),
  );
  for (const list of new Set(items.map((li) => li.parentElement!))) {
    const touched = items.filter((li) => li.parentElement === list).sort((a, b) => orderOf(a)! - orderOf(b)!);
    const first = touched[0]!;
    const last = touched[touched.length - 1]!;
    const unitsIn = (li: Element) => units.map((u, i) => [u, i] as const).filter(([u]) => u.node && li.contains(u.node));
    if (list.contains(start.t) && !first.contains(start.t)) {
      const inFirst = unitsIn(first);
      if (inFirst.length) [sAt, sOff] = [inFirst[0]![1], 0];
    }
    if (list.contains(end.t) && !last.contains(end.t)) {
      const inLast = unitsIn(last);
      if (inLast.length) [eAt, eOff] = [inLast[inLast.length - 1]![1], inLast[inLast.length - 1]![0].text.length];
    }
  }

  const before = readOutward(units, sAt, sOff, -1);
  const after = readOutward(units, eAt, eOff, 1);
  const head = units[sAt]!.heading;
  return {
    before: before.text,
    after: after.text,
    atStart: before.edge,
    atEnd: after.edge,
    edge,
    heading: head ? discussText(head).trim() : "",
  };
}

/** The nearest h1–h4 above the range in authored order, read without the
 *  reader's additions; the heading itself when the range starts in one. "" when none. */
export function discussHeading(article: Element, range: Range): string {
  return discussContext(article, range)?.heading ?? "";
}
