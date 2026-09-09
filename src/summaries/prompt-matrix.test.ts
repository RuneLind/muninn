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
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { BotConfig } from "../bots/config.ts";
import { SUMMARY_SOURCES } from "./sources.ts";
import { joinPromptPieces } from "./prompt-pieces.ts";
import { resolveCapturePresets, SHIPPED_CAPTURE_PRESETS } from "./presets.ts";
import { buildTakeawayCheckPrompt } from "./takeaway-check.ts";
import { buildYouTubeSystemPrompt, buildYouTubeUserPrompt } from "../youtube/prompt.ts";
import { buildVimeoSystemPrompt, buildVimeoUserPrompt } from "../vimeo/prompt.ts";
import { buildTikTokSystemPrompt, buildTikTokUserPrompt } from "../tiktok/prompt.ts";
import { buildXVideoSystemPrompt, buildXVideoUserPrompt } from "../x-article/video-prompt.ts";
import { buildXArticleSystemPrompt } from "../x-article/prompt.ts";
import { buildArticleSystemPrompt } from "../article/prompt.ts";
import { buildAnthropicSystemPrompt } from "../anthropic/prompt.ts";
import {
  PLACEHOLDER_ARTICLE_TEXT,
  PLACEHOLDER_ARTICLE_URL,
  PLACEHOLDER_ANTHROPIC_URL,
  PLACEHOLDER_AUTHOR,
  PLACEHOLDER_FLAT_TRANSCRIPT,
  PLACEHOLDER_FRAMES,
  PLACEHOLDER_KEYFRAMES,
  PLACEHOLDER_SUMMARY_BODY,
  PLACEHOLDER_TAKEAWAY,
  PLACEHOLDER_TITLE,
  PLACEHOLDER_VIMEO_ID,
  PLACEHOLDER_WINDOWED_TRANSCRIPT,
  PLACEHOLDER_XARTICLE_URL,
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

  test("the Vimeo cell carries ALL THREE riders, in the contract's order", () => {
    const matrix = buildPromptMatrix(bot(), [bot()]);
    const chips = cell(matrix, "vimeo", "standard").chips;
    // The windowed rider is baked into this vertical's intro SENTENCE, so it is
    // a span of its own rather than a piece appended after the structure — but
    // the reader is owed the same chip YouTube shows for the same sentence.
    expect(chips).toEqual([
      "intro",
      "windowed transcript rider",
      "category/summary envelope",
      "structure bullets",
      "video context",
      "auto-caption rider",
      "language rider",
      "frames: slides quoted inline by address",
      // NO visual-detail chip: `buildVimeoUserPrompt` takes no policy argument,
      // so nothing in a Vimeo prompt varies with that picker. Only YouTube's
      // user builder reads one.
      "model: the bot's own",
      "thinking: capped at 8000",
    ]);
    expect(chips.some((chip) => chip.startsWith("visual detail:"))).toBe(false);
    // The intro split leaves TWO intro spans — the lead and the separator that
    // follows the rider — and the separator is whitespace, so it is a span to
    // tint and not a part to list. One chip, two spans.
    const vimeoPieceIds = cell(matrix, "vimeo", "standard").systemPieces.map((p) => p.id);
    expect(vimeoPieceIds.filter((id) => id === "intro")).toHaveLength(2);
    expect(chips.filter((chip) => chip === "intro")).toHaveLength(1);
    expect(chips.indexOf("auto-caption rider")).toBeLessThan(chips.indexOf("language rider"));
    // The same chip text as the YouTube row's, since it is the same sentence.
    expect(cell(matrix, "youtube", "standard").chips).toContain("windowed transcript rider");
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

describe("the text cells", () => {
  /**
   * The three text verticals share the CATEGORY/SUMMARY scaffold, so a cell
   * pointed at a neighbour's builder still renders a plausible prompt. Equality
   * against the vertical's own builder is what catches that; the set-size
   * assertion below is what makes the equality worth something.
   */
  test("each text cell's system prompt is its OWN vertical's builder", () => {
    const matrix = buildPromptMatrix(bot(), [bot()]);
    expect(cell(matrix, "x-article", null).systemPrompt).toBe(
      buildXArticleSystemPrompt({
        title: PLACEHOLDER_TITLE,
        author: PLACEHOLDER_AUTHOR,
        url: PLACEHOLDER_XARTICLE_URL,
      }),
    );
    expect(cell(matrix, "article", null).systemPrompt).toBe(
      buildArticleSystemPrompt({
        title: PLACEHOLDER_TITLE,
        author: PLACEHOLDER_AUTHOR,
        url: PLACEHOLDER_ARTICLE_URL,
      }),
    );
    expect(cell(matrix, "anthropic", null).systemPrompt).toBe(
      buildAnthropicSystemPrompt({
        framing: "anthropic",
        title: PLACEHOLDER_TITLE,
        url: PLACEHOLDER_ANTHROPIC_URL,
      }),
    );
    // The pasted body IS the user prompt for all three — no builder to call.
    for (const id of ["x-article", "article", "anthropic"]) {
      expect(cell(matrix, id, null).userPrompt).toBe(PLACEHOLDER_ARTICLE_TEXT);
    }
  });

  test("the three text builders really differ over one common input", () => {
    // Without this, the three equalities above would all still pass if two
    // builders happened to compose the same string.
    const three = [
      buildXArticleSystemPrompt({ title: "T", author: "A", url: "U" }),
      buildArticleSystemPrompt({ title: "T", author: "A", url: "U" }),
      buildAnthropicSystemPrompt({ framing: "anthropic", title: "T", url: "U" }),
    ];
    expect(new Set(three).size).toBe(3);
  });
});

describe("the fixed axes the page pins", () => {
  /**
   * What this check IS and what it is NOT, stated because the difference is the
   * whole value of it.
   *
   * It is ONE-DIRECTIONAL. For every axis a row DECLARES it asserts the matching
   * property of the composed prompt, so a row that says "captions: auto" while
   * the cell was built with `manual` fails here. It cannot do the other
   * direction: an axis a builder branches on and no row declares is INVISIBLE to
   * it, because nothing enumerates a builder's branch points mechanically. That
   * list is maintained BY HAND, from the branch points named in the comment
   * beside each row's `fixedAxes` — and it was wrong once already: the two
   * short-video rows declared nothing while their user builders branch on an
   * empty transcript and on an empty frame list, and this test pinned the
   * omission with `toEqual([])`.
   *
   * So: adding a branch to a builder without adding its axis here still passes.
   * The defence against that is the comment beside each row, not this test.
   */
  test("every declared axis agrees with the composed prompt", () => {
    const matrix = buildPromptMatrix(bot(), [bot()]);
    const axes = Object.fromEntries(
      matrix.rows.map((r) => [r.source.id, r.source.fixedAxes]),
    ) as Record<string, readonly string[]>;
    const noteText = PLACEHOLDER_FRAMES[0]!.note!;

    expect(axes["youtube"]).toEqual([
      "windowed transcript: yes",
      "frames: present",
      "one frame carries a selection note",
      "visual detail: selected",
    ]);
    expect(cell(matrix, "youtube", "standard").systemPieces.map((p) => p.id)).toContain("rider-windowed");
    const youtubeUser = cell(matrix, "youtube", "standard").userPrompt;
    expect(youtubeUser).toContain("Slide frames");
    // The note channel: the 60 s frame's line carries it, the 120 s one does not.
    expect(youtubeUser).toContain(`${PLACEHOLDER_FRAMES[0]!.path} — ${noteText}`);
    expect(youtubeUser).toContain(`${PLACEHOLDER_FRAMES[1]!.path}\n`);
    expect(youtubeUser).not.toContain(`${PLACEHOLDER_FRAMES[1]!.path} —`);
    // `selected` states one cap and no appendix; `detailed` would say both.
    expect(youtubeUser).toContain("At most 8 distinct frames");
    expect(youtubeUser).not.toContain("## Visual reference");

    expect(axes["vimeo"]).toEqual([
      "captions: auto-generated",
      "output language: English",
      "frames: present",
      "one frame carries a selection note",
    ]);
    const vimeoIds = cell(matrix, "vimeo", "standard").systemPieces.map((p) => p.id);
    expect(vimeoIds).toContain("rider-auto-caption");
    expect(vimeoIds).toContain("rider-language");
    expect(cell(matrix, "vimeo", "standard").systemPrompt).toContain(
      "LANGUAGE: write the summary in English",
    );
    const vimeoUser = cell(matrix, "vimeo", "standard").userPrompt;
    expect(vimeoUser).toContain("Slide frames");
    expect(vimeoUser).toContain(`${PLACEHOLDER_FRAMES[0]!.path} — ${noteText}`);
    expect(vimeoUser).not.toContain(`${PLACEHOLDER_FRAMES[1]!.path} —`);

    // The two short-video user builders branch twice each, and the page pins the
    // present-transcript, present-frames form of both.
    for (const id of ["tiktok", "x-video"]) {
      expect(axes[id]).toEqual(["transcript: present", "keyframes: present"]);
      const user = cell(matrix, id, null).userPrompt;
      expect(user.startsWith("Transcript:\n")).toBe(true);
      expect(user).not.toContain("No speech detected");
      expect(user).toContain("Keyframes (read each image before summarizing):");
    }

    for (const id of ["x-article", "article"]) {
      expect(axes[id]).toEqual(["author and url: both present"]);
      expect(cell(matrix, id, null).systemPrompt).toContain("Article author:");
      expect(cell(matrix, id, null).systemPrompt).toContain("Article URL:");
    }

    expect(axes["anthropic"]).toEqual(["framing: Anthropic release", "linked-content rider: absent"]);
    const anthropicIds = cell(matrix, "anthropic", null).systemPieces.map((p) => p.id);
    expect(anthropicIds).not.toContain("rider-enrichment");
    expect(cell(matrix, "anthropic", null).systemPrompt).toContain("Anthropic / Claude ecosystem release");
  });

  /**
   * The renderer has ONE `fixed:` wording now, because every row has an axis to
   * name. A row that lost its axes would render `fixed:` followed by nothing —
   * so the emptiness is caught here rather than on the page.
   */
  test("no row declares an empty axis list", () => {
    for (const row of buildPromptMatrix(bot(), [bot()]).rows) {
      expect(row.source.fixedAxes.length).toBeGreaterThan(0);
    }
  });
});

describe("a per-bot variant with BLANK content", () => {
  /**
   * `resolveCapturePresets` skips a variant whose content is blank (the loader
   * already warns and the shipped default still applies). The override marker
   * has to agree, or the page says "present" about a file the capture ignores —
   * one predicate, used by both.
   */
  test("is 'not present' on the marker AND absent from the resolved kinds", () => {
    const shippedDeep = SHIPPED_CAPTURE_PRESETS.find((p) => p.id === "deep")!;
    const b = bot({
      prompts: { captureSummaryVariants: [{ id: "deep", label: "Deep", content: "   \n\t " }] },
    });
    const matrix = buildPromptMatrix(b, [b]);
    expect(cell(matrix, "youtube", "deep").override).toEqual({
      path: "/bots/matrixbot/prompts/captureSummary.deep.md",
      present: false,
    });
    // The resolver ignored it too — the shipped instruction is what is sent.
    expect(cell(matrix, "youtube", "deep").systemPrompt).toContain(
      shippedDeep.instruction.split("\n")[0]!,
    );

    // A blank NEW id is no kind at all, and so has no column and no cell.
    const c = bot({
      prompts: { captureSummaryVariants: [{ id: "blankkind", label: "Blank", content: "" }] },
    });
    expect(buildPromptMatrix(c, [c]).kinds.map((k) => k.id)).not.toContain("blankkind");

    // …and a NON-blank variant of the same id is still present, so the
    // assertions above are about blankness and not about the id.
    const d = bot({
      prompts: { captureSummaryVariants: [{ id: "deep", label: "Deep", content: TINY_INSTRUCTION }] },
    });
    expect(cell(buildPromptMatrix(d, [d]), "youtube", "deep").override!.present).toBe(true);
  });
});

describe("the module graph", () => {
  /**
   * The page's payload is composed by a dashboard VIEW's import graph, so this
   * module may not drag a summarizer's world in behind it. `executeOneShot` and
   * the tracer are the two that matter: pulling them in gives a server-rendered
   * page a transitive dependency on the model client.
   */
  const SRC = resolve(dirname(new URL(import.meta.url).pathname), "..");

  /**
   * The RUNTIME graph: `import type` is erased by the compiler, so a type-only
   * edge costs a reader nothing and is not what this test is about. Comments are
   * stripped first, so a path written in prose is not mistaken for an edge.
   */
  function reachableFrom(entry: string): Set<string> {
    const seen = new Set<string>();
    const queue = [resolve(entry)];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const text = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\n)\s*\/\/[^\n]*/g, "$1");
      for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\s+([\s\S]*?)\s*from\s+"(\.[^"]+)"/g)) {
        if (/^type\b/.test(m[1]!)) continue;
        queue.push(resolve(dirname(file), m[2]!));
      }
    }
    return seen;
  }

  test("prompt-matrix.ts does not reach the one-shot client, the tracer, or summarizer-shared", () => {
    const reached = reachableFrom(resolve(SRC, "summaries/prompt-matrix.ts"));
    for (const forbidden of [
      "ai/one-shot.ts",
      "core/traced-one-shot.ts",
      "tracing/tracer.ts",
      "summaries/summarizer-shared.ts",
    ]) {
      expect([...reached]).not.toContain(resolve(SRC, forbidden));
    }
    // The walk really walked: the verticals' builders are on the far side of it.
    expect([...reached]).toContain(resolve(SRC, "youtube/prompt.ts"));
    expect([...reached]).toContain(resolve(SRC, "summaries/prompt-pieces.ts"));
  });
});
