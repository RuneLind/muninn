import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { registerWikiGardenerRoutes } from "./wiki-gardener-routes.ts";
import { __resetWikiRegistryForTest } from "./wiki-routes.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";

/**
 * Route-level resolution tests for `/api/wiki/linter-findings`. Mirrors the
 * `wiki-routes.test.ts` approach: only the deterministic resolution branches
 * that never reach real bot discovery are exercised here (a `WIKI_EXTRA`
 * standalone wiki is source !== "bot"; an unknown name resolves to nothing).
 * Both degrade to a 200 with an `error` field, never a 5xx. The actual lint
 * findings (broken link + orphan) are covered end-to-end in `src/wiki/lint.test.ts`.
 */
describe("GET /api/wiki/linter-findings — resolution errors", () => {
  let root: string;
  let app: Hono;
  let prevExtra: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-linter-route-"));
    await Bun.write(path.join(root, "A Concept.md"), "---\ntype: concept\ntitle: A Concept\n---\n\nBody.");
    prevExtra = process.env.WIKI_EXTRA;
    // Standalone wiki (source !== "bot") — the linter is bot-wiki only.
    process.env.WIKI_EXTRA = `lintwiki=${root}`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    app = new Hono();
    registerWikiGardenerRoutes(app);
  });

  afterEach(async () => {
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("standalone (non-bot) wiki → 200 with a bot-only error, no findings", async () => {
    const res = await app.request("/api/wiki/linter-findings?wiki=lintwiki");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { findings: unknown[]; error?: string };
    expect(body.error).toContain("only available for bot wikis");
    expect(body.findings).toEqual([]);
  });

  test("unknown wiki → 200 with a not-configured error", async () => {
    const res = await app.request("/api/wiki/linter-findings?wiki=does-not-exist");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { findings: unknown[]; error?: string };
    expect(body.error).toContain("no wiki configured");
    expect(body.findings).toEqual([]);
  });
});
