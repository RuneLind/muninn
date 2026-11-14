/**
 * `GET /api/wiki/ref`'s answer, from one page render (living facts PR 4): for
 * each asked id the page defines, the kind, the anchor and the hover text.
 *
 * The targets are read off the FINISHED HTML of the page route's render, so an
 * anchor is the one the render's id allocator gave (`-2` when another element
 * already held the slug, `uniqueLogAnchors` in `web-format.ts`), and the
 * choice of target is the in-page linker's (`refTargets` in
 * `wiki-ref-links.ts`): chips in document order over the three `ID_TARGETS`
 * kinds, keyed by their text, and a key two chips carry names no target —
 * on the linked page itself that id links nowhere, so a cross-page reference
 * to it stays plain too.
 */

import { leadSentence } from "../format/lead-sentence.ts";
import { parseBlocks } from "../format/markdown-ast.ts";
import { DECISION_ID_RE, parseQuestionPage, type QuestionState } from "../format/question.ts";
import { decodeBasicCharRefs } from "../format/safe-link-href.ts";
import type { XrefKind, XrefTarget } from "./core/cross-ref.ts";
import { decisionText } from "./decision-text.ts";
import { stripMarkdownSyntax } from "./walkthrough.ts";

/** An HTML fragment's text, whitespace collapsed. */
function plain(html: string): string {
  return decodeBasicCharRefs(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

/** The element whose open tag starts at `at`, to its balanced `</tag>`:
 *  where its content starts, where its close tag starts and ends. */
function balanced(html: string, at: number, tag: string): { inner: number; close: number; end: number } {
  const inner = html.indexOf(">", at) + 1;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  re.lastIndex = inner;
  let depth = 1;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (!m[1]) depth++;
    else if (--depth === 0) return { inner, close: m.index, end: m.index + m[0].length };
  }
  return { inner, close: html.length, end: html.length };
}

/** The inner HTML of the first `<tag class="cls">` in `html`, balanced; null when there is none. */
function innerOf(html: string, tag: string, cls: string): string | null {
  const at = html.indexOf(`<${tag} class="${cls}"`);
  if (at === -1) return null;
  const b = balanced(html, at, tag);
  return html.slice(b.inner, b.close);
}

/** `html` without its glossary definitions (`.gl-tip`): hidden tooltip text. */
function withoutTips(html: string): string {
  for (let at = html.indexOf('<span class="gl-tip"'); at !== -1; at = html.indexOf('<span class="gl-tip"', at)) {
    html = html.slice(0, at) + html.slice(balanced(html, at, "span").end);
  }
  return html;
}

/** A DecisionLog item's lead sentence as plain text. Code and emphasis syntax
 *  (`~~`, `*`, `_`, `**`) go first, so a bold opening is part of the sentence
 *  rather than all of it; `leadSentence` flattens the links. */
function itemLead(itemText: string): string {
  return leadSentence(stripMarkdownSyntax(itemText.split("\n")[0]!, { emphasis: true }));
}

/** The in-page linker's id test (`isRefId`): two or more characters, one a letter. */
function isRefId(key: string): boolean {
  return /\p{L}/u.test(key) && [...key].length >= 2;
}

interface Chip {
  key: string;
  kind: XrefKind;
  anchor: string;
  /** Where the target element starts in the HTML. */
  at: number;
}

const DL_RE = /<li class="(dl-item[^"]*)"(?: value="\d+")? id="([^"]+)"([^>]*)>(?:<span class="id-noun"[^>]*>[^<]*<\/span> )?<a class="dl-id" href="#\2">([^<]*)<\/a>/g;
const QUERY_RE = /<section class="query" id="([^"]+)">[\s\S]*?<a class="query-id" href="#\1">([^<]*)<\/a>/g;
const CASE_RE = /<div class="cb-row" id="([^"]+)">[\s\S]*?<a class="cb-id" href="#\1">([^<]*)<\/a>/g;

/** Every id chip in the render, in document order. */
function chips(html: string): Chip[] {
  const out: Chip[] = [];
  for (const m of html.matchAll(DL_RE)) out.push({ key: plain(m[4]!), kind: "decision", anchor: m[2]!, at: m.index });
  for (const m of html.matchAll(QUERY_RE)) out.push({ key: plain(m[2]!), kind: "query", anchor: m[1]!, at: m.index });
  for (const m of html.matchAll(CASE_RE)) out.push({ key: plain(m[2]!), kind: "case", anchor: m[1]!, at: m.index });
  return out.sort((a, b) => a.at - b.at);
}

/** The text of the element whose open tag starts at `at`, up to `close`. */
function segment(html: string, at: number, close: string): string {
  const end = html.indexOf(close, at);
  return end === -1 ? html.slice(at) : html.slice(at, end);
}

function stateFields(state: QuestionState | undefined): Pick<XrefTarget, "state" | "decision"> {
  if (!state) return {};
  if (state.kind === "decided") return { state: "decided", decision: state.decision };
  return { state: state.kind };
}

/**
 * The targets `ids` name on the page rendered as `html` from `markdown`. An id
 * the page does not define, or defines twice, is left out.
 */
export function pageRefTargets(html: string, markdown: string, ids: readonly string[]): Record<string, XrefTarget> {
  const want = new Set(ids);
  const byKey = new Map<string, Chip | null>();
  for (const c of chips(html)) {
    if (!c.key || !isRefId(c.key)) continue;
    byKey.set(c.key, byKey.has(c.key) ? null : c);
  }
  const out: Record<string, XrefTarget> = {};
  let page: ReturnType<typeof parseQuestionPage> | null = null;
  for (const id of want) {
    const c = byKey.get(id);
    if (!c) continue;
    if (c.kind === "decision") {
      page ??= parseQuestionPage(parseBlocks(decisionText(markdown)));
      const entry = page.entries.find((e) => e.id === id);
      const li = segment(html, c.at, "</li>");
      const date = /data-item-date="(\d{4}-\d{2}-\d{2})"/.exec(li)?.[1];
      const isDecision = DECISION_ID_RE.test(id) || /\bdl-decision\b/.test(li.slice(0, li.indexOf(">")));
      const text = entry ? itemLead(entry.itemText) : plain(li.replace(/^[\s\S]*?<\/a>/, ""));
      out[id] = {
        kind: "decision",
        anchor: c.anchor,
        text,
        ...(isDecision ? {} : stateFields(page.states.get(id))),
        ...(date ? { date } : {}),
      };
    } else if (c.kind === "query") {
      // The card's own head (every card renders one), so a card without a
      // question or an answer never reads the next card's.
      const head = innerOf(html.slice(c.at), "div", "query-head") ?? "";
      const question = innerOf(head, "span", "query-question");
      const answer = innerOf(head, "div", "query-answer");
      out[id] = {
        kind: "query",
        anchor: c.anchor,
        text: question ? plain(withoutTips(question)) : "",
        ...(answer ? { answer: plain(withoutTips(answer)) } : {}),
      };
    } else {
      const row = segment(html, c.at, "</div>");
      const pill = /<span class="cb-pill[^"]*"[^>]*>([^<]*)<\/span>/.exec(row)?.[1];
      const owner = /<span class="cb-owner">([^<]*)<\/span>/.exec(row)?.[1];
      const note = /<span class="cb-note">([\s\S]*?)<\/span>(?=<span class="cb-refs">|$)/.exec(row)?.[1];
      out[id] = {
        kind: "case",
        anchor: c.anchor,
        text: [pill, owner, note].filter((x): x is string => !!x).map(plain).filter(Boolean).join(" · "),
      };
    }
  }
  return out;
}
