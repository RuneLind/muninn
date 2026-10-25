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
import {
  TIKTOK_PROMPT_SPEC,
  X_VIDEO_PROMPT_SPEC,
  buildShortVideoSystemPrompt,
  shortVideoSystemPromptPieces,
} from "../video/short-video-prompt.ts";
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

  /**
   * The id guard over the WHOLE list.
   *
   * `assertEnvelopeInstructions` sees the envelope's own four ids and the slot
   * entries, which is everything the envelope knows about — and nothing about
   * the pieces the vertical appends AROUND it. So a slot entry could take the id
   * of the vertical's own `context` piece, and the page would tint two different
   * parts as one and chip the name twice. The join is where the whole list
   * exists, so that is where the check lives.
   */
  test("two content pieces sharing an id are refused at the join", () => {
    const collide = () =>
      joinPromptPieces([
        ...summarySystemPromptPieces("I.", ["a"], "- one", {
          after: [{ id: "context", label: "No-commentary rule", text: "Say nothing else." }],
        }),
        { id: "context", label: "Video context", text: "\n\nVideo URL: u" },
      ]);
    expect(collide).toThrow(/share the piece id "context"/);
  });

  test("an empty id on a content piece is refused at the join", () => {
    expect(() => joinPromptPieces([{ id: "", label: "X", text: "words" }])).toThrow(
      /empty piece id/,
    );
  });

  /**
   * A WHITESPACE-only span may repeat an id, and that exemption is Vimeo's: its
   * intro is split around the windowed rider, and the trailing slice is the
   * `\n\n` before the envelope — the same piece, in two spans, with a separator
   * between them. It contributes no chip (`pieceChips` filters it) and has no
   * visible tint, so it is not a second part claiming the name.
   */
  test("a whitespace-only span may repeat an id — the separator is not a part", () => {
    expect(() =>
      joinPromptPieces([
        { id: "intro", label: "Intro", text: "You are an analyst." },
        { id: "rider-windowed", label: "Windowed transcript rider", text: " The windows are positions." },
        { id: "intro", label: "Intro", text: "\n\n" },
      ]),
    ).not.toThrow();
  });

  /** Every shipped builder still joins — the guard must not refuse production. */
  test("the shipped builders' piece lists all pass the id guard", () => {
    // Vimeo first: it is the only shipped builder whose list repeats an id.
    expect(() =>
      buildVimeoSystemPrompt({
        preset: STANDARD,
        title: "T",
        url: "U",
        captionKind: "auto",
        outputLang: "en",
      }),
    ).not.toThrow();
    expect(() =>
      buildShortVideoSystemPrompt(TIKTOK_PROMPT_SPEC, {
        preset: STANDARD,
        title: "T",
        url: "https://www.tiktok.com/@a/video/1",
        author: "a",
      }),
    ).not.toThrow();
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

/**
 * The `before`/`after` slots — the short-video verticals' way onto the shared
 * envelope, and the reason they could not take it before.
 *
 * The slots NUMBER what they hold, which is the whole point: a `before` entry
 * renumbers the envelope's own three steps rather than leaving a prompt with two
 * step 1s.
 */
describe("the envelope's before/after slots", () => {
  const BEFORE = [
    { id: "read-frames", label: "Frame-reading rule", text: "Read the frames first." },
    { id: "visual-only", label: "Visual-only rule", text: "Say when a point is visual-only." },
  ];
  const AFTER = [{ id: "no-commentary", label: "No-commentary rule", text: "Produce NO commentary." }];

  test("the slotted shape is EXACTLY this — a second literal, like the scaffold's own", () => {
    expect(
      joinPromptPieces(
        summarySystemPromptPieces("Intro.", ["a", "b"], "- one\n- two", {
          before: BEFORE,
          after: AFTER,
        }),
      ),
    ).toBe(`Intro.

Instructions:
1. Read the frames first.
2. Say when a point is visual-only.
3. Start your response with EXACTLY this line: CATEGORY: <category>
   Choose from: a, b
4. Then add a blank line, then SUMMARY: on its own line
5. Then write a structured summary with:
   - one
   - two
6. Produce NO commentary.`);
  });

  test("each slotted instruction is its OWN piece, so the page tints it as itself", () => {
    const pieces = summarySystemPromptPieces("Intro.", ["a"], "- one", {
      before: BEFORE,
      after: AFTER,
    });
    expect(pieces.map((p) => p.id)).toEqual([
      "intro",
      // `Instructions:` becomes a span of its own only when a `before` entry has
      // to sit between it and the CATEGORY step — a span cannot be split around
      // another span.
      "instructions",
      "read-frames",
      "visual-only",
      "envelope",
      "structure",
      "no-commentary",
    ]);
    expect(pieces.find((p) => p.id === "instructions")!.text).toBe("Instructions:\n");
    expect(pieces.find((p) => p.id === "read-frames")!.text).toBe("1. Read the frames first.\n");
    expect(pieces.find((p) => p.id === "no-commentary")!.text).toBe("\n6. Produce NO commentary.");
    expect(pieces.find((p) => p.id === "read-frames")!.label).toBe("Frame-reading rule");
  });

  test("a `before` entry RENUMBERS the envelope's own steps", () => {
    const none = joinPromptPieces(summarySystemPromptPieces("I.", ["a"], "- one"));
    const one = joinPromptPieces(
      summarySystemPromptPieces("I.", ["a"], "- one", { before: [BEFORE[0]!] }),
    );
    expect(none).toContain("1. Start your response with EXACTLY this line");
    expect(one).toContain("2. Start your response with EXACTLY this line");
    expect(one).toContain("3. Then add a blank line");
    expect(one).toContain("4. Then write a structured summary with:");
    // …and there is exactly ONE step 1, which is the slotted one. Counted with
    // `g`, because `/^1\. /m` finds the first match and `[0]` is then the
    // pattern's own literal text — an assertion that cannot fail whatever the
    // prompt says, and that survived a renumbering mutation.
    expect(one.match(/^1\. /gm)).toHaveLength(1);
    expect(one).toContain("1. Read the frames first.");
  });

  test("`after` numbers on from the structure step, one line each", () => {
    const two = joinPromptPieces(
      summarySystemPromptPieces("I.", ["a"], "- one", {
        after: [AFTER[0]!, { id: "x", label: "X", text: "And this." }],
      }),
    );
    expect(two.endsWith("3. Then write a structured summary with:\n   - one\n4. Produce NO commentary.\n5. And this.")).toBe(
      true,
    );
  });

  /**
   * The slot's CONTRACT, refused at construction.
   *
   * `text` is documented as "the instruction, unnumbered and unterminated", and
   * every shape below silently produced a malformed prompt or a wrong tint
   * instead of an error. The measured one: `after: [{ text: "\n6. legacy" }]`
   * composed a step 4 with no words after its number and an orphan `6.` on the
   * next line, and the page tinted both as the same piece. A slot entry is
   * written once, in code, by a vertical author — so the honest answer to a
   * shape the envelope cannot number is a throw, not a best effort.
   */
  describe("the slot contract", () => {
    const ok = { id: "r", label: "R", text: "Do the thing." };
    /** Compose with one slot entry replaced by `bad`, in whichever slot. */
    const withEntry = (slot: "before" | "after" | "envelopeLines", bad: { id: string; label: string; text: string }) =>
      () => summarySystemPromptPieces("I.", ["a"], "- one", { [slot]: [bad] });

    for (const slot of ["before", "after", "envelopeLines"] as const) {
      test(`${slot}: empty text is refused`, () => {
        expect(withEntry(slot, { ...ok, text: "" })).toThrow(/no text/);
        expect(withEntry(slot, { ...ok, text: "   \n " })).toThrow(/no text/);
      });

      test(`${slot}: text that carries its own leading newline or spacing is refused`, () => {
        // The measured probe: a legacy instruction pasted in with the newline
        // and the number the envelope is supposed to add.
        expect(withEntry(slot, { ...ok, text: "\n6. legacy" })).toThrow(/leading or trailing whitespace/);
        expect(withEntry(slot, { ...ok, text: "Do the thing. " })).toThrow(/leading or trailing whitespace/);
      });

      test(`${slot}: multi-line text is refused`, () => {
        expect(withEntry(slot, { ...ok, text: "First line.\nSecond line." })).toThrow(/one line/);
      });

      test(`${slot}: text that numbers itself is refused`, () => {
        expect(withEntry(slot, { ...ok, text: "6. legacy" })).toThrow(/numbers itself/);
        expect(withEntry(slot, { ...ok, text: "1) legacy" })).toThrow(/numbers itself/);
      });
    }

    test("a duplicate id across the slots is refused", () => {
      expect(() =>
        summarySystemPromptPieces("I.", ["a"], "- one", {
          before: [{ ...ok, id: "twice" }],
          after: [{ ...ok, id: "twice" }],
        }),
      ).toThrow(/duplicate piece id "twice"/);
    });

    test("an id that collides with a piece the envelope itself emits is refused", () => {
      for (const id of ["intro", "instructions", "envelope", "envelope-summary", "structure"]) {
        expect(withEntry("before", { ...ok, id })).toThrow(new RegExp(`duplicate piece id "${id}"`));
        expect(withEntry("envelopeLines", { ...ok, id })).toThrow(new RegExp(`duplicate piece id "${id}"`));
      }
    });

    test("an empty id is refused — a span with no id is a span the page cannot tint", () => {
      for (const slot of ["before", "after", "envelopeLines"] as const) {
        expect(withEntry(slot, { ...ok, id: "" })).toThrow(/empty piece id/);
        expect(withEntry(slot, { ...ok, id: "  " })).toThrow(/empty piece id/);
      }
    });

    test("the shapes the two short-video verticals really send are accepted", () => {
      // The guard must not refuse the production callers — the one thing a
      // validation round can break that no other case here would notice.
      expect(() =>
        shortVideoSystemPromptPieces(TIKTOK_PROMPT_SPEC, {
          preset: STANDARD,
          title: "T",
          url: "https://www.tiktok.com/@a/video/1",
          author: "a",
        }),
      ).not.toThrow();
      expect(() =>
        shortVideoSystemPromptPieces(X_VIDEO_PROMPT_SPEC, {
          preset: STANDARD,
          title: "T",
          url: "https://x.com/a/status/1",
          author: "a",
        }),
      ).not.toThrow();
    });
  });

  /**
   * The five callers that pass no slots — youtube, vimeo, x-article, article,
   * anthropic — must be unchanged in BOTH directions: the composed bytes AND the
   * piece list, since the second is what `/summaries/prompts` renders chips from.
   */
  test("no slots ⇒ byte-identical output AND an identical piece list to passing none", () => {
    for (const structure of [undefined, "- only this", SUMMARY_STRUCTURE_BULLETS.join("\n")]) {
      const bare =
        structure === undefined
          ? summarySystemPromptPieces("Intro.", VALID_CATEGORIES)
          : summarySystemPromptPieces("Intro.", VALID_CATEGORIES, structure);
      const empty =
        structure === undefined
          ? summarySystemPromptPieces("Intro.", VALID_CATEGORIES, undefined, {})
          : summarySystemPromptPieces("Intro.", VALID_CATEGORIES, structure, { before: [], after: [] });
      expect(empty).toEqual(bare);
      expect(bare.map((p) => p.id)).toEqual(["intro", "envelope", "structure"]);
      expect(bare[1]!.text.startsWith("Instructions:\n1. Start your response")).toBe(true);
    }
  });

  test("buildSummarySystemPrompt passes the slots through to the pieces", () => {
    const slots = { before: BEFORE, after: AFTER };
    expect(buildSummarySystemPrompt("Intro.", ["a"], "- one", slots)).toBe(
      joinPromptPieces(summarySystemPromptPieces("Intro.", ["a"], "- one", slots)),
    );
    expect(buildSummarySystemPrompt("Intro.", ["a"], "- one", slots)).not.toBe(
      buildSummarySystemPrompt("Intro.", ["a"], "- one"),
    );
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
      () =>
        buildShortVideoSystemPrompt(TIKTOK_PROMPT_SPEC, {
          preset: STANDARD,
          title: "T",
          url: "U",
          author: "A",
        }),
      () =>
        joinPromptPieces(
          shortVideoSystemPromptPieces(TIKTOK_PROMPT_SPEC, {
            preset: STANDARD,
            title: "T",
            url: "U",
            author: "A",
          }),
        ),
    ],
    [
      "x-video",
      () =>
        buildShortVideoSystemPrompt(X_VIDEO_PROMPT_SPEC, {
          preset: STANDARD,
          title: "T",
          url: "U",
          author: "A",
        }),
      () =>
        joinPromptPieces(
          shortVideoSystemPromptPieces(X_VIDEO_PROMPT_SPEC, {
            preset: STANDARD,
            title: "T",
            url: "U",
            author: "A",
          }),
        ),
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

  test("the short-video envelopes are the SHARED one, with their rules in its slots", () => {
    for (const spec of [TIKTOK_PROMPT_SPEC, X_VIDEO_PROMPT_SPEC]) {
      const pieces = shortVideoSystemPromptPieces(spec, {
        preset: STANDARD,
        title: "T",
        url: "U",
        author: "A",
      });
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
      expect(pieces.find((p) => p.id === "no-commentary")!.text).toContain("Write no commentary");
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

describe("the envelopeLines slot (YouTube's LINKS: step)", () => {
  const LINE = { id: "links-step", label: "LINKS: step", text: "Then add one LINKS line." };

  test("the slotted shape is EXACTLY this: between CATEGORY and SUMMARY, numbered in sequence", () => {
    expect(
      joinPromptPieces(
        summarySystemPromptPieces("Intro.", ["a"], "- one", {
          envelopeLines: [LINE],
          after: [{ id: "no-commentary", label: "N", text: "No commentary." }],
        }),
      ),
    ).toBe(`Intro.

Instructions:
1. Start your response with EXACTLY this line: CATEGORY: <category>
   Choose from: a
2. Then add one LINKS line.
3. Then add a blank line, then SUMMARY: on its own line
4. Then write a structured summary with:
   - one
5. No commentary.`);
  });

  test("present, the envelope splits into `envelope` and `envelope-summary` around the slot", () => {
    const pieces = summarySystemPromptPieces("Intro.", ["a"], "- one", { envelopeLines: [LINE] });
    expect(pieces.map((p) => p.id)).toEqual(["intro", "envelope", "links-step", "envelope-summary", "structure"]);
    expect(pieces[1]!.text).toBe("Instructions:\n1. Start your response with EXACTLY this line: CATEGORY: <category>\n   Choose from: a\n");
    expect(pieces[2]!.text).toBe("2. Then add one LINKS line.\n");
    expect(pieces[3]!.text).toBe("3. Then add a blank line, then SUMMARY: on its own line\n4. Then write a structured summary with:\n   ");
  });

  test("with a `before` slot too, one sequence of numbers", () => {
    const text = joinPromptPieces(
      summarySystemPromptPieces("I.", ["a"], "- one", {
        before: [{ id: "r", label: "R", text: "Read first." }],
        envelopeLines: [LINE],
      }),
    );
    expect(text).toContain("1. Read first.\n2. Start your response");
    expect(text).toContain("3. Then add one LINKS line.\n4. Then add a blank line");
    expect(text).toContain("5. Then write a structured summary with:");
  });

  test("absent or empty ⇒ byte-identical bytes AND piece list", () => {
    const bare = summarySystemPromptPieces("Intro.", VALID_CATEGORIES);
    expect(summarySystemPromptPieces("Intro.", VALID_CATEGORIES, undefined, { envelopeLines: [] })).toEqual(bare);
  });

  test("YouTube with linksStep false/absent is the pre-links prompt; true adds the step", () => {
    const input = { windowed: true, title: "T", videoUrl: "U" };
    expect(buildYouTubeSystemPrompt(STANDARD, { ...input, linksStep: false })).toBe(buildYouTubeSystemPrompt(STANDARD, input));
    expect(youTubeSystemPromptPieces(STANDARD, { ...input, linksStep: true }).map((p) => p.id)).toEqual([
      "intro",
      "envelope",
      "links-step",
      "envelope-summary",
      "structure",
      "rider-windowed",
      "context",
    ]);
  });
});

/**
 * Byte-identity against the code BEFORE the `envelopeLines` slot, pinned as
 * hashes of each builder's piece list (`[id, label, text]`): computed on
 * origin/main ea8fa4d5 and on this branch, identical. Every builder that passes
 * no slot — the five slotless verticals, and YouTube without a links list —
 * must keep these bytes AND these chips.
 */
describe("slotless builders are byte-identical to before the envelopeLines slot", () => {
  const hash = (pieces: ReadonlyArray<{ id: string; label: string; text: string }>) =>
    new Bun.CryptoHasher("sha256").update(JSON.stringify(pieces.map((p) => [p.id, p.label, p.text]))).digest("hex");
  const cases: Array<[string, () => ReadonlyArray<{ id: string; label: string; text: string }>, string]> = [
    ["youtube", () => youTubeSystemPromptPieces(STANDARD, { windowed: true, title: "T", videoUrl: "U" }), "de07e8fc1204b2e507131b591906a9ec634fc54aee2e14111f72d1f2cc2646f6"],
    ["youtube (no window rider)", () => youTubeSystemPromptPieces(STANDARD, { windowed: false, title: "T", videoUrl: "U" }), "1c6491cc58e52a53fe5d76ccc45e0c5a0598097e09565d3af475c1fc5508f7e4"],
    ["vimeo", () => vimeoSystemPromptPieces({ preset: STANDARD, title: "T", url: "U", captionKind: "auto", outputLang: "nb" }), "83771478c9535c2da3714e1fb1144df77eac601e468d2ce5ce37f65e961b5e44"],
    ["vimeo (manual captions)", () => vimeoSystemPromptPieces({ preset: STANDARD, title: "T", url: "U", captionKind: "manual", outputLang: "en" }), "e701cdfef9c7a85f303718453bf04d1b31d95e653bb397f5bd2e6a3c43719fcf"],
    ["tiktok", () => shortVideoSystemPromptPieces(TIKTOK_PROMPT_SPEC, { preset: STANDARD, title: "T", url: "U", author: "A" }), "6d95cae611956263a6f111ca3cae89825c3c3a817fa286b8d6ab12990dce18b0"],
    ["tiktok (no frames)", () => shortVideoSystemPromptPieces(TIKTOK_PROMPT_SPEC, { preset: STANDARD, title: "T", url: "U", author: "A", frames: false }), "fae1870ad0d69b894f7989aae82c18c4d654b3b39a08ff5d04d0de3ac071bd08"],
    ["x-video", () => shortVideoSystemPromptPieces(X_VIDEO_PROMPT_SPEC, { preset: STANDARD, title: "T", url: "U", author: "A" }), "1e8a3c520b03bd5c69be7b1f0da5382d0a71e38bc06a6bca57c8f1a9b9f84668"],
    ["x-article", () => xArticleSystemPromptPieces({ title: "T", author: "A", url: "U" }), "73b25ed9fec5f43edee01d69aa8bfdb45b48228df7836745c4a69b46914cc73f"],
    ["article", () => articleSystemPromptPieces({ title: "T", author: "A", url: "U" }), "04c823587559649772f49f711e6c8e4427054752b8c90651c7a5407819cc0b52"],
    ["anthropic", () => anthropicSystemPromptPieces({ framing: "anthropic", title: "T", url: "U" }), "9d8f5865d66e705444a93244ffafe9d9191de6620e17a320793c0ea1dca3fae0"],
  ];
  for (const [name, pieces, want] of cases) {
    test(name, () => {
      expect(hash(pieces())).toBe(want);
    });
  }
});
