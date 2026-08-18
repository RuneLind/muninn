import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { configure, reset, type LogRecord } from "@logtape/logtape";
import { safeFetchText, type SafeFetchOptions } from "./safe-fetch.ts";

/**
 * The helper refuses by ADDRESS, so nothing local is reachable by its real name —
 * every test that needs a real server therefore injects the two documented test
 * seams: `lookup` (a stub resolving the public-looking `pub.test` to `PUBLIC_ADDR`,
 * a genuinely public address the guard passes — the documentation ranges are all
 * blocked now, so a TEST-NET stand-in would be testing the refusal path) and
 * `fetchImpl` (rewriting the host onto the loopback server that actually answers).
 * The bytes, the redirect hops, the content-type and the streaming cap are all
 * REAL — only the socket's destination is redirected.
 */

let server: ReturnType<typeof Bun.serve>;
let port = 0;

/** Refusal warnings emitted by the helper, captured per test via `warnings.length = 0`. */
const warnings: LogRecord[] = [];

// A REAL public address (example.com's). Deliberately not one of the documentation
// ranges — TEST-NET-1/2/3 are themselves blocked, so a test using 203.0.113.x as its
// "public" stand-in would have been testing the refusal path by accident.
const PUBLIC_ADDR = "93.184.216.34";

function stubLookup(map: Record<string, string[]>) {
  return async (hostname: string): Promise<string[]> => map[hostname] ?? [];
}

/** Test seam: send the request to the loopback server whatever host was checked. */
function localFetch(): typeof fetch {
  return (async (input: Request | string | URL, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input.toString());
    u.hostname = "127.0.0.1";
    u.port = String(port);
    return fetch(u.toString(), init);
  }) as unknown as typeof fetch;
}

/** Wraps the loopback fetch to count the bytes the helper actually PULLS. */
function countingFetch(counter: { bytes: number }): typeof fetch {
  const inner = localFetch();
  return (async (input: Request | string | URL, init?: RequestInit) => {
    const res = await inner(input as string, init);
    if (!res.body) return res;
    const reader = res.body.getReader();
    const counted = new ReadableStream({
      async pull(c) {
        const { done, value } = await reader.read();
        if (done || !value) return c.close();
        counter.bytes += value.byteLength;
        c.enqueue(value);
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return new Response(counted, { status: res.status, headers: res.headers });
  }) as unknown as typeof fetch;
}

/**
 * What the SERVER saw on `/endless` — the only vantage point from which socket
 * teardown is visible. The client-side counter is a wrapper around the response
 * body and cannot see whether the socket is still being drained underneath it.
 */
const endless = { bytes: 0, aborted: false };

function opts(extra: SafeFetchOptions = {}): SafeFetchOptions {
  return {
    lookup: stubLookup({ "pub.test": [PUBLIC_ADDR] }),
    fetchImpl: localFetch(),
    ...extra,
  };
}

function refusals(): string[] {
  return warnings.map((r) => r.message.join("") + JSON.stringify(r.properties ?? {}));
}

beforeAll(async () => {
  await configure({
    sinks: {
      capture: (r: LogRecord) => {
        if (r.category.join(".") === "muninn.summaries.safe-fetch") warnings.push(r);
      },
    },
    loggers: [
      { category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" },
      { category: ["logtape", "meta"], sinks: [], lowestLevel: "error" },
    ],
    reset: true,
  });

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      if (p === "/ok") {
        return new Response("<html>hello  world\n</html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (p === "/json") {
        return new Response('{"a":1}', { headers: { "content-type": "application/json" } });
      }
      if (p === "/binary") {
        // NB: the NULs are JS escapes, NOT literal bytes — one literal NUL in this
        // file makes git classify it as binary, and `gh pr diff` then renders the
        // whole test file as `Bin 0 -> N bytes` instead of a reviewable diff.
        return new Response("MZ\u0000\u0000not text", {
          headers: { "content-type": "application/octet-stream" },
        });
      }
      if (p === "/no-type") {
        // A BYTE body carries no implicit content-type, so this response really has
        // no content-type header at all — the case `application/octet-stream` does
        // not cover, and the one a misconfigured origin actually sends.
        return new Response(new TextEncoder().encode("hello"));
      }
      if (p === "/204") {
        return new Response(null, { status: 204, headers: { "content-type": "text/plain" } });
      }
      if (p === "/redirect-private") {
        return new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${port}/ok` },
        });
      }
      if (p === "/redirect-scheme") {
        return new Response(null, { status: 301, headers: { location: "file:///etc/passwd" } });
      }
      if (p === "/redirect-ok") {
        return new Response(null, { status: 302, headers: { location: "http://pub.test/ok" } });
      }
      if (p.startsWith("/chain")) {
        // A TERMINATING chain: /chain0 → /chain1 → /chain2 → /ok, i.e. exactly the
        // three hops docs.anthropic.com's `.md` rewrite walks in production.
        const n = Number(p.slice(6));
        const next = n >= 2 ? "http://pub.test/ok" : `http://pub.test/chain${n + 1}`;
        return new Response(null, { status: n === 0 ? 301 : 307, headers: { location: next } });
      }
      if (p.startsWith("/hop")) {
        const n = Number(p.slice(4));
        return new Response(null, {
          status: 302,
          headers: { location: `http://pub.test/hop${n + 1}` },
        });
      }
      if (p === "/big") {
        // Declared length, honestly served.
        const body = "x".repeat(5000);
        return new Response(body, {
          headers: { "content-type": "text/plain", "content-length": String(body.length) },
        });
      }
      if (p === "/stream") {
        // Chunked (no content-length) — only the streaming cap can stop this one.
        const chunk = new TextEncoder().encode("y".repeat(64 * 1024));
        let sent = 0;
        const target = 8 * 1024 * 1024;
        const stream = new ReadableStream({
          pull(controller) {
            if (sent >= target) return controller.close();
            controller.enqueue(chunk);
            sent += chunk.length;
          },
        });
        return new Response(stream, { headers: { "content-type": "text/plain" } });
      }
      if (p === "/endless") {
        // Never ends on its own: only the client giving up stops it. Counts what it
        // has enqueued and records whether the request was aborted, so the test can
        // assert TEARDOWN rather than "the client stopped reading".
        endless.bytes = 0;
        endless.aborted = false;
        req.signal.addEventListener("abort", () => {
          endless.aborted = true;
        });
        const chunk = new TextEncoder().encode("z".repeat(256 * 1024));
        // 128 MB is a TEST SAFETY VALVE, not the thing under test: without abort this
        // stream is pulled forever (cross-process it reached 52 GB in 5 s) and the
        // test file would never finish. The assertion is far below the valve.
        const valve = 128 * 1024 * 1024;
        const stream = new ReadableStream({
          // The `await` is load-bearing: with a SYNCHRONOUS pull the server enqueues
          // all 128 MB before the loop ever processes the client's abort, and the
          // measurement says nothing. Yielding per chunk is what makes teardown
          // observable — measured, abort stops it at 512 KB / ~320 ms, while
          // cancel-only runs to the valve and never sees `req.signal` fire at all.
          async pull(controller) {
            if (req.signal.aborted || endless.bytes >= valve) return controller.close();
            controller.enqueue(chunk);
            endless.bytes += chunk.length;
            await Bun.sleep(1);
          },
        });
        return new Response(stream, { headers: { "content-type": "text/plain" } });
      }
      if (p.startsWith("/five")) {
        // FOUR redirects then a 200 — the shape that a cap of 3 refuses. Pins the
        // cap at ≥5 (hop 0 is the first request, so 4 redirects need 5 fetches).
        const n = Number(p.slice(5));
        const next = n >= 3 ? "http://pub.test/ok" : `http://pub.test/five${n + 1}`;
        return new Response(null, { status: 302, headers: { location: next } });
      }
      if (p === "/500") return new Response("nope", { status: 500 });
      return new Response("not found", { status: 404 });
    },
  });
  port = server.port ?? 0;
});

afterAll(async () => {
  server?.stop(true);
  await reset();
});

function fresh() {
  warnings.length = 0;
}

describe("safeFetchText — the happy path", () => {
  test("a normal public 200 returns its text UNCHANGED and logs no refusal", async () => {
    fresh();
    const text = await safeFetchText("http://pub.test/ok", opts());
    expect(text).toBe("<html>hello  world\n</html>");
    expect(warnings.filter((w) => w.level === "warning")).toHaveLength(0);
  });

  test("application/json is allowed through the content-type gate", async () => {
    fresh();
    expect(await safeFetchText("http://pub.test/json", opts())).toBe('{"a":1}');
  });

  test("a redirect to another PUBLIC address is followed", async () => {
    fresh();
    expect(await safeFetchText("http://pub.test/redirect-ok", opts())).toBe(
      "<html>hello  world\n</html>",
    );
    expect(warnings.filter((w) => w.level === "warning")).toHaveLength(0);
  });
});

describe("safeFetchText — scheme refusals", () => {
  test.each(["file:///etc/passwd", "ftp://example.com/x", "gopher://x/1", "data:text/plain,hi"])(
    "%s is refused before any socket is opened",
    async (url) => {
      fresh();
      let called = false;
      const res = await safeFetchText(url, {
        ...opts(),
        fetchImpl: (() => {
          called = true;
          throw new Error("must not fetch");
        }) as unknown as typeof fetch,
      });
      expect(res).toBeNull();
      expect(called).toBe(false);
      expect(warnings).toHaveLength(1);
      expect(refusals().join()).toContain("scheme");
    },
  );

  test("an unparseable URL is refused", async () => {
    fresh();
    expect(await safeFetchText("not a url", opts())).toBeNull();
    expect(warnings).toHaveLength(1);
  });
});

describe("safeFetchText — resolved-address refusals", () => {
  const blocked: [string, string][] = [
    ["loopback v4", "127.0.0.1"],
    ["loopback v4, high octet", "127.1.2.3"],
    ["private 10/8", "10.0.0.5"],
    ["private 172.16/12", "172.20.3.4"],
    ["private 192.168/16", "192.168.1.1"],
    ["link-local 169.254/16 (cloud metadata)", "169.254.169.254"],
    ["CGNAT 100.64/10 (the tailnet)", "100.100.100.100"],
    ["this-network 0/8", "0.0.0.0"],
    ["loopback v6", "::1"],
    ["unique-local v6 fc00::/7", "fd00::1"],
    ["link-local v6 fe80::/10", "fe80::1234"],
    ["v6 unspecified", "::"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["IPv4-mapped metadata", "::ffff:169.254.169.254"],
    ["IPv4-mapped, hex form", "::ffff:7f00:1"],
    ["IPv4-compatible loopback", "::7f00:1"],
    // Reserved IPv4 blocks that are not private but are never a public article.
    ["IETF protocol assignments 192.0.0.0/24", "192.0.0.8"],
    ["TEST-NET-1 192.0.2.0/24", "192.0.2.5"],
    ["6to4 relay anycast 192.88.99.0/24", "192.88.99.1"],
    ["benchmarking 198.18.0.0/15 (low half)", "198.18.0.1"],
    ["benchmarking 198.18.0.0/15 (high half)", "198.19.255.254"],
    ["TEST-NET-2 198.51.100.0/24", "198.51.100.7"],
    ["TEST-NET-3 203.0.113.0/24", "203.0.113.10"],
    ["reserved 240.0.0.0/4", "240.0.0.1"],
    ["broadcast", "255.255.255.255"],
    // v4-in-v6 wrappers beyond ::ffff: — each one of these reaches a v4 destination
    // through a v6 literal, and each was ALLOWED before this round.
    ["NAT64 well-known 64:ff9b::/96 → loopback", "64:ff9b::7f00:1"],
    ["NAT64 well-known 64:ff9b::/96 → cloud metadata", "64:ff9b::a9fe:a9fe"],
    // 64:ff9b:1::/48 is refused WHOLESALE — RFC 8215 calls it local-use, so whatever
    // v4 an operator embedded in it is by definition not a public article. These three
    // are only illustrative of the forms; the third would have READ as public under a
    // per-slot unwrap and must still be refused.
    ["NAT64 local-use 64:ff9b:1::/48, /96-slot form", "64:ff9b:1::7f00:1"],
    ["NAT64 local-use 64:ff9b:1::/48, /48-slot form", "64:ff9b:1:7f00:0:100::"],
    ["NAT64 local-use 64:ff9b:1::/48, public-looking suffix", "64:ff9b:1::5db8:d822"],
    ["6to4 2002::/16 → loopback", "2002:7f00:1::"],
    ["6to4 2002::/16 → cloud metadata", "2002:a9fe:a9fe::"],
    ["IPv4-translated ::ffff:0:0:0/96 (RFC 2765) → loopback", "::ffff:0:7f00:1"],
    // v6 ranges that are never a public article on their own.
    ["site-local fec0::/10", "fec0::1"],
    ["Teredo 2001::/32", "2001::1"],
    ["discard-only 100::/64", "100::1"],
    ["ORCHIDv2 2001:20::/28", "2001:20::1"],
    // The v6 documentation/benchmarking ranges, for symmetry with the v4 list above:
    // nothing legitimate is served from them either.
    ["documentation 2001:db8::/32", "2001:db8::1"],
    ["documentation 3fff::/20 (RFC 9637), low", "3fff::1"],
    ["documentation 3fff::/20 (RFC 9637), high", "3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["benchmarking 2001:2::/48", "2001:2::1"],
    ["ORCHID 2001:10::/28 (deprecated)", "2001:10::1"],
  ];

  /**
   * The unwrapping must judge the embedded address, not blanket-refuse the wrapper:
   * a NAT64 or 6to4 literal carrying a PUBLIC v4 is a reachable public article and
   * has to stay reachable, or the fix trades an SSRF for a false refusal.
   */
  test.each([
    ["NAT64 well-known, public v4", "64:ff9b::5db8:d822"],
    ["6to4, public v4", "2002:5db8:d822::"],
    ["IPv4-mapped, public v4", "::ffff:93.184.216.34"],
  ])("a %s literal is NOT refused (%s)", async (_label, addr) => {
    fresh();
    let called = false;
    const res = await safeFetchText(`http://[${addr}]/x`, {
      lookup: async () => {
        throw new Error("must not resolve a literal");
      },
      fetchImpl: (() => {
        called = true;
        throw new Error("reached the socket");
      }) as unknown as typeof fetch,
    });
    // The address passed the guard — the only failure is the stub throwing at the socket.
    expect(called).toBe(true);
    expect(res).toBeNull();
    expect(refusals().join()).not.toContain("non-public address");
  });

  test.each(blocked)("a hostname resolving to %s is refused (%s)", async (_label, addr) => {
    fresh();
    let called = false;
    const res = await safeFetchText("http://target.test/x", {
      lookup: stubLookup({ "target.test": [addr] }),
      fetchImpl: (() => {
        called = true;
        throw new Error("must not fetch");
      }) as unknown as typeof fetch,
    });
    expect(res).toBeNull();
    expect(called).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(refusals().join()).toContain("address");
  });

  test.each(blocked)("the literal %s in the URL is refused without any DNS (%s)", async (_l, addr) => {
    fresh();
    const host = addr.includes(":") ? `[${addr}]` : addr;
    const res = await safeFetchText(`http://${host}/x`, {
      lookup: async () => {
        throw new Error("must not resolve a literal");
      },
      fetchImpl: (() => {
        throw new Error("must not fetch");
      }) as unknown as typeof fetch,
    });
    expect(res).toBeNull();
    expect(warnings).toHaveLength(1);
    // Assert the REASON, not just the null: a literal that slips past the address
    // guard still returns null here (the stub throws at the socket), so without this
    // the whole literal half of the table passes on a bypass.
    expect(refusals().join()).toContain("non-public address");
  });

  test("ONE blocked address among several refuses the whole host (split-horizon)", async () => {
    fresh();
    const res = await safeFetchText("http://target.test/x", {
      lookup: stubLookup({ "target.test": [PUBLIC_ADDR, "127.0.0.1"] }),
      fetchImpl: (() => {
        throw new Error("must not fetch");
      }) as unknown as typeof fetch,
    });
    expect(res).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  test("a host that resolves to nothing is refused", async () => {
    fresh();
    expect(
      await safeFetchText("http://nx.test/x", { lookup: stubLookup({}), fetchImpl: localFetch() }),
    ).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  test("a resolver that throws is a refusal, not a throw", async () => {
    fresh();
    const res = await safeFetchText("http://target.test/x", {
      lookup: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(res).toBeNull();
    expect(warnings).toHaveLength(1);
  });
});

describe("safeFetchText — redirect refusals", () => {
  test("a redirect to a PRIVATE address is refused AT THE HOP, once", async () => {
    fresh();
    const res = await safeFetchText("http://pub.test/redirect-private", opts());
    expect(res).toBeNull();
    expect(warnings).toHaveLength(1);
    // The log must name the hop, or the operator cannot tell this from a dead link.
    const line = refusals().join();
    expect(line).toContain("address");
    expect(line).toContain("127.0.0.1");
  });

  test("a redirect to a non-http scheme is refused", async () => {
    fresh();
    expect(await safeFetchText("http://pub.test/redirect-scheme", opts())).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(refusals().join()).toContain("scheme");
  });

  test("an endless redirect chain is refused at the hop cap", async () => {
    fresh();
    expect(await safeFetchText("http://pub.test/hop0", opts())).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(refusals().join()).toContain("redirect");
  });

  test("a THREE-hop chain (the docs.anthropic.com `.md` shape) is followed to the 200", async () => {
    fresh();
    expect(await safeFetchText("http://pub.test/chain0", opts())).toBe(
      "<html>hello  world\n</html>",
    );
    expect(warnings.filter((w) => w.level === "warning")).toHaveLength(0);
  });

  test("a FOUR-redirect chain still reaches its 200 at the default cap", async () => {
    fresh();
    // Pins SAFE_FETCH_MAX_REDIRECTS ≥ 5 against a revert to 3: the measured
    // `agents-and-tools/mcp.md` shape is 4 redirects, and at a cap of 3 it was
    // refused. Deliberately uses the DEFAULT cap — that is the constant at risk.
    expect(await safeFetchText("http://pub.test/five0", opts())).toBe(
      "<html>hello  world\n</html>",
    );
    expect(warnings.filter((w) => w.level === "warning")).toHaveLength(0);
    // …and the same chain IS refused once the cap is the old 3, so the test above
    // fails for the right reason if the constant moves back.
    fresh();
    expect(await safeFetchText("http://pub.test/five0", opts({ maxRedirects: 3 }))).toBeNull();
    expect(refusals().join()).toContain("redirect");
  });
});

describe("safeFetchText — content-type and size refusals", () => {
  test("a non-text content-type is refused BEFORE the body is read", async () => {
    fresh();
    expect(await safeFetchText("http://pub.test/binary", opts())).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(refusals().join()).toContain("content-type");
  });

  test("a response with NO content-type at all is refused (we do not sniff)", async () => {
    fresh();
    expect(await safeFetchText("http://pub.test/no-type", opts())).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(refusals().join()).toContain("content-type");
  });

  test("a 204 with an empty body returns the empty string, not null", async () => {
    fresh();
    const res = await safeFetchText("http://pub.test/204", opts());
    // The callers all do `text?.trim()`, so "" and null degrade identically for them —
    // but "" says the fetch SUCCEEDED and the page was empty, which the log should
    // not be claiming was a refusal.
    expect(res).toBe("");
    expect(res?.trim()).toBe("");
    expect(warnings.filter((w) => w.level === "warning")).toHaveLength(0);
  });

  test("a DECLARED content-length over the cap is truncated too, never refused", async () => {
    fresh();
    // The removed pre-check compared the WIRE length (usually gzip/brotli) against a
    // cap that measures the DECOMPRESSED body, so it fired unpredictably: live,
    // norvig.com/big.txt (6.5 MB of text/plain, brotli wire length 2 298 971) was
    // REFUSED while an equally large gzipped page truncated. The streaming cap is
    // the one that bounds the process.
    const res = await safeFetchText("http://pub.test/big", opts({ maxBytes: 1024 }));
    expect(res).not.toBeNull();
    expect(res!.length).toBe(1024);
    expect(warnings.filter((w) => w.level === "warning")).toHaveLength(0);
    expect(refusals().join()).toContain("Truncated");
  });

  test("an undeclared (chunked) body over the cap is TRUNCATED, not refused", async () => {
    fresh();
    const counter = { bytes: 0 };
    const res = await safeFetchText(
      "http://pub.test/stream",
      opts({ maxBytes: 512 * 1024, fetchImpl: countingFetch(counter) }),
    );
    // The regression this guards: refusing outright turned a 3 MB Wikipedia article
    // that used to be fetched-and-`capContent`ed into no enrichment at all. The cap
    // bounds the PROCESS; the prompt cap still trims what is returned.
    expect(res).not.toBeNull();
    expect(res!.length).toBe(512 * 1024);
    expect(res!.startsWith("yyyy")).toBe(true);
    expect(warnings.filter((w) => w.level === "warning")).toHaveLength(0);
    expect(refusals().join()).toContain("Truncated");
    // The whole point: of the 8 MB offered, the helper pulls the cap plus at most the
    // transport's read-ahead — `await res.text()` would have taken all 8 MB. (RSS is too
    // noisy to assert in-process; the 50 MB RSS check is the empirical script.)
    expect(counter.bytes).toBeLessThan(2 * 512 * 1024);
  });

  test("truncation TEARS DOWN the socket — the server stops being read from", async () => {
    fresh();
    const res = await safeFetchText("http://pub.test/endless", opts({ maxBytes: 256 * 1024 }));
    expect(res).not.toBeNull();
    expect(res!.length).toBe(256 * 1024);
    // `reader.cancel()` does NOT close a Bun fetch socket — measured cross-process
    // at this same 256 KB cap, the read returned in 8 ms and the server pushed 52 GB
    // over the next 5 s, stopping only when the client PROCESS exited. Only aborting
    // the request tears it down, and only the SERVER can see the difference: the
    // client-side byte counter is a wrapper and cannot observe the socket.
    const deadline = Date.now() + 2000;
    while (!endless.aborted && Date.now() < deadline) await Bun.sleep(20);
    expect(endless.aborted).toBe(true);
    const settled = endless.bytes;
    await Bun.sleep(200);
    expect(endless.bytes).toBe(settled);
    expect(settled).toBeLessThan(32 * 1024 * 1024);
  });

  test("a non-200 is refused", async () => {
    fresh();
    expect(await safeFetchText("http://pub.test/500", opts())).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(refusals().join()).toContain("500");
  });
});

describe("safeFetchText — never throws", () => {
  test("a transport failure returns null", async () => {
    fresh();
    const res = await safeFetchText("http://pub.test/ok", {
      ...opts(),
      fetchImpl: (async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
    });
    expect(res).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  test("a timeout returns null and is logged AS a timeout, not as a transport failure", async () => {
    fresh();
    const res = await safeFetchText("http://pub.test/ok", {
      ...opts(),
      timeoutMs: 1,
      fetchImpl: (async (_i: unknown, init?: RequestInit) =>
        await new Promise((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
        })) as unknown as typeof fetch,
    });
    expect(res).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(refusals().join()).toContain("timed out");
  });

  test("a failure AFTER a redirect names the hop URL, not the original", async () => {
    fresh();
    let n = 0;
    const res = await safeFetchText("http://pub.test/start", {
      ...opts(),
      fetchImpl: (async () => {
        if (n++ === 0) {
          return new Response(null, {
            status: 302,
            headers: { location: "http://pub.test/second" },
          });
        }
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
    });
    expect(res).toBeNull();
    const line = refusals().join();
    expect(line).toContain("/second");
    expect(line).not.toContain("/start");
  });

  test("a SLOW DNS lookup is cut off by the whole-operation timeout", async () => {
    fresh();
    // The doc comment claims the timeout "covers the whole operation". Before this
    // round the abort signal reached `fetch` only, so a resolver that took 3 s spent
    // 3 s under a 300 ms budget.
    const started = Date.now();
    const res = await safeFetchText("http://slow.test/x", {
      timeoutMs: 300,
      lookup: () =>
        new Promise<string[]>((resolve) => {
          const t = setTimeout(() => resolve([PUBLIC_ADDR]), 3000);
          (t as unknown as { unref?: () => void }).unref?.();
        }),
      fetchImpl: (() => {
        throw new Error("must not fetch");
      }) as unknown as typeof fetch,
    });
    const elapsed = Date.now() - started;
    expect(res).toBeNull();
    expect(elapsed).toBeLessThan(1500);
    expect(refusals().join()).toContain("timed out");
  });

  test("the caller label is in the refusal line, so a log names which fetch was blocked", async () => {
    fresh();
    const res = await safeFetchText("http://target.test/x", {
      caller: "enrichment",
      lookup: stubLookup({ "target.test": ["127.0.0.1"] }),
    });
    expect(res).toBeNull();
    expect(refusals().join()).toContain("enrichment");
  });
});
