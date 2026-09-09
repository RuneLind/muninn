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
 * Whisper's real shape: one unbroken paragraph that ENDS in a newline.
 *
 * The trailing newline is the fixture's whole point, not decoration. The window
 * capper's rule is "a budget that does not reach past the text's FIRST newline
 * has no head to show" — so a paragraph with a newline anywhere past the budget
 * is thrown away in full, while a text with no newline at all falls through to
 * its word-boundary cut and survives. A whisper transcript has the newline.
 */
const FLAT = `${"word ".repeat(400)}end.\n`;
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
   * The failure the split exists for, as an inequality rather than a claim: run
   * a flat transcript through the WINDOW capper and the answer is the note and
   * nothing else. `headWithinBytes` returns `""` when the budget does not reach
   * past the text's first line, which for a one-paragraph transcript is the
   * whole thing — so a 2 MiB whisper transcript would be stored as 65 bytes of
   * apology.
   */
  test("the WINDOW capper would have thrown this transcript away entirely", () => {
    const cap = 500;
    expect(capTranscriptWindows(FLAT, cap).text).toBe(TRANSCRIPT_TRUNCATION_NOTE);
    expect(capFlatTranscript(FLAT, cap).text).not.toBe(TRANSCRIPT_TRUNCATION_NOTE);
    expect(bytesOf(capFlatTranscript(FLAT, cap).text)).toBeGreaterThan(400);
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
    const a = appendTranscriptSection("S", FLAT, cap);
    const b = appendTranscriptSection("S", FLAT, cap, true);
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
    const flat = appendTranscriptSection("S", FLAT, cap, false);
    const windowed = appendTranscriptSection("S", FLAT, cap, true);
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
