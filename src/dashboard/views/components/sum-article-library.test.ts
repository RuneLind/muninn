/**
 * The two pure client functions the article view uses to turn a Vimeo
 * capture's timestamps into clicks into the video. The REAL
 * `sumArticleLibraryScript()` source is evaluated (the sum-submit-form idiom),
 * with only the one global its top level touches (`document`) stubbed, so a
 * change to the transform is tested as it ships, not as a copy.
 */
import { describe, expect, test } from "bun:test";
import { sumArticleLibraryScript } from "./sum-article-library.ts";
import { appendTranscriptSection } from "../../../youtube/frames.ts";

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
  splitTranscript: (markdown: string) => { body: string; transcript: string | null };
  renderArticleHtml: (cleaned: string) => string;
} {
  const ctx = { document: { addEventListener() {}, getElementById: () => null } };
  // renderMarkdown is the page's marked wrapper (sum-job-card.ts), a global
  // this script calls; a tagging stub is enough to see what went through it.
  return new Function(
    "ctx",
    `var document = ctx.document;\nvar renderMarkdown = function(t) { return '<md>' + t + '</md>'; };\n${sumArticleLibraryScript()}\n` +
      "return { linkVimeoTimestamps: linkVimeoTimestamps, vimeoVideoIdFromUrl: vimeoVideoIdFromUrl, openVimeoLinksInNewTab: openVimeoLinksInNewTab, splitTranscript: splitTranscript, renderArticleHtml: renderArticleHtml };",
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

describe("splitTranscript", () => {
  const { splitTranscript } = load();

  test("splits at the level-2 Transcript heading; the heading itself is dropped", () => {
    const md = "## Key takeaways\n- a\n\n## Transcript\n\n### [00:00:00]\nHei";
    expect(splitTranscript(md)).toEqual({
      body: "## Key takeaways\n- a\n",
      transcript: "\n### [00:00:00]\nHei",
    });
  });

  test("no heading ⇒ whole text is the body, transcript null", () => {
    const md = "## Summary\nText";
    expect(splitTranscript(md)).toEqual({ body: md, transcript: null });
  });

  test("a Transcript heading inside a fence is content, not the split point", () => {
    const md = "Intro\n```\n## Transcript\nnot it\n```\n## Transcript\nreal";
    expect(splitTranscript(md)).toEqual({ body: "Intro\n```\n## Transcript\nnot it\n```", transcript: "real" });
  });

  test("level 3 or a suffixed heading does not split", () => {
    expect(splitTranscript("### Transcript\nx").transcript).toBeNull();
    expect(splitTranscript("## Transcript notes\nx").transcript).toBeNull();
  });

  test("a YouTube frames capture's own document folds here — the writer and this reader agree", () => {
    // The coupling, not a second fixture: `appendTranscriptSection` is what the
    // YouTube ingest body is built with, and this is what the article view does
    // with the document that comes back. Spelling the heading twice by hand
    // would let the two drift and pass.
    const doc = appendTranscriptSection(
      "### Key takeaways\n- a",
      "### [00:00:00]\nhello there\n\n### [00:02:00]\nmore words",
    );
    const parts = splitTranscript(doc.text);
    expect(parts.body.trim()).toBe("### Key takeaways\n- a");
    expect(parts.transcript).toContain("### [00:02:00]");
    // The summary half keeps no trace of the transcript.
    expect(parts.body).not.toContain("[00:00:00]");
  });
});

describe("fences shared by both transforms (mapProseLines)", () => {
  const { splitTranscript, linkVimeoTimestamps } = load();
  const url = "https://vimeo.com/123";

  test("a four-backtick fence showing a three-backtick block is ONE fence", () => {
    const md = "Intro\n````md\n```\n## Transcript\n[00:10]\n```\n````\nAfter [00:20]";
    expect(splitTranscript(md).transcript).toBeNull();
    const linked = linkVimeoTimestamps(md, url);
    expect(linked).toContain("\n[00:10]\n");
    expect(linked).toContain("[\\[00:20\\]](https://vimeo.com/123#t=20s)");
  });

  test("an indented opener still opens a fence (the old loop's rule, kept)", () => {
    const md = "    ```\n[00:10]\n    ```\n## Transcript\nT";
    expect(linkVimeoTimestamps(md, url)).toBe(md);
    expect(splitTranscript(md)).toEqual({ body: "    ```\n[00:10]\n    ```", transcript: "T" });
  });

  test("the FIRST Transcript heading wins", () => {
    expect(splitTranscript("a\n## Transcript\nb\n## Transcript\nc")).toEqual({ body: "a", transcript: "b\n## Transcript\nc" });
  });

  test("a non-string input is coerced on both paths", () => {
    expect(splitTranscript(123 as unknown as string)).toEqual({ body: "123", transcript: null });
    expect(splitTranscript({ toString: () => "x\n## Transcript\ny" } as unknown as string)).toEqual({ body: "x", transcript: "y" });
    expect(linkVimeoTimestamps(123 as unknown as string, url)).toBe("123");
  });

  test("a fence is closed only by its own marker character", () => {
    const md = "```\n~~~\n[00:10]\n```\n[00:20]";
    expect(linkVimeoTimestamps(md, url)).toBe("```\n~~~\n[00:10]\n```\n[\\[00:20\\]](https://vimeo.com/123#t=20s)");
  });
});

describe("renderArticleHtml", () => {
  const { renderArticleHtml } = load();

  test("summary only ⇒ just the rendered markdown, no details", () => {
    expect(renderArticleHtml("## A\nx")).toBe("<md>## A\nx</md>");
  });

  test("a transcript renders inside a closed details after the summary", () => {
    expect(renderArticleHtml("## A\nx\n## Transcript\n### [00:00:00]\nHei")).toBe(
      "<md>## A\nx</md>" +
        '<details class="sum-transcript"><summary>Transcript</summary>' +
        '<div class="sum-transcript-body"><md>### [00:00:00]\nHei</md></div></details>',
    );
  });
});
