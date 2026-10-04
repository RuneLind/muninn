import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type { Config } from "../../config.ts";
import { registerWikiReadRoutes } from "./wiki-routes.ts";
import { __resetWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import { __setReadonlyWikiRootsForTest, __setWikiReadonlyForTest } from "../../wiki/readonly.ts";

/**
 * The wiki READ slice's own rules, at the route level:
 *
 *  - under the slice (`nais`) only a wiki whose root is read-only is served —
 *    a writable registered wiki is unknown to every read route and absent from
 *    the `/wiki` picker; `default` serves both (the control);
 *  - under the slice an HTTP `?refresh=1` is honoured at most once per root per
 *    `WIKI_HTTP_REFRESH_MIN_INTERVAL_MS`; `default` honours every one.
 *
 * The provenance context is injected with the ledger unconfigured and no huginn,
 * so no assertion depends on what listens on this machine.
 */
describe("wiki read slice — routes", () => {
  let ro: string;
  let rw: string;
  let prevExtra: string | undefined;
  let prevDir: string | undefined;
  const PAGE = "---\ntype: concept\n---\n# Widgets\n\nThe device ships 4M units.\n";

  const provenanceCtx = {
    sessionLedger: {
      urlConfigured: false,
      baseUrl: "http://127.0.0.1:1",
      fetchSessions: async () => { throw new Error("no ledger"); },
      fetchMerges: async () => { throw new Error("no ledger"); },
    },
    knowledgeApiUrl: "http://127.0.0.1:1",
    publicUrl: null,
  } as unknown as Parameters<typeof registerWikiReadRoutes>[2];

  function appFor(profile: "default" | "nais"): Hono {
    const app = new Hono();
    app.onError((err, c) => c.json({ error: String(err) }, 500));
    registerWikiReadRoutes(app, { profile, dashboardPort: 3010 } as Config, provenanceCtx);
    return app;
  }

  beforeEach(async () => {
    ro = await mkdtemp(path.join(tmpdir(), "wiki-slice-ro-"));
    rw = await mkdtemp(path.join(tmpdir(), "wiki-slice-rw-"));
    await Bun.write(path.join(ro, "Widgets.md"), PAGE);
    await Bun.write(path.join(rw, "Widgets.md"), PAGE);
    await Bun.write(path.join(ro, "x.html"), "<p>explainer</p>");
    await Bun.write(path.join(rw, "x.html"), "<p>explainer</p>");
    prevExtra = process.env.WIKI_EXTRA;
    prevDir = process.env.WIKI_DIR;
    // The writable wiki FIRST, so a bare request's default would be it if the
    // slice did not filter the registry.
    process.env.WIKI_EXTRA = `rwwiki=${rw},rowiki=${ro}`;
    delete process.env.WIKI_DIR;
    __setWikiReadonlyForTest(false);
    __setReadonlyWikiRootsForTest([ro]);
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
  });

  afterEach(async () => {
    __setReadonlyWikiRootsForTest();
    __setWikiReadonlyForTest();
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    if (prevDir === undefined) delete process.env.WIKI_DIR;
    else process.env.WIKI_DIR = prevDir;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(ro, { recursive: true, force: true });
    await rm(rw, { recursive: true, force: true });
  });

  const reads = (wiki: string) => [
    `/api/wiki/page?wiki=${wiki}&name=Widgets`,
    `/api/wiki/page/provenance?wiki=${wiki}&name=Widgets`,
    `/api/wiki/related?wiki=${wiki}&name=Widgets`,
    `/api/wiki/html?wiki=${wiki}&relPath=x.html`,
    `/api/wiki/graph?wiki=${wiki}&scope=wiki&level=1&depth=0`,
  ];

  test("nais: a writable wiki is unknown to every read route", async () => {
    const app = appFor("nais");
    for (const url of reads("rwwiki")) {
      const res = await app.request(url);
      expect(`${url} → ${res.status}`).toBe(`${url} → 404`);
      expect(await res.text(), url).toContain("no wiki configured for that name");
    }
    const listing = (await (await app.request("/api/wiki/pages?wiki=rwwiki")).json()) as { pages: unknown[]; error?: string };
    expect(listing.pages).toEqual([]);
    expect(listing.error).toBe("no wiki configured for that name");
  });

  test("nais: the read-only wiki is served, and a bare listing defaults to it", async () => {
    const app = appFor("nais");
    expect((await app.request("/api/wiki/page?wiki=rowiki&name=Widgets")).status).toBe(200);
    expect((await app.request("/api/wiki/html?wiki=rowiki&relPath=x.html")).status).toBe(200);
    expect((await app.request("/api/wiki/related?wiki=rowiki&name=Widgets")).status).toBe(200);
    const bare = (await (await app.request("/api/wiki/pages")).json()) as { pages: { relPath: string }[] };
    expect(bare.pages.map((p) => p.relPath).sort()).toEqual(["Widgets.md", "x.html"]);
  });

  test("nais: the /wiki picker lists only the read-only wiki", async () => {
    const html = await (await appFor("nais").request("/wiki")).text();
    expect(html).toContain("rowiki");
    expect(html).not.toContain("rwwiki");
  });

  test("nais: no registered read-only wiki ⇒ nothing is served, not the store's fallback root", async () => {
    __setReadonlyWikiRootsForTest([]);
    const app = appFor("nais");
    const bare = (await (await app.request("/api/wiki/pages")).json()) as { pages: unknown[]; error?: string };
    expect(bare.pages).toEqual([]);
    expect(bare.error).toBe("no wiki configured for that name");
  });

  describe("the WIKI_DIR override under the slice", () => {
    // Only the writable wiki is registered, so the registry offers no default:
    // what a bare request serves is decided by the override alone.
    beforeEach(() => {
      process.env.WIKI_EXTRA = `rwwiki=${rw}`;
      __resetWikiRegistryForTest();
    });

    test("nais: a WRITABLE WIKI_DIR is not served", async () => {
      process.env.WIKI_DIR = rw;
      const bare = (await (await appFor("nais").request("/api/wiki/pages")).json()) as { pages: unknown[]; error?: string };
      expect(bare.pages).toEqual([]);
      expect(bare.error).toBe("no wiki configured for that name");
      expect((await appFor("nais").request("/api/wiki/page?name=Widgets")).status).toBe(404);
    });

    test("nais: a read-only WIKI_DIR is served", async () => {
      process.env.WIKI_DIR = ro;
      const bare = (await (await appFor("nais").request("/api/wiki/pages")).json()) as { pages: { relPath: string }[] };
      expect(bare.pages.map((p) => p.relPath).sort()).toEqual(["Widgets.md", "x.html"]);
      expect((await appFor("nais").request("/api/wiki/page?name=Widgets")).status).toBe(200);
    });
  });

  test("default (control): both wikis are served and listed", async () => {
    const app = appFor("default");
    expect((await app.request("/api/wiki/page?wiki=rwwiki&name=Widgets")).status).toBe(200);
    expect((await app.request("/api/wiki/page?wiki=rowiki&name=Widgets")).status).toBe(200);
    const html = await (await app.request("/wiki")).text();
    expect(html).toContain("rwwiki");
    expect(html).toContain("rowiki");
  });

  const relPaths = async (app: Hono, url: string) =>
    ((await (await app.request(url)).json()) as { pages: { relPath: string }[] }).pages.map((p) => p.relPath);

  test("nais: a second ?refresh=1 inside the interval is answered from the cache", async () => {
    const app = appFor("nais");
    await relPaths(app, "/api/wiki/pages?wiki=rowiki&refresh=1");
    await Bun.write(path.join(ro, "New.md"), "# New\n");
    const second = await relPaths(app, "/api/wiki/pages?wiki=rowiki&refresh=1");
    expect(second).not.toContain("New.md");
  });

  test("default (control): every ?refresh=1 rescans", async () => {
    const app = appFor("default");
    await relPaths(app, "/api/wiki/pages?wiki=rowiki&refresh=1");
    await Bun.write(path.join(ro, "New.md"), "# New\n");
    expect(await relPaths(app, "/api/wiki/pages?wiki=rowiki&refresh=1")).toContain("New.md");
  });
});
