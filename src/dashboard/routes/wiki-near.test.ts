/**
 * `GET /api/wiki/page`'s `near` map — the find palette's closeness boost.
 *
 * Driven through the real route over a temp wiki, because the one thing a
 * unit test of `nearScores` cannot see is the KEY the route ships: the client
 * looks rows up by the listing's `relPath`, so a key spelled any other way
 * (the lowercased `normalizeRelPath` form, say) silently zeroes the boost on
 * every path with a capital.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { registerWikiRoutes } from "./wiki-routes.ts";
import { __resetWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import { NEAR_MAX, RELATED_HUB_BACKLINKS } from "../../wiki/related-constants.ts";

function page(title: string, body: string): string {
  return ["---", `title: ${title}`, "---", "", body, ""].join("\n");
}

describe("GET /api/wiki/page — near", () => {
  let root = "";
  let app: Hono;
  let prevExtra: string | undefined;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-near-"));
    const files: Array<[string, string]> = [
      ["plans/open.md", page("Open", "Links [[Mid]] and [[hub]].")],
      ["Notes/Mid.md", page("Mid", "Links [[far]].")],
      ["other/far.md", page("Far", "Nothing.")],
      ["plans/hub.md", page("Hub", "Links [[Mid]].")],
      // A page whose near map overflows the cap: 30 first-hop pages, each with
      // 10 of its own.
      ["big/open.md", page("Big", Array.from({ length: 30 }, (_, i) => `[[m${i}]]`).join(" "))],
    ];
    for (let i = 0; i < 30; i++) {
      files.push([`big/m${i}.md`, page(`M${i}`, Array.from({ length: 10 }, (_, j) => `[[f${i}-${j}]]`).join(" "))]);
      for (let j = 0; j < 10; j++) files.push([`big/f${i}-${j}.md`, page(`F${i}-${j}`, "x")]);
    }
    for (let i = 0; i <= RELATED_HUB_BACKLINKS; i++) files.push([`fill/f${i}.md`, page(`Fill ${i}`, "[[hub]]")]);
    for (const [rel, body] of files) {
      await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
      await writeFile(path.join(root, rel), body, "utf8");
    }
    prevExtra = process.env.WIKI_EXTRA;
    process.env.WIKI_EXTRA = `nearwiki=${root}`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    app = new Hono();
    app.onError((err, c) => c.json({ error: String(err) }, 500));
    registerWikiRoutes(app, {} as Parameters<typeof registerWikiRoutes>[1]);
  });

  afterAll(async () => {
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  const near = async (relPath: string): Promise<Record<string, number>> => {
    const res = await app.request(`/api/wiki/page?wiki=nearwiki&relPath=${encodeURIComponent(relPath)}`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { near: Record<string, number> }).near;
  };

  test("a normal page: first hop at 0.5, second hop under it, keyed as the listing spells it", async () => {
    const map = await near("plans/open.md");
    const listing = (await (await app.request("/api/wiki/pages?wiki=nearwiki")).json()) as {
      pages: Array<{ relPath: string }>;
    };
    const listed = new Set(listing.pages.map((p) => p.relPath));
    expect(map["Notes/Mid.md"]).toBe(0.5);
    expect(map["other/far.md"]).toBeGreaterThan(0);
    expect(map["other/far.md"]).toBeLessThan(0.5);
    // Capitals kept: every key is a listing relPath, the lowercased one is absent.
    for (const key of Object.keys(map)) expect(listed.has(key)).toBe(true);
    expect(map["notes/mid.md"]).toBeUndefined();
    // The hub is not in the map, and the open page is not its own neighbour.
    expect(map["plans/hub.md"]).toBeUndefined();
    expect(map["plans/open.md"]).toBeUndefined();
  });

  test("a hub page answers an empty map", async () => {
    expect(await near("plans/hub.md")).toEqual({});
  });

  test(`the map is capped at ${NEAR_MAX} entries`, async () => {
    expect(Object.keys(await near("big/open.md")).length).toBe(NEAR_MAX);
  });
});
