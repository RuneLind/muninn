/**
 * The system prompt an X-ARTICLE (text) capture sends, as a pure builder.
 *
 * Not the X-VIDEO one — that is `./video-prompt.ts`, a hand-rolled frame-reading
 * envelope. This vertical is the pasted long-form post: the shared scaffold, the
 * three context lines, and the article text as the user prompt.
 */

import { VALID_CATEGORIES } from "../utils/summary-parser.ts";
import { joinPromptPieces, summarySystemPromptPieces, type PromptPiece } from "../summaries/prompt-pieces.ts";

export const SUMMARIZE_INTRO =
  "You are a content analyst. Summarize the following X/Twitter article.";

export interface XArticleSystemPromptInput {
  readonly title: string;
  /** The handle WITHOUT its `@` — the prompt adds one. */
  readonly author: string;
  readonly url: string;
}

export function xArticleSystemPromptPieces(input: XArticleSystemPromptInput): PromptPiece[] {
  return [
    ...summarySystemPromptPieces(SUMMARIZE_INTRO, VALID_CATEGORIES),
    {
      id: "context",
      label: "Article context",
      text: `\n\nArticle title: ${input.title}\nArticle author: @${input.author}\nArticle URL: ${input.url}`,
    },
  ];
}

export function buildXArticleSystemPrompt(input: XArticleSystemPromptInput): string {
  return joinPromptPieces(xArticleSystemPromptPieces(input));
}
