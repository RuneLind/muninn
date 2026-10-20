/**
 * The path an `aliases:` entry spells, with any wikilink wrapping removed.
 *
 * IO-free, so the server (`aliasWorkedPaths` in `store.ts`) and the browser's
 * boundary resolver (`wiki-work-boundaries.ts`) read one alias the same way
 * (arch review 2026-10, finding 85).
 */

/** `[[plans/old|Label]]`, `[[plans/old#x]]`, ` ./plans\old ` → `plans/old`.
 *  Brackets, a `|label` and a `#anchor` are dropped, backslashes become `/`,
 *  and a leading `./` goes. Empty when nothing is left. */
export function unwrapAliasRef(alias: string): string {
  const v = alias.trim().replace(/^\[+/, "").replace(/\]+$/, "").trim();
  return v.split("|")[0]!.split("#")[0]!.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}
