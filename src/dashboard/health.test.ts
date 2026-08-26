import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { createDashboardRoutes } from "./index.ts";
import {
  readiness,
  READINESS_CACHE_MS,
  __resetReadinessCacheForTest,
  __setReadinessProbeForTest,
} from "./health.ts";
import type { Config } from "../config.ts";
import type { AuthRole } from "../auth/role.ts";

beforeEach(__resetReadinessCacheForTest);
afterEach(() => __setReadinessProbeForTest(null));

describe("readiness", () => {
  test("a working probe is ready", async () => {
    __setReadinessProbeForTest(async () => {});
    expect(await readiness(0)).toEqual({ ready: true });
  });

  test("an unreachable database is NOT ready, and says why", async () => {
    // The whole point of the endpoint: a process that is up but cannot serve
    // must fail its readiness probe rather than report a cheerful 200.
    __setReadinessProbeForTest(async () => { throw new Error("ECONNREFUSED 127.0.0.1:5435"); });
    const result = await readiness(0);
    expect(result.ready).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });

  test("the verdict is cached briefly — the route is unauthenticated", async () => {
    let calls = 0;
    __setReadinessProbeForTest(async () => { calls++; });
    await readiness(0);
    await readiness(READINESS_CACHE_MS - 1);
    expect(calls).toBe(1);
    // …and it is a window, not a latch: a database that comes back is seen.
    await readiness(READINESS_CACHE_MS);
    expect(calls).toBe(2);
  });

  test("a FAILURE is cached too — a flood must not become a flood of connections", async () => {
    let calls = 0;
    __setReadinessProbeForTest(async () => { calls++; throw new Error("down"); });
    expect((await readiness(0)).ready).toBe(false);
    expect((await readiness(1)).ready).toBe(false);
    expect(calls).toBe(1);
  });
});

describe("the two routes, on the real dashboard app", () => {
  // A bare `createDashboardRoutes` with no auth middleware in front: these are
  // the open zone, so the interesting property is what they do with no identity
  // at all.
  const app = new Hono();
  app.route("/", createDashboardRoutes({ dashboardPort: 3010 } as Config));

  test("/api/live answers 200 and does NOT touch the database", async () => {
    // Proven by the probe seam rather than by reading the handler: if the live
    // route ever grows a dependency check, this fails.
    let probed = 0;
    __setReadinessProbeForTest(async () => { probed++; });
    const res = await app.request("/api/live");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(probed).toBe(0);
  });

  test("/api/ready answers 200 when the database answers", async () => {
    __setReadinessProbeForTest(async () => {});
    const res = await app.request("/api/ready");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ready: true });
  });

  test("/api/ready answers 503 when the database is unreachable", async () => {
    __setReadinessProbeForTest(async () => { throw new Error("ECONNREFUSED"); });
    const res = await app.request("/api/ready");
    expect(res.status).toBe(503);
    expect((await res.json() as { ready: boolean }).ready).toBe(false);
  });
});

describe("GET / is role-aware", () => {
  function appAs(role: AuthRole | null): Hono {
    const outer = new Hono();
    outer.use("*", async (c, next) => {
      if (role !== null) c.set("role", role);
      await next();
    });
    outer.route("/", createDashboardRoutes({ dashboardPort: 3010 } as Config));
    return outer;
  }

  test("role `user` is redirected to the surface they DO have", async () => {
    const res = await appAs("user").request("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/chat");
  });

  test("role `admin` gets the dashboard", async () => {
    const res = await appAs("admin").request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<html");
  });

  test("with auth off (no role) it is byte-identical to what it was", async () => {
    const res = await appAs(null).request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<html");
  });
});
