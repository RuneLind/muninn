/**
 * `.wiki-reader.json` `statePhrases` (living-facts PR 1, D10): the words a
 * wiki writes a PR's, a release's or a Jira issue's state with, and the task
 * words that tie a line to a piece of work. The state lint (`lint-state.ts`)
 * reads it; a wiki with no block runs neither state check. Dependency-free, so
 * `store.ts` can parse it without importing the lint.
 *
 * ```json
 * "statePhrases": { "phrases": ["merget", "ikke i prod"], "taskWords": ["oppgave", "PR"] }
 * ```
 */

export interface StatePhrasesConfig {
  /** Phrases that state a fact's state, matched case-insensitively on word edges. */
  phrases: string[];
  /** Words that anchor a line to a piece of work, matched the same way. */
  taskWords: string[];
}

/** A list of non-blank strings, trimmed and deduplicated case-insensitively.
 *  A bad entry is dropped with a warning. */
function parseWordList(value: unknown, key: string, warnings: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  (value as unknown[]).forEach((v, i) => {
    const w = typeof v === "string" ? v.trim() : "";
    if (!w) {
      warnings.push(`${key} entry ${i + 1} dropped: not a non-empty string`);
      return;
    }
    const folded = w.toLowerCase();
    if (seen.has(folded)) return;
    seen.add(folded);
    out.push(w);
  });
  return out;
}

/**
 * Parse the block. Absent ⇒ `null` with no warning. Not an object, `phrases`
 * not an array, or no usable phrase ⇒ `null` with a warning, so a malformed
 * block turns the checks off rather than running them on half a list (the
 * `roleKeys` fail direction, one level up). A bad `taskWords` drops only that
 * list.
 */
export function parseStatePhrases(value: unknown): { config: StatePhrasesConfig | null; warnings: string[] } {
  if (value === undefined) return { config: null, warnings: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { config: null, warnings: ["is not an object with phrases and taskWords — ignoring it"] };
  }
  const obj = value as Record<string, unknown>;
  const warnings: string[] = [];
  if (!Array.isArray(obj.phrases)) {
    return { config: null, warnings: ["phrases is not an array of strings — ignoring the block"] };
  }
  const phrases = parseWordList(obj.phrases, "phrases", warnings);
  if (phrases.length === 0) {
    warnings.push("phrases holds no usable phrase — ignoring the block");
    return { config: null, warnings };
  }
  let taskWords: string[] = [];
  if (obj.taskWords !== undefined) {
    if (Array.isArray(obj.taskWords)) taskWords = parseWordList(obj.taskWords, "taskWords", warnings);
    else warnings.push("taskWords is not an array of strings — ignoring it");
  }
  for (const key of Object.keys(obj)) {
    if (key !== "phrases" && key !== "taskWords") warnings.push(`unknown key "${key}" ignored`);
  }
  return { config: { phrases, taskWords }, warnings };
}
