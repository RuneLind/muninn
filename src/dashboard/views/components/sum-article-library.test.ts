/**
 * The two pure client functions the article view uses to turn a Vimeo
 * capture's timestamps into clicks into the video. The REAL
 * `sumArticleLibraryScript()` source is evaluated (the sum-submit-form idiom),
 * with only the one global its top level touches (`document`) stubbed, so a
 * change to the transform is tested as it ships, not as a copy.
 */
import { describe, expect, test } from "bun:test";
import { sumArticleLibraryScript } from "./sum-article-library.ts";

interface FakeAnchor {
  attrs: Record<string, string>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

function anchor(href: string): FakeAnchor {
  return {
    attrs: { href },
    getAttribute(name) {
      return this.attrs[name] ?? null;
    },
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
  };
}

function load(): {
  linkVimeoTimestamps: (markdown: string, videoUrl: string) => string;
  vimeoVideoIdFromUrl: (url: unknown) => string | null;
  openVimeoLinksInNewTab: (container: { querySelectorAll(sel: string): FakeAnchor[] } | null, videoUrl: string) => void;
} {
  const ctx = { document: { addEventListener() {}, getElementById: () => null } };
  return new Function(
    "ctx",
    `var document = ctx.document;\n${sumArticleLibraryScript()}\n` +
      "return { linkVimeoTimestamps: linkVimeoTimestamps, vimeoVideoIdFromUrl: vimeoVideoIdFromUrl, openVimeoLinksInNewTab: openVimeoLinksInNewTab };",
  )(ctx);
}

describe("openVimeoLinksInNewTab", () => {
  const { openVimeoLinksInNewTab } = load();

  test("sets target + rel on the video's #t= links and leaves every other anchor alone", () => {
    const stamp = anchor("https://vimeo.com/1223444307#t=750s");
    const other = anchor("https://vimeo.com/1223444307");
    const elsewhere = anchor("https://example.com/#t=750s");
    openVimeoLinksInNewTab({ querySelectorAll: () => [stamp, other, elsewhere] }, "https://vimeo.com/1223444307");
    expect(stamp.attrs).toEqual({ href: "https://vimeo.com/1223444307#t=750s", target: "_blank", rel: "noopener" });
    expect(other.attrs).toEqual({ href: "https://vimeo.com/1223444307" });
    expect(elsewhere.attrs).toEqual({ href: "https://example.com/#t=750s" });
  });

  test("no container, or no video id, is a no-op", () => {
    const stamp = anchor("https://vimeo.com/1223444307#t=750s");
    openVimeoLinksInNewTab(null, "https://vimeo.com/1223444307");
    expect(stamp.attrs).toEqual({ href: "https://vimeo.com/1223444307#t=750s" });
    // The no-id half is only pinned by an anchor the id-less prefix WOULD
    // match: without the guard the prefix is the literal "…/null#t=".
    const nullish = anchor("https://vimeo.com/null#t=750s");
    openVimeoLinksInNewTab({ querySelectorAll: () => [nullish] }, "https://youtu.be/x");
    expect(nullish.attrs).toEqual({ href: "https://vimeo.com/null#t=750s" });
  });
});

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

  test("fences are paired by their own marker — a ~~~ line inside a ``` block does not close it", () => {
    const md = "```\n~~~\n[02:00]\n```\n[03:00] after";
    const out = linkVimeoTimestamps(md, URL);
    expect(out).toContain("```\n~~~\n[02:00]\n```");
    expect(out).toContain("[\\[03:00\\]](https://vimeo.com/1223444307#t=180s) after");
    // And the mirror image.
    const md2 = "~~~\n```\n[02:00]\n~~~\n[03:00] after";
    expect(linkVimeoTimestamps(md2, URL)).toContain("~~~\n```\n[02:00]\n~~~\n[\\[03:00\\]]");
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
