import { afterEach, describe, expect, test } from "bun:test";
import {
  isVertexEndpoint,
  assertVertexEndpointAllowed,
  VertexTokenProvider,
  defaultVertexTokenFetcher,
  type VertexAccessToken,
} from "./vertex-access.ts";

const REGIONAL = "https://europe-north1-aiplatform.googleapis.com/v1/projects/p/locations/europe-north1/endpoints/openapi";
const MULTI = "https://aiplatform.eu.rep.googleapis.com/v1/projects/p/locations/eu/endpoints/openapi";

describe("isVertexEndpoint", () => {
  test("recognises the regional and multi-region hosts", () => {
    expect(isVertexEndpoint(REGIONAL)).toBe(true);
    expect(isVertexEndpoint(MULTI)).toBe(true);
    // The region-less host is Vertex too — recognised here so the refusal below
    // can fire. Not recognising it would let `global` through as "some other
    // OpenAI-compatible server" and authenticate it with OPENAI_API_KEY.
    expect(isVertexEndpoint("https://aiplatform.googleapis.com/v1/projects/p/locations/global/endpoints/openapi")).toBe(true);
  });

  test("leaves every other baseUrl on the static-key path", () => {
    for (const url of [
      "http://localhost:11434/v1",
      "https://api.openai.com/v1",
      "https://aiplatform.googleapis.com.example.com/v1",
      "https://notaiplatform.googleapis.com/v1",
      "not a url at all",
    ]) {
      expect(isVertexEndpoint(url)).toBe(false);
    }
  });
});

describe("assertVertexEndpointAllowed", () => {
  test("accepts a named region, host and path agreeing", () => {
    expect(() => assertVertexEndpointAllowed(REGIONAL, "bot")).not.toThrow();
    expect(() => assertVertexEndpointAllowed(MULTI, "bot")).not.toThrow();
  });

  test("refuses the region-less host — it IS the global endpoint", () => {
    expect(() => assertVertexEndpointAllowed(
      "https://aiplatform.googleapis.com/v1/projects/p/locations/europe-north1/endpoints/openapi", "bot",
    )).toThrow(/global/);
  });

  test("refuses a `global` host prefix", () => {
    // The PATH here names a real region on purpose. With `/locations/global/` in
    // it, the path door threw first and this case passed with the host check
    // deleted — it was testing the wrong door.
    expect(() => assertVertexEndpointAllowed(
      "https://global-aiplatform.googleapis.com/v1/projects/p/locations/europe-north1/endpoints/openapi", "bot",
    )).toThrow(/global/);
  });

  test("refuses a PERCENT-ENCODED `global` in the path — Google decodes it, so we must", () => {
    // Measured against the live endpoint: `%67lobal` and `global` address the
    // same resource and both answer 200. A raw compare refused one spelling and
    // minted a bearer token for the other.
    for (const encoded of ["%67lobal", "glob%61l", "%67%6c%6f%62%61%6c", "GLOB%61L"]) {
      expect(() => assertVertexEndpointAllowed(
        `https://europe-north1-aiplatform.googleapis.com/v1/projects/p/locations/${encoded}/endpoints/openapi`, "bot",
      )).toThrow(/global/);
    }
  });

  test("refuses a TRAILING-DOT `global` — the same request, differently written", () => {
    // `URL.pathname` keeps the dot, so `global.` compared unequal to `global`
    // and walked through the one door this guard has in the path. It reaches the
    // same 200 the refused spellings do; a door that admits it is not a door.
    for (const dotted of ["global.", "global..", "GLOBAL."]) {
      expect(() => assertVertexEndpointAllowed(
        `https://europe-north1-aiplatform.googleapis.com/v1/projects/p/locations/${dotted}/endpoints/openapi`, "bot",
      )).toThrow(/global/);
    }
  });

  test("a path segment that cannot be decoded is not a reason to refuse", () => {
    // A lone `%` throws in `decodeURIComponent`, and such a segment cannot mean
    // `global` on Google's side either.
    expect(() => assertVertexEndpointAllowed(
      "https://europe-north1-aiplatform.googleapis.com/v1/projects/p/locations/%/endpoints/openapi", "bot",
    )).not.toThrow();
  });

  test("refuses `global` in the RESOURCE PATH behind a regional host", () => {
    // The second door, and the one a regional-looking URL hides: Vertex takes
    // the path as authoritative for the resource, so this really does route to
    // `global` however European the hostname reads.
    expect(() => assertVertexEndpointAllowed(
      "https://europe-north1-aiplatform.googleapis.com/v1/projects/p/locations/global/endpoints/openapi", "bot",
    )).toThrow(/global/);
  });

  test("names the bot, so the message points at the config that has to change", () => {
    expect(() => assertVertexEndpointAllowed(
      "https://aiplatform.googleapis.com/v1/projects/p/locations/global/endpoints/openapi", "somebot",
    )).toThrow(/somebot/);
  });

  test("is silent about non-Vertex URLs", () => {
    expect(() => assertVertexEndpointAllowed("http://localhost:11434/v1/locations/global", "bot")).not.toThrow();
  });
});

describe("VertexTokenProvider", () => {
  const token = (t: string, expiresAtMs: number): VertexAccessToken =>
    ({ token: t, expiresAtMs, source: "gcloud-adc" });

  test("caches while the token is comfortably alive", async () => {
    let calls = 0;
    const p = new VertexTokenProvider(async () => { calls++; return token(`t${calls}`, 1_000_000 + 3_600_000); });
    expect((await p.acquire(1_000_000)).token).toBe("t1");
    expect((await p.acquire(1_100_000)).token).toBe("t1");
    expect(calls).toBe(1);
  });

  test("refreshes BEFORE expiry, not after", async () => {
    let calls = 0;
    // Expires at 1_060_000; the margin is 2 min, so 1_000_000 is fine and
    // anything past 940_000 + margin is not. A request that STARTS just inside
    // the window still has to finish.
    const p = new VertexTokenProvider(async () => { calls++; return token(`t${calls}`, 1_060_000); });
    expect((await p.acquire(900_000)).token).toBe("t1");
    expect((await p.acquire(939_000)).token).toBe("t1");
    expect((await p.acquire(941_000)).token).toBe("t2");
    expect(calls).toBe(2);
  });

  test("invalidate() forces the next get() to fetch", async () => {
    let calls = 0;
    const p = new VertexTokenProvider(async () => { calls++; return token(`t${calls}`, 1_000_000 + 3_600_000); });
    expect((await p.acquire(1_000_000)).token).toBe("t1");
    p.invalidate(0);
    expect((await p.acquire(1_000_000)).token).toBe("t2");
    expect(calls).toBe(2);
  });

  test("single-flights concurrent misses", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const p = new VertexTokenProvider(async () => {
      calls++;
      await gate;
      return token(`t${calls}`, 1_000_000 + 3_600_000);
    });
    const all = Promise.all([p.acquire(1_000_000), p.acquire(1_000_000), p.acquire(1_000_000)]);
    release();
    expect((await all).map((a) => a.token)).toEqual(["t1", "t1", "t1"]);
    expect(calls).toBe(1);
  });

  test("invalidate() DURING an in-flight fetch is honoured, not swallowed", async () => {
    // The 401 path: a request fails while another turn is already refreshing.
    // Clearing only the cache made invalidate() a no-op here — the landing
    // flight re-installed the very token that had just been refused.
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const p = new VertexTokenProvider(async () => {
      const n = ++calls;
      if (n === 1) await gate;
      return token(`t${n}`, 1_000_000 + 3_600_000);
    });
    const joined = p.acquire(1_000_000);     // starts flight 1
    p.invalidate(0);                          // the 401 handler fires mid-flight
    release();
    await joined;
    expect((await p.acquire(1_000_000)).token).toBe("t2");
    // …and the stale flight must not have re-installed itself behind us.
    expect((await p.acquire(1_000_000)).token).toBe("t2");
    expect(calls).toBe(2);
  });

  test("a token that lands already inside the margin is returned, not refetched", async () => {
    // A source handing over a token near its end is the ORDINARY refresh, not an
    // error: refetching on it fetched twice on every roll and fixed nothing.
    let calls = 0;
    const p = new VertexTokenProvider(async () => { calls++; return token(`t${calls}`, 1_000_000); });
    expect((await p.acquire(1_000_000)).token).toBe("t1");
    expect(calls).toBe(1);
  });

  test("invalidate() DETACHES the flight, so an acquire during it does not adopt the refused token", async () => {
    // The sibling case above proves the cache is cleared. This one proves the
    // other half: a caller arriving while the invalidated flight is STILL
    // outstanding must not join it. Deleting `#inFlight = null` from
    // `invalidate()` leaves every other case green while restoring the bug.
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const p = new VertexTokenProvider(async () => {
      // `n` is captured BEFORE the await: reading `calls` afterwards renames the
      // gated fetch to whatever the counter reached while it was suspended.
      const n = ++calls;
      if (n === 1) await gate;
      return token(`t${n}`, 1_000_000 + 3_600_000);
    });
    const started = p.acquire(1_000_000);   // flight 1, still in the air
    p.invalidate(0);
    const during = p.acquire(1_000_000);    // must NOT join flight 1
    release();
    const first = await started;
    expect(first.token).toBe("t1");
    expect((await during).token).toBe("t2");
    expect(calls).toBe(2);
    // And it must report ITS OWN flight's generation, not whatever the counter
    // reached while it was in the air. Reporting the current one would let this
    // caller's 401 pass the superseded check and throw away the GOOD token the
    // refresh it slept through had just installed.
    expect(first.generation).toBe(0);
    expect((await during).generation).toBe(1);
  });

  test("a BURST of 401s costs one refresh, not one per caller", async () => {
    // Every turn holding the same expired token reports the same generation.
    // Detaching unconditionally made each of them throw away the refresh the
    // previous one had just started — five ~700ms subprocesses on the gcloud
    // path, four of the five tokens discarded unwritten.
    let calls = 0;
    const p = new VertexTokenProvider(async () => {
      calls++;
      return token(`t${calls}`, 1_000_000 + 3_600_000);
    });
    const held = await p.acquire(1_000_000);
    expect(held.token).toBe("t1");
    const refreshed = await Promise.all(Array.from({ length: 5 }, async () => {
      p.invalidate(held.generation);        // all five report the SAME token
      return (await p.acquire(1_000_000)).token;
    }));
    expect(refreshed).toEqual(["t2", "t2", "t2", "t2", "t2"]);
    expect(calls).toBe(2);
  });

  test("a SECOND 401, on the token the first refresh produced, refreshes again", async () => {
    // The generation a caller reports has to be the one its own flight was
    // started at. Read off the provider before the flight started instead, it
    // was one behind — so the second `invalidate()` compared as superseded, did
    // nothing, and the retry re-sent the token that had just been refused.
    let calls = 0;
    const p = new VertexTokenProvider(async () => token(`t${++calls}`, 1_000_000 + 3_600_000));
    const first = await p.acquire(1_000_000);
    p.invalidate(first.generation);
    const second = await p.acquire(1_000_000);
    expect(second.token).toBe("t2");
    p.invalidate(second.generation);
    expect((await p.acquire(1_000_000)).token).toBe("t3");
    expect(calls).toBe(3);
  });

  test("a failed fetch does not wedge the provider", async () => {
    let calls = 0;
    const p = new VertexTokenProvider(async () => {
      calls++;
      if (calls === 1) throw new Error("no credential");
      return token("t2", 1_000_000 + 3_600_000);
    });
    await expect(p.acquire(1_000_000)).rejects.toThrow(/no credential/);
    expect((await p.acquire(1_000_000)).token).toBe("t2");
  });
});

describe("defaultVertexTokenFetcher — the metadata server", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  function metadataAnswers(body: unknown) {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("metadata.google.internal")) return Promise.resolve(Response.json(body));
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;
  }

  /**
   * The TTL is stamped as `Date.now() + ttl` inside the fetcher, at a moment
   * between these two reads — so the assertion has to be a window, not a point.
   * Written as a point first, it failed on roughly one run in six: 1_800_001.
   */
  async function ttlOf(body: unknown): Promise<{ min: number; max: number }> {
    metadataAnswers(body);
    const before = Date.now();
    const t = await defaultVertexTokenFetcher();
    const after = Date.now();
    expect(t.source).toBe("metadata-server");
    expect(t.token).toBe("from-metadata");
    return { min: t.expiresAtMs - after, max: t.expiresAtMs - before };
  }

  test("honours a sane expires_in", async () => {
    const { min, max } = await ttlOf({ access_token: "from-metadata", expires_in: 1800 });
    expect(min).toBeLessThanOrEqual(1_800_000);
    expect(max).toBeGreaterThanOrEqual(1_800_000);
    expect(max - min).toBeLessThan(5_000);
  });

  test("CLAMPS an absurd expires_in to one hour — otherwise one token is pinned for the process lifetime", async () => {
    const { min, max } = await ttlOf({ access_token: "from-metadata", expires_in: 1e12 });
    expect(min).toBeLessThanOrEqual(60 * 60_000);
    expect(max).toBeGreaterThanOrEqual(60 * 60_000);
  });

  test("falls back to the conservative window when expires_in is absent or nonsense", async () => {
    for (const expires_in of [undefined, "3600", -5, 0]) {
      const { min, max } = await ttlOf({ access_token: "from-metadata", expires_in });
      expect(min).toBeLessThanOrEqual(30 * 60_000);
      expect(max).toBeGreaterThanOrEqual(30 * 60_000);
    }
  });
});
