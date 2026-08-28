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

  /**
   * The state space, enumerated rather than patched case by case.
   *
   * `global` can be written into a Vertex URL in three POSITIONS — as a host
   * prefix, as the ABSENCE of one (the region-less host, which IS the global
   * endpoint), and in the resource path — and each is spelled four ways: plain,
   * percent-escaped, uppercase, trailing dot. Twelve cells. Three rounds of
   * review found three of them one at a time (`%67lobal` in the path, `global.`
   * in the path, the dot on the host), which is what a per-finding fix looks
   * like when the space is small enough to just write down.
   *
   * Eight of the twelve are independent pins: all four path cells, and the
   * `plain` and `dotted` host cells. The percent and uppercase HOST cells are
   * not — `new URL()` maps them byte-identically onto their `plain` sibling, so
   * they document the input space rather than test anything new. (That is true
   * of the `https:` URLs here. It is NOT true in general: a non-special scheme's
   * host stays opaque and verbatim, which is what `normalizes a host the URL
   * parser leaves alone` covers.)
   *
   * Each position carries its own DOOR pattern, in the same object rather than a
   * lookup table beside it. Keyed separately, renaming a position silently made
   * `DOOR[position]` undefined — and `toThrow(undefined)` passes for any throw,
   * so all four path cells stopped asserting a door while staying green.
   */
  const PATH = (r: string) => `/v1/projects/p/locations/${r}/endpoints/openapi`;
  const POSITIONS = [
    {
      name: "host, `global-` prefix",
      // Anchored on the PARENTHESISED clause. Two looser patterns were tried and
      // rejected by mutation, both matching every refusal: `/global/` (the
      // message opens "names the `global` Vertex region") and a bare
      // `/in the path/` (the remedy sentence ends "…/locations/<region>/ in the
      // path"). With those, a path cell whose host ALSO said `global` passed
      // while measuring the host door — the defect review found in round 1.
      door: /\(host prefix\)/,
      urls: {
        plain: `https://global-aiplatform.googleapis.com${PATH("europe-north1")}`,
        percent: `https://%67lob%61l-aiplatform.googleapis.com${PATH("europe-north1")}`,
        upper: `https://GLOBAL-aiplatform.googleapis.com${PATH("europe-north1")}`,
        // A trailing dot belongs to the whole HOSTNAME, so for the host
        // positions that spelling is the dot at the END — not one spliced into a
        // label, which is a different name and no route at all.
        dotted: `https://global-aiplatform.googleapis.com.${PATH("europe-north1")}`,
      },
    },
    {
      name: "host, region-less (IS the global endpoint)",
      door: /\(the region-less host IS the global endpoint\)/,
      urls: {
        plain: `https://aiplatform.googleapis.com${PATH("europe-north1")}`,
        percent: `https://%61iplatform.googleapis.com${PATH("europe-north1")}`,
        upper: `https://AIPLATFORM.GOOGLEAPIS.COM${PATH("europe-north1")}`,
        dotted: `https://aiplatform.googleapis.com.${PATH("europe-north1")}`,
      },
    },
    {
      name: "path",
      door: /\(\/locations\/global\/ in the path\)/,
      urls: {
        plain: `https://europe-north1-aiplatform.googleapis.com${PATH("global")}`,
        percent: `https://europe-north1-aiplatform.googleapis.com${PATH("%67lob%61l")}`,
        upper: `https://europe-north1-aiplatform.googleapis.com${PATH("GLOBAL")}`,
        dotted: `https://europe-north1-aiplatform.googleapis.com${PATH("global.")}`,
      },
    },
  ] as const;

  for (const { name, door, urls } of POSITIONS) {
    for (const [spelling, url] of Object.entries(urls)) {
      test(`refuses \`global\` in the ${name}, written ${spelling}`, () => {
        expect(() => assertVertexEndpointAllowed(url, "bot")).toThrow(door);
      });
    }
  }

  test("the table still has twelve cells", () => {
    // The two ways this enumeration can stop enumerating, neither of which any
    // individual case can see: delete a position, or empty its `urls`. Both left
    // the file at 36 pass / 0 fail — fewer tests, all green, and a docstring
    // still claiming twelve.
    expect(POSITIONS).toHaveLength(3);
    expect(POSITIONS.flatMap((p) => Object.keys(p.urls))).toHaveLength(12);
  });

  test("each door pattern discriminates — it must not match another position's refusal", () => {
    // The last route to a door that asserts nothing. Anchoring the patterns
    // closed the two loose ones a reviewer happened to try; a permissive regex
    // (`/./`) still passed all twelve cells. This makes the discrimination a
    // property the suite checks rather than one a past reviewer remembers.
    const refusalFor = (url: string): string => {
      try {
        assertVertexEndpointAllowed(url, "bot");
      } catch (err) {
        return (err as Error).message;
      }
      throw new Error(`expected a refusal for ${url}`);
    };
    for (const position of POSITIONS) {
      expect(refusalFor(position.urls.plain)).toMatch(position.door);
      for (const other of POSITIONS) {
        if (other.name === position.name) continue;
        expect(refusalFor(other.urls.plain)).not.toMatch(position.door);
      }
    }
  });

  test("normalizes a host the URL parser leaves alone", () => {
    // `URL.hostname` lowercases a SPECIAL scheme's host and leaves a non-special
    // scheme's host opaque and verbatim (measured). Nothing validates a bot's
    // `baseUrl` scheme, so `hostOf` lowercases rather than trusting the parser
    // to have done it. Not a live exploit — the connector could not fetch such a
    // URL — but it is the only input that can tell that call from its absence,
    // and an expression no test can distinguish is one someone deletes later.
    expect(isVertexEndpoint("foo://EUROPE-NORTH1-AIPLATFORM.GOOGLEAPIS.COM/v1")).toBe(true);
    expect(() => assertVertexEndpointAllowed(
      "foo://AIPLATFORM.GOOGLEAPIS.COM/v1/projects/p/locations/europe-north1/endpoints/openapi", "bot",
    )).toThrow(/\(the region-less host IS the global endpoint\)/);
  });

  test("and a legitimate region survives every one of those rewritings", () => {
    // The other direction: normalization must not start refusing real URLs.
    for (const url of [
      "https://europe-north1-aiplatform.googleapis.com/v1/projects/p/locations/europe-north1/endpoints/openapi",
      "https://EUROPE-NORTH1-aiplatform.googleapis.com/v1/projects/p/locations/EUROPE-NORTH1/endpoints/openapi",
      "https://europe-north1-aiplatform.googleapis.com./v1/projects/p/locations/europe-north1./endpoints/openapi",
      "https://aiplatform.eu.rep.googleapis.com/v1/projects/p/locations/eu/endpoints/openapi",
      // Percent-escaped, so the decode half is covered in this direction too:
      // over-refusal is the failure mode a decoding guard invites.
      "https://europe-north1-aiplatform.googleapis.com/v1/projects/p/locations/europe%2Dnorth1/endpoints/openapi",
    ]) {
      expect(isVertexEndpoint(url)).toBe(true);
      expect(() => assertVertexEndpointAllowed(url, "bot")).not.toThrow();
    }
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

  test("a caller that JOINED a flight reports that flight's generation, not a later one", async () => {
    // The other end of the hand-off the round self-caught for the flight
    // STARTER. A joiner that reported the current generation would have its 401
    // pass the superseded check and throw away the good token another turn had
    // just installed.
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const p = new VertexTokenProvider(async () => {
      const n = ++calls;
      if (n === 1) await gate;
      return token(`t${n}`, 1_000_000 + 3_600_000);
    });
    const starter = p.acquire(1_000_000);   // starts flight 1
    const joiner = p.acquire(1_000_000);    // joins flight 1
    p.invalidate(0);                        // generation → 1, flight 1 detached
    release();
    expect((await starter).generation).toBe(0);
    expect((await joiner).generation).toBe(0);
    expect((await joiner).token).toBe("t1");
    expect(calls).toBe(1);
  });

  test("a cached read reports the CURRENT generation", async () => {
    let calls = 0;
    const p = new VertexTokenProvider(async () => token(`t${++calls}`, 1_000_000 + 3_600_000));
    const first = await p.acquire(1_000_000);
    p.invalidate(first.generation);
    const second = await p.acquire(1_000_000);   // fetched
    const cached = await p.acquire(1_000_000);   // served from cache
    expect(cached.token).toBe(second.token);
    expect(cached.generation).toBe(second.generation);
    expect(calls).toBe(2);
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
