/**
 * The one text a page's decision chain is read from, shared by the reader's
 * views (`renderWikiHtml`), `GET /api/wiki/decision-chain`, lint check 16 and
 * the dry run, so the four cannot disagree on what a page says.
 *
 * The text is the page markdown with the frontmatter and the live fact-check
 * marker lines dropped and every `[[target|label]]` replaced by its label,
 * else its target. It is not the reader's text: the H1 stays (the reader may
 * strip it), and a wikilink inside a code span or fence is replaced too.
 */

import { pageDecisionData, type PageDecisionData } from "../format/decision-views.ts";
import { parseBlocks } from "../format/markdown-ast.ts";
import { findLiveSentinelBlocks } from "./factcheck-context.ts";
import { WIKILINK_WITH_LABEL_RE } from "./page-text.ts";
import { stripFrontmatter } from "./store.ts";

export { WIKILINK_WITH_LABEL_RE };

/** The text a wikilink shows: its label, else its target. */
export function wikiLinkText(target: string, label: string | undefined): string {
  return (label ?? target).trim() || target.trim();
}

/**
 * Drop the two marker LINES of every live fact-check block, leaving the block
 * between them (real content) to render. The blocks come from the writers' own
 * walker (`findLiveSentinelBlocks`), so what the reader hides is by construction
 * what the splice replaces and the strip removes: a marker mid-sentence, inside a
 * fence, indented as code, blockquoted, in the frontmatter or unpaired is content
 * and renders as written. Runs on the whole page, frontmatter included, because
 * the walker skips the frontmatter itself.
 */
export function stripSentinelLines(markdown: string): string {
  const owned = new Set<number>();
  for (const span of findLiveSentinelBlocks(markdown)) {
    owned.add(span.startLine);
    owned.add(span.endLine);
  }
  if (owned.size === 0) return markdown;
  return markdown
    .split("\n")
    .filter((_, i) => !owned.has(i))
    .join("\n");
}

/** Every wikilink in `text` replaced by the text it shows. */
export function wikiLinksAsText(text: string): string {
  return text.replace(WIKILINK_WITH_LABEL_RE, (_m, target: string, label?: string) => wikiLinkText(target, label));
}

/** The page body the decision analysis reads (see the module comment). */
export function decisionText(markdown: string): string {
  return wikiLinksAsText(stripFrontmatter(stripSentinelLines(markdown)));
}

/** The page's ledgers and chains, read from {@link decisionText}. `proposed`
 *  is the index's `plan_status === "proposed"`. */
export function pageDecisionDataOf(markdown: string, proposed: boolean): PageDecisionData {
  return pageDecisionData(parseBlocks(decisionText(markdown)), { proposed });
}
