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
import {
  purgeRecentsKeys,
  readFolds,
  toggleFolded,
  type RecentsPurgeStorage,
} from "./wiki-recents-store.ts";
import {
  FOLDS_MAX,
  PINS_KEY_PREFIX,
  RECENTS_KEY_PREFIX,
  SECTION_META_FOLD_KEY,
  foldsKey,
  isFoldOpen,
} from "./wiki-recents.ts";
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

/**
 * The FOLD half of this module — the groups a reader has opened, per wiki.
 *
 * Worth its own cases for the reason the purge is: the rules live next door in
 * `wiki-recents.ts`, but the DEGRADE is here, and the whole feature is built
 * around "not stored means closed" — so a store that throws, or holds something
 * that is not a list, has to read as a rail with every group closed rather than
 * as an exception on boot.
 */
describe("the fold store", () => {
  /** A Storage-shaped fake installed as the global the module reads. `throws`
   *  is the private-window / blocked-site-data case, where EVERY accessor
   *  throws — not just `setItem`. */
  function withStorage<T>(
    initial: Record<string, string>,
    fn: (map: Map<string, string>) => T,
    opts: { throws?: boolean } = {},
  ): T {
    const map = new Map(Object.entries(initial));
    const original = (globalThis as { localStorage?: unknown }).localStorage;
    const fake = {
      getItem: (k: string) => {
        if (opts.throws) throw new Error("SecurityError");
        return map.get(k) ?? null;
      },
      setItem: (k: string, v: string) => {
        if (opts.throws) throw new Error("SecurityError");
        map.set(k, v);
      },
      removeItem: (k: string) => {
        if (opts.throws) throw new Error("SecurityError");
        map.delete(k);
      },
    };
    Object.defineProperty(globalThis, "localStorage", { value: fake, configurable: true });
    try {
      return fn(map);
    } finally {
      Object.defineProperty(globalThis, "localStorage", { value: original, configurable: true });
    }
  }

  test("round-trips per wiki, and an untouched wiki holds nothing", () => {
    withStorage({}, (map) => {
      expect(readFolds("mimir")).toEqual([]);
      expect(toggleFolded("mimir", "plans/x.mdx")).toEqual(["plans/x.mdx"]);
      expect(readFolds("mimir")).toEqual(["plans/x.mdx"]);
      // …and the OTHER wiki is untouched: one key per wiki, like the pins.
      expect(readFolds("melosys")).toEqual([]);
      expect(map.has(foldsKey("mimir"))).toBe(true);
      expect(map.has(foldsKey("melosys"))).toBe(false);
    });
  });

  test("closing again REMOVES the key rather than storing an empty list", () => {
    withStorage({}, (map) => {
      toggleFolded("mimir", "plans/x.mdx");
      expect(toggleFolded("mimir", "plans/x.mdx")).toEqual([]);
      expect(readFolds("mimir")).toEqual([]);
      expect(map.has(foldsKey("mimir"))).toBe(false);
    });
  });

  test("the section sentinel travels the same namespace as a page key", () => {
    withStorage({}, () => {
      expect(toggleFolded("mimir", SECTION_META_FOLD_KEY)).toEqual([SECTION_META_FOLD_KEY]);
      expect(readFolds("mimir")).toEqual([SECTION_META_FOLD_KEY]);
      // Normalization must not damage it — it is why the sentinel is lowercase
      // and separator-free in the first place.
      expect(isFoldOpen(readFolds("mimir"), SECTION_META_FOLD_KEY)).toBe(true);
    });
  });

  test("the cap is enforced on READ, so a hand-edited key cannot grow unbounded", () => {
    const many = Array.from({ length: FOLDS_MAX + 25 }, (_, i) => `plans/p${i}.mdx`);
    withStorage({ [foldsKey("mimir")]: JSON.stringify(many) }, () => {
      expect(readFolds("mimir")).toHaveLength(FOLDS_MAX);
      expect(readFolds("mimir")[0]).toBe("plans/p0.mdx");
    });
  });

  test("the cap is enforced on WRITE too — measured on the STORED string", () => {
    withStorage({}, (map) => {
      for (let i = 0; i < FOLDS_MAX + 5; i++) toggleFolded("mimir", `plans/p${i}.mdx`);
      // Read back through `readFolds` this would pass with no write cap at all —
      // the read cap truncates either way. What the write cap owns is the size of
      // the string in storage, so that is what this measures.
      const stored = JSON.parse(map.get(foldsKey("mimir"))!) as string[];
      expect(stored).toHaveLength(FOLDS_MAX);
      expect(stored[0]).toBe(`plans/p${FOLDS_MAX + 4}.mdx`); // newest first
      expect(readFolds("mimir")).toHaveLength(FOLDS_MAX);
    });
  });

  test("anything that is not a list of strings reads as EVERYTHING CLOSED", () => {
    for (const stored of ["{not json", '{"a":1}', '"a string"', "null", '[1,2]', ""]) {
      withStorage({ [foldsKey("mimir")]: stored }, () => {
        expect(readFolds("mimir"), stored).toEqual([]);
      });
    }
  });

  test("a storage that throws degrades to closed, and the toggle still answers", () => {
    withStorage({}, () => {
      expect(readFolds("mimir")).toEqual([]);
      // The caller renders from the RETURN value, so a failed write still opens
      // the group for this session instead of doing nothing visible.
      expect(toggleFolded("mimir", "plans/x.mdx")).toEqual(["plans/x.mdx"]);
    }, { throws: true });
  });
});
