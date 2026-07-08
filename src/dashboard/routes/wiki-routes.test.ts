import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { registerWikiRoutes } from "./wiki-routes.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";

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
    registerWikiRoutes(app);
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
