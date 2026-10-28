/// <reference lib="dom" />
/**
 * Stale marks in the article text (plan muninn-wiki-drift-check, PR 2b, D21):
 * a mark on the status words of each CONFIRMED stale status line, placed in
 * the browser over the rendered article, never written into the source.
 *
 * For each hit the client finds the rendered link to the hit's target
 * (`a.wiki-link[data-relpath]`) in a list item, a paragraph line or a table
 * row, then the said words after it: the first status word of a kind in
 * `said` between the link and the next wikilink on the line, the segment the
 * server read (`stale.ts`, the same {@link STATUS_WORDS}). Inline code and
 * struck text hold no status word there, as on the server.
 *
 * Which line is the hit's: the rendered text carries no line numbers, so each
 * candidate line is scored against the hit's text (its words in order, links
 * left out on both sides, {@link lineScore}), at or above {@link MATCH_MIN};
 * a tie goes to the line with the fewest words the hit does not hold, so an
 * exact line beats a longer one. A mark lands only on a unique best
 * candidate; with none, or a tie on both, there is no mark and the STALE tab
 * still lists the hit. A hit on a frontmatter line has no rendered line and
 * no mark.
 *
 * DOM-free at import time; the pure halves are exported for the unit test,
 * and `wiki-stale-marks-dom.test.ts` (happy-dom) and
 * `e2e/wiki-stale-counts.spec.ts` drive the DOM half.
 */
import { STATUS_WORDS } from "../../../wiki/status-words.ts";
import type { StaleHitView } from "./wiki-stale-tab.ts";

export const STALE_MARK_CLASS = "wiki-stale-mark";
/** The share of the hit's words a candidate line holds in order. */
export const MATCH_MIN = 0.8;

/** Elements that start a new line inside a line root; a table cell does not:
 *  a table row is one source line, its cells separate words. */
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DETAILS", "DIALOG", "DD", "DIV",
  "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2",
  "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE",
  "SECTION", "TABLE", "TBODY", "THEAD", "TR", "UL", "SUMMARY",
]);
/** Text the server masks before it reads a status word: inline code, strikethrough. */
const MASKED_TAGS = new Set(["CODE", "PRE", "DEL", "S", "STRIKE", "KBD", "SAMP"]);

const CELL_TAGS = new Set(["TD", "TH"]);

const isLink = (el: Element) => el.classList.contains("wiki-link") || el.classList.contains("wiki-link-missing");

/** The earliest status word in `text` of a kind in `said`, as `[start, end]`
 *  — the server's `saidSpan` rule. */
export function saidWordSpan(text: string, said: readonly string[]): [number, number] | null {
  let best: [number, number] | null = null;
  for (const [kind, re] of STATUS_WORDS) {
    if (!said.includes(kind)) continue;
    const m = re.exec(text);
    if (m && (!best || m.index < best[0])) best = [m.index, m.index + m[0].length];
  }
  return best;
}

/** Lowercased letter-and-digit runs. */
export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/** The words of a hit's text a rendered line shows: wikilinks left out (the
 *  line leaves out the links' rendered text), a markdown link read as its
 *  text, and the word cut at each `…` edge dropped. */
export function hitTokens(text: string): string[] {
  const plain = text.replace(/!?\[\[[^\]]*\]\]/g, " ").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
  const pieces = plain.split("…");
  const out: string[] = [];
  pieces.forEach((piece, i) => {
    const t = tokens(piece);
    // A cut can split a word: drop the edge word on a cut side.
    if (i > 0 && t.length && !/^[^\p{L}\p{N}]/u.test(piece)) t.shift();
    if (i < pieces.length - 1 && t.length && !/[^\p{L}\p{N}]$/u.test(piece)) t.pop();
    out.push(...t);
  });
  return out;
}

/** The share of `hit` that `line` holds in order (longest common subsequence). */
export function lineScore(hit: readonly string[], line: readonly string[]): number {
  if (!hit.length) return 1;
  let prev = new Array<number>(line.length + 1).fill(0);
  for (const h of hit) {
    const cur = new Array<number>(line.length + 1).fill(0);
    for (let j = 1; j <= line.length; j++) cur[j] = h === line[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    prev = cur;
  }
  return prev[line.length]! / hit.length;
}

/** Candidate order: the higher {@link lineScore} first, then the higher share
 *  of the line's words the hit holds (the closer line). 0 is a tie. */
export function compareFit(x: { score: number; fit: number }, y: { score: number; fit: number }): number {
  return y.score - x.score || y.fit - x.fit;
}

/** A text run of one rendered line. */
interface Piece {
  node: Text;
  /** Offset of this run inside `node`. */
  start: number;
  text: string;
  /** The wikilink element it sits in, if any. */
  link: Element | null;
  masked: boolean;
  /** The table cell it sits in, if any: a cell edge separates words. */
  cell: Element | null;
}

/** The element a link's line lives in: its list item, table row or block,
 *  else the article container (a paragraph is bare text there). */
function lineRootOf(a: Element, container: Element): Element {
  for (let el = a.parentElement; el && el !== container; el = el.parentElement) {
    if (el.tagName === "TR" || el.tagName === "LI" || (BLOCK_TAGS.has(el.tagName) && el.tagName !== "TBODY" && el.tagName !== "THEAD")) return el;
  }
  return container;
}

/** The nearest line-starting block of `node` below `root`, else `root`. */
function blockOf(node: Node, root: Element): Node {
  for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
    if (BLOCK_TAGS.has(el.tagName)) return el;
  }
  return root;
}

/** `root`'s text cut into lines: at a newline, a `<br>` and a block edge. */
function linesOf(root: Element): Piece[][] {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 1 | 4 /* SHOW_ELEMENT | SHOW_TEXT */);
  const lines: Piece[][] = [[]];
  let block: Node | null = null;
  const breakLine = () => {
    if (lines[lines.length - 1]!.length) lines.push([]);
  };
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 1) {
      if ((n as Element).tagName === "BR") breakLine();
      continue;
    }
    const t = n as Text;
    const b = blockOf(t, root);
    if (block !== null && b !== block) breakLine();
    block = b;
    let link: Element | null = null;
    let masked = false;
    let cell: Element | null = null;
    for (let el = t.parentElement; el && el !== root.parentElement; el = el.parentElement) {
      if (!link && isLink(el)) link = el;
      if (MASKED_TAGS.has(el.tagName)) masked = true;
      if (!cell && CELL_TAGS.has(el.tagName)) cell = el;
      if (el === root) break;
    }
    const parts = t.data.split("\n");
    let at = 0;
    parts.forEach((p, i) => {
      if (i > 0) breakLine();
      if (p) lines[lines.length - 1]!.push({ node: t, start: at, text: p, link, masked, cell });
      at += p.length + 1;
    });
  }
  return lines.filter((l) => l.length);
}

interface Candidate {
  anchor: Element;
  score: number;
  /** The share of the line's words the hit holds. */
  fit: number;
  /** The said word's runs, each a slice of one text node. */
  runs: { node: Text; start: number; end: number }[];
}

/** One link's candidate: its line's score against the hit, and the said word after it. */
function candidateFor(a: Element, container: Element, hit: StaleHitView, want: readonly string[]): Candidate | null {
  const root = lineRootOf(a, container);
  const line = linesOf(root).find((l) => l.some((p) => p.link === a));
  if (!line) return null;
  const lastOwn = line.map((p) => p.link === a).lastIndexOf(true);
  // The segment: after the link, to the next wikilink on the line.
  const seg: Piece[] = [];
  for (const p of line.slice(lastOwn + 1)) {
    if (p.link) break;
    seg.push(p);
  }
  // Masked runs keep their length, so offsets map back, but hold no word; a
  // space stands for each cell edge, which the rendered text has none of.
  let text = "";
  const at: number[] = [];
  seg.forEach((p, i) => {
    if (i > 0 && p.cell !== seg[i - 1]!.cell) text += " ";
    at.push(text.length);
    text += p.masked ? " ".repeat(p.text.length) : p.text;
  });
  const span = saidWordSpan(text, hit.said);
  if (!span) return null;
  const runs: Candidate["runs"] = [];
  seg.forEach((p, i) => {
    const s = Math.max(span[0], at[i]!);
    const e = Math.min(span[1], at[i]! + p.text.length);
    if (s < e) runs.push({ node: p.node, start: p.start + s - at[i]!, end: p.start + e - at[i]! });
  });
  const lineWords = tokens(line.filter((p) => !p.link).map((p) => p.text).join(" "));
  return { anchor: a, score: lineScore(want, lineWords), fit: lineScore(lineWords, want), runs };
}

/** Remove every stale mark under `container`, its text kept. */
export function clearStaleMarks(container: Element): void {
  const marks = Array.from(container.querySelectorAll(`mark.${STALE_MARK_CLASS}`));
  const parents = new Set<Node>();
  for (const m of marks) {
    const parent = m.parentNode;
    if (!parent) continue;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parents.add(parent);
  }
  for (const p of parents) p.normalize();
}

/**
 * Mark each hit's said words in `container` (D21), after clearing the old
 * marks. Returns the number of hits marked; a hit with no unique match is
 * left unmarked.
 */
export function placeStaleMarks(container: Element, hits: readonly StaleHitView[]): number {
  clearStaleMarks(container);
  const plans: { hit: StaleHitView; c: Candidate }[] = [];
  for (const hit of hits) {
    // A frontmatter line is not rendered: no line of the article is the hit's.
    if (hit.frontmatter) continue;
    const want = hitTokens(hit.text);
    const anchors = Array.from(container.querySelectorAll("a.wiki-link[data-relpath]")).filter((a) => a.getAttribute("data-relpath") === hit.target);
    const found = anchors.map((a) => candidateFor(a, container, hit, want)).filter((c): c is Candidate => !!c && c.score >= MATCH_MIN);
    found.sort(compareFit);
    // A tie at the top is no unique match.
    if (!found.length || (found.length > 1 && compareFit(found[0]!, found[1]!) === 0)) continue;
    plans.push({ hit, c: found[0]! });
  }
  // A link two hits both claim is not unique either.
  const claims = new Map<Element, number>();
  for (const p of plans) claims.set(p.c.anchor, (claims.get(p.c.anchor) ?? 0) + 1);
  let placed = 0;
  for (const { hit, c } of plans) {
    if (claims.get(c.anchor)! > 1) continue;
    // Read again: a mark placed for an earlier hit split text nodes.
    const runs = candidateFor(c.anchor, container, hit, [])?.runs ?? [];
    if (!runs.length) continue;
    // Wrap the runs last first, so an earlier run's offsets stay valid.
    for (const r of [...runs].reverse()) {
      const tail = r.node.splitText(r.start);
      tail.splitText(r.end - r.start);
      const mark = container.ownerDocument.createElement("mark");
      mark.className = STALE_MARK_CLASS;
      mark.setAttribute("data-stale-mark", String(hit.line));
      mark.title = `Stale status line: ${hit.target} is ${hit.now}`;
      tail.parentNode!.insertBefore(mark, tail);
      mark.appendChild(tail);
    }
    placed++;
  }
  return placed;
}

/** The marks' CSS, injected by `wiki-page.ts`. */
export function wikiStaleMarkStyles(): string {
  return `
    mark.${STALE_MARK_CLASS} { background: color-mix(in srgb, var(--status-warning) 28%, transparent); color: inherit; border-bottom: 2px solid var(--status-warning); border-radius: 2px; padding: 0 1px; }
  `;
}
