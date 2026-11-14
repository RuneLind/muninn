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

/** CommonMark's backslash-escapable characters (ASCII punctuation). */
const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
/** ASCII punctuation `leadSentence` must read as plain text goes to the Private
 *  Use Area (U+E000 + its code) and comes back after it. */
const hide = (c: string): string => String.fromCharCode(0xe000 + c.charCodeAt(0));
const unhide = (s: string): string => s.replace(/[-]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xe000));
const isSpace = (c: string | undefined): boolean => c === undefined || /\s/u.test(c);
const isPunct = (c: string | undefined): boolean => c !== undefined && /[\p{P}\p{S}]/u.test(c);

/**
 * One markdown line as display text, inline syntax only: no block marker goes
 * (`> 5 saker`, `3. juli` and `# 3` keep their first character, unlike the
 * walkthrough's quote matcher). A backslash escape and a code span's content
 * are literal (returned hidden, see `hide`); an emphasis or strike run (`*`,
 * `_`, `~`) goes when it pairs under CommonMark's flanking rules. With
 * `dropStruck`, a `~~…~~` run goes with its words. Links are `leadSentence`'s.
 */
function inlineDisplay(s: string, dropStruck: boolean): string {
  type Piece = { text: string; delim?: { ch: string; n: number; open: boolean; close: boolean } };
  const pieces: Piece[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "\\" && ASCII_PUNCT.test(s[i + 1] ?? "")) {
      pieces.push({ text: hide(s[i + 1]!) });
      i += 2;
      continue;
    }
    if (c === "`") {
      let n = 1;
      while (s[i + n] === "`") n++;
      const fence = "`".repeat(n);
      let close = s.indexOf(fence, i + n);
      while (close !== -1 && (s[close + n] === "`" || s[close - 1] === "`")) {
        let e = close;
        while (s[e] === "`") e++;
        close = s.indexOf(fence, e);
      }
      if (close === -1) {
        pieces.push({ text: fence });
        i += n;
      } else {
        let body = s.slice(i + n, close);
        if (body.length > 1 && body.startsWith(" ") && body.endsWith(" ") && body.trim() !== "") body = body.slice(1, -1);
        pieces.push({ text: body.replace(new RegExp(ASCII_PUNCT.source, "g"), hide) });
        i = close + n;
      }
      continue;
    }
    if (c === "*" || c === "_" || c === "~") {
      let n = 1;
      while (s[i + n] === c) n++;
      const before = s[i - 1];
      const after = s[i + n];
      const left = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before));
      const right = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after));
      const open = c === "_" ? left && (!right || isPunct(before)) : left;
      const close = c === "_" ? right && (!left || isPunct(after)) : right;
      // GFM strikethrough is one or two tildes; a closer pairs with an opener of its length.
      const delim = (open || close) && (c !== "~" || n <= 2) ? { ch: c, n, open, close } : undefined;
      pieces.push({ text: s.slice(i, i + n), delim });
      i += n;
      continue;
    }
    let j = i + 1;
    while (j < s.length && !"\\`*_~".includes(s[j]!)) j++;
    pieces.push({ text: s.slice(i, j) });
    i = j;
  }
  const openers: number[] = [];
  const drop = new Set<number>();
  pieces.forEach((p, k) => {
    const d = p.delim;
    if (!d) return;
    if (d.close) {
      const at = openers.findLastIndex((o) => {
        const od = pieces[o]!.delim!;
        return od.ch === d.ch && (d.ch !== "~" || od.n === d.n);
      });
      if (at !== -1) {
        const from = openers[at]!;
        if (dropStruck && d.ch === "~" && d.n === 2) for (let x = from; x <= k; x++) drop.add(x);
        else drop.add(from).add(k);
        openers.length = at;
        return;
      }
    }
    if (d.open) openers.push(k);
  });
  return pieces.map((p, k) => (drop.has(k) ? "" : p.text)).join("");
}

/** A DecisionLog item's lead sentence as plain text. Inline syntax goes first,
 *  so a bold opening is part of the sentence rather than all of it;
 *  `leadSentence` flattens the links. With `dropStruck` (an item with no
 *  question state) a `~~…~~` run is an overturned claim and is left out; an
 *  item struck whole keeps its struck words. */
function itemLead(itemText: string, dropStruck: boolean): string {
  const line = itemText.split("\n")[0]!;
  const kept = dropStruck ? inlineDisplay(line, true) : "";
  const text = (kept.trim() ? kept : inlineDisplay(line, false))
    .replace(/\s+/g, " ")
    // An ordinal's dot before a lower-case word (`3. juli`) ends no sentence.
    .replace(/(^|\s)(\d+)\.(?= \p{Ll})/gu, (_, sp: string, n: string) => sp + n + hide("."));
  return unhide(leadSentence(text));
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
      const state = isDecision ? {} : stateFields(page.states.get(id));
      const text = entry ? itemLead(entry.itemText, !state.state) : plain(li.replace(/^[\s\S]*?<\/a>/, ""));
      out[id] = {
        kind: "decision",
        anchor: c.anchor,
        text,
        ...state,
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
