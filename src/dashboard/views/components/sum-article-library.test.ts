/**
 * The two pure client functions the article view uses to turn a Vimeo
 * capture's timestamps into clicks into the video. The REAL
 * `sumArticleLibraryScript()` source is evaluated (the sum-submit-form idiom),
 * with only the one global its top level touches (`document`) stubbed, so a
 * change to the transform is tested as it ships, not as a copy.
 */
import { describe, expect, test } from "bun:test";
import { sumArticleLibraryScript } from "./sum-article-library.ts";

function load(): {
  linkVimeoTimestamps: (markdown: string, videoUrl: string) => string;
  vimeoVideoIdFromUrl: (url: unknown) => string | null;
} {
  const ctx = { document: { addEventListener() {}, getElementById: () => null } };
  return new Function(
    "ctx",
    `var document = ctx.document;\n${sumArticleLibraryScript()}\n` +
      "return { linkVimeoTimestamps: linkVimeoTimestamps, vimeoVideoIdFromUrl: vimeoVideoIdFromUrl };",
  )(ctx);
}

describe("vimeoVideoIdFromUrl (client mirror)", () => {
  const { vimeoVideoIdFromUrl } = load();
  test("the two stored shapes resolve, hash suffix or not", () => {
    expect(vimeoVideoIdFromUrl("https://vimeo.com/1223444307")).toBe("1223444307");
    expect(vimeoVideoIdFromUrl("https://vimeo.com/1223444307/abcdef")).toBe("1223444307");
    expect(vimeoVideoIdFromUrl("https://player.vimeo.com/video/1223444307?h=x")).toBe("1223444307");
    expect(vimeoVideoIdFromUrl("http://www.vimeo.com/42#t=1s")).toBe("42");
  });
  test("anything else is null", () => {
    expect(vimeoVideoIdFromUrl("https://youtu.be/abc")).toBeNull();
    expect(vimeoVideoIdFromUrl("https://vimeo.com/javazone")).toBeNull();
    expect(vimeoVideoIdFromUrl("https://notvimeo.com/123")).toBeNull();
    expect(vimeoVideoIdFromUrl("")).toBeNull();
    expect(vimeoVideoIdFromUrl(undefined)).toBeNull();
  });
});

describe("linkVimeoTimestamps", () => {
  const { linkVimeoTimestamps } = load();
  const URL = "https://vimeo.com/1223444307";

  test("a window heading and a cited timestamp become links to that second, brackets kept as the label", () => {
    const md = "### [00:12:00]\n\nAt [12:30] the demo starts; see also [1:05:07].";
    expect(linkVimeoTimestamps(md, URL)).toBe(
      "### [\\[00:12:00\\]](https://vimeo.com/1223444307#t=720s)\n\n" +
        "At [\\[12:30\\]](https://vimeo.com/1223444307#t=750s) the demo starts; see also [\\[1:05:07\\]](https://vimeo.com/1223444307#t=3907s).",
    );
  });

  test("fenced code is left alone; an existing link is not re-wrapped", () => {
    const md = "See [00:01:00].\n```\nrun at [00:01:00]\n```\n~~~yaml\nat: [02:00]\n~~~\nalready [00:01:00](https://x) linked";
    const out = linkVimeoTimestamps(md, URL);
    expect(out).toContain("See [\\[00:01:00\\]](https://vimeo.com/1223444307#t=60s).");
    expect(out).toContain("```\nrun at [00:01:00]\n```");
    expect(out).toContain("~~~yaml\nat: [02:00]\n~~~");
    expect(out).toContain("already [00:01:00](https://x) linked");
  });

  test("a url with no video id returns the markdown untouched", () => {
    const md = "### [00:12:00]\n";
    expect(linkVimeoTimestamps(md, "https://youtu.be/x")).toBe(md);
    expect(linkVimeoTimestamps(md, "")).toBe(md);
  });

  test("things that look like timestamps but are not stay as they are", () => {
    // Three-part with a 1-digit seconds field, or a footnote-style [1], are not times.
    const md = "[1] and [12:3] and [a:bc] and [123:45]";
    expect(linkVimeoTimestamps(md, URL)).toBe(md);
  });
});
