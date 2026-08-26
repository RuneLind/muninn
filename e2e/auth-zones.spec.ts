/**
 * The zone model, on TWO real muninns in `MUNINN_AUTH=local`.
 *
 * Why a spec rather than a source-text or route-level assertion:
 *
 *   1. **The middleware is mounted in `src/index.ts`**, on the top-level app,
 *      before both `app.route()` calls. Deleting that one `app.use` is
 *      invisible to `tsc` and to every unit test in `src/auth/` — which drives
 *      `decideZone` and a hand-built app, not the branch. Same seam class as
 *      `ws-scope.spec.ts`'s first assertion.
 *   2. **`/chat/*` coverage is the whole point of the user zone**, and `/chat`
 *      is a SECOND `app.route` sub-app. Only a booted server proves the
 *      top-level middleware reaches it.
 *   3. **`MUNINN_LOCAL_ROLE` is a per-process setting**, so admin and `user`
 *      cannot be observed on one instance. Hence two ports.
 *
 * ⚠️ **Every row expecting `admin` stamps `x-forwarded-for`.** Playwright and
 * `fetch` both drive 127.0.0.1, which takes the loopback bypass — and a bypass
 * grant is never promoted, whatever `MUNINN_LOCAL_ROLE` says, because the
 * bypass is blind to an L4 forward. One forwarding header is exactly what a
 * real reverse proxy stamps and what takes a request out of it.
 * `ws-scope.spec.ts` carries the same idiom.
 *
 * No model calls, no writes: it reads status lines. `SCHEDULER_ENABLED=false`.
 *
 * SPAWN ENV: `e2eEnv()` blanks the platform tokens and the instance-profile
 * flags (the `MUNINN_AUTH` family, `MUNINN_LOCAL_ROLE` included), and this spec
 * then sets them back deliberately. Without the blank the HOST's own auth
 * config would decide what these servers do.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";

const ADMIN_PORT = e2ePort("auth-zones/admin");
const USER_PORT = e2ePort("auth-zones/user");
const ADMIN_BASE = `http://127.0.0.1:${ADMIN_PORT}`;
const USER_BASE = `http://127.0.0.1:${USER_PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const SECRET = "e2e-auth-zones-secret-not-a-real-one";
const PINNED_USER = "e2e-zone-user";

/** See the header note: one forwarding header takes a request OUT of the
 *  loopback bypass, which is the only way `MUNINN_LOCAL_ROLE` can apply. */
const VIA_PROXY = { "x-forwarded-for": "203.0.113.9" };
const TOKEN = { "x-muninn-token": SECRET };

const servers: ChildProcess[] = [];

function boot(port: number, extra: Record<string, string>): ChildProcess {
  const proc = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(port),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      MUNINN_AUTH: "local",
      MUNINN_LOCAL_TOKEN: SECRET,
      MUNINN_LOCAL_USER: PINNED_USER,
      MUNINN_ADMIN_IDENTS: "A123456",
      MUNINN_ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
      ...extra,
    },
    stdio: "ignore",
  });
  servers.push(proc);
  return proc;
}

/** `/api/live` is the open zone's whole point: reachable with no credential in
 *  an authenticating mode, so it doubles as the readiness probe here. */
async function waitUp(base: string): Promise<void> {
  const deadline = Date.now() + 40_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/live`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`muninn did not start on ${base}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

const status = async (base: string, p: string, headers: Record<string, string> = {}, method = "GET") =>
  (await fetch(`${base}${p}`, { headers, method, redirect: "manual" })).status;

test.beforeAll(async () => {
  boot(ADMIN_PORT, { MUNINN_LOCAL_ROLE: "admin" });
  // Deliberately NOT set: the default is `user`, which is what closes the
  // operator surface, and asserting the default is asserting the default.
  boot(USER_PORT, {});
  await Promise.all([waitUp(ADMIN_BASE), waitUp(USER_BASE)]);
});

test.afterAll(() => {
  for (const s of servers) s.kill("SIGTERM");
});

test.describe("the open zone", () => {
  test("/api/live answers with no credential and does not touch the database", async () => {
    const res = await fetch(`${ADMIN_BASE}/api/live`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("/api/ready answers with no credential", async () => {
    const res = await fetch(`${ADMIN_BASE}/api/ready`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ready: true });
  });

  test("both favicon paths answer for a role `user`", async () => {
    expect(await status(USER_BASE, "/favicon.svg", { ...VIA_PROXY, ...TOKEN })).toBe(200);
    expect(await status(USER_BASE, "/favicon.ico", { ...VIA_PROXY, ...TOKEN })).toBe(200);
  });
});

test.describe("role `user` — the default", () => {
  const as = { ...VIA_PROXY, ...TOKEN };

  test("GET / redirects to /chat", async () => {
    const res = await fetch(`${USER_BASE}/`, { headers: as, redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/chat");
  });

  test("the chat surface and the routes that page calls are reachable", async () => {
    // Middleware coverage of `/chat/*` proven on a booted server: `/chat` is a
    // second `app.route` sub-app, so this is the only place the top-level mount
    // can be observed reaching it.
    expect(await status(USER_BASE, "/chat", as)).toBe(200);
    expect(await status(USER_BASE, "/chat/me", as)).toBe(200);
    expect(await status(USER_BASE, "/chat/bots", as)).toBe(200);
    expect(await status(USER_BASE, `/api/goals/${PINNED_USER}`, as)).toBe(200);
  });

  test("the two admin bot-preferences routes are 403", async () => {
    // They sit UNDER the `/chat/*` user-zone prefix and set BOT-GLOBAL state:
    // the deny list is what stops the prefix admitting them. (The OPTIONS
    // preflight is deliberately not asserted — a credential-less preflight is
    // 401'd by the auth middleware before zones run.)
    const p = "/chat/bot-preferences/jarvis/default-user";
    expect(await status(USER_BASE, p, as)).toBe(403);
    expect(await status(USER_BASE, p, { ...as, "content-type": "application/json" }, "PUT")).toBe(403);
  });

  test("the operator surface is 403, page and API alike", async () => {
    for (const p of ["/traces", "/models", "/plans", "/api/traces", "/api/users", "/api/threads"]) {
      expect(await status(USER_BASE, p, as), p).toBe(403);
    }
  });
});

test.describe("role `admin` — MUNINN_LOCAL_ROLE, and the channel it applies to", () => {
  test("the operator surface is reachable end to end", async () => {
    for (const p of ["/traces", "/models", "/plans"]) {
      expect(await status(ADMIN_BASE, p, { ...VIA_PROXY, ...TOKEN }), p).toBe(200);
    }
  });

  test("GET / is the dashboard, not a redirect", async () => {
    const res = await fetch(`${ADMIN_BASE}/`, { headers: { ...VIA_PROXY, ...TOKEN }, redirect: "manual" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<html");
  });

  test("a DIRECT loopback request with no credential does NOT get admin", async () => {
    // The row the whole design turns on. The bypass hands out the pinned
    // identity with no secret and cannot see an L4 forward (`ssh -L`, `socat`,
    // `tailscale serve --tcp`, a bare `proxy_pass`), so promoting it would be
    // full admin over every user's data to anyone behind one.
    expect(await status(ADMIN_BASE, "/api/traces")).toBe(403);
  });

  test("…and the same request WITH a valid token does — the ssh escape hatch", async () => {
    expect(await status(ADMIN_BASE, "/api/traces", TOKEN)).toBe(200);
  });

  test("a request with no credential at all through the proxy is 401, not 403", async () => {
    // Identity before role: a caller must be able to tell "not logged in" from
    // "not an operator".
    expect(await status(ADMIN_BASE, "/api/traces", VIA_PROXY)).toBe(401);
  });

  test("a COOKIE-only request through the proxy is admin — the row the hatch stands on", async () => {
    // The operator's second and every later request after following the login
    // link. `presentedToken` never sees a cookie, so a "was a credential
    // presented" predicate would drop them to `user` one redirect in.
    const login = await fetch(`${ADMIN_BASE}/chat/me`, { headers: { ...VIA_PROXY, ...TOKEN } });
    const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    expect(cookie).toContain("muninn_session=");
    expect(await status(ADMIN_BASE, "/api/traces", { ...VIA_PROXY, cookie })).toBe(200);
  });

  test("a cookie-bearing request from the HOST ITSELF stays `user` — the stated consequence", async () => {
    // `resolveRequestIdentity` fills `identity` from the bypass and reads the
    // cookie only `if (!identity)`, so a browser running on the muninn host
    // never reaches the cookie branch. Shipped PR D ordering, documented rather
    // than restructured — reach the dashboard through the proxy, or with the
    // token on the request.
    const login = await fetch(`${ADMIN_BASE}/chat/me`, { headers: { ...VIA_PROXY, ...TOKEN } });
    const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    expect(await status(ADMIN_BASE, "/api/traces", { cookie })).toBe(403);
  });
});
