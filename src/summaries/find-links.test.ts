import { describe, expect, test } from "bun:test";
import {
  authorSurname,
  candidateIsListed,
  candidateUrlCarried,
  candidateUrlKeys,
  carriedUrlKeys,
  extractPageTitle,
  FIND_LINKS_AGENT_TIMEOUT_MS,
  FIND_LINKS_CONCURRENCY,
  FIND_LINKS_RUN_TIMEOUT_MS,
  foundLinkFrom,
  githubOwnerRepo,
  inlineAnchorTexts,
  insertFoundLinks,
  isSiteNameSuffix,
  judgePage,
  lineTitleOf,
  linksBaseHash,
  linkUrlKey,
  namesRepo,
  pageBylines,
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
    expect(v.score).toMatchObject({ a: 4 / 6, twoWay: true });
    expect(v.evidence).toBe("author");
    expect(v.authorCheck).toBe("passed");
  });

  test("the same candidate vs «Claude Code best practices» → reachable when the quote is on the page, else not shown", () => {
    const p = page(`<title>Claude Code best practices</title>${filler("Start with the defaults and adjust from there.")}`);
    expect(judgePage(LYDIA, p, "Start with the defaults and adjust from there.").label).toBe("reachable");
    expect(judgePage(LYDIA, p, "").label).toBeNull();
  });

  test("«Spending your effort» vs «Using Claude Code: Spending your effort / claude.dev Blog» → matched", () => {
    const c: LinkCandidate = { title: "Spending your effort", author: null, topic: "the claude.dev post", kind: "post" };
    // On its own host the suffix is the site name, so the part after the colon is the title.
    const p = page("<title>Using Claude Code: Spending your effort / claude.dev Blog</title>", "https://claude.dev/blog/spending-your-effort");
    expect(judgePage(c, p, "")).toMatchObject({ label: "matched", evidence: "title" });
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
    expect(s.twoWay).toBe(false);
  });

  test("a different author's page on the same topic: the author check fails, so not matched", () => {
    const p = page(`<title>Claude Code effort level and model selection</title>${filler("A thread by Jane Doe about effort levels.")}`);
    const v = judgePage(LYDIA, p, "");
    expect(v.score?.twoWay).toBe(true);
    expect(v.authorCheck).toBe("failed");
    expect(v.label).toBeNull();
  });

  test("D19 1: a page title under 3 tokens holds the two-way score only on its exact token set", () => {
    expect(scoreTitle("Claude Code", { title: "Claude Code", topic: "the Claude Code docs" }).twoWay).toBe(true);
    expect(scoreTitle("Claude Code", { title: "Claude Code best practices", topic: "Claude Code" }).twoWay).toBe(true);
    expect(scoreTitle("Claude Code", { title: "Claude Code best practices", topic: "the best practices post" }).twoWay).toBe(false);
  });

  test("D20 1: title equality reads the candidate's TITLE, never its topic", () => {
    expect(scoreTitle("Claude Code", { title: "Claude Code", topic: "the Claude Code docs" }).titleEqual).toBe(true);
    expect(scoreTitle("Claude Code", { title: "Claude Code best practices", topic: "Claude Code" }).titleEqual).toBe(false);
    expect(scoreTitle("Claude Code", { title: null, topic: "Claude Code" }).titleEqual).toBe(false);
  });
});

describe("L2: a colon title is scored with and without its prefix", () => {
  test.each([
    ["BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding", { title: null, topic: "the BERT paper on pre-training deep bidirectional transformers" }],
    ["Llama 2: Open Foundation and Fine-Tuned Chat Models", { title: "Llama 2", topic: "Meta's Llama 2 paper on open foundation and fine-tuned chat models" }],
    ["The lethal trifecta for AI agents: private data, untrusted content, and external communication", { title: "The lethal trifecta for AI agents", topic: "Simon Willison's post" }],
  ])("%s → the two-way score holds", (title, c) => {
    expect(scoreTitle(title, c).twoWay).toBe(true);
  });

  test("a different paper with a colon title does not match", () => {
    const s = scoreTitle("BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding", {
      title: "Attention Is All You Need",
      topic: "the original transformer paper",
    });
    expect(s.twoWay).toBe(false);
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
  test("matched by title equality with the check skipped carries no author", () => {
    const c: LinkCandidate = { ...LYDIA, title: "Claude Code effort level and model selection" };
    const p = page('<meta property="og:site_name" content="Example"><title>Claude Code effort level and model selection</title>');
    const v = judgePage(c, p, "");
    expect(v).toMatchObject({ label: "matched", evidence: "title", authorCheck: "skipped" });
    expect(foundLinkFrom(c, p, entry, v)).toMatchObject({ label: "matched", detail: "Example" });
  });
  test("og:site_name equal to the author: the name is said once", () => {
    const c: LinkCandidate = { title: null, author: "Julia Evans", topic: "Julia Evans on what happens behind hello world on Linux", kind: "post" };
    const p = page(`<meta property="og:site_name" content="Julia Evans"><title>What happens behind the scenes when we run hello world on Linux</title>${filler("By Julia Evans.")}`);
    const v = judgePage(c, p, "");
    expect(foundLinkFrom(c, p, entry, v)?.detail).toBe("Julia Evans");
    expect(v).toMatchObject({ label: "matched", evidence: "author" });
  });
});

describe("L6: only a PDF is reachable, not read", () => {
  test("a resolved PDF (text null) is unread, titled from the candidate, never the manifest (D19 8)", () => {
    const p: SafePage = { finalUrl: "https://example.test/p.pdf", contentType: "application/pdf", text: null };
    const v = judgePage(LYDIA, p, "");
    expect(v.label).toBe("unread");
    expect(foundLinkFrom(LYDIA, p, { url: p.finalUrl, title: "Effort paper", quote: "" }, v)).toEqual({
      url: p.finalUrl,
      title: LYDIA.topic,
      detail: "",
      label: "unread",
    });
  });
});

describe("L7 / D20 filter: exact titles and carried URLs only", () => {
  test("an inline link's anchor text drops a candidate only when its title tokens are equal", () => {
    const body = [
      "See [Claude Code effort level and model selection](https://example.test/a) for the dial.",
      "",
      "Sources: https://example.test/blog/spending-your-effort",
    ].join("\n");
    const anchors = inlineAnchorTexts(body);
    expect(anchors).toEqual(["Claude Code effort level and model selection"]);
    expect(candidateIsListed({ ...LYDIA, title: "Claude Code Effort Levels and Model Selection" }, anchors)).toBe(true);
    // No title, so only a URL can drop it; and a bare URL's slug is no title.
    expect(candidateIsListed(LYDIA, anchors)).toBe(false);
    expect(candidateIsListed({ title: "Spending your effort", author: null, topic: "the post", kind: "post" }, anchors)).toBe(false);
  });

  test("a short existing line title or a repo line does not swallow a specific candidate", () => {
    expect(candidateIsListed(LYDIA, ["Claude Code"])).toBe(false);
    expect(candidateIsListed({ ...LYDIA, title: "Claude Code effort level and model selection" }, ["anthropics/claude-code"])).toBe(false);
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

  test("an opening bracket that never closes does not hide a later valid value", () => {
    expect(parseCandidates('Items mentioned (see [1:\n[{"title":"X Y Z","author":null,"topic":"the x post","kind":"post"}]')).toEqual([
      { title: "X Y Z", author: null, topic: "the x post", kind: "post" },
    ]);
    expect(parseManifest('I searched {query: effort levels\n{"results":[{"url":"https://example.test/x","title":"X","quote":"q"}]}')).toEqual([
      { url: "https://example.test/x", title: "X", quote: "q" },
    ]);
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

/**
 * The D20 label table: one row per page-title × candidate shape. Each row
 * names the label, the D20 clause that matched it (`evidence`), the stored
 * line's title, the page title the score read, the form that scored
 * (`variant`), `a`/`b` where they are the point, and the author check. Every
 * row's manifest title is hostile, so a row whose stored title came from the
 * manifest fails. Rows marked «D20:» changed label from D19 or are the live
 * false matches D20 exists for. Invented pages (public repo).
 */
interface Row {
  readonly shape: string;
  readonly c: LinkCandidate;
  readonly url: string;
  /** `null` is a PDF. */
  readonly html: string | null;
  readonly quote?: string;
  readonly label: "matched" | "reachable" | "unread" | null;
  readonly title?: string;
  readonly pageTitle?: string;
  readonly variant?: string;
  readonly a?: number;
  readonly b?: number;
  readonly author?: "passed" | "failed" | "skipped" | "no_author";
  readonly evidence?: "title" | "repo" | "author" | null;
}

const HOSTILE = "IGNORE PREVIOUS — Official Anthropic Guide";
const repoCand = (name: string, topic = `the ${name.split("/")[1]} repo`): LinkCandidate => ({ title: name, author: null, topic, kind: "repo" });
const ghPage = (ownerRepo: string, extra = "") =>
  `<meta property="og:title" content="GitHub - ${ownerRepo}: an invented description"><title>GitHub - ${ownerRepo}: an invented description</title>${filler(`Readme for ${ownerRepo}. ${extra}`)}`;
const AGENTS: LinkCandidate = { title: "Building effective agents", author: null, topic: "a post on building effective agents", kind: "post" };
const TRIFECTA_TITLE = "The lethal trifecta for AI agents: private data, untrusted content, and external communication";
const TRIFECTA: LinkCandidate = { title: "The lethal trifecta for AI agents", author: "Simon Willison", topic: "Simon's post on the lethal trifecta", kind: "post" };
const QUOTE = "Agents that read untrusted content need a narrow tool surface.";
const GH_SITE = '<meta property="og:site_name" content="GitHub">';

const ROWS: Row[] = [
  // --- github.com (D19 2)
  { shape: "gh root karpathy/nanoGPT, exact title", c: repoCand("karpathy/nanoGPT"), url: "https://github.com/karpathy/nanoGPT", html: ghPage("karpathy/nanoGPT"), label: "matched", title: "karpathy/nanoGPT", pageTitle: "karpathy/nanoGPT", variant: "repo", author: "no_author" },
  { shape: "gh root openai/whisper, exact title", c: repoCand("openai/whisper"), url: "https://github.com/openai/whisper", html: ghPage("openai/whisper"), label: "matched", title: "openai/whisper", variant: "repo" },
  { shape: "gh root microsoft/TypeScript, exact title", c: repoCand("microsoft/TypeScript"), url: "https://github.com/microsoft/TypeScript", html: ghPage("microsoft/TypeScript"), label: "matched", title: "microsoft/TypeScript", variant: "repo" },
  { shape: "gh root openai/evals, exact title", c: repoCand("openai/evals"), url: "https://github.com/openai/evals", html: ghPage("openai/evals"), label: "matched", variant: "repo" },
  { shape: "gh root anthropics/courses, exact title", c: repoCand("anthropics/courses"), url: "https://github.com/anthropics/courses", html: ghPage("anthropics/courses"), label: "matched", variant: "repo" },
  { shape: "D20: gh root morluto/rea, candidate names the repo by its bare name: not matched", c: { title: "REA", author: null, topic: "REA (Reverse Engineer Anything), an MCP server by @morluto", kind: "tool" }, url: "https://github.com/morluto/rea", html: ghPage("morluto/rea"), label: null, variant: "repo", evidence: null },
  { shape: "D20: gh root morluto/rea by bare name, quote on the page: reachable", c: { title: "REA", author: null, topic: "REA (Reverse Engineer Anything), an MCP server by @morluto", kind: "tool" }, url: "https://github.com/morluto/rea", html: ghPage("morluto/rea", QUOTE), quote: QUOTE, label: "reachable", title: "morluto/rea" },
  { shape: "gh root with a trailing slash", c: repoCand("openai/evals"), url: "https://github.com/openai/evals/", html: ghPage("openai/evals"), label: "matched", title: "openai/evals", variant: "repo", evidence: "repo" },
  { shape: "D20: gh root, bare repo name in the topic, author on the page: never the author clause", c: { title: null, author: "Andrej Karpathy", topic: "Karpathy's nanoGPT repo", kind: "repo" }, url: "https://github.com/karpathy/nanoGPT", html: ghPage("karpathy/nanoGPT", "By Andrej Karpathy."), label: null, variant: "repo", author: "passed" },
  { shape: "D20 2: gh root, topic names github.com/owner/repo", c: { title: null, author: null, topic: "the code at github.com/karpathy/nanoGPT", kind: "repo" }, url: "https://github.com/karpathy/nanoGPT", html: ghPage("karpathy/nanoGPT"), label: "matched", evidence: "repo" },
  { shape: "D20 2: gh root, topic names https://www.github.com/owner/repo.git", c: { title: null, author: null, topic: "clone https://www.github.com/karpathy/nanoGPT.git first", kind: "repo" }, url: "https://github.com/karpathy/nanoGPT", html: ghPage("karpathy/nanoGPT"), label: "matched", evidence: "repo" },
  { shape: "D20 2: gh root, candidate title in another case, sentence-final dot", c: { title: null, author: null, topic: "Karpathy's repo, KARPATHY/NANOGPT.", kind: "repo" }, url: "https://github.com/karpathy/nanoGPT", html: ghPage("karpathy/nanoGPT"), label: "matched", evidence: "repo" },
  { shape: "D20 2: a longer owner/repo string is not the repo (nanoGPT-mini)", c: { title: null, author: null, topic: "the karpathy/nanoGPT-mini fork", kind: "repo" }, url: "https://github.com/karpathy/nanoGPT", html: ghPage("karpathy/nanoGPT"), label: null },
  { shape: "D20 2: a deeper path is not the repo (owner/repo/blob)", c: { title: null, author: null, topic: "github.com/karpathy/nanoGPT/blob/master/model.py", kind: "repo" }, url: "https://github.com/karpathy/nanoGPT", html: ghPage("karpathy/nanoGPT"), label: null },
  { shape: "D20 2: a suffix of another owner is not the repo (xkarpathy/nanoGPT)", c: { title: null, author: null, topic: "the xkarpathy/nanoGPT fork", kind: "repo" }, url: "https://github.com/karpathy/nanoGPT", html: ghPage("karpathy/nanoGPT"), label: null },
  // the D19 review's live false matches, as invented pages
  { shape: "D20: «the Ollama Python library» vs github.com/ollama/ollama", c: { title: null, author: null, topic: "the Ollama Python library", kind: "repo" }, url: "https://github.com/ollama/ollama", html: ghPage("ollama/ollama"), label: null },
  { shape: "D20: «the Ollama Python library» vs ollama/ollama, quote on the page: reachable", c: { title: null, author: null, topic: "the Ollama Python library", kind: "repo" }, url: "https://github.com/ollama/ollama", html: ghPage("ollama/ollama", QUOTE), quote: QUOTE, label: "reachable" },
  { shape: "D20: «Vercel's AI SDK for Next.js apps» vs github.com/vercel/next.js", c: { title: null, author: null, topic: "Vercel's AI SDK for Next.js apps", kind: "repo" }, url: "https://github.com/vercel/next.js", html: ghPage("vercel/next.js"), label: null },
  { shape: "D20: «the LangGraph Studio desktop app» vs github.com/langchain-ai/langgraph", c: { title: null, author: null, topic: "the LangGraph Studio desktop app", kind: "tool" }, url: "https://github.com/langchain-ai/langgraph", html: ghPage("langchain-ai/langgraph"), label: null },
  { shape: "D20: «Astral's ruff linter, which pairs with uv» vs github.com/astral-sh/uv", c: { title: null, author: null, topic: "Astral's ruff linter, which pairs with uv", kind: "tool" }, url: "https://github.com/astral-sh/uv", html: ghPage("astral-sh/uv"), label: null },
  { shape: "D20: «React Native for mobile» vs github.com/facebook/react", c: { title: null, author: null, topic: "React Native for mobile", kind: "repo" }, url: "https://github.com/facebook/react", html: ghPage("facebook/react"), label: null },
  { shape: "D20: «AutoGen Studio» vs github.com/microsoft/autogen", c: { title: null, author: null, topic: "AutoGen Studio", kind: "tool" }, url: "https://github.com/microsoft/autogen", html: ghPage("microsoft/autogen"), label: null },
  { shape: "D20: «GitHub's docs on Actions caching» vs github.com/github/docs", c: { title: null, author: null, topic: "GitHub's docs on Actions caching", kind: "doc" }, url: "https://github.com/github/docs", html: ghPage("github/docs"), label: null },
  { shape: "D20: «Claude Code best practices» (post, no author) vs github.com/anthropics/claude-code", c: { title: "Claude Code best practices", author: null, topic: "Claude Code best practices", kind: "post" }, url: "https://github.com/anthropics/claude-code", html: ghPage("anthropics/claude-code"), label: null },
  { shape: "D20: github.com/advisories/GHSA-… is no repo root: titled by the page", c: { title: null, author: null, topic: "the GHSA-abcd-efgh-ijkl advisory", kind: "doc" }, url: "https://github.com/advisories/GHSA-abcd-efgh-ijkl", html: `${GH_SITE}<title>Invented parser flaw · CVE-2099-0001 · GitHub Advisory Database · GitHub</title>${filler("Affected versions.")}`, label: null, pageTitle: "Invented parser flaw · CVE-2099-0001 · GitHub Advisory Database · GitHub" },
  { shape: "D20: github.com/education/… is no repo root", c: repoCand("education/classroom"), url: "https://github.com/education/classroom", html: `${GH_SITE}<title>GitHub Classroom · GitHub</title>${filler("Classroom.")}`, label: null, pageTitle: "GitHub Classroom · GitHub" },
  { shape: "D20: github.com/git-guides/… is no repo root", c: repoCand("git-guides/install-git"), url: "https://github.com/git-guides/install-git", html: `${GH_SITE}<title>Install Git · GitHub</title>${filler("Install.")}`, label: null, pageTitle: "Install Git · GitHub" },
  { shape: "D20: github.com/open-source/… is no repo root", c: repoCand("open-source/stories"), url: "https://github.com/open-source/stories", html: `${GH_SITE}<title>Stories of open source maintainers · GitHub</title>${filler("Stories.")}`, label: null, pageTitle: "Stories of open source maintainers · GitHub" },
  { shape: "gh root, a different repo's candidate", c: repoCand("openai/evals"), url: "https://github.com/anthropics/claude-code", html: ghPage("anthropics/claude-code"), label: null, variant: "repo" },
  { shape: "gh issue page vs the repo's candidate: titled by the page", c: repoCand("anthropics/claude-code", "the Claude Code repo"), url: "https://github.com/anthropics/claude-code/issues/1", html: `${GH_SITE}<title>Claude Code fails to start · Issue #1 · anthropics/claude-code · GitHub</title>${filler("Steps to reproduce.")}`, label: null, pageTitle: "Claude Code fails to start · Issue #1 · anthropics/claude-code · GitHub" },
  { shape: "gh pull page vs the repo's candidate", c: repoCand("anthropics/claude-code", "the Claude Code repo"), url: "https://github.com/anthropics/claude-code/pull/1", html: `${GH_SITE}<title>Fix the installer by someone · Pull Request #1 · anthropics/claude-code · GitHub</title>${filler("Diff.")}`, label: null },
  { shape: "gh blob README vs the repo's candidate", c: repoCand("anthropics/claude-code", "the Claude Code repo"), url: "https://github.com/anthropics/claude-code/blob/main/README.md", html: `${GH_SITE}<title>claude-code/README.md at main · anthropics/claude-code · GitHub</title>${filler("Readme.")}`, label: null, pageTitle: "claude-code/README.md at main · anthropics/claude-code · GitHub" },
  { shape: "gh topics page is no repo: its own title, scored like any page", c: { title: "llm agents", author: null, topic: "repos tagged llm agents", kind: "repo" }, url: "https://github.com/topics/llm-agents", html: `${GH_SITE}<title>llm-agents · GitHub Topics · GitHub</title>${filler("Repositories.")}`, label: null, pageTitle: "llm-agents · GitHub Topics · GitHub", variant: "whole", a: 0.5 },
  { shape: "D20: gh topics page vs «large language models»: a = 0.6 is no title equality, so not matched", c: { title: "large language models", author: null, topic: "large language models", kind: "doc" }, url: "https://github.com/topics/large-language-models", html: `${GH_SITE}<title>large-language-models · GitHub Topics · GitHub</title>${filler("Repositories.")}`, label: null, variant: "whole", a: 0.6 },
  { shape: "D20: gh topics page vs an owner/repo-shaped candidate: never the repo rule, not matched", c: repoCand("topics/large-language-models"), url: "https://github.com/topics/large-language-models", html: `${GH_SITE}<title>large-language-models · GitHub Topics · GitHub</title>${filler("Repositories.")}`, label: null, pageTitle: "large-language-models · GitHub Topics · GitHub", variant: "whole" },

  // --- the colon prefix alone (D19 4)
  { shape: "prefix alone, no author: reachable at most (quote on the page)", c: AGENTS, url: "https://acme.example/agents", html: `<title>Building effective agents: my takeaways after a year shipping production LLM systems at Acme</title>${filler(QUOTE)}`, quote: QUOTE, label: "reachable", variant: "prefix", author: "no_author" },
  { shape: "prefix alone, no author, no quote: not shown", c: AGENTS, url: "https://acme.example/agents", html: `<title>Building effective agents: my takeaways after a year shipping production LLM systems at Acme</title>${filler(QUOTE)}`, label: null, variant: "prefix" },
  { shape: "prefix alone, author check passed: matched", c: TRIFECTA, url: "https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/", html: `<title>${TRIFECTA_TITLE}</title>${filler("Posted by Simon Willison.")}`, label: "matched", title: TRIFECTA_TITLE, variant: "prefix", author: "passed" },
  { shape: "prefix alone, author check skipped (short page): not matched", c: TRIFECTA, url: "https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/", html: `<title>${TRIFECTA_TITLE}</title><p>Simon Willison.</p>`, label: null, variant: "prefix", author: "skipped" },
  { shape: "after the colon (pin): «Series: Title» vs the title", c: { title: "Spending your effort", author: null, topic: "the post on spending your effort", kind: "post" }, url: "https://example.test/post", html: "<title>Claude Code Deep Dives: Spending your effort</title>", label: "matched", variant: "after-colon", a: 1, b: 1 },

  // --- site suffixes (D19 3)
  { shape: "en dash + named entity suffix that is the site: stripped, matched", c: { title: "Building effective agents", author: null, topic: "Anthropic's post on building effective agents", kind: "post" }, url: "https://simonwillison.net/2024/Dec/20/building-effective-agents/", html: "<title>Building effective agents &#8211; Simon Willison&rsquo;s Weblog</title>", label: "matched", title: "Building effective agents", pageTitle: "Building effective agents – Simon Willison’s Weblog", variant: "site-stripped", a: 1, b: 1 },
  { shape: "en dash suffix «Joel on Software» on joelonsoftware.com: stored stripped", c: { title: "Things You Should Never Do, Part I", author: "Joel Spolsky", topic: "Joel's post on never rewriting code", kind: "post" }, url: "https://www.joelonsoftware.com/2000/04/06/things-you-should-never-do-part-i/", html: `<title>Things You Should Never Do, Part I &#8211; Joel on Software</title>${filler("Joel Spolsky.")}`, label: "matched", title: "Things You Should Never Do, Part I", author: "passed" },
  { shape: "« - Part 1» is the title, not a site: kept whole", c: { title: "Llama 2 - Part 1", author: null, topic: "the first part of a Llama 2 series", kind: "post" }, url: "https://blog.example.test/llama-2-part-1", html: "<title>Llama 2 - Part 1</title>", label: "matched", title: "Llama 2 - Part 1", variant: "whole" },
  { shape: "« - Part 1» page vs «Llama 2»: no strip, so no 2-token match", c: { title: "Llama 2", author: null, topic: "Meta's Llama 2 paper", kind: "paper" }, url: "https://blog.example.test/llama-2-part-1", html: "<title>Llama 2 - Part 1</title>", label: null, variant: "whole" },
  { shape: "« / » inside the title: scored whole", c: { title: "Input / output in Claude Code agents", author: null, topic: "the post on agent I/O", kind: "post" }, url: "https://claude.com/blog/io", html: "<title>Input / output in Claude Code agents</title>", label: "matched", title: "Input / output in Claude Code agents", variant: "whole" },
  { shape: "« - » before the rest of the title: scored whole", c: { title: "Claude Code - the definitive guide to effort levels", author: null, topic: "a guide to effort levels", kind: "post" }, url: "https://claude.com/blog/effort", html: "<title>Claude Code - the definitive guide to effort levels</title>", label: "matched", title: "Claude Code - the definitive guide to effort levels", variant: "whole" },
  { shape: "same page vs «Claude Code»: the head is no site-stripped form", c: { title: "Claude Code", author: null, topic: "Claude Code", kind: "tool" }, url: "https://claude.com/blog/effort", html: "<title>Claude Code - the definitive guide to effort levels</title>", label: null },
  { shape: "&mdash; suffix = og:site_name: stored stripped", c: { title: "Building effective agents", author: null, topic: "the post", kind: "post" }, url: "https://agents.blog.test/agents", html: '<meta property="og:site_name" content="Example"><title>Building effective agents &mdash; Example</title>', label: "matched", title: "Building effective agents", pageTitle: "Building effective agents — Example" },
  { shape: "D20: site suffix carrying the candidate's words: the two-way score alone is not matched", c: { title: "Claude Code docs", author: null, topic: "the Claude Code docs", kind: "doc" }, url: "https://docs.claude.com/en/docs/claude-code/overview", html: "<title>Overview - Claude Code Docs</title>", label: null, variant: "whole" },
  { shape: "D20: «Claude 3.5 Haiku announcement» vs «Introducing Claude 3.5 Sonnet» (a 0.60, b 0.50)", c: { title: null, author: null, topic: "Anthropic's Claude 3.5 Haiku announcement", kind: "post" }, url: "https://www.anthropic.example/news/claude-3-5-sonnet", html: `<title>Introducing Claude 3.5 Sonnet</title>${filler("A new model.")}`, label: null, variant: "whole", a: 0.6, b: 0.5 },
  { shape: "D20: «Meta's Llama 3.1 70B Instruct» vs «meta-llama/Llama-3.1-8B · Hugging Face»", c: { title: null, author: null, topic: "Meta's Llama 3.1 70B Instruct", kind: "tool" }, url: "https://huggingface.co/meta-llama/Llama-3.1-8B", html: `<title>meta-llama/Llama-3.1-8B · Hugging Face</title>${filler("Model card.")}`, label: null, variant: "site-stripped" },
  { shape: "D20 3: two-way score with a different author's byline: failed check, not matched", c: { title: null, author: "Jane Doe", topic: "Anthropic's Claude 3.5 Haiku announcement", kind: "post" }, url: "https://www.anthropic.example/news/claude-3-5-sonnet", html: `<title>Introducing Claude 3.5 Sonnet</title>${filler("A new model from the team.")}`, label: null, author: "failed" },
  { shape: "D20 3: two-way score, author check skipped (short page): not matched", c: LYDIA, url: "https://example.test/post", html: "<title>Claude Code effort level and model selection</title><p>By Lydia Hallie.</p>", label: null, author: "skipped" },
  { shape: "D20 1: an equal title with a failed author check: not matched", c: { title: "The Next Economy", author: "Jane Doe", topic: "the essay", kind: "post" }, url: "https://example.test/next", html: `<title>The Next Economy</title>${filler("By Tim O'Reilly.")}`, label: null, author: "failed" },
  { shape: "« · » suffix = the host's name: stored stripped", c: { title: "Prompt caching in practice", author: null, topic: "the caching post", kind: "post" }, url: "https://medium.example/caching", html: "<title>Prompt caching in practice · Medium</title>", label: "matched", title: "Prompt caching in practice" },

  // --- short titles (D19 1)
  { shape: "2-token page «Prompt caching» vs the exact candidate", c: { title: "Prompt caching", author: null, topic: "Anthropic's prompt caching docs", kind: "doc" }, url: "https://docs.example.test/prompt-caching", html: "<title>Prompt caching</title>", label: "matched", variant: "whole" },
  { shape: "2-token page «Claude Code» vs «Claude Code best practices»", c: { title: "Claude Code best practices", author: null, topic: "the best practices post", kind: "post" }, url: "https://docs.example.test/claude-code", html: "<title>Claude Code</title>", label: null },

  // --- entities (D19 5)
  { shape: "&rsquo; in the title tokenizes as the apostrophe", c: LYDIA, url: "https://example.test/post", html: `<title>Hallie&rsquo;s effort guide for Claude Code</title>${filler("By Lydia Hallie.")}`, label: "matched", title: "Hallie’s effort guide for Claude Code", author: "passed" },
  { shape: "&rsquo; and &hellip; on the page vs ’ and … in the quote", c: { title: "Something else entirely", author: null, topic: "an unrelated post", kind: "post" }, url: "https://example.test/other", html: `<title>Other page title words</title><p>It&rsquo;s best to start with the defaults&hellip; then adjust.</p>${filler("x")}`, quote: "It’s best to start with the defaults… then adjust.", label: "reachable" },
  { shape: "&hellip; on the page vs «...» in the quote", c: { title: "Something else entirely", author: null, topic: "an unrelated post", kind: "post" }, url: "https://example.test/other", html: `<title>Other page title words</title><p>Start with the defaults&hellip; then adjust from there.</p>${filler("x")}`, quote: "Start with the defaults... then adjust from there.", label: "reachable" },

  // --- authors (D19 6)
  { shape: "author O'Reilly vs «By Tim O'Reilly.»", c: { title: "The Next Economy", author: "Tim O'Reilly", topic: "Tim O'Reilly's essay on the next economy", kind: "post" }, url: "https://example.test/next", html: `<title>The Next Economy</title>${filler("By Tim O'Reilly.")}`, label: "matched", author: "passed" },
  { shape: "author O’Reilly (curly) vs «By Tim O'Reilly.»", c: { title: "The Next Economy", author: "Tim O’Reilly", topic: "the essay", kind: "post" }, url: "https://example.test/next", html: `<title>The Next Economy</title>${filler("By Tim O'Reilly.")}`, label: "matched", author: "passed" },
  { shape: "author O'Reilly vs «By Tim O&rsquo;Reilly.» (curly on the page)", c: { title: "The Next Economy", author: "Tim O'Reilly", topic: "the essay", kind: "post" }, url: "https://example.test/next", html: `<title>The Next Economy</title>${filler("By Tim O&rsquo;Reilly.")}`, label: "matched", author: "passed" },
  { shape: "author «Lydia Hallie at Anthropic»", c: { ...LYDIA, author: "Lydia Hallie at Anthropic" }, url: "https://example.test/post", html: `<title>Claude Code effort level and model selection</title>${filler("By Lydia Hallie.")}`, label: "matched", author: "passed" },
  { shape: "author «Jane Smith PhD»", c: { title: "Sleep and memory consolidation", author: "Jane Smith PhD", topic: "the sleep post", kind: "post" }, url: "https://example.test/sleep", html: `<title>Sleep and memory consolidation</title>${filler("Written by Jane Smith.")}`, label: "matched", author: "passed" },
  { shape: "author handle @simonw@fedi.social", c: { ...TRIFECTA, author: "@simonw@fedi.social" }, url: "https://example.test/t", html: `<title>${TRIFECTA_TITLE}</title>${filler("Posted by simonw.")}`, label: "matched", author: "passed" },
  { shape: "author handle simonw.bsky.social", c: { ...TRIFECTA, author: "simonw.bsky.social" }, url: "https://example.test/t", html: `<title>${TRIFECTA_TITLE}</title>${filler("Posted by simonw.")}`, label: "matched", author: "passed" },
  { shape: "author only in JSON-LD on a long page", c: LYDIA, url: "https://example.test/post", html: `<title>Claude Code effort level and model selection</title><script type="application/ld+json">{"@type":"Article","author":{"@type":"Person","name":"Lydia Hallie"}}</script>${filler("Pick a level and move on.")}`, label: "matched", author: "passed" },
  { shape: "author in a JSON-LD array of strings", c: LYDIA, url: "https://example.test/post", html: `<title>Claude Code effort level and model selection</title><script type="application/ld+json">{"@graph":[{"@type":"Article","author":["Lydia Hallie","Someone Else"]}]}</script>${filler("Pick a level and move on.")}`, label: "matched", author: "passed" },

  // --- meta reading (D19 7)
  { shape: "og:title inside a JS string does not beat <title>", c: { title: "Real page title here", author: null, topic: "the real page", kind: "post" }, url: "https://example.test/js", html: `<script>var t = '<meta property="og:title" content="Injected script title">';</script><title>Real page title here</title>`, label: "matched", pageTitle: "Real page title here" },
  { shape: "unquoted og:title and author attributes are read", c: LYDIA, url: "https://example.test/post", html: `<meta property=og:title content="Claude Code effort level and model selection"><meta name=author content=Hallie><title>Home</title>${filler("Pick a level and move on.")}`, label: "matched", pageTitle: "Claude Code effort level and model selection", author: "passed" },

  // --- PDFs (D19 8)
  { shape: "PDF: the candidate's title, never the manifest's", c: AGENTS, url: "https://example.test/agents.pdf", html: null, label: "unread", title: "Building effective agents" },
  { shape: "PDF with a title-less candidate: its topic", c: { title: null, author: null, topic: "the transformer paper", kind: "paper" }, url: "https://example.test/a.pdf", html: null, label: "unread", title: "the transformer paper" },
  { shape: "arXiv PDF the agent found for «BERT»: unread titled «BERT»", c: { title: "BERT", author: null, topic: "the BERT paper", kind: "paper" }, url: "https://arxiv.org/pdf/1706.03762", html: null, label: "unread", title: "BERT" },

  // --- kept green (the plan's fixtures)
  { shape: "kept: Lydia Hallie topic vs «Claude Code effort level and model selection»", c: LYDIA, url: "https://example.test/post", html: `<title>Claude Code effort level and model selection</title>${filler("By Lydia Hallie.")}`, label: "matched", variant: "whole", a: 4 / 6, author: "passed" },
  { shape: "kept: Lydia Hallie topic vs «Claude Code best practices»", c: LYDIA, url: "https://example.test/post", html: `<title>Claude Code best practices</title>${filler(QUOTE)}`, quote: QUOTE, label: "reachable" },
  { shape: "kept: «Spending your effort» vs «Using Claude Code: Spending your effort / claude.dev Blog»", c: { title: "Spending your effort", author: null, topic: "the claude.dev post", kind: "post" }, url: "https://claude.dev/blog/spending-your-effort", html: "<title>Using Claude Code: Spending your effort / claude.dev Blog</title>", label: "matched", title: "Using Claude Code: Spending your effort" },
  { shape: "kept: BERT topic / Devlin et al. vs the BERT paper's page, author passed", c: { title: null, author: "Jacob Devlin et al.", topic: "the BERT paper on pre-training deep bidirectional transformers", kind: "paper" }, url: "https://arxiv.org/abs/1810.04805", html: `<title>BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding</title>${filler("Jacob Devlin, Ming-Wei Chang, Kenton Lee, Kristina Toutanova.")}`, label: "matched", author: "passed", evidence: "author" },
  { shape: "D20: BERT topic with no author vs the BERT paper's page: the two-way score alone is not matched", c: { title: null, author: null, topic: "the BERT paper on pre-training deep bidirectional transformers", kind: "paper" }, url: "https://arxiv.org/abs/1810.04805", html: "<title>BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding</title>", label: null },
  { shape: "kept: YouTube watch page whose whole title equals the candidate's (author check skipped)", c: { title: "Anthropic Just Revealed Which Effort Level to Use", author: "Ben AI", topic: "Ben AI's video", kind: "post" }, url: "https://www.youtube.com/watch?v=invented01", html: '<meta property="og:title" content="Anthropic Just Revealed Which Effort Level to Use"><p>Watch</p>', label: "matched", variant: "whole", author: "skipped", evidence: "title" },
  { shape: "kept: «Prompt caching» vs a docs page titled «Prompt caching - Claude Docs»", c: { title: "Prompt caching", author: null, topic: "Anthropic's prompt caching docs", kind: "doc" }, url: "https://platform.claude.example/docs/en/build-with-claude/prompt-caching", html: '<meta property="og:site_name" content="Claude Docs"><title>Prompt caching - Claude Docs</title>', label: "matched", title: "Prompt caching", variant: "site-stripped", evidence: "title" },
  { shape: "kept: «Attention Is All You Need» vs the BERT page", c: { title: "Attention Is All You Need", author: null, topic: "the original transformer paper", kind: "paper" }, url: "https://arxiv.org/abs/1810.04805", html: "<title>BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding</title>", label: null },
];

describe("the D20 label table", () => {
  test.each(ROWS.map((r) => [r.shape, r] as const))("%s", (_shape, r) => {
    const p: SafePage = r.html === null ? { finalUrl: r.url, contentType: "application/pdf", text: null } : page(r.html, r.url);
    const v = judgePage(r.c, p, r.quote ?? "");
    expect(v.label).toBe(r.label);
    const line = foundLinkFrom(r.c, p, { url: r.url, title: HOSTILE, quote: r.quote ?? "" }, v);
    if (r.title !== undefined) expect(line?.title).toBe(r.title);
    if (line) expect(line.title).not.toBe(HOSTILE);
    if (r.pageTitle !== undefined) expect(v.pageTitle).toBe(r.pageTitle);
    if (r.variant !== undefined) expect((v.score as { variant?: string } | null)?.variant).toBe(r.variant);
    if (r.a !== undefined) expect(v.score?.a).toBeCloseTo(r.a, 5);
    if (r.b !== undefined) expect(v.score?.b).toBeCloseTo(r.b, 5);
    if (r.author !== undefined) expect(v.authorCheck).toBe(r.author);
    if (r.evidence !== undefined) expect(v.evidence).toBe(r.evidence);
  });
});

describe("D19 5-7: reading the markup", () => {
  test("entities decode once: &amp;#39; stays &#39;; every HTML5 name decodes", () => {
    expect(extractPageTitle("<title>Tom &amp;#39; Jerry</title>", "https://example.test/")).toBe("Tom &#39; Jerry");
    expect(pageVisibleText("<p>a&nbsp;b &mdash; c &NotNestedGreaterGreater; &bogus;</p>")).toBe("a b — c ⪢̸ &bogus;");
  });

  test.each([
    ["@simonw@fedi.social", "simonw"],
    ["simonw.bsky.social", "simonw"],
    ["Jane Smith PhD", "Smith"],
    ["Jane Smith, Ph.D.", "Smith"],
    ["Lydia Hallie at Anthropic", "Hallie"],
    ["Jane Doe from Acme", "Doe"],
    ["Tim O'Reilly", "O'Reilly"],
    ["Tim O’Reilly", "O'Reilly"],
    ["Jean-Luc D'Arcy", "D'Arcy"],
  ])("D19 6: surname of %s is %s", (author, surname) => {
    expect(authorSurname(author)).toBe(surname);
  });

  test("D19 7: the byline sources", () => {
    expect(pageBylines('<script>var x = \'<meta name="author" content="Script Person">\';</script><meta name=author content=Hallie>')).toEqual(["Hallie"]);
    expect(pageBylines('<script type="application/ld+json">{"author":[{"name":"Ada Lovelace"},"Charles Babbage"]}</script>')).toEqual(["Ada Lovelace", "Charles Babbage"]);
  });
});

describe("D20 filter: what hides a candidate", () => {
  const cand = (title: string | null, topic: string, kind = "post"): LinkCandidate => ({ title, author: null, topic, kind });

  // The D19 review's filter false-hides: none of these may drop the candidate.
  test.each([
    ["inline [Claude Code](github.com/anthropics/claude-code) vs the Lydia article", "See [Claude Code](https://github.com/anthropics/claude-code).", cand(null, "Lydia Hallie's article on Claude Code effort level and model selection")],
    ["inline [Claude Code] vs a titled Lydia article", "See [Claude Code](https://github.com/anthropics/claude-code).", cand("Claude Code effort level and model selection", "Lydia Hallie's article")],
    ["inline github.com/vercel/ai vs «AI Fluency course»", "Built on https://github.com/vercel/ai and [AI SDK](https://github.com/vercel/ai).", cand("AI Fluency course", "Anthropic's AI Fluency course", "doc")],
  ])("a body link does not hide it: %s", (_name, body, c) => {
    expect(candidateIsListed(c, inlineAnchorTexts(body))).toBe(false);
    expect(candidateUrlCarried(c, carriedUrlKeys(body))).toBe(false);
  });

  test.each([
    ["«Claude 4 Best Practices» vs «Claude Code Best Practices»", "Claude 4 Best Practices", cand("Claude Code Best Practices", "the Claude Code best practices post")],
    ["anthropic.com/claude-opus-5-5 vs «Claude Opus 5»", "anthropic.com/claude-opus-5-5", cand("Claude Opus 5", "the Claude Opus 5 announcement")],
    ["«Claude Sonnet 5 System Card» vs «Claude Opus 5 system card»", "Claude Sonnet 5 System Card", cand("Claude Opus 5 system card", "the Opus 5 system card", "doc")],
    ["github.com/morluto/rea vs «the REA docs site, rea.tools»", "github.com/morluto/rea", cand(null, "the REA docs site, rea.tools", "doc")],
    ["«official Google Gemini GitHub repo» vs «Google's Gemini CLI repo»", "official Google Gemini GitHub repo", cand("Google's Gemini CLI repo", "Google's Gemini CLI repo", "repo")],
    ["«karpathy/nanoGPT» line vs {title nanoGPT} (searched, then answered already linked)", "karpathy/nanoGPT", cand("nanoGPT", "Karpathy's nanoGPT repo", "repo")],
    ["a prefix-alone title", "Building effective agents: my takeaways after a year shipping production LLM systems at Acme", cand("Building effective agents", "a post on building effective agents")],
  ])("a Links line title does not hide it: %s", (_name, lineTitle, c) => {
    expect(candidateIsListed(c, [lineTitle])).toBe(false);
  });

  test("an equal title token set hides it: case, possessive, plural and stop words fold", () => {
    expect(candidateIsListed(cand("Building Effective Agents", "the post"), ["Building effective agents"])).toBe(true);
    expect(candidateIsListed(cand("The lethal trifecta for AI agents", "Simon's post"), ["Lethal trifecta for AI agent"])).toBe(true);
    expect(candidateIsListed(cand(null, "Building effective agents"), ["Building effective agents"])).toBe(false);
  });

  test("a URL the candidate itself names hides it when carried, with or without a scheme", () => {
    const carried = carriedUrlKeys("Install [it](https://github.com/obra/superpowers) and read https://example.test/guide/setup.");
    expect(candidateUrlCarried(cand(null, "the superpowers plugin at github.com/obra/superpowers", "repo"), carried)).toBe(true);
    expect(candidateUrlCarried(cand("Setup guide (https://example.test/guide/setup)", "the setup guide", "doc"), carried)).toBe(true);
    expect(candidateUrlCarried(cand(null, "the superpowers plugin", "repo"), carried)).toBe(false);
  });

  test("a bare host (rea.tools, Node.js) is no URL; a host with a path is", () => {
    expect(candidateUrlKeys(cand(null, "the REA docs site, rea.tools, built on Node.js"))).toEqual([]);
    expect(candidateUrlKeys(cand(null, "see github.com/obra/superpowers."))).toEqual([linkUrlKey("https://github.com/obra/superpowers")]);
  });
});

describe("D20: table defects fixed with the rule", () => {
  test.each([
    ["Yi Ma", "Ma"],
    ["Jack Ma", "Ma"],
    ["Lisa Ba", "Ba"],
    ["Ana Ms", "Ms"],
    ["Jane Smith M.A.", "Smith"],
    ["Jane Smith B.A.", "Smith"],
    ["Jane Smith M.S.", "Smith"],
  ])("a two-letter surname is no degree: surname of %s is %s", (author, surname) => {
    expect(authorSurname(author)).toBe(surname);
  });

  test("a commented-out JSON-LD block names no author", () => {
    const ld = (name: string) => `<script type="application/ld+json">{"author":{"name":"${name}"}}</script>`;
    expect(pageBylines(`<!-- ${ld("Old Author")} -->${ld("Lydia Hallie")}`)).toEqual(["Lydia Hallie"]);
  });

  test("a site suffix's first token needs 3 characters to name the host", () => {
    // «AI» occurs in mail.example; at 2 characters it says nothing about the site.
    expect(isSiteNameSuffix("AI", { host: "mail.example" })).toBe(false);
    expect(lineTitleOf("Prompt caching in practice - AI", { host: "mail.example" })).toBe("Prompt caching in practice - AI");
    expect(isSiteNameSuffix("Mail Weekly", { host: "mail.example" })).toBe(true);
  });

  test("the host's www. is no site name", () => {
    expect(isSiteNameSuffix("WWW Conference", { host: "www.example.org" })).toBe(false);
  });

  test("github.com repo roots: .git and www. stripped", () => {
    expect(githubOwnerRepo("https://github.com/karpathy/nanoGPT.git")).toBe("karpathy/nanoGPT");
    expect(githubOwnerRepo("https://www.github.com/karpathy/nanoGPT")).toBe("karpathy/nanoGPT");
    expect(namesRepo("karpathy/nanoGPT", { title: null, topic: "karpathy/nanoGPT.git" })).toBe(true);
  });
});
