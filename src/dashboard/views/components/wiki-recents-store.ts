/// <reference lib="dom" />
/**
 * The localStorage half of the /wiki rail's pins. The pin rules live in
 * `wiki-recents.ts`; this file reads, writes and swallows — and owns the one
 * rule of its own, the recents purge below.
 *
 * Storage is best-effort, the same settlement `wiki-rail-resize.ts` and the
 * Ask-session persistence make: in a private window or a browser with site data
 * blocked, every accessor throws, and the rail then works for the session and
 * forgets on reload rather than taking the page down. That is why each function
 * returns the list it decided on even when the write failed — the caller renders
 * from the return value, not from a re-read.
 *
 * The key is per WIKI — the caller passes the canonical name (`""` for the
 * default one; `wiki-browser.ts` resolves it once at boot through
 * `readActiveWikiName`), so a browser that reads two wikis keeps two lists.
 */
import {
  PINS_MAX,
  RECENTS_KEY_PREFIX,
  parseRelPathList,
  pinsKey,
  serializeRelPathList,
  togglePin,
} from "./wiki-recents.ts";

/** The slice of `Storage` the purge below needs, so a unit test can hand it a
 *  fake instead of a browser. */
export interface RecentsPurgeStorage {
  readonly length: number;
  key(index: number): string | null;
  removeItem(key: string): void;
}

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

export function readPins(wiki: string): string[] {
  return read(pinsKey(wiki), PINS_MAX);
}

/** Flip one page's pin and return the new list. */
export function togglePinned(wiki: string, relPath: string): string[] {
  const next = togglePin(readPins(wiki), relPath);
  write(pinsKey(wiki), next);
  return next;
}

/**
 * Drop every `muninn.wiki.recents.v1:*` key left behind by the removed
 * `Recently opened` section. Runs on every rail boot, for good: it is a walk
 * over the origin's keys and idempotent, so no "have I run this?" flag is
 * needed — which is the point, since such a flag would itself be a key nothing
 * ever removes.
 *
 * **The prefix is the whole contract.** `muninn.wiki.pins.v1:*` is the feature
 * that replaces the section and `muninn.wiki.last.v1` is what makes a bare
 * `/wiki` open the wiki last read, so a looser match — `muninn.wiki.` — would
 * silently destroy both.
 *
 * Iterating BACKWARDS matters: `removeItem` re-indexes the store, so a forward
 * walk skips the key that slides into the index just removed.
 *
 * Wrapped like every other accessor here: in a private window, or a browser with
 * site data blocked, `localStorage` itself throws, and a boot must not take the
 * rail down over a cleanup.
 */
export function purgeRecentsKeys(store?: RecentsPurgeStorage): void {
  try {
    const s = store ?? localStorage;
    for (let i = s.length - 1; i >= 0; i--) {
      const key = s.key(i);
      if (key && key.startsWith(RECENTS_KEY_PREFIX)) s.removeItem(key);
    }
  } catch {
    /* best-effort */
  }
}
