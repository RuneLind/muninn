/**
 * The merged short-video prompt — the two builders it replaced, and the
 * positions that are load-bearing.
 *
 * Two things this file exists to pin, and neither is visible from
 * `prompt-pieces.test.ts` (which only checks that a builder is the join of its
 * own pieces — both sides of that comparison move together):
 *
 *  - **The composed string, as a literal.** A second spelling of the prompt is
 *    normally the thing to avoid; here it is the change-detector, exactly as
 *    `summarizer-shared.test.ts`'s scaffold literal is. It is what proves the
 *    shared envelope's `before`/`after` slots reproduce the hand-rolled
 *    numbering — `1.` read the frames, `2.` visual-only, `3.` CATEGORY, `4.`
 *    SUMMARY, `5.` structure, `6.` no commentary — rather than merely producing
 *    a plausible prompt.
 *  - **The no-commentary rule's POSITION.** Without it the model narrates its
 *    frame Reads and the chatter streams into the shelf card ahead of the
 *    summary; stated before the structure step it reads as a rule about the
 *    frames rather than about the whole answer. Its presence AND its place after
 *    the structure are asserted.
 */

import { test, expect, describe } from "bun:test";
import { VALID_CATEGORIES } from "../utils/summary-parser.ts";
import { SUMMARY_STRUCTURE_BULLETS } from "../summaries/summary-structure.ts";
import { SHIPPED_CAPTURE_PRESETS, type CapturePreset } from "../summaries/presets.ts";
import { joinPromptPieces } from "../summaries/prompt-pieces.ts";
import {
  TIKTOK_PROMPT_SPEC,
  X_VIDEO_PROMPT_SPEC,
  buildShortVideoSystemPrompt,
  buildShortVideoUserPrompt,
  formatTimestamp,
  frameListBlock,
  shortVideoSystemPromptPieces,
} from "./short-video-prompt.ts";

const STANDARD = SHIPPED_CAPTURE_PRESETS.find((p) => p.id === "standard")!;

/** A one-bullet kind, so the whole-prompt literal below fits on a page. */
const TINY: CapturePreset = {
  id: "tiny",
  label: "Tiny",
  instruction: "- One bullet, and nothing else.",
  run: { thinking: "capped", model: "bot" },
};

describe("the composed system prompt", () => {
  test("is EXACTLY this, numbering and all — the TikTok spelling", () => {
    expect(
      buildShortVideoSystemPrompt(TIKTOK_PROMPT_SPEC, {
        preset: TINY,
        title: "A placeholder capture",
        url: "https://www.tiktok.com/@placeholder/video/1234567890123456789",
        author: "placeholder-author",
      }),
    ).toBe(`You are a video content analyst. Summarize the following TikTok video, using BOTH its speech transcript and the extracted keyframe images.

Instructions:
1. Read ALL the frame images listed below (with the Read tool) FIRST, batching many Read tool calls into one turn (parallel tool calls) — do NOT read one frame per message. TikToks often carry most of their information on screen — capture diagrams, code, on-screen text, and visual demos.
2. Note explicitly when key information is visual-only (not spoken).
3. Start your response with EXACTLY this line: CATEGORY: <category>
   Choose from: ${VALID_CATEGORIES.join(", ")}
4. Then add a blank line, then SUMMARY: on its own line
5. Then write a structured summary with:
   - One bullet, and nothing else.
6. CRITICAL: produce NO commentary — your only text output is the final CATEGORY/SUMMARY response. Do not narrate the frames as you read them.

Video title: A placeholder capture
Video URL: https://www.tiktok.com/@placeholder/video/1234567890123456789
Author: placeholder-author`);
  });

  test("the X spelling differs in the platform noun and the frame clause, and nowhere else", () => {
    const input = {
      preset: TINY,
      title: "T",
      url: "https://x.com/placeholder/status/1",
      author: "A",
    };
    const tiktok = buildShortVideoSystemPrompt(TIKTOK_PROMPT_SPEC, input);
    const x = buildShortVideoSystemPrompt(X_VIDEO_PROMPT_SPEC, input);
    expect(x).not.toBe(tiktok);
    // Substituting the two spec strings back turns one into the other — which
    // is the claim "the platforms differ in two clauses" as an equality rather
    // than as a pair of `toContain`s.
    expect(
      x
        .replace("the following X/Twitter video", "the following TikTok video")
        .replace(X_VIDEO_PROMPT_SPEC.frameClause, TIKTOK_PROMPT_SPEC.frameClause),
    ).toBe(tiktok);
  });

  test("the builder is the join of its own pieces, with the ids the page tints by", () => {
    const input = { preset: STANDARD, title: "T", url: "U", author: "A" };
    const pieces = shortVideoSystemPromptPieces(TIKTOK_PROMPT_SPEC, input);
    expect(joinPromptPieces(pieces)).toBe(buildShortVideoSystemPrompt(TIKTOK_PROMPT_SPEC, input));
    expect(pieces.map((p) => p.id)).toEqual([
      "intro",
      "instructions",
      "read-frames",
      "visual-only",
      "envelope",
      "structure",
      "no-commentary",
      "context",
    ]);
    // No empty span: an absent piece must be dropped, not tinted as nothing.
    for (const p of pieces) expect(p.text.length).toBeGreaterThan(0);
  });

  test("the no-commentary rule is present, is step 6, and comes AFTER the structure", () => {
    const prompt = buildShortVideoSystemPrompt(TIKTOK_PROMPT_SPEC, {
      preset: STANDARD,
      title: "T",
      url: "U",
      author: "A",
    });
    expect(prompt).toContain(
      "\n6. CRITICAL: produce NO commentary — your only text output is the final CATEGORY/SUMMARY response. Do not narrate the frames as you read them.",
    );
    // Position, not just presence: the rule governs the whole answer, so it is
    // stated after the structure bullets rather than among the frame rules.
    const lastBullet = SUMMARY_STRUCTURE_BULLETS[SUMMARY_STRUCTURE_BULLETS.length - 1]!;
    expect(prompt.indexOf("6. CRITICAL: produce NO commentary")).toBeGreaterThan(
      prompt.indexOf(lastBullet),
    );
    // …and after the CATEGORY step, which is what a `before`-slotted rule would
    // have come before.
    expect(prompt.indexOf("6. CRITICAL")).toBeGreaterThan(prompt.indexOf("3. Start your response"));
  });

  test("the KIND's instruction is what the structure step carries", () => {
    const talkNotes = SHIPPED_CAPTURE_PRESETS.find((p) => p.id === "talk-notes")!;
    const prompt = buildShortVideoSystemPrompt(X_VIDEO_PROMPT_SPEC, {
      preset: talkNotes,
      title: "T",
      url: "U",
      author: "A",
    });
    expect(prompt).toContain("## Timeline");
    expect(prompt).not.toContain("- Use a markdown table when the content is genuinely comparative");
  });
});

describe("the user prompt", () => {
  test("transcript then keyframes, in the `t=M:SS <path>` shape", () => {
    expect(
      buildShortVideoUserPrompt({
        transcript: "Some speech.",
        frames: [
          { path: "/tmp/a/frame_001.jpg", tSeconds: 4 },
          { path: "/tmp/a/frame_002.jpg", tSeconds: 72 },
        ],
      }),
    ).toBe(
      "Transcript:\nSome speech.\n\nKeyframes (read each image before summarizing):\n" +
        "t=0:04 /tmp/a/frame_001.jpg\nt=1:12 /tmp/a/frame_002.jpg",
    );
  });

  test("an empty transcript is a real capture, and says so instead of sending a blank section", () => {
    const out = buildShortVideoUserPrompt({
      transcript: "",
      frames: [{ path: "/tmp/a/frame_001.jpg", tSeconds: 0 }],
    });
    expect(out.startsWith("No speech detected — summarize from the frames.")).toBe(true);
    expect(out).not.toContain("Transcript:");
  });

  test("no frames ⇒ no keyframes section at all", () => {
    expect(buildShortVideoUserPrompt({ transcript: "Some speech.", frames: [] })).toBe(
      "Transcript:\nSome speech.",
    );
  });

  test("formatTimestamp floors, clamps at zero and pads the seconds", () => {
    expect([formatTimestamp(-5), formatTimestamp(0), formatTimestamp(9.9), formatTimestamp(3599)]).toEqual([
      "0:00",
      "0:00",
      "0:09",
      "59:59",
    ]);
    expect(frameListBlock([])).toBe("");
  });
});
