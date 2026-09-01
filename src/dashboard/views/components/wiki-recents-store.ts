/// <reference lib="dom" />
/**
 * The localStorage half of the /wiki rail's recents and pins. Every rule lives in
 * `wiki-recents.ts`; this file only reads, writes and swallows.
 *
 * Storage is best-effort, the same settlement `wiki-rail-resize.ts` and the
 * Ask-session persistence make: in a private window or a browser with site data
 * blocked, every accessor throws, and the rail then works for the session and
 * forgets on reload rather than taking the page down. That is why each function
 * returns the list it decided on even when the write failed — the caller renders
 * from the return value, not from a re-read.
 *
 * Both keys are per WIKI (`readActiveWikiName()`, `""` for the default one), so
 * a browser that reads two wikis keeps two lists.
 */
import {
  PINS_MAX,
  RECENTS_MAX,
  parseRelPathList,
  pinsKey,
  pushRecent,
  recentsKey,
  serializeRelPathList,
  togglePin,
} from "./wiki-recents.ts";

function read(key: string, max: number): string[] {
  try {
    return parseRelPathList(localStorage.getItem(key), max);
  } catch {
    return [];
  }
}

function write(key: string, list: string[]): void {
  try {
    if (list.length) localStorage.setItem(key, serializeRelPathList(list));
    else localStorage.removeItem(key);
  } catch {
    /* best-effort */
  }
}

export function readRecents(wiki: string): string[] {
  return read(recentsKey(wiki), RECENTS_MAX);
}

export function readPins(wiki: string): string[] {
  return read(pinsKey(wiki), PINS_MAX);
}

/** Record a page as opened and return the new list. */
export function recordRecent(wiki: string, relPath: string): string[] {
  const next = pushRecent(readRecents(wiki), relPath);
  write(recentsKey(wiki), next);
  return next;
}

/** Flip one page's pin and return the new list. */
export function togglePinned(wiki: string, relPath: string): string[] {
  const next = togglePin(readPins(wiki), relPath);
  write(pinsKey(wiki), next);
  return next;
}

/** The "clear" affordance on the Recently opened header. */
export function clearRecents(wiki: string): string[] {
  write(recentsKey(wiki), []);
  return [];
}
