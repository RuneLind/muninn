import { describe, expect, test } from "bun:test";
import { canonicalVimeoUrl, extractVimeoVideoId, vimeoWatchUrl } from "./url.ts";

describe("extractVimeoVideoId — accepted shapes", () => {
  test("bare watch URL", () => {
    expect(extractVimeoVideoId("https://vimeo.com/1223642971")).toEqual({ id: "1223642971" });
  });

  test("www. is tolerated", () => {
    expect(extractVimeoVideoId("https://www.vimeo.com/1223642971")).toEqual({ id: "1223642971" });
  });

  test("trailing slash, query and fragment are ignored", () => {
    expect(extractVimeoVideoId("https://vimeo.com/1223642971/?foo=bar#t=30")).toEqual({ id: "1223642971" });
  });

  test("unlisted URL keeps the private hash", () => {
    expect(extractVimeoVideoId("https://vimeo.com/1223642971/a1b2c3d4e5")).toEqual({
      id: "1223642971",
      hash: "a1b2c3d4e5",
    });
  });

  test("player embed URL", () => {
    expect(extractVimeoVideoId("https://player.vimeo.com/video/1223642971")).toEqual({ id: "1223642971" });
  });

  test("player embed carries the hash as ?h=", () => {
    expect(extractVimeoVideoId("https://player.vimeo.com/video/1223642971?h=a1b2c3d4e5&autoplay=1")).toEqual({
      id: "1223642971",
      hash: "a1b2c3d4e5",
    });
  });

  test("channel URL", () => {
    expect(extractVimeoVideoId("https://vimeo.com/channels/staffpicks/1223642971")).toEqual({
      id: "1223642971",
    });
  });

  test("a non-hex sub-page is not mistaken for a hash", () => {
    expect(extractVimeoVideoId("https://vimeo.com/1223642971/likes")).toEqual({ id: "1223642971" });
  });
});

describe("extractVimeoVideoId — the host gate", () => {
  test("a Vimeo-looking path on another host is refused", () => {
    expect(extractVimeoVideoId("https://evil.example/vimeo.com/1223642971")).toBeNull();
  });

  test("a suffix-matching host is refused", () => {
    expect(extractVimeoVideoId("https://evilvimeo.com/1223642971")).toBeNull();
    expect(extractVimeoVideoId("https://vimeo.com.evil.example/1223642971")).toBeNull();
  });

  test("a non-http scheme is refused", () => {
    expect(extractVimeoVideoId("javascript:alert(1)//vimeo.com/123456")).toBeNull();
    expect(extractVimeoVideoId("file:///vimeo.com/123456")).toBeNull();
  });

  test("garbage is refused", () => {
    expect(extractVimeoVideoId("not a url")).toBeNull();
    expect(extractVimeoVideoId("")).toBeNull();
  });

  test("a Vimeo page that names no video id is refused", () => {
    expect(extractVimeoVideoId("https://vimeo.com/channels/staffpicks")).toBeNull();
    expect(extractVimeoVideoId("https://vimeo.com/ondemand/somefilm")).toBeNull();
    expect(extractVimeoVideoId("https://vimeo.com/")).toBeNull();
    expect(extractVimeoVideoId("https://player.vimeo.com/video/")).toBeNull();
  });
});

describe("canonical + watch URLs", () => {
  test("the dedup key is the id alone, hash or not", () => {
    const withHash = extractVimeoVideoId("https://vimeo.com/1223642971/a1b2c3d4e5")!;
    const without = extractVimeoVideoId("https://player.vimeo.com/video/1223642971")!;
    expect(canonicalVimeoUrl(withHash.id)).toBe("https://vimeo.com/1223642971");
    expect(canonicalVimeoUrl(withHash.id)).toBe(canonicalVimeoUrl(without.id));
  });

  test("the watch URL carries the hash, because the page 404s without it", () => {
    expect(vimeoWatchUrl({ id: "123", hash: "a1b2c3d4e5" })).toBe("https://vimeo.com/123/a1b2c3d4e5");
    expect(vimeoWatchUrl({ id: "123" })).toBe("https://vimeo.com/123");
  });
});
