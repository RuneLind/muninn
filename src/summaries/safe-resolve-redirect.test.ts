import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { safeResolveRedirect, type SafeResolveOptions } from "./safe-fetch.ts";

/**
 * `safeResolveRedirect` against a fake shortener: ONE hop, the `Location`
 * judged again, the body never read. Hostnames are invented and resolved by a
 * stub; `fetchImpl` sends each request to the loopback server below (the
 * `safe-fetch.test.ts` seams).
 */

let server: ReturnType<typeof Bun.serve>;
let port = 0;
/** Requests the fake answered, by path. */
let hits: string[] = [];

/** A REAL public address (example.com's): the guard passes it. */
const PUBLIC_ADDR = "93.184.216.34";

const lookup = async (hostname: string): Promise<string[]> =>
  ({ "t.co": [PUBLIC_ADDR], "pub.test": [PUBLIC_ADDR], "inside.test": ["127.0.0.1"] })[hostname] ?? [];

function localFetch(): typeof fetch {
  return (async (input: Request | string | URL, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input.toString());
    u.hostname = "127.0.0.1";
    u.protocol = "http:";
    u.port = String(port);
    return fetch(u.toString(), init);
  }) as unknown as typeof fetch;
}

const opts = (extra: SafeResolveOptions = {}): SafeResolveOptions => ({ lookup, fetchImpl: localFetch(), ...extra });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      hits.push(path);
      if (path === "/one") return new Response(null, { status: 301, headers: { location: "https://pub.test/two" } });
      // The target redirects again — never followed.
      if (path === "/two") return new Response(null, { status: 302, headers: { location: "https://pub.test/three" } });
      if (path === "/relative") return new Response(null, { status: 302, headers: { location: "/landing?x=1" } });
      if (path === "/inside") return new Response(null, { status: 301, headers: { location: "https://inside.test/admin" } });
      if (path === "/scheme") return new Response(null, { status: 301, headers: { location: "file:///etc/passwd" } });
      if (path === "/page") return new Response("<html>a page</html>", { headers: { "content-type": "text/html" } });
      if (path === "/nolocation") return new Response(null, { status: 302 });
      if (path === "/slow") {
        await Bun.sleep(2_000);
        return new Response(null, { status: 301, headers: { location: "https://pub.test/late" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  port = server.port!;
});

afterAll(() => {
  server.stop(true);
});

describe("safeResolveRedirect", () => {
  test("answers the first Location and makes exactly one request", async () => {
    hits = [];
    expect(await safeResolveRedirect("https://t.co/one", opts())).toBe("https://pub.test/two");
    expect(hits).toEqual(["/one"]);
  });

  test("a relative Location is resolved against the short URL", async () => {
    expect(await safeResolveRedirect("https://t.co/relative", opts())).toBe("https://t.co/landing?x=1");
  });

  test("the body is never read", async () => {
    let pulled = false;
    // Finite, so a reader that does read it fails this test rather than hanging.
    const body = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          pulled = true;
          c.enqueue(new TextEncoder().encode("x".repeat(1024)));
          c.close();
        },
      },
      { highWaterMark: 0 },
    );
    const fetchImpl = (async () =>
      new Response(body, { status: 301, headers: { location: "https://pub.test/target" } })) as unknown as typeof fetch;
    expect(await safeResolveRedirect("https://t.co/streams", { lookup, fetchImpl })).toBe("https://pub.test/target");
    expect(pulled).toBe(false);
  });

  test("a Location on a non-public address is refused", async () => {
    expect(await safeResolveRedirect("https://t.co/inside", opts())).toBeNull();
  });

  test("a Location with a refused scheme is refused", async () => {
    expect(await safeResolveRedirect("https://t.co/scheme", opts())).toBeNull();
  });

  test("a short URL on a non-public address is never requested", async () => {
    hits = [];
    expect(await safeResolveRedirect("https://inside.test/one", opts())).toBeNull();
    expect(hits).toEqual([]);
  });

  test("a 200, a 404 and a 3xx with no Location are null", async () => {
    expect(await safeResolveRedirect("https://t.co/page", opts())).toBeNull();
    expect(await safeResolveRedirect("https://t.co/missing", opts())).toBeNull();
    expect(await safeResolveRedirect("https://t.co/nolocation", opts())).toBeNull();
  });

  test("a shared budget that runs out gives up, well before the server answers", async () => {
    const budget = new AbortController();
    setTimeout(() => budget.abort(), 100);
    const started = Date.now();
    expect(await safeResolveRedirect("https://t.co/slow", opts({ signal: budget.signal }))).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  test("its own timeout applies without a shared signal", async () => {
    const started = Date.now();
    expect(await safeResolveRedirect("https://t.co/slow", opts({ timeoutMs: 100 }))).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_500);
  });
});
