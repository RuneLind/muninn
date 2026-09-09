/**
 * The pure half of the summary export.
 *
 * Two things only this file pins: the frame rewrite (served address →
 * `frames/<sec>.jpg`, both spellings, non-canonical seconds left alone) and the
 * PARITY between the two Vimeo transforms ported here and the client's own
 * copies in `sum-article-library.ts` — same fixtures, same output, because the
 * client copy lives in a template literal nothing can import.
 */

import { test, expect, describe } from "bun:test";
import {
  exportBaseName,
  findFrameReference,
  linkVimeoTimestamps,
  renderExportMarkdown,
  renderExportPage,
  rewriteFrameUrls,
} from "./export.ts";
// The split's DECLARATION site, not the export's re-export of it: it moved to
// `transcript-split.ts` when the capture re-run became its third server-side
// reader, and this file's whole job on it is the parity with the client copy.
import { splitTranscript } from "./transcript-split.ts";
import { VIMEO_FRAME_SOURCE, YOUTUBE_FRAME_SOURCE } from "./frames.ts";
import { sumArticleLibraryScript } from "../dashboard/views/components/sum-article-library.ts";

function clientTransforms(): {
  linkVimeoTimestamps: (markdown: string, videoUrl: string) => string;
  splitTranscript: (markdown: string) => { body: string; transcript: string | null };
} {
  const ctx = { document: { addEventListener() {}, getElementById: () => null } };
  return new Function(
    "ctx",
    `var document = ctx.document;\nvar renderMarkdown = function(t) { return t; };\n${sumArticleLibraryScript()}\n` +
      "return { linkVimeoTimestamps: linkVimeoTimestamps, splitTranscript: splitTranscript };",
  )(ctx);
}

describe("findFrameReference", () => {
  test("reads source + id off the current spelling", () => {
    const ref = findFrameReference("x ![Slide at 00:03:07](/api/frames/vimeo/1223642971/187.jpg) y");
    expect(ref?.source).toBe(VIMEO_FRAME_SOURCE);
    expect(ref?.id).toBe("1223642971");
  });
  test("reads the legacy Vimeo spelling and a YouTube id", () => {
    expect(findFrameReference("![s](/api/vimeo/frames/42/7.jpg)")?.id).toBe("42");
    const yt = findFrameReference("![s](/api/frames/youtube/dQw4w9WgXcQ/7.jpg)");
    expect(yt?.source).toBe(YOUTUBE_FRAME_SOURCE);
    expect(yt?.id).toBe("dQw4w9WgXcQ");
  });
  test("only the exporting source's frames count when a source is given", () => {
    const md = "![a](/api/frames/youtube/dQw4w9WgXcQ/60.jpg) ![b](/api/frames/vimeo/111/60.jpg)";
    expect(findFrameReference(md, VIMEO_FRAME_SOURCE)?.id).toBe("111");
    expect(findFrameReference(md, YOUTUBE_FRAME_SOURCE)?.id).toBe("dQw4w9WgXcQ");
    expect(findFrameReference("![b](/api/frames/vimeo/111/60.jpg)", YOUTUBE_FRAME_SOURCE)).toBeNull();
  });
  test("a quote inside fenced code is source text, not a reference", () => {
    expect(findFrameReference("```\n![a](/api/frames/vimeo/123/60.jpg)\n```")).toBeNull();
  });
  test("an image carrying a markdown title is still a reference", () => {
    expect(findFrameReference('![a](/api/frames/vimeo/123/60.jpg "Slide")')?.id).toBe("123");
  });
  test("an id outside the charset is not a reference; no quotes ⇒ null", () => {
    expect(findFrameReference("![s](/api/frames/vimeo/../etc/7.jpg)")).toBeNull();
    expect(findFrameReference("![s](/api/frames/youtube/short/7.jpg)")).toBeNull();
    expect(findFrameReference("plain text")).toBeNull();
  });
});

describe("rewriteFrameUrls", () => {
  const ref = { source: VIMEO_FRAME_SOURCE, id: "42" };
  test("both spellings become relative; seconds deduped ascending", () => {
    const md = "a ![x](/api/frames/vimeo/42/670.jpg) b ![y](/api/vimeo/frames/42/187.jpg) c ![z](/api/frames/vimeo/42/670.jpg)";
    const out = rewriteFrameUrls(md, ref);
    expect(out.markdown).toBe("a ![x](frames/670.jpg) b ![y](frames/187.jpg) c ![z](frames/670.jpg)");
    expect(out.seconds).toEqual([187, 670]);
  });
  test("a quote inside fenced code keeps its source text; a titled image is rewritten", () => {
    const md = '```\n![a](/api/frames/vimeo/42/60.jpg)\n```\n![b](/api/frames/vimeo/42/61.jpg "Slide")';
    const out = rewriteFrameUrls(md, ref);
    expect(out.markdown).toBe('```\n![a](/api/frames/vimeo/42/60.jpg)\n```\n![b](frames/61.jpg "Slide")');
    expect(out.seconds).toEqual([61]);
  });
  test("another video's frames and a non-canonical second are left as they are", () => {
    const md = "![a](/api/frames/vimeo/43/1.jpg) ![b](/api/frames/vimeo/42/007.jpg)";
    const out = rewriteFrameUrls(md, ref);
    expect(out.markdown).toBe(md);
    expect(out.seconds).toEqual([]);
  });
});

describe("the export reads a quote the way the pass and the copy do", () => {
  const ytRef = { source: YOUTUBE_FRAME_SOURCE, id: "dQw4w9WgXcQ" };
  const address = (sec: number) => `/api/frames/youtube/dQw4w9WgXcQ/${sec}.jpg`;

  test("a quote in INLINE code is neither packaged nor rewritten", () => {
    const md = [
      `Write it as \`![Slide](${address(10)})\`.`,
      "```",
      `![b](${address(20)})`,
      "```",
      `![c](${address(30)})`,
    ].join("\n");
    const out = rewriteFrameUrls(md, ytRef);
    expect(out.seconds).toEqual([30]);
    expect(out.markdown).toBe(
      [
        `Write it as \`![Slide](${address(10)})\`.`,
        "```",
        `![b](${address(20)})`,
        "```",
        "![c](frames/30.jpg)",
      ].join("\n"),
    );
  });

  test("an inline-code quote is not the reference the archive is built from", () => {
    const md = `Write \`![a](/api/frames/vimeo/111/60.jpg)\` — the real one is ![b](/api/frames/vimeo/222/61.jpg).`;
    expect(findFrameReference(md, VIMEO_FRAME_SOURCE)?.id).toBe("222");
  });

  test("the link form and a `]`-carrying alt ARE packaged and rewritten", () => {
    const md = `[the chart](${address(40)})\n\n![Slide [the chart]](${address(50)})`;
    const out = rewriteFrameUrls(md, ytRef);
    expect(out.seconds).toEqual([40, 50]);
    expect(out.markdown).toBe("[the chart](frames/40.jpg)\n\n![Slide [the chart]](frames/50.jpg)");
  });
});

describe("Vimeo transforms match the client copies", () => {
  const client = clientTransforms();
  const url = "https://vimeo.com/1223642971";
  const fixtures = [
    "At [00:12:00] the speaker says [1:05] and [\\[00:00:10\\]](https://x) stays.",
    "```\n[00:01:00] inside a fence\n```\nafter [02:00]",
    "~~~\n[00:01:00]\n```\nstill fenced [00:02:00]\n~~~\nout [00:03:00]",
    "## Transcript\n### [00:00:00]\nhello",
    "body\n\n## Transcript\n\n### [00:02:00]\nwindow\n\n```\n## Transcript\n```\n",
    "no transcript here\n```\n## Transcript\n```",
    "a [01:02](https://vimeo.com/1#t=62s) b [01:03]",
    "````\n```\n[00:01:00] still fenced\n````\nout [00:02:00]",
  ];
  test("linkVimeoTimestamps", () => {
    for (const f of fixtures) expect(linkVimeoTimestamps(f, url)).toBe(client.linkVimeoTimestamps(f, url));
    expect(linkVimeoTimestamps(fixtures[0]!, url)).toContain("[\\[00:12:00\\]](https://vimeo.com/1223642971#t=720s)");
    expect(linkVimeoTimestamps(fixtures[0]!, "https://youtu.be/x")).toBe(fixtures[0]!);
    expect(linkVimeoTimestamps(fixtures[0]!, undefined)).toBe(fixtures[0]!);
  });
  test("the video id is read with the client's own rule", () => {
    for (const u of ["https://vimeo.com/channels/foo/123", "https://vimeo.com/0123", "https://player.vimeo.com/video/7?h=x", "https://youtu.be/x"]) {
      expect(linkVimeoTimestamps("[00:12] hi", u)).toBe(client.linkVimeoTimestamps("[00:12] hi", u));
    }
  });
  test("splitTranscript", () => {
    for (const f of fixtures) expect(splitTranscript(f)).toEqual(client.splitTranscript(f));
    expect(splitTranscript(fixtures[5]!).transcript).toBeNull();
    expect(splitTranscript(fixtures[4]!).body).toBe("body\n");
  });
});

describe("renderExportMarkdown", () => {
  test("images render, raw HTML is escaped, external links open in a new tab", () => {
    const html = renderExportMarkdown(
      "![Slide at 00:03:07](frames/187.jpg)\n\n<script>alert(1)</script>\n\n[t](https://vimeo.com/1#t=5s) [rel](frames/x)",
    );
    expect(html).toContain('<img src="frames/187.jpg" alt="Slide at 00:03:07">');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('<a href="https://vimeo.com/1#t=5s" target="_blank" rel="noopener">t</a>');
    expect(html).toContain('<a href="frames/x">rel</a>');
  });
  test("a link with an executable scheme is emitted as text; a remote image as its alt text", () => {
    const html = renderExportMarkdown(
      "[j](javascript:alert(1)) [d](data:text/html;base64,AA==) [v](vbscript:x) [m](mailto:a@b.c) [h](#top)\n\n" +
        "![remote](https://evil.example/pixel.png) ![j](javascript:x) ![ok](frames/187.jpg)",
    );
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:");
    expect(html).not.toContain("vbscript:");
    expect(html).toContain("j d v");
    expect(html).toContain('<a href="mailto:a@b.c">m</a>');
    expect(html).toContain('<a href="#top">h</a>');
    expect(html).not.toContain("evil.example");
    expect(html).toContain("remote j <img");
    expect(html).toContain('<img src="frames/187.jpg" alt="ok">');
  });
  test("a control character inside the scheme, or a protocol-relative href, is not a link either", () => {
    // Browsers strip ASCII tab/CR/LF from a URL before parsing the scheme, so
    // `java<TAB>script:` re-forms as `javascript:` — measured through a click.
    // In marked the LF forms and the BARE NUL form never parse as links
    // (literal text); the tab form and an angle-bracketed NUL form do, and the
    // gate is what reduces them to text.
    const html = renderExportMarkdown("[a](<java\tscript:x>) [b](<java\nscript:x>) [c](//evil.example/p) [d](java\u0000script:x)");
    expect(html).not.toMatch(/<a /);
    expect(html).not.toContain("href=");
    expect(html).not.toContain("evil.example");
    expect(html).toMatch(/^<p>a \[b\]/);
    expect(html).toContain(" c [d]");
  });
  test("an absolute link opens in a new tab whatever its authority spelling", () => {
    // `http:host` and `https:/\\host` resolve to the remote site exactly like
    // `http://host`; without a new tab the file:// page navigates ITSELF away.
    const html = renderExportMarkdown("[a](http:evil.example) [b](https:/\\evil.example) [c](mailto:x@y.z) [d](/p)");
    expect(html).toContain('<a href="http:evil.example" target="_blank" rel="noopener">a</a>');
    expect(html).toContain('<a href="https:/\\evil.example" target="_blank" rel="noopener">b</a>');
    expect(html).toContain('<a href="mailto:x@y.z">c</a>');
    expect(html).toContain('<a href="/p">d</a>');
  });
  test("a host reference in any slash spelling is not a link; a plain path or fragment is", () => {
    // The WHATWG parser treats `\` as `/` on a special base such as `file:`,
    // so `/\host` is a host reference exactly like `//host`. (A markdown
    // backslash escape — `\/host`, `\\host` — reaches the href as `/host` or
    // `\host`, a plain path either way, so those spellings are not fixtures.)
    const html = renderExportMarkdown("[a](/\\evil.example/p) [c](//evil.example) [d](/local/p) [e](#f) [f](sub/p.html)");
    expect(html).not.toContain("evil.example");
    expect(html).toContain('<a href="/local/p">d</a>');
    expect(html).toContain('<a href="#f">e</a>');
    expect(html).toContain('<a href="sub/p.html">f</a>');
  });
});

describe("renderExportPage", () => {
  test("title escaped, facts from metadata, transcript folded, no server URL left", () => {
    const html = renderExportPage({
      title: 'A <b>"talk"</b>',
      url: "https://vimeo.com/42",
      linkLabel: "Watch on Vimeo ↗",
      metadata: { speaker: "Kari", author: "JavaZone", upload_date: "2026-09-03 06:49:18", summary_kind: "deep" },
      markdown: "Intro ![s](frames/7.jpg) at [00:00:07]\n\n## Transcript\n### [00:00:00]\nhi",
      sourceId: "vimeo",
    });
    expect(html).toContain("<title>A &lt;b&gt;&quot;talk&quot;&lt;/b&gt;</title>");
    expect(html).toContain("<span>Kari</span><span>JavaZone</span><span>2026-09-03</span><span>deep summary</span>");
    expect(html).toContain('<a href="https://vimeo.com/42" target="_blank" rel="noopener">Watch on Vimeo ↗</a>');
    expect(html).toContain('<details class="transcript"><summary>Transcript</summary>');
    expect(html).toContain('href="https://vimeo.com/42#t=7s"');
    expect(html).toContain('<img src="frames/7.jpg"');
    expect(html).not.toContain("/api/frames/");
    expect(html).toContain("prefers-color-scheme: light");
  });
  test("a document url with an executable scheme gets no source link", () => {
    const html = renderExportPage({ title: "t", url: "javascript:alert(1)", linkLabel: "Open", markdown: "x", sourceId: "article" });
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain(">Open<");
  });
  test("a non-Vimeo source gets no timestamp links and no facts line without metadata", () => {
    const html = renderExportPage({ title: "t", linkLabel: "x", markdown: "see [00:01:00]", sourceId: "youtube" });
    expect(html).not.toContain("#t=");
    expect(html).not.toContain('class="facts"');
    expect(html).not.toContain("<details");
  });
});

describe("exportBaseName", () => {
  test("drops filesystem-hostile characters, keeps hyphens and non-ASCII, caps and never empties", () => {
    expect(exportBaseName('Trust, But Verify: "Skill/Driven" - Totto')).toBe("Trust, But Verify Skill Driven - Totto");
    expect(exportBaseName("Æøå · talk")).toBe("Æøå · talk");
    expect(exportBaseName("///")).toBe("summary");
    expect(exportBaseName("x".repeat(200)).length).toBe(80);
    // 13 five-char words with their spaces are 77 chars; the 80-char slice ends inside the 14th
    // ("wo"), which a hard slice keeps and a word-boundary cut drops.
    expect(exportBaseName("wordy ".repeat(30).trim())).toBe("wordy ".repeat(13).trim());
  });
});
