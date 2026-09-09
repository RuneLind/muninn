/**
 * The system prompt a pasted-article capture sends, as a pure builder.
 *
 * A text vertical: no kind picker, no frames, and the USER prompt is the pasted
 * article itself, so there is nothing to build there. The extraction exists for
 * the same reason the video ones do — `/summaries/prompts` and a re-run must send
 * and show what the run sends, not a second spelling of it.
 */

import { VALID_CATEGORIES } from "../utils/summary-parser.ts";
import { joinPromptPieces, summarySystemPromptPieces, type PromptPiece } from "../summaries/prompt-pieces.ts";

export const SUMMARIZE_INTRO = "You are a content analyst. Summarize the following article.";

export interface ArticleSystemPromptInput {
  readonly title: string;
  /** Absent on a paste with no source link — the line is then omitted, not blank. */
  readonly url?: string;
  /** Absent when the paste named nobody. */
  readonly author?: string;
}

/**
 * The system prompt's pieces: the shared scaffold, then only the context lines
 * this paste actually has. A pasted article may carry no url and no author, and
 * an empty `Article URL:` line is a fact the model would try to use.
 */
export function articleSystemPromptPieces(input: ArticleSystemPromptInput): PromptPiece[] {
  const contextLines = [
    `Article title: ${input.title}`,
    ...(input.author ? [`Article author: ${input.author}`] : []),
    ...(input.url ? [`Article URL: ${input.url}`] : []),
  ];
  return [
    ...summarySystemPromptPieces(SUMMARIZE_INTRO, VALID_CATEGORIES),
    { id: "context", label: "Article context", text: `\n\n${contextLines.join("\n")}` },
  ];
}

export function buildArticleSystemPrompt(input: ArticleSystemPromptInput): string {
  return joinPromptPieces(articleSystemPromptPieces(input));
}
