import { describe, expect, test } from "bun:test";
import {
  TEXT_LINKS_MAX,
  classifyTextLinks,
  classifyTextLinksCounted,
  pickTextLinks,
  renderTextLinksSection,
  substituteUrls,
  tcoUrlsIn,
  textLinksPromptSection,
} from "./text-links.ts";
import { finishTextLinks, linkTraceAttrs, prepareTextLinks } from "./text-links-run.ts";
import { parseLinksSection } from "./links-section.ts";

/** Invented text; every URL is made up. */
const TEXT = [
  "Intro with [the paper](https://example.org/paper) and a bare https://example.net/notes.",
  "Code at https://github.com/example/harness and again [here](https://www.github.com/example/harness/).",
  "Profiles: https://x.com/someone_invented https://linkedin.com/in/someone-invented https://t.co/Unresolved1",
  "A post on X: https://x.com/someone_invented/status/1000000000000000001",
].join("\n");

describe("classifyTextLinks", () => {
  test("every non-social, non-X URL is a candidate, deduped, first occurrence wins, numbered in order", () => {
    expect(classifyTextLinks(TEXT)).toEqual([
      { id: 1, url: "https://example.org/paper", title: "the paper", cls: "candidate" },
      { id: 2, url: "https://example.net/notes", title: "example.net/notes", cls: "candidate" },
      { id: 3, url: "https://github.com/example/harness", title: "github.com/example/harness", cls: "repo" },
    ]);
  });

  test("a URL-shaped link text falls back to host/path", () => {
    expect(classifyTextLinks("[example.org/a…](https://example.org/a-long-path)")[0]!.title).toBe("example.org/a-long-path");
  });

  test(`caps the list at ${TEXT_LINKS_MAX}`, () => {
    const many = Array.from({ length: 55 }, (_, i) => `https://example.org/page-${i}`).join("\n");
    const links = classifyTextLinks(many);
    expect(links).toHaveLength(TEXT_LINKS_MAX);
    expect(links.at(-1)).toMatchObject({ id: 40, url: "https://example.org/page-39" });
  });

  test("the cap counts candidates: dropped social and X links never use it up", () => {
    const dropped = Array.from({ length: 20 }, (_, i) => [
      `https://x.com/someone_invented/status/${1000 + i}`,
      `https://linkedin.com/in/someone-invented-${i}`,
    ]).flat();
    const real = Array.from({ length: 5 }, (_, i) => `https://example.org/source-${i}`);
    const counted = classifyTextLinksCounted([...dropped, ...real].join("\n"));
    expect(counted.links.map((l) => l.url)).toEqual(real);
    expect(counted.truncated).toBe(0);
  });

  test("the candidates past the cap are counted, each distinct one once", async () => {
    const many = Array.from({ length: 55 }, (_, i) => `https://example.org/page-${i}`);
    const text = [...many, "https://example.org/page-50", "https://x.com/someone_invented"].join("\n");
    expect(classifyTextLinksCounted(text).truncated).toBe(15);
    const prepared = await prepareTextLinks(text);
    expect(prepared.links).toHaveLength(TEXT_LINKS_MAX);
    expect(prepared.linksTruncated).toBe(15);
    expect(linkTraceAttrs(prepared)).toEqual({
      linkCandidates: "40",
      linkCandidatesTruncated: "15",
      tcoFound: "0",
      tcoResolved: "0",
    });
  });
});

describe("classifyTextLinks on article-shaped text", () => {
  test("X media hosts are skipped like X self-links", () => {
    const text = "Photo https://pbs.twimg.com/media/Inv3nted.jpg and https://video.twimg.com/amplify_video/1/vid/a.mp4?tag=1";
    expect(classifyTextLinks(text)).toEqual([]);
  });

  test("a YouTube playlist or video is content; a channel stays social", () => {
    const text = [
      "Playlist — https://youtube.com/playlist?list=PLinvented",
      "Talk — https://www.youtube.com/watch?v=Invented123",
      "Channel https://youtube.com/@someone_invented and https://youtube.com/channel/UCinvented",
    ].join("\n");
    expect(classifyTextLinks(text).map((l) => l.url)).toEqual([
      "https://youtube.com/playlist?list=PLinvented",
      "https://www.youtube.com/watch?v=Invented123",
    ]);
  });

  test("a bare URL takes the text before it as its title when that text ends in a separator", () => {
    const text = [
      "6. Building Invented Agents — https://youtube.com/watch?v=Invented123",
      "Docs: https://example.org/docs",
      "Part two - https://example.org/two",
      "Links: https://example.org/generic",
      "  - https://example.org/bullet",
      "Read https://example.org/no-separator",
      "https://youtube.com/watch?v=Invented456&si=tracking",
      "https://example.org/a/b?x=1",
    ].join("\n");
    expect(classifyTextLinks(text).map((l) => l.title)).toEqual([
      "Building Invented Agents",
      "Docs",
      "Part two",
      "example.org/generic",
      "example.org/bullet",
      "example.org/no-separator",
      "youtube.com/watch?v=Invented456",
      "example.org/a/b",
    ]);
  });

  test("a GitHub owner or repo spelled in another case is the same link", () => {
    const text = "One https://github.com/invented-owner/Tool and two https://github.com/Invented-Owner/tool.";
    expect(classifyTextLinks(text).map((l) => l.url)).toEqual(["https://github.com/invented-owner/Tool"]);
  });

  test("the capture's own URL is not listed", async () => {
    const text = "# [An invented headline](https://example.org/post/1?utm_source=x)\n\nSee https://example.org/other";
    expect(classifyTextLinks(text, "https://www.example.org/post/1").map((l) => l.url)).toEqual(["https://example.org/other"]);
    const prepared = await prepareTextLinks(text, {}, "https://example.org/post/1");
    expect(prepared.links.map((l) => l.url)).toEqual(["https://example.org/other"]);
  });
});

describe("t.co substitution", () => {
  test("finds each distinct t.co URL", () => {
    expect(tcoUrlsIn("a https://t.co/Ab1 b [x](https://t.co/Ab1) c https://t.co/Ab12")).toEqual([
      "https://t.co/Ab1",
      "https://t.co/Ab12",
    ]);
  });

  test("replaces a URL everywhere, never inside a longer one", () => {
    const out = substituteUrls(
      "a https://t.co/Ab1 b [x](https://t.co/Ab1) c https://t.co/Ab12",
      new Map([["https://t.co/Ab1", "https://example.org/$&-target"]]),
    );
    expect(out).toBe(
      "a https://example.org/$&-target b [x](https://example.org/$&-target) c https://t.co/Ab12",
    );
  });

  test("prepareTextLinks substitutes in the text AND the list, and drops what did not resolve", async () => {
    const prepared = await prepareTextLinks("See [the repo](https://t.co/Ab1) and https://t.co/Zz9.", {
      resolveRedirect: async (url) => (url === "https://t.co/Ab1" ? "https://github.com/example/harness" : null),
    });
    expect(prepared.text).toBe("See [the repo](https://github.com/example/harness) and https://t.co/Zz9.");
    expect(prepared.links).toEqual([{ id: 1, url: "https://github.com/example/harness", title: "the repo", cls: "repo" }]);
    expect(prepared).toMatchObject({ tcoFound: 2, tcoResolved: 1 });
  });

  test("all t.co lookups share ONE budget", async () => {
    const urls = Array.from({ length: 12 }, (_, i) => `https://t.co/Slow${i}`).join(" ");
    const started = Date.now();
    const prepared = await prepareTextLinks(urls, {
      tcoBudgetMs: 150,
      resolveRedirect: (url, signal) =>
        new Promise((resolve) => {
          const t = setTimeout(() => resolve(`https://example.org/${url.slice(-5)}`), 1_000);
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            resolve(null);
          });
        }),
    });
    expect(Date.now() - started).toBeLessThan(800);
    expect(prepared.tcoResolved).toBe(0);
    expect(prepared.links).toEqual([]);
  });
});

describe("the prompt list, the pick and the section", () => {
  const links = classifyTextLinks(TEXT);

  test("the numbered list the user prompt carries; empty adds nothing", () => {
    expect(textLinksPromptSection(links)).toBe(
      "\n\n## Links in the text\n\n" +
        "1. the paper — https://example.org/paper\n" +
        "2. example.net/notes — https://example.net/notes\n" +
        "3. github.com/example/harness — https://github.com/example/harness [code or paper]",
    );
    expect(textLinksPromptSection([])).toBe("");
  });

  test("only picked ids go in; nothing goes in by rule; unknown ids are reported", () => {
    expect(pickTextLinks(links, "none").lines).toEqual([]);
    expect(pickTextLinks(links, null).lines).toEqual([]);
    const picked = pickTextLinks(links, [3, 1, 9]);
    expect(picked.lines.map((l) => [l.icon, l.url, l.provenance])).toEqual([
      ["📄", "https://example.org/paper", "from text"],
      ["📦", "https://github.com/example/harness", "from text"],
    ]);
    expect(picked.unknownIds).toEqual([9]);
  });

  test("the rendered section reads back through the shared parser", () => {
    const section = renderTextLinksSection(pickTextLinks(links, [1, 3]).lines)!;
    expect(parseLinksSection(section).lines.map((l) => l.url)).toEqual([
      "https://example.org/paper",
      "https://github.com/example/harness",
    ]);
    expect(renderTextLinksSection([])).toBeNull();
  });

  test("finishTextLinks adds a repo line, and a failed lookup leaves the plain line", async () => {
    const withDetail = await finishTextLinks(links, [3], { repoLine: async () => "An invented harness, Go, ★ 3 on 2026-10-25" });
    expect(withDetail.section).toBe(
      "## Links\n\n- 📦 [github.com/example/harness](https://github.com/example/harness) — An invented harness, Go, ★ 3 on 2026-10-25 · from text",
    );
    const plain = await finishTextLinks(links, [3], { repoLine: async () => null });
    expect(plain.section).toBe("## Links\n\n- 📦 [github.com/example/harness](https://github.com/example/harness) · from text");
  });
});

describe("fix round 2 batch 2 pins", () => {
  test("📦 only on a GitHub repo root; a pull request, issue, file or tree page reads 📄 (G3)", () => {
    const urls: string[] = [
      "https://github.com/example/harness",
      "https://github.com/example/harness/pull/3",
      "https://github.com/example/harness/issues/12",
      "https://github.com/example/harness/blob/main/README.md",
      "https://github.com/example/harness/tree/main/subdir",
      "https://github.com/example/harness/tree/main",
      "https://arxiv.org/abs/2401.00001",
    ];
    const links = classifyTextLinks(urls.join("\n"));
    expect(links.map((l) => l.cls)).toEqual(["repo", "repo", "repo", "repo", "repo", "repo", "repo"]);
    const lines = pickTextLinks(links, links.map((l) => l.id)).lines;
    expect(lines.map((l) => l.url)).toEqual(urls);
    // A tree root is 📦 only once the lookup confirms the default branch (`withRepoDetails`).
    expect(lines.map((l) => l.icon)).toEqual(["📦", "📄", "📄", "📄", "📄", "📄", "📦"]);
  });

  test("a fallback title carries at most 60 characters of the query (M10b)", () => {
    const query = `q=${"a".repeat(100)}`;
    const [link] = classifyTextLinks(`https://example.org/search?${query}`);
    expect(link!.title).toBe(`example.org/search?${query.slice(0, 60)}`);
  });

  test("substitution tries the longest URL first, whatever the map's order (M26)", () => {
    const out = substituteUrls(
      "a https://bit.ly/x?y=1 b https://bit.ly/x",
      new Map([
        ["https://bit.ly/x", "https://e.test/short"],
        ["https://bit.ly/x?y=1", "https://e.test/long"],
      ]),
    );
    expect(out).toBe("a https://e.test/long b https://e.test/short");
  });
});
