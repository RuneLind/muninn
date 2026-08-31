import { afterEach, test, expect, describe } from "bun:test";
import { readActiveWikiRoot, withWikiParam } from "./wiki-param.ts";

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
