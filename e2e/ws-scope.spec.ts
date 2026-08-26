/**
 * The `/chat/ws` upgrade, on a REAL muninn in `MUNINN_AUTH=local`.
 *
 * What only a booted server can prove, and why each piece is here:
 *
 *   1. **`src/index.ts` actually calls the authorizer.** The upgrade runs inside
 *      `Bun.serve`'s `fetch`, before `app.fetch`, so no Hono middleware covers
 *      it and no route test can reach it. Deleting the two lines that wire
 *      `createWsUpgradeAuthorizer` in is invisible to `tsc` and to every unit
 *      test in `src/auth/ws-upgrade.test.ts` — which drives the authorizer
 *      through a MIRROR of that branch, not the branch itself. This is the
 *      `initChatOptions` seam class, pinned the way that one is.
 *   2. **The proxy-header rule is what makes a refusal observable at all.** Every
 *      request here comes from `127.0.0.1`, i.e. from inside the loopback
 *      bypass, so an unauthenticated handshake would otherwise succeed. Adding
 *      one `x-forwarded-for` is exactly what a real reverse proxy stamps and
 *      what `src/auth/middleware.ts` keys the bypass off — so this file
 *      exercises both directions of that rule on the socket.
 *   3. **`/api/events` is denied and `/chat/events` is not**, on the same live
 *      server, which is the pair the chat page depends on.
 *
 * No model calls, no writes: it opens sockets, reads the first frame, and
 * closes. `SCHEDULER_ENABLED=false`, so no watcher runs.
 *
 * SPAWN ENV: as `plans-write.spec.ts` — `e2eEnv()` blanks the platform tokens
 * and the instance-profile flags, and this spec then sets the `MUNINN_AUTH`
 * family back deliberately. That order is load-bearing: without the blank the
 * host's own auth config would decide what this server does.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";

const PORT = e2ePort("ws-scope");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const SECRET = "e2e-ws-scope-secret-not-a-real-one";
const PINNED_USER = "e2e-ws-user";
const ALLOWED_ORIGIN = `http://127.0.0.1:${PORT}`;

/** One `x-forwarded-for` is enough to take a request OUT of the loopback bypass
 *  — header PRESENCE only ever removes it, which is the direction that keeps the
 *  bypass safe. Without this every assertion below would be about the bypass. */
const VIA_PROXY = { "x-forwarded-for": "203.0.113.9" };

let server: ChildProcess | undefined;

/**
 * A raw handshake, because the STATUS LINE of a refusal is the assertion. A
 * refused `WebSocket` surfaces only as an opaque error event, and 401 vs 403 is
 * precisely what is being distinguished. `fetch` is no help either: it will not
 * let a caller set `Origin`.
 */
function handshake(headers: Record<string, string> = {}, path = "/chat/ws"): Promise<string> {
  const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n");
  return new Promise((resolve, reject) => {
    let buf = "";
    const sock = net.connect(PORT, "127.0.0.1", () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n` +
        `${lines}${lines ? "\r\n" : ""}\r\n`,
      );
    });
    const done = () => {
      sock.destroy();
      resolve(buf);
    };
    // A 101 is followed by the server's own frames, so waiting for the socket to
    // close would hang. The header block is the whole assertion.
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      if (buf.includes("\r\n\r\n")) done();
    });
    sock.on("close", () => resolve(buf));
    sock.on("error", reject);
    setTimeout(() => {
      sock.destroy();
      reject(new Error("handshake timed out"));
    }, 10_000).unref?.();
  });
}

const statusOf = (raw: string) => Number(raw.split(" ")[1] ?? 0);

async function waitUp(): Promise<void> {
  const deadline = Date.now() + 40_000;
  for (;;) {
    try {
      // With auth ON, an unauthenticated probe from loopback still answers via
      // the bypass — which is what makes this a readiness check rather than an
      // auth assertion.
      const res = await fetch(`${BASE}/chat/me`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`muninn did not start on ${BASE}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

test.beforeAll(async () => {
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      // Set back AFTER the blank, deliberately — this spec is about the mode.
      MUNINN_AUTH: "local",
      MUNINN_LOCAL_TOKEN: SECRET,
      MUNINN_LOCAL_USER: PINNED_USER,
      MUNINN_ADMIN_IDENTS: "A000000",
      MUNINN_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    },
    stdio: "ignore",
  });
  await waitUp();
});

test.afterAll(() => {
  server?.kill("SIGTERM");
});

test.describe("the /chat/ws upgrade on a live authenticating instance", () => {
  test("a handshake through a proxy with NO credential is refused 401, not upgraded", async () => {
    // Before PR D this answered 101 and streamed every conversation in the
    // process — the REST API was 401 while the socket was wide open. It is also
    // the assertion that proves `src/index.ts` calls the authorizer at all.
    const raw = await handshake(VIA_PROXY);
    expect(statusOf(raw)).toBe(401);
    expect(raw).toContain("loginUrl");
  });

  test("the same handshake WITH the shared secret upgrades and sends a snapshot", async () => {
    const raw = await handshake({ ...VIA_PROXY, authorization: `Bearer ${SECRET}` });
    expect(statusOf(raw)).toBe(101);
  });

  test("a cross-origin handshake with a valid credential is refused 403", async () => {
    // Handshakes are not subject to CORS, so without this an attacker page
    // riding the ambient session gets a live stream of the victim's
    // conversations and every guard in PR D is bypassed.
    const raw = await handshake({
      ...VIA_PROXY,
      authorization: `Bearer ${SECRET}`,
      origin: "https://evil.example",
    });
    expect(statusOf(raw)).toBe(403);
    expect(raw).toContain("cross-origin");
  });

  test("the allowlisted origin is accepted", async () => {
    const raw = await handshake({
      ...VIA_PROXY,
      authorization: `Bearer ${SECRET}`,
      origin: ALLOWED_ORIGIN,
    });
    expect(statusOf(raw)).toBe(101);
  });

  test("/simulator/ws — the alias matched by the same `if` — is guarded identically", async () => {
    expect(statusOf(await handshake(VIA_PROXY, "/simulator/ws"))).toBe(401);
  });

  test("the loopback bypass still upgrades with no credential at all", async () => {
    // §8 requires an escape hatch no auth config can revoke: `ssh` +
    // `curl 127.0.0.1:3010` must work from the road. The socket must not be the
    // one surface that ignores it — and the contrast with the first test is what
    // shows the proxy-header rule is the thing doing the work.
    const raw = await handshake();
    expect(statusOf(raw)).toBe(101);
  });
});

test.describe("what an upgraded socket is told", () => {
  test("the snapshot carries no conversation the session does not own", async () => {
    // The whole chain on a live server: authorizer → `wsDataFor` → the `open`
    // handler's filter. The credential rides the query string because node's
    // global `WebSocket` cannot set request headers.
    //
    // ⚠️ Its strength depends on the instance: it BITES on any muninn whose DB
    // carries messages for other users (`hydrateFromDb` rebuilds a shell for
    // each at boot), and is merely true-but-quiet on a freshly-seeded CI
    // database, which inserts no `messages` rows. The parts that hold
    // everywhere are `src/chat/ws.test.ts` (the filter, over a seeded state) and
    // its `wsDataFor` cases (the wiring).
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/chat/ws?muninn_token=${encodeURIComponent(SECRET)}`);
    const frame = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no frame")), 10_000);
      ws.onmessage = (e) => {
        clearTimeout(t);
        resolve(String(e.data));
      };
      ws.onerror = () => {
        clearTimeout(t);
        reject(new Error("handshake refused"));
      };
    });
    ws.close();

    const payload = JSON.parse(frame) as { type: string; conversations: { userId: string }[] };
    expect(payload.type).toBe("snapshot");
    const foreign = payload.conversations.filter((c) => c.userId !== PINNED_USER);
    expect(foreign, "the socket published conversations the session does not own").toEqual([]);
  });
});

test.describe("the two event streams on the same instance", () => {
  test("GET /api/events is denied to role `user`", async () => {
    // A local identity always resolves to `user` (`role.ts`), so on this
    // instance the operator stream is closed to everyone — the deferred zone
    // model's shape arriving early, and stated in `src/auth/CLAUDE.md`.
    const res = await fetch(`${BASE}/api/events`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(403);
    await res.body?.cancel();
  });

  test("GET /chat/events opens, which is what the chat page consumes instead", async () => {
    const res = await fetch(`${BASE}/chat/events?viewer=${PINNED_USER}`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.body?.cancel();
  });

  test("a claimed viewer that is not the session is 403 there too", async () => {
    const res = await fetch(`${BASE}/chat/events?viewer=somebody-else`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(403);
    await res.body?.cancel();
  });
});
