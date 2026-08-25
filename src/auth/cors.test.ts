import { describe, test, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import { applyCors, corsAllowOrigin, corsHeaders } from "./cors.ts";
import { __setAuthPolicyForTest, isAuthenticatingInstance, pinnedLocalUserId, policyAllowedOrigins, sharedMemoryReadsAllowed, setAuthPolicy } from "./policy.ts";
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

  test("the pinned identity is published for the bot_default_user fallback", () => {
    // PR C hides the chat page's user dropdown, which was `bot_default_user`'s
    // ONLY writer. `getBotDefaultUser` falls back to this so six readers keep
    // working without the authenticated client touching an admin-zone route.
    __setAuthPolicyForTest(null);
    expect(pinnedLocalUserId()).toBeNull();
    setAuthPolicy(resolveAuthConfig({
      MUNINN_AUTH: "local",
      MUNINN_LOCAL_TOKEN: "a-sufficiently-long-secret",
      MUNINN_LOCAL_USER: "rune",
      MUNINN_ADMIN_IDENTS: "A123456",
      MUNINN_ALLOWED_ORIGINS: "https://host.example",
    }));
    expect(pinnedLocalUserId()).toBe("rune");
    setAuthPolicy(resolveAuthConfig({ MUNINN_AUTH: "off" }));
    expect(pinnedLocalUserId(), "auth off must keep the stored value's absence meaningful").toBeNull();
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
    // ...but it STILL declares that it varies. The response is origin-dependent
    // in both directions; declaring it only on the permissive branch lets a
    // shared cache store this header-less variant and replay it to the
    // allowlisted extension, silently breaking it.
    expect(res.headers.get("vary")).toBe("Origin");
  });

  test("authenticating: the preflight declares Vary on the refusal branch too", async () => {
    __setAuthPolicyForTest({ authenticating: true, allowedOrigins: [EXTENSION] });
    const res = await probe().request("/o", { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("vary")).toBe("Origin");
  });

  test("authenticating: a request with no Origin gets no header", async () => {
    __setAuthPolicyForTest({ authenticating: true, allowedOrigins: [EXTENSION] });
    const res = await probe().request("/h");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("vary")).toBe("Origin");
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
