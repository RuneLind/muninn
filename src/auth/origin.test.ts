import { describe, test, expect, afterAll } from "bun:test";
import { Hono } from "hono";
import { createAuthMiddleware } from "./middleware.ts";
import { createOriginMiddleware, decideOrigin, isSideEffectingRequest, loopbackOrigins, SIDE_EFFECTING_GETS } from "./origin.ts";
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

const SELF = "http://127.0.0.1:9999";

describe("decideOrigin — the pure rule", () => {
  // `allowedOrigins` is the CONFIGURED set — the allowlist plus the loopback
  // literals the middleware derives from `DASHBOARD_PORT`. There is no `host`
  // field by design; see `loopbackOrigins`.
  const base = {
    allowedOrigins: [...ALLOWED, ...loopbackOrigins(9999)],
    origin: undefined as string | undefined,
    secFetchSite: undefined as string | undefined,
  };

  test("a safe GET is never checked, whatever the origin says", () => {
    expect(decideOrigin({ ...base, method: "GET", path: "/chat", origin: "https://evil.example" }).allowed).toBe(true);
    expect(decideOrigin({ ...base, method: "HEAD", path: "/chat", secFetchSite: "cross-site" }).allowed).toBe(true);
  });

  test("OPTIONS is never checked — a CORS preflight has no side effect", () => {
    // Refusing it would break the very preflight `src/auth/cors.ts` answers.
    expect(decideOrigin({ ...base, method: "OPTIONS", path: "/api/research/chat", origin: EXTENSION }).allowed).toBe(true);
    expect(decideOrigin({ ...base, method: "OPTIONS", path: "/api/research/chat", origin: "https://evil.example" }).allowed).toBe(true);
  });

  test("a cross-site POST is refused; the page's own loopback origin is allowed", () => {
    expect(decideOrigin({ ...base, method: "POST", path: "/chat/conversations", origin: "https://evil.example" }).allowed).toBe(false);
    expect(decideOrigin({ ...base, method: "POST", path: "/chat/conversations", origin: SELF }).allowed).toBe(true);
  });

  test("the PROXIED origin is allowed by being LISTED, not by matching Host", () => {
    // tailscale serve publishes https and forwards plain HTTP, so the browser
    // sends `Origin: https://<tailnet-name>` while muninn's own URL is http.
    // That origin is accepted because it is in MUNINN_ALLOWED_ORIGINS — which
    // is also why the scheme in the allowlist entry has to be the one the
    // BROWSER sends.
    expect(decideOrigin({
      ...base, method: "POST", path: "/chat/conversations",
      origin: "https://muninn-host.example-tailnet.ts.net",
    }).allowed).toBe(true);
    // ...and the http spelling of the same name is NOT, because nothing sends it.
    expect(decideOrigin({
      ...base, method: "POST", path: "/chat/conversations",
      origin: "http://muninn-host.example-tailnet.ts.net",
    }).allowed).toBe(false);
  });

  test("a DIFFERENT port on the same hostname is cross-origin", () => {
    expect(decideOrigin({ ...base, method: "POST", path: "/x", origin: "http://127.0.0.1:9998" }).allowed).toBe(false);
  });

  test("an attacker-controlled name is refused however the request describes itself", () => {
    // The DNS-rebinding shape. An earlier cut compared Origin against the
    // request's own `Host`, so a page on `evil.example` rebound to 127.0.0.1
    // sent a matching pair and was answered 201 by a live server. There is no
    // `host` input any more; this asserts the refusal survives every spelling.
    for (const origin of ["http://evil.example:9999", "https://evil.example", "http://evil.example"]) {
      expect(decideOrigin({ ...base, method: "POST", path: "/chat/conversations", origin }).allowed).toBe(false);
    }
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

  test("HEAD is treated as GET, not as safe", () => {
    // Hono routes HEAD to the `app.get` handler and RUNS it, so exempting HEAD
    // skips the same side effect rather than a bodyless read.
    expect(isSideEffectingRequest("HEAD", "/chat/pending/t1")).toBe(true);
    expect(isSideEffectingRequest("HEAD", "/api/research/ask")).toBe(true);
    // ...while an ordinary HEAD stays safe — the two read-only app.on("HEAD")
    // report/spec routes must not start 403ing.
    expect(isSideEffectingRequest("HEAD", "/chat/reports/bot/user/AB-1")).toBe(false);
    expect(decideOrigin({ ...base, method: "HEAD", path: "/chat/pending/t1", secFetchSite: "cross-site" }).allowed).toBe(false);
  });

  test("the wiki egress GETs are on the list — model spend, and two reach the live web", () => {
    for (const path of [
      "/api/wiki/ask", "/api/wiki/digest", "/api/wiki/explain",
      "/api/wiki/factcheck", "/api/wiki/factcheck/claim",
    ]) {
      expect(isSideEffectingRequest("GET", path), path).toBe(true);
      expect(decideOrigin({ ...base, method: "GET", path, secFetchSite: "cross-site" }).allowed, path).toBe(false);
    }
    // The pending alias `src/index.ts` 301s from is listed too.
    expect(isSideEffectingRequest("GET", "/simulator/pending/t1")).toBe(true);
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
// The server is bound FIRST, because the middleware needs the real port: the
// accepted set is derived from configuration, never from the request's own
// `Host` header. A late `handler` binding is what lets both happen in order.
let handler: (req: Request, srv: unknown) => Response | Promise<Response>;
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req, srv) => handler(req, srv) });
const PORT = Number(server.port);
afterAll(() => server.stop(true));

const app = new Hono();
app.use("*", createAuthMiddleware(CONFIG));
app.use("*", createOriginMiddleware(CONFIG.allowedOrigins, PORT));
app.post("/chat/conversations", (c) => c.json({ ok: true }));
let consumed = 0;
app.get("/chat/pending/:threadId", (c) => { consumed++; return c.json({ consumed, id: c.req.param("threadId") }); });
app.get("/api/wiki/digest", (c) => c.json({ spent: true }));
app.get("/chat/bots", (c) => c.json({ ok: true }));
handler = (req, srv) => app.fetch(req, srv as never);

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

  test("HEAD on the one-time consume is refused, and the handler does NOT run", async () => {
    // The defect this replaces: HEAD was exempt, Hono ran the GET handler
    // anyway, and a cross-site `fetch(…, {method:"HEAD", mode:"no-cors"})`
    // destroyed the victim's pending message while answering 200.
    const before = consumed;
    const raw = await rawRequest("/chat/pending/victim", { "Sec-Fetch-Site": "cross-site" }, "HEAD");
    expect(status(raw)).toBe(403);
    expect(consumed, "the GET handler ran for a refused HEAD").toBe(before);
  });

  test("a cross-site GET on a wiki egress route is refused before any model spend", async () => {
    expect(status(await rawRequest("/api/wiki/digest", { "Sec-Fetch-Site": "cross-site" }))).toBe(403);
  });

  test("a forged Host cannot make an attacker origin look like ours", async () => {
    // Measured on a live server before the fix: `Host: evil.example:<port>`
    // with a matching Origin created a real conversation, because the check
    // compared the request against ITSELF. Both spellings must be refused.
    for (const host of [`evil.example:${PORT}`, "evil.example"]) {
      const raw = await rawRequest(
        "/chat/conversations",
        { Host: host, Origin: `http://${host}`, "Content-Type": "application/json" },
        "POST",
        "{}",
      );
      expect(status(raw), host).toBe(403);
    }
  });
});
