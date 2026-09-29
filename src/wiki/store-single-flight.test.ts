import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  __resetWikiCacheForTest,
  __setWikiIndexBuilderForTest,
  __wikiIndexBuildsStartedForTest,
  getWikiIndex,
  type WikiIndex,
} from "./store.ts";

/**
 * `getWikiIndex` single-flight: concurrent callers share one build, and a
 * `refresh` caller is never handed a build that started before its call.
 */
describe("getWikiIndex single-flight", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-flight-"));
    await Bun.write(path.join(root, "A.md"), "# A\n\nbody\n");
    __resetWikiCacheForTest();
  });

  afterEach(async () => {
    __setWikiIndexBuilderForTest(null);
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("N concurrent cold callers share ONE build (one index object)", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => getWikiIndex({ root })));
    expect(results[0]).not.toBeNull();
    expect(new Set(results).size).toBe(1);
  });

  test("N concurrent refreshers on a warm cache cost TWO builds, not N", async () => {
    // The first starts a build; the other seven arrive after it started, so they
    // cannot trust it and share the one queued behind it.
    const warm = await getWikiIndex({ root });
    const results = await Promise.all(Array.from({ length: 8 }, () => getWikiIndex({ root, refresh: true })));
    expect(new Set(results).size).toBe(2);
    expect(results).not.toContain(warm);
    expect(new Set(results.slice(1)).size).toBe(1);
  });

  /** A builder whose builds are held open until released, each stamped with the
   *  "disk version" it read at START — so a stale build is observable. */
  function heldBuilder() {
    let version = 1;
    const releases: (() => void)[] = [];
    __setWikiIndexBuilderForTest(async (r) => {
      const seen = version;
      await new Promise<void>((resolve) => releases.push(resolve));
      return { root: r, pages: [], scannedAt: Date.now(), seen } as unknown as WikiIndex;
    });
    return {
      write: () => { version++; },
      releaseNext: async () => {
        while (releases.length === 0) await Bun.sleep(1);
        releases.shift()!();
      },
    };
  }
  const seen = (i: WikiIndex | null) => (i as unknown as { seen: number }).seen;

  test("a refresh after a write that lands DURING an in-flight build sees the write", async () => {
    const b = heldBuilder();
    const before = getWikiIndex({ root }); // build 1 starts, reads version 1
    await Bun.sleep(5);
    b.write(); // the write lands while build 1 is running
    const after = getWikiIndex({ root, refresh: true }); // the writer's refresh
    await b.releaseNext();
    expect(seen(await before)).toBe(1);
    await b.releaseNext();
    expect(seen(await after)).toBe(2);
    expect(__wikiIndexBuildsStartedForTest()).toBe(2);
  });

  test("refreshers arriving during a running build share ONE queued build", async () => {
    const b = heldBuilder();
    const running = getWikiIndex({ root });
    await Bun.sleep(5);
    const refreshers = [1, 2, 3].map(() => getWikiIndex({ root, refresh: true }));
    const joiner = getWikiIndex({ root }); // accepts the cache: joins the running build
    await b.releaseNext();
    await b.releaseNext();
    const got = await Promise.all(refreshers);
    expect(new Set(got).size).toBe(1);
    expect(await joiner).toBe(await running);
    expect(__wikiIndexBuildsStartedForTest()).toBe(2);
  });
});
