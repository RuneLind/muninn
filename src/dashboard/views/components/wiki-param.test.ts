import { afterEach, test, expect, describe } from "bun:test";
import { readActiveWikiRoot, readFindRowsWiki, readFindSelfWiki, withWikiParam } from "./wiki-param.ts";

/**
 * `readActiveWikiRoot` degrades to `null` for every shape that is not a usable
 * root, because the alternative is a copy button that hands over a path naming
 * no file: `undefined/plans/x.mdx` reads like a path and opens nothing.
 */
describe("readActiveWikiRoot", () => {
  const g = globalThis as unknown as { __WIKI_ROOT__?: unknown };
  afterEach(() => {
    delete g.__WIKI_ROOT__;
  });

  test("returns the injected root", () => {
    g.__WIKI_ROOT__ = "/Users/rune/source/private/mimir";
    expect(readActiveWikiRoot()).toBe("/Users/rune/source/private/mimir");
  });

  test("is null when the page injected nothing (a non-reader page)", () => {
    expect(readActiveWikiRoot()).toBeNull();
  });

  test("is null for a non-string or blank global", () => {
    // `null` is what the server writes for an unknown wiki — JSON, not a string.
    for (const v of [null, undefined, 0, {}, "", "   "]) {
      g.__WIKI_ROOT__ = v;
      expect(readActiveWikiRoot()).toBeNull();
    }
  });
});

describe("withWikiParam", () => {
  test("leaves a URL alone when no wiki is active", () => {
    expect(withWikiParam("/api/wiki/pages", "")).toBe("/api/wiki/pages");
  });

  test("appends with the right separator and escapes the name", () => {
    expect(withWikiParam("/api/wiki/pages", "e2e wiki")).toBe("/api/wiki/pages?wiki=e2e%20wiki");
    expect(withWikiParam("/api/wiki/page?relPath=a", "mimir")).toBe(
      "/api/wiki/page?relPath=a&wiki=mimir",
    );
  });
});

// arch-review 2026-10 #60: two names on aliased roots. The requested name keys
// answers, new-since baselines and the Agent lens; the rows name only dedupes
// and opens Everywhere rows in place.
describe("readFindRowsWiki / readFindSelfWiki", () => {
  const g = globalThis as unknown as { __WIKI_FIND_SELF__?: unknown; __WIKI_FIND_ROWS__?: unknown };
  afterEach(() => {
    delete g.__WIKI_FIND_SELF__;
    delete g.__WIKI_FIND_ROWS__;
  });

  test("each reads its own global", () => {
    g.__WIKI_FIND_SELF__ = "b";
    g.__WIKI_FIND_ROWS__ = "a";
    expect(readFindSelfWiki()).toBe("b");
    expect(readFindRowsWiki()).toBe("a");
  });

  test("the rows name falls back to the self name on a page that injects none", () => {
    g.__WIKI_FIND_SELF__ = "b";
    expect(readFindRowsWiki()).toBe("b");
  });

  test("the reader wires the rows name to the palette only, the self name to every consumer that sends `wiki`", async () => {
    const src = await Bun.file(new URL("./wiki-browser.ts", import.meta.url)).text();
    expect(src).toContain("selfWiki: () => FIND_ROWS_WIKI,");
    // Agent lens, new-since, answer cards, answer export.
    expect(src.match(/wiki: FIND_SELF_WIKI \|\| WIKI,/g)?.length).toBe(4);
    // Nothing else reads the rows name: one declaration, one palette use.
    expect(src.match(/\bFIND_ROWS_WIKI\b/g)?.length).toBe(2);
  });
});
