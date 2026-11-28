/**
 * The bounds Discuss's handoff shares between the reader's client, the route
 * and the pack (mimir plan muninn-wiki-discuss, P1), so the three agree.
 * Dependency-free: the reader bundle imports it.
 */

/** The longest selection «Ask Claude Code» takes, in characters. The client
 *  offers the control up to it, the route refuses past it, and the pack
 *  locates all of it (the prompt may cut the quote, with a mark). */
export const HANDOFF_SELECTION_MAX = 20_000;
/** The shortest selection the client offers the control for (trimmed). */
export const HANDOFF_SELECTION_MIN = 3;
/** The question's bound, in characters (the textarea's `maxlength`). */
export const HANDOFF_QUESTION_MAX = 2000;
/** How many key characters of context the client reads on each side of a
 *  selection. The locator's agreement rule reads the nearest
 *  `CONTEXT_NEAR_CHARS` (`discuss-locate.ts`); the rest only breaks a tie
 *  between copies whose near context is the same. */
export const DISCUSS_CONTEXT_KEY_CHARS = 160;
/** The raw length the route takes for each context string. */
export const HANDOFF_CONTEXT_MAX = 1000;
/** The heading hint's bound. */
export const HANDOFF_HEADING_MAX = 200;
/** The whole request body's bound, in bytes: the selection at four UTF-8
 *  bytes a character, with room for the rest. */
export const HANDOFF_BODY_MAX = 128 * 1024;
/** `POST /api/wiki/discuss`'s body bound (Discuss v3 P2): the handoff's
 *  fields plus a card's held passage, whose own text can be a second copy of
 *  the selection and whose two sides are each `HANDOFF_CONTEXT_MAX`. It
 *  assumes text at no more than four UTF-8 bytes a character: two selections
 *  are then 160,000 bytes, with the rest under the other 100 KB. JSON writes a
 *  control character as `\uXXXX` (six bytes), so a selection made mostly of
 *  control characters can pass `HANDOFF_SELECTION_MAX` and still be refused
 *  here (413); real page text does not. */
export const DISCUSS_BODY_MAX = 256 * 1024;

/** The one line a thread's stored assistant message carries in place of the
 *  proposed edit's JSON block: the edit itself is the ledger row's. Here, not
 *  in `discuss-agent.ts`, so the reader bundle can match it exactly
 *  («Earlier discussions» replaces it: a closed thread has no Apply). */
export const STORED_EDIT_MARKER = "_(Proposed edit: preview and apply it in the page's Discuss tab.)_";
/** What an answer shows in place of its proposed edit where nothing can apply
 *  it: «Earlier discussions» (a closed thread's {@link STORED_EDIT_MARKER}, an
 *  old one-shot turn's edit block) and /chat on a closed wiki thread. */
export const EARLIER_EDIT_NOTE = "_(This answer proposed an edit; an earlier discussion cannot apply it.)_";

/** The question an «Explain with context» turn asks; the passage and its
 *  place on the page go with it as the turn's selection fields. Here, not in
 *  the selection menu's module, so /chat can tell an Explain turn by its
 *  ledger row's question and draw it as a chip (Discuss v3 P4). */
export const EXPLAIN_QUESTION = "Explain this passage with context: what it means, why it is here, and what led to it.";
