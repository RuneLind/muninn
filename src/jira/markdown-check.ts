/**
 * The markdown-subset post-pass — deterministic, and "flag, don't silently drop",
 * the same shape as `verify-keys.ts`.
 *
 * The new Jira editor converts markdown ON PASTE but will not give raw markdown
 * back, so the paste is a one-way door: whatever renders wrong is what the task
 * says, and the source exists nowhere else. PR 0 pasted 25 constructs into a live
 * MELOSYS create screen and measured which ones survive; four do not, and this
 * pass flags them so PR 2 can show the reader before they paste, rather than
 * leaving the door defended only by prompt wording.
 *
 * **What is flagged** (all measured non-converting, 2026-08-22):
 *   · raw HTML tags — escape to visible literal text
 *   · Jira wiki markup (`h2.`, `{code}`, `{panel}`) — stays literal, and is being
 *     phased out upstream anyway
 *   · `- [ ]` / `- [x]` task lists — render as a plain bullet followed by a
 *     literal `[ ]`. Jira's task list is a native ADF node that converts when
 *     TYPED, not when pasted, and this feature is paste-shaped.
 *   · `:warning:`-style emoji shortcodes — stay literal
 *
 * **What is deliberately NOT flagged: nesting depth.** PR 0 falsified the
 * documented assumption that nesting stops at two levels — three levels render
 * with distinct glyphs. Had this shipped on the assumption it would have carried
 * a linter rule against working syntax.
 *
 * Fenced code is excluded from every check (a `<div>` inside a ```html block is
 * the point of the block), via the shared `maskFencedCode`.
 */

import type { JiraMarkdownFlag, JiraMarkdownFlagKind } from "./wire.ts";
import { maskFencedCode, maskInlineCode, lineOfOffset } from "./markdown-scan.ts";

/** Max chars of the offending fragment carried on a flag. */
const SAMPLE_MAX = 80;

/**
 * A raw HTML tag, matched against a KNOWN TAG NAME.
 *
 * Any-`<name>` was tried and is wrong: a task describing a generic type
 * (`List<String>`, `Flow<Sak>`) is ordinary prose about Kotlin, and flagging it
 * is the denylist-noise failure `verify-keys` guards against from the other side
 * — a reader who learns to ignore the flags is a reader the pass no longer
 * protects. So the name must be one this list knows.
 *
 * The list is the block/inline set a model actually reaches for when it ignores
 * "markdown only", plus the two component-vocabulary tags a copied-in prompt
 * could reintroduce (`Callout`/`Verdict` — the very tags reusing
 * `SYNTHESIS_RULES_BODY` would have taught it to emit). Bounded by design: an
 * exotic tag that escapes this list renders as visible garbage the reader sees
 * in the preview anyway, which is a strictly better failure than a flag column
 * nobody reads.
 */
const HTML_TAGS = [
  "a", "abbr", "b", "blockquote", "br", "code", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "i", "img", "li", "ol", "p", "pre", "s", "small", "span", "strong", "sub", "sup",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
  "details", "summary", "font", "center",
  "Callout", "Verdict", "Pill", "Figure", "FileRef", "ComparisonTable",
];
// Case-INSENSITIVE: HTML tag names are, and `<DIV>` escapes to visible literal
// text in exactly the same way `<div>` does. (The component names are matched
// case-insensitively too — a `<callout>` is the same mistake in lower case.)
const HTML_RE = new RegExp(`</?(?:${HTML_TAGS.join("|")})(?:\\s[^<>]*)?/?>`, "gi");

/** Jira wiki markup. `h1.`–`h6.` must be line-anchored — "no. 2" is not a heading. */
const WIKI_BLOCK_RE = /\{(?:code|panel|quote|noformat|color|anchor|section|column)(?::[^}]*)?\}/gi;
const WIKI_HEADING_RE = /^ {0,3}h[1-6]\.\s/gm;

/**
 * `- [ ]` / `* [x]` at the start of a list item, any indent.
 *
 * The trailing lookahead is load-bearing: `- [x](https://…)` is an ordinary
 * markdown LINK whose text happens to be `x`, and Jira converts it perfectly.
 * Without the lookahead every bulleted link list flagged as a task list.
 */
const TASK_LIST_RE = /^[ \t]*[-*+][ \t]+\[[ xX]\](?=[ \t]|$)/gm;

/**
 * `:name:` emoji shortcodes.
 *
 * Requires letters/digits/underscore/dash between the colons AND a non-word char
 * (or string edge) on both outer sides, so a ratio (`3:2:1`), a time range
 * (`09:00:00`) and a Kotlin fully-qualified name do not match.
 */
const EMOJI_RE = /(^|[^\w:])(:[a-z0-9][a-z0-9_+-]{1,30}:)(?![\w:])/gim;

/**
 * Record one flag, at most ONE per line per kind.
 *
 * A paragraph carrying `<div><span>x</span></div>` is one thing to fix, and four
 * rows saying so is a flag column the reader stops reading — the same failure the
 * HTML tag list and the key denylist are both bounded against. The FIRST sample
 * on the line is kept, since that is where the reader's eye goes.
 */
function push(
  flags: JiraMarkdownFlag[],
  seen: Set<string>,
  kind: JiraMarkdownFlagKind,
  masked: string,
  offset: number,
  sample: string,
): void {
  const line = lineOfOffset(masked, offset);
  const slot = `${kind}:${line}`;
  if (seen.has(slot)) return;
  seen.add(slot);
  flags.push({
    kind,
    line,
    sample: sample.length > SAMPLE_MAX ? `${sample.slice(0, SAMPLE_MAX - 1)}…` : sample,
  });
}

/**
 * Scan the generated markdown for constructs the Jira paste does not convert.
 *
 * Fenced code AND inline code spans are masked first — a `<div>` inside a
 * ```html block is the point of the block, and a `` `h2.` `` in prose is the
 * reader naming the construct rather than emitting it.
 *
 * Flags are returned in LINE order (one per line per kind); the order within a
 * line is not a contract, the presence of a flag is.
 */
export function checkJiraMarkdown(markdown: string): JiraMarkdownFlag[] {
  const masked = maskInlineCode(maskFencedCode(markdown));
  const flags: JiraMarkdownFlag[] = [];
  const seen = new Set<string>();

  for (const m of masked.matchAll(HTML_RE)) push(flags, seen, "html", masked, m.index, m[0]);
  for (const m of masked.matchAll(WIKI_BLOCK_RE)) push(flags, seen, "wiki-markup", masked, m.index, m[0]);
  for (const m of masked.matchAll(WIKI_HEADING_RE)) push(flags, seen, "wiki-markup", masked, m.index, m[0].trim());
  for (const m of masked.matchAll(TASK_LIST_RE)) push(flags, seen, "task-list", masked, m.index, m[0].trim());
  for (const m of masked.matchAll(EMOJI_RE)) {
    push(flags, seen, "emoji-shortcode", masked, m.index + (m[1]?.length ?? 0), m[2]!);
  }

  return flags.sort((a, b) => a.line - b.line);
}
