/// <reference lib="dom" />
/**
 * Cross-page ids in the /wiki reader (living facts PR 4): `D9 i [[page]]`,
 * `D3, D4 og Q-16 på [[page]]`. Each id the linked page defines becomes a link
 * to that page's item, with a hover card filled from `GET /api/wiki/ref`; the
 * rest stays plain text, never a link to the citing page's own item.
 *
 * Two steps, because the endpoint answers after the render and `linkRefs`
 * runs during it:
 *  1. {@link wrapXrefRuns}, BEFORE `linkRefs`: every candidate run (an id run
 *     whose next sibling is an `a.wiki-link[data-relpath]` or a
 *     `span.wiki-link-missing`, read out of inline wrappers and across a
 *     `.fact-chip`) goes into a `span.wiki-xref-run`, which `linkRefs` skips
 *     (`REF_SKIP`). No candidate, no wrapper, no call; a run before a missing
 *     page is wrapped (so it never links in-page) but asks no page.
 *  2. {@link resolveXrefRuns} when the answers arrive: the ids the page
 *     defines become `a.wiki-xref` links, and every wrapper is unwrapped.
 *
 * A link carries `data-relpath` and `data-anchor`, so a click goes through the
 * shell's page navigation (`navTargetFrom` → `openNavTarget`), which pushes
 * the anchor as the URL's `#fragment` and reveals it after the render.
 */

import {
  findXrefRun,
  NAV_ANCHOR_ATTR,
  XREF_CLASS,
  XREF_RUN_CLASS,
  XREF_SCAN_CHARS,
  xrefIdsIn,
  type XrefAnswer,
  type XrefTarget,
} from "../../../wiki/core/cross-ref.ts";
import { NAV_RELPATH_ATTR } from "../../../wiki/core/wiki-nav.ts";
import { FACT_CHIP_SELECTOR, INLINE, REF_SKIP } from "./wiki-ref-dom.ts";

/** An element the run text is never read through: a link, code, or another
 *  run's wrapper. An inline element holding one ends the run too. */
const BARRIER = `a, code, kbd, .${XREF_RUN_CLASS}`;

/** Text inside a run that never becomes a link: a link's, code's, or a
 *  glossary's hidden `.gl-tip` (as `REF_SKIP` keeps it unlinked). */
const NO_LINK_TEXT = "a, code, kbd, .gl-tip";

export interface XrefCandidate {
  wrapper: HTMLElement;
  /** The wikilink's `data-relpath`; `""` before a `wiki-link-missing` span. */
  relPath: string;
  /** The ids of the run, in order. */
  ids: string[];
  link: HTMLElement;
}

/** The elements a run can stand before: a resolved wikilink, or a missing
 *  one (its run stays plain text, and no page is asked). */
const RUN_END = `a.wiki-link[${NAV_RELPATH_ATTR}], span.wiki-link-missing`;

interface Piece {
  node: Node;
  text: string;
  start: number;
}

/** The run's siblings before `link`, after walking out of the inline
 *  wrappers it is the first child of. */
function piecesBefore(link: Element, article: Element): { parent: Element; pieces: Piece[] } | null {
  let at: Node = link;
  while (!at.previousSibling) {
    const parent: Element | null = at.parentElement;
    if (!parent || parent === article || !parent.matches(INLINE) || parent.matches(BARRIER)) break;
    at = parent;
  }
  const parent = at.parentElement;
  if (!parent || parent.closest(REF_SKIP)) return null;
  const rev: { node: Node; text: string }[] = [];
  let chars = 0;
  for (let n = at.previousSibling; n && chars < XREF_SCAN_CHARS; n = n.previousSibling) {
    if (n.nodeType === 3) {
      rev.push({ node: n, text: n.nodeValue ?? "" });
    } else if (n.nodeType === 1) {
      const el = n as Element;
      if (el.matches(FACT_CHIP_SELECTOR)) continue;
      if (!el.matches(INLINE) || el.matches(BARRIER) || el.querySelector(BARRIER)) break;
      rev.push({ node: n, text: n.textContent ?? "" });
    } else if (n.nodeType !== 8) {
      break;
    } else {
      continue;
    }
    chars += rev[rev.length - 1]!.text.length;
  }
  let start = 0;
  const pieces = rev.reverse().map((p) => {
    const piece = { ...p, start };
    start += p.text.length;
    return piece;
  });
  return { parent, pieces };
}

/** The piece holding offset `off`; at a boundary, the one that starts there
 *  (`forEnd`: the one that ends there). */
function pieceAt(pieces: Piece[], off: number, forEnd: boolean): Piece {
  for (const p of pieces) {
    const end = p.start + p.text.length;
    if (forEnd ? off > p.start && off <= end : off >= p.start && off < end) return p;
  }
  return pieces[pieces.length - 1]!;
}

/**
 * Step 1: wrap every candidate run under `article` in a `span.wiki-xref-run`.
 * `trackerProjects`: a key of one of them (`MELOSYS-8308`) is never an id.
 */
export function wrapXrefRuns(article: Element, trackerProjects: readonly string[] = []): XrefCandidate[] {
  const out: XrefCandidate[] = [];
  const links = Array.from(article.querySelectorAll<HTMLElement>(RUN_END));
  for (const link of links) {
    const missing = link.matches("span.wiki-link-missing");
    const relPath = missing ? "" : (link.getAttribute(NAV_RELPATH_ATTR) ?? "");
    if (!missing && !relPath) continue;
    const before = piecesBefore(link, article);
    if (!before || !before.pieces.length) continue;
    const { pieces } = before;
    const run = findXrefRun(pieces.map((p) => p.text).join(""), trackerProjects);
    if (!run) continue;
    const first = run[0]!;
    const last = run[run.length - 1]!;
    const range = document.createRange();
    const sp = pieceAt(pieces, first.start, false);
    if (sp.node.nodeType === 3) range.setStart(sp.node, first.start - sp.start);
    else range.setStartBefore(sp.node);
    const ep = pieceAt(pieces, last.end, true);
    if (ep.node.nodeType === 3) range.setEnd(ep.node, last.end - ep.start);
    else range.setEndAfter(ep.node);
    const wrapper = document.createElement("span");
    wrapper.className = XREF_RUN_CLASS;
    try {
      range.surroundContents(wrapper);
    } catch {
      continue;
    }
    out.push({ wrapper, relPath, ids: run.map((r) => r.id), link });
  }
  return out;
}

/** What a resolved link's hover card shows. */
interface LinkInfo {
  id: string;
  title: string;
  target: XrefTarget;
  language: string;
}
const linkInfo = new WeakMap<HTMLAnchorElement, LinkInfo>();

/** The wikilink's own href (`/wiki?wiki=…&relPath=…`) with the item's anchor. */
function hrefFor(link: HTMLElement, relPath: string, anchor: string): string {
  const base = link.getAttribute("href") || `/wiki?relPath=${encodeURIComponent(relPath)}`;
  return `${base.split("#")[0]}#${encodeURIComponent(anchor)}`;
}

/**
 * Step 2: turn the ids each linked page defines into links, and unwrap every
 * wrapper. `answers` maps a relPath to its endpoint answer, or null when the
 * call failed (every id there stays plain).
 */
export function resolveXrefRuns(
  cands: readonly XrefCandidate[],
  answers: ReadonlyMap<string, XrefAnswer | null>,
  language = "en",
): number {
  let linked = 0;
  for (const cand of cands) {
    const { wrapper } = cand;
    if (!wrapper.isConnected) continue;
    const answer = answers.get(cand.relPath) ?? null;
    const wanted = new Set(cand.ids);
    if (answer) {
      const walker = document.createTreeWalker(wrapper, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!n.parentElement?.closest(NO_LINK_TEXT)) nodes.push(n as Text);
      for (const node of nodes) {
        const text = node.nodeValue ?? "";
        const hits = xrefIdsIn(text).filter((t) => wanted.has(t.id) && Object.hasOwn(answer.refs, t.id));
        if (!hits.length) continue;
        const frag = document.createDocumentFragment();
        let last = 0;
        for (const h of hits) {
          const target = answer.refs[h.id]!;
          frag.append(text.slice(last, h.start));
          const a = document.createElement("a");
          a.className = XREF_CLASS;
          a.href = hrefFor(cand.link, cand.relPath, target.anchor);
          a.setAttribute(NAV_RELPATH_ATTR, cand.relPath);
          a.setAttribute(NAV_ANCHOR_ATTR, target.anchor);
          a.textContent = h.id;
          linkInfo.set(a, { id: h.id, title: answer.title, target, language });
          frag.append(a);
          last = h.end;
          linked++;
        }
        frag.append(text.slice(last));
        node.replaceWith(frag);
      }
    }
    wrapper.replaceWith(...Array.from(wrapper.childNodes));
  }
  return linked;
}

/** The endpoint call for one linked page, injectable for tests. */
export type XrefFetch = (relPath: string, ids: string[]) => Promise<XrefAnswer | null>;

/** The reader's fetch: `GET /api/wiki/ref` through the shell's `withWiki`. */
export function xrefFetchVia(withWiki: (url: string) => string): XrefFetch {
  return async (relPath, ids) => {
    try {
      const url = withWiki(`/api/wiki/ref?relPath=${encodeURIComponent(relPath)}&ids=${encodeURIComponent(ids.join(","))}`);
      const res = await fetch(url);
      if (!res.ok) return null;
      const body = (await res.json()) as XrefAnswer;
      return body && typeof body === "object" && body.refs ? body : null;
    } catch {
      return null;
    }
  };
}

/** Ask each linked page once for the ids its runs name, then resolve. */
export async function fetchAndResolveXrefs(cands: readonly XrefCandidate[], fetchRef: XrefFetch, language = "en"): Promise<number> {
  if (!cands.length) return 0;
  const byPage = new Map<string, Set<string>>();
  for (const c of cands) {
    if (!c.relPath) continue;
    const set = byPage.get(c.relPath) ?? new Set<string>();
    for (const id of c.ids) set.add(id);
    byPage.set(c.relPath, set);
  }
  const answers = new Map<string, XrefAnswer | null>();
  await Promise.all(
    [...byPage].map(async ([relPath, ids]) => {
      answers.set(relPath, await fetchRef(relPath, [...ids]));
    }),
  );
  return resolveXrefRuns(cands, answers, language);
}

// ── Hover card ───────────────────────────────────────────────────────────
// The card itself is the in-page peek's (`wiki-ref-links.ts`): one card, one
// Escape owner, its focus, scroll and resize guards. This module gives it a
// body for an `a.wiki-xref`.

/** The cross-page card's id, beside the in-page card's class. */
export const XREF_PEEK_ID = "wiki-xref-peek";

/** The state line of a question item: `Closed → D2`, `Closed`, `Open`. */
export function xrefStateLine(t: XrefTarget, language: string): string {
  const no = language === "no";
  if (t.state === "decided") return `${no ? "Lukket" : "Closed"} → ${t.decision}`;
  if (t.state === "closed") return no ? "Lukket" : "Closed";
  if (t.state === "open") return no ? "Åpen" : "Open";
  return "";
}

/** The hover card's lines for one link, in order. */
export function xrefPeekLines(t: XrefTarget, language: string): { cls: string; text: string }[] {
  const lines = [{ cls: "xref-text", text: t.text }];
  if (t.answer) lines.push({ cls: "xref-answer", text: t.answer });
  const meta = [xrefStateLine(t, language), t.date ?? ""].filter(Boolean).join(" · ");
  if (meta) lines.push({ cls: "xref-meta", text: meta });
  return lines.filter((l) => l.text);
}

/** The card's parts for a resolved link: the id, the linked page's title and
 *  the item's lines. Null for a link this module did not make. */
export function xrefPeekParts(a: HTMLAnchorElement): { label: string; where: string; body: Node[] } | null {
  const info = linkInfo.get(a);
  if (!info) return null;
  const body = xrefPeekLines(info.target, info.language).map((l) => {
    const p = document.createElement("div");
    p.className = l.cls;
    p.textContent = l.text;
    return p;
  });
  return { label: info.id, where: info.title, body };
}

/** The reader's CSS for a cross-page id link and its card's lines. */
export function crossRefsCss(): string {
  return `
    .wiki-article a.${XREF_CLASS} { color: var(--accent-light); text-decoration: underline dashed; text-underline-offset: 3px; }
    .wiki-article a.${XREF_CLASS}:hover, .wiki-article a.${XREF_CLASS}:focus-visible { text-decoration-style: solid; }
    .${XREF_PEEK_ID} .xref-answer { color: var(--text-primary); }
    .${XREF_PEEK_ID} .xref-meta { color: var(--text-soft); font-size: 0.9em; }
  `;
}
