import { describe, expect, test } from "bun:test";
import {
  isVertexEndpoint,
  assertVertexEndpointAllowed,
  VertexTokenProvider,
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
    expect(await p.get(1_000_000)).toBe("t1");
    expect(await p.get(1_100_000)).toBe("t1");
    expect(calls).toBe(1);
  });

  test("refreshes BEFORE expiry, not after", async () => {
    let calls = 0;
    // Expires at 1_060_000; the margin is 2 min, so 1_000_000 is fine and
    // anything past 940_000 + margin is not. A request that STARTS just inside
    // the window still has to finish.
    const p = new VertexTokenProvider(async () => { calls++; return token(`t${calls}`, 1_060_000); });
    expect(await p.get(900_000)).toBe("t1");
    expect(await p.get(939_000)).toBe("t1");
    expect(await p.get(941_000)).toBe("t2");
    expect(calls).toBe(2);
  });

  test("invalidate() forces the next get() to fetch", async () => {
    let calls = 0;
    const p = new VertexTokenProvider(async () => { calls++; return token(`t${calls}`, 1_000_000 + 3_600_000); });
    expect(await p.get(1_000_000)).toBe("t1");
    p.invalidate();
    expect(await p.get(1_000_000)).toBe("t2");
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
    const all = Promise.all([p.get(1_000_000), p.get(1_000_000), p.get(1_000_000)]);
    release();
    expect(await all).toEqual(["t1", "t1", "t1"]);
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
      calls++;
      if (calls === 1) await gate;
      return token(`t${calls}`, 1_000_000 + 3_600_000);
    });
    const joined = p.get(1_000_000);        // starts flight 1
    p.invalidate();                          // the 401 handler fires mid-flight
    release();
    await joined;
    expect(await p.get(1_000_000)).toBe("t2");
    // …and the stale flight must not have re-installed itself behind us.
    expect(await p.get(1_000_000)).toBe("t2");
    expect(calls).toBe(2);
  });

  test("a token that lands already inside the margin is returned, not refetched", async () => {
    // A source handing over a token near its end is the ORDINARY refresh, not an
    // error: refetching on it fetched twice on every roll and fixed nothing.
    let calls = 0;
    const p = new VertexTokenProvider(async () => { calls++; return token(`t${calls}`, 1_000_000); });
    expect(await p.get(1_000_000)).toBe("t1");
    expect(calls).toBe(1);
  });

  test("a failed fetch does not wedge the provider", async () => {
    let calls = 0;
    const p = new VertexTokenProvider(async () => {
      calls++;
      if (calls === 1) throw new Error("no credential");
      return token("t2", 1_000_000 + 3_600_000);
    });
    await expect(p.get(1_000_000)).rejects.toThrow(/no credential/);
    expect(await p.get(1_000_000)).toBe("t2");
  });
});
