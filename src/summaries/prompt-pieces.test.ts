/**
 * The piece split is the SAME template as the builder — pinned here, because the
 * two drifting apart is exactly the failure the split exists to prevent and is
 * invisible on the page (a mis-tinted line still reads correctly).
 */

import { test, expect, describe } from "bun:test";
import { VALID_CATEGORIES } from "../utils/summary-parser.ts";
import { SUMMARY_STRUCTURE_BULLETS } from "./summary-structure.ts";
import { buildSummarySystemPrompt, windowedTranscriptRider } from "./summarizer-shared.ts";
import { joinPromptPieces, optionalPiece, summarySystemPromptPieces } from "./prompt-pieces.ts";
import { youTubeSystemPromptPieces, buildYouTubeSystemPrompt } from "../youtube/prompt.ts";
import {
  vimeoSystemPromptPieces,
  buildVimeoSystemPrompt,
  SUMMARIZE_INTRO as VIMEO_SUMMARIZE_INTRO,
} from "../vimeo/prompt.ts";
import { tikTokSystemPromptPieces, buildTikTokSystemPrompt } from "../tiktok/prompt.ts";
import { xVideoSystemPromptPieces, buildXVideoSystemPrompt } from "../x-article/video-prompt.ts";
import { xArticleSystemPromptPieces, buildXArticleSystemPrompt } from "../x-article/prompt.ts";
import { articleSystemPromptPieces, buildArticleSystemPrompt } from "../article/prompt.ts";
import { anthropicSystemPromptPieces, buildAnthropicSystemPrompt } from "../anthropic/prompt.ts";
import { SHIPPED_CAPTURE_PRESETS } from "./presets.ts";

const STANDARD = SHIPPED_CAPTURE_PRESETS.find((p) => p.id === "standard")!;

describe("joinPromptPieces", () => {
  test("is the pieces' bytes in order, and nothing else", () => {
    expect(
      joinPromptPieces([
        { id: "a", label: "A", text: "one" },
        { id: "b", label: "B", text: "\n\ntwo" },
      ]),
    ).toBe("one\n\ntwo");
    expect(joinPromptPieces([])).toBe("");
  });

  test("optionalPiece drops the piece entirely rather than contributing an empty span", () => {
    const piece = { id: "r", label: "R", text: "x" };
    expect(optionalPiece(true, piece)).toEqual([piece]);
    expect(optionalPiece(false, piece)).toEqual([]);
  });
});

describe("the shared scaffold", () => {
  test("the pieces join to exactly what buildSummarySystemPrompt returns", () => {
    for (const structure of [undefined, "- only this", SUMMARY_STRUCTURE_BULLETS.join("\n")]) {
      const built =
        structure === undefined
          ? buildSummarySystemPrompt("Intro.", VALID_CATEGORIES)
          : buildSummarySystemPrompt("Intro.", VALID_CATEGORIES, structure);
      const pieces =
        structure === undefined
          ? summarySystemPromptPieces("Intro.", VALID_CATEGORIES)
          : summarySystemPromptPieces("Intro.", VALID_CATEGORIES, structure);
      expect(joinPromptPieces(pieces)).toBe(built);
    }
  });

  test("splits into intro, envelope and structure — the three the page tints by", () => {
    const pieces = summarySystemPromptPieces("Intro.", ["a", "b"], "- one\n- two");
    expect(pieces.map((p) => p.id)).toEqual(["intro", "envelope", "structure"]);
    expect(pieces[0]!.text).toBe("Intro.\n\n");
    expect(pieces[1]!.text).toContain("Choose from: a, b");
    // The continuation indent belongs to the ENVELOPE's trailing spaces plus the
    // structure's own re-indent, exactly as the template spelled it.
    expect(pieces[1]!.text.endsWith("3. Then write a structured summary with:\n   ")).toBe(true);
    expect(pieces[2]!.text).toBe("- one\n   - two");
  });
});

describe("every vertical's builder is the join of its pieces", () => {
  const cases: Array<[string, () => string, () => string]> = [
    [
      "youtube",
      () => buildYouTubeSystemPrompt(STANDARD, { windowed: true, title: "T", videoUrl: "U" }),
      () => joinPromptPieces(youTubeSystemPromptPieces(STANDARD, { windowed: true, title: "T", videoUrl: "U" })),
    ],
    [
      "youtube (no window rider)",
      () => buildYouTubeSystemPrompt(STANDARD, { windowed: false, title: "T", videoUrl: "U" }),
      () => joinPromptPieces(youTubeSystemPromptPieces(STANDARD, { windowed: false, title: "T", videoUrl: "U" })),
    ],
    [
      "vimeo",
      () =>
        buildVimeoSystemPrompt({ preset: STANDARD, title: "T", url: "U", captionKind: "auto", outputLang: "nb" }),
      () =>
        joinPromptPieces(
          vimeoSystemPromptPieces({ preset: STANDARD, title: "T", url: "U", captionKind: "auto", outputLang: "nb" }),
        ),
    ],
    [
      "vimeo (manual captions)",
      () =>
        buildVimeoSystemPrompt({ preset: STANDARD, title: "T", url: "U", captionKind: "manual", outputLang: "en" }),
      () =>
        joinPromptPieces(
          vimeoSystemPromptPieces({ preset: STANDARD, title: "T", url: "U", captionKind: "manual", outputLang: "en" }),
        ),
    ],
    [
      "tiktok",
      () => buildTikTokSystemPrompt({ title: "T", url: "U", author: "A" }),
      () => joinPromptPieces(tikTokSystemPromptPieces({ title: "T", url: "U", author: "A" })),
    ],
    [
      "x-video",
      () => buildXVideoSystemPrompt({ title: "T", url: "U", author: "A" }),
      () => joinPromptPieces(xVideoSystemPromptPieces({ title: "T", url: "U", author: "A" })),
    ],
    [
      "x-article",
      () => buildXArticleSystemPrompt({ title: "T", author: "A", url: "U" }),
      () => joinPromptPieces(xArticleSystemPromptPieces({ title: "T", author: "A", url: "U" })),
    ],
    [
      "article",
      () => buildArticleSystemPrompt({ title: "T", author: "A", url: "U" }),
      () => joinPromptPieces(articleSystemPromptPieces({ title: "T", author: "A", url: "U" })),
    ],
    [
      "anthropic",
      () => buildAnthropicSystemPrompt({ framing: "anthropic", title: "T", url: "U" }),
      () => joinPromptPieces(anthropicSystemPromptPieces({ framing: "anthropic", title: "T", url: "U" })),
    ],
    [
      "anthropic (x framing, enriched)",
      () =>
        buildAnthropicSystemPrompt({
          framing: "x-post",
          title: "T",
          url: "U",
          enrichment: { kind: "x-link", destinationOnly: false },
        }),
      () =>
        joinPromptPieces(
          anthropicSystemPromptPieces({
            framing: "x-post",
            title: "T",
            url: "U",
            enrichment: { kind: "x-link", destinationOnly: false },
          }),
        ),
    ],
  ];

  for (const [name, build, join] of cases) {
    test(name, () => {
      expect(join()).toBe(build());
      expect(build().length).toBeGreaterThan(0);
    });
  }
});

describe("the pieces each vertical contributes", () => {
  test("YouTube drops the windowed rider when the transcript carries no windows", () => {
    const on = youTubeSystemPromptPieces(STANDARD, { windowed: true, title: "T", videoUrl: "U" });
    const off = youTubeSystemPromptPieces(STANDARD, { windowed: false, title: "T", videoUrl: "U" });
    expect(on.map((p) => p.id)).toEqual(["intro", "envelope", "structure", "rider-windowed", "context"]);
    expect(off.map((p) => p.id)).toEqual(["intro", "envelope", "structure", "context"]);
  });

  test("Vimeo's language rider is LAST, after the auto-caption one", () => {
    const ids = vimeoSystemPromptPieces({
      preset: STANDARD,
      title: "T",
      url: "U",
      captionKind: "auto",
      outputLang: "nb",
    }).map((p) => p.id);
    expect(ids).toEqual([
      "intro",
      "rider-windowed",
      // The scaffold's own separator between the intro block and the envelope —
      // the intro's bytes, so an intro span, not a second rider span.
      "intro",
      "envelope",
      "structure",
      "context",
      "rider-auto-caption",
      "rider-language",
    ]);
    expect(ids.indexOf("rider-auto-caption")).toBeLessThan(ids.indexOf("rider-language"));
  });

  /**
   * Vimeo bakes the windowed-transcript sentence into its intro STRING (unlike
   * YouTube, which appends it as a piece), so the page tinted it as "Intro" and
   * the cell omitted the chip the contract names. It is its own span now — and
   * the split is a SPLIT: the three texts concatenate to the piece they
   * replaced, so not one byte of the prompt moved.
   *
   * THREE and not two, because the scaffold's intro piece ends in the `\n\n`
   * that separates the intro block from the envelope. Those bytes are the
   * intro's; a two-way split hands them to the rider span, which then reads as a
   * rider running to the blank line.
   */
  test("Vimeo's windowed rider is its own span, and splitting it changed no byte", () => {
    const input = {
      preset: STANDARD,
      title: "T",
      url: "U",
      captionKind: "auto" as const,
      outputLang: "en" as const,
    };
    const pieces = vimeoSystemPromptPieces(input);
    expect(pieces[0]!.id).toBe("intro");
    expect(pieces[1]!.id).toBe("rider-windowed");
    expect(pieces[2]!.id).toBe("intro");
    // The scaffold's single intro piece, as it was before the split.
    const scaffoldIntro = summarySystemPromptPieces(
      VIMEO_SUMMARIZE_INTRO,
      VALID_CATEGORIES,
      STANDARD.instruction,
    )[0]!;
    expect(pieces[0]!.text + pieces[1]!.text + pieces[2]!.text).toBe(scaffoldIntro.text);
    // The rider span is the seam's sentence and NOTHING else — no separator.
    expect(pieces[1]!.text).toBe(windowedTranscriptRider("talk"));
    expect(pieces[0]!.text).not.toContain(windowedTranscriptRider("talk"));
    expect(pieces[2]!.text).toBe("\n\n");
    // The chip label is the one the YouTube row shows for the same sentence.
    expect(pieces[1]!.label).toBe(
      youTubeSystemPromptPieces(STANDARD, { windowed: true, title: "T", videoUrl: "U" }).find(
        (p) => p.id === "rider-windowed",
      )!.label,
    );
  });

  test("the short-video envelopes keep their own no-commentary piece", () => {
    for (const pieces of [
      tikTokSystemPromptPieces({ title: "T", url: "U", author: "A" }),
      xVideoSystemPromptPieces({ title: "T", url: "U", author: "A" }),
    ]) {
      expect(pieces.map((p) => p.id)).toEqual(["envelope", "structure", "no-commentary", "context"]);
      expect(pieces.find((p) => p.id === "no-commentary")!.text).toContain("produce NO commentary");
    }
  });

  test("an article with no url and no author omits those context lines entirely", () => {
    const full = joinPromptPieces(articleSystemPromptPieces({ title: "T", author: "A", url: "U" }));
    const bare = joinPromptPieces(articleSystemPromptPieces({ title: "T" }));
    expect(full).toContain("Article author: A");
    expect(full).toContain("Article URL: U");
    expect(bare).toContain("Article title: T");
    expect(bare).not.toContain("Article author:");
    expect(bare).not.toContain("Article URL:");
  });
});
