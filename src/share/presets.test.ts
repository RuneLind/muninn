import { test, expect, describe } from "bun:test";
import {
  resolveSharePresets,
  findSharePreset,
  DEFAULT_SHARE_PRESET_ID,
  DEFAULT_SHARE_PRESET_LABEL,
  DEFAULT_SHARE_PROMPT,
  SHIPPED_SHARE_PRESETS,
  SLACK_DEV_SECURITY_PROMPT,
} from "./presets.ts";
import { DEFAULT_VARIANT_ID, DEFAULT_VARIANT_LABEL, type BotPrompts } from "../bots/config.ts";
import {
  DEFAULT_VARIANT_ID as LEAF_VARIANT_ID,
  DEFAULT_VARIANT_LABEL as LEAF_VARIANT_LABEL,
} from "../bots/prompt-defaults.ts";

const variant = (id: string, label: string, content: string) => ({ id, label, content });

// The picker's reserved id and the LOADER's refused variant id must be the same
// string: the loader blocks `share.default.md` because this entry owns "default".
// Re-exported rather than re-spelled so the two can never drift apart.
//
// Both spellings are asserted deliberately. The constants MOVED to a
// dependency-free leaf (`bots/prompt-defaults.ts`) so `presets.ts` — which
// advertises itself as pure + IO-free — stopped transitively loading
// `node:fs`/db/hivemind through `bots/config.ts` (measured ~2ms → ~20ms). The
// `config.ts` assertions pin the RE-EXPORT, so removing it would trip here rather
// than in whichever route imports it.
describe("the default entry's id/label are the loader's constants", () => {
  test("id", () => expect(DEFAULT_SHARE_PRESET_ID).toBe(DEFAULT_VARIANT_ID));
  test("label", () => expect(DEFAULT_SHARE_PRESET_LABEL).toBe(DEFAULT_VARIANT_LABEL));
  test("config.ts still re-exports the leaf's constants, identically", () => {
    expect(DEFAULT_VARIANT_ID).toBe(LEAF_VARIANT_ID);
    expect(DEFAULT_VARIANT_LABEL).toBe(LEAF_VARIANT_LABEL);
  });
});

describe("resolveSharePresets", () => {
  test("a bot with NO prompt files still gets the full shipped set", () => {
    // The reason the defaults are TS constants rather than per-bot files: jarvis
    // has no prompts/ dir, and capra/melosys live in other repos.
    const presets = resolveSharePresets(undefined);
    expect(presets.length).toBe(1 + SHIPPED_SHARE_PRESETS.length);
    expect(presets[0]!.id).toBe(DEFAULT_SHARE_PRESET_ID);
    expect(presets[0]!.content).toBe(DEFAULT_SHARE_PROMPT);
    expect(presets.map((p) => p.id)).toContain("slack-dev-security");
  });

  test("the resolved set is never empty, whatever the bot supplies", () => {
    for (const prompts of [undefined, {}, { shareVariants: [] }] as (BotPrompts | undefined)[]) {
      expect(resolveSharePresets(prompts).length).toBeGreaterThan(0);
    }
  });

  test("a bare share.md REPLACES the shipped default and nothing else", () => {
    const presets = resolveSharePresets({ share: "My own default" });
    expect(presets[0]).toEqual({ id: DEFAULT_SHARE_PRESET_ID, label: "Standard", content: "My own default" });
    // The shipped non-default presets survive alongside it.
    expect(presets.find((p) => p.id === "slack-dev-security")!.content).toBe(SLACK_DEV_SECURITY_PROMPT);
    expect(presets.length).toBe(1 + SHIPPED_SHARE_PRESETS.length);
  });

  test("a per-bot share.<id>.md with a COLLIDING id overrides in place, never duplicates", () => {
    const presets = resolveSharePresets({
      shareVariants: [variant("slack-dev-security", "Slack · our way", "Bot body")],
    });
    const matches = presets.filter((p) => p.id === "slack-dev-security");
    expect(matches.length).toBe(1);
    expect(matches[0]).toEqual({ id: "slack-dev-security", label: "Slack · our way", content: "Bot body" });
    // Same total count — an override is a replacement, not an addition.
    expect(presets.length).toBe(1 + SHIPPED_SHARE_PRESETS.length);
    // …and it keeps the shipped position, so the picker order doesn't shuffle.
    const shippedIdx = SHIPPED_SHARE_PRESETS.findIndex((p) => p.id === "slack-dev-security");
    expect(presets[1 + shippedIdx]!.id).toBe("slack-dev-security");
  });

  // Round-2 review: the loader drops a blank `share.md`, but `?? DEFAULT` only
  // catches `undefined` — so any OTHER producer of a `BotPrompts` (a test, a
  // future DB-backed or API-supplied prompt source) handing over `""` replaced
  // the shipped default with an instruction-free prompt, and the share flow would
  // have sent whatever the model made of a bare document. The guard belongs on
  // the contract, not on one caller.
  describe("a BLANK prompt is treated as ABSENT here too, not just in the loader", () => {
    for (const [label, share] of [
      ["empty string", ""],
      ["whitespace only", "  \n "],
      ["tabs and newlines", "\t\n\n"],
    ] as const) {
      test(`share: ${label} → the shipped default content`, () => {
        const presets = resolveSharePresets({ share });
        expect(presets[0]!.content).toBe(DEFAULT_SHARE_PROMPT);
        expect(presets[0]!.id).toBe(DEFAULT_SHARE_PRESET_ID);
      });
    }

    test("a present, non-blank share.md still replaces the default", () => {
      expect(resolveSharePresets({ share: "Mine" })[0]!.content).toBe("Mine");
    });

    test("a blank VARIANT is dropped, so the shipped preset it collides with survives", () => {
      const presets = resolveSharePresets({
        shareVariants: [variant("slack-dev-security", "Blank override", "   \n ")],
      });
      expect(presets.find((p) => p.id === "slack-dev-security")!.content).toBe(SLACK_DEV_SECURITY_PROMPT);
      expect(presets.length).toBe(1 + SHIPPED_SHARE_PRESETS.length);
    });

    test("a blank NEW-id variant is dropped entirely, never appended empty", () => {
      const presets = resolveSharePresets({ shareVariants: [variant("kunde", "Kundebrev", " ")] });
      expect(presets.find((p) => p.id === "kunde")).toBeUndefined();
      expect(presets.length).toBe(1 + SHIPPED_SHARE_PRESETS.length);
    });

    test("no resolved preset is ever blank, whatever the bot supplies", () => {
      const junk: BotPrompts = {
        share: "",
        shareVariants: [variant("a", "A", ""), variant("b", "B", "  "), variant("email", "E", "\n")],
      };
      for (const p of resolveSharePresets(junk)) expect(p.content.trim()).not.toBe("");
    });
  });

  test("a NEW id appends after the shipped set", () => {
    const presets = resolveSharePresets({ shareVariants: [variant("kunde", "Kundebrev", "Body")] });
    expect(presets.length).toBe(2 + SHIPPED_SHARE_PRESETS.length);
    expect(presets[presets.length - 1]).toEqual({ id: "kunde", label: "Kundebrev", content: "Body" });
  });

  test("override + append together keep both effects", () => {
    const presets = resolveSharePresets({
      share: "Own default",
      shareVariants: [variant("email", "E-post", "Own email"), variant("kunde", "Kundebrev", "Body")],
    });
    expect(presets[0]!.content).toBe("Own default");
    expect(presets.find((p) => p.id === "email")!.content).toBe("Own email");
    expect(presets.find((p) => p.id === "kunde")!.label).toBe("Kundebrev");
    expect(presets.length).toBe(2 + SHIPPED_SHARE_PRESETS.length);
  });
});

describe("shipped preset prompt contract", () => {
  const all = resolveSharePresets(undefined);

  test("every shipped preset says markdown only", () => {
    for (const p of all) expect(p.content).toContain("MARKDOWN only");
  });

  test("every shipped preset carries the no-derived-quantities rule", () => {
    // This lands in a company Slack under the user's name; a computed figure is a
    // claim the sender is making.
    for (const p of all) {
      expect(p.content).toContain("Never state a number");
      expect(p.content).toContain("derive quantities");
    }
  });

  test("every shipped preset forbids quoting the source's section headings", () => {
    // A Norwegian post must not carry English heading strings.
    for (const p of all) expect(p.content).toContain("Do not copy the source document's section headings");
  });

  test("the Slack preset carries an explicit length budget well under Slack's snippet threshold", () => {
    const slack = all.find((p) => p.id === "slack-dev-security")!;
    const budget = slack.content.match(/under (\d+) characters/);
    expect(budget).not.toBeNull();
    expect(Number(budget![1])).toBeLessThan(4000);
    expect(slack.content).toContain("snippet");
  });

  test("preset prompts are language-neutral — no output language is pinned", () => {
    // Language is an orthogonal axis appended as a rider AFTER any user edit.
    for (const p of all) {
      expect(p.content).not.toMatch(/\b(in English|på norsk|bokmål)\b/i);
    }
  });
});

describe("findSharePreset", () => {
  const presets = resolveSharePresets(undefined);

  test("finds by id", () => {
    expect(findSharePreset(presets, "email").id).toBe("email");
  });

  test("an absent or unknown id falls back to the default entry", () => {
    expect(findSharePreset(presets, undefined).id).toBe(DEFAULT_SHARE_PRESET_ID);
    expect(findSharePreset(presets, "  ").id).toBe(DEFAULT_SHARE_PRESET_ID);
    expect(findSharePreset(presets, "nope").id).toBe(DEFAULT_SHARE_PRESET_ID);
  });
});
