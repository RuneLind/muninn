/**
 * Pure context/prompt assembly for the wiki reader's Select-to-Explain feature
 * (`GET /api/wiki/explain`). Given a reader-selected passage, the page it came
 * from, and the wiki's semantic cousins, this module composes the retrieval seed
 * question and the per-wiki synthesis system prompt. The route stays a thin I/O
 * shell: it reads the body + fetches similar titles, then calls
 * {@link buildExplainAskOptions}; it never composes prompts itself.
 *
 * Kept side-effect-free (no Huginn, no `claude` spawn, no filesystem) so the
 * locator + prompt shapes unit-test in isolation — this is the test seam.
 */

import { buildSynthesisSystemPrompt } from "../research/answer.ts";

/** Server-side cap on the selected passage (chars) — a runaway selection can't blow the prompt. */
export const EXPLAIN_SELECTION_MAX = 1500;
/** Server-side cap on the optional heading/section hint (chars). */
export const EXPLAIN_HEADING_MAX = 200;
/** Chars of the original body kept either side of a located selection. */
export const EXPLAIN_WINDOW = 1200;
/** Bodies at or below this length skip locating — the whole page is sent as the excerpt. */
export const EXPLAIN_FULL_BODY_MAX = 3000;

/**
 * Collapse markdown source toward the plain, whitespace-normalized text a reader
 * would have selected from the RENDERED HTML, while recording, for every emitted
 * char, the offset it came from in the ORIGINAL body. That offset map is what
 * lets {@link locateExcerpt} snap a collapsed-space match back to a real body
 * window.
 *
 * "Collapse" strips, deterministically:
 *  - whitespace runs → a single space (leading whitespace dropped entirely);
 *  - the emphasis/code markers `*`, `_`, and backtick (so `**foo**` ≈ `foo`);
 *  - markdown links `[label](url)` → `label` (the URL and brackets vanish).
 *
 * It is intentionally shallow — it does not touch headings `#`, list bullets, or
 * HTML entities — because the selection comes from rendered text and only needs
 * to survive the most common inline-markup mismatches.
 */
function collapseWithMap(text: string): { collapsed: string; map: number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  let lastWasSpace = true; // true so any leading whitespace is dropped

  const emit = (ch: string, origIdx: number) => {
    if (/\s/.test(ch)) {
      if (lastWasSpace) return; // collapse runs; drop leading
      chars.push(" ");
      map.push(origIdx);
      lastWasSpace = true;
    } else {
      chars.push(ch);
      map.push(origIdx);
      lastWasSpace = false;
    }
  };

  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i]!;
    if (ch === "*" || ch === "_" || ch === "`") {
      i++;
      continue; // strip inline markup marker
    }
    if (ch === "[") {
      // Match `[label](url)` and emit only the label; skip the URL wholesale.
      const close = text.indexOf("]", i + 1);
      if (close !== -1 && text[close + 1] === "(") {
        const urlEnd = text.indexOf(")", close + 2);
        if (urlEnd !== -1) {
          for (let j = i + 1; j < close; j++) {
            const lc = text[j]!;
            if (lc === "*" || lc === "_" || lc === "`") continue;
            emit(lc, j);
          }
          i = urlEnd + 1;
          continue;
        }
      }
    }
    emit(ch, i);
    i++;
  }
  return { collapsed: chars.join(""), map };
}

/** ±`EXPLAIN_WINDOW` chars of the original body around a collapsed-space match,
 *  snapped out to line boundaries and trimmed. */
function windowAround(body: string, map: number[], collapsedIdx: number, collapsedLen: number): string {
  const origStart = map[collapsedIdx] ?? 0;
  const origEnd = (map[collapsedIdx + collapsedLen - 1] ?? origStart) + 1;
  let start = Math.max(0, origStart - EXPLAIN_WINDOW);
  let end = Math.min(body.length, origEnd + EXPLAIN_WINDOW);
  // Snap outward to whole lines so the excerpt reads as intact paragraphs.
  const nlBefore = body.lastIndexOf("\n", start);
  start = nlBefore === -1 ? 0 : nlBefore + 1;
  const nlAfter = body.indexOf("\n", end);
  end = nlAfter === -1 ? body.length : nlAfter;
  return body.slice(start, end).trim();
}

/** Locate the markdown section whose heading text contains `heading`
 *  (case-insensitive), from that heading to the next same-or-higher-level
 *  heading, capped at `2 × EXPLAIN_WINDOW`. Null when no heading matches. */
function locateHeadingSection(body: string, heading: string): string | null {
  const needle = heading.trim().toLowerCase();
  if (!needle) return null;
  const lines = body.split("\n");
  let startLine = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^(#{1,6})\s+(.*)$/);
    if (m && m[2]!.toLowerCase().includes(needle)) {
      startLine = i;
      level = m[1]!.length;
      break;
    }
  }
  if (startLine === -1) return null;
  let endLine = lines.length;
  for (let i = startLine + 1; i < lines.length; i++) {
    const m = lines[i]!.match(/^(#{1,6})\s+/);
    if (m && m[1]!.length <= level) {
      endLine = i;
      break;
    }
  }
  return lines.slice(startLine, endLine).join("\n").trim().slice(0, 2 * EXPLAIN_WINDOW);
}

/**
 * Best-effort locate the reader's `selection` inside the markdown `body` and
 * return a bounded excerpt around it. The selection comes from rendered HTML and
 * the body is markdown source, so an exact `indexOf` usually fails — the locator
 * is deliberately tolerant, in order:
 *  1. Whitespace/markup-collapse both, match the collapsed selection, map back.
 *  2. Retry with only the first 80 collapsed chars of the selection.
 *  3. If a `heading` hint is given, return that markdown section.
 *  4. Fall back to the head of the body (`2 × EXPLAIN_WINDOW` chars).
 * Bodies ≤ {@link EXPLAIN_FULL_BODY_MAX} skip all of this and return whole.
 */
export function locateExcerpt(body: string, selection: string, heading?: string): string {
  if (body.length <= EXPLAIN_FULL_BODY_MAX) return body.trim();

  const { collapsed: cBody, map } = collapseWithMap(body);
  const cSel = collapseWithMap(selection).collapsed.trim();

  const tryHit = (needle: string): string | null => {
    if (!needle) return null;
    const idx = cBody.indexOf(needle);
    if (idx === -1) return null;
    return windowAround(body, map, idx, needle.length);
  };

  // Step 1: full collapsed selection.
  const full = tryHit(cSel);
  if (full) return full;

  // Step 2: prefix of the collapsed selection (long selections often mismatch on
  // a trailing link/footnote the rendered text carried differently).
  const prefix = tryHit(cSel.slice(0, 80));
  if (prefix) return prefix;

  // Step 3: heading hint.
  if (heading) {
    const section = locateHeadingSection(body, heading);
    if (section) return section;
  }

  // Step 4: head of the body.
  return body.slice(0, 2 * EXPLAIN_WINDOW).trim();
}

/**
 * The user-facing question string — also the retrieval seed (fed through
 * `buildRetrievalQuestion` verbatim, so the decomposer sees the selection), the
 * `/agents` run name, and the citation-log key. Keeps the selection quoted so
 * the model knows exactly what to explain.
 */
export function buildExplainQuestion(selection: string, pageTitle: string): string {
  return `Explain this passage from "${pageTitle}": "${selection.trim()}"`;
}

/**
 * The article-context block appended to the synthesis system prompt: the page's
 * metadata, the excerpt around the selection, and (when non-empty) the wiki's
 * related pages, followed by the explain instruction. The related-pages line is
 * omitted entirely when `similarTitles` is empty (degrade path — no dangling
 * "Related pages: " label).
 */
export function buildExplainContextBlock(input: {
  meta: { title: string; tags: string[]; type: string };
  excerpt: string;
  similarTitles: string[];
}): string {
  const { meta, excerpt, similarTitles } = input;
  const lines = [
    "ARTICLE CONTEXT (the passage the reader selected comes from this page):",
    `Title: ${meta.title}   Tags: ${meta.tags.join(", ")}   Type: ${meta.type}`,
    "Excerpt around the selection:",
    '"""',
    excerpt,
    '"""',
  ];
  if (similarTitles.length) {
    lines.push(`Related pages in this wiki: ${similarTitles.join(", ")}`);
  }
  lines.push("");
  lines.push(
    "Explain the selected passage for a reader of this article: what it means, where it " +
      "comes from, and what the wiki's sources add. Ground claims in the numbered sources; " +
      "the article context above is background, not a citable source. If the sources don't " +
      "cover something, say so.",
  );
  return lines.join("\n");
}

/**
 * End-to-end composition for the explain route: locate the excerpt, build the
 * question, and assemble the per-wiki synthesis system prompt (framing line +
 * shared rules body, via `buildSynthesisSystemPrompt`, then the context block).
 * The route supplies the raw body + similar titles and never composes prompts
 * itself — this is the thin-I/O-shell seam and the primary unit-test entry point.
 */
export function buildExplainAskOptions(input: {
  meta: { title: string; tags: string[]; type: string };
  body: string;
  sel: string;
  ctx?: string;
  similarTitles: string[];
  wikiName: string;
}): { question: string; systemPrompt: string } {
  const { meta, body, sel, ctx, similarTitles, wikiName } = input;
  const excerpt = locateExcerpt(body, sel, ctx);
  const question = buildExplainQuestion(sel, meta.title);
  const contextBlock = buildExplainContextBlock({ meta, excerpt, similarTitles });
  const systemPrompt =
    buildSynthesisSystemPrompt(
      `You explain passages from the "${wikiName}" knowledge wiki, using ONLY the numbered sources provided in the user message.`,
    ) +
    "\n\n" +
    contextBlock;
  return { question, systemPrompt };
}
