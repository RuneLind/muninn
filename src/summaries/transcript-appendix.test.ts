/**
 * The `## Transcript` append, and the TWO cappers behind it.
 *
 * `src/youtube/frames.test.ts` already drives the WINDOWED capper hard (it was
 * written when that was the only one); what this file exists for is the split:
 * that the flat path is a different capper, that picking the wrong one is
 * destructive rather than merely imprecise, and that the module's names are
 * still reachable under their old spellings from `src/youtube/frames.ts`.
 */

import { test, expect, describe } from "bun:test";
import {
  TRANSCRIPT_MAX_BYTES,
  TRANSCRIPT_TRUNCATION_NOTE,
  appendTranscriptSection,
  capFlatTranscript,
  capTranscriptWindows,
} from "./transcript-appendix.ts";
import * as youtubeFrames from "../youtube/frames.ts";

const bytesOf = (s: string) => new TextEncoder().encode(s).length;

/**
 * Whisper's real shapes — all three of them, because which capper is right is a
 * statement about the newline layout and this producer emits three layouts.
 *
 * `transcribeVideo` returns a `.trim()`ed string, so NONE of them can carry the
 * trailing newline a fixture can manufacture; what whisper does emit is one line
 * per SEGMENT, which is where the newlines come from. Measured at a 500-byte cap
 * (the numbers are in `capFlatTranscript`'s docblock): the window capper answers
 * 495, 487 and 64 bytes for the three, and the flat capper 500 for all three.
 * Only the third is destructive — and it is the one nothing pinned.
 */
const FLAT_ONE_LINE = `${"word ".repeat(400)}end.`;
/** One line per whisper segment: single newlines, no blank line anywhere. */
const FLAT_SEGMENTED = Array.from(
  { length: 120 },
  (_, i) => `segment ${i} of the spoken transcript`,
).join("\n");
/**
 * A first line LONGER than the budget, with segments after it — the layout
 * `headWithinBytes` answers with `""`, because its rule is "a budget that does
 * not reach past the text's FIRST newline has no head to show". Reachable
 * rather than theoretical: `maxBytes` is the caller's argument, so "the budget
 * does not reach the first newline" is a claim about the two together.
 */
const FLAT_LONG_FIRST_LINE = `${"word ".repeat(400)}end.\nand one more segment.`;
/** The one this file's older cases used, kept as the default flat fixture. */
const FLAT = FLAT_ONE_LINE;
/** huginn's shape: `### [HH:MM:SS]` over one long line, windows split by a blank line. */
const WINDOWED = ["### [00:00:00]", "", "first window speech", "", "### [00:02:00]", "", "second window speech"]
  .join("\n")
  .replace("first window speech", "first window speech ".repeat(30))
  .replace("second window speech", "second window speech ".repeat(30));

describe("capFlatTranscript", () => {
  test("under the budget it is the transcript, untouched and un-noted", () => {
    const out = capFlatTranscript("short", 1000);
    expect(out).toEqual({ text: "short", truncated: false, inputBytes: 5, keptBytes: 5 });
  });

  test("over the budget it keeps a HEAD and says so, inside the cap", () => {
    const cap = 500;
    const out = capFlatTranscript(FLAT, cap);
    expect(out.truncated).toBe(true);
    expect(out.text.endsWith(TRANSCRIPT_TRUNCATION_NOTE)).toBe(true);
    expect(out.text.startsWith("word word")).toBe(true);
    expect(out.keptBytes).toBeLessThanOrEqual(cap);
    expect(out.inputBytes).toBe(bytesOf(FLAT));
  });

  /**
   * The three layouts side by side — the whole case for the split, as measured
   * numbers rather than as a claim about one manufactured fixture.
   *
   * The flat capper answers the SAME way for all three, because its cut is
   * decided by the budget. The window capper answers three different ways,
   * because its cut is decided by the newlines: a word boundary, a line
   * boundary, and — on the third — the truncation note ALONE, which is a
   * transcript stored as 64 bytes of apology.
   */
  test("the flat capper's cut is the budget's; the window capper's is the newlines'", () => {
    const cap = 500;
    for (const [name, text] of [
      ["one unbroken line", FLAT_ONE_LINE],
      ["one line per segment", FLAT_SEGMENTED],
      ["a first line past the budget", FLAT_LONG_FIRST_LINE],
    ] as const) {
      const flat = capFlatTranscript(text, cap);
      // Same answer whatever the layout: the head the budget allows, and never
      // the note alone.
      expect(flat.keptBytes, name).toBe(cap);
      expect(flat.text.startsWith(text.slice(0, 40)), name).toBe(true);
      expect(flat.text.endsWith(TRANSCRIPT_TRUNCATION_NOTE), name).toBe(true);
    }

    // The window capper, layout by layout — a different answer each time.
    expect(capTranscriptWindows(FLAT_ONE_LINE, cap).text).not.toBe(TRANSCRIPT_TRUNCATION_NOTE);
    const segmented = capTranscriptWindows(FLAT_SEGMENTED, cap);
    expect(segmented.text).not.toBe(TRANSCRIPT_TRUNCATION_NOTE);
    // Cut at a LINE boundary, which is a structure this text does not have.
    expect(segmented.text.slice(0, -`\n\n${TRANSCRIPT_TRUNCATION_NOTE}`.length).endsWith("transcript")).toBe(true);
    // …and the destructive one: nothing of the transcript survives.
    expect(capTranscriptWindows(FLAT_LONG_FIRST_LINE, cap).text).toBe(TRANSCRIPT_TRUNCATION_NOTE);
    expect(capFlatTranscript(FLAT_LONG_FIRST_LINE, cap).text).not.toBe(TRANSCRIPT_TRUNCATION_NOTE);
    expect(bytesOf(capFlatTranscript(FLAT_LONG_FIRST_LINE, cap).text)).toBeGreaterThan(400);
  });

  test("and the WINDOWED capper is still the right one for windowed text", () => {
    // The complement: on huginn's shape the window capper cuts at a window
    // BOUNDARY, where the flat one cuts wherever the byte budget lands.
    const cap = 700;
    const tail = `\n\n${TRANSCRIPT_TRUNCATION_NOTE}`;
    const windowed = capTranscriptWindows(WINDOWED, cap);
    expect(windowed.truncated).toBe(true);
    expect(windowed.text.endsWith(tail)).toBe(true);

    const kept = windowed.text.slice(0, -tail.length);
    // A prefix of the input, ending exactly where a window ends — so no
    // `### [HH:MM:SS]` heading is left standing over half a sentence.
    expect(WINDOWED.startsWith(kept)).toBe(true);
    expect(WINDOWED.slice(kept.length).startsWith("\n\n")).toBe(true);

    // The flat capper on the SAME text lands somewhere else — that difference is
    // the reason `appendTranscriptSection` takes a `windowed` argument at all.
    const flat = capFlatTranscript(WINDOWED, cap);
    expect(flat.text).not.toBe(windowed.text);
    const flatKept = flat.text.slice(0, -tail.length);
    expect(WINDOWED.slice(flatKept.length).startsWith("\n\n")).toBe(false);
  });
});

describe("appendTranscriptSection", () => {
  test("puts the transcript under a level-2 `## Transcript`, after the summary", () => {
    const out = appendTranscriptSection("SUMMARY BODY\n", "### [00:00:00]\nhello");
    expect(out.text).toBe("SUMMARY BODY\n\n## Transcript\n\n### [00:00:00]\nhello\n");
    expect(out.truncated).toBe(false);
  });

  test("defaults to the WINDOWED capper, so every pre-existing caller is unchanged", () => {
    const cap = 500;
    // Three spellings of the same call: the two-argument one every caller used
    // before the flag, the explicit-cap one the tests used, and the explicit
    // `true`. All windowed.
    const a = appendTranscriptSection("S", FLAT_LONG_FIRST_LINE, cap);
    const b = appendTranscriptSection("S", FLAT_LONG_FIRST_LINE, cap, true);
    expect(a.text).toBe(b.text);
    expect(a.text).toBe(`S\n\n## Transcript\n\n${TRANSCRIPT_TRUNCATION_NOTE}\n`);
  });

  test("`windowed: false` files a flat transcript whole", () => {
    const out = appendTranscriptSection("S", "one flat line of speech", TRANSCRIPT_MAX_BYTES, false);
    expect(out.text).toBe("S\n\n## Transcript\n\none flat line of speech\n");
    expect(out.truncated).toBe(false);
  });

  test("`windowed: false` over the cap keeps a head where `true` keeps nothing", () => {
    const cap = 500;
    // The layout on which the two really diverge — see the capper cases above.
    const flat = appendTranscriptSection("S", FLAT_LONG_FIRST_LINE, cap, false);
    const windowed = appendTranscriptSection("S", FLAT_LONG_FIRST_LINE, cap, true);
    expect(flat.truncated).toBe(true);
    expect(flat.text).toContain("word word");
    expect(windowed.text).not.toContain("word word");
  });

  test("the cap defaults to 2 MiB and a big transcript stays about there", () => {
    expect(TRANSCRIPT_MAX_BYTES).toBe(2 * 1024 * 1024);
    const long = "x".repeat(TRANSCRIPT_MAX_BYTES + 5000);
    const out = appendTranscriptSection("S", long, undefined, false);
    expect(out.truncated).toBe(true);
    expect(out.keptBytes).toBeLessThanOrEqual(TRANSCRIPT_MAX_BYTES);
  });
});

describe("the old spellings still resolve through src/youtube/frames.ts", () => {
  /**
   * The move is only safe while every importer of the old module keeps its
   * import — `src/youtube/summarizer.ts`, `src/youtube/frames.test.ts` and
   * `sum-article-library.test.ts` all name these through `frames.ts`.
   */
  test("the re-exports are the same functions and the same constant", () => {
    expect(youtubeFrames.appendTranscriptSection).toBe(appendTranscriptSection);
    expect(youtubeFrames.capTranscriptWindows).toBe(capTranscriptWindows);
    expect(youtubeFrames.capFlatTranscript).toBe(capFlatTranscript);
    expect(youtubeFrames.YOUTUBE_TRANSCRIPT_MAX_BYTES).toBe(TRANSCRIPT_MAX_BYTES);
    expect(youtubeFrames.TRANSCRIPT_TRUNCATION_NOTE).toBe(TRANSCRIPT_TRUNCATION_NOTE);
  });
});
