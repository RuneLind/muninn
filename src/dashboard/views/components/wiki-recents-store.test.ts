/**
 * The one-time recents-key purge that ships with the removal of `Recently
 * opened`.
 *
 * It is the only function in `wiki-recents-store.ts` worth a unit test: the pin
 * read and write are a `JSON.parse`/`stringify` around rules that are tested in
 * `wiki-recents.test.ts`, while this one DELETES keys and therefore has to be
 * pinned on what it leaves alone — the pins key beside it and the last-wiki key
 * `wiki-home.ts` owns. It takes a storage object for exactly that reason; the
 * browser half (it runs at rail boot, once) is pinned in
 * `e2e/wiki-rail-pins.spec.ts`.
 */
import { describe, expect, test } from "bun:test";
import { purgeRecentsKeys, type RecentsPurgeStorage } from "./wiki-recents-store.ts";
import { PINS_KEY_PREFIX, RECENTS_KEY_PREFIX } from "./wiki-recents.ts";
import { LAST_WIKI_KEY } from "./wiki-home.ts";

/** A `Storage`-shaped map: `key(i)` reads the insertion order and `removeItem`
 *  re-indexes it, which is the behaviour the purge's backwards walk exists for. */
function fakeStorage(entries: Record<string, string>): RecentsPurgeStorage & {
  keys: () => string[];
} {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key(i: number): string | null {
      return [...map.keys()][i] ?? null;
    },
    removeItem(k: string): void {
      map.delete(k);
    },
    keys: () => [...map.keys()],
  };
}

describe("purgeRecentsKeys", () => {
  test("drops every recents key and nothing else", () => {
    const store = fakeStorage({
      [RECENTS_KEY_PREFIX + "mimir"]: '["a.md"]',
      [PINS_KEY_PREFIX + "mimir"]: '["b.md"]',
      [RECENTS_KEY_PREFIX + "melosys"]: '["c.md"]',
      [LAST_WIKI_KEY]: "mimir",
      [RECENTS_KEY_PREFIX]: '["d.md"]', // the default wiki's bare-suffix key
      "muninn.wiki.startTab.v1:mimir": "atlas",
    });
    purgeRecentsKeys(store);
    expect(store.keys()).toEqual([
      PINS_KEY_PREFIX + "mimir",
      LAST_WIKI_KEY,
      "muninn.wiki.startTab.v1:mimir",
    ]);
  });

  test("a run of ADJACENT recents keys is fully removed", () => {
    // The forward-walk bug: `removeItem` re-indexes, so removing index 0 slides
    // the next key into it and `i++` steps over it. Three in a row is the
    // smallest fixture where a forward walk leaves one behind.
    const store = fakeStorage({
      [RECENTS_KEY_PREFIX + "a"]: "[]",
      [RECENTS_KEY_PREFIX + "b"]: "[]",
      [RECENTS_KEY_PREFIX + "c"]: "[]",
      [PINS_KEY_PREFIX + "a"]: "[]",
    });
    purgeRecentsKeys(store);
    expect(store.keys()).toEqual([PINS_KEY_PREFIX + "a"]);
  });

  test("a store holding no recents key is left untouched", () => {
    const store = fakeStorage({ [PINS_KEY_PREFIX + "mimir"]: '["b.md"]', [LAST_WIKI_KEY]: "mimir" });
    purgeRecentsKeys(store);
    expect(store.keys()).toEqual([PINS_KEY_PREFIX + "mimir", LAST_WIKI_KEY]);
  });

  test("a throwing storage does not throw out — a boot must not die over a cleanup", () => {
    // A private window, or a browser with site data blocked: every accessor
    // throws, and the rail still has to render.
    const hostile: RecentsPurgeStorage = {
      get length(): number {
        throw new Error("SecurityError");
      },
      key(): string | null {
        throw new Error("SecurityError");
      },
      removeItem(): void {
        throw new Error("SecurityError");
      },
    };
    expect(() => purgeRecentsKeys(hostile)).not.toThrow();

    // …and the same when the THROW comes mid-walk, past the length read.
    let removed = 0;
    const midWalk: RecentsPurgeStorage = {
      length: 2,
      key: (i: number) => RECENTS_KEY_PREFIX + i,
      removeItem: () => {
        removed++;
        throw new Error("QuotaExceededError");
      },
    };
    expect(() => purgeRecentsKeys(midWalk)).not.toThrow();
    expect(removed).toBe(1);
  });
});
