// Moved out of `src/jira/retrieval.ts` (architecture review 2026-11, B2), which re-exports it.

/**
 * THE Jira key shape — one source, two consumers.
 *
 * `verify-keys.ts` scans the generated markdown with it and `retrieval.ts` reads it
 * off a doc id; they shipped as two regexes that DISAGREED (prefix ≥1 vs ≥2
 * characters, ≤∞ vs ≤7 digits), which means a key could be extracted from the
 * draft and never found in the index, or the other way round — a red row for a
 * real issue. Digits go to 8: MELOSYS is at 5 figures and a corpus that reaches
 * 7 would otherwise start failing silently.
 */
export const JIRA_KEY_SOURCE = "[A-Z][A-Z0-9]{1,15}-\\d{1,8}";
