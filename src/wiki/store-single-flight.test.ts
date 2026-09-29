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
   *  "disk version" it read at START and its build number — so a stale build is
   *  observable. Every wait is bounded: a mutant that starts too many or too few
   *  builds fails on an assertion, never on bun's 5 s timeout. */
  function heldBuilder() {
    let version = 1;
    let started = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    const pending: (() => void)[] = [];
    __setWikiIndexBuilderForTest(async (r) => {
      const seen = version;
      const id = ++started;
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise<void>((resolve) => pending.push(resolve));
      concurrent--;
      return { root: r, pages: [], scannedAt: Date.now(), seen, id } as unknown as WikiIndex;
    });
    /** Wait (≤ 250 ms) until `n` builds have started; false on the deadline. */
    const waitStarted = async (n: number) => {
      const deadline = Date.now() + 250;
      while (__wikiIndexBuildsStartedForTest() < n) {
        if (Date.now() > deadline) return false;
        await Bun.sleep(1);
      }
      return true;
    };
    /** Release one held build (≤ 250 ms wait); false when none was held. */
    const release = async (which: "oldest" | "newest") => {
      const deadline = Date.now() + 250;
      while (pending.length === 0) {
        if (Date.now() > deadline) return false;
        await Bun.sleep(1);
      }
      (which === "oldest" ? pending.shift()! : pending.pop()!)();
      return true;
    };
    return {
      write: () => { version++; },
      waitStarted,
      releaseNext: () => release("oldest"),
      releaseNewest: () => release("newest"),
      held: () => pending.length,
      maxConcurrent: () => maxConcurrent,
    };
  }
  const seen = (i: WikiIndex | null) => (i as unknown as { seen: number }).seen;
  const buildId = (i: WikiIndex | null) => (i as unknown as { id: number }).id;

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
    expect(await b.waitStarted(1)).toBe(true);
    const refreshers = [1, 2, 3].map(() => getWikiIndex({ root, refresh: true }));
    const joiner = getWikiIndex({ root }); // accepts the cache: joins the running build
    expect(await b.releaseNext()).toBe(true);
    expect(await b.waitStarted(2)).toBe(true);
    await Bun.sleep(20); // room for any extra queued build to start
    expect(__wikiIndexBuildsStartedForTest()).toBe(2);
    expect(await b.releaseNext()).toBe(true);
    const got = await Promise.all(refreshers);
    expect(new Set(got).size).toBe(1);
    expect(await joiner).toBe(await running);
  });

  test("a second refresh wave after a write during the FIRST queued build sees that write", async () => {
    const b = heldBuilder();
    const first = getWikiIndex({ root }); // build 1, reads version 1
    expect(await b.waitStarted(1)).toBe(true);
    b.write(); // version 2
    const wave1 = getWikiIndex({ root, refresh: true }); // queued build 2
    expect(await b.releaseNext()).toBe(true);
    expect(seen(await first)).toBe(1);
    expect(await b.waitStarted(2)).toBe(true); // build 2 read version 2
    b.write(); // version 3 lands while the queued build runs
    const wave2 = getWikiIndex({ root, refresh: true }); // must not get build 2 back
    expect(await b.releaseNext()).toBe(true);
    expect(seen(await wave1)).toBe(2);
    await b.releaseNext(); // build 3, when there is one
    expect(seen(await wave2)).toBe(3);
    expect(__wikiIndexBuildsStartedForTest()).toBe(3);
  });

  test("a caller arriving while a queued build runs never starts a second concurrent build", async () => {
    const b = heldBuilder();
    getWikiIndex({ root }); // build 1
    expect(await b.waitStarted(1)).toBe(true);
    const wave1 = getWikiIndex({ root, refresh: true }); // queued build 2
    expect(await b.releaseNext()).toBe(true);
    expect(await b.waitStarted(2)).toBe(true);
    const late = getWikiIndex({ root, refresh: true }); // arrives while build 2 runs
    await b.waitStarted(3);
    await Bun.sleep(20);
    expect(b.maxConcurrent()).toBe(1);
    // Newest first: were builds 2 and 3 concurrent, build 2 would settle LAST
    // and leave its older index in the cache.
    while (b.held() > 0 || __wikiIndexBuildsStartedForTest() < 3) {
      if (!(await b.releaseNewest())) break;
    }
    expect(buildId(await wave1)).toBe(2);
    expect(buildId(await late)).toBe(3);
    expect(buildId(await getWikiIndex({ root }))).toBe(3); // the cache holds the newest
  });
});
