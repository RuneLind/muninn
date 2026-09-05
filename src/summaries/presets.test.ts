import { describe, expect, test } from "bun:test";
import type { BotConfig } from "../bots/config.ts";
import {
  CAPTURE_DEEP_MODEL,
  DEFAULT_CAPTURE_KIND,
  SHIPPED_CAPTURE_PRESETS,
  TALK_NOTES_STRUCTURE_BULLETS,
  captureBotConfigFor,
  capturePresetOptions,
  captureThinkingFor,
  findCapturePreset,
  resolveCapturePresets,
} from "./presets.ts";
import { SUMMARY_STRUCTURE_BULLETS } from "./summary-structure.ts";
import { buildSummarySystemPrompt } from "./summarizer-shared.ts";

const bot = (over: Partial<BotConfig> = {}): BotConfig =>
  ({ name: "b", dir: "/x", persona: "", connector: "claude-sdk", model: "claude-sonnet-5", ...over }) as BotConfig;

describe("the shipped kinds", () => {
  test("ship standard, deep and talk-notes in that order; standard is the default", () => {
    expect(SHIPPED_CAPTURE_PRESETS.map((p) => p.id)).toEqual(["standard", "deep", "talk-notes"]);
    expect(DEFAULT_CAPTURE_KIND).toBe("standard");
  });

  test("standard's instruction IS the shared structure, so a standard capture is byte-identical to before the picker", () => {
    const standard = SHIPPED_CAPTURE_PRESETS[0]!;
    expect(buildSummarySystemPrompt("intro", ["a"], standard.instruction)).toBe(
      buildSummarySystemPrompt("intro", ["a"]),
    );
    expect(buildSummarySystemPrompt("intro", ["a"])).toContain(
      `   ${SUMMARY_STRUCTURE_BULLETS.join("\n   ")}`,
    );
  });

  test("deep is standard's structure with the run options changed, and nothing else", () => {
    const [standard, deep] = SHIPPED_CAPTURE_PRESETS;
    expect(deep!.instruction).toBe(standard!.instruction);
    expect(deep!.run).toEqual({ thinking: "inherit", model: "opus" });
    expect(standard!.run).toEqual({ thinking: "capped", model: "bot" });
  });

  test("talk-notes keeps the envelope bullets and adds the timeline", () => {
    const notes = SHIPPED_CAPTURE_PRESETS[2]!;
    expect(notes.instruction).toContain("## Timeline");
    expect(notes.instruction).toContain("### [HH:MM:SS]");
    // Ingress, key takeaways and the closer are the shared ones, verbatim.
    expect(TALK_NOTES_STRUCTURE_BULLETS[0]).toBe(SUMMARY_STRUCTURE_BULLETS[0]);
    expect(TALK_NOTES_STRUCTURE_BULLETS[1]).toBe(SUMMARY_STRUCTURE_BULLETS[1]);
    expect(TALK_NOTES_STRUCTURE_BULLETS.at(-1)).toBe(SUMMARY_STRUCTURE_BULLETS.at(-1));
    expect(notes.run).toEqual({ thinking: "capped", model: "bot" });
  });

  test("the prompt builder indents a multi-line instruction under the numbered step", () => {
    const prompt = buildSummarySystemPrompt("intro", ["a"], "- one\n- two\n");
    expect(prompt).toContain("3. Then write a structured summary with:\n   - one\n   - two");
    expect(prompt.endsWith("- two")).toBe(true);
  });
});

describe("resolveCapturePresets", () => {
  test("no prompts ⇒ the shipped set", () => {
    expect(resolveCapturePresets(undefined)).toEqual([...SHIPPED_CAPTURE_PRESETS]);
    expect(resolveCapturePresets({})).toEqual([...SHIPPED_CAPTURE_PRESETS]);
  });

  test("a per-bot file of a shipped id replaces the INSTRUCTION in place and keeps label + run options", () => {
    const resolved = resolveCapturePresets({
      captureSummaryVariants: [{ id: "deep", label: "Deep (ours)", content: "- our bullets" }],
    });
    expect(resolved.map((p) => p.id)).toEqual(["standard", "deep", "talk-notes"]);
    const deep = resolved[1]!;
    expect(deep.instruction).toBe("- our bullets");
    expect(deep.label).toBe("Deep (opus, full thinking)");
    expect(deep.run).toEqual({ thinking: "inherit", model: "opus" });
  });

  test("a new per-bot id appends with the default run options", () => {
    const resolved = resolveCapturePresets({
      captureSummaryVariants: [{ id: "should-i-watch", label: "Should I watch?", content: "- five lines" }],
    });
    expect(resolved.map((p) => p.id)).toEqual(["standard", "deep", "talk-notes", "should-i-watch"]);
    expect(resolved[3]).toEqual({
      id: "should-i-watch",
      label: "Should I watch?",
      instruction: "- five lines",
      run: { thinking: "capped", model: "bot" },
    });
  });

  test("a blank variant is absent — it neither overrides nor appends", () => {
    const resolved = resolveCapturePresets({
      captureSummaryVariants: [
        { id: "standard", label: "S", content: "  \n " },
        { id: "empty", label: "E", content: "" },
      ],
    });
    expect(resolved).toEqual([...SHIPPED_CAPTURE_PRESETS]);
  });
});

describe("findCapturePreset", () => {
  const presets = resolveCapturePresets(undefined);

  test("absent or blank ⇒ standard", () => {
    expect(findCapturePreset(presets, undefined)?.id).toBe("standard");
    expect(findCapturePreset(presets, "")?.id).toBe("standard");
    expect(findCapturePreset(presets, "  ")?.id).toBe("standard");
  });

  test("present but unknown ⇒ undefined, so the route can refuse", () => {
    expect(findCapturePreset(presets, "should-i-watch")).toBeUndefined();
    expect(findCapturePreset(presets, "Standard")).toBeUndefined();
  });

  test("a known id resolves to that entry", () => {
    expect(findCapturePreset(presets, "talk-notes")?.id).toBe("talk-notes");
    expect(findCapturePreset(presets, " deep ")?.id).toBe("deep");
  });

  test("the picker projection is id + label only", () => {
    expect(capturePresetOptions(presets)).toEqual([
      { id: "standard", label: "Standard" },
      { id: "deep", label: "Deep (opus, full thinking)" },
      { id: "talk-notes", label: "Talk notes (timeline)" },
    ]);
  });
});

describe("the run options", () => {
  const [standard, deep] = SHIPPED_CAPTURE_PRESETS;

  test("thinking: capped ⇒ the seam's default (undefined), inherit ⇒ null", () => {
    expect(captureThinkingFor(standard!)).toBeUndefined();
    expect(captureThinkingFor(deep!)).toBeNull();
  });

  test("opus swaps the model on the Anthropic-namespace connectors only", () => {
    expect(captureBotConfigFor(bot({ connector: "claude-sdk" }), deep!).model).toBe(CAPTURE_DEEP_MODEL);
    expect(captureBotConfigFor(bot({ connector: "claude-cli" }), deep!).model).toBe(CAPTURE_DEEP_MODEL);
    expect(captureBotConfigFor(bot({ connector: "copilot-sdk" }), deep!).model).toBe(CAPTURE_DEEP_MODEL);
    // Unset connector is claude-cli.
    expect(captureBotConfigFor(bot({ connector: undefined }), deep!).model).toBe(CAPTURE_DEEP_MODEL);
    const ollama = bot({ connector: "openai-compat", model: "qwen3.5:35b" });
    expect(captureBotConfigFor(ollama, deep!)).toBe(ollama);
  });

  test("a bot-model kind returns the SAME config object, never a clone", () => {
    const b = bot();
    expect(captureBotConfigFor(b, standard!)).toBe(b);
    // And the swap never mutates the caller's config.
    captureBotConfigFor(b, deep!);
    expect(b.model).toBe("claude-sonnet-5");
  });
});
