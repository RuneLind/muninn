import { test, expect, describe } from "bun:test";
import { TRANSCRIPT_TRUNCATION_NOTE, byteLength, capTextWithNote, headWithinBytes } from "./truncation.ts";

/**
 * The two cappers in this leaf answer different questions, and the whole point
 * of the file is that they do not share a rule.
 *
 * `headWithinBytes` is the WINDOW-aware one: huginn's transcript windows are a
 * `### [HH:MM:SS]` heading followed by one unbroken line, so a budget that does
 * not reach past the heading has no head to show and the function says so with
 * `""`. `capTextWithNote` has no windows — it caps a stored PROMPT, which is a
 * system scaffold with a transcript pasted into it and may be one paragraph
 * with no newline until the very end. Inheriting the window rule there deleted
 * the prompt: measured on a 300 KB single-paragraph article with a trailing
 * newline, the stored row was the 62-byte note and nothing else, while the same
 * text with the newline removed stored 262,140 bytes.
 */
const NOTE_BYTES = byteLength(TRANSCRIPT_TRUNCATION_NOTE);
/** What `capTextWithNote` reserves: the note plus the `\n\n` it is joined on. */
const RESERVED = NOTE_BYTES + 2;

describe("capTextWithNote", () => {
  test("a one-paragraph text whose only newline is PAST the budget keeps its head", () => {
    // The reachable shape: `article-routes.ts` ingests pasted text uncapped, and
    // a pasted article is one paragraph that ends on a newline.
    const text = `${"a".repeat(300_000)}\n`;
    const capped = capTextWithNote(text, 4096);

    expect(capped).not.toBe(TRANSCRIPT_TRUNCATION_NOTE);
    expect(capped.startsWith("aaaa")).toBe(true);
    expect(capped.endsWith(TRANSCRIPT_TRUNCATION_NOTE)).toBe(true);
    expect(byteLength(capped)).toBeLessThanOrEqual(4096);
    // Not merely "non-empty": the whole budget minus the note is spent on text.
    expect(byteLength(capped)).toBe(4096);
  });

  test("a text with NO newline anywhere keeps its head — the case that already worked", () => {
    const text = "b".repeat(300_000);
    const capped = capTextWithNote(text, 4096);
    expect(capped.startsWith("bbbb")).toBe(true);
    expect(capped.endsWith(TRANSCRIPT_TRUNCATION_NOTE)).toBe(true);
    expect(byteLength(capped)).toBe(4096);
  });

  test("a multi-line text keeps its head too, and the two shapes agree on length", () => {
    const oneParagraph = `${"c".repeat(300_000)}\n`;
    const manyLines = "c".repeat(50).concat("\n").repeat(6000);
    expect(byteLength(capTextWithNote(oneParagraph, 4096))).toBe(4096);
    expect(byteLength(capTextWithNote(manyLines, 4096))).toBe(4096);
  });

  test("a text at exactly the cap is returned byte-for-byte, note and all absent", () => {
    const text = "d".repeat(4096);
    expect(capTextWithNote(text, 4096)).toBe(text);
    // One byte over is where the note appears.
    expect(capTextWithNote(`${text}e`, 4096)).not.toBe(`${text}e`);
  });

  test("empty input is returned unchanged", () => {
    expect(capTextWithNote("", 4096)).toBe("");
  });

  test("a cut inside a multi-byte code point stores no replacement character", () => {
    // Three bytes each, and a trailing newline — the late-newline shape again,
    // so this is also the case the window rule emptied.
    const text = `${"あ".repeat(100_000)}\n`;
    const capped = capTextWithNote(text, 4096);

    expect(capped).not.toContain("�");
    expect(capped.startsWith("ああ")).toBe(true);
    expect(capped.endsWith(TRANSCRIPT_TRUNCATION_NOTE)).toBe(true);
    expect(byteLength(capped)).toBeLessThanOrEqual(4096);
    // A 3-byte budget cannot land flush: the cut costs at most two bytes.
    expect(byteLength(capped)).toBeGreaterThanOrEqual(4096 - 2);
  });

  test("a multi-byte text with no newline is byte-safe as well", () => {
    const capped = capTextWithNote("あ".repeat(100_000), 4096);
    expect(capped).not.toContain("�");
    expect(byteLength(capped)).toBeLessThanOrEqual(4096);
  });

  test("a budget too small for the note answers the note alone", () => {
    // The documented band: there is no text left to bound, so the answer is
    // over the caller's cap rather than empty.
    expect(capTextWithNote("x".repeat(1000), RESERVED - 1)).toBe(TRANSCRIPT_TRUNCATION_NOTE);
  });
});

describe("headWithinBytes keeps its window rule", () => {
  test("a budget that stops inside the FIRST line answers nothing", () => {
    // The frames capper's contract: half a `### [HH:MM:SS]` heading is not a
    // head of the talk. `capTextWithNote` must not inherit this.
    expect(headWithinBytes("### [00:00:00]\nthe window's speech", 6)).toBe("");
  });

  test("a budget past the heading cuts at the last newline", () => {
    const text = "### [00:00:00]\nfirst window\n### [00:02:00]\nsecond window";
    expect(headWithinBytes(text, 30)).toBe("### [00:00:00]\nfirst window");
  });
});
