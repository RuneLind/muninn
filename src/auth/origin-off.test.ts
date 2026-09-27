import { describe, test, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import type { Config } from "../config.ts";
import { createDashboardRoutes } from "../dashboard/routes.ts";
import { corsAllowOrigin } from "./cors.ts";
import { createOriginMiddleware, decideOrigin, loopbackOrigins } from "./origin.ts";
import { resolveAuthConfig } from "./mode.ts";
import { __setAuthPolicyForTest, setAuthPolicy } from "./policy.ts";

/**
 * `MUNINN_AUTH=off`'s origin guard and CORS echo. The auth-mode rule is pinned
 * in `origin.test.ts` / `cors.test.ts`; this file is the off-mode table plus
 * one pass through the dashboard routes composed the way `src/index.ts` mounts
 * them with auth off (the mount itself is pinned in `wiring.test.ts`).
 */

const PORT = 3010;
const EXTENSION = "chrome-extension://abcdefghijklmnop";
const TAILNET = "https://muninn-host.example-tailnet.ts.net";

afterEach(() => __setAuthPolicyForTest(null));

describe("decideOrigin — the off-mode table", () => {
  const base = {
    method: "POST",
    path: "/api/research/chat",
    allowedOrigins: loopbackOrigins(PORT),
    origin: undefined as string | undefined,
    secFetchSite: undefined as string | undefined,
    mode: "off" as const,
  };
  const allowed = (over: Partial<typeof base>) => decideOrigin({ ...base, ...over }).allowed;

  test("a loopback literal at the configured port is allowed; another port is not", () => {
    expect(allowed({ origin: `http://localhost:${PORT}` })).toBe(true);
    expect(allowed({ origin: `http://127.0.0.1:${PORT}` })).toBe(true);
    expect(allowed({ origin: "http://localhost:5173" })).toBe(false);
  });

  test("any chrome-extension origin is allowed, even with Sec-Fetch-Site cross-site", () => {
    // Unpinned per-install ids: none can be listed.
    expect(allowed({ origin: EXTENSION, secFetchSite: "cross-site" })).toBe(true);
    expect(allowed({ origin: EXTENSION, secFetchSite: "none" })).toBe(true);
    expect(allowed({ origin: "chrome-extension://zzzzzzzzzzzzzzzz" })).toBe(true);
  });

  test("a foreign origin is refused, however Sec-Fetch-Site is absent or cross", () => {
    expect(allowed({ origin: "http://evil.example" })).toBe(false);
    expect(allowed({ origin: "https://evil.example", secFetchSite: "cross-site" })).toBe(false);
    expect(allowed({ origin: "https://evil.example", secFetchSite: "same-site" })).toBe(false);
    expect(allowed({ origin: "https://evil.example", secFetchSite: "none" })).toBe(false);
  });

  test("`Origin: null` is refused", () => {
    expect(allowed({ origin: "null" })).toBe(false);
    expect(allowed({ origin: "null", secFetchSite: "cross-site" })).toBe(false);
  });

  test("an unknown origin with Sec-Fetch-Site same-origin is allowed (tailscale serve)", () => {
    expect(allowed({ origin: TAILNET, secFetchSite: "same-origin" })).toBe(true);
    expect(allowed({ origin: TAILNET })).toBe(false);
  });

  test("an origin on the optional allowlist is allowed", () => {
    expect(allowed({ origin: TAILNET, allowedOrigins: [...loopbackOrigins(PORT), TAILNET] })).toBe(true);
  });

  test("no Origin: the Sec-Fetch-Site rule is the auth-mode one", () => {
    expect(allowed({ secFetchSite: "same-origin" })).toBe(true);
    expect(allowed({ secFetchSite: "none" })).toBe(true);
    expect(allowed({ secFetchSite: "cross-site" })).toBe(false);
    expect(allowed({ secFetchSite: "same-site" })).toBe(false);
    expect(allowed({ path: "/chat/pending/t1", method: "GET", secFetchSite: "cross-site" })).toBe(false);
  });

  test("neither header, OPTIONS and safe GETs are allowed", () => {
    expect(allowed({})).toBe(true);
    expect(allowed({ method: "OPTIONS", origin: "https://evil.example" })).toBe(true);
    expect(allowed({ method: "GET", path: "/api/youtube/options", origin: "https://evil.example" })).toBe(true);
  });

  test("auth mode keeps its stricter rule: neither off arm applies there", () => {
    const auth = { ...base, mode: "authenticating" as const };
    expect(decideOrigin({ ...auth, origin: TAILNET, secFetchSite: "same-origin" }).allowed).toBe(false);
    expect(decideOrigin({ ...auth, origin: EXTENSION, secFetchSite: "none" }).allowed).toBe(false);
    // Omitted mode is the auth rule, so every existing caller is unchanged.
    const { mode: _omit, ...legacy } = auth;
    expect(decideOrigin({ ...legacy, origin: TAILNET, secFetchSite: "same-origin" }).allowed).toBe(false);
  });
});

describe("CORS with auth off — an echo, never `*`", () => {
  const offPolicy = (env: Record<string, string> = {}) =>
    setAuthPolicy(resolveAuthConfig({ MUNINN_AUTH: "off", ...env }), PORT);

  test("an extension origin and a loopback origin are echoed", () => {
    offPolicy();
    expect(corsAllowOrigin(EXTENSION)).toBe(EXTENSION);
    expect(corsAllowOrigin(`http://localhost:${PORT}`)).toBe(`http://localhost:${PORT}`);
  });

  test("a foreign origin, another loopback port, `null` and no Origin get no header", () => {
    offPolicy();
    expect(corsAllowOrigin("https://evil.example")).toBeNull();
    expect(corsAllowOrigin("http://localhost:5173")).toBeNull();
    expect(corsAllowOrigin("null")).toBeNull();
    expect(corsAllowOrigin(undefined)).toBeNull();
  });

  test("the same-origin arm does not reach CORS; the optional allowlist does", () => {
    offPolicy();
    expect(corsAllowOrigin(TAILNET)).toBeNull();
    offPolicy({ MUNINN_ALLOWED_ORIGINS: TAILNET });
    expect(corsAllowOrigin(TAILNET)).toBe(TAILNET);
  });

  test("an empty MUNINN_ALLOWED_ORIGINS does not refuse an off-mode boot", () => {
    expect(resolveAuthConfig({ MUNINN_AUTH: "off" }).allowedOrigins).toEqual([]);
    expect(resolveAuthConfig({ MUNINN_AUTH: "off", MUNINN_ALLOWED_ORIGINS: "*" }).allowedOrigins).toEqual([]);
  });
});

describe("the dashboard with auth off, composed as src/index.ts composes it", () => {
  const CONFIG = { dashboardPort: PORT, profile: "default" } as Config;

  function offApp(): Hono {
    setAuthPolicy(resolveAuthConfig({ MUNINN_AUTH: "off" }), PORT);
    const app = new Hono();
    app.use("*", createOriginMiddleware([], PORT, "off"));
    app.route("/", createDashboardRoutes(CONFIG));
    return app;
  }

  /** `{}` is an INVALID research body: the handler answers 400 before any
   *  thread, bot or model is touched. A 400 therefore proves the handler ran;
   *  the 403 body below is the middleware's and proves it did not. */
  const post = (app: Hono, headers: Record<string, string>) =>
    app.request("/api/research/chat", { method: "POST", headers, body: "{}" });

  async function refused(res: Response) {
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden", reason: "cross-origin request" });
  }
  async function reachedHandler(res: Response) {
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing required field: text" });
  }

  test("a cross-site text/plain POST is refused 403 before the handler", async () => {
    await refused(await post(offApp(), {
      origin: "http://evil.example", "sec-fetch-site": "cross-site", "content-type": "text/plain",
    }));
  });

  test("a cross-site JSON POST is refused 403 before the handler", async () => {
    await refused(await post(offApp(), {
      origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "application/json",
    }));
  });

  test("a cross-site POST to a dashboard write route is refused too", async () => {
    const res = await offApp().request("/api/watchers/x/trigger", {
      method: "POST",
      headers: { origin: "http://evil.example", "sec-fetch-site": "cross-site", "content-type": "text/plain" },
      body: "{}",
    });
    await refused(res);
  });

  test("the extension's POST reaches the handler, with its origin echoed", async () => {
    const res = await post(offApp(), {
      origin: EXTENSION, "sec-fetch-site": "none", "content-type": "application/json",
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(EXTENSION);
    await reachedHandler(res);
  });

  test("a loopback page's POST and a header-less script's POST reach the handler", async () => {
    await reachedHandler(await post(offApp(), {
      origin: `http://localhost:${PORT}`, "sec-fetch-site": "same-origin", "content-type": "application/json",
    }));
    await reachedHandler(await post(offApp(), { "content-type": "application/json" }));
  });

  test("the preflight names the extension and not a foreign page", async () => {
    const preflight = (origin: string) => offApp().request("/api/research/chat", {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    const ext = await preflight(EXTENSION);
    expect(ext.status).toBe(204);
    expect(ext.headers.get("access-control-allow-origin")).toBe(EXTENSION);
    const evil = await preflight("https://evil.example");
    expect(evil.status).toBe(204);
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    expect(evil.headers.get("vary")).toBe("Origin");
  });
});
