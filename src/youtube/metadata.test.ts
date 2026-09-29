import { test, expect, describe } from "bun:test";
import {
  capFrontmatterAuthor,
  FRONTMATTER_FIELD_MAX_BYTES,
  fetchYouTubeOembed,
  fetchYouTubeOembedAuthor,
  normalizeUploadDate,
  probeAuthor,
  youtubeVideoFields,
} from "./metadata.ts";
import type { YtDlpInfo } from "../video/media.ts";

const probe = (over: Partial<YtDlpInfo> = {}): YtDlpInfo => ({
  id: "abcdefghijk",
  title: "T",
  duration: 423,
  uploader: "A Channel",
  uploadDate: "20240115",
  ...over,
});

describe("youtubeVideoFields", () => {
  test("a full probe: its uploader, a dashed date, the duration", () => {
    expect(youtubeVideoFields(probe(), "ignored")).toEqual({
      author: "A Channel",
      upload_date: "2024-01-15",
      duration_sec: 423,
    });
  });

  test("a fractional duration is ROUNDED — huginn answers 422 on a fraction", () => {
    expect(youtubeVideoFields(probe({ duration: 422.5 }), undefined).duration_sec).toBe(423);
    expect(youtubeVideoFields(probe({ duration: 0.4 }), undefined)).not.toHaveProperty("duration_sec");
  });

  test("probe sentinels count as absent: 0 duration, empty uploader, no/odd upload_date", () => {
    const f = youtubeVideoFields(probe({ duration: 0, uploader: "  ", uploadDate: undefined }), "From oEmbed");
    expect(f).toEqual({ author: "From oEmbed" });
    expect(youtubeVideoFields(probe({ uploadDate: "NA" }), undefined)).not.toHaveProperty("upload_date");
  });

  test("no probe: oEmbed's author only, never a length or a date", () => {
    expect(youtubeVideoFields(null, "From oEmbed")).toEqual({ author: "From oEmbed" });
    expect(youtubeVideoFields(null, undefined)).toEqual({});
    expect(youtubeVideoFields(null, "   ")).toEqual({});
  });

  test("probeAuthor trims and treats the empty sentinel as none", () => {
    expect(probeAuthor(probe({ uploader: " X " }))).toBe("X");
    expect(probeAuthor(probe({ uploader: "" }))).toBeUndefined();
    expect(probeAuthor(null)).toBeUndefined();
  });

  test("an author over huginn's 512-byte field cap is OMITTED, never truncated", () => {
    // 256 × "ø" is exactly 512 bytes; one more byte is over.
    const over = "ø".repeat(256) + "x";
    expect(Buffer.byteLength(over)).toBe(FRONTMATTER_FIELD_MAX_BYTES + 1);
    expect(youtubeVideoFields(null, over)).toEqual({});
    expect(youtubeVideoFields(probe({ uploader: over }), undefined)).not.toHaveProperty("author");
    const fits = "ø".repeat(256);
    expect(youtubeVideoFields(null, ` ${fits} `)).toEqual({ author: fits });
    expect(capFrontmatterAuthor(over)).toBeUndefined();
    expect(capFrontmatterAuthor("  ")).toBeUndefined();
  });

  test("normalizeUploadDate accepts exactly YYYYMMDD", () => {
    expect(normalizeUploadDate("20240115")).toBe("2024-01-15");
    for (const bad of [undefined, "", "2024-01-15", "2024011", "202401150", "NA"]) {
      expect(normalizeUploadDate(bad)).toBeUndefined();
    }
  });
});

describe("fetchYouTubeOembed", () => {
  const answer = (status: number, body: unknown = {}): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  test("200 with author_name is ok, and the request names the watch url", async () => {
    let seen = "";
    const impl = (async (url: string) => {
      seen = url;
      return new Response(JSON.stringify({ author_name: " A Channel " }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await fetchYouTubeOembed("abcdefghijk", { fetchImpl: impl })).toEqual({ kind: "ok", author: "A Channel" });
    expect(seen).toBe(
      "https://www.youtube.com/oembed?format=json&url=" +
        encodeURIComponent("https://www.youtube.com/watch?v=abcdefghijk"),
    );
  });

  test("the title rides along when the answer has one", async () => {
    expect(await fetchYouTubeOembed("x", { fetchImpl: answer(200, { author_name: "A", title: " T " }) })).toEqual({
      kind: "ok",
      author: "A",
      title: "T",
    });
  });

  test("400, 401, 403 and 404 are facts about the video; everything else is an error", async () => {
    for (const status of [400, 401, 403, 404]) {
      expect(await fetchYouTubeOembed("x", { fetchImpl: answer(status) })).toEqual({ kind: "unavailable", status });
    }
    for (const status of [429, 500, 503]) {
      expect(await fetchYouTubeOembed("x", { fetchImpl: answer(status) })).toEqual({ kind: "error", error: `HTTP ${status}` });
    }
    expect((await fetchYouTubeOembed("x", { fetchImpl: answer(200, {}) })).kind).toBe("error");
    const bad = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    expect((await fetchYouTubeOembed("x", { fetchImpl: bad })).kind).toBe("error");
    const thrown = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await fetchYouTubeOembed("x", { fetchImpl: thrown })).toEqual({ kind: "error", error: "TypeError: fetch failed" });
  });

  test("a hung server is bounded by the budget, and the author form never throws", async () => {
    const hang = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const started = Date.now();
    expect(await fetchYouTubeOembedAuthor("x", { fetchImpl: hang, timeoutMs: 50 })).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
