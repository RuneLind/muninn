/**
 * `MUNINN_AUTH=entra` on a REAL muninn, against a stub Texas.
 *
 * Everything asserted here is invisible from a unit test:
 *
 *   1. **The mode BOOTS.** `AUTH_ZONES_IMPLEMENTED` flipping is one constant;
 *      that the process then comes up, mounts three middlewares and answers is
 *      a different claim.
 *   2. **Provisioning really writes.** The rows are read back out of Postgres,
 *      not inferred from a 200.
 *   3. **ONE introspection for an HTTP request AND a `/chat/ws` upgrade on the
 *      same token** — acceptance 17, and the assertion that catches the
 *      duplicate-introspector shape. Two introspector instances both WORK; what
 *      they cost is a second Texas call and a second first-login transaction,
 *      and only a live server with both channels can see it. The stub counts.
 *
 * The stub Texas is an in-process `Bun.serve` whose claims are per-token, so a
 * case can present a second token for the same `oid`, or a claim set with no
 * NAVident, without restarting anything.
 *
 * No NAV values: placeholder UUIDs, `example-tenant`, `X999999`-shaped idents
 * that belong to nobody. muninn is a public repo.
 *
 * SPAWN ENV: `e2eEnv()` blanks the platform tokens and the instance-profile
 * flags (the `MUNINN_AUTH` family and the two `entra` variables included), and
 * this spec sets them back deliberately.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import path from "node:path";
import postgres from "postgres";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const PORT = e2ePort("entra-identity");
const TEXAS_PORT = e2ePort("entra-identity/texas");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");


const TENANT = "example-tenant";
const OID_A = "00000000-1111-2222-3333-aaaaaaaaaaaa";
const OID_B = "00000000-1111-2222-3333-bbbbbbbbbbbb";
const OID_C = "00000000-1111-2222-3333-cccccccccccc";

/** Far future, so no case is clock-sensitive. */
const EXP = Math.floor(Date.now() / 1000) + 3600;

interface StubClaims {
  active: boolean;
  oid?: string;
  NAVident?: string | null;
  name?: string;
  exp?: number;
}

/** token → what Texas answers for it. Mutated per test. */
const tokens = new Map<string, StubClaims>();
/** token → how many times muninn asked. The acceptance-17 counter. */
const calls = new Map<string, number>();

let texas: Server | null = null;
let muninn: ChildProcess | null = null;
let sql: ReturnType<typeof postgres> | null = null;

/**
 * The stub Texas. `node:http`, not `Bun.serve`: Playwright runs this file under
 * NODE (the `summaries-share.spec.ts` precedent).
 */
function startTexas(): Promise<Server> {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        let body: { identity_provider?: string; token?: string } = {};
        try { body = JSON.parse(raw); } catch { /* answered as a 400 below */ }
        // The contract muninn posts. Asserted rather than trusted: a wrong
        // provider string would be a silent production failure.
        if (body.identity_provider !== "azuread") {
          res.writeHead(400, { "content-type": "application/json" }).end("{}");
          return;
        }
        const token = body.token ?? "";
        calls.set(token, (calls.get(token) ?? 0) + 1);
        const claims = tokens.get(token);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(claims ? { exp: EXP, ...claims } : { active: false }));
      });
    });
    srv.listen(TEXAS_PORT, "127.0.0.1", () => resolve(srv));
  });
}

async function waitUp(): Promise<void> {
  const deadline = Date.now() + 40_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/live`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`muninn did not start on ${BASE}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function usersFor(id: string) {
  return await sql!`SELECT id, username, display_name, platform FROM users WHERE id = ${id}`;
}
async function identities() {
  return await sql!`SELECT provider, tenant, oid, user_id, nav_ident, display_name FROM user_identities ORDER BY oid`;
}

test.beforeAll(async () => {
  texas = await startTexas();
  sql = postgres(TEST_DB, { max: 2 });
  await sql`DELETE FROM user_identities`;
  await sql`DELETE FROM users WHERE platform = 'entra' OR id LIKE 'nav-%'`;

  muninn = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DATABASE_URL: TEST_DB,
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      MUNINN_AUTH: "entra",
      NAIS_TOKEN_INTROSPECTION_ENDPOINT: `http://127.0.0.1:${TEXAS_PORT}/introspect`,
      MUNINN_TENANT: TENANT,
      MUNINN_ADMIN_IDENTS: "X999999",
      MUNINN_ALLOWED_ORIGINS: `http://127.0.0.1:${PORT}`,
    },
    stdio: "ignore",
  });
  await waitUp();
});

test.afterAll(async () => {
  muninn?.kill("SIGTERM");
  texas?.close();
  await sql?.end();
});

test.describe("acceptance 21 — the mode boots", () => {
  test("MUNINN_AUTH=entra comes up and answers the open zone with no credential", async () => {
    // Before this PR the process refused to start at all.
    const res = await fetch(`${BASE}/api/live`);
    expect(res.status).toBe(200);
  });

  test("a request with no credential is 401, and names the sidecar's login url", async () => {
    // ⚠️ The 401 body's `loginUrl` is the CLIENT's HTTP expiry predicate
    // (authed-fetch.ts). If this string moves, the chat page stops reloading.
    const res = await fetch(`${BASE}/chat/me`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "unauthenticated", mode: "entra", loginUrl: "/oauth2/login" });
  });

  test("a token Texas refuses is a 401", async () => {
    expect((await fetch(`${BASE}/chat/me`, { headers: bearer("never-issued") })).status).toBe(401);
  });
});

test.describe("acceptance 13 + 16 — provisioning, read back out of Postgres", () => {
  test("a first login writes one users row and one identity row", async () => {
    tokens.set("tok-a1", { active: true, oid: OID_A, NAVident: "X999999", name: "Test Person" });

    const res = await fetch(`${BASE}/chat/me`, { headers: bearer("tok-a1") });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      mode: "session",
      userId: "nav-x999999",
      provider: "entra",
      navIdent: "X999999",
      // MUNINN_ADMIN_IDENTS carries X999999, matched against the token's claims.
      role: "admin",
    });

    expect(await usersFor("nav-x999999")).toMatchObject([
      { id: "nav-x999999", username: "X999999", display_name: "Test Person", platform: "entra" },
    ]);
    expect(await identities()).toMatchObject([
      { provider: "entra", tenant: TENANT, oid: OID_A, user_id: "nav-x999999", nav_ident: "X999999" },
    ]);
  });

  test("a SECOND token for the same oid with a changed name provisions nothing", async () => {
    // Acceptance 13's second half + 16: the identity is the oid, not the name.
    tokens.set("tok-a2", { active: true, oid: OID_A, NAVident: "X999999", name: "Renamed Person" });
    const res = await fetch(`${BASE}/chat/me`, { headers: bearer("tok-a2") });
    expect((await res.json()).userId).toBe("nav-x999999");

    const rows = await identities();
    expect(rows.length).toBe(1);
    expect(rows[0]!.display_name).toBe("Renamed Person");
    expect((await sql!`SELECT count(*)::int AS n FROM users WHERE platform = 'entra'`)[0]!.n).toBe(1);
  });
});

test.describe("acceptance 14 — a re-issued NAVident does not adopt the account", () => {
  test("the colliding ident takes the suffix fallback", async () => {
    // Seeded, not reasoned about: `nav-x111111` already belongs to someone.
    await sql!`INSERT INTO users (id, username, platform) VALUES ('nav-x111111', 'X111111', 'web')`;
    tokens.set("tok-b", { active: true, oid: OID_B, NAVident: "X111111", name: "The Newcomer" });

    const me = await (await fetch(`${BASE}/chat/me`, { headers: bearer("tok-b") })).json();
    expect(me.userId).not.toBe("nav-x111111");
    expect(me.userId).toBe(`nav-x111111-${OID_B.slice(0, 8)}`);

    // The existing account is untouched and unlinked.
    expect((await usersFor("nav-x111111"))[0]!.platform).toBe("web");
    const linked = await sql!`SELECT user_id FROM user_identities WHERE oid = ${OID_B}`;
    expect(linked[0]!.user_id).toBe(me.userId);
  });
});

test.describe("acceptance 15 — a claim set with no NAVident", () => {
  test("mints from the oid, and still resolves admin off the oid", async () => {
    // The `claims.extra: ["NAVident"]` entry lives in another repository, so
    // this half has to defend itself.
    tokens.set("tok-c", { active: true, oid: OID_C, name: "No Ident" });
    const me = await (await fetch(`${BASE}/chat/me`, { headers: bearer("tok-c") })).json();
    expect(me.userId).toBe(`nav-${OID_C}`);
    expect(me.navIdent).toBeNull();
    // resolveRole matches MUNINN_ADMIN_IDENTS against BOTH claims, so an
    // ident-less token is role `user` here — the honest answer, not a lockout
    // of a name that is not on the list.
    expect(me.role).toBe("user");

    const [row] = await sql!`SELECT nav_ident, user_id FROM user_identities WHERE oid = ${OID_C}`;
    expect(row!.nav_ident).toBeNull();
    expect(row!.user_id).toBe(`nav-${OID_C}`);
  });
});

test.describe("acceptance 17 — ONE introspection across BOTH credential paths", () => {
  test("an HTTP request and a /chat/ws upgrade on one token cost one Texas call", async () => {
    // The assertion that catches the duplicate-introspector shape. Two
    // introspector instances both work — they just each hold their own cache,
    // so the socket misses the one the HTTP request filled milliseconds before,
    // and in entra mode that second miss is also a second provisioning
    // transaction racing the first.
    const token = "tok-shared";
    tokens.set(token, { active: true, oid: OID_A, NAVident: "X999999", name: "Test Person" });
    calls.delete(token);

    // Both channels, concurrently, on a token neither has seen.
    const [httpRes, wsOk] = await Promise.all([
      fetch(`${BASE}/chat/me`, { headers: bearer(token) }),
      upgrade(token),
    ]);
    expect(httpRes.status).toBe(200);
    expect(wsOk).toBe(true);
    expect(calls.get(token)).toBe(1);

    // And the cache holds for later requests on the same token.
    await fetch(`${BASE}/chat/bots`, { headers: bearer(token) });
    await fetch(`${BASE}/chat/me`, { headers: bearer(token) });
    expect(calls.get(token)).toBe(1);
  });

  test("a DIFFERENT token is a different entry", async () => {
    tokens.set("tok-other", { active: true, oid: OID_A, NAVident: "X999999" });
    calls.delete("tok-other");
    await fetch(`${BASE}/chat/me`, { headers: bearer("tok-other") });
    expect(calls.get("tok-other")).toBe(1);
  });
});

/**
 * A raw `/chat/ws` handshake carrying the bearer token, and whether it 101'd.
 *
 * Hand-rolled over a socket because the browser/node `WebSocket` constructor
 * cannot set an `Authorization` header — and the Bearer channel is exactly what
 * wonderwall forwards on an upgrade (measured, `scripts/wonderwall-ws-harness.sh`).
 * Same shape as `src/auth/ws-upgrade.test.ts`'s `rawHandshake`.
 */
function upgrade(token: string): Promise<boolean> {
  return new Promise((resolve) => {
    let buf = "";
    const sock = connect(PORT, "127.0.0.1", () => {
      sock.write(
        `GET /chat/ws HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n` +
        `Authorization: Bearer ${token}\r\n\r\n`,
      );
    });
    const done = () => {
      sock.destroy();
      resolve(buf.startsWith("HTTP/1.1 101"));
    };
    sock.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\r\n\r\n")) done();
    });
    sock.on("error", done);
    sock.setTimeout(5000, done);
  });
}
