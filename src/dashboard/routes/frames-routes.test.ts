/**
 * The frames route: `GET /api/frames/:source/:id/:file` plus the pre-seam Vimeo
 * alias, both over ONE root.
 *
 * The alias is the half that cannot be dropped: huginn stores a capture's
 * summary markdown verbatim, so every Vimeo document ingested before the seam
 * quotes `/api/vimeo/frames/<id>/<sec>.jpg` for ever. A reader opening a talk
 * captured last week must see the same bytes the new path serves.
 *
 * No `mock.module` here, so this file shares a `bun test` process.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../config.ts";
import { registerFramesRoutes } from "./frames-routes.ts";
import { registerSummariesRoutes } from "./summaries-routes.ts";

const config = { knowledgeApiUrl: "http://127.0.0.1:1" } as unknown as Config;

const VIDEO = "1223358361";
const YT = "dQw4-9W_gXQ";

function tmp(prefix = "frames-route-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A root with one kept Vimeo frame and one kept YouTube frame. */
function rootWithFrames(): string {
  const root = tmp();
  mkdirSync(join(root, "vimeo", VIDEO), { recursive: true });
  writeFileSync(join(root, "vimeo", VIDEO, "1390.jpg"), "VIMEOBYTES");
  mkdirSync(join(root, "youtube", YT), { recursive: true });
  writeFileSync(join(root, "youtube", YT, "47.jpg"), "YOUTUBEBYTES");
  return root;
}

function appWith(root: string): Hono {
  const app = new Hono();
  registerFramesRoutes(app, config, { framesRoot: root });
  return app;
}

describe("GET /api/frames/:source/:id/:file", () => {
  test("serves a kept frame as image/jpeg with a day of PRIVATE caching, per source", async () => {
    const app = appWith(rootWithFrames());

    const ok = await app.request(`/api/frames/vimeo/${VIDEO}/1390.jpg`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/jpeg");
    // PRIVATE: the route sits in the default-deny (admin) zone under MUNINN_AUTH,
    // and a shared cache must not serve a slide past a 403.
    expect(ok.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(await ok.text()).toBe("VIMEOBYTES");

    const yt = await app.request(`/api/frames/youtube/${YT}/47.jpg`);
    expect(yt.status).toBe(200);
    expect(await yt.text()).toBe("YOUTUBEBYTES");
  });

  test("the SOURCE segment is default-deny, and each source's id charset is its own", async () => {
    const root = rootWithFrames();
    // Plant files under the shapes below, so a 404 means REFUSED and not MISSING.
    mkdirSync(join(root, "tiktok", "123"), { recursive: true });
    writeFileSync(join(root, "tiktok", "123", "1.jpg"), "X");
    mkdirSync(join(root, "vimeo", "abc"), { recursive: true });
    writeFileSync(join(root, "vimeo", "abc", "1390.jpg"), "X");
    mkdirSync(join(root, "youtube", "1223358361"), { recursive: true });
    writeFileSync(join(root, "youtube", "1223358361", "47.jpg"), "X");
    writeFileSync(join(root, "vimeo", VIDEO, "frame.jpg"), "X");
    const app = appWith(root);

    for (const path of [
      "/api/frames/tiktok/123/1.jpg", // not a frames source
      "/api/frames/vimeo/abc/1390.jpg", // vimeo ids are digits
      "/api/frames/youtube/1223358361/47.jpg", // youtube ids are 11 chars
      `/api/frames/vimeo/${VIDEO}/frame.jpg`, // the file name IS the second
      `/api/frames/vimeo/${VIDEO}/1391.jpg`, // not kept
      `/api/frames/vimeo/${VIDEO}/1390.png`,
      `/api/frames/vimeo/${VIDEO}/..%2F1390.jpg`,
      `/api/frames/vimeo/${VIDEO}/1390.jpg%00`,
    ]) {
      const res = await app.request(path);
      expect(res.status).toBe(404); // never a 400, which would confirm the shape
    }
  });

  test("a SYMLINK under the root pointing outside it is refused — containment is judged on the real path", async () => {
    const root = tmp();
    const outside = tmp("frames-outside-");
    mkdirSync(join(root, "vimeo"), { recursive: true });
    writeFileSync(join(outside, "9.jpg"), "OUTSIDE");
    writeFileSync(join(outside, "secret.txt"), "SECRET");
    symlinkSync(outside, join(root, "vimeo", "7"));
    mkdirSync(join(root, "vimeo", "1"));
    symlinkSync(join(outside, "secret.txt"), join(root, "vimeo", "1", "2.jpg"));
    writeFileSync(join(root, "vimeo", "1", "1.jpg"), "INSIDE");
    const app = appWith(root);
    expect((await app.request("/api/frames/vimeo/7/9.jpg")).status).toBe(404);
    expect((await app.request("/api/frames/vimeo/1/2.jpg")).status).toBe(404);
    expect((await app.request("/api/frames/vimeo/1/1.jpg")).status).toBe(200);
  });

  test("is read-only: no POST, PUT or DELETE is registered on either path", async () => {
    const app = appWith(rootWithFrames());
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect((await app.request(`/api/frames/vimeo/${VIDEO}/1390.jpg`, { method })).status).toBe(404);
      expect((await app.request(`/api/vimeo/frames/${VIDEO}/1390.jpg`, { method })).status).toBe(404);
    }
  });
});

describe("the pre-seam Vimeo alias", () => {
  test("the alias and the new path answer the SAME BYTES and the same headers", async () => {
    const app = appWith(rootWithFrames());
    const fresh = await app.request(`/api/frames/vimeo/${VIDEO}/1390.jpg`);
    const legacy = await app.request(`/api/vimeo/frames/${VIDEO}/1390.jpg`);
    expect(legacy.status).toBe(fresh.status);
    expect(legacy.status).toBe(200);
    const [a, b] = await Promise.all([fresh.bytes(), legacy.bytes()]);
    expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
    expect(new TextDecoder().decode(b)).toBe("VIMEOBYTES");
    expect(legacy.headers.get("content-type")).toBe(fresh.headers.get("content-type"));
    expect(legacy.headers.get("cache-control")).toBe(fresh.headers.get("cache-control"));
  });

  test("the alias is VIMEO's alone: it reads <root>/vimeo, never another source's dir", async () => {
    const root = rootWithFrames();
    const app = appWith(root);
    // A youtube id is not digits, and the alias resolves the source itself.
    expect((await app.request(`/api/vimeo/frames/${YT}/47.jpg`)).status).toBe(404);
    expect(existsSync(join(root, "youtube", YT, "47.jpg"))).toBe(true);
  });
});

describe("registration", () => {
  test("registerSummariesRoutes wires the frames routes — deleting the call is otherwise invisible", () => {
    // Inspected, never requested: this app has no temp root, so a request here
    // would read the developer's real home.
    const app = new Hono();
    registerSummariesRoutes(app, config);
    const paths = new Set(app.routes.map((r) => `${r.method} ${r.path}`));
    expect(paths.has("GET /api/frames/:source/:id/:file")).toBe(true);
    expect(paths.has("GET /api/vimeo/frames/:videoId/:file")).toBe(true);
  });
});
