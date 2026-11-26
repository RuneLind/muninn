/**
 * The mentions route's key check, on its own so the reader's client bundle can
 * run the same check before it asks (Discuss v2 PR 5: «Where else» and
 * «History» on a selection). `mentions.ts` re-exports it; this module imports
 * nothing, so it is safe in the browser bundle.
 */

export const MENTION_KEY_MIN = 3;
export const MENTION_KEY_MAX = 80;

/** The key as searched, or why it is refused: 3–80 characters, no line break, NUL or other control character. Surrounding blanks are trimmed. */
export function parseMentionKey(raw: string | undefined): { key: string } | { error: string } {
  const key = (raw ?? "").trim();
  if (key.length < MENTION_KEY_MIN || key.length > MENTION_KEY_MAX) return { error: `key must be ${MENTION_KEY_MIN}–${MENTION_KEY_MAX} characters` };
  if (/[\u0000-\u001f\u007f]/.test(key)) return { error: "key may not hold a line break or control character" };
  return { key };
}
