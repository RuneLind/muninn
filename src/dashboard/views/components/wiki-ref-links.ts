/// <reference lib="dom" />
/**
 * In-page references in the /wiki reader: a bare id the page defines (`D4`,
 * `S1`, `Q-8`, a CaseBoard case) and a quoted section title («Q2-oppskrift»,
 * "As run — decisions") become links. Hovering or focusing one shows a peek
 * card with what it points at; clicking jumps there (folds open, the target
 * flashes) and a `↩ Back` pill returns to where the reader was. Client-side
 * only, so every existing page gains it with no edit.
 *
 * - **Targets.** DecisionLog items, Query cards and CaseBoard rows keep their
 *   server anchors and are keyed by their chip text. Every `<Fold>` and heading
 *   gets an id here, GitHub's heading slug, so the `](#slug)` links pages
 *   already carry resolve (repeats numbered `-1`, `-2` in document order, as
 *   GitHub does). A fold wins over a heading of the same title. A key two
 *   targets share links nowhere: a title two folds share (fagavklaring has
 *   fourteen «Om spørringen» folds), an id two DecisionLogs both define.
 * - **Not linked:** text inside code, links, headings, a fold's summary, form
 *   controls, diagrams and a Query's CSV result table (data, not prose); a
 *   reference inside its own target; a quote that names no section on the
 *   page (`«vedtak fattet i Melosys»`).
 * - **Explicit links.** A server-rendered `<a href="#id">` whose target is one
 *   of those kinds, inside the article, joins in and gets the same peek and
 *   jump; any other fragment link keeps the browser's own behaviour.
 * - **Back.** Each jump pushes a history entry. Back (the pill or the browser)
 *   restores the scroll position the jump left. The pill and the peek live in
 *   the article, so the next page render takes them away.
 */

import { HASH_FLASH_CLASS, revealHashTarget } from "./wiki-hash-target.ts";
import {
  CB_LINE_CLASS,
  CB_MORE_CLASS,
  CB_OKMORE_CLASS,
  DL_ALL_CLASS,
  DL_MORE_CLASS,
  DL_QSTATE_CLASS,
  DL_WHEN_CLASS,
  idPrefix,
  READER_ONLY_ATTR,
  type IdLabels,
} from "../../../format/reader-lens.ts";

/** The noun before an id (D12): the server puts it before a DecisionLog or
 *  Query chip, the ref links before an id run in prose. */
export const ID_NOUN_CLASS = "id-noun";

export const REF_CLASS = "wiki-ref";
export const PEEK_CLASS = "wiki-ref-peek";
export const BACK_CLASS = "wiki-ref-back";

/** GitHub's heading slug: lowercase, punctuation dropped, each space a hyphen
 *  (so `Runde 3 — 18.08` gives `runde-3--1808`). Letters outside ASCII stay. */
export function headingSlug(text: string): string {
  return text
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

export interface RefMatch {
  start: number;
  end: number;
  /** The id or the section title, as the index holds it. */
  key: string;
  kind: "id" | "title";
}

/** Regex syntax escaped, `-` left alone: outside a class it needs none, and
 *  `\-` is a syntax error under the `u` flag. */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A quote and the words inside it: «…», “…” or "…" on one line. */
const QUOTE_SRC = String.raw`«([^«»\n]{1,120})»|“([^“”\n]{1,120})”|"([^"\n]{1,120})"`;

/** Every reference in `text`, left to right, non-overlapping. An id matches
 *  whole: `Q-1` not inside `Q-10` or `XQ-1`, `D4` not inside `D4-saken`. A quote
 *  matches when its trimmed words are a title in `titles`; one that is not is
 *  scanned for ids inside it. */
export function findRefs(text: string, ids: ReadonlySet<string>, titles: ReadonlySet<string>): RefMatch[] {
  const idAlt = [...ids].sort((a, b) => b.length - a.length).map(escapeRe).join("|");
  const idSrc = idAlt ? String.raw`(?<![\p{L}\p{N}_-])(${idAlt})(?![\p{L}\p{N}_]|-[\p{L}\p{N}])` : "";
  const src = [titles.size ? QUOTE_SRC : "", idSrc].filter(Boolean).join("|");
  if (!src) return [];
  const re = new RegExp(src, "gu");
  const out: RefMatch[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const quoted = titles.size ? (m[1] ?? m[2] ?? m[3]) : undefined;
    if (quoted !== undefined) {
      const key = quoted.trim();
      if (titles.has(key)) out.push({ start: m.index, end: m.index + m[0].length, key, kind: "title" });
      // Not a section: look for ids inside the quote, from just past its opener.
      else re.lastIndex = m.index + 1;
      continue;
    }
    const id = m[titles.size ? 4 : 1]!;
    out.push({ start: m.index, end: m.index + id.length, key: id, kind: "id" });
  }
  return out;
}

/** A fold's title: its summary's own text, without the teaser span. */
function foldTitle(fold: Element): string {
  const summary = fold.querySelector(":scope > summary");
  if (!summary) return "";
  let t = "";
  summary.childNodes.forEach((n) => {
    if (n.nodeType === 3) t += n.textContent ?? "";
  });
  return t.trim();
}

/** GitHub's rule for a repeated slug: the first keeps it, then `-1`, `-2`. */
function ensureId(el: Element, title: string): string {
  if (el.id) return el.id;
  const base = headingSlug(title) || "section";
  let id = base;
  for (let k = 1; document.getElementById(id); k++) id = `${base}-${k}`;
  el.id = id;
  return id;
}

const ID_TARGETS = ".dl-item[id] > .dl-id, section.query[id] .query-id, .cb-row[id] > .cb-id";
const SECTIONS = "details.fold, h1, h2, h3, h4, h5, h6";
/** What a peek can show: the targets `peekParts` knows. */
const TARGET_KINDS = `.dl-item, section.query, .cb-row, ${SECTIONS}`;

/** A key seen twice maps to null: it names no one target. */
function claim(map: Map<string, Element | null>, key: string, el: Element): void {
  map.set(key, map.has(key) ? null : el);
}

function unique(map: Map<string, Element | null>): Map<string, Element> {
  const out = new Map<string, Element>();
  for (const [k, el] of map) if (el) out.set(k, el);
  return out;
}

/** What the page defines, keyed the way its prose names it. Gives every fold
 *  and heading an id on the way, in document order. A key defined twice is
 *  left out. */
export function refTargets(root: Element): { ids: Map<string, Element>; titles: Map<string, Element> } {
  const idDefs = new Map<string, Element | null>();
  root.querySelectorAll(ID_TARGETS).forEach((chip) => {
    const key = (chip.textContent ?? "").trim();
    const target = chip.closest("[id]");
    if (key && target) claim(idDefs, key, target);
  });
  const folds = new Map<string, Element | null>();
  const headings = new Map<string, Element | null>();
  root.querySelectorAll(SECTIONS).forEach((el) => {
    if (el.classList.contains("fold-heading-dup")) return;
    const isFold = el.matches("details.fold");
    const title = isFold ? foldTitle(el) : (el.textContent ?? "").trim();
    if (!title) return;
    ensureId(el, title);
    claim(isFold ? folds : headings, title, el);
  });
  const titles = unique(folds);
  // A heading takes only a title no fold holds, ambiguously or not.
  for (const [title, el] of headings) if (el && !folds.has(title)) titles.set(title, el);
  return { ids: unique(idDefs), titles };
}

const SKIP =
  "a, code, pre, summary, h1, h2, h3, h4, h5, h6, button, textarea, input, select, svg, script, style, .mermaid, .query-result";

/** What may stand between two ids of one run: a list or range separator. */
const RUN_GAP_RE = /^\s*(?:[,/&–—-]|og|and|eller|or|til|to)?\s*$/u;

/** Whether the text before an id ends with a word that starts with one of the
 *  noun's forms: «beslutningen D7», «Beslutning D7», «beslutningene D1–D3»,
 *  «Beslutning (D7)», «beslutning: D7». Only the text after the last blank
 *  line counts: a text run can still carry one after a component. */
function ledByNoun(before: string, forms: readonly string[]): boolean {
  const tail = before.split(/\n[^\S\n]*\n/).pop()!.toLocaleLowerCase();
  return forms.some((f) => {
    const form = f.toLocaleLowerCase();
    // The form, at a word start, then the rest of that word, then only
    // whitespace, opening brackets or a colon.
    const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRe(form)}[\\p{L}\\p{N}]*[\\s(\\[{:]*$`, "u");
    return re.test(tail);
  });
}

/**
 * Where the id nouns go in one text node's matches (D12): a run of ids with
 * one prefix, joined by a list or range separator (`D1–D11`, `D1 til D11`,
 * `S1, S2 og S6`), gets the noun once, before its first id, plural when the
 * run holds more than one. A run whose preceding word starts with the noun
 * (`Beslutning D7`, `beslutningen D7`) gets none. `preceding` is the inline
 * text before this node ({@link precedingText}, `**Beslutning** D7`). Returns the noun per
 * match index that starts a run.
 */
export function nounRuns(text: string, matches: RefMatch[], labels: IdLabels | undefined, preceding = ""): Map<number, string> {
  const out = new Map<number, string>();
  if (!labels || Object.keys(labels).length === 0) return out;
  let k = 0;
  while (k < matches.length) {
    const m = matches[k]!;
    const prefix = m.kind === "id" ? idPrefix(m.key) : null;
    let end = k;
    if (prefix && Object.hasOwn(labels, prefix)) {
      while (end + 1 < matches.length) {
        const next = matches[end + 1]!;
        if (next.kind !== "id" || idPrefix(next.key) !== prefix) break;
        if (!RUN_GAP_RE.test(text.slice(matches[end]!.end, next.start))) break;
        end++;
      }
      const label = labels[prefix]!;
      if (!ledByNoun(preceding + text.slice(0, m.start), [label.one, label.other])) {
        out.set(k, end > k ? label.other : label.one);
      }
    }
    k = end + 1;
  }
  return out;
}

/** The inline elements the text before an id is read back through; any other
 *  element (a heading, a list, a fold, a `<br>`) ends the read-back. */
const INLINE = "strong, em, b, i, u, s, del, mark, code, kbd, sup, sub, small, abbr, span, a";
const PRECEDING_MAX = 80;

/** The text before `node` back to the first non-inline element, through its
 *  preceding siblings and those of its inline ancestors; the last
 *  {@link PRECEDING_MAX} chars. */
function precedingText(node: Text): string {
  let out = "";
  let at: Node = node;
  while (out.length < PRECEDING_MAX) {
    const prev: Node | null = at.previousSibling;
    if (prev) {
      if (prev.nodeType === Node.TEXT_NODE) out = (prev.nodeValue ?? "") + out;
      else if (prev instanceof Element && prev.matches(INLINE)) out = (prev.textContent ?? "") + out;
      else if (prev.nodeType !== Node.COMMENT_NODE) break;
      at = prev;
      continue;
    }
    const parent: Element | null = at.parentElement;
    if (!parent?.matches(INLINE)) break;
    at = parent;
  }
  return out.slice(-PRECEDING_MAX);
}

/** Wrap every reference under `root` in an `a.wiki-ref`, with the wiki's id
 *  nouns before the id runs ({@link nounRuns}). Returns how many links. */
export function linkRefs(root: Element, idLabels?: IdLabels): number {
  const { ids, titles } = refTargets(root);
  // A server-rendered fragment link to a known kind of target joins in.
  root.querySelectorAll<HTMLAnchorElement>('a[href^="#"]:not(.dl-id):not(.query-id):not(.cb-id)').forEach((a) => {
    const id = decodeHash(a.getAttribute("href")!);
    const target = id ? document.getElementById(id) : null;
    if (target && root.contains(target) && target.matches(TARGET_KINDS)) {
      a.classList.add(REF_CLASS);
      a.dataset.ref = target.id;
    }
  });
  if (!ids.size && !titles.size) return 0;
  const idKeys = new Set(ids.keys());
  const titleKeys = new Set(titles.keys());
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  let count = 0;
  for (const node of nodes) {
    const text = node.nodeValue ?? "";
    let last = 0;
    let frag: DocumentFragment | null = null;
    const matches = findRefs(text, idKeys, titleKeys).filter(
      (m) => !(m.kind === "id" ? ids : titles).get(m.key)!.contains(node),
    );
    const nouns = matches.length && idLabels ? nounRuns(text, matches, idLabels, precedingText(node)) : new Map<number, string>();
    for (const [k, m] of matches.entries()) {
      const target = (m.kind === "id" ? ids : titles).get(m.key)!;
      frag ??= document.createDocumentFragment();
      frag.append(text.slice(last, m.start));
      const noun = nouns.get(k);
      if (noun) {
        const span = document.createElement("span");
        span.className = ID_NOUN_CLASS;
        span.setAttribute(READER_ONLY_ATTR, "");
        span.textContent = noun;
        frag.append(span, " ");
      }
      const a = document.createElement("a");
      a.className = REF_CLASS;
      a.href = `#${encodeURIComponent(target.id)}`;
      a.dataset.ref = target.id;
      a.textContent = text.slice(m.start, m.end);
      frag.append(a);
      last = m.end;
      count++;
    }
    if (frag) {
      frag.append(text.slice(last));
      node.replaceWith(frag);
    }
  }
  return count;
}

function decodeHash(href: string): string | null {
  try {
    return decodeURIComponent(href.slice(1));
  } catch {
    return null;
  }
}

/** A copy safe to show twice on the page: no ids, no flash, no frames
 *  reloading, no live checkboxes, and none of the Overview lens's decision
 *  chrome (the «mer» toggle, the «lukket» badge): a peek shows a decision
 *  whole in every lens (D6). */
function cloneBare<T extends Node>(n: T): T {
  const c = n.cloneNode(true) as T;
  if (c instanceof Element) {
    // The reader's lens controls and Overview's compact parts (D6, D41, D42):
    // a peek shows its target whole, as written.
    c.querySelectorAll(
      `.${DL_MORE_CLASS}, .${DL_QSTATE_CLASS}, .${DL_ALL_CLASS}, .${CB_MORE_CLASS}, .${CB_OKMORE_CLASS}, .${DL_WHEN_CLASS}, .${CB_LINE_CLASS}`,
    ).forEach((b) => b.remove());
    for (const x of [c, ...Array.from(c.querySelectorAll("[id], .wiki-hash-flash, iframe, input"))]) {
      x.removeAttribute("id");
      x.classList.remove(HASH_FLASH_CLASS);
      if (x.tagName === "IFRAME") x.remove();
      if (x instanceof HTMLInputElement) x.disabled = true;
    }
  }
  return c;
}

/** Blocks a peek does not copy: big, live or a section of their own. */
const PEEK_SKIP = "details, iframe, section.query, .caseboard";

const PEEK_CHARS = 400;
const isHeading = (n: Node) => n.nodeType === 1 && /^H[1-6]$/.test((n as Element).tagName);

/** The opening of a section, copied: nodes from `start` on, past leading
 *  headings, up to the next heading or about `PEEK_CHARS` of text. Text nodes
 *  count, since a paragraph renders as a bare text run, not a `<p>`. */
function leadingContent(start: ChildNode | null): Node[] {
  const out: Node[] = [];
  let chars = 0;
  for (let n = start; n && chars < PEEK_CHARS; n = n.nextSibling) {
    if (isHeading(n)) {
      if (chars > 0) break;
      continue;
    }
    if (n.nodeType === 1 && (n as Element).matches(PEEK_SKIP)) {
      if (chars > 0) break;
      continue;
    }
    const text = (n.textContent ?? "").trim();
    if (!out.length && !text) continue;
    out.push(cloneBare(n));
    chars += text.length;
  }
  return out;
}

/** What a peek card shows for `target`: its label, where it sits, and a copy
 *  of its content. */
export function peekParts(target: Element): { label: string; where: string; body: Node[]; isTitle: boolean } {
  const enclosing = target.parentElement?.closest("details.fold");
  const where = enclosing ? foldTitle(enclosing) : "";
  if (target.matches(".dl-item")) {
    const c = cloneBare(target);
    // The chip and its noun: the card's label already names the id.
    c.querySelector(":scope > .dl-id")?.remove();
    c.querySelector(`:scope > .${ID_NOUN_CLASS}`)?.remove();
    const p = document.createElement("div");
    p.append(...Array.from(c.childNodes));
    return { label: target.querySelector(".dl-id")?.textContent ?? "", where, body: [p], isTitle: false };
  }
  if (target.matches("section.query")) {
    const body = [".query-question", ".query-answer", ".query-meta"]
      .map((s) => target.querySelector(s))
      .filter((x): x is Element => !!x)
      .map(cloneBare);
    return { label: target.querySelector(".query-id")?.textContent ?? "", where, body, isTitle: false };
  }
  if (target.matches(".cb-row")) {
    const c = cloneBare(target);
    c.querySelector(".cb-id")?.remove();
    return { label: target.querySelector(".cb-id")?.textContent ?? "", where, body: [c], isTitle: false };
  }
  if (target.matches("details.fold")) {
    const body: Node[] = [];
    const teaser = target.querySelector(":scope > summary .fold-summary");
    if (teaser) body.push(cloneBare(teaser));
    body.push(...leadingContent(target.querySelector(":scope > .fold-body")?.firstChild ?? null));
    return { label: foldTitle(target), where, body, isTitle: true };
  }
  // A heading: the opening of its section.
  return { label: (target.textContent ?? "").trim(), where, body: leadingContent(target.nextSibling), isTitle: true };
}

// ── Interaction ──────────────────────────────────────────────────────────

const SHOW_DELAY_MS = 200;
const HIDE_DELAY_MS = 250;

/** `#articleWrap`: what `revealHashTarget` searches and what scrolls. */
let root: Element | null = null;
/** The `.wiki-article` inside it, which holds the peek and the pill. */
let article: Element | null = null;
let peek: HTMLElement | null = null;
let peekFor: HTMLAnchorElement | null = null;
let showTimer: ReturnType<typeof setTimeout> | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let backPill: HTMLButtonElement | null = null;
/** The page's relPath, for a jump from a legacy `?page=` URL. */
let pageRelPath = "";
/** A link Escape just returned focus to: its focusin must not reopen the card. */
let refocused: HTMLAnchorElement | null = null;
/** One entry per jump: the URL and scroll position it left. */
let stack: { url: string; top: number }[] = [];
let installed = false;

const touchOnly = (): boolean => matchMedia("(hover: none)").matches;

function hidePeek(): void {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  // Cleared before the removal: removing a card that holds focus fires its
  // focusout, which calls back in here, and a second remove() throws.
  const card = peek;
  peekFor?.removeAttribute("aria-describedby");
  peek = null;
  peekFor = null;
  card?.remove();
}

/** Hide any peek card, and cancel one about to show. The find palette calls it
 *  as it opens, so no peek (and no peek-owned Escape) outlives the open. */
export function hideRefPeek(): void {
  hidePeek();
}

function showPeek(a: HTMLAnchorElement): void {
  const target = document.getElementById(a.dataset.ref ?? "");
  if (!target) return;
  hidePeek();
  const { label, where, body, isTitle } = peekParts(target);
  const card = document.createElement("div");
  card.className = PEEK_CLASS;
  // A tooltip, not a dialog: the reader's modal checks treat any
  // [role="dialog"] as open and would block shortcuts while a card shows.
  card.id = PEEK_CLASS;
  card.setAttribute("role", "tooltip");
  a.setAttribute("aria-describedby", PEEK_CLASS);
  const head = document.createElement("div");
  head.className = `${PEEK_CLASS}-head`;
  const lab = document.createElement("span");
  lab.className = `${PEEK_CLASS}-label${isTitle ? ` ${PEEK_CLASS}-title` : ""}`;
  lab.textContent = label;
  const wh = document.createElement("span");
  wh.className = `${PEEK_CLASS}-where`;
  wh.textContent = where;
  const go = document.createElement("button");
  go.type = "button";
  go.className = `${PEEK_CLASS}-go`;
  go.textContent = "Go to ↓";
  go.addEventListener("click", () => jump(target.id));
  head.append(lab, wh, go);
  const bodyEl = document.createElement("div");
  bodyEl.className = `${PEEK_CLASS}-body`;
  bodyEl.append(...body);
  card.append(head, bodyEl);
  card.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  card.addEventListener("mouseleave", () => {
    hideTimer = setTimeout(hidePeek, HIDE_DELAY_MS);
  });
  card.addEventListener("focusout", (e) => {
    const to = e.relatedTarget as Node | null;
    if (!card.contains(to) && to !== a) hidePeek();
  });
  // Inside the article so its scoped styles reach the copy.
  (article ?? document.body).append(card);
  peek = card;
  peekFor = a;
  place(card, a);
}

function place(card: HTMLElement, a: Element): void {
  const r = a.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const w = card.offsetWidth;
  const h = card.offsetHeight;
  const left = Math.max(16, Math.min(r.left, vw - w - 16));
  const below = r.bottom + 6;
  const top = below + h + 8 > vh && r.top - h - 6 > 0 ? r.top - h - 6 : below;
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}

function setBackPill(): void {
  if (!backPill && article) {
    backPill = document.createElement("button");
    backPill.type = "button";
    backPill.className = BACK_CLASS;
    backPill.textContent = "↩ Back";
    backPill.title = "Back to where you were";
    backPill.addEventListener("click", () => history.back());
    article.append(backPill);
  }
  if (backPill) backPill.hidden = stack.length === 0;
}

function jump(id: string): void {
  if (!root) return;
  hidePeek();
  // A legacy `?page=` URL: give the entry its relPath first, or Back would
  // miss the reader's same-page check and refetch the page.
  const u = new URL(location.href);
  if (pageRelPath && u.searchParams.get("relPath") !== pageRelPath) {
    u.searchParams.delete("page");
    u.searchParams.set("relPath", pageRelPath);
    history.replaceState(history.state, "", u);
  }
  stack.push({ url: location.href, top: root.scrollTop });
  const hash = `#${encodeURIComponent(id)}`;
  // pushState fires no hashchange, so the reader's own listener stays out of it.
  history.pushState(history.state, "", hash);
  revealHashTarget(root, hash);
  setBackPill();
}

/** Back onto the URL a jump left: restore its scroll. popstate, not
 *  hashchange: a jump to the hash already in the URL changes no hash. */
function onPopState(): void {
  // The pane holds something else now (an Ask answer, the start view).
  if (!article?.isConnected) {
    stack = [];
    return;
  }
  const top = stack[stack.length - 1];
  if (!top || location.href !== top.url) return;
  stack.pop();
  setBackPill();
  // After the reader's own hashchange handler, which scrolls to the hash.
  requestAnimationFrame(() => {
    if (root) root.scrollTop = top.top;
  });
}

/** The reference link an event is about, outside a peek card: a link inside
 *  the card jumps on click but opens no second card. */
function refLink(e: Event): HTMLAnchorElement | null {
  const a = (e.target as Element).closest?.(`a.${REF_CLASS}`) as HTMLAnchorElement | null;
  return a && !a.closest(`.${PEEK_CLASS}`) ? a : null;
}

function install(): void {
  if (installed) return;
  installed = true;
  document.addEventListener("mouseover", (e) => {
    const a = refLink(e);
    if (!a || touchOnly()) return;
    clearTimeout(hideTimer);
    if (peekFor === a) return;
    clearTimeout(showTimer);
    showTimer = setTimeout(() => showPeek(a), SHOW_DELAY_MS);
  });
  document.addEventListener("mouseout", (e) => {
    if (!refLink(e)) return;
    clearTimeout(showTimer);
    hideTimer = setTimeout(hidePeek, HIDE_DELAY_MS);
  });
  // Keyboard focus only: a tap focuses the link too, and must leave the
  // first-tap peek to the click handler.
  document.addEventListener("focusin", (e) => {
    const a = refLink(e);
    if (a && a === refocused) return;
    if (a && peekFor !== a && a.matches(":focus-visible")) showPeek(a);
  });
  document.addEventListener("focusout", (e) => {
    const a = refLink(e);
    if (a && peekFor === a && !peek?.contains(e.relatedTarget as Node | null)) hidePeek();
  });
  document.addEventListener("click", (e) => {
    const a = (e.target as Element).closest?.(`a.${REF_CLASS}`) as HTMLAnchorElement | null;
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    // Touch has no hover: the first tap shows the peek, its button jumps. A
    // link inside the card jumps on the first tap.
    if (touchOnly() && peekFor !== a && !a.closest(`.${PEEK_CLASS}`)) {
      showPeek(a);
      return;
    }
    jump(a.dataset.ref ?? "");
  });
  // Capture on window: this Escape closes the card and nothing else (focus
  // mode's own Escape listener would otherwise leave focus mode too).
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || !peek) return;
      // A card the pane swap left behind owns no Escape.
      if (!peek.isConnected) {
        hidePeek();
        return;
      }
      // Stopped here, so no other listener sees this Escape (a focused field's
      // own included); the browser's default action still runs.
      e.stopImmediatePropagation();
      const back = peekFor;
      const inside = peek.contains(document.activeElement);
      hidePeek();
      if (inside && back) {
        // focus() fires focusin synchronously; cleared after either way.
        refocused = back;
        back.focus();
        refocused = null;
      }
    },
    true,
  );
  // The peek is placed against the viewport: a scroll outside it or a resize
  // retires it.
  document.addEventListener(
    "scroll",
    (e) => {
      if (peek && !peek.contains(e.target as Node)) hidePeek();
    },
    true,
  );
  window.addEventListener("resize", () => peek && hidePeek());
  window.addEventListener("popstate", onPopState);
}

/** Link the references in a freshly rendered article and reset the jump
 *  history. Called once per page render, before the URL's hash is revealed. */
export function enhanceRefLinks(articleRoot: Element, relPath = "", idLabels?: IdLabels): void {
  install();
  pageRelPath = relPath;
  hidePeek();
  stack = [];
  backPill = null;
  root = articleRoot;
  article = articleRoot.querySelector(".wiki-article");
  if (article) linkRefs(article, idLabels);
}

/** The reader's CSS for links, the peek card and the back pill. */
export function refLinksCss(): string {
  return `
    .wiki-article a.${REF_CLASS} { color: var(--accent-light); text-decoration: underline dotted; text-underline-offset: 3px; }
    .wiki-article a.${REF_CLASS}:hover, .wiki-article a.${REF_CLASS}:focus-visible { text-decoration-style: solid; }
    .wiki-article :is(details.fold, h1, h2, h3, h4, h5, h6) { scroll-margin-top: 1rem; }
    .${PEEK_CLASS} {
      position: fixed; z-index: 40; width: max-content; max-width: min(420px, calc(100vw - 32px));
      padding: 8px 12px; border-radius: 8px; border: 1px solid var(--border-secondary);
      background: var(--bg-panel); color: var(--text-secondary); font-size: 13px; line-height: 1.5;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
    }
    .${PEEK_CLASS}-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
    .${PEEK_CLASS}-label { font-family: var(--mono, ui-monospace, monospace); font-weight: 700; color: var(--accent-light); }
    .${PEEK_CLASS}-title { font-family: inherit; }
    .${PEEK_CLASS}-where { flex: 1; font-size: 11px; color: var(--text-soft); }
    .${PEEK_CLASS}-go {
      font: inherit; font-size: 11px; padding: 1px 8px; border-radius: 999px; cursor: pointer;
      border: 1px solid var(--border-secondary); background: var(--bg-surface); color: var(--text-secondary);
    }
    .${PEEK_CLASS}-go:hover, .${PEEK_CLASS}-go:focus-visible { color: var(--text-primary); border-color: var(--accent); }
    .${PEEK_CLASS}-body { max-height: 220px; overflow: auto; }
    .${PEEK_CLASS}-body > * { margin: 2px 0; }
    .${PEEK_CLASS}-body .query-meta, .${PEEK_CLASS}-body .fold-summary { color: var(--text-soft); font-size: 0.9em; margin: 0; }
    .${PEEK_CLASS}-body .query-question { font-weight: 600; color: var(--text-primary); }
    .${PEEK_CLASS}-body .cb-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
    .${BACK_CLASS} {
      position: fixed; right: 20px; bottom: 20px; z-index: 40; cursor: pointer;
      padding: 6px 14px; border-radius: 999px; border: 1px solid var(--accent);
      background: var(--bg-panel); color: var(--text-primary); font: inherit; font-size: 13px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    }
    .${BACK_CLASS}[hidden] { display: none; }
    .wiki-article .${HASH_FLASH_CLASS} { animation: wiki-hash-flash 2s ease-out; }
    @keyframes wiki-hash-flash {
      0%, 35% { background-color: color-mix(in srgb, var(--accent) 28%, transparent); }
      100% { background-color: transparent; }
    }
    @media (prefers-reduced-motion: reduce) { .wiki-article .${HASH_FLASH_CLASS} { animation: none; } }
    .${BACK_CLASS}:hover, .${BACK_CLASS}:focus-visible { background: var(--bg-surface); }
  `;
}
