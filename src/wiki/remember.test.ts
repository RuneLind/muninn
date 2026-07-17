import { test, expect, describe } from "bun:test";
import {
  buildDistillPrompt,
  parseDistillResult,
  buildSavedNotesBlock,
  REMEMBER_ANSWER_TRUNCATE,
  REMEMBER_SUMMARY_MAX,
} from "./remember.ts";

describe("buildDistillPrompt", () => {
  test("includes the wiki name, question, and answer", () => {
    const prompt = buildDistillPrompt({
      wikiName: "mimir",
      question: "How does the gardener wire pages?",
      answer: "It adds an index.md catalog line and See-also backlinks.",
    });
    expect(prompt).toContain("mimir");
    expect(prompt).toContain("How does the gardener wire pages?");
    expect(prompt).toContain("index.md catalog line");
  });

  test("asks for the durable fact, not the interaction", () => {
    const prompt = buildDistillPrompt({ wikiName: "w", question: "q", answer: "a" });
    // The instruction must steer away from "the user asked X" phrasing.
    expect(prompt.toLowerCase()).toContain("durable fact");
    expect(prompt).toContain("content");
    expect(prompt).toContain("summary");
    expect(prompt).toContain("tags");
  });

  test("truncates the answer to REMEMBER_ANSWER_TRUNCATE chars", () => {
    const answer = "x".repeat(REMEMBER_ANSWER_TRUNCATE + 500);
    const prompt = buildDistillPrompt({ wikiName: "w", question: "q", answer });
    const longestXrun = (prompt.match(/x+/g) ?? []).reduce((m, r) => Math.max(m, r.length), 0);
    expect(longestXrun).toBe(REMEMBER_ANSWER_TRUNCATE);
    expect(prompt).not.toContain("x".repeat(REMEMBER_ANSWER_TRUNCATE + 1));
  });

  test("trims whitespace on question and answer", () => {
    const prompt = buildDistillPrompt({
      wikiName: "w",
      question: "  spaced q  ",
      answer: "  spaced a  ",
    });
    expect(prompt).toContain('"""\nspaced q\n"""');
    expect(prompt).toContain('"""\nspaced a\n"""');
  });
});

describe("parseDistillResult", () => {
  test("parses a clean JSON object", () => {
    const out = parseDistillResult(
      '{"content":"pgvector stores 384-dim embeddings","summary":"muninn uses pgvector 384-dim","tags":["pgvector","embeddings"]}',
    );
    expect(out).toEqual({
      content: "pgvector stores 384-dim embeddings",
      summary: "muninn uses pgvector 384-dim",
      tags: ["pgvector", "embeddings"],
    });
  });

  test("strips markdown fences", () => {
    const raw = '```json\n{"content":"a fact","summary":"a line","tags":["t"]}\n```';
    expect(parseDistillResult(raw)).toEqual({
      content: "a fact",
      summary: "a line",
      tags: ["t"],
    });
  });

  test("extracts JSON embedded in prose", () => {
    const raw = 'Here is the memory:\n{"content":"c","summary":"s","tags":[]}\nHope that helps.';
    expect(parseDistillResult(raw)).toEqual({ content: "c", summary: "s", tags: [] });
  });

  test("lowercases, trims, and caps tags at 3", () => {
    const out = parseDistillResult(
      '{"content":"c","summary":"s","tags":["  Alpha ","BETA","gamma","delta","epsilon"]}',
    );
    expect(out?.tags).toEqual(["alpha", "beta", "gamma"]);
  });

  test("drops non-string tags and empties", () => {
    const out = parseDistillResult(
      '{"content":"c","summary":"s","tags":["ok", 5, "", "  ", "two"]}',
    );
    expect(out?.tags).toEqual(["ok", "two"]);
  });

  test("defaults tags to [] when absent or non-array", () => {
    expect(parseDistillResult('{"content":"c","summary":"s"}')?.tags).toEqual([]);
    expect(parseDistillResult('{"content":"c","summary":"s","tags":"nope"}')?.tags).toEqual([]);
  });

  test("caps summary at REMEMBER_SUMMARY_MAX chars", () => {
    const long = "s".repeat(REMEMBER_SUMMARY_MAX + 50);
    const out = parseDistillResult(JSON.stringify({ content: "c", summary: long, tags: [] }));
    expect(out?.summary.length).toBe(REMEMBER_SUMMARY_MAX);
  });

  test("returns null when content is missing or empty", () => {
    expect(parseDistillResult('{"summary":"s","tags":[]}')).toBeNull();
    expect(parseDistillResult('{"content":"   ","summary":"s"}')).toBeNull();
  });

  test("returns null when summary is missing or empty", () => {
    expect(parseDistillResult('{"content":"c","tags":[]}')).toBeNull();
    expect(parseDistillResult('{"content":"c","summary":""}')).toBeNull();
  });

  test("returns null on malformed / non-object / empty input", () => {
    expect(parseDistillResult("not json at all")).toBeNull();
    expect(parseDistillResult('{"content": "c", "summary": ')).toBeNull();
    expect(parseDistillResult("[1,2,3]")).toBeNull();
    expect(parseDistillResult("")).toBeNull();
    expect(parseDistillResult("42")).toBeNull();
  });
});

describe("buildSavedNotesBlock", () => {
  test("returns null for an empty list", () => {
    expect(buildSavedNotesBlock([])).toBeNull();
  });

  test("returns null when every content is blank (drops empties)", () => {
    expect(buildSavedNotesBlock([{ content: "" }, { content: "   " }])).toBeNull();
  });

  test("carries the honest background/non-citable framing", () => {
    const block = buildSavedNotesBlock([{ content: "a fact" }])!;
    expect(block).toContain("READER'S SAVED WIKI NOTES");
    expect(block.toLowerCase()).toContain("background only");
    expect(block).toContain("do not cite these as [n]");
    expect(block.toLowerCase()).toContain("trust the sources");
  });

  test("renders one bullet per note, order preserved", () => {
    const block = buildSavedNotesBlock([
      { content: "first note" },
      { content: "second note" },
      { content: "third note" },
    ])!;
    expect(block).toContain("- first note");
    expect(block).toContain("- second note");
    expect(block).toContain("- third note");
    expect(block.indexOf("first note")).toBeLessThan(block.indexOf("second note"));
    expect(block.indexOf("second note")).toBeLessThan(block.indexOf("third note"));
  });

  test("trims content and drops blank rows while keeping order", () => {
    const block = buildSavedNotesBlock([
      { content: "  kept one  " },
      { content: "   " },
      { content: "kept two" },
    ])!;
    expect(block).toContain("- kept one\n- kept two");
  });
});
