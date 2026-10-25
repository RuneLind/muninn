import { describe, expect, test } from "bun:test";
import {
  authorSurname,
  candidateIsListed,
  extractPageTitle,
  FIND_LINKS_AGENT_TIMEOUT_MS,
  FIND_LINKS_CONCURRENCY,
  FIND_LINKS_RUN_TIMEOUT_MS,
  foundLinkFrom,
  inlineLinkTitles,
  insertFoundLinks,
  judgePage,
  linksBaseHash,
  linkUrlKey,
  pageVisibleText,
  parseCandidates,
  parseManifest,
  scoreTitle,
  titleTokens,
  type LinkCandidate,
} from "./find-links.ts";
import type { SafePage } from "./safe-fetch.ts";
import { checkedSha256OfRaw } from "./factcheck-body.ts";

/** Invented pages (public repo: no live corpus). `filler` pads the visible text past the author check's 500-character floor. */
const filler = (words: string) => `<p>${(words + " ").repeat(60)}</p>`;
const page = (html: string, url = "https://example.test/post"): SafePage => ({ finalUrl: url, contentType: "text/html", text: html });
const LYDIA: LinkCandidate = { title: null, author: "Lydia Hallie", topic: "Lydia Hallie's article on Claude Code effort levels", kind: "post" };

describe("the plan's label fixtures", () => {
  test("Lydia Hallie's article vs «Claude Code effort level and model selection», Hallie in the text → matched", () => {
    const p = page(`<title>Claude Code effort level and model selection</title>${filler("By Lydia Hallie, on picking a level.")}`);
    const v = judgePage(LYDIA, p, "");
    expect(v.label).toBe("matched");
    expect(v.score).toMatchObject({ a: 4 / 6, matched: true });
    expect(v.authorCheck).toBe("passed");
  });

  test("the same candidate vs «Claude Code best practices» → reachable when the quote is on the page, else not shown", () => {
    const p = page(`<title>Claude Code best practices</title>${filler("Start with the defaults and adjust from there.")}`);
    expect(judgePage(LYDIA, p, "Start with the defaults and adjust from there.").label).toBe("reachable");
    expect(judgePage(LYDIA, p, "").label).toBeNull();
  });

  test("«Spending your effort» vs «Using Claude Code: Spending your effort / claude.dev Blog» → matched", () => {
    const c: LinkCandidate = { title: "Spending your effort", author: null, topic: "the claude.dev post", kind: "post" };
    expect(judgePage(c, page("<title>Using Claude Code: Spending your effort / claude.dev Blog</title>"), "").label).toBe("matched");
  });

  test("a page whose title matches the agent's manifest title but not the candidate → reachable, never matched", () => {
    const c: LinkCandidate = { title: "Spending your effort", author: null, topic: "the claude.dev post", kind: "post" };
    const p = page(`<title>Ten tips for prompt caching</title>${filler("Cache the system prompt first.")}`);
    const entry = { url: p.finalUrl, title: "Ten tips for prompt caching", quote: "Cache the system prompt first." };
    const v = judgePage(c, p, entry.quote);
    expect(v.label).toBe("reachable");
    expect(foundLinkFrom(c, p, entry, v)?.label).toBe("reachable");
  });
});

describe("L1: the score holds both ways", () => {
  test("a wordy candidate does not match a short page title it covers", () => {
    const c: LinkCandidate = { title: null, author: null, topic: "a post about spending your weekend effort on gardening", kind: "post" };
    const s = scoreTitle("Spending your effort", c);
    expect(s.a).toBe(1);
    expect(s.b).toBeLessThan(0.5);
    expect(s.matched).toBe(false);
  });

  test("a different author's page on the same topic: the author check fails, so not matched", () => {
    const p = page(`<title>Claude Code effort level and model selection</title>${filler("A thread by Jane Doe about effort levels.")}`);
    const v = judgePage(LYDIA, p, "");
    expect(v.score?.matched).toBe(true);
    expect(v.authorCheck).toBe("failed");
    expect(v.label).toBeNull();
  });

  test("a page title under 3 tokens never matches", () => {
    expect(scoreTitle("Claude Code", { title: "Claude Code", topic: "Claude Code" }).matched).toBe(false);
  });
});

describe("L2: a colon title is scored with and without its prefix", () => {
  test.each([
    ["BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding", { title: null, topic: "the BERT paper on pre-training deep bidirectional transformers" }],
    ["Llama 2: Open Foundation and Fine-Tuned Chat Models", { title: "Llama 2", topic: "Meta's Llama 2 paper on open foundation and fine-tuned chat models" }],
    ["The lethal trifecta for AI agents: private data, untrusted content, and external communication", { title: "The lethal trifecta for AI agents", topic: "Simon Willison's post" }],
  ])("%s → matched", (title, c) => {
    expect(scoreTitle(title, c).matched).toBe(true);
  });

  test("a different paper with a colon title does not match", () => {
    const s = scoreTitle("BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding", {
      title: "Attention Is All You Need",
      topic: "the original transformer paper",
    });
    expect(s.matched).toBe(false);
  });
});

describe("L3: github.com reads owner/repo from the path", () => {
  const html = '<meta property="og:title" content="GitHub - anthropics/claude-code: Claude Code is an agentic coding tool">';
  test("the og:title is ignored on github.com", () => {
    expect(extractPageTitle(html, "https://github.com/anthropics/claude-code")).toBe("anthropics/claude-code");
    expect(extractPageTitle(html, "https://example.test/x")).toBe("GitHub - anthropics/claude-code: Claude Code is an agentic coding tool");
  });
  test("a repo candidate matches; a short-title other repo does not", () => {
    const p = page(html, "https://github.com/anthropics/claude-code");
    expect(judgePage({ title: "anthropics/claude-code", author: null, topic: "the Claude Code repo", kind: "repo" }, p, "").label).toBe("matched");
    expect(judgePage({ title: "openai/evals", author: null, topic: "the evals repo", kind: "repo" }, p, "").label).toBeNull();
  });
});

describe("L4: the author check", () => {
  test("a JS-rendered page (byline only in scripts, visible text under 500) skips it and still matches", () => {
    const p = page(
      '<meta property="og:title" content="Anthropic Just Revealed Which Effort Level to Use"><script>var ytInitialData={"author":"Ben AI"}</script><p>Watch</p>',
      "https://www.youtube.com/watch?v=invented01",
    );
    const c: LinkCandidate = { title: "Anthropic Just Revealed Which Effort Level to Use", author: "Ben AI", topic: "Ben AI's video", kind: "post" };
    const v = judgePage(c, p, "");
    expect(v.authorCheck).toBe("skipped");
    expect(v.label).toBe("matched");
  });

  test.each([
    ["Lydia Hallie", "Hallie"],
    ["Jacob Devlin et al.", "Devlin"],
    ["Thariq Shihipar (Anthropic)", "Shihipar"],
    ["Martin Luther King Jr.", "King"],
    ["Simon Willison's", "Willison"],
    ["@simonw", "simonw"],
    ["Ada Lovelace and Charles Babbage", "Lovelace"],
  ])("surname of %s is %s", (author, surname) => {
    expect(authorSurname(author)).toBe(surname);
  });

  test("the byline metadata counts", () => {
    const p = page(`<meta name="author" content="Lydia Hallie"><title>Claude Code effort level and model selection</title>${filler("Pick a level.")}`);
    expect(judgePage(LYDIA, p, "").authorCheck).toBe("passed");
  });
});

describe("L5: a line names an author only when the check passed", () => {
  const entry = { url: "https://example.test/post", title: "", quote: "Start with the defaults and adjust from there." };
  test("matched with the check passed carries the author", () => {
    const p = page(`<meta property="og:site_name" content="Example"><title>Claude Code effort level and model selection</title>${filler("By Lydia Hallie.")}`);
    expect(foundLinkFrom(LYDIA, p, entry, judgePage(LYDIA, p, ""))?.detail).toBe("Example, Lydia Hallie");
  });
  test("reachable carries the site only", () => {
    const p = page(`<meta property="og:site_name" content="Example"><title>Claude Code best practices</title>${filler("Start with the defaults and adjust from there. Lydia Hallie.")}`);
    expect(foundLinkFrom(LYDIA, p, entry, judgePage(LYDIA, p, entry.quote))).toMatchObject({ label: "reachable", detail: "Example" });
  });
  test("matched with the check skipped carries no author", () => {
    const p = page('<meta property="og:site_name" content="Example"><title>Claude Code effort level and model selection</title>');
    expect(foundLinkFrom(LYDIA, p, entry, judgePage(LYDIA, p, ""))).toMatchObject({ label: "matched", detail: "Example" });
  });
});

describe("L6: only a PDF is reachable, not read", () => {
  test("a resolved PDF (text null) is unread, titled from the manifest", () => {
    const p: SafePage = { finalUrl: "https://example.test/p.pdf", contentType: "application/pdf", text: null };
    const v = judgePage(LYDIA, p, "");
    expect(v.label).toBe("unread");
    expect(foundLinkFrom(LYDIA, p, { url: p.finalUrl, title: "Effort paper", quote: "" }, v)).toEqual({
      url: p.finalUrl,
      title: "Effort paper",
      detail: "",
      label: "unread",
    });
  });
});

describe("L7: links already carried, and the listed filter", () => {
  test("an inline link's anchor text or URL slug drops the candidate", () => {
    const body = [
      "See [Claude Code effort level and model selection](https://example.test/a) for the dial.",
      "",
      "Sources: https://example.test/blog/spending-your-effort",
    ].join("\n");
    const titles = inlineLinkTitles(body);
    expect(candidateIsListed(LYDIA, titles)).toBe(true);
    expect(candidateIsListed({ title: "Spending your effort", author: null, topic: "the post", kind: "post" }, titles)).toBe(true);
    expect(candidateIsListed({ title: "Attention Is All You Need", author: null, topic: "the paper", kind: "paper" }, titles)).toBe(false);
  });

  test("a short existing line title or a repo line does not swallow a specific candidate", () => {
    expect(candidateIsListed(LYDIA, ["Claude Code"])).toBe(false);
    expect(candidateIsListed(LYDIA, ["anthropics/claude-code"])).toBe(false);
    expect(candidateIsListed({ title: "anthropics/claude-code", author: null, topic: "the repo", kind: "repo" }, ["anthropics/claude-code"])).toBe(true);
  });
});

describe("R5: parsing and reading", () => {
  test("a bracketed number in prose is not the candidate list", () => {
    const raw = 'Found [2] items: [{"title": null, "author": null, "topic": "the effort article", "kind": "post"}]';
    expect(parseCandidates(raw)).toEqual([{ title: null, author: null, topic: "the effort article", kind: "post" }]);
    expect(parseCandidates("[]")).toEqual([]);
    expect(parseCandidates("Nothing here.")).toBeNull();
  });

  test("the manifest is the first object with a results array", () => {
    const raw = 'I checked {"a": 1} and then: {"results": [{"url": "https://example.test/x", "title": "X", "quote": "q"}, {"url": "javascript:alert(1)"}]}';
    expect(parseManifest(raw)).toEqual([{ url: "https://example.test/x", title: "X", quote: "q" }]);
  });

  test("an inline SVG <title> does not beat the <h1>; data-name=og:title is not og:title", () => {
    const html = '<meta data-name="og:title" content="Wrong"><svg><title>Icon</title></svg><h1>Real heading here</h1>';
    expect(extractPageTitle(html, "https://example.test/")).toBe("Real heading here");
  });

  test("%2f/%2F and %7E/~ are one URL", () => {
    expect(linkUrlKey("https://example.test/a%2fb")).toBe(linkUrlKey("https://example.test/a%2Fb"));
    expect(linkUrlKey("https://example.test/%7Euser/x")).toBe(linkUrlKey("https://example.test/~user/x"));
    expect(linkUrlKey("https://www.example.test/x/?utm_source=y")).toBe(linkUrlKey("https://example.test/x"));
  });

  test("a hostile numeric entity does not throw", () => {
    expect(pageVisibleText("<p>a &#99999999; b &#x41; &amp;</p>")).toBe("a &#99999999; b A &");
  });

  test("tokens: possessive, plural and stop words", () => {
    expect(titleTokens("Lydia Hallie's article on the Claude Code effort levels")).toEqual(["lydia", "hallie", "article", "claude", "code", "effort", "level"]);
  });
});

describe("the run's constants (plan: 3 at a time, 60 s, 120 s)", () => {
  test("pinned", () => {
    expect(FIND_LINKS_CONCURRENCY).toBe(3);
    expect(FIND_LINKS_AGENT_TIMEOUT_MS).toBe(60_000);
    expect(FIND_LINKS_RUN_TIMEOUT_MS).toBe(120_000);
  });
});

describe("linksBaseHash: the exact inverse of the insert", () => {
  const FM = '---\ndate: 2026-03-22\nurl: "https://example.test/v"\n---\n\n';
  const LINE = { url: "https://example.test/found", title: "Found page", detail: "Example" };
  /** What huginn writes back: the frontmatter re-quoted, the body as sent, one trailing newline. */
  const rewrite = (raw: string, body: string, tail = "") => raw.replace("date: 2026-03-22", 'date: "2026-03-22"').replace(/\n---\n\n[\s\S]*$/, `\n---\n\n${body}${tail}\n`);

  test("creating the section moves neither hash, with and without a transcript", () => {
    for (const tail of ["", "\n\n## Transcript\n\n### [00:00:00]\n\nWords."]) {
      const raw = `${FM}Summary text.${tail}\n`;
      const body = "Summary text.";
      const next = insertFoundLinks(body, [LINE]);
      expect(next.body).toBe("Summary text.\n\n## Links\n\n- 🔎 [Found page](https://example.test/found) — Example · found by search");
      const after = rewrite(raw, next.body, tail);
      expect(linksBaseHash(after)).toBe(linksBaseHash(raw));
      expect(checkedSha256OfRaw(after)).toBe(checkedSha256OfRaw(raw));
    }
  });

  test("a line goes above the count line; a URL already there is skipped", () => {
    const body = "Summary.\n\n## Links\n\n- 📄 [A](https://example.test/a) · from description\n\n_2 creator and social links in the description are not listed._";
    const next = insertFoundLinks(body, [LINE, { ...LINE, url: "https://www.example.test/a/" }]);
    expect(next).toMatchObject({ added: 1, skipped: 1 });
    expect(next.body).toContain("from description\n- 🔎 [Found page](https://example.test/found) — Example · found by search\n\n_2 creator");
    expect(linksBaseHash(`${FM}${next.body}\n`)).toBe(linksBaseHash(`${FM}${body}\n`));
  });

  test("any other body write moves it; frontmatter does not", () => {
    const raw = `${FM}Summary text.\n`;
    expect(linksBaseHash(`${FM}Summary text, re-run.\n`)).not.toBe(linksBaseHash(raw));
    expect(linksBaseHash(raw.replace("date: 2026-03-22", 'date: "2026-03-22"'))).toBe(linksBaseHash(raw));
  });
});
