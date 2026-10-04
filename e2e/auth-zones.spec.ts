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
 * No model calls and nothing written: it reads status lines. The Stamp rows and
 * the wiki write rows POST an EMPTY body, which each route refuses on its own
 * first content check, against a temp wiki registered read-only — so no wiki
 * page is ever written and no model is called. Both servers run the DEFAULT
 * profile; the nais wiki rows live in `wiki-nais-read.spec.ts`.
 * `SCHEDULER_ENABLED=false`.
 *
 * SPAWN ENV: `e2eEnv()` blanks the platform tokens and the instance-profile
 * flags (the `MUNINN_AUTH` family, `MUNINN_LOCAL_ROLE` included), and this spec
 * then sets them back deliberately. Without the blank the HOST's own auth
 * config would decide what these servers do.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

/** The one WRITE this file probes, asserted from both roles. The body is
 *  deliberately incomplete: an admin must get the ROUTE's own 400 rather than a
 *  zone 403, and a body that could reach the CLI would make this spec a writer. */
const STAMP_PATH = "/api/wiki/provenance/stamp";
const STAMP_BODY = {};

const servers: ChildProcess[] = [];

/** One read-only wiki on both servers — the pod's mirror shape — created in
 *  `beforeAll`, so a Playwright listing (`--list`) writes nothing. */
let WIKI_ROOT = "";
const WIKI_Q = "wiki=zones";

/** The seven read-slice paths, each with parameters that answer 200 for an admin
 *  (the wiki carries a `trackers` block, so graph mode answers too). */
const WIKI_READS = [
  `/wiki?${WIKI_Q}`,
  `/api/wiki/pages?${WIKI_Q}`,
  `/api/wiki/page?${WIKI_Q}&relPath=side.md`,
  `/api/wiki/page/provenance?${WIKI_Q}&relPath=side.md`,
  `/api/wiki/related?${WIKI_Q}&relPath=side.md`,
  `/api/wiki/html?${WIKI_Q}&relPath=side.html`,
  `/api/wiki/graph?${WIKI_Q}&scope=wiki&level=1&depth=0`,
];

/** Outside the read slice: Explain, Ask and the other egress GETs, then the
 *  writes. Every body is `{}`, which each route refuses on its own first content
 *  check, and the wiki is read-only — so an admin that passes the zone reaches a
 *  refusal, never a model call or a write. */
const WIKI_TOOL_GETS = [
  `/api/wiki/explain?${WIKI_Q}`,
  `/api/wiki/ask?${WIKI_Q}`,
  `/api/wiki/factcheck?${WIKI_Q}`,
  `/api/wiki/similar?${WIKI_Q}`,
];
const WIKI_TOOL_POSTS = [
  STAMP_PATH,
  "/api/wiki/series",
  "/api/wiki/share",
  "/api/wiki/remember",
  `/api/wiki/reindex?${WIKI_Q}`,
  "/api/wiki/ask/chat",
  "/api/wiki/factcheck/append",
  "/api/wiki/factcheck/integrate/apply",
];
/** The zone middleware's own refusal body — what tells a zone 403 from a route's. */
const ZONE_REFUSAL = { error: "forbidden", reason: "admin-only route" };

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
      WIKI_EXTRA: `zones=${WIKI_ROOT}`,
      WIKI_READONLY_ROOTS: WIKI_ROOT,
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
  WIKI_ROOT = mkdtempSync(path.join(tmpdir(), "muninn-e2e-zones-wiki-"));
  writeFileSync(path.join(WIKI_ROOT, "side.md"), "---\ntitle: Side\n---\n\n# Side\n\nÆ, ø og å.\n", "utf8");
  writeFileSync(path.join(WIKI_ROOT, "side.html"), "<!doctype html><title>Side</title><p>x</p>", "utf8");
  writeFileSync(
    path.join(WIKI_ROOT, ".wiki-reader.json"),
    JSON.stringify({ trackers: [{ id: "jira", projects: ["MELOSYS"], hosts: ["jira.example.invalid"] }] }),
    "utf8",
  );
  boot(ADMIN_PORT, { MUNINN_LOCAL_ROLE: "admin" });
  // Deliberately NOT set: the default is `user`, which is what closes the
  // operator surface, and asserting the default is asserting the default.
  boot(USER_PORT, {});
  await Promise.all([waitUp(ADMIN_BASE), waitUp(USER_BASE)]);
});

test.afterAll(() => {
  for (const s of servers) s.kill("SIGTERM");
  if (WIKI_ROOT) rmSync(WIKI_ROOT, { recursive: true, force: true });
});

/** GET or POST `{}`, returning the status and the parsed body when it is JSON. */
async function probe(base: string, p: string, headers: Record<string, string>, method: "GET" | "POST") {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: method === "POST" ? { ...headers, "content-type": "application/json" } : headers,
    ...(method === "POST" ? { body: "{}" } : {}),
    redirect: "manual",
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* HTML or SSE */
  }
  return { status: res.status, body };
}

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

  test("the wiki Stamp WRITE is 403 — default-deny, with no `zones.ts` entry of its own", async () => {
    // `POST /api/wiki/provenance/stamp` appends to a page's frontmatter through
    // claude-usage's CLI. Its route header calls itself "admin-zone by muninn's
    // default-deny", and default-deny is spelled as the ABSENCE of an entry — so
    // nothing in `zones.ts` names the route and no unit test there would fail if
    // a `/api/wiki/` prefix joined the user zone one day. This is the assertion
    // that would.
    const res = await fetch(`${USER_BASE}${STAMP_PATH}`, {
      method: "POST",
      headers: { ...as, "content-type": "application/json" },
      body: JSON.stringify(STAMP_BODY),
    });
    expect(res.status).toBe(403);
    // The zone middleware's OWN body, not the route's: proof the refusal came
    // from the zone rather than from `decideStampRequest`, a read-only guard or
    // a route that is simply not registered.
    expect(await res.json()).toEqual({ error: "forbidden", reason: "admin-only route" });
  });
});

// These servers run the DEFAULT profile, where the wiki reader is the
// operator's full surface: role `user` is refused all of it, the read slice
// included. The nais rows (the slice in the user zone) are in
// `wiki-nais-read.spec.ts`, which boots that profile for both roles.
test.describe("the wiki on the default profile — role `user`", () => {
  const as = { ...VIA_PROXY, ...TOKEN };

  test("all seven read-slice paths are the zone's 403", async () => {
    for (const p of WIKI_READS) {
      const r = await probe(USER_BASE, p, as, "GET");
      expect(`${p} → ${r.status}`).toBe(`${p} → 403`);
      expect(r.body).toEqual(ZONE_REFUSAL);
    }
  });

  test("Explain, Ask and the other egress GETs are the zone's 403", async () => {
    for (const p of WIKI_TOOL_GETS) {
      const r = await probe(USER_BASE, p, as, "GET");
      expect(`${p} → ${r.status}`).toBe(`${p} → 403`);
      expect(r.body).toEqual(ZONE_REFUSAL);
    }
  });

  test("Stamp and every wiki write are the zone's 403", async () => {
    for (const p of WIKI_TOOL_POSTS) {
      const r = await probe(USER_BASE, p, as, "POST");
      expect(`${p} → ${r.status}`).toBe(`${p} → 403`);
      expect(r.body).toEqual(ZONE_REFUSAL);
    }
  });

  test("without a credential the read paths answer 401", async () => {
    for (const p of WIKI_READS) {
      expect(`${p} → ${(await probe(USER_BASE, p, VIA_PROXY, "GET")).status}`).toBe(`${p} → 401`);
    }
  });
});

test.describe("the wiki on the default profile — role `admin`", () => {
  const as = { ...VIA_PROXY, ...TOKEN };

  test("the read paths pass the zone and answer from the wiki", async () => {
    const got: string[] = [];
    for (const p of WIKI_READS) got.push(`${p} → ${(await probe(ADMIN_BASE, p, as, "GET")).status}`);
    expect(got).toEqual(WIKI_READS.map((p) => `${p} → 200`));
    const page = await probe(ADMIN_BASE, `/api/wiki/page?${WIKI_Q}&relPath=side.md`, as, "GET");
    expect((page.body as { html?: string }).html).toContain("Æ, ø og å.");
  });

  test("…and so does every route outside it — the route's own answer, not the zone's", async () => {
    const answers: string[] = [];
    for (const p of WIKI_TOOL_GETS) {
      const r = await probe(ADMIN_BASE, p, as, "GET");
      if (r.status === 404 || JSON.stringify(r.body) === JSON.stringify(ZONE_REFUSAL)) answers.push(`GET ${p} → ${r.status}`);
    }
    for (const p of WIKI_TOOL_POSTS) {
      const r = await probe(ADMIN_BASE, p, as, "POST");
      if (r.status === 404 || JSON.stringify(r.body) === JSON.stringify(ZONE_REFUSAL)) answers.push(`POST ${p} → ${r.status}`);
    }
    expect(answers).toEqual([]);
  });
});

test.describe("role `admin` — MUNINN_LOCAL_ROLE, and the channel it applies to", () => {
  test("the operator surface is reachable end to end", async () => {
    for (const p of ["/traces", "/models", "/plans"]) {
      expect(await status(ADMIN_BASE, p, { ...VIA_PROXY, ...TOKEN }), p).toBe(200);
    }
  });

  test("…and the same wiki Stamp WRITE PASSES the zone, so the route's own checks answer", async () => {
    // The other half of the pin: 403 for a `user` is only evidence about the
    // zone if an admin is NOT 403'd at the same URL. The answer is the route's
    // first content check — which is also proof the route is registered and
    // that neither `decideStampRequest` nor the global origin middleware
    // refuses a same-process POST carrying no browser headers.
    const res = await fetch(`${ADMIN_BASE}${STAMP_PATH}`, {
      method: "POST",
      headers: { ...VIA_PROXY, ...TOKEN, "content-type": "application/json" },
      body: JSON.stringify(STAMP_BODY),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "relPath and ref (or tracker and key) are required" });
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
