import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { createOriginMiddleware, type OriginPolicyMode } from "./origin.ts";

/**
 * `?refresh=1` turns four read GETs into a forced rebuild: a full wiki index
 * build with its git reads (`/api/wiki/pages`, `/api/wiki/index-coverage`), or
 * an uncached recompute over every summary collection (`/api/wiki/ingest-backlog`,
 * `/api/summaries/stats`). The plain GETs are the reader's own reads and stay
 * open to any origin; only the refresh variant is refused cross-site. Driven
 * through the real middleware in both modes, with handlers that count calls.
 */

const PORT = 3010;
const REFRESH_PATHS = ["/api/wiki/pages", "/api/wiki/index-coverage", "/api/wiki/ingest-backlog", "/api/summaries/stats"];

function appFor(mode: OriginPolicyMode) {
  const calls: Record<string, number> = {};
  const app = new Hono();
  app.use("*", createOriginMiddleware(["https://muninn.example"], PORT, mode));
  for (const path of [...REFRESH_PATHS, "/api/wiki/page"]) {
    app.get(path, (c) => {
      calls[path] = (calls[path] ?? 0) + 1;
      return c.json({ ok: true });
    });
  }
  return { app, calls };
}

const CROSS = { "sec-fetch-site": "cross-site" };

for (const mode of ["off", "authenticating"] as const) {
  describe(`the refresh variant through the real middleware (${mode})`, () => {
    for (const path of REFRESH_PATHS) {
      test(`${path}: a cross-site ?refresh=1 is refused before the handler`, async () => {
        const { app, calls } = appFor(mode);
        for (const target of [`${path}?refresh=1`, `${path}?wiki=mimir&refresh=1`, `${path}?refresh=0&refresh=1`, `${path}?refresh=1&refresh=0`]) {
          const res = await app.request(target, { headers: CROSS });
          expect({ target, status: res.status }).toEqual({ target, status: 403 });
        }
        const head = await app.request(`${path}?refresh=1`, { method: "HEAD", headers: CROSS });
        expect(head.status).toBe(403);
        expect(calls[path] ?? 0).toBe(0);
      });

      test(`${path}: the plain read stays open cross-site`, async () => {
        const { app, calls } = appFor(mode);
        for (const target of [path, `${path}?wiki=mimir`, `${path}?refresh=0`, `${path}?refresh=`]) {
          const res = await app.request(target, { headers: CROSS });
          expect({ target, status: res.status }).toEqual({ target, status: 200 });
        }
        expect(calls[path]).toBe(4);
      });

      test(`${path}: the page's own same-origin refresh and a header-less script still pass`, async () => {
        const { app, calls } = appFor(mode);
        expect((await app.request(`${path}?refresh=1`, { headers: { "sec-fetch-site": "same-origin" } })).status).toBe(200);
        expect((await app.request(`${path}?refresh=1`)).status).toBe(200);
        expect(calls[path]).toBe(2);
      });
    }

    // The routes read `c.req.query("refresh")`, which is Hono's FIRST value, so
    // `?refresh=1&refresh=0` is a rebuild: a gate reading the last value would let it through.
    test("a repeated refresh: the route reads the first value, and the gate refuses either order", async () => {
      const app = new Hono();
      app.use("*", createOriginMiddleware(["https://muninn.example"], PORT, mode));
      const seen: (string | undefined)[] = [];
      app.get("/api/wiki/pages", (c) => {
        seen.push(c.req.query("refresh"));
        return c.json({ ok: true });
      });
      const same = { "sec-fetch-site": "same-origin" };
      expect((await app.request("/api/wiki/pages?refresh=1&refresh=0", { headers: same })).status).toBe(200);
      expect((await app.request("/api/wiki/pages?refresh=0&refresh=1", { headers: same })).status).toBe(200);
      expect(seen).toEqual(["1", "0"]);
      expect((await app.request("/api/wiki/pages?refresh=1&refresh=0", { headers: CROSS })).status).toBe(403);
      expect(seen).toHaveLength(2);
    });

    test("/api/wiki/page never rebuilds on ?refresh=1, so it is not refused", async () => {
      const { app, calls } = appFor(mode);
      expect((await app.request("/api/wiki/page?relPath=a.md&refresh=1", { headers: CROSS })).status).toBe(200);
      expect(calls["/api/wiki/page"]).toBe(1);
    });
  });
}
