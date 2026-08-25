import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { Hono } from "hono";
import {
  createAuthMiddleware,
  isDirectLoopback,
  LOGIN_TOKEN_PLACEHOLDER,
  TOKEN_HEADER,
  TOKEN_QUERY_PARAM,
  __setLoopbackBypassForTest,
} from "./middleware.ts";
import { createIntrospector } from "./introspect.ts";
import { resolveAuthConfig } from "./mode.ts";
import { mintSession, SESSION_COOKIE } from "./session.ts";

const SECRET = "a-sufficiently-long-secret";
const CONFIG = resolveAuthConfig({
  MUNINN_AUTH: "local",
  MUNINN_LOCAL_TOKEN: SECRET,
  MUNINN_LOCAL_USER: "rune",
  MUNINN_ADMIN_IDENTS: "A123456",
  MUNINN_ALLOWED_ORIGINS: "https://muninn-host.example-tailnet.ts.net",
});

/**
 * A REAL Bun.serve, not a synthetic Request. The whole loopback bypass rests on
 * `server.requestIP` reaching the middleware through Hono's env argument, which
 * a hand-built `app.request()` cannot exercise at all — and getting that wiring
 * wrong fails silently, in the fail-CLOSED direction, as a lockout.
 */
const app = new Hono();
app.use("*", createAuthMiddleware(CONFIG));
// `?.` because `ContextVariableMap` types these as OPTIONAL — with auth off no
// middleware is mounted and they are genuinely absent. That the compiler forces
// the `?.` here is the point of the optional declaration.
app.get("/who", (c) => c.json({ userId: c.get("identity")?.userId, role: c.get("role") }));
app.post("/who", (c) => c.json({ userId: c.get("identity")?.userId }));

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (req, srv) => app.fetch(req, srv),
});
const PORT = Number(server.port);
const BASE = `http://127.0.0.1:${PORT}`;
afterAll(() => {
  server.stop(true);
  // Restore the module-global: `beforeEach` only resets it for THIS file, so a
  // `false` left standing would follow the module into the rest of the `bun
  // test` chunk — the same cross-file leakage class the repo's mock.module rule
  // exists for.
  __setLoopbackBypassForTest(null);
});


/**
 * A raw HTTP request, because `fetch` NORMALISES the request target: it collapses
 * `//evil.example/x` to `/evil.example/x` before the bytes leave, so the
 * open-redirect case below is unreachable through it and a test written with
 * `fetch` passes against the vulnerable code. `curl` does not normalise, and
 * neither does an attacker. Returns the raw response text.
 */
function rawRequest(target: string, headers: Record<string, string> = {}, method = "GET"): Promise<string> {
  const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n");
  return new Promise((resolve) => {
    let buf = "";
    Bun.connect({
      hostname: "127.0.0.1",
      port: PORT,
      socket: {
        open(sock) {
          sock.write(`${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\n${lines}${lines ? "\r\n" : ""}Connection: close\r\n\r\n`);
        },
        data(_s, d) { buf += new TextDecoder().decode(d); },
        close() { resolve(buf); },
      },
    });
  });
}

beforeEach(() => __setLoopbackBypassForTest(null));

/**
 * The header set a `tailscale serve` proxy actually stamps, measured 2026-08-25
 * against a live serve publishing `127.0.0.1:3010` to a tailnet (the values
 * below are anonymised; the header NAMES are what was observed). Reproduced
 * verbatim because the peer address of such a request is `127.0.0.1` — these
 * headers are the ONLY thing separating a tailnet device from the operator's
 * own shell.
 */
const TAILSCALE_SERVE_HEADERS = {
  "x-forwarded-for": "100.64.0.1",
  "x-forwarded-host": "muninn-host.example-tailnet.ts.net:8443",
  "x-forwarded-proto": "https",
  "tailscale-headers-info": "https://tailscale.com/s/serve-headers",
  "tailscale-user-login": "someone@example.com",
  "tailscale-user-name": "Example Operator",
};

describe("the loopback bypass — §8's escape hatch", () => {
  test("a direct loopback request is granted with no credential at all", async () => {
    const res = await fetch(`${BASE}/who`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "rune", role: "user" });
  });

  test("the bypass resolves to role user, not admin", async () => {
    // If it were admin, requireOwnUser's passthrough (PRs C-D) would make every
    // claimed-id guard a no-op for exactly the loopback tests meant to prove it.
    expect((await (await fetch(`${BASE}/who`)).json()).role).toBe("user");
  });

  // THE trap. A naive peer-address-only loopback check hands the bypass to
  // every device on the tailnet — the precise exposure this campaign closes.
  test("a request carrying tailscale-serve's proxy headers is NOT bypassed", async () => {
    const res = await fetch(`${BASE}/who`, { headers: TAILSCALE_SERVE_HEADERS });
    expect(res.status).toBe(401);
  });

  test("each proxy header alone is enough to remove the bypass", async () => {
    for (const header of Object.keys(TAILSCALE_SERVE_HEADERS)) {
      const res = await fetch(`${BASE}/who`, { headers: { [header]: "x" } });
      expect({ header, status: res.status }).toEqual({ header, status: 401 });
    }
  });

  test("a proxied request still authenticates normally with a credential", async () => {
    // The direction that makes this safe: a header can only REMOVE the bypass,
    // so forging one is not an attack, it is a request that must log in.
    const res = await fetch(`${BASE}/who`, {
      headers: { ...TAILSCALE_SERVE_HEADERS, [TOKEN_HEADER]: SECRET },
    });
    expect(res.status).toBe(200);
  });

  test("isDirectLoopback covers the v4 /8 and the v6 spellings", () => {
    const none = new Headers();
    for (const address of ["127.0.0.1", "127.1.2.3", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"]) {
      expect({ address, ok: isDirectLoopback(address, none) }).toEqual({ address, ok: true });
    }
    for (const address of ["100.64.0.1", "10.0.0.1", "0.0.0.0", "::ffff:100.64.0.1", undefined]) {
      expect({ address, ok: isDirectLoopback(address, none) }).toEqual({ address, ok: false });
    }
  });
});

describe("acceptance 7 — the 401 shape", () => {
  test("an unauthenticated request gets JSON carrying loginUrl, scriptable without a browser", async () => {
    __setLoopbackBypassForTest(false);
    const res = await fetch(`${BASE}/who`);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      error: "unauthenticated",
      mode: "local",
      loginUrl: `/?${TOKEN_QUERY_PARAM}=${LOGIN_TOKEN_PLACEHOLDER}`,
    });
  });

  test("the 401 body never contains the shared secret", async () => {
    __setLoopbackBypassForTest(false);
    expect(await (await fetch(`${BASE}/who`)).text()).not.toContain(SECRET);
  });

  test("a wrong credential is a 401, not a 500", async () => {
    __setLoopbackBypassForTest(false);
    const res = await fetch(`${BASE}/who`, { headers: { [TOKEN_HEADER]: "wrong-but-long-enough" } });
    expect(res.status).toBe(401);
  });
});

describe("presenting the secret, and the cookie it buys", () => {
  beforeEach(() => __setLoopbackBypassForTest(false));

  test("the header form authenticates and mints a session cookie", async () => {
    const res = await fetch(`${BASE}/who`, { headers: { [TOKEN_HEADER]: SECRET } });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    // Plain http: no Secure attribute, or the cookie would never be stored.
    expect(cookie).not.toContain("Secure");
  });

  test("the Authorization: Bearer form works too", async () => {
    const res = await fetch(`${BASE}/who`, { headers: { authorization: `Bearer ${SECRET}` } });
    expect(res.status).toBe(200);
  });

  test("the minted cookie authenticates on its own, and carries no secret", async () => {
    const first = await fetch(`${BASE}/who`, { headers: { [TOKEN_HEADER]: SECRET } });
    const value = (first.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(value).not.toContain(SECRET);

    const res = await fetch(`${BASE}/who`, { headers: { cookie: value } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "rune", role: "user" });
  });

  test("a forged cookie is refused", async () => {
    const res = await fetch(`${BASE}/who`, { headers: { cookie: `${SESSION_COOKIE}=v1.aaa.bbb` } });
    expect(res.status).toBe(401);
  });

  test("a GET presenting the secret on the query string redirects it away", async () => {
    // Otherwise the secret sits in history, the address bar and any Referer.
    const res = await fetch(`${BASE}/who?${TOKEN_QUERY_PARAM}=${SECRET}&keep=1`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/who?keep=1");
    expect(res.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=`);
  });

  test("a POST presenting the secret is NOT redirected — that would drop the body", async () => {
    const res = await fetch(`${BASE}/who?${TOKEN_QUERY_PARAM}=${SECRET}`, { method: "POST", redirect: "manual" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "rune" });
  });

  test("a request behind an https proxy gets a Secure cookie", async () => {
    const res = await fetch(`${BASE}/who`, {
      headers: { ...TAILSCALE_SERVE_HEADERS, [TOKEN_HEADER]: SECRET },
    });
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });
});

describe("regressions found in review", () => {
  beforeEach(() => __setLoopbackBypassForTest(false));

  test("a cookie that is not valid percent-encoding is a 401, not a 500", async () => {
    // `decodeURIComponent` threw, uncaught, BEFORE the presented-token branch —
    // so a browser holding a corrupted 7-day cookie got 500 on every request and
    // could not clear it by re-presenting the secret. Four reviewers hit it.
    for (const bad of ["%", "%zz", "%E0%A4%A"]) {
      const res = await fetch(`${BASE}/who`, { headers: { cookie: `${SESSION_COOKIE}=${bad}` } });
      expect({ bad, status: res.status }).toEqual({ bad, status: 401 });
    }
  });

  test("a malformed cookie still lets the shared secret authenticate", async () => {
    // The recovery path the 500 killed.
    const res = await fetch(`${BASE}/who`, {
      headers: { cookie: `${SESSION_COOKIE}=%`, [TOKEN_HEADER]: SECRET },
    });
    expect(res.status).toBe(200);
  });

  test("the raw shared secret is NOT honoured as a cookie value", async () => {
    // Otherwise a hand-set cookie puts the long-lived secret in every request's
    // jar with no expiry — the property session.ts exists to prevent.
    const res = await fetch(`${BASE}/who`, { headers: { cookie: `${SESSION_COOKIE}=${SECRET}` } });
    expect(res.status).toBe(401);
  });

  test("a session minted for a different pinned user is refused", async () => {
    const stale = mintSession(SECRET, "someone-else");
    const res = await fetch(`${BASE}/who`, { headers: { cookie: `${SESSION_COOKIE}=${stale}` } });
    expect(res.status).toBe(401);
  });

  test("the token-stripping redirect cannot be turned into an open redirect", async () => {
    // `URL.pathname` keeps a leading `//`, which a browser resolves as an
    // absolute HOST: `//evil.example/x` sent the operator off-site WITH a fresh
    // session cookie, reached through the very login link this branch exists to
    // clean up. Sent raw — `fetch` would collapse the `//` and never reach it.
    const res = await rawRequest(`//evil.example/x?${TOKEN_QUERY_PARAM}=${SECRET}`);
    expect(res).toContain("302");
    const location = res.match(/^location:\s*(.*)$/im)?.[1]?.trim();
    expect(location).toBe("/evil.example/x");
  });

  test("the secret is stripped even when a cookie already authenticated", async () => {
    // Gating the strip on "the cookie check failed" left a bookmarked login URL
    // carrying the secret in the address bar on every later visit.
    const cookie = `${SESSION_COOKIE}=${mintSession(SECRET, "rune")}`;
    const res = await fetch(`${BASE}/who?${TOKEN_QUERY_PARAM}=${SECRET}`, {
      headers: { cookie }, redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/who");
  });

  test("HEAD with the secret on the query string is stripped too", async () => {
    const res = await fetch(`${BASE}/who?${TOKEN_QUERY_PARAM}=${SECRET}`, {
      method: "HEAD", redirect: "manual",
    });
    expect(res.status).toBe(302);
  });

  test("an unlisted forwarding header still removes the bypass", async () => {
    // The literal nine-name list admitted every one of these.
    __setLoopbackBypassForTest(null);
    for (const header of ["cf-connecting-ip", "x-envoy-external-address", "fly-client-ip", "via", "true-client-ip", "x-forwarded-port"]) {
      const res = await fetch(`${BASE}/who`, { headers: { [header]: "1.2.3.4" } });
      expect({ header, status: res.status }).toEqual({ header, status: 401 });
    }
  });
});

describe("off is off", () => {
  test("there is no introspector to build in off mode", () => {
    expect(createIntrospector(resolveAuthConfig({}))).toBeNull();
  });

  test("and therefore no middleware can be constructed", () => {
    expect(() => createAuthMiddleware(resolveAuthConfig({}))).toThrow(/nothing to mount/);
  });
});
