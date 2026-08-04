import { test, expect, describe } from "bun:test";
import {
  ASK_CHAT_ANSWER_MIN,
  ASK_CHAT_SEED_MAX,
  ASK_CHAT_SOURCES_MAX,
  ASK_CHAT_TITLE_MAX,
  buildAskChatSeed,
  buildDirectChatSeed,
  deriveAskThreadTitle,
  deriveAskThreadTitleOrNull,
  uniqueAskThreadTitle,
} from "./ask-chat.ts";

describe("deriveAskThreadTitle", () => {
  test("lowercases and keeps a short question verbatim", () => {
    expect(deriveAskThreadTitle("How does the Gardener cluster?")).toBe(
      "how does the gardener cluster?",
    );
  });

  test("truncates to the createThread 50-char limit with an ellipsis", () => {
    const long = "what exactly happens when the wiki gardener drains the ingest backlog";
    const title = deriveAskThreadTitle(long);
    expect(title.length).toBeLessThanOrEqual(ASK_CHAT_TITLE_MAX);
    expect(title.endsWith("...")).toBe(true);
    expect(title).toBe(long.slice(0, ASK_CHAT_TITLE_MAX - 3) + "...");
  });

  test("flattens the newlines and tabs createThread rejects", () => {
    const title = deriveAskThreadTitle("line one\nline\ttwo\r\nthree");
    expect(title).toBe("line one line two three");
    expect(/[\n\r\t]/.test(title)).toBe(false);
  });

  test("falls back to a stable name when the question flattens to nothing", () => {
    expect(deriveAskThreadTitle("\n\t  ")).toBe("wiki ask");
    expect(deriveAskThreadTitle("")).toBe("wiki ask");
  });

  test("the …OrNull variant reports 'no name here' instead of the fallback", () => {
    // A caller with a SECOND source (the route's typed threadName, falling back to
    // the question) needs to tell an empty name from one that names the fallback —
    // otherwise a control-character name silently pins the thread to "wiki ask".
    expect(deriveAskThreadTitleOrNull("\n\t  ")).toBeNull();
    expect(deriveAskThreadTitleOrNull("")).toBeNull();
    expect(deriveAskThreadTitleOrNull("Real Name")).toBe("real name");
  });
});

describe("uniqueAskThreadTitle", () => {
  const now = new Date(2026, 7, 3, 9, 5); // 2026-08-03 09:05, local

  test("appends a timestamp suffix", () => {
    expect(uniqueAskThreadTitle("short question", now)).toBe("short question-2026-08-03-0905");
  });

  test("stays within the 50-char limit for an already-max-length base", () => {
    const base = "x".repeat(ASK_CHAT_TITLE_MAX);
    const out = uniqueAskThreadTitle(base, now);
    expect(out.length).toBe(ASK_CHAT_TITLE_MAX);
    expect(out.endsWith("-2026-08-03-0905")).toBe(true);
  });

  test("an attempt > 1 adds a disambiguator and still fits", () => {
    const base = "x".repeat(ASK_CHAT_TITLE_MAX);
    const second = uniqueAskThreadTitle(base, now, 2);
    const tenth = uniqueAskThreadTitle(base, now, 10);
    expect(second).toBe(uniqueAskThreadTitle(base, now, 2)); // deterministic
    expect(second).not.toBe(uniqueAskThreadTitle(base, now, 1));
    expect(second.endsWith("-2026-08-03-0905-2")).toBe(true);
    expect(tenth.endsWith("-2026-08-03-0905-10")).toBe(true);
    expect(second.length).toBe(ASK_CHAT_TITLE_MAX);
    expect(tenth.length).toBe(ASK_CHAT_TITLE_MAX);
  });
});

describe("thread-name truncation is surrogate-safe", () => {
  test("an astral question never stores a replacement char and never exceeds 50", () => {
    const title = deriveAskThreadTitle("🧠".repeat(40));
    expect(title.length).toBeLessThanOrEqual(ASK_CHAT_TITLE_MAX);
    expect(title).not.toContain("�");
    // A half-pair would show up as a lone surrogate — assert the string is
    // well-formed by round-tripping it through the code-point iterator.
    expect([...title].join("")).toBe(title);
    expect(/[\uD800-\uDFFF]/.test(title.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""))).toBe(false);
  });
});

describe("buildAskChatSeed", () => {
  const base = {
    wikiName: "jarvis",
    question: "How does the gardener cluster summaries?",
    answer: "It clusters by topic key,\nthen drafts one page per cluster.",
    citations: [
      { pageName: "Wiki Gardener", title: "wiki-gardener.md" },
      { title: "Ingest backlog" },
    ],
  };

  test("carries the question, the quoted answer and the sources", () => {
    const seed = buildAskChatSeed(base);
    expect(seed).toContain(base.question);
    expect(seed).toContain("> It clusters by topic key,");
    expect(seed).toContain("> then drafts one page per cluster.");
    expect(seed).toContain("Sources cited by the wiki: Wiki Gardener · Ingest backlog");
    expect(seed).toContain('"jarvis" wiki');
  });

  test("frames the quoted answer as prior context, not a question to re-answer", () => {
    const seed = buildAskChatSeed(base);
    expect(seed).toContain("PRIOR CONTEXT");
    expect(seed.toLowerCase()).toContain("don't just repeat it back");
  });

  test("prefers pageName, dedupes and drops empty citation names", () => {
    const seed = buildAskChatSeed({
      ...base,
      citations: [
        { pageName: "A Page", title: "ignored" },
        { pageName: "A Page" },
        { title: "" },
        { title: "Second" },
      ],
    });
    expect(seed).toContain("Sources cited by the wiki: A Page · Second");
  });

  test("omits the sources line entirely when there are no citations", () => {
    const seed = buildAskChatSeed({ ...base, citations: [] });
    expect(seed).not.toContain("Sources cited by the wiki");
  });

  test("truncates an oversized answer and stays within the seed cap", () => {
    const seed = buildAskChatSeed({ ...base, answer: "z".repeat(20_000) });
    expect(seed.length).toBeLessThanOrEqual(ASK_CHAT_SEED_MAX);
    expect(seed).toContain("(answer truncated)");
    // The question and the sources survive the cut — they're what make the
    // continuation addressable.
    expect(seed).toContain(base.question);
    expect(seed).toContain("Sources cited by the wiki:");
  });

  test("a pasted-document question is truncated — the TOTAL seed is the bound", () => {
    // The cap used to budget only the answer, so an oversized question rode along
    // untruncated: a 200k-char question produced a 205k-char seed.
    const seed = buildAskChatSeed({ ...base, question: "q".repeat(200_000) });
    expect(seed.length).toBeLessThanOrEqual(ASK_CHAT_SEED_MAX);
    expect(seed).toContain("(question truncated)");
  });

  test("a question big enough to eat the budget still leaves the answer its share", () => {
    // ~5.7k of question used to zero the answer budget, so the seed carried
    // "(answer truncated)" and NONE of the answer — the one thing escalating is for.
    const answer = "the gardener clusters by topic key. ".repeat(200);
    const seed = buildAskChatSeed({ ...base, question: "q".repeat(5_700), answer });
    expect(seed.length).toBeLessThanOrEqual(ASK_CHAT_SEED_MAX);
    expect(seed).toContain("> the gardener clusters by topic key.");
    // The quoted answer keeps at least its guaranteed minimum share.
    const quotedLen = seed.split("\n").filter((l) => l.startsWith(">")).join("\n").length;
    expect(quotedLen).toBeGreaterThanOrEqual(ASK_CHAT_ANSWER_MIN);
  });

  test("a huge citation list is capped and reports the overflow", () => {
    const citations = Array.from({ length: 8 }, (_, i) => ({
      pageName: `Page ${i} ` + "n".repeat(200),
    }));
    const seed = buildAskChatSeed({ ...base, citations });
    const line = seed.split("\n").find((l) => l.startsWith("Sources cited by the wiki:"))!;
    expect(line.length).toBeLessThanOrEqual(ASK_CHAT_SOURCES_MAX);
    expect(line).toContain("more");
    expect(seed.length).toBeLessThanOrEqual(ASK_CHAT_SEED_MAX);
  });

  test("everything oversized at once still fits", () => {
    const seed = buildAskChatSeed({
      wikiName: "w".repeat(500),
      question: "q".repeat(50_000),
      answer: "a".repeat(50_000),
      citations: Array.from({ length: 20 }, (_, i) => ({ pageName: `P${i} ` + "x".repeat(300) })),
    });
    expect(seed.length).toBeLessThanOrEqual(ASK_CHAT_SEED_MAX);
  });

  test("a non-string citation field can't throw out of the pure builder", () => {
    const seed = buildAskChatSeed({
      ...base,
      citations: [{ pageName: 123 }, { title: null }, { pageName: "Real Page" }] as never,
    });
    expect(seed).toContain("Sources cited by the wiki: Real Page");
  });
});

/**
 * `buildDirectChatSeed` — the seed for a question escalated WITHOUT asking the
 * wiki first ("New chat"). No answer to quote, so it is a separate builder rather
 * than the answer builder fed an empty string.
 */
describe("buildDirectChatSeed", () => {
  const base = { wikiName: "mimir", question: "How does the gardener cluster summaries?" };

  test("frames the question as fresh, naming the wiki, with no quoted answer", () => {
    const seed = buildDirectChatSeed({ ...base, webSearch: true });
    expect(seed).toContain('"mimir"');
    expect(seed).toContain("How does the gardener cluster summaries?");
    // Nothing quoted and no follow-up-to-nothing tail.
    expect(seed).not.toContain("\n>");
    expect(seed).not.toContain("What else should I know here?");
    expect(seed).not.toContain("Ask tab answered");
  });

  test("provenance is BRACKETED, never a first-person claim about the reader", () => {
    // The opening used to read "I'm reading the … wiki and want to dig into this",
    // and the memory extractor duly recorded a biographical fact about a user who
    // had only clicked a button (observed: a real memories row asserting the user
    // "maintains" a throwaway test wiki). Provenance, not autobiography.
    const seed = buildDirectChatSeed({ ...base, webSearch: true });
    expect(seed.startsWith('[Question asked from the "mimir" wiki reader]')).toBe(true);
    expect(seed).not.toContain("I'm reading");
    expect(seed).not.toContain("I maintain");
    // The instructions stay imperative.
    expect(seed).toContain("Answer it properly");
  });

  test("a wiki with NO collections is not told to search notes it cannot search", () => {
    // A `WIKI_EXTRA` entry without the collections segment has nothing behind the
    // Ask tab, so "search the wiki's own notes first" is an order that can only
    // fail — observed producing an answer that opened by apologizing for it.
    const without = buildDirectChatSeed({ ...base, webSearch: true, hasCollections: false });
    expect(without).not.toContain("wiki's own notes");
    expect(without).toContain("research it with");
    expect(without).toContain("cite what you find");
    // Provenance is still named — the bot should know where the question came from.
    expect(without).toContain('"mimir"');
    // Absent flag ⇒ the overwhelmingly common searchable shape, unchanged.
    expect(buildDirectChatSeed({ ...base, webSearch: true })).toContain("wiki's own notes");
    expect(buildDirectChatSeed({ ...base, webSearch: true, hasCollections: true })).toContain(
      "wiki's own notes",
    );
  });

  test("the collection-less framing still names web search only when it exists", () => {
    const on = buildDirectChatSeed({ ...base, webSearch: true, hasCollections: false });
    const off = buildDirectChatSeed({ ...base, webSearch: false, hasCollections: false });
    expect(on).toContain("including web search");
    expect(off).not.toContain("web search");
    expect(off).toContain("the tools you have");
  });

  test("names web search only when the effective connector can deliver it", () => {
    expect(buildDirectChatSeed({ ...base, webSearch: true })).toContain("including web search");
    const without = buildDirectChatSeed({ ...base, webSearch: false });
    expect(without).not.toContain("web search");
    // Still asks for real research — it just doesn't promise a tool that isn't there.
    expect(without).toContain("the tools you have");
  });

  test("the WHOLE seed is bounded, however huge the inputs", () => {
    const seed = buildDirectChatSeed({
      wikiName: "w".repeat(500),
      question: "q".repeat(200_000),
      webSearch: true,
    });
    expect(seed.length).toBeLessThanOrEqual(ASK_CHAT_SEED_MAX);
    expect(seed).toContain("(question truncated)");
  });

  test("a blank/absent question degrades instead of throwing", () => {
    expect(buildDirectChatSeed({ wikiName: "", question: "   ", webSearch: false })).toContain(
      "knowledge",
    );
    expect(
      buildDirectChatSeed({ wikiName: 5, question: null, webSearch: true } as never),
    ).toBeString();
  });
});
