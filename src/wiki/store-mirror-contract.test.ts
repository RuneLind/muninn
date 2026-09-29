/**
 * The two `getWikiIndex` behaviors the bucket mirror (`bucket-mirror.ts`) builds
 * on, pinned before it relies on them:
 *
 *  1. an EMPTY existing root is an empty wiki (0 pages), not null — so the
 *     mirror's `mkdir -p` at boot turns "wiki disabled" into "no pages yet";
 *  2. a `refresh: true` call picks up a file added, changed or deleted behind
 *     the cache, while a plain call inside the TTL does not.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getWikiIndex, readWikiPage, __resetWikiCacheForTest } from "./store.ts";

describe("getWikiIndex — the contract the bucket mirror relies on", () => {
  let root: string;
  beforeEach(async () => {
    __resetWikiCacheForTest();
    root = await mkdtemp(path.join(tmpdir(), "wiki-mirror-contract-"));
  });
  afterEach(async () => {
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("an empty existing root is an empty wiki, not null", async () => {
    const index = await getWikiIndex({ root });
    expect(index).not.toBeNull();
    expect(index!.pages.length).toBe(0);
  });

  test("a missing root is null and is not cached — it is re-stat'ed once it exists", async () => {
    const missing = path.join(root, "later");
    expect(await getWikiIndex({ root: missing })).toBeNull();
    await Bun.write(path.join(missing, "a.md"), "# A\n");
    const index = await getWikiIndex({ root: missing });
    expect(index?.pages.map((p) => p.relPath)).toEqual(["a.md"]);
  });

  test("refresh: true picks up an added, a changed and a deleted file; a plain call stays cached", async () => {
    expect((await getWikiIndex({ root }))!.pages.length).toBe(0);

    await Bun.write(path.join(root, "plans/side.mdx"), "---\ntitle: Første\n---\n\nEn.\n");
    // Inside the TTL, without refresh: the cached empty index.
    expect((await getWikiIndex({ root }))!.pages.length).toBe(0);

    const added = await getWikiIndex({ root, refresh: true });
    expect(added!.pages.map((p) => p.relPath)).toEqual(["plans/side.mdx"]);
    expect(added!.pages[0]!.title).toBe("Første");

    await Bun.write(path.join(root, "plans/side.mdx"), "---\ntitle: Andre\n---\n\nTo.\n");
    const changed = await getWikiIndex({ root, refresh: true });
    expect(changed!.pages[0]!.title).toBe("Andre");
    expect(await readWikiPage(changed!, changed!.pages[0]!)).toContain("To.");

    await unlink(path.join(root, "plans/side.mdx"));
    const deleted = await getWikiIndex({ root, refresh: true });
    expect(deleted!.pages.length).toBe(0);
  });
});
