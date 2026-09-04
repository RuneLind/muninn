import { describe, expect, test } from "bun:test";
import { canonicalVimeoUrl, extractVimeoVideoId, resolveVimeoRef, vimeoWatchUrl } from "./url.ts";

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

  test("?h= is taken as given — the hex rule is for path segments only", () => {
    // The hex rule exists to tell `/<hash>` from `/likes`. A QUERY parameter is
    // unambiguous: `?h=` is the hash and nothing else, so a value that does not
    // look hex is still the credential the page needs. Dropping it turns a
    // reachable unlisted video into a 404 recorded as "not public".
    expect(extractVimeoVideoId("https://vimeo.com/1223642971?h=notahexvalue")).toEqual({
      id: "1223642971",
      hash: "notahexvalue",
    });
    expect(extractVimeoVideoId("https://player.vimeo.com/video/1223642971?h=NotAHex")).toEqual({
      id: "1223642971",
      hash: "NotAHex",
    });
  });

  test("an empty ?h= is no hash at all", () => {
    expect(extractVimeoVideoId("https://vimeo.com/1223642971?h=")).toEqual({ id: "1223642971" });
  });

  test("the player embed carries the hash as a path segment too", () => {
    expect(extractVimeoVideoId("https://player.vimeo.com/video/1223642971/a1b2c3d4e5")).toEqual({
      id: "1223642971",
      hash: "a1b2c3d4e5",
    });
  });

  test("a non-hex trailing segment degrades to the bare id on BOTH hosts", () => {
    expect(extractVimeoVideoId("https://player.vimeo.com/video/1223642971/likes")).toEqual({
      id: "1223642971",
    });
    expect(extractVimeoVideoId("https://vimeo.com/1223642971/likes")).toEqual({ id: "1223642971" });
  });

  test("a leading-zero id is not a video id", () => {
    // `/0123` and `/123` would be two dedup keys for one video, and Vimeo never
    // writes the first.
    expect(extractVimeoVideoId("https://vimeo.com/0123")).toBeNull();
    expect(extractVimeoVideoId("https://vimeo.com/0")).toBeNull();
    expect(extractVimeoVideoId("https://player.vimeo.com/video/0123")).toBeNull();
    expect(extractVimeoVideoId("https://vimeo.com/channels/staffpicks/0123")).toBeNull();
  });
});

describe("resolveVimeoRef — the one bare-id-or-URL door", () => {
  test("a bare numeric id is a reference", () => {
    expect(resolveVimeoRef("1223642971")).toEqual({ id: "1223642971" });
    expect(resolveVimeoRef("  1223642971  ")).toEqual({ id: "1223642971" });
  });

  test("a URL goes through extractVimeoVideoId, hash and all", () => {
    expect(resolveVimeoRef("https://vimeo.com/1223642971/a1b2c3d4e5")).toEqual({
      id: "1223642971",
      hash: "a1b2c3d4e5",
    });
  });

  test("the same leading-zero rule as a URL id", () => {
    expect(resolveVimeoRef("0123")).toBeNull();
  });

  test("anything else is null", () => {
    expect(resolveVimeoRef("https://evil.example/vimeo.com/1")).toBeNull();
    expect(resolveVimeoRef("not a url")).toBeNull();
    expect(resolveVimeoRef("")).toBeNull();
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

  test("the hash cannot steer the URL off the video's own path", () => {
    // `?h=` is accepted verbatim (it is a credential, not a shape), and the
    // watch URL is then LOADED IN A BROWSER — so the segment is encoded on the
    // way in. Without this, `?h=..%2f..%2fsettings` addressed another vimeo.com
    // page entirely.
    const ref = extractVimeoVideoId("https://vimeo.com/123?h=..%2f..%2fsettings")!;
    expect(ref.hash).toBe("../../settings");
    const url = vimeoWatchUrl(ref);
    expect(new URL(url).pathname).toBe("/123/..%2F..%2Fsettings");
    expect(url.includes("/../")).toBe(false);
    // A real hex hash is untouched by the encoding.
    expect(vimeoWatchUrl({ id: "123", hash: "a1b2c3d4e5" })).toBe("https://vimeo.com/123/a1b2c3d4e5");
  });
});
