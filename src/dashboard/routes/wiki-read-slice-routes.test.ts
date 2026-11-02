import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type { Config } from "../../config.ts";
import { registerWikiReadRoutes } from "./wiki-routes.ts";
import { __resetWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest, __setWikiIndexAnswerConfigForTest } from "../../wiki/store.ts";
import { __setReadonlyWikiRootsForTest, __setWikiReadonlyForTest } from "../../wiki/readonly.ts";
import { testTempDir } from "../../test/temp-dir.ts";

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
    ro = await testTempDir(path.join(tmpdir(), "wiki-slice-ro-"));
    rw = await testTempDir(path.join(tmpdir(), "wiki-slice-rw-"));
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
    `/api/wiki/decision-chain?wiki=${wiki}&name=Widgets`,
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

  describe("what waits on the owner", () => {
    const answers = { wikis: new Set(["rowiki"]), owner: "Kari (A123456)", groups: new Map([["utvikler", new Set(["A123456"])]]) };
    const WAITS = '---\ntitle: Waits\n---\n\n<NextMoves>\n\n<Lane kind="waiting" since="2026-09-30">\n\n- O1\n\n</Lane>\n\n</NextMoves>\n\n<Question id="O1" to="utvikler">\n\nWhich?\n\n</Question>\n';

    const appWithAnswers = (profile: "default" | "nais") => {
      const app = new Hono();
      registerWikiReadRoutes(app, { profile, dashboardPort: 3010, wikiAnswers: answers } as unknown as Config, provenanceCtx);
      return app;
    };

    beforeEach(async () => {
      await Bun.write(path.join(ro, "Waits.md"), WAITS);
      await Bun.write(path.join(ro, "Linker.md"), "---\ntitle: Linker\n---\n\nSee [[Waits]].\n");
      __setWikiIndexAnswerConfigForTest(answers);
      __resetWikiCacheForTest();
    });
    afterEach(() => __setWikiIndexAnswerConfigForTest(null));

    // Comparing a page's `q-for` line with a count says which group the owner is
    // in, and the slice serves no work map to read one.
    test("nais: no response carries it, on any row shape", async () => {
      const app = appWithAnswers("nais");
      for (const url of [
        "/api/wiki/pages?wiki=rowiki",
        "/api/wiki/page?wiki=rowiki&name=Waits",
        "/api/wiki/page?wiki=rowiki&name=Linker",
        "/api/wiki/related?wiki=rowiki&name=Linker",
      ]) {
        const res = await app.request(url);
        const text = await res.text();
        expect(`${url} → ${res.status}`).toBe(`${url} → 200`);
        expect(text, url).toContain("Waits");
        for (const field of ["movesWaiting", "waitingSince", "waitsCounted"]) expect(text.includes(field), `${url} ${field}`).toBe(false);
      }
    });

    test("default: the listing carries it for the card, and no other row does", async () => {
      const app = appWithAnswers("default");
      const listing = (await (await app.request("/api/wiki/pages?wiki=rowiki")).json()) as {
        waitsCounted: boolean;
        pages: { relPath: string; movesWaiting?: number; waitingSince?: string }[];
      };
      expect(listing.waitsCounted).toBe(true);
      const row = listing.pages.find((p) => p.relPath === "Waits.md")!;
      expect(row.movesWaiting).toBe(1);
      expect(row.waitingSince).toBe("2026-09-30");
      for (const url of ["/api/wiki/page?wiki=rowiki&name=Waits", "/api/wiki/page?wiki=rowiki&name=Linker"]) {
        const text = await (await app.request(url)).text();
        expect(text.includes("movesWaiting"), url).toBe(false);
      }
    });
  });

  test("nais: the read-only wiki is served, and a bare listing defaults to it", async () => {
    const app = appFor("nais");
    expect((await app.request("/api/wiki/page?wiki=rowiki&name=Widgets")).status).toBe(200);
    expect((await app.request("/api/wiki/html?wiki=rowiki&relPath=x.html")).status).toBe(200);
    expect((await app.request("/api/wiki/related?wiki=rowiki&name=Widgets")).status).toBe(200);
    expect((await app.request("/api/wiki/decision-chain?wiki=rowiki&name=Widgets")).status).toBe(200);
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

  // The page inlines the whole client bundle (~1 MB); nothing else in the
  // serving chain compresses it, the nais pod's ingress included.
  describe("GET /wiki is gzipped for a client that accepts it", () => {
    for (const profile of ["default", "nais"] as const) {
      test(`${profile}: gzip on Accept-Encoding, identity without it, same bytes either way`, async () => {
        const app = appFor(profile);
        const plain = await app.request("/wiki?wiki=rowiki");
        expect(plain.headers.get("content-encoding")).toBeNull();
        const html = await plain.text();
        expect(html).toContain("rowiki");

        const zipped = await app.request("/wiki?wiki=rowiki", { headers: { "accept-encoding": "gzip, deflate, br" } });
        expect(zipped.status).toBe(200);
        expect(zipped.headers.get("content-encoding")).toBe("gzip");
        expect(zipped.headers.get("vary")).toContain("Accept-Encoding");
        expect(zipped.headers.get("content-type")).toContain("text/html");
        const raw = new Uint8Array(await zipped.arrayBuffer());
        expect(raw.byteLength).toBeLessThan(html.length / 2);
        expect(new TextDecoder().decode(Bun.gunzipSync(raw))).toBe(html);
      });
    }

    test("a JSON route beside it is not compressed", async () => {
      const res = await appFor("default").request("/api/wiki/pages?wiki=rowiki", {
        headers: { "accept-encoding": "gzip" },
      });
      expect(res.headers.get("content-encoding")).toBeNull();
      expect(((await res.json()) as { pages: unknown[] }).pages.length).toBe(2);
    });
  });
});
