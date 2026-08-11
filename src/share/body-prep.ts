/**
 * Body prep for the share flow — turning what is ON DISK (a wiki page, an HTML
 * explainer, a capture summary doc) into the prose the share prompt is given.
 *
 * Everything here is pure: no filesystem, no model call, no huginn. Each strip
 * step reuses the module that already owns it rather than re-spelling the regex,
 * which is what keeps this from becoming a fifth frontmatter parser.
 *
 * What is deliberately NOT done: the emphasis/backtick strip. A shared post keeps
 * its bold and its inline code — that is the whole difference between this and the
 * Atlas blurb's flattening (see `flattenWikiLinks` vs the private `flattenLinks`).
 */

import { stripFrontmatter, flattenWikiLinks } from "../wiki/store.ts";
import { stripFactcheckBlock } from "../wiki/factcheck-context.ts";
import { stripFactWrappers, COMPONENT_TAG_SOURCE_SINGLE_LINE } from "../format/markdown-ast.ts";
import { htmlToText } from "../wiki/explain-context.ts";
import { truncateUnits } from "../wiki/ask-chat.ts";

/**
 * Component tags (open/close/self-closing) whose attribute tail may NOT cross a
 * newline. Compiled here from the shared AST source rather than reusing
 * `src/wiki/similar.ts`'s `stripComponentTags`, for two reasons: that helper is
 * built on the newline-CROSSING `COMPONENT_TAG_SOURCE`, so a malformed opener
 * (`<Callout tone="info"` with its `>` missing) swallows every line down to the
 * next `>` anywhere in the page — deleting real prose from a shared post — and
 * importing it would drag the registry/store/huginn-client graph into a module
 * whose whole contract is "pure, no filesystem". `src/wiki/store.ts` reaches the
 * same single-line guarantee by applying its copy per line.
 */
const COMPONENT_TAG_RE = new RegExp(COMPONENT_TAG_SOURCE_SINGLE_LINE, "g");

/** Remove component tags, leaving their inner prose. */
function stripComponentTags(text: string): string {
  return text.replace(COMPONENT_TAG_RE, "");
}

/**
 * Hard cap on the prepared body handed to the share prompt. A bound, not a budget:
 * peer of `INTEGRATE_BODY_MAX` (24k) — generous enough that a normal wiki page or
 * capture summary never comes near it, small enough that one runaway page can't
 * blow the prompt. The clip is MARKED, so the model is never silently handed half
 * a document and asked to summarize "it".
 */
export const SHARE_BODY_MAX = 24_000;

/** The marker appended to a clipped body. Prose, because the model reads it. */
export const SHARE_BODY_CLIP_MARKER = "\n\n[The source was longer than this and has been cut off here.]";

/**
 * Clip a prepared body to {@link SHARE_BODY_MAX}, marking the cut. Truncation is
 * `truncateUnits` (surrogate-safe) for the same reason the ask-chat seed uses it:
 * a bare `slice` through an astral character leaves a U+FFFD.
 *
 * The MARKER IS INSIDE THE CAP — the prose budget is `max` minus the marker, so a
 * "hard cap" is one. Appended on top (as it was until the review) every clipped
 * body came back 62 characters over the bound the caller asked for. A `max`
 * smaller than the marker itself is degenerate; the marker still rides along,
 * because an unmarked clip hands the model half a document and asks it to
 * summarize "it".
 */
export function clipShareBody(body: string, max: number = SHARE_BODY_MAX): string {
  if (body.length <= max) return body;
  const budget = Math.max(0, max - SHARE_BODY_CLIP_MARKER.length);
  return truncateUnits(body, budget).trimEnd() + SHARE_BODY_CLIP_MARKER;
}

/**
 * Collapse the blank-line runs the strips leave behind (a stripped `<Callout>`
 * turns its open/close lines into empties), trim, then clip. Same collapse
 * `stripFactcheckBlock` already applies to a wiki body — this only extends it to
 * the other strip steps. Applied to the whole body including fences: a code
 * sample carrying three consecutive blank lines loses one, which is acceptable
 * for a body that exists to be summarized, not written back.
 */
function finish(body: string): string {
  return clipShareBody(body.replace(/\n{3,}/g, "\n\n").trim());
}

/**
 * A markdown wiki page (`.md` / `.mdx`) → shareable prose.
 *
 * Order is load-bearing:
 *  1. `stripFrontmatter` — the ONE home for this (`src/wiki/store.ts`; `render.ts`
 *     records it as such). No second copy gets promoted for share's sake.
 *  2. `stripFactcheckBlock` — a persisted `<!-- factcheck:start/end -->` callout is
 *     an appendix about the page, not the page. Runs BEFORE the wrapper strip so
 *     the block goes whole rather than leaving its inner prose behind.
 *  3. `stripFactWrappers` — zone-aware: a `<Fact>` inside a fence or backticks is
 *     documentation and survives (see `src/web/CLAUDE.md`).
 *  4. `stripComponentTags` (local, single-line — see above): keep the prose, drop
 *     the JSX-ish markup a native `.mdx` carries. Known limitation, shared with
 *     every other copy of this strip: unlike step 3 it is NOT code-region-aware,
 *     so a fenced sample that DOCUMENTS a component (a page about the component
 *     vocabulary) loses its tags. Accepted — the fence case is rarer than the
 *     cost of a second zone-aware parser.
 *  5. `flattenWikiLinks` — wiki-internal targets resolve only inside the reader.
 *  6. blank-run tidy + the `SHARE_BODY_MAX` clip.
 */
export function prepareWikiPageBody(raw: string): string {
  const stripped = stripComponentTags(stripFactWrappers(stripFactcheckBlock(stripFrontmatter(raw))));
  return finish(flattenWikiLinks(stripped));
}

/**
 * A standalone HTML explainer (`type: "explainer"`) → shareable prose, via the
 * same `htmlToText` reduction the Select-to-Explain route runs on explainers. No
 * markdown strips after it: the output is already plain text with markdown-style
 * heading markers, and it carries no frontmatter, components or wikilinks.
 */
export function prepareExplainerBody(raw: string): string {
  return finish(htmlToText(raw));
}

/**
 * A capture summary doc's leading `[collection > path > title]` breadcrumb.
 *
 * The breadcrumb OWNS ITS LINE — nothing but optional trailing spaces may follow
 * the `]` before the newline, and a newline must be there at all. Without that
 * anchor the pattern ate any document opening with a bracket: a lead-in
 * (`[TL;DR] Everything you need`) lost its first words, and a markdown link
 * (`[Read the original](https://…)`) lost its label and opened on a bare URL in
 * parentheses. All 58 live capture docs put the breadcrumb on its own line.
 */
const SUMMARY_BREADCRUMB_RE = /^\[[^\]\n]*\][ \t]*\r?\n\s*/;

/**
 * A residual `tags: …` line, ANCHORED AT THE HEAD.
 *
 * The head anchor is the whole point. The pattern the dashboard summary clients
 * use — a `^tags:` line match with the `m` flag but no `g` and no head anchor —
 * deletes the FIRST line starting with `tags:` ANYWHERE in the document, including
 * a real body line in a summary that happens to discuss tagging. Here the
 * frontmatter strip above has already taken the normal case; this only catches a
 * leftover bare line at the very top.
 */
const SUMMARY_HEAD_TAGS_RE = /^tags:[^\n]*\n*/;

/**
 * A capture summary doc (`youtube-summaries`, `x-articles`, `tiktok-summaries`,
 * `anthropic-summaries`, `article-summaries`) → shareable prose.
 *
 * Order: breadcrumb → frontmatter (huginn's tagger injects tags as YAML
 * frontmatter) → the defensive head-anchored `tags:` leftover → clip.
 */
export function prepareSummaryDocBody(raw: string): string {
  const withoutBreadcrumb = raw.replace(SUMMARY_BREADCRUMB_RE, "");
  const withoutFrontmatter = stripFrontmatter(withoutBreadcrumb);
  return finish(withoutFrontmatter.replace(SUMMARY_HEAD_TAGS_RE, ""));
}

/** What kind of source a body came from — the discriminator the share service
 *  resolves from the page's `type` (or from "this is a capture summary doc"). */
export type ShareBodyKind = "wiki" | "explainer" | "summary";

/** Dispatcher over the three preparers, so a caller holding a kind doesn't
 *  re-spell the switch. */
export function prepareShareBody(kind: ShareBodyKind, raw: string): string {
  switch (kind) {
    case "wiki":
      return prepareWikiPageBody(raw);
    case "explainer":
      return prepareExplainerBody(raw);
    case "summary":
      return prepareSummaryDocBody(raw);
  }
}
