import { describe, test, expect, afterAll } from "bun:test";
import { Hono } from "hono";
import { createAuthMiddleware } from "./middleware.ts";
import { createOriginMiddleware, decideOrigin, isSideEffectingRequest, SIDE_EFFECTING_GETS } from "./origin.ts";
import { resolveAuthConfig } from "./mode.ts";

const SECRET = "a-sufficiently-long-secret";
const EXTENSION = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const CONFIG = resolveAuthConfig({
  MUNINN_AUTH: "local",
  MUNINN_LOCAL_TOKEN: SECRET,
  MUNINN_LOCAL_USER: "rune",
  MUNINN_ADMIN_IDENTS: "A123456",
  MUNINN_ALLOWED_ORIGINS: `https://muninn-host.example-tailnet.ts.net,${EXTENSION}`,
});
const ALLOWED = CONFIG.allowedOrigins;

describe("decideOrigin — the pure rule", () => {
  const base = { host: "127.0.0.1:9999", allowedOrigins: ALLOWED, origin: undefined, secFetchSite: undefined };

  test("a safe GET is never checked, whatever the origin says", () => {
    expect(decideOrigin({ ...base, method: "GET", path: "/chat", origin: "https://evil.example" }).allowed).toBe(true);
    expect(decideOrigin({ ...base, method: "HEAD", path: "/chat", secFetchSite: "cross-site" }).allowed).toBe(true);
  });

  test("OPTIONS is never checked — a CORS preflight has no side effect", () => {
    // Refusing it would break the very preflight `src/auth/cors.ts` answers.
    expect(decideOrigin({ ...base, method: "OPTIONS", path: "/api/research/chat", origin: EXTENSION }).allowed).toBe(true);
    expect(decideOrigin({ ...base, method: "OPTIONS", path: "/api/research/chat", origin: "https://evil.example" }).allowed).toBe(true);
  });

  test("a cross-site POST is refused; a same-HOST one is allowed", () => {
    expect(decideOrigin({ ...base, method: "POST", path: "/chat/conversations", origin: "https://evil.example" }).allowed).toBe(false);
    expect(decideOrigin({ ...base, method: "POST", path: "/chat/conversations", origin: "http://127.0.0.1:9999" }).allowed).toBe(true);
  });

  test("the scheme is deliberately NOT compared — the proxy terminates TLS", () => {
    // tailscale serve publishes https and forwards plain HTTP, so a browser
    // sends `Origin: https://<tailnet-name>` while muninn's own URL is http.
    // Comparing schemes would refuse every write from the one deployment this
    // campaign exists for.
    expect(decideOrigin({
      ...base, method: "POST", path: "/chat/conversations",
      host: "muninn-host.example-tailnet.ts.net",
      origin: "https://muninn-host.example-tailnet.ts.net",
    }).allowed).toBe(true);
  });

  test("a DIFFERENT port on the same hostname is cross-origin", () => {
    expect(decideOrigin({ ...base, method: "POST", path: "/x", origin: "http://127.0.0.1:9998" }).allowed).toBe(false);
  });

  test("an allowlisted extension origin is allowed even when Sec-Fetch-Site says cross-site", () => {
    // The ORDER of the Origin and Sec-Fetch-Site branches is what makes this
    // work: an extension-initiated fetch can carry `cross-site`.
    expect(decideOrigin({
      ...base, method: "POST", path: "/api/youtube/summarize", origin: EXTENSION, secFetchSite: "cross-site",
    }).allowed).toBe(true);
  });

  test("a NON-allowlisted extension origin is refused", () => {
    expect(decideOrigin({
      ...base, method: "POST", path: "/api/youtube/summarize", origin: "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
    }).allowed).toBe(false);
  });

  test("`Origin: null` — a sandboxed iframe — is refused, not treated as absent", () => {
    expect(decideOrigin({ ...base, method: "POST", path: "/x", origin: "null" }).allowed).toBe(false);
  });

  test("the side-effecting GETs ARE checked, and Sec-Fetch-Site is what catches them", () => {
    // A cross-site `<img src>` sends NO Origin header at all — which is exactly
    // why an Origin-only check would be blind to the one-time consume.
    for (const path of ["/chat/pending/abc-123", "/api/research/ask"]) {
      expect(decideOrigin({ ...base, method: "GET", path, secFetchSite: "cross-site" }).allowed).toBe(false);
      expect(decideOrigin({ ...base, method: "GET", path, secFetchSite: "same-origin" }).allowed).toBe(true);
      expect(decideOrigin({ ...base, method: "GET", path, secFetchSite: "none" }).allowed).toBe(true);
      // `same-site` is refused too: nothing legitimate reaches muninn that way.
      expect(decideOrigin({ ...base, method: "GET", path, secFetchSite: "same-site" }).allowed).toBe(false);
    }
  });

  test("neither header ⇒ allowed, so curl and the launchd probe keep working", () => {
    expect(decideOrigin({ ...base, method: "POST", path: "/chat/conversations" }).allowed).toBe(true);
    expect(decideOrigin({ ...base, method: "GET", path: "/chat/pending/x" }).allowed).toBe(true);
  });

  test("a missing Host header cannot make an origin same-origin", () => {
    expect(decideOrigin({ ...base, host: undefined, method: "POST", path: "/x", origin: "http://127.0.0.1:9999" }).allowed).toBe(false);
  });

  test("isSideEffectingRequest matches the enumerated GET list by PATH", () => {
    expect(SIDE_EFFECTING_GETS).toContain("/chat/pending/");
    expect(isSideEffectingRequest("GET", "/chat/pending/t1")).toBe(true);
    expect(isSideEffectingRequest("GET", "/chat/pendingx")).toBe(false);
    expect(isSideEffectingRequest("GET", "/api/research/ask")).toBe(true);
    expect(isSideEffectingRequest("GET", "/api/research/askx")).toBe(false);
    expect(isSideEffectingRequest("DELETE", "/chat/conversations/x")).toBe(true);
  });
});

/**
 * The empirical half, over a REAL server and RAW sockets.
 *
 * Raw sockets, not `fetch`, for two reasons this campaign has already been
 * bitten by: `fetch` normalises the request target, and it will not let a
 * caller set `Origin` freely — so a test written with it can be green against
 * code that has no check at all.
 *
 * And note WHERE these requests come from: 127.0.0.1, with no proxy headers,
 * i.e. inside the loopback bypass. That is deliberate — it is the "a browser on
 * the muninn host" case, the half `SameSite=Lax` cannot touch because the
 * bypass authenticates before any cookie is read. A test driven through a proxy
 * would be green whether or not this middleware exists.
 */
const app = new Hono();
app.use("*", createAuthMiddleware(CONFIG));
app.use("*", createOriginMiddleware(CONFIG.allowedOrigins));
app.post("/chat/conversations", (c) => c.json({ ok: true }));
app.get("/chat/pending/:threadId", (c) => c.json({ consumed: c.req.param("threadId") }));
app.get("/chat/bots", (c) => c.json({ ok: true }));

const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req, srv) => app.fetch(req, srv) });
const PORT = Number(server.port);
afterAll(() => server.stop(true));

function rawRequest(
  target: string,
  headers: Record<string, string> = {},
  method = "GET",
  body?: string,
): Promise<string> {
  const all = { Host: `127.0.0.1:${PORT}`, ...headers } as Record<string, string>;
  if (body !== undefined) all["Content-Length"] = String(Buffer.byteLength(body));
  const lines = Object.entries(all).map(([k, v]) => `${k}: ${v}`).join("\r\n");
  return new Promise((resolve) => {
    let buf = "";
    Bun.connect({
      hostname: "127.0.0.1",
      port: PORT,
      socket: {
        open(sock) {
          sock.write(`${method} ${target} HTTP/1.1\r\n${lines}\r\nConnection: close\r\n\r\n${body ?? ""}`);
        },
        data(_s, d) { buf += new TextDecoder().decode(d); },
        close() { resolve(buf); },
      },
    });
  });
}
const status = (raw: string) => Number(raw.split(" ")[1]);

describe("the origin middleware, over a real socket, inside the loopback bypass", () => {
  const JSON_POST = { "Content-Type": "application/json" };

  test("a forged cross-site JSON POST is refused with 403", async () => {
    const raw = await rawRequest("/chat/conversations", { ...JSON_POST, Origin: "https://evil.example" }, "POST", "{}");
    expect(status(raw)).toBe(403);
    expect(raw).toContain("cross-origin");
  });

  test("a forged cross-site TEXT/PLAIN POST is refused too — the measured incident", async () => {
    // `src/dashboard/routes/jira-routes.ts` records a MEASURED cross-origin
    // `text/plain` POST that landed two messages in a thread; it was mitigated
    // one route at a time with a 415. This is the global regression test for it.
    const raw = await rawRequest("/chat/conversations", { "Content-Type": "text/plain", Origin: "https://evil.example" }, "POST", "{}");
    expect(status(raw)).toBe(403);
  });

  test("a cross-site POST with NO Origin but Sec-Fetch-Site: cross-site is refused", async () => {
    const raw = await rawRequest("/chat/conversations", { ...JSON_POST, "Sec-Fetch-Site": "cross-site" }, "POST", "{}");
    expect(status(raw)).toBe(403);
  });

  test("the page's own same-origin POST still works", async () => {
    const raw = await rawRequest(
      "/chat/conversations",
      { ...JSON_POST, Origin: `http://127.0.0.1:${PORT}`, "Sec-Fetch-Site": "same-origin" },
      "POST",
      "{}",
    );
    expect(status(raw)).toBe(200);
  });

  test("an allowlisted extension POST still works", async () => {
    const raw = await rawRequest("/chat/conversations", { ...JSON_POST, Origin: EXTENSION, "Sec-Fetch-Site": "cross-site" }, "POST", "{}");
    expect(status(raw)).toBe(200);
  });

  test("a scripted POST with no browser headers still works", async () => {
    expect(status(await rawRequest("/chat/conversations", JSON_POST, "POST", "{}"))).toBe(200);
  });

  test("SIDE-EFFECTING GET: a cross-site <img> hit on the one-time consume is refused", async () => {
    // No Origin — a browser sends none on an <img> load. This is the half
    // SameSite=Lax does not cover even through the proxy.
    const raw = await rawRequest("/chat/pending/victim-thread", {
      "Sec-Fetch-Site": "cross-site",
      "Sec-Fetch-Dest": "image",
      "Sec-Fetch-Mode": "no-cors",
    });
    expect(status(raw)).toBe(403);
    expect(raw).not.toContain("victim-thread");
  });

  test("the same consume from the page itself is allowed", async () => {
    const raw = await rawRequest("/chat/pending/own-thread", { "Sec-Fetch-Site": "same-origin" });
    expect(status(raw)).toBe(200);
    expect(raw).toContain("own-thread");
  });

  test("an ORDINARY cross-site GET is untouched — the check is on side effects, not methods", async () => {
    expect(status(await rawRequest("/chat/bots", { "Sec-Fetch-Site": "cross-site" }))).toBe(200);
  });
});
