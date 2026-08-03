import { test, expect, describe } from "bun:test";
import {
  ASK_CHAT_SEED_MAX,
  ASK_CHAT_TITLE_MAX,
  buildAskChatSeed,
  deriveAskThreadTitle,
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
});
