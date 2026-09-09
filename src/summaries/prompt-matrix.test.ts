/**
 * The `/summaries/prompts` payload — every cell's chip set, piece list and
 * composed prompt, pinned against the kind resolver.
 *
 * Pure: no DOM, no server, no bot on disk. The bots are literals, which is what
 * lets the whole matrix be checked including the branch a real bot roster rarely
 * has (a per-bot kind that replaces a shipped one, and one that adds a new id).
 *
 * The one cell whose COMPLETE composed prompt is inlined is a kind whose
 * structure is a single bullet — that is what makes a whole-prompt pin readable
 * at all, and it pins the override merge in the same assertion.
 */

import { test, expect, describe } from "bun:test";
import type { BotConfig } from "../bots/config.ts";
import { SUMMARY_SOURCES } from "./sources.ts";
import { joinPromptPieces } from "./prompt-pieces.ts";
import { resolveCapturePresets, SHIPPED_CAPTURE_PRESETS } from "./presets.ts";
import { buildTakeawayCheckPrompt } from "./takeaway-check.ts";
import { buildYouTubeSystemPrompt, buildYouTubeUserPrompt } from "../youtube/prompt.ts";
import { buildVimeoSystemPrompt, buildVimeoUserPrompt } from "../vimeo/prompt.ts";
import { buildTikTokSystemPrompt, buildTikTokUserPrompt } from "../tiktok/prompt.ts";
import { buildXVideoSystemPrompt, buildXVideoUserPrompt } from "../x-article/video-prompt.ts";
import {
  PLACEHOLDER_FLAT_TRANSCRIPT,
  PLACEHOLDER_FRAMES,
  PLACEHOLDER_KEYFRAMES,
  PLACEHOLDER_SUMMARY_BODY,
  PLACEHOLDER_TAKEAWAY,
  PLACEHOLDER_TITLE,
  PLACEHOLDER_VIMEO_ID,
  PLACEHOLDER_WINDOWED_TRANSCRIPT,
  PLACEHOLDER_YOUTUBE_ID,
  PROMPT_MATRIX_SOURCES,
  buildPromptMatrix,
  noKindChip,
  type PromptMatrix,
  type PromptMatrixCell,
} from "./prompt-matrix.ts";

/** A bot with no per-bot kinds — the shipped set, on a connector that runs opus. */
function bot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    name: "matrixbot",
    dir: "/bots/matrixbot",
    persona: "",
    telegramAllowedUserIds: [],
    slackAllowedUserIds: [],
    connector: "claude-cli",
    ...overrides,
  };
}

/** The one-bullet kind the whole-prompt pin below is written against. */
const TINY_INSTRUCTION = "- One bullet, and nothing else.";

function cell(matrix: PromptMatrix, sourceId: string, kindId: string | null): PromptMatrixCell {
  const row = matrix.rows.find((r) => r.source.id === sourceId);
  if (!row) throw new Error(`no row for ${sourceId}`);
  const found = row.cells.find((c) => c.kindId === kindId);
  if (!found) throw new Error(`no ${sourceId} cell for kind ${kindId}`);
  return found;
}

describe("the matrix's shape", () => {
  test("one row per capture source, in the module's order", () => {
    const matrix = buildPromptMatrix(bot(), [bot()]);
    expect(matrix.rows.map((r) => r.source.id)).toEqual([
      "youtube",
      "vimeo",
      "tiktok",
      "x-video",
      "x-article",
      "article",
      "anthropic",
    ]);
    expect(matrix.rows.map((r) => r.source.id)).toEqual(PROMPT_MATRIX_SOURCES.map((s) => s.id));
  });

  test("every shelf source has a row — a new capture vertical cannot be silently missing", () => {
    const inMatrix = new Set(PROMPT_MATRIX_SOURCES.map((s) => s.id));
    for (const s of SUMMARY_SOURCES) expect(inMatrix.has(s.id)).toBe(true);
  });

  test("the kind columns are the resolver's answer for the picked bot", () => {
    const b = bot();
    const matrix = buildPromptMatrix(b, [b]);
    expect(matrix.kinds).toEqual(
      resolveCapturePresets(b.prompts, b.connector).map((p) => ({ id: p.id, label: p.label })),
    );
    expect(matrix.kinds.map((k) => k.id)).toEqual(["standard", "deep", "talk-notes"]);
  });

  test("a connector that cannot name the opus model loses the deep column AND its cells", () => {
    const b = bot({ connector: "openai-compat" });
    const matrix = buildPromptMatrix(b, [b]);
    expect(matrix.kinds.map((k) => k.id)).toEqual(["standard", "talk-notes"]);
    expect(matrix.rows.find((r) => r.source.id === "youtube")!.cells.map((c) => c.kindId)).toEqual([
      "standard",
      "talk-notes",
    ]);
  });

  test("a kind-ful source has one cell per kind; a kind-less one has exactly one", () => {
    const matrix = buildPromptMatrix(bot(), [bot()]);
    for (const row of matrix.rows) {
      expect(row.cells.length).toBe(row.source.kinds ? matrix.kinds.length : 1);
      if (!row.source.kinds) expect(row.cells[0]!.kindId).toBeNull();
    }
  });

  test("the bot picker lists every discovered bot, with the connector each resolves to", () => {
    const a = bot({ name: "one" });
    const c = bot({ name: "two", connector: "copilot-sdk" });
    const d = bot({ name: "three", connector: undefined });
    const matrix = buildPromptMatrix(a, [a, c, d]);
    expect(matrix.bots).toEqual([
      { name: "one", connector: "claude-cli" },
      { name: "two", connector: "copilot-sdk" },
      { name: "three", connector: "claude-cli" },
    ]);
    expect(matrix.botName).toBe("one");
  });
});

describe("the chips", () => {
  test("the YouTube standard cell lists exactly what that combination receives", () => {
    const matrix = buildPromptMatrix(bot(), [bot()]);
    expect(cell(matrix, "youtube", "standard").chips).toEqual([
      "intro",
      "category/summary envelope",
      "structure bullets",
      "windowed transcript rider",
      "video context",
      "frames: slides quoted inline by address",
      "visual detail: selected",
      "model: the bot's own",
      "thinking: capped at 8000",
    ]);
  });

  test("the deep kind's chips name the bigger model and the inherited budget", () => {
    const matrix = buildPromptMatrix(bot(), [bot()]);
    const chips = cell(matrix, "youtube", "deep").chips;
    expect(chips).toContain("model: claude-opus-5");
    expect(chips).toContain("thinking: the bot's own budget");
    expect(chips).not.toContain("model: the bot's own");
  });

  test("talk-notes says TIMELINE bullets, and an override of it says structure bullets again", () => {
    const plain = buildPromptMatrix(bot(), [bot()]);
    expect(cell(plain, "vimeo", "talk-notes").chips).toContain("timeline bullets");

    const overridden = bot({
      prompts: {
        captureSummaryVariants: [{ id: "talk-notes", label: "Talk notes", content: TINY_INSTRUCTION }],
      },
    });
    const matrix = buildPromptMatrix(overridden, [overridden]);
    const chips = cell(matrix, "vimeo", "talk-notes").chips;
    expect(chips).toContain("structure bullets");
    expect(chips).not.toContain("timeline bullets");
  });

  test("the Vimeo cell carries BOTH riders, in the contract's order", () => {
    const matrix = buildPromptMatrix(bot(), [bot()]);
    const chips = cell(matrix, "vimeo", "standard").chips;
    expect(chips).toEqual([
      "intro",
      "category/summary envelope",
      "structure bullets",
      "video context",
      "auto-caption rider",
      "language rider",
      "frames: slides quoted inline by address",
      "visual detail: selected",
      "model: the bot's own",
      "thinking: capped at 8000",
    ]);
    expect(chips.indexOf("auto-caption rider")).toBeLessThan(chips.indexOf("language rider"));
  });

  test("the short-video cells say 'hand-rolled envelope, no kind' and span the kinds", () => {
    const matrix = buildPromptMatrix(bot(), [bot()]);
    for (const id of ["tiktok", "x-video"]) {
      const c = cell(matrix, id, null);
      expect(c.chips[0]).toBe("hand-rolled envelope, no kind");
      expect(c.chips).toContain("thinking: the bot's own budget");
      expect(c.chips).toContain("frames: keyframes read first, never quoted");
      // No kind picker ⇒ no visual-detail axis and no override file.
      expect(c.chips.some((chip) => chip.startsWith("visual detail:"))).toBe(false);
      expect(c.override).toBeNull();
    }
  });

  test("the text cells say 'shared envelope, no kind' — a different sentence from the video ones", () => {
    const matrix = buildPromptMatrix(bot(), [bot()]);
    for (const id of ["x-article", "article", "anthropic"]) {
      const c = cell(matrix, id, null);
      expect(c.chips[0]).toBe("shared envelope, no kind");
      expect(c.chips).toContain("thinking: capped at 8000");
    }
    expect(noKindChip("shared")).toBe("shared envelope, no kind");
    expect(noKindChip("hand-rolled")).toBe("hand-rolled envelope, no kind");
  });
});

describe("the prompts", () => {
  test("every cell's system prompt IS the join of its pieces — the tint cannot drift", () => {
    const matrix = buildPromptMatrix(bot(), [bot()]);
    let checked = 0;
    for (const row of matrix.rows) {
      for (const c of row.cells) {
        expect(joinPromptPieces(c.systemPieces)).toBe(c.systemPrompt);
        expect(c.systemPieces.length).toBeGreaterThan(0);
        checked++;
      }
    }
    // 2 kind-ful sources × 3 kinds + 5 kind-less sources.
    expect(checked).toBe(11);
  });

  test("no cell's piece text is empty — an absent rider contributes no span to tint", () => {
    const matrix = buildPromptMatrix(bot(), [bot()]);
    for (const row of matrix.rows) {
      for (const c of row.cells) {
        for (const p of c.systemPieces) expect(p.text.length).toBeGreaterThan(0);
      }
    }
  });

  test("each video cell's prompts are its vertical's own builders over the fixed input", () => {
    const b = bot();
    const matrix = buildPromptMatrix(b, [b]);
    const presets = resolveCapturePresets(b.prompts, b.connector);
    const standard = presets.find((p) => p.id === "standard")!;

    expect(cell(matrix, "youtube", "standard").systemPrompt).toBe(
      buildYouTubeSystemPrompt(standard, {
        windowed: true,
        title: PLACEHOLDER_TITLE,
        videoUrl: `https://www.youtube.com/watch?v=${PLACEHOLDER_YOUTUBE_ID}`,
      }),
    );
    expect(cell(matrix, "youtube", "standard").userPrompt).toBe(
      buildYouTubeUserPrompt(PLACEHOLDER_WINDOWED_TRANSCRIPT, {
        videoId: PLACEHOLDER_YOUTUBE_ID,
        frames: PLACEHOLDER_FRAMES,
        visualDetail: "selected",
      }),
    );
    expect(cell(matrix, "vimeo", "standard").systemPrompt).toBe(
      buildVimeoSystemPrompt({
        preset: standard,
        title: PLACEHOLDER_TITLE,
        url: `https://vimeo.com/${PLACEHOLDER_VIMEO_ID}`,
        captionKind: "auto",
        outputLang: "en",
      }),
    );
    expect(cell(matrix, "vimeo", "standard").userPrompt).toBe(
      buildVimeoUserPrompt(PLACEHOLDER_WINDOWED_TRANSCRIPT, {
        videoId: PLACEHOLDER_VIMEO_ID,
        frames: PLACEHOLDER_FRAMES,
      }),
    );
    expect(cell(matrix, "tiktok", null).systemPrompt).toBe(
      buildTikTokSystemPrompt({
        title: PLACEHOLDER_TITLE,
        url: "https://www.tiktok.com/@placeholder/video/1234567890123456789",
        author: "placeholder-author",
      }),
    );
    expect(cell(matrix, "tiktok", null).userPrompt).toBe(
      buildTikTokUserPrompt({ transcript: PLACEHOLDER_FLAT_TRANSCRIPT, frames: PLACEHOLDER_KEYFRAMES }),
    );
    expect(cell(matrix, "x-video", null).systemPrompt).toBe(
      buildXVideoSystemPrompt({
        title: PLACEHOLDER_TITLE,
        url: "https://x.com/placeholder/status/1234567890123456789",
        author: "placeholder-author",
      }),
    );
    expect(cell(matrix, "x-video", null).userPrompt).toBe(
      buildXVideoUserPrompt({ transcript: PLACEHOLDER_FLAT_TRANSCRIPT, frames: PLACEHOLDER_KEYFRAMES }),
    );
  });

  test("the YouTube user prompt carries both placeholder frames, one of them noted", () => {
    const matrix = buildPromptMatrix(bot(), [bot()]);
    const user = cell(matrix, "youtube", "standard").userPrompt;
    expect(user.startsWith(PLACEHOLDER_WINDOWED_TRANSCRIPT)).toBe(true);
    expect(user).toContain("t=00:01:00 /tmp/muninn-capture-placeholder/frames/60.jpg — chart: the measurement the talk turns on");
    expect(user).toContain("t=00:02:00 /tmp/muninn-capture-placeholder/frames/120.jpg\n");
    expect(user).toContain(`/api/frames/youtube/${PLACEHOLDER_YOUTUBE_ID}/<sec>.jpg`);
    // The `selected` policy: no appendix, one cap.
    expect(user).toContain("At most 8 distinct frames in the whole summary.");
    expect(user).not.toContain("## Visual reference");
  });

  test("the Vimeo user prompt takes the DEFAULT rules paragraph, not a policy", () => {
    const matrix = buildPromptMatrix(bot(), [bot()]);
    const user = cell(matrix, "vimeo", "standard").userPrompt;
    expect(user).toContain("ADDS something the transcript did not say");
    expect(user).not.toContain("explain, compare, verify or revisit");
    expect(user).toContain(`/api/frames/vimeo/${PLACEHOLDER_VIMEO_ID}/<sec>.jpg`);
  });

  test("every cell's takeaway prompt is the checker's own, over the placeholder pair", () => {
    const matrix = buildPromptMatrix(bot(), [bot()]);
    const expected = buildTakeawayCheckPrompt(PLACEHOLDER_SUMMARY_BODY, PLACEHOLDER_TAKEAWAY);
    for (const row of matrix.rows) {
      for (const c of row.cells) expect(c.takeawayPrompt).toBe(expected);
    }
    expect(expected).toContain("<takeaway>");
  });

  test("a one-bullet per-bot kind composes this exact YouTube system prompt", () => {
    const b = bot({
      prompts: { captureSummaryVariants: [{ id: "tiny", label: "Tiny", content: TINY_INSTRUCTION }] },
    });
    const matrix = buildPromptMatrix(b, [b]);
    // The whole string, so the envelope, the rider order and the context lines
    // are all pinned in one place rather than by three `toContain`s.
    expect(cell(matrix, "youtube", "tiny").systemPrompt).toBe(
      `You are a video content analyst. Summarize the following YouTube video transcript.

Instructions:
1. Start your response with EXACTLY this line: CATEGORY: <category>
   Choose from: ai/claude-code, ai/claude, ai/openclaw, ai/general, ai/rag, health, tech, career, parenting, entertainment, coding
2. Then add a blank line, then SUMMARY: on its own line
3. Then write a structured summary with:
   - One bullet, and nothing else.

The transcript is grouped into windows, each opened by a \`### [HH:MM:SS]\` heading carrying its absolute position in the video; those headings are positions, not content — never quote one as if it were speech.

Video title: A placeholder capture
Video URL: https://www.youtube.com/watch?v=placeholder`,
    );
    // A NEW id runs like standard, so the shipped three are still there.
    expect(matrix.kinds.map((k) => k.id)).toEqual(["standard", "deep", "talk-notes", "tiny"]);
  });
});

describe("the override files", () => {
  test("a kind-ful cell names the file that would override it, and whether it is there", () => {
    const b = bot({
      dir: "/bots/matrixbot",
      prompts: { captureSummaryVariants: [{ id: "deep", label: "Deep", content: TINY_INSTRUCTION }] },
    });
    const matrix = buildPromptMatrix(b, [b]);
    expect(cell(matrix, "youtube", "deep").override).toEqual({
      path: "/bots/matrixbot/prompts/captureSummary.deep.md",
      present: true,
    });
    expect(cell(matrix, "youtube", "standard").override).toEqual({
      path: "/bots/matrixbot/prompts/captureSummary.standard.md",
      present: false,
    });
    // The override replaces the INSTRUCTION and keeps the run options: `deep`
    // still promises the bigger model.
    expect(cell(matrix, "youtube", "deep").chips).toContain("model: claude-opus-5");
    expect(cell(matrix, "youtube", "deep").systemPrompt).toContain(`   ${TINY_INSTRUCTION}`);
  });

  test("an override of a shipped kind really changes the structure the model is sent", () => {
    const plain = bot();
    const shippedStandard = SHIPPED_CAPTURE_PRESETS.find((p) => p.id === "standard")!;
    expect(
      cell(buildPromptMatrix(plain, [plain]), "youtube", "standard").systemPrompt,
    ).toContain(shippedStandard.instruction.split("\n")[0]!);

    const b = bot({
      prompts: { captureSummaryVariants: [{ id: "standard", label: "Standard", content: TINY_INSTRUCTION }] },
    });
    const prompt = cell(buildPromptMatrix(b, [b]), "youtube", "standard").systemPrompt;
    expect(prompt).toContain(TINY_INSTRUCTION);
    expect(prompt).not.toContain(shippedStandard.instruction.split("\n")[0]!);
  });
});
