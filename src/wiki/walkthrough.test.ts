import { describe, test, expect } from "bun:test";
import {
  checkQuotes,
  eligibleHeadings,
  locateSection,
  parseWalkthroughReply,
  sectionPlainText,
  WALKTHROUGH_MAX_STEPS,
} from "./walkthrough.ts";

const MD = [
  "---",
  "title: Demo",
  "---",
  "# Demo",
  "",
  "Intro text.",
  "",
  "## Setup `bun` **now**",
  "",
  "Run **bun install** then read [the docs](https://example.com/docs).",
  "",
  "```",
  "## Not a heading",
  "```",
  "",
  "### Sub",
  "",
  "Sub text under the first setup.",
  "",
  "## Usage",
  "",
  "Usage text.",
  "",
  "## Setup `bun` **now**",
  "",
  "Second copy, last section.",
  "",
].join("\n");

const MDX = [
  "---",
  "title: Native",
  "---",
  "",
  "## Overview <Pill tone=\"info\">beta</Pill>",
  "",
  "The overview with a [[Linked Page|link label]].",
  "",
  "<Fold title=\"Details\">",
  "",
  "## Inside the fold",
  "",
  "Folded prose.",
  "",
  "</Fold>",
  "",
  "## Closing",
  "",
  "Closing prose.",
].join("\n");

describe("eligibleHeadings — the headings the reader decorates", () => {
  test("top-level headings only, as rendered text; fenced and stripped-title headings excluded", () => {
    const heads = eligibleHeadings(MD, { stripTitle: "Demo" }).map((h) => [h.level, h.text]);
    expect(heads).toEqual([
      [2, "Setup bun now"],
      [3, "Sub"],
      [2, "Usage"],
      [2, "Setup bun now"],
    ]);
  });

  test("on .mdx: inline components render to their text, a heading inside a Fold does not count", () => {
    const heads = eligibleHeadings(MDX, { stripTitle: "Native" }).map((h) => h.text);
    expect(heads).toEqual(["Overview beta", "Closing"]);
  });

  test("without the title strip the leading H1 is a heading like any other", () => {
    expect(eligibleHeadings(MD).map((h) => h.text)[0]).toBe("Demo");
  });
});

describe("locateSection", () => {
  const at = (heading: string, ordinal: number, count: number, md = MD, stripTitle = "Demo") =>
    locateSection(md, { heading, ordinal, count, stripTitle });

  test("a duplicate heading text: the ordinal picks the section", () => {
    const first = at("Setup bun now", 0, 2);
    const second = at("Setup bun now", 1, 2);
    expect(first.ok && first.section.markdown).toContain("Run **bun install**");
    expect(first.ok && first.section.markdown).not.toContain("Second copy");
    expect(second.ok && second.section.markdown).toContain("Second copy");
  });

  test("a section runs through deeper headings and ends at the next same-or-higher one", () => {
    const r = at("Setup bun now", 0, 2);
    expect(r.ok && r.section.markdown).toContain("Sub text under the first setup.");
    expect(r.ok && r.section.markdown).not.toContain("Usage text.");
    const sub = at("Sub", 0, 1);
    expect(sub.ok && sub.section.markdown.trim()).toBe("Sub text under the first setup.");
  });

  test("the last section runs to the end of the page", () => {
    const r = at("Setup bun now", 1, 2);
    expect(r.ok && r.section.markdown.trim()).toBe("Second copy, last section.");
  });

  test("a heading inside a code fence is not a section", () => {
    expect(at("Not a heading", 0, 1)).toEqual({ ok: false, reason: "not_found", found: 0 });
  });

  test("the heading matches with whitespace collapsed", () => {
    expect(at("  Setup   bun now ", 1, 2).ok).toBe(true);
  });

  test("a count the page no longer has is a mismatch, never a guess", () => {
    expect(at("Setup bun now", 0, 1)).toEqual({ ok: false, reason: "count_mismatch", found: 2 });
    expect(at("Setup bun now", 2, 3)).toEqual({ ok: false, reason: "count_mismatch", found: 2 });
  });

  test(".mdx: a section ends at the next top-level heading, a folded one stays inside it", () => {
    const r = locateSection(MDX, { heading: "Overview beta", ordinal: 0, count: 1, stripTitle: "Native" });
    expect(r.ok && r.section.markdown).toContain("Folded prose.");
    expect(r.ok && r.section.markdown).not.toContain("Closing prose.");
    expect(locateSection(MDX, { heading: "Inside the fold", ordinal: 0, count: 1 }).ok).toBe(false);
  });
});

describe("the quote check", () => {
  const section = "Run **bun install** then read [the docs](https://example.com/docs).\n\nIt   caches\npackages locally.";
  const plain = sectionPlainText(section);

  test("the section's plain text is the rendered text, whitespace collapsed", () => {
    expect(plain).toBe("Run bun install then read the docs. It caches packages locally.");
  });

  test("drops a step whose quote is not in the section; keeps one that differs only in markdown and whitespace", () => {
    const parsed = {
      steps: [
        { title: "Install", text: "t", quote: "Run bun   install\nthen read the **docs**." },
        { title: "Invented", text: "t", quote: "Run npm install and restart." },
      ],
      quiz: [
        { question: "q", choices: ["a", "b"], answer: 0, quote: "It caches packages locally." },
        { question: "q2", choices: ["a", "b"], answer: 1, quote: "It deletes packages remotely." },
      ],
      dropped: [],
    };
    const kept = checkQuotes(parsed, plain);
    expect(kept.steps.map((s) => s.title)).toEqual(["Install"]);
    expect(kept.quiz.map((q) => q.question)).toEqual(["q"]);
    expect(kept.dropped).toEqual([
      { kind: "step", reason: "quote_not_in_section" },
      { kind: "question", reason: "quote_not_in_section" },
    ]);
  });

  test("a kept quote is shown as the section's own text, not the model's spelling", () => {
    const kept = checkQuotes(
      {
        steps: [{ title: "Install", text: "t", quote: "Run bun   install\nthen read the **docs**." }],
        quiz: [{ question: "q", choices: ["a", "b"], answer: 0, quote: "It caches “packages” locally." }],
        dropped: [],
      },
      sectionPlainText('Run **bun install** then read [the docs](https://example.com/docs).\n\nIt caches "packages" locally.'),
    );
    expect(kept.steps.map((s) => s.quote)).toEqual(["Run bun install then read the docs."]);
    expect(kept.quiz.map((q) => q.quote)).toEqual(['It caches "packages" locally.']);
  });

  const one = (sectionMd: string, quote: string) =>
    checkQuotes({ steps: [{ title: "s", text: "t", quote }], quiz: [], dropped: [] }, sectionPlainText(sectionMd));

  test.each([
    ["a link destination", "Read [the docs](https://evil.example/phish) before starting work."],
    ["a wikilink target", "Read [[Invented Page|the docs]] before starting work."],
  ])("a quote that adds %s the section lacks is dropped", (_what, quote) => {
    const kept = one("Read [the docs](https://x.com) before starting work.", quote);
    expect(kept.steps).toEqual([]);
    expect(kept.dropped).toEqual([{ kind: "step", reason: "quote_not_in_section" }]);
  });

  test("a faithful quote of literal markdown from a code span is kept", () => {
    const section = "Use `**bold**` to make bold text in a page.";
    const shown = sectionPlainText(section);
    expect(shown).toBe("Use **bold** to make bold text in a page.");
    const kept = one(section, shown);
    expect(kept.steps.map((s) => s.quote)).toEqual([shown]);
    expect(kept.dropped).toEqual([]);
  });

  test.each([
    ["smart quotes", 'He said "hello world" to everyone.', "He said “hello world” to everyone."],
    ["NFD vs NFC", "Kaffe på Cafe\u0301 Oslo smaker godt.", "Kaffe på Café Oslo smaker godt."],
    ["en dash vs hyphen", "The 2024–2025 window closes early.", "The 2024-2025 window closes early."],
    ["arrow vs ->", "Page write → log line → commit.", "Page write -> log line -> commit."],
    ["guillemets vs straight quotes", "Det heter «svar» på norsk her.", 'Det heter "svar" på norsk her.'],
  ])("a faithful quote differing in %s is kept, shown as the section spells it", (_what, section, quote) => {
    const kept = one(section, quote);
    expect(kept.dropped).toEqual([]);
    expect(kept.steps.map((s) => s.quote)).toEqual([sectionPlainText(section)]);
  });

  test("a quote too short to ground anything is dropped even when it matches", () => {
    const kept = checkQuotes({ steps: [{ title: "x", text: "t", quote: "Run" }], quiz: [], dropped: [] }, plain);
    expect(kept.steps).toEqual([]);
    expect(kept.dropped).toEqual([{ kind: "step", reason: "quote_too_short" }]);
  });
});

describe("parseWalkthroughReply", () => {
  const good = {
    steps: [{ title: "A", text: "B", quote: "C quote text here" }],
    quiz: [{ question: "Q", choices: ["x", "y", "z"], answer: 2, quote: "C quote text here" }],
  };

  test("reads the JSON object, a wrapping fence and surrounding text tolerated", () => {
    expect(parseWalkthroughReply(JSON.stringify(good))?.steps.length).toBe(1);
    expect(parseWalkthroughReply("```json\n" + JSON.stringify(good) + "\n```")?.quiz.length).toBe(1);
    expect(parseWalkthroughReply("Here you go:\n" + JSON.stringify(good))?.steps.length).toBe(1);
  });

  test("not JSON, or no steps array, is a parse failure (null)", () => {
    expect(parseWalkthroughReply("I can't do that.")).toBeNull();
    expect(parseWalkthroughReply("{not json}")).toBeNull();
    expect(parseWalkthroughReply(JSON.stringify({ quiz: [] }))).toBeNull();
    expect(parseWalkthroughReply("[1,2]")).toBeNull();
  });

  test("a malformed item is dropped as malformed; the rest survive", () => {
    const r = parseWalkthroughReply(
      JSON.stringify({
        steps: [{ title: "A", text: "B", quote: "C" }, { title: "", text: "B", quote: "C" }],
        quiz: [
          { question: "Q", choices: ["x"], answer: 0, quote: "C" },
          { question: "Q", choices: ["x", "y"], answer: 2, quote: "C" },
          { question: "Q", choices: ["x", "y"], answer: 1, quote: "C" },
        ],
      }),
    )!;
    expect(r.steps.length).toBe(1);
    expect(r.quiz.length).toBe(1);
    expect(r.dropped.filter((d) => d.reason === "malformed").length).toBe(3);
  });

  test("steps past the cap are ignored", () => {
    const many = Array.from({ length: WALKTHROUGH_MAX_STEPS + 3 }, () => good.steps[0]);
    expect(parseWalkthroughReply(JSON.stringify({ steps: many }))!.steps.length).toBe(WALKTHROUGH_MAX_STEPS);
  });
});
