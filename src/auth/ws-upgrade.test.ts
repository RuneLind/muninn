import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { createWsUpgradeAuthorizer, __resetWsWarningsForTest } from "./ws-upgrade.ts";
import { __setLoopbackBypassForTest } from "./middleware.ts";
import { resolveAuthConfig } from "./mode.ts";
import { mintSession, SESSION_COOKIE } from "./session.ts";

const SECRET = "a-sufficiently-long-secret";
const TAILNET = "https://muninn-host.example-tailnet.ts.net";
const LOCAL_CONFIG = resolveAuthConfig({
  MUNINN_AUTH: "local",
  MUNINN_LOCAL_TOKEN: SECRET,
  MUNINN_LOCAL_USER: "rune",
  MUNINN_ADMIN_IDENTS: "A123456",
  MUNINN_ALLOWED_ORIGINS: TAILNET,
});
const OFF_CONFIG = resolveAuthConfig({});

/**
 * A REAL `Bun.serve` whose `fetch` mirrors `src/index.ts`'s upgrade branch,
 * because the two facts this file exists to pin cannot be observed any other
 * way:
 *
 *  1. **Acceptance 13** — `server.upgrade` still returns `true` after an
 *     `await`. The bundled Bun docs and types show only the synchronous form
 *     and say nothing either way, and PR D's whole socket design rests on
 *     awaiting introspection first. A synthetic `Request` cannot exercise it.
 *  2. **The peer address** reaches the authorizer through `server.requestIP`,
 *     which is what the loopback bypass keys on — the same wiring
 *     `middleware.test.ts` drives a real server for.
 *
 * The websocket handler here is deliberately trivial: the fan-out filter is
 * `src/chat/ws.test.ts`'s subject, this file's is the handshake.
 */
let authorizeAtPort: ReturnType<typeof createWsUpgradeAuthorizer>;

const server = Bun.serve<{ userId: string | null; role: string | null }>({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/chat/ws" || url.pathname === "/simulator/ws") {
      const decision = await authorizeAtPort(req, srv.requestIP(req)?.address);
      if (!decision.ok) return decision.response;
      const upgraded = srv.upgrade(req, {
        data: { userId: decision.identity?.userId ?? null, role: decision.role },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }
    return new Response("not ws");
  },
  websocket: {
    open(ws) {
      ws.send(JSON.stringify(ws.data));
    },
    message() {},
  },
});
const PORT = Number(server.port);
// Built once the port is known: the accepted set includes the loopback literals
// at the CONFIGURED port, which is the whole point of `loopbackOrigins` taking a
// port rather than reading one off the request.
authorizeAtPort = createWsUpgradeAuthorizer(LOCAL_CONFIG, PORT);

afterAll(() => {
  server.stop(true);
  __setLoopbackBypassForTest(null);
});

beforeEach(() => {
  __setLoopbackBypassForTest(false); // every test runs over loopback; see below
  __resetWsWarningsForTest();
});

/**
 * A raw handshake, so the STATUS LINE of a refusal is observable — a
 * `new WebSocket` that is refused surfaces only as an opaque `error` event, and
 * 401 vs 403 is exactly the distinction this file asserts. `fetch` is no use
 * either: it normalises the target and will not let a caller set `Origin`.
 */
function rawHandshake(path: string, headers: Record<string, string> = {}): Promise<string> {
  const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n");
  return new Promise((resolve) => {
    let buf = "";
    Bun.connect({
      hostname: "127.0.0.1",
      port: PORT,
      socket: {
        open(sock) {
          sock.write(
            `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\n` +
            `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n` +
            `${lines}${lines ? "\r\n" : ""}\r\n`,
          );
        },
        data(_s, d) {
          buf += new TextDecoder().decode(d);
          if (buf.includes("\r\n\r\n")) {
            _s.end();
            resolve(buf);
          }
        },
        close() {
          resolve(buf);
        },
      },
    });
  });
}

function statusOf(response: string): number {
  return Number(response.split(" ")[1] ?? 0);
}

const session = () => `${SESSION_COOKIE}=${mintSession(SECRET, "rune")}`;

describe("acceptance 13 — server.upgrade after an await", () => {
  test("the socket upgrades and delivers a frame from an ASYNC fetch handler", async () => {
    // The assertion PR D's design was gated on, before the introspection path
    // was built on it. If this ever fails, the upgrade must be decided
    // synchronously and the whole identity-at-upgrade shape changes.
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/chat/ws`, {
      headers: { cookie: session() },
      // Bun's WebSocket accepts request headers; the DOM lib's signature does not.
    } as unknown as string[]);
    const frame = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), 3000);
      ws.onmessage = (e) => {
        clearTimeout(t);
        resolve(String(e.data));
      };
      ws.onerror = () => {
        clearTimeout(t);
        reject(new Error("handshake refused"));
      };
    });
    expect(JSON.parse(frame)).toEqual({ userId: "rune", role: "user" });
    ws.close();
  });
});

describe("identity at the upgrade", () => {
  test("no credential ⇒ 401, not upgraded", async () => {
    // Before PR D this handshake returned 101 and streamed every conversation
    // in the process — the REST API was 401 while the socket was wide open.
    const res = await rawHandshake("/chat/ws");
    expect(statusOf(res)).toBe(401);
    expect(res).toContain("loginUrl");
  });

  test("the 401 body is the same shape every other route answers", async () => {
    const res = await rawHandshake("/chat/ws");
    const body = res.slice(res.indexOf("\r\n\r\n") + 4);
    expect(JSON.parse(body)).toEqual({
      error: "unauthenticated",
      mode: "local",
      loginUrl: "/?muninn_token=YOUR_MUNINN_LOCAL_TOKEN",
    });
  });

  test("a forged session cookie ⇒ 401", async () => {
    const res = await rawHandshake("/chat/ws", { cookie: `${SESSION_COOKIE}=v1.abc.def` });
    expect(statusOf(res)).toBe(401);
  });

  test("the RAW shared secret on the cookie ⇒ 401 — sessions only", async () => {
    // The `session.ts` rule, inherited rather than re-decided: honouring the
    // secret on the cookie channel would put the long-lived credential in every
    // request's jar with no expiry.
    const res = await rawHandshake("/chat/ws", { cookie: `${SESSION_COOKIE}=${SECRET}` });
    expect(statusOf(res)).toBe(401);
  });

  test("the shared secret on Authorization ⇒ upgraded", async () => {
    const res = await rawHandshake("/chat/ws", { authorization: `Bearer ${SECRET}` });
    expect(statusOf(res)).toBe(101);
  });

  test("the loopback bypass grants the pinned identity, as it does on HTTP", async () => {
    // Restored for this one test: §8 requires an escape hatch no auth config can
    // revoke, and the socket must not be the one surface that ignores it.
    __setLoopbackBypassForTest(null);
    const res = await rawHandshake("/chat/ws");
    expect(statusOf(res)).toBe(101);
  });

  test("/simulator/ws — the alias — is guarded identically", async () => {
    // It is matched by the same `if` in src/index.ts, so a check written for one
    // path and not the other would leave a fully-functional unguarded socket.
    expect(statusOf(await rawHandshake("/simulator/ws"))).toBe(401);
    expect(statusOf(await rawHandshake("/simulator/ws", { authorization: `Bearer ${SECRET}` }))).toBe(101);
  });
});

describe("origin at the upgrade", () => {
  test("a cross-origin handshake WITH a valid session ⇒ 403, not upgraded", async () => {
    // Acceptance 10's socket half. Handshakes are not subject to CORS, so
    // without this an attacker page riding the ambient cookie gets a live stream
    // of the victim's conversations and every guard in PR D is bypassed.
    const res = await rawHandshake("/chat/ws", { cookie: session(), origin: "https://evil.example" });
    expect(statusOf(res)).toBe(403);
    expect(res).toContain("cross-origin");
  });

  test("identity is decided BEFORE origin, so a credential-less cross-origin handshake is 401", async () => {
    // The same order as HTTP, where the auth middleware is mounted before the
    // origin middleware: a scripted client must be able to tell the two apart.
    const res = await rawHandshake("/chat/ws", { origin: "https://evil.example" });
    expect(statusOf(res)).toBe(401);
  });

  test("the allowlisted tailnet origin is accepted", async () => {
    const res = await rawHandshake("/chat/ws", { cookie: session(), origin: TAILNET });
    expect(statusOf(res)).toBe(101);
  });

  test("the loopback origin at the CONFIGURED port is accepted", async () => {
    const res = await rawHandshake("/chat/ws", { cookie: session(), origin: `http://127.0.0.1:${PORT}` });
    expect(statusOf(res)).toBe(101);
  });

  test("a matching Host does NOT make an origin acceptable", async () => {
    // The defect review demonstrated in PR C, re-asserted on the surface §6
    // explicitly warned not to re-implement: `Host: evil.example` with a
    // matching `Origin` created a real conversation. `decideOrigin` takes no
    // host input at all, and this pins that it stays that way here too.
    const lines = [
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
      `cookie: ${session()}`,
      "origin: http://evil.example",
    ].join("\r\n");
    const res = await new Promise<string>((resolve) => {
      let buf = "";
      Bun.connect({
        hostname: "127.0.0.1",
        port: PORT,
        socket: {
          open(sock) {
            sock.write(`GET /chat/ws HTTP/1.1\r\nHost: evil.example\r\n${lines}\r\n\r\n`);
          },
          data(s, d) {
            buf += new TextDecoder().decode(d);
            if (buf.includes("\r\n\r\n")) {
              s.end();
              resolve(buf);
            }
          },
          close() {
            resolve(buf);
          },
        },
      });
    });
    expect(statusOf(res)).toBe(403);
  });

  test("a non-browser client sending NEITHER header is allowed through to the credential check", async () => {
    // The same trade `decideOrigin` documents for HTTP: refusing here would
    // break every script (and this file's own harness) to close nothing, since
    // a client that can set headers can set `Origin` too. The credential is
    // what stops it.
    expect(statusOf(await rawHandshake("/chat/ws", { authorization: `Bearer ${SECRET}` }))).toBe(101);
  });
});

describe("with auth OFF", () => {
  test("the authorizer is a constant allow, carrying no identity", async () => {
    // "Off is off": no middleware is mounted on the HTTP side either, and the
    // socket stays exactly as unfiltered as it is today.
    const off = createWsUpgradeAuthorizer(OFF_CONFIG, PORT);
    const decision = await off(new Request("http://127.0.0.1/chat/ws"), "203.0.113.9");
    expect(decision).toEqual({ ok: true, identity: null, role: null });
  });

  test("even a cross-origin handshake is allowed", async () => {
    const off = createWsUpgradeAuthorizer(OFF_CONFIG, PORT);
    const decision = await off(
      new Request("http://127.0.0.1/chat/ws", { headers: { origin: "https://evil.example" } }),
      "203.0.113.9",
    );
    expect(decision.ok).toBe(true);
  });
});

/**
 * The socket carries no ZONE decision — `/chat/ws` and `/simulator/ws` are
 * `/chat/*` surfaces, already identity-authenticated and owner-scoped — but it
 * does carry a ROLE, and that role must equal the one HTTP grants for the same
 * credential. `resolveRole` has two call sites; threading `MUNINN_LOCAL_ROLE`
 * through only the middleware would leave HTTP `admin` and the socket `user`,
 * which nothing else in the suite can see.
 */
describe("MUNINN_LOCAL_ROLE reaches the upgrade, on the same terms as HTTP", () => {
  const ADMIN_CONFIG = resolveAuthConfig({
    MUNINN_AUTH: "local",
    MUNINN_LOCAL_TOKEN: SECRET,
    MUNINN_LOCAL_USER: "rune",
    MUNINN_LOCAL_ROLE: "admin",
    MUNINN_ADMIN_IDENTS: "A123456",
    MUNINN_ALLOWED_ORIGINS: TAILNET,
  });

  // The file-level `beforeEach` turns the bypass OFF so refusals are
  // observable at all; these cases are ABOUT the bypass, so it goes back on.
  // The file's `afterAll` restores the default either way.
  beforeEach(() => __setLoopbackBypassForTest(null));

  const decide = (headers: Record<string, string>, peer: string) =>
    createWsUpgradeAuthorizer(ADMIN_CONFIG, PORT)(new Request("http://127.0.0.1/chat/ws", { headers }), peer);

  test("a credential-less loopback upgrade is `user`", async () => {
    const d = await decide({}, "127.0.0.1");
    expect(d.ok && d.role).toBe("user");
  });

  test("a token on the upgrade is `admin` — the same answer HTTP gives", async () => {
    const d = await decide({ authorization: `Bearer ${SECRET}` }, "127.0.0.1");
    expect(d.ok && d.role).toBe("admin");
  });

  test("a session cookie through a proxy is `admin`", async () => {
    const d = await decide(
      { cookie: `${SESSION_COOKIE}=${mintSession(SECRET, "rune")}`, "x-forwarded-for": "100.64.0.1" },
      "127.0.0.1",
    );
    expect(d.ok && d.role).toBe("admin");
  });

  test("and a `user`-role identity can still complete the upgrade", async () => {
    // The socket makes no zone decision: a `user` opening their own chat page
    // is the ordinary case, and a zone check here would break it.
    const d = await createWsUpgradeAuthorizer(LOCAL_CONFIG, PORT)(
      new Request("http://127.0.0.1/chat/ws", { headers: { authorization: `Bearer ${SECRET}` } }),
      "127.0.0.1",
    );
    expect(d.ok).toBe(true);
    expect(d.ok && d.role).toBe("user");
  });
});
