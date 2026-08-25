import { describe, test, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import { applyCors, corsAllowOrigin, corsHeaders } from "./cors.ts";
import { __setAuthPolicyForTest, isAuthenticatingInstance, policyAllowedOrigins, sharedMemoryReadsAllowed, setAuthPolicy } from "./policy.ts";
import { resolveAuthConfig } from "./mode.ts";

const EXTENSION = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

afterEach(() => __setAuthPolicyForTest(null));

function probe() {
  const app = new Hono();
  app.get("/h", (c) => { applyCors(c); return c.json({ ok: true }); });
  app.options("/o", (c) => new Response(null, { status: 204, headers: corsHeaders(c, { "Access-Control-Allow-Methods": "POST" }) }));
  return app;
}

describe("the policy seam", () => {
  test("the DEFAULT is off — a standalone createDashboardRoutes in a unit test", () => {
    __setAuthPolicyForTest(null);
    expect(isAuthenticatingInstance()).toBe(false);
    expect(policyAllowedOrigins()).toEqual([]);
    expect(sharedMemoryReadsAllowed()).toBe(true);
  });

  test("setAuthPolicy publishes the resolved mode and the allowlist", () => {
    setAuthPolicy(resolveAuthConfig({
      MUNINN_AUTH: "local",
      MUNINN_LOCAL_TOKEN: "a-sufficiently-long-secret",
      MUNINN_LOCAL_USER: "rune",
      MUNINN_ADMIN_IDENTS: "A123456",
      MUNINN_ALLOWED_ORIGINS: `https://host.example,${EXTENSION}`,
    }));
    expect(isAuthenticatingInstance()).toBe(true);
    expect(policyAllowedOrigins()).toEqual(["https://host.example", EXTENSION]);
    // The narrowing acceptance 11 is about, expressed at the seam.
    expect(sharedMemoryReadsAllowed()).toBe(false);
  });

  test("setAuthPolicy(off) leaves the wildcard and the shared branch alone", () => {
    setAuthPolicy(resolveAuthConfig({ MUNINN_AUTH: "off" }));
    expect(isAuthenticatingInstance()).toBe(false);
    expect(sharedMemoryReadsAllowed()).toBe(true);
  });
});

describe("the CORS disposition", () => {
  test("auth off: the header stays `*`, byte for byte", async () => {
    __setAuthPolicyForTest(null);
    const res = await probe().request("/h", { headers: { origin: EXTENSION } });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    // No Vary either — nothing varies when the answer is constant.
    expect(res.headers.get("vary")).toBeNull();
    expect(corsAllowOrigin(undefined)).toBe("*");
  });

  test("authenticating: an allowlisted origin is ECHOED, with Vary: Origin", async () => {
    __setAuthPolicyForTest({ authenticating: true, allowedOrigins: [EXTENSION] });
    const res = await probe().request("/h", { headers: { origin: EXTENSION } });
    expect(res.headers.get("access-control-allow-origin")).toBe(EXTENSION);
    expect(res.headers.get("vary")).toBe("Origin");
  });

  test("authenticating: an unlisted origin gets NO header at all — never `*`", async () => {
    __setAuthPolicyForTest({ authenticating: true, allowedOrigins: [EXTENSION] });
    const res = await probe().request("/h", { headers: { origin: "https://evil.example" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("authenticating: a request with no Origin gets no header", async () => {
    __setAuthPolicyForTest({ authenticating: true, allowedOrigins: [EXTENSION] });
    expect((await probe().request("/h")).headers.get("access-control-allow-origin")).toBeNull();
  });

  test("the preflight form carries the same disposition and keeps its other headers", async () => {
    __setAuthPolicyForTest({ authenticating: true, allowedOrigins: [EXTENSION] });
    const allowed = await probe().request("/o", { method: "OPTIONS", headers: { origin: EXTENSION } });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(EXTENSION);
    expect(allowed.headers.get("access-control-allow-methods")).toBe("POST");

    const refused = await probe().request("/o", { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    expect(refused.status).toBe(204);
    expect(refused.headers.get("access-control-allow-origin")).toBeNull();
    // The methods header survives: a preflight that answers no ACAO already
    // fails in the browser, and stripping the rest would change what the
    // Chrome extensions see on an `off`-mode instance if this ever regressed.
    expect(refused.headers.get("access-control-allow-methods")).toBe("POST");
  });

  test("an origin that is not parseable is not honoured", () => {
    __setAuthPolicyForTest({ authenticating: true, allowedOrigins: [EXTENSION] });
    expect(corsAllowOrigin("not-an-origin")).toBeNull();
    expect(corsAllowOrigin("")).toBeNull();
  });
});
