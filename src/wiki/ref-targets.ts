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
import type { XrefKind, XrefTarget } from "./core/cross-ref.ts";
import { decisionText } from "./decision-text.ts";

/** `escapeHtml`'s entities and numeric references back to text. */
function decode(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|#x[0-9a-f]+|#[0-9]+);/gi, (_m, e: string) => {
    const k = e.toLowerCase();
    if (k === "amp") return "&";
    if (k === "lt") return "<";
    if (k === "gt") return ">";
    if (k === "quot") return '"';
    if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16));
    return String.fromCodePoint(Number(k.slice(1)));
  });
}

/** An HTML fragment's text, whitespace collapsed. */
function plain(html: string): string {
  return decode(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
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
      const text = entry ? leadSentence(entry.itemText) : plain(li.replace(/^[\s\S]*?<\/a>/, ""));
      out[id] = {
        kind: "decision",
        anchor: c.anchor,
        text,
        ...(isDecision ? {} : stateFields(page.states.get(id))),
        ...(date ? { date } : {}),
      };
    } else if (c.kind === "query") {
      const sec = segment(html, c.at, '<details class="query-sql"');
      const question = /<span class="query-question">([\s\S]*?)<\/span>/.exec(sec)?.[1];
      const answer = /<div class="query-answer">([\s\S]*?)<\/div>/.exec(sec)?.[1];
      out[id] = {
        kind: "query",
        anchor: c.anchor,
        text: question ? plain(question) : "",
        ...(answer ? { answer: plain(answer) } : {}),
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
