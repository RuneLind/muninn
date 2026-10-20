/**
 * Architecture review 2026-10, finding 32: a bucket mirror whose copy is stale
 * had no surface. The mirror now reports its health, and `/api/wiki/pages`
 * carries it for a mirrored root while it is not `ok`. Driven against a fake
 * GCS on a loopback port and a real `BucketMirror` loop.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type { Config, WikiBucketMirrorConfig } from "../config.ts";
import { BucketMirror, startWikiBucketMirrors, type BucketMirrorDeps } from "./bucket-mirror.ts";
import { registerWikiReadRoutes } from "../dashboard/routes/wiki-routes.ts";
import { __resetWikiRegistryForTest } from "./registry-memo.ts";
import { __resetWikiCacheForTest, getWikiIndex } from "./store.ts";
import { __setReadonlyWikiRootsForTest, __setWikiReadonlyForTest } from "./readonly.ts";

const objects = new Map<string, { generation: number; body: string }>();
let listStatus = 200;
let mediaStatus = new Map<string, number>();
let server: ReturnType<typeof Bun.serve>;
let base: string;
let root: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const m = /^\/storage\/v1\/b\/([^/]+)\/o(?:\/(.+))?$/.exec(url.pathname);
      if (!m || decodeURIComponent(m[1]!) !== "felles") return new Response("no bucket", { status: 404 });
      if (!m[2]) {
        if (listStatus !== 200) return new Response("denied", { status: listStatus });
        return Response.json({
          items: [...objects].map(([name, o]) => ({ name, generation: String(o.generation), size: String(o.body.length) })),
        });
      }
      const name = decodeURIComponent(m[2]);
      const forced = mediaStatus.get(name);
      if (forced) return new Response("nope", { status: forced });
      const o = objects.get(name);
      if (!o || url.searchParams.get("generation") !== String(o.generation)) return new Response("not found", { status: 404 });
      return new Response(o.body);
    },
  });
});
afterAll(() => server.stop(true));

const live: { stop(): Promise<void> }[] = [];
beforeEach(async () => {
  objects.clear();
  listStatus = 200;
  mediaStatus = new Map();
  base = await mkdtemp(path.join(tmpdir(), "bm-status-"));
  root = path.join(base, "felles");
});
afterEach(async () => {
  await Promise.all(live.splice(0).map((m) => m.stop()));
  await rm(base, { recursive: true, force: true });
});

function mirror(extra: Partial<BucketMirrorDeps> = {}): BucketMirror {
  const m = new BucketMirror({ bucket: "felles", prefix: "", root }, {
    gcsBase: `http://127.0.0.1:${server.port}`,
    intervalMs: 40,
    tokens: { acquire: async () => null, invalidate: () => {} },
    registeredWikiRoot: (r) => r,
    isReadonlyRoot: () => true,
    refreshIndex: async () => {},
    ...extra,
  });
  live.push(m);
  return m;
}

async function until(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (pred()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("BucketMirror.status (finding 32)", () => {
  test("starting before the first poll, ok after a clean one with its time", async () => {
    objects.set("a.md", { generation: 1, body: "# A" });
    const m = mirror({ now: () => 1_000_000 });
    expect(m.status()).toEqual({ health: "starting", lastSuccessAt: null, consecutiveFailures: 0, failedObjects: 0 });
    m.start();
    await until(() => m.status().health !== "starting", "first poll");
    expect(m.status()).toEqual({ health: "ok", lastSuccessAt: 1_000_000, consecutiveFailures: 0, failedObjects: 0 });
  });

  test("a resolved poll that failed a download is degraded, not ok, and sets no success time", async () => {
    objects.set("a.md", { generation: 1, body: "# A" });
    objects.set("b.md", { generation: 1, body: "# B" });
    mediaStatus.set("b.md", 403);
    const m = mirror();
    m.start();
    await until(() => m.status().health !== "starting", "first poll");
    expect(m.status()).toEqual({ health: "degraded", lastSuccessAt: null, consecutiveFailures: 0, failedObjects: 1 });
    // The object heals: the next poll brings it in and the mirror is ok again.
    mediaStatus.clear();
    await until(() => m.status().health === "ok", "recovery");
    expect(m.status().lastSuccessAt).toBeNumber();
    expect(m.status().failedObjects).toBe(0);
  });

  test("a failed index rebuild is degraded", async () => {
    objects.set("a.md", { generation: 1, body: "# A" });
    const m = mirror({ refreshIndex: async () => { throw new Error("index down"); } });
    m.start();
    await until(() => m.status().health !== "starting", "first poll");
    expect(m.status().health).toBe("degraded");
    expect(m.status().lastSuccessAt).toBeNull();
  });

  test("a listing that fails after a good poll is failing, and keeps the last success time", async () => {
    objects.set("a.md", { generation: 1, body: "# A" });
    let t = 5_000;
    const m = mirror({ now: () => t });
    m.start();
    await until(() => m.status().health === "ok", "first poll");
    t = 9_000;
    listStatus = 403;
    await until(() => m.status().health === "failing", "a failed listing");
    expect(m.status()).toMatchObject({ health: "failing", lastSuccessAt: 5_000 });
    expect(m.status().consecutiveFailures).toBeGreaterThanOrEqual(1);
  });

  test("a refused mirror says refused", async () => {
    const m = mirror({ isReadonlyRoot: () => false });
    m.start();
    await until(() => m.state === "refused", "the refusal");
    expect(m.status().health).toBe("refused");
  });
});

describe("/api/wiki/pages carries the mirror's health (finding 32)", () => {
  let prevExtra: string | undefined;
  let prevDir: string | undefined;
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

  beforeEach(() => {
    prevExtra = process.env.WIKI_EXTRA;
    prevDir = process.env.WIKI_DIR;
    process.env.WIKI_EXTRA = `felles=${root}`;
    delete process.env.WIKI_DIR;
    __setWikiReadonlyForTest(false);
    __setReadonlyWikiRootsForTest([root]);
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
  });
  afterEach(() => {
    __setReadonlyWikiRootsForTest();
    __setWikiReadonlyForTest();
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    if (prevDir === undefined) delete process.env.WIKI_DIR;
    else process.env.WIKI_DIR = prevDir;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
  });

  function boot() {
    const config: WikiBucketMirrorConfig = {
      mirrors: [{ bucket: "felles", prefix: "", root }],
      refused: [],
      intervalRefused: null,
      intervalMs: 40,
      gcsBase: `http://127.0.0.1:${server.port}`,
      projectNumber: null,
      projectNumberRefused: null,
    };
    const started = startWikiBucketMirrors(config, {
      registeredWikiRoot: (r) => r,
      isReadonlyRoot: () => true,
      refreshIndex: (r) => getWikiIndex({ root: r, refresh: true }),
    });
    live.push(started);
    const app = new Hono();
    app.onError((err, c) => c.json({ error: String(err) }, 500));
    registerWikiReadRoutes(app, { profile: "nais", dashboardPort: 3010 } as Config, provenanceCtx);
    return { m: started.mirrors[0]!, app };
  }

  const listing = async (app: Hono) => (await app.request("/api/wiki/pages?wiki=felles")).json() as Promise<Record<string, unknown>>;
  /** The listing once `done` holds, or the last one after ~1.5 s. Polls the
   *  route rather than `status()`, so a tree without the status reads as a
   *  missing field rather than a crash. */
  async function listingWhen(app: Hono, done: (b: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    let body = await listing(app);
    for (let i = 0; i < 75 && !done(body); i++) {
      await Bun.sleep(20);
      body = await listing(app);
    }
    return body;
  }

  test("degraded: the field is there, with counts only — no object name", async () => {
    objects.set("a.md", { generation: 1, body: "# A" });
    objects.set("secret-name.md", { generation: 1, body: "# S" });
    mediaStatus.set("secret-name.md", 500);
    const { app } = boot();
    const body = await listingWhen(app, (b) => (b.mirror as { health?: string } | undefined)?.health === "degraded");
    expect(body.mirror).toEqual({ health: "degraded", lastSuccessAt: null, consecutiveFailures: 0, failedObjects: 1 });
    expect(JSON.stringify(body.mirror)).not.toContain("secret-name");
  });

  test("healthy: no field, the listing is what it was without a mirror", async () => {
    objects.set("a.md", { generation: 1, body: "# A" });
    const { app } = boot();
    const body = await listingWhen(app, (b) => (b.pages as unknown[]).length === 1 && !("mirror" in b));
    expect("mirror" in body).toBe(false);
    expect((body.pages as unknown[]).length).toBe(1);
  });

  test("a stopped mirror unregisters; an unmirrored root never has the field", async () => {
    // Imported here, so on a tree without the module only this test fails to
    // load it and the route tests above fail on their assertions.
    const status = await import("./bucket-mirror-status.ts");
    expect(status.bucketMirrorPayloadField(root)).toEqual({});
    objects.set("a.md", { generation: 1, body: "# A" });
    const { m } = boot();
    listStatus = 403;
    await until(() => m.status().health === "failing", "a failed listing");
    expect(status.bucketMirrorPayloadField(root).mirror?.health).toBe("failing");
    expect(status.bucketMirrorPayloadField(path.join(base, "other"))).toEqual({});
    await live.splice(0).map((x) => x.stop())[0];
    expect(status.bucketMirrorPayloadField(root)).toEqual({});
  });
});
