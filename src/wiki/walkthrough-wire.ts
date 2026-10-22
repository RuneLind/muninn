/**
 * The wire contract of «Walk me through» (`POST /api/wiki/walkthrough`).
 *
 * Dependency-free, so the reader's panel imports it. The server half is
 * `walkthrough.ts`; the SSE runner is `dashboard/routes/walkthrough-sse.ts`.
 */

/** Cap on the heading text a request may carry (UTF-16 units). */
export const WALKTHROUGH_HEADING_MAX = 300;

/** Cap on how many headings may share one text, and so on `ordinal`/`count`. */
export const WALKTHROUGH_ORDINAL_MAX = 500;

/**
 * Heading text as both sides compare it: every whitespace run collapsed to one
 * space, trimmed. The client feeds it a heading's `textContent`; the server feeds
 * it the same heading rendered to text.
 */
export function normalizeHeadingText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** One step of the walkthrough. `quote` is verbatim section text. */
export interface WalkthroughStep {
  title: string;
  text: string;
  quote: string;
}

/** One quiz question. `answer` is the 0-based index into `choices`. */
export interface WalkthroughQuestion {
  question: string;
  choices: string[];
  answer: number;
  quote: string;
}

/** Why an item from the model was not shown. */
export type WalkthroughDropReason = "quote_not_in_section" | "quote_too_short" | "malformed";

export interface WalkthroughDrop {
  kind: "step" | "question";
  reason: WalkthroughDropReason;
}

/** The `done` event: what survived the quote check, plus what did not. */
export interface WalkthroughDonePayload {
  heading: string;
  steps: WalkthroughStep[];
  quiz: WalkthroughQuestion[];
  dropped: WalkthroughDrop[];
}

/** `app_error.code` for the case where the model answered but every step was
 *  dropped, so the panel can say so rather than report a transport failure. */
export const WALKTHROUGH_ALL_DROPPED = "all_dropped";
/** `app_error.code` for a reply that was not the JSON shape. */
export const WALKTHROUGH_PARSE_FAILED = "parse_failed";
/** A 422's `code` when the page is unchanged (its hash matches) but the
 *  server finds no section for the reader's heading identity. */
export const WALKTHROUGH_HEADING_MISMATCH = "heading_mismatch";

/** The POST body. `ordinal` is 0-based among the eligible headings whose
 *  normalized text equals `heading`; `count` is how many there are. */
export interface WalkthroughRequest {
  wiki?: string;
  relPath: string;
  heading: string;
  ordinal: number;
  count: number;
  /** The page hash the reader rendered (`/api/wiki/page`'s `hash`). */
  hash?: string;
}
