import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { __resetWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import {
  registerWikiRoutes,
  __resetWikiDigestCacheForTest,
  __seedWikiDigestForTest,
  digestCacheDecision,
} from "./wiki-routes.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import { readLogMtimeMs, type WikiDigest } from "../../wiki/digest.ts";

/**
 * Route-level tests for the explainer-serving seam `/api/wiki/html`. Uses the
 * legacy `WIKI_DIR` env override (a bare request, no `?wiki=`) so the memoized
 * bot registry is irrelevant — the store resolves the temp dir directly.
 */
describe("GET /api/wiki/html", () => {
  let root: string;
  let app: Hono;
  let prevWikiDir: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-html-route-"));
    await mkdir(path.join(root, "blogs"), { recursive: true });
    await mkdir(path.join(root, "concepts"), { recursive: true });
    await Bun.write(
      path.join(root, "blogs/Explainer One.html"),
      "<!doctype html><html><head><title>Explainer One</title></head><body>hello</body></html>",
    );
    await Bun.write(
      path.join(root, "concepts/A Concept.md"),
      "---\ntype: concept\ntitle: A Concept\n---\n\nBody.",
    );
    prevWikiDir = process.env.WIKI_DIR;
    process.env.WIKI_DIR = root;
    __resetWikiCacheForTest();
    app = new Hono();
    // The /api/wiki/html tests never touch the ask route, so a stub config is fine.
    registerWikiRoutes(app, {} as Parameters<typeof registerWikiRoutes>[1]);
  });

  afterEach(async () => {
    if (prevWikiDir === undefined) delete process.env.WIKI_DIR;
    else process.env.WIKI_DIR = prevWikiDir;
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("serves an explainer's raw HTML as text/html", async () => {
    const res = await app.request("/api/wiki/html?name=" + encodeURIComponent("Explainer One"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("<title>Explainer One</title>");
  });

  test("400 without a name param", async () => {
    const res = await app.request("/api/wiki/html");
    expect(res.status).toBe(400);
  });

  test("404 for a markdown (non-explainer) page", async () => {
    const res = await app.request("/api/wiki/html?name=" + encodeURIComponent("A Concept"));
    expect(res.status).toBe(404);
  });

  test("404 for an unknown page name", async () => {
    const res = await app.request("/api/wiki/html?name=does-not-exist");
    expect(res.status).toBe(404);
  });
});

/**
 * Wiki Ask route resolution. Exercises only the branches that never reach
 * `streamResearchAnswer` (no Huginn / no `claude` spawn): an unknown wiki and a
 * registered wiki with no search collections both emit a clean `app_error` SSE
 * event. Uses a `WIKI_EXTRA` temp wiki (no collections) and resets the memoized
 * registry so the env is picked up deterministically.
 */
describe("GET /api/wiki/ask — resolution errors", () => {
  let root: string;
  let app: Hono;
  let prevExtra: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-ask-route-"));
    await Bun.write(path.join(root, "A Concept.md"), "---\ntype: concept\ntitle: A Concept\n---\n\nBody.");
    prevExtra = process.env.WIKI_EXTRA;
    // Standalone wiki with NO third segment ⇒ no collections.
    process.env.WIKI_EXTRA = `askwiki=${root}`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    app = new Hono();
    registerWikiRoutes(app, {} as Parameters<typeof registerWikiRoutes>[1]);
  });

  afterEach(async () => {
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("400 without a q param", async () => {
    const res = await app.request("/api/wiki/ask?wiki=askwiki");
    expect(res.status).toBe(400);
  });

  test("registered wiki with no collections → app_error SSE", async () => {
    const res = await app.request("/api/wiki/ask?wiki=askwiki&q=hello");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("event: app_error");
    expect(body).toContain("No search collection connected");
    expect(body).toContain("event: end");
  });

  test("unknown wiki → app_error SSE", async () => {
    const res = await app.request("/api/wiki/ask?wiki=does-not-exist&q=hello");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("event: app_error");
    expect(body).toContain("No wiki configured");
  });
});

describe("digestCacheDecision", () => {
  const digest = { logMtimeMs: 1000 } as WikiDigest;

  test("refresh always regenerates, even on a matching mtime", () => {
    expect(digestCacheDecision(digest, 1000, true)).toBe("regenerate");
  });

  test("hit when cached and mtime matches", () => {
    expect(digestCacheDecision(digest, 1000, false)).toBe("hit");
  });

  test("regenerate when mtime differs (log.md changed)", () => {
    expect(digestCacheDecision(digest, 2000, false)).toBe("regenerate");
  });

  test("regenerate when nothing cached", () => {
    expect(digestCacheDecision(undefined, 1000, false)).toBe("regenerate");
  });
});

/**
 * `/api/wiki/digest` route seams that don't require a connector run: a wiki
 * without a `log.md` yields `{ digest: null }`, and a pre-seeded cache whose
 * `logMtimeMs` matches the on-disk `log.md` is served straight back (cache hit,
 * no generation). Uses a `WIKI_EXTRA` temp wiki so there IS a registry entry to
 * resolve (the digest route needs one — the bare `WIKI_DIR` override never
 * claims a wiki). Cache-hit returns the seeded digest, proving no regeneration.
 */
describe("GET /api/wiki/digest", () => {
  let root: string;
  let app: Hono;
  let prevExtra: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-digest-route-"));
    await Bun.write(
      path.join(root, "knowledge-graph.md"),
      "---\ntype: concept\ntitle: knowledge-graph\n---\n\nBody.",
    );
    prevExtra = process.env.WIKI_EXTRA;
    process.env.WIKI_EXTRA = `digwiki=${root}`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    __resetWikiDigestCacheForTest();
    app = new Hono();
    registerWikiRoutes(app, {} as Parameters<typeof registerWikiRoutes>[1]);
  });

  afterEach(async () => {
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    __resetWikiDigestCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("wiki without log.md → { digest: null }", async () => {
    const res = await app.request("/api/wiki/digest?wiki=digwiki");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ digest: null });
  });

  test("cache hit: seeded digest with matching mtime is served (bullets rendered to html)", async () => {
    await Bun.write(
      path.join(root, "log.md"),
      "# Log\n\n## [2026-05-01] note | Init\n\nBody mentions [[knowledge-graph]].",
    );
    const mtime = (await readLogMtimeMs(root))!;
    const seeded: WikiDigest = {
      bullets: "- Grew [[knowledge-graph]]",
      generatedAt: 42,
      logMtimeMs: mtime,
      entryCount: 1,
      fromDate: "2026-05-01",
      toDate: "2026-05-01",
    };
    __seedWikiDigestForTest("digwiki", seeded);
    const res = await app.request("/api/wiki/digest?wiki=digwiki");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { digest: (WikiDigest & { html: string }) | null };
    expect(body.digest).not.toBeNull();
    // Same seeded generatedAt ⇒ not regenerated.
    expect(body.digest!.generatedAt).toBe(42);
    expect(body.digest!.bullets).toBe("- Grew [[knowledge-graph]]");
    // The wikilink resolved to a real page ⇒ rendered as an in-reader anchor.
    expect(body.digest!.html).toContain('data-wiki-page="knowledge-graph"');
  });
});
