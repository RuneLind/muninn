/**
 * The generic provider's own surface. The cache, refresh-margin, single-flight
 * and invalidate rules are pinned through the Vertex names in
 * `src/ai/vertex-access.test.ts`, which run this same class.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createAdcTokenFetcher, GcpTokenProvider, type GcpAccessToken } from "./access-token.ts";
import { VertexTokenProvider } from "../ai/vertex-access.ts";

describe("GcpTokenProvider", () => {
  test("caches one token across callers; Vertex's provider is the same class", async () => {
    let calls = 0;
    const p = new GcpTokenProvider(async (): Promise<GcpAccessToken> => {
      calls++;
      return { token: `t${calls}`, expiresAtMs: 10_000_000, source: "metadata-server" };
    }, "GCS");
    const [a, b] = await Promise.all([p.acquire(1_000), p.acquire(1_000)]);
    expect(a.token).toBe("t1");
    expect(b.token).toBe("t1");
    expect(calls).toBe(1);
    expect(new VertexTokenProvider(async () => ({ token: "v", expiresAtMs: 1, source: "gcloud-adc" })))
      .toBeInstanceOf(GcpTokenProvider);
  });
});

describe("createAdcTokenFetcher", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test("reads the metadata server first", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("metadata.google.internal")) throw new Error(`unexpected ${url}`);
      return Response.json({ access_token: "md", expires_in: 3600 });
    }) as typeof fetch;
    const t = await createAdcTokenFetcher("GCS")();
    expect(t.token).toBe("md");
    expect(t.source).toBe("metadata-server");
  });
});
