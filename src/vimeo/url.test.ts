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

  test("the watch URL's path is the video's own, whatever ?h= carried", () => {
    // The RESOLVED path, not a substring test. `encodeURIComponent` leaves `.`
    // alone, so `?h=..` built `https://vimeo.com/<id>/..` — which resolves to the
    // vimeo.com homepage — and `?h=.` dropped the credential, both while passing
    // an `includes("/../")` check. A `?h=` value now has to be on the safe
    // charset and otherwise degrades to NO hash, as an unrecognised path segment
    // already did.
    const good = extractVimeoVideoId("https://vimeo.com/123?h=a1b2c3d4e5")!;
    expect(good.hash).toBe("a1b2c3d4e5");
    expect(new URL(vimeoWatchUrl(good)).pathname).toBe("/123/a1b2c3d4e5");

    for (const raw of ["..", ".", "%2e%2e", "a/b", "a?b", "..%2f..%2fsettings"]) {
      const ref = extractVimeoVideoId(`https://vimeo.com/123?h=${raw}`)!;
      expect(ref).toEqual({ id: "123" });
      expect(ref.hash).toBeUndefined();
      expect(new URL(vimeoWatchUrl(ref)).pathname).toBe("/123");
    }
  });

  test("a hash handed straight to vimeoWatchUrl cannot leave the video's path either", () => {
    // The second door: `HarvestOptions.hash` reaches `vimeoWatchUrl` without
    // passing through the parser, and `encodeURIComponent("..")` is `..`.
    expect(new URL(vimeoWatchUrl({ id: "123", hash: ".." })).pathname).toBe("/123");
    expect(new URL(vimeoWatchUrl({ id: "123", hash: "../../settings" })).pathname).toBe("/123");
    // A real hash is untouched.
    expect(new URL(vimeoWatchUrl({ id: "123", hash: "a1b2c3d4e5" })).pathname).toBe("/123/a1b2c3d4e5");
  });
});
