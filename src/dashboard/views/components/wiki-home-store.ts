/// <reference lib="dom" />
/**
 * The localStorage half of `wiki-home.ts` — the same pure/DOM split as
 * `wiki-rail-width.ts` + `wiki-rail-resize.ts`. Every read answers `null` and
 * every write is best-effort when storage is unavailable (private mode, a
 * quota, a sandboxed frame): the reader still works, it just forgets.
 */
import { LAST_WIKI_KEY, startTabKey, type StartTab } from "./wiki-home.ts";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* best-effort */
  }
}

export const readLastWiki = (): string | null => read(LAST_WIKI_KEY);
export const writeLastWiki = (wiki: string): void => write(LAST_WIKI_KEY, wiki);
export const readStartTab = (wiki: string): string | null => read(startTabKey(wiki));
export const writeStartTab = (wiki: string, tab: StartTab): void => write(startTabKey(wiki), tab);
