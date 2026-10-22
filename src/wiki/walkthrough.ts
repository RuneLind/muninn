/**
 * «Walk me through» — the pure server half: find a section by its heading,
 * reduce it to plain text, build the prompt, parse the model's JSON, and drop
 * every step or question whose quote is not in the section.
 *
 * **Which headings count.** The reader puts the button on the headings that are
 * direct children of the rendered article (`.wiki-article > h1…h6`). In the
 * renderer only a markdown heading emits an `<hN>`, and a TOP-LEVEL heading
 * block is exactly the one whose element is a direct child: a heading inside a
 * `<Fold>` or any other component renders inside that component's wrapper, a
 * heading inside a code fence renders as code. So the server counts the
 * top-level heading blocks of `parseBlocks(readerBody(page))` — the same parse
 * the renderer runs over the same text — and both sides compare heading TEXT
 * as rendered: the reader its `textContent`, the server the heading rendered
 * through `renderWikiHtml` and reduced to text. Inline code, links, emphasis,
 * wikilinks and inline components therefore compare as the reader shows them.
 *
 * **Where a section ends.** At the next top-level heading of the same or a
 * higher level (fewer `#`), else at the end of the page.
 *
 * **One plain text, two readers.** The model is given the section as
 * {@link sectionPlainText}. A quote matches when it is a substring of that text
 * after {@link foldForMatch} on both sides (Unicode NFC, a small typography fold,
 * whitespace collapsed). The quote is never re-rendered as markdown: a faithful
 * copy of the text the model saw, literal `**` from a code span included,
 * matches as written. Failing that, one second try strips the emphasis and code
 * markers `*`, `_`, `~` and the backtick from the quote alone, so `**review gate**` matches
 * `review gate`; a link destination or a wikilink target is content, not a
 * marker, so a quote adding one does not match. A kept item's `quote` is
 * replaced by the matching span of the section's plain text, so the panel only
 * ever shows text that is in the section.
 */

import { parseBlocks, headingLine } from "../format/markdown-ast.ts";
import { readerBody, renderWikiHtml } from "./render.ts";
import type { WikiPageMeta } from "./store.ts";
import { neutralizePromptFence, stripWrappingFence } from "../utils/prompt-fence.ts";
import {
  normalizeHeadingText,
  type WalkthroughDrop,
  type WalkthroughQuestion,
  type WalkthroughStep,
} from "./walkthrough-wire.ts";

/** Plain-text cap on one section. A bound, not a budget: a section past it is
 *  refused rather than clipped, since a clipped section would quote-check
 *  against text the reader can see but the model never got. */
export const WALKTHROUGH_SECTION_MAX = 16_000;

/** A quote shorter than this (plain-text characters) is dropped: a two-word
 *  quote matches almost any section and grounds nothing. */
export const WALKTHROUGH_QUOTE_MIN = 12;

/** Caps on what the reply may carry; extra items are ignored, not dropped. */
export const WALKTHROUGH_MAX_STEPS = 8;
export const WALKTHROUGH_MAX_QUESTIONS = 5;

type Resolve = (target: string) => WikiPageMeta | undefined;

const BLOCK_TAGS =
  "p|div|li|ul|ol|h[1-6]|tr|td|th|table|thead|tbody|section|blockquote|pre|details|summary|figure|figcaption|dt|dd|dl|hr|br|aside|header|footer";
const BLOCK_TAG_RE = new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, "gi");

function decodeEntities(s: string): string {
  const fromCode = (n: number): string => {
    try {
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    } catch {
      return "";
    }
  };
  return s
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => fromCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => fromCode(parseInt(d, 10)))
    .replace(/&amp;/gi, "&");
}

/**
 * Rendered HTML to the text a reader sees, whitespace collapsed: an inline tag
 * disappears (as in `textContent`, so `**a**b` reads `ab`), a block tag becomes
 * a space, script/style/svg go whole. Prompt input and quote-check input only —
 * never re-inserted into HTML.
 */
export function htmlPlainText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(BLOCK_TAG_RE, " ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** Markdown to the plain text the quote check compares: rendered through the
 *  reader's own renderer, then {@link htmlPlainText}. A `"""` run collapses to
 *  one quote, as it does in the prompt (`neutralizePromptFence`). */
export function sectionPlainText(markdown: string, resolve: Resolve = () => undefined): string {
  return neutralizePromptFence(htmlPlainText(renderWikiHtml(markdown, resolve)));
}

export interface LocatedSection {
  level: number;
  /** The heading as both sides compare it. */
  headingText: string;
  /** The section's source, heading line excluded. */
  markdown: string;
}

export type LocateResult =
  | { ok: true; section: LocatedSection }
  | { ok: false; reason: "not_found" | "count_mismatch"; found: number };

/** Every heading the reader decorates, in document order. */
export function eligibleHeadings(
  markdown: string,
  opts: { stripTitle?: string; resolve?: Resolve } = {},
): { level: number; text: string; line: number }[] {
  const body = readerBody(markdown, opts.stripTitle);
  const out: { level: number; text: string; line: number }[] = [];
  for (const b of parseBlocks(body)) {
    if (b.type !== "heading") continue;
    const line = headingLine(b);
    if (line === undefined) continue;
    const text = normalizeHeadingText(
      htmlPlainText(renderWikiHtml(`${"#".repeat(b.level)} ${b.content}`, opts.resolve ?? (() => undefined))),
    );
    out.push({ level: b.level, text, line });
  }
  return out;
}

/**
 * Find the `ordinal`-th section headed `heading`. `count` is how many headings
 * the reader saw with that text: when the page now has a different number, the
 * ordinal may name another section, so the answer is `count_mismatch` rather
 * than a guess.
 */
export function locateSection(
  markdown: string,
  req: { heading: string; ordinal: number; count: number; stripTitle?: string; resolve?: Resolve },
): LocateResult {
  const want = normalizeHeadingText(req.heading);
  const all = eligibleHeadings(markdown, { stripTitle: req.stripTitle, resolve: req.resolve });
  const same = all.filter((h) => h.text === want);
  if (same.length === 0) return { ok: false, reason: "not_found", found: 0 };
  if (same.length !== req.count || req.ordinal >= same.length) {
    return { ok: false, reason: "count_mismatch", found: same.length };
  }
  const head = same[req.ordinal]!;
  const next = all.find((h) => h.line > head.line && h.level <= head.level);
  const lines = readerBody(markdown, req.stripTitle).replace(/\r\n/g, "\n").split("\n");
  const section = lines.slice(head.line + 1, next ? next.line : lines.length).join("\n");
  return { ok: true, section: { level: head.level, headingText: head.text, markdown: section } };
}

export function buildWalkthroughSystemPrompt(wikiName: string): string {
  const where = wikiName ? ` from the "${neutralizePromptFence(wikiName)}" wiki` : "";
  return (
    `You turn one section of a page${where} into a short guided walkthrough and a quiz ` +
    "for a reader who wants to understand it. You use only the section you are given. " +
    "Answer with one JSON object and nothing else — no preamble, no code fence."
  );
}

export function buildWalkthroughUserPrompt(input: {
  pageTitle: string;
  heading: string;
  sectionText: string;
}): string {
  return [
    "Write a walkthrough of the SECTION below: 3 to 6 steps that take the reader through it in order, " +
      "then 2 to 4 multiple-choice questions that check they understood it.",
    "Rules:",
    "- Every step and every question carries a `quote`: a passage copied VERBATIM from the section " +
      "(one sentence or a phrase of at least a few words). Copy it character for character; do not " +
      "paraphrase, translate, shorten with an ellipsis, or join two passages.",
    "- A step's `text` explains that passage in one to three plain sentences. Its `title` is a few words.",
    "- A question has 3 or 4 `choices`; `answer` is the 0-based index of the right one, and its `quote` " +
      "is the passage that shows the answer.",
    "- Write in the language of the section.",
    "Answer with exactly this JSON shape:",
    '{"steps":[{"title":"…","text":"…","quote":"…"}],"quiz":[{"question":"…","choices":["…","…","…"],"answer":0,"quote":"…"}]}',
    `PAGE: "${neutralizePromptFence(input.pageTitle.trim()) || "(untitled)"}"`,
    `SECTION: "${neutralizePromptFence(input.heading)}"\n"""\n${neutralizePromptFence(input.sectionText)}\n"""`,
  ].join("\n\n");
}

/** The reply's shape, before the quote check. Items failing their own shape are
 *  counted as `malformed` drops rather than failing the whole reply. */
export interface ParsedWalkthrough {
  steps: WalkthroughStep[];
  quiz: WalkthroughQuestion[];
  dropped: WalkthroughDrop[];
}

const nonBlank = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/**
 * Parse the model's reply. `null` — a parse failure the route reports as an
 * `app_error` — when it is not a JSON object carrying a `steps` array. A
 * wrapping code fence and text around the object are tolerated.
 */
export function parseWalkthroughReply(raw: string): ParsedWalkthrough | null {
  const text = stripWrappingFence(raw ?? "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = obj as { steps?: unknown; quiz?: unknown };
  if (!Array.isArray(o.steps)) return null;
  const dropped: WalkthroughDrop[] = [];
  const steps: WalkthroughStep[] = [];
  for (const s of o.steps.slice(0, WALKTHROUGH_MAX_STEPS)) {
    const st = s as Partial<WalkthroughStep> | null;
    if (st && nonBlank(st.title) && nonBlank(st.text) && nonBlank(st.quote)) {
      steps.push({ title: st.title.trim(), text: st.text.trim(), quote: st.quote.trim() });
    } else dropped.push({ kind: "step", reason: "malformed" });
  }
  const quiz: WalkthroughQuestion[] = [];
  const rawQuiz = Array.isArray(o.quiz) ? o.quiz : [];
  for (const q of rawQuiz.slice(0, WALKTHROUGH_MAX_QUESTIONS)) {
    const qu = q as Partial<WalkthroughQuestion> | null;
    const choices = Array.isArray(qu?.choices) ? qu!.choices : [];
    const ok =
      qu &&
      nonBlank(qu.question) &&
      nonBlank(qu.quote) &&
      choices.length >= 2 &&
      choices.length <= 6 &&
      choices.every(nonBlank) &&
      Number.isInteger(qu.answer) &&
      (qu.answer as number) >= 0 &&
      (qu.answer as number) < choices.length;
    if (ok) {
      quiz.push({
        question: qu.question!.trim(),
        choices: choices.map((c) => (c as string).trim()),
        answer: qu.answer as number,
        quote: qu.quote!.trim(),
      });
    } else dropped.push({ kind: "question", reason: "malformed" });
  }
  return { steps, quiz, dropped };
}

/** Glyph variants a faithful copy may change, folded to one spelling on both
 *  sides of the match. Whitespace (nbsp included) is collapsed separately. */
const TYPOGRAPHY_FOLD: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "‛": "'", "‹": "'", "›": "'",
  "“": '"', "”": '"', "„": '"', "‟": '"', "«": '"', "»": '"',
  "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-", "−": "-",
  "→": "->", "←": "<-", "↔": "<->", "⇒": "=>", "…": "...",
  "­": "", "​": "", "‌": "", "‍": "", "﻿": "",
};

/** One character cluster (a base and its combining marks) at a time, so every
 *  folded character can be traced back to the span of the source it came from. */
const CLUSTER_RE = /\P{M}\p{M}*|\p{M}+/gu;

interface FoldedText {
  text: string;
  /** Per folded character: the source offsets of the cluster it came from. */
  from: number[];
  to: number[];
}

/**
 * The text the quote check compares: Unicode NFC, {@link TYPOGRAPHY_FOLD},
 * whitespace runs collapsed to one space, trimmed — with a map back to the
 * source so a match can be shown in the section's own spelling.
 */
export function foldForMatch(s: string): FoldedText {
  let text = "";
  const from: number[] = [];
  const to: number[] = [];
  for (const m of s.matchAll(CLUSTER_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (/^\s+$/.test(m[0])) {
      if (text === "" || text.endsWith(" ")) continue;
      text += " ";
      from.push(start);
      to.push(end);
      continue;
    }
    for (const ch of m[0].normalize("NFC")) {
      const out = TYPOGRAPHY_FOLD[ch] ?? ch;
      for (const o of out) {
        text += o;
        from.push(start);
        to.push(end);
      }
    }
  }
  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    from.pop();
    to.pop();
  }
  return { text, from, to };
}

/** Emphasis and code markers a quote may carry that the plain text does not. */
const MARKDOWN_MARKERS_RE = /[*_`~]/g;

/**
 * Keep the steps and questions whose quote appears in the section's plain
 * text (see the module header for the rule), each with its `quote` replaced by
 * the matching span of that text.
 */
export function checkQuotes(parsed: ParsedWalkthrough, sectionText: string): ParsedWalkthrough {
  const dropped = [...parsed.dropped];
  const section = foldForMatch(sectionText);
  const verdict = (quote: string): { shown: string } | { reason: WalkthroughDrop["reason"] } => {
    const tries = [foldForMatch(quote).text, foldForMatch(quote.replace(MARKDOWN_MARKERS_RE, "")).text];
    if (tries.every((t) => t.length < WALKTHROUGH_QUOTE_MIN)) return { reason: "quote_too_short" };
    for (const t of tries) {
      if (t.length < WALKTHROUGH_QUOTE_MIN) continue;
      const at = section.text.indexOf(t);
      if (at !== -1) return { shown: sectionText.slice(section.from[at]!, section.to[at + t.length - 1]!) };
    }
    return { reason: "quote_not_in_section" };
  };
  const steps: WalkthroughStep[] = [];
  for (const s of parsed.steps) {
    const v = verdict(s.quote);
    if ("reason" in v) dropped.push({ kind: "step", reason: v.reason });
    else steps.push({ ...s, quote: v.shown });
  }
  const quiz: WalkthroughQuestion[] = [];
  for (const q of parsed.quiz) {
    const v = verdict(q.quote);
    if ("reason" in v) dropped.push({ kind: "question", reason: v.reason });
    else quiz.push({ ...q, quote: v.shown });
  }
  return { steps, quiz, dropped };
}
