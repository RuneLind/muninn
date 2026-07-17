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
  __setSimilarSearchForTest,
  digestCacheDecision,
  resolveExplainPreflight,
} from "./wiki-routes.ts";
import type { WikiRegistryEntry } from "../../wiki/registry.ts";
import type { WikiIndex, WikiPageMeta } from "../../wiki/store.ts";
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

  // The explainer view's Connections panel is fed by /api/wiki/page — it must
  // serve explainers (meta + backlinks), not just markdown pages.
  test("/api/wiki/page serves an explainer with its backlinks", async () => {
    await Bun.write(
      path.join(root, "concepts/Linker.md"),
      "---\ntype: concept\ntitle: Linker\n---\n\nSee the [explainer](../blogs/Explainer%20One.html).",
    );
    __resetWikiCacheForTest();
    const res = await app.request("/api/wiki/page?name=" + encodeURIComponent("Explainer One"));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      meta: { type: string };
      backlinks: Array<{ name: string }>;
      outgoing: unknown[];
    };
    expect(data.meta.type).toBe("explainer");
    expect(data.backlinks.map((b) => b.name)).toContain("Linker");
    expect(data.outgoing).toEqual([]);
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

/**
 * `/api/wiki/index-coverage` resolution branches that never hit huginn: an
 * unknown wiki and a registered wiki with no backing collections both return a
 * clean 200 + `{ error }` with null coverage fields (never a 5xx). The happy path
 * (real collection listings) is covered at the unit level on `buildIndexCoverageResponse`.
 */
describe("GET /api/wiki/index-coverage — resolution branches", () => {
  let root: string;
  let app: Hono;
  let prevExtra: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-idxcov-route-"));
    await Bun.write(path.join(root, "A Concept.md"), "---\ntype: concept\ntitle: A Concept\n---\n\nBody.");
    prevExtra = process.env.WIKI_EXTRA;
    // Standalone wiki with NO third segment ⇒ no collections.
    process.env.WIKI_EXTRA = `covwiki=${root}`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    app = new Hono();
    registerWikiRoutes(app, { knowledgeApiUrl: "http://127.0.0.1:0" } as Parameters<typeof registerWikiRoutes>[1]);
  });

  afterEach(async () => {
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("registered wiki with no collections → 200 + clean error, null coverage", async () => {
    const res = await app.request("/api/wiki/index-coverage?wiki=covwiki");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error?: string; totalMd: number | null; indexed: number | null };
    expect(body.error).toContain("no search collection connected");
    expect(body.totalMd).toBeNull();
    expect(body.indexed).toBeNull();
  });

  test("unknown wiki → 200 + clean error", async () => {
    const res = await app.request("/api/wiki/index-coverage?wiki=does-not-exist");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("no wiki configured");
  });
});

/**
 * `/api/wiki/reindex` + `/api/wiki/reindex-status` resolution branches that never
 * hit huginn: an unknown wiki and a registered wiki with no backing collections
 * both return a clean 200 + `{ collections: [], error }` (never a 5xx). The huginn
 * fan-out + 409/unknown mapping is covered at the unit level on `src/wiki/reindex.ts`.
 */
describe("wiki reindex routes — resolution branches", () => {
  let root: string;
  let app: Hono;
  let prevExtra: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-reindex-route-"));
    await Bun.write(path.join(root, "A Concept.md"), "---\ntype: concept\ntitle: A Concept\n---\n\nBody.");
    prevExtra = process.env.WIKI_EXTRA;
    // Standalone wiki with NO third segment ⇒ no collections.
    process.env.WIKI_EXTRA = `rixwiki=${root}`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    app = new Hono();
    registerWikiRoutes(app, { knowledgeApiUrl: "http://127.0.0.1:0" } as Parameters<typeof registerWikiRoutes>[1]);
  });

  afterEach(async () => {
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("POST reindex, wiki with no collections → 200 + clean error, empty collections", async () => {
    const res = await app.request("/api/wiki/reindex?wiki=rixwiki", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error?: string; collections: unknown[] };
    expect(body.error).toContain("no search collection connected");
    expect(body.collections).toEqual([]);
  });

  test("POST reindex, unknown wiki → 200 + clean error", async () => {
    const res = await app.request("/api/wiki/reindex?wiki=does-not-exist", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("no wiki configured");
  });

  test("GET reindex-status, wiki with no collections → 200 + clean error", async () => {
    const res = await app.request("/api/wiki/reindex-status?wiki=rixwiki");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error?: string; collections: unknown[] };
    expect(body.error).toContain("no search collection connected");
    expect(body.collections).toEqual([]);
  });

  test("GET reindex-status, unknown wiki → 200 + clean error", async () => {
    const res = await app.request("/api/wiki/reindex-status?wiki=does-not-exist");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("no wiki configured");
  });
});

/**
 * `/api/wiki/similar` — semantic cousins for a page. The Huginn search is
 * injected via `__setSimilarSearchForTest`, so happy / self-exclusion /
 * unresolved-drop / huginn-down all run without a live Huginn. No-collections
 * and unknown-wiki resolution branches (clean 404s) need no injection.
 */
describe("GET /api/wiki/similar", () => {
  let root: string;
  let app: Hono;
  let prevExtra: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-similar-route-"));
    await mkdir(path.join(root, "sub"), { recursive: true });
    await Bun.write(path.join(root, "Current.md"), "---\ntype: concept\ntitle: Current\n---\n\nBody of current.");
    await Bun.write(path.join(root, "Cousin A.md"), "---\ntype: concept\ntitle: Cousin A\n---\n\nBody A.");
    await Bun.write(path.join(root, "sub/Cousin B.md"), "---\ntype: concept\ntitle: Cousin B\n---\n\nBody B.");
    await Bun.write(
      path.join(root, "sub/An Explainer.html"),
      '<!doctype html><html><head><title>An Explainer</title>' +
        '<meta name="keywords" content="Corrective RAG, Retrieval">' +
        '<meta name="description" content="Head meta description prose.">' +
        "</head><body>hello</body></html>",
    );
    prevExtra = process.env.WIKI_EXTRA;
    // Standalone wiki WITH a collection (3rd segment) so similar can search.
    process.env.WIKI_EXTRA = `simwiki=${root}=simcoll`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    app = new Hono();
    registerWikiRoutes(app, { knowledgeApiUrl: "http://127.0.0.1:0" } as Parameters<typeof registerWikiRoutes>[1]);
  });

  afterEach(async () => {
    __setSimilarSearchForTest(null);
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("happy path resolves hits to wiki pages, ordered by relevance", async () => {
    __setSimilarSearchForTest(async () => ({
      results: [
        { collection: "simcoll", id: "Cousin A.md", relevance: 0.5 },
        { collection: "simcoll", id: "sub/Cousin B.md", relevance: 0.9 },
      ],
    }));
    const res = await app.request("/api/wiki/similar?wiki=simwiki&page=" + encodeURIComponent("Current"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { similar: { name: string; title: string; relPath: string }[] };
    expect(body.similar.map((p) => p.title)).toEqual(["Cousin B", "Cousin A"]);
  });

  test("excludes the current page from its own similar list", async () => {
    __setSimilarSearchForTest(async () => ({
      results: [
        { collection: "simcoll", id: "Current.md", relevance: 0.99 },
        { collection: "simcoll", id: "Cousin A.md", relevance: 0.4 },
      ],
    }));
    const res = await app.request("/api/wiki/similar?wiki=simwiki&page=" + encodeURIComponent("Current"));
    const body = (await res.json()) as { similar: { title: string }[] };
    expect(body.similar.map((p) => p.title)).toEqual(["Cousin A"]);
  });

  test("drops hits that don't resolve to a wiki page", async () => {
    __setSimilarSearchForTest(async () => ({
      results: [
        { collection: "simcoll", id: "external/not-in-wiki.md", title: "Nope", relevance: 0.8 },
        { collection: "simcoll", id: "Cousin A.md", relevance: 0.3 },
      ],
    }));
    const res = await app.request("/api/wiki/similar?wiki=simwiki&page=" + encodeURIComponent("Current"));
    const body = (await res.json()) as { similar: { title: string }[] };
    expect(body.similar.map((p) => p.title)).toEqual(["Cousin A"]);
  });

  test("wiki with no collections → clean 404", async () => {
    process.env.WIKI_EXTRA = `nocoll=${root}`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    const res = await app.request("/api/wiki/similar?wiki=nocoll&page=Current");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("no search collection connected");
  });

  test("unknown wiki → clean 404", async () => {
    const res = await app.request("/api/wiki/similar?wiki=does-not-exist&page=Current");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("no wiki configured");
  });

  test("missing page param → 400", async () => {
    const res = await app.request("/api/wiki/similar?wiki=simwiki");
    expect(res.status).toBe(400);
  });

  test("explainer sends the enriched query (title + tags + head description)", async () => {
    let seenPath = "";
    __setSimilarSearchForTest(async (_baseUrl, p) => {
      seenPath = p;
      return { results: [] };
    });
    const res = await app.request(
      "/api/wiki/similar?wiki=simwiki&page=" + encodeURIComponent("An Explainer"),
    );
    expect(res.status).toBe(200);
    const q = new URLSearchParams(seenPath.split("?")[1]).get("q")!;
    expect(q).toContain("An Explainer");
    expect(q).toContain("corrective-rag retrieval");
    expect(q).toContain("Head meta description prose");
  });

  test("page-list payload carries tags + description for explainers", async () => {
    const res = await app.request("/api/wiki/pages?wiki=simwiki");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pages: { name: string; type: string; tags: string[]; description?: string }[];
    };
    const ex = body.pages.find((p) => p.name === "An Explainer")!;
    expect(ex.type).toBe("explainer");
    expect(ex.tags).toEqual(["corrective-rag", "retrieval"]);
    expect(ex.description).toBe("Head meta description prose.");
  });

  test("huginn down → 200 with empty similar (section hides, page never errors)", async () => {
    __setSimilarSearchForTest(async () => {
      throw new Error("Knowledge API unreachable");
    });
    const res = await app.request("/api/wiki/similar?wiki=simwiki&page=" + encodeURIComponent("Current"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { similar: unknown[] };
    expect(body.similar).toEqual([]);
  });
});

/**
 * `/api/wiki/explain` — Select-to-Explain. Sibling of the Ask route. Like the Ask
 * tests, we exercise only the seams the code allows without a live Huginn/`claude`:
 * the 400s for missing params, the `app_error` preflights (unknown wiki / no
 * collections / missing index / unknown page), the status-200 explainer case (now
 * supported via htmlToText — preflight-removal proven in the pure
 * `resolveExplainPreflight` tests), and the risk-note-4 behavioral check that a
 * THROWING similar-search fn still reaches
 * `streamResearchSSE` without a 500. All prompt-composition assertions live in the
 * pure `explain-context.test.ts` — the route stays a thin I/O shell here.
 */
describe("GET /api/wiki/explain — resolution + preflight", () => {
  let root: string;
  let app: Hono;
  let prevExtra: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-explain-route-"));
    await mkdir(path.join(root, "blogs"), { recursive: true });
    await Bun.write(path.join(root, "A Concept.md"), "---\ntype: concept\ntitle: A Concept\n---\n\nBody.");
    await Bun.write(
      path.join(root, "blogs/An Explainer.html"),
      "<!doctype html><html><head><title>An Explainer</title></head><body>hi</body></html>",
    );
    prevExtra = process.env.WIKI_EXTRA;
    // explwiki: has a collection (page-level preflights reachable).
    // nocoll:   same dir, no collection.
    // badidx:   has a collection but points at a missing dir (index unloadable).
    process.env.WIKI_EXTRA =
      `explwiki=${root}=explcoll,nocoll=${root},badidx=${path.join(root, "missing-subdir")}=badcoll`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    app = new Hono();
    registerWikiRoutes(app, { knowledgeApiUrl: "http://127.0.0.1:0" } as Parameters<typeof registerWikiRoutes>[1]);
  });

  afterEach(async () => {
    __setSimilarSearchForTest(null);
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  test("400 without a sel param", async () => {
    const res = await app.request(
      "/api/wiki/explain?wiki=explwiki&page=" + encodeURIComponent("A Concept"),
    );
    expect(res.status).toBe(400);
  });

  test("400 without a page param", async () => {
    const res = await app.request("/api/wiki/explain?wiki=explwiki&sel=hello");
    expect(res.status).toBe(400);
  });

  test("unknown wiki → app_error SSE", async () => {
    const res = await app.request("/api/wiki/explain?wiki=does-not-exist&sel=hi&page=X");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("event: app_error");
    expect(body).toContain("No wiki configured");
    expect(body).toContain("event: end");
  });

  test("wiki with no collections → app_error SSE", async () => {
    const res = await app.request(
      "/api/wiki/explain?wiki=nocoll&sel=hi&page=" + encodeURIComponent("A Concept"),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("event: app_error");
    expect(body).toContain("No search collection connected");
  });

  test("missing/unloadable index → app_error SSE", async () => {
    const res = await app.request("/api/wiki/explain?wiki=badidx&sel=hi&page=X");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("event: app_error");
    expect(body).toContain("wiki directory not found");
  });

  test("unknown page → app_error SSE", async () => {
    const res = await app.request("/api/wiki/explain?wiki=explwiki&sel=hi&page=Nope");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("event: app_error");
    expect(body).toContain("No wiki page named");
    expect(body).toContain("Nope");
  });

  test("explainer page → 200 SSE (now supported via htmlToText, no preflight-out)", async () => {
    // Explainers are no longer preflighted out. We assert only the status —
    // reading the body would drive the real (unreachable) synthesis path, and a
    // status-only check cannot distinguish old (app_error) from new (synthesis)
    // anyway; the preflight-removal proof lives in the pure resolveExplainPreflight
    // unit tests below.
    const res = await app.request(
      "/api/wiki/explain?wiki=explwiki&sel=hi&page=" + encodeURIComponent("An Explainer"),
    );
    expect(res.status).toBe(200);
  });

  test("throwing similar search still reaches streamResearchSSE without a 500", async () => {
    // risk-note-4: a thrown similar-search degrades to no Related-pages context and
    // the request still streams (returns a 200 SSE Response). We assert only the
    // status — reading the body would drive the real (unreachable) synthesis path.
    __setSimilarSearchForTest(async () => {
      throw new Error("Huginn unreachable");
    });
    const res = await app.request(
      "/api/wiki/explain?wiki=explwiki&page=" +
        encodeURIComponent("A Concept") +
        "&sel=" +
        encodeURIComponent("Body."),
    );
    expect(res.status).toBe(200);
  });
});

/**
 * Pure preflight decision chain for `/api/wiki/explain`. This is the seam that
 * proves the explainer-preflight REMOVAL: an explainer meta yields `null` (no
 * error), while the unknown-wiki / no-collections / unknown-page branches are
 * unchanged. A status-only route test can't show this (both old and new paths
 * are 200, and reading the body drives the unreachable synthesis path).
 */
describe("resolveExplainPreflight", () => {
  const entry = { name: "w", root: "/x", source: "extra", collections: ["c"] } as WikiRegistryEntry;
  const index = {} as WikiIndex;
  const mdMeta = { type: "concept" } as WikiPageMeta;
  const explainerMeta = { type: "explainer" } as WikiPageMeta;

  test("explainer meta → null (no more preflight-out)", () => {
    expect(
      resolveExplainPreflight({ wiki: "w", unknownWiki: false, entry, index, meta: explainerMeta, page: "P" }),
    ).toBeNull();
  });

  test("markdown meta → null", () => {
    expect(
      resolveExplainPreflight({ wiki: "w", unknownWiki: false, entry, index, meta: mdMeta, page: "P" }),
    ).toBeNull();
  });

  test("unknown wiki → configured error (interpolates the raw wiki name)", () => {
    expect(
      resolveExplainPreflight({
        wiki: "ghost",
        unknownWiki: true,
        entry: undefined,
        index: null,
        meta: undefined,
        page: "P",
      }),
    ).toBe('No wiki configured for "ghost".');
  });

  test("no entry with blank wiki → (none) fallback", () => {
    expect(
      resolveExplainPreflight({
        wiki: "",
        unknownWiki: false,
        entry: undefined,
        index: null,
        meta: undefined,
        page: "P",
      }),
    ).toBe('No wiki configured for "(none)".');
  });

  test("entry with no collections → no-collection error", () => {
    const noColl = { name: "w", root: "/x", source: "extra" } as WikiRegistryEntry;
    expect(
      resolveExplainPreflight({ wiki: "w", unknownWiki: false, entry: noColl, index: null, meta: undefined, page: "P" }),
    ).toBe("No search collection connected for this wiki.");
  });

  test("unloadable index → directory-not-found error", () => {
    expect(
      resolveExplainPreflight({ wiki: "w", unknownWiki: false, entry, index: null, meta: undefined, page: "P" }),
    ).toBe("wiki directory not found");
  });

  test("unknown page → named error (interpolates the page)", () => {
    expect(
      resolveExplainPreflight({ wiki: "w", unknownWiki: false, entry, index, meta: undefined, page: "Nope" }),
    ).toBe('No wiki page named "Nope".');
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
