/**
 * The system prompt an `anthropic` capture sends, as a pure builder.
 *
 * One vertical, two framings and one optional rider, all of which the builder
 * takes as arguments rather than deciding: the shelf covers both the Anthropic
 * firehose (a docs page, blog post, changelog or commit) and captured X posts,
 * and a summary written under the wrong framing describes the wrong thing.
 *
 * The categories are `AI_CATEGORIES`, not the full set: the
 * `anthropic-summaries` collection only accepts those (huginn's allowlist), and
 * a stray valid-but-non-ai category is rejected at ingest.
 */

import { AI_CATEGORIES } from "../utils/summary-parser.ts";
import {
  joinPromptPieces,
  optionalPiece,
  summarySystemPromptPieces,
  type PromptPiece,
} from "../summaries/prompt-pieces.ts";

export const ANTHROPIC_SUMMARIZE_INTRO =
  "You are an analyst summarizing a new Anthropic / Claude ecosystem release (a docs page, blog post, changelog, or commit) for a personal learning shelf. Lead the Key takeaways with what changed and why it matters.";

/**
 * X variant of the summarize intro — for a captured long-form X post/article
 * (borrows the framing of `src/x-article/summarizer.ts`). Same CATEGORY:/SUMMARY:
 * contract + AI_CATEGORIES clamp as the anthropic prompt, so the parser is
 * unchanged; only the framing (a personal note, not an Anthropic release) differs.
 */
export const X_SUMMARIZE_INTRO =
  "You are an analyst summarizing a long-form X (Twitter) post or article for a personal learning shelf. The content below is one author's note/thread — distill its argument and takeaways for a senior AI engineer. Lead the Key takeaways with the author's main point and why it matters.";

/** Which framing this capture is written under. */
export type AnthropicFraming = "anthropic" | "x-post";

/**
 * Kind-scoped framing appended to the system prompt when the tweet's linked
 * content was folded in. `x-link` treats the destination as the PRIMARY subject;
 * every other kind (`x-post`, the pre-PR-3 long-form population) treats it as
 * SUPPORTING CONTEXT only, keeping the post the subject.
 */
export function enrichmentFraming(kind: string | null | undefined, destinationOnly = false): string {
  if (destinationOnly) {
    return "The content below is the destination artifact itself, fetched directly — the pointer post that surfaced it could not be resolved and is NOT included. Summarize the destination on its own terms; do not refer to a post.";
  }
  if (kind === "x-link") {
    return "The content below includes a `--- LINKED CONTENT ---` section fetched from the link this tweet points to. Treat that linked content as the PRIMARY subject — summarize what the destination says; the tweet itself is just the pointer and context.";
  }
  return "The content below includes a `--- LINKED CONTENT ---` section fetched from a link in the post. Treat it as SUPPORTING CONTEXT only — the author's own post stays the subject of the summary.";
}

export interface AnthropicSystemPromptInput {
  readonly framing: AnthropicFraming;
  readonly title: string;
  readonly url: string;
  /**
   * The enrichment rider, when linked content was folded into the body. Absent
   * ⇒ no rider at all, which is every capture that followed no link.
   */
  readonly enrichment?: {
    readonly kind: string | null | undefined;
    /** Absent reads as `false`, the way {@link enrichmentFraming}'s default did. */
    readonly destinationOnly?: boolean | undefined;
  };
}

export function anthropicSystemPromptPieces(input: AnthropicSystemPromptInput): PromptPiece[] {
  const intro = input.framing === "x-post" ? X_SUMMARIZE_INTRO : ANTHROPIC_SUMMARIZE_INTRO;
  return [
    ...summarySystemPromptPieces(intro, AI_CATEGORIES),
    { id: "context", label: "Source context", text: `\n\nTitle: ${input.title}\nURL: ${input.url}` },
    ...optionalPiece(input.enrichment !== undefined, {
      id: "rider-enrichment",
      label: "Linked-content rider",
      text: `\n\n${enrichmentFraming(input.enrichment?.kind, input.enrichment?.destinationOnly ?? false)}`,
    }),
  ];
}

export function buildAnthropicSystemPrompt(input: AnthropicSystemPromptInput): string {
  return joinPromptPieces(anthropicSystemPromptPieces(input));
}
