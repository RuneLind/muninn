import { describe, expect, test } from "bun:test";
import { fetchVimeoOembed, isNotPublic, VimeoOembedError, vimeoOembedBaseUrl } from "./oembed.ts";

/** The shape vimeo.com/api/oembed.json actually answers with (trimmed). */
const OEMBED_BODY = {
  type: "video",
  title: "Trust, but verify",
  author_name: "JavaZone",
  author_url: "https://vimeo.com/javazone",
  duration: 3220,
  upload_date: "2026-09-03 11:22:33",
  thumbnail_url: "https://i.vimeocdn.com/video/123_640.jpg",
  video_id: 1223642971,
};

function jsonFetch(body: unknown, status = 200): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("fetchVimeoOembed", () => {
  test("maps the 200 body onto muninn's metadata shape", async () => {
    const { impl } = jsonFetch(OEMBED_BODY);
    const result = await fetchVimeoOembed("1223642971", { fetchImpl: impl });
    expect(isNotPublic(result)).toBe(false);
    expect(result).toEqual({
      title: "Trust, but verify",
      author: "JavaZone",
      durationSec: 3220,
      uploadDate: "2026-09-03 11:22:33",
      thumbnailUrl: "https://i.vimeocdn.com/video/123_640.jpg",
    });
  });

  test("asks about the canonical watch URL of a bare id", async () => {
    const { impl, calls } = jsonFetch(OEMBED_BODY);
    await fetchVimeoOembed("1223642971", { fetchImpl: impl });
    expect(calls[0]).toBe(
      "https://vimeo.com/api/oembed.json?url=https%3A%2F%2Fvimeo.com%2F1223642971",
    );
  });

  test("an unlisted video's private hash rides along — oEmbed 404s without it", async () => {
    const { impl, calls } = jsonFetch(OEMBED_BODY);
    await fetchVimeoOembed("https://vimeo.com/1223642971/a1b2c3d4e5", { fetchImpl: impl });
    expect(calls[0]).toContain(encodeURIComponent("https://vimeo.com/1223642971/a1b2c3d4e5"));
  });

  test("baseUrl override is where the request goes (the e2e stub seam)", async () => {
    const { impl, calls } = jsonFetch(OEMBED_BODY);
    await fetchVimeoOembed("1223642971", { fetchImpl: impl, baseUrl: "http://127.0.0.1:3999/" });
    expect(calls[0]!.startsWith("http://127.0.0.1:3999/api/oembed.json?url=")).toBe(true);
  });

  test("404 is an answer about the video, not an error", async () => {
    const { impl } = jsonFetch({ error: "not found" }, 404);
    const result = await fetchVimeoOembed("1223642971", { fetchImpl: impl });
    expect(result).toEqual({ notPublic: true, status: 404 });
  });

  test("403 likewise", async () => {
    const { impl } = jsonFetch({}, 403);
    expect(await fetchVimeoOembed("1223642971", { fetchImpl: impl })).toEqual({
      notPublic: true,
      status: 403,
    });
  });

  test("a 5xx says nothing about the video and throws", async () => {
    const { impl } = jsonFetch({}, 503);
    await expect(fetchVimeoOembed("1223642971", { fetchImpl: impl })).rejects.toThrow(VimeoOembedError);
  });

  test("an unparseable body throws", async () => {
    const impl = (async () =>
      new Response("<html>nope</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;
    await expect(fetchVimeoOembed("1223642971", { fetchImpl: impl })).rejects.toThrow(VimeoOembedError);
  });

  test("a timeout aborts and throws, naming the budget", async () => {
    const impl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    await expect(
      fetchVimeoOembed("1223642971", { fetchImpl: impl, timeoutMs: 25 }),
    ).rejects.toThrow(/timed out after 25ms/);
  });

  test("a non-Vimeo URL is refused before any request", async () => {
    let called = false;
    const impl = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    await expect(fetchVimeoOembed("https://evil.example/vimeo.com/1", { fetchImpl: impl })).rejects.toThrow(
      VimeoOembedError,
    );
    expect(called).toBe(false);
  });
});

describe("vimeoOembedBaseUrl", () => {
  test("defaults to vimeo.com and is read at call time", () => {
    const before = process.env.VIMEO_OEMBED_BASE;
    try {
      delete process.env.VIMEO_OEMBED_BASE;
      expect(vimeoOembedBaseUrl()).toBe("https://vimeo.com");
      process.env.VIMEO_OEMBED_BASE = "  http://127.0.0.1:4321 ";
      expect(vimeoOembedBaseUrl()).toBe("http://127.0.0.1:4321");
      process.env.VIMEO_OEMBED_BASE = "   ";
      expect(vimeoOembedBaseUrl()).toBe("https://vimeo.com");
    } finally {
      if (before === undefined) delete process.env.VIMEO_OEMBED_BASE;
      else process.env.VIMEO_OEMBED_BASE = before;
    }
  });
});
