/**
 * Capture summary presets — the KIND of summary a capture writes. The shipped set
 * lives here as typed constants (the `src/share/presets.ts` shape, for the same
 * reason: a per-bot-only feature is dead on every bot that has no `prompts/`
 * dir), and a bot layers `prompts/captureSummary.<id>.md` files on top by id —
 * one overriding a shipped kind's INSTRUCTION, a new id appending a kind.
 *
 * A preset is two things, and the split is the point of the shape:
 *
 *  - `instruction` — the structure bullets the system prompt interpolates (what
 *    `SUMMARY_STRUCTURE_BULLETS` is for the standard kind). This is the half a
 *    per-bot file replaces.
 *  - `run` — how the model call is made: whether the capture thinking cap
 *    applies and whether the bot's model is swapped for the bigger one. A file
 *    on disk cannot say this, so a per-bot override of a shipped id KEEPS the
 *    shipped run options, and a new per-bot id runs like `standard`.
 *
 * The CATEGORY/SUMMARY envelope, the ingress line and the closing takeaway are
 * NOT the preset's to change — `buildSummarySystemPrompt` owns the envelope
 * (the shared parser reads it) and the summarizer appends the language and
 * auto-caption riders after whatever the preset says.
 *
 * `should-i-watch` (five lines: who it is for, what is new, what the demo shows,
 * the one thing to steal, a verdict) is a WANTED kind that is deliberately not
 * here yet — it pays on a backlog day, which needs batch paste first. It lands
 * as one more entry in {@link SHIPPED_CAPTURE_PRESETS}, nothing else.
 *
 * Pure + IO-free: the `BotPrompts` import is type-only, as in the share sibling.
 */

import type { BotConfig, BotPrompts, ConnectorType } from "../bots/config.ts";
import { SUMMARY_STRUCTURE_BULLETS } from "./summary-structure.ts";

/** How a kind's model call differs from the default capture call. */
export interface CaptureRunOptions {
  /**
   * `capped` — the 8k `CAPTURE_THINKING_MAX_TOKENS` first-token budget every
   * capture gets; `inherit` — the bot's own budget (jarvis: 40k), the TikTok
   * mechanism, for a kind whose reader has opted into waiting.
   */
  readonly thinking: "capped" | "inherit";
  /** `bot` — the bot's configured model; `opus` — {@link CAPTURE_DEEP_MODEL}. */
  readonly model: "bot" | "opus";
}

export interface CapturePreset {
  readonly id: string;
  readonly label: string;
  /** The structure bullets, one per line, as the system prompt interpolates them. */
  readonly instruction: string;
  readonly run: CaptureRunOptions;
}

export const DEFAULT_CAPTURE_KIND = "standard";

const DEFAULT_RUN: CaptureRunOptions = { thinking: "capped", model: "bot" };

/**
 * The model the `deep` kind runs on, in the Anthropic namespace the Claude
 * connectors speak. Applied by {@link captureBotConfigFor} only on a connector
 * whose model ids ARE that namespace — see the note there.
 */
export const CAPTURE_DEEP_MODEL = "claude-opus-5";

/**
 * The `talk-notes` structure: a timeline, one block per section of the talk,
 * each anchored on the `[HH:MM:SS]` the transcript windows already carry. The
 * envelope bullets (ingress, takeaways, closer) are shared with `standard` so a
 * talk-notes document still reads as a summary on the shelf and still feeds the
 * source drafter the shape it expects; the difference is what the BODY is.
 */
export const TALK_NOTES_STRUCTURE_BULLETS: readonly string[] = [
  SUMMARY_STRUCTURE_BULLETS[0]!,
  SUMMARY_STRUCTURE_BULLETS[1]!,
  "- Then a `## Timeline` section: ONE block per section of the talk, in the order they were given. Each block opens with a `### [HH:MM:SS] <what this section is about>` heading — the timestamp is the window heading the section STARTS in (copy it exactly; never invent or interpolate a time) — followed by 2–5 bullets stating the claims made there: what was asserted, what was demonstrated, what number or name was given. A claim, not a topic: `- 🧪 Argues that mocking the repository hides the N+1` rather than `- Testing`.",
  "- Aim for 8–15 blocks on an hour-long talk; merge sections shorter than a couple of minutes into their neighbour rather than padding the timeline.",
  "- When the speaker DICTATES something meant to be reused — a prompt, a command, a config, a snippet — reproduce it VERBATIM inside a fenced code block within that section's block, under a short line saying what it is. Always close the fence; never label one `mermaid`. If it will not fit, quote the essential part, mark it `(excerpted)`, and still close the fence.",
  "- **Bold** for key terms; every bullet prefixed with a fitting emoji (as in `- 🧪 …`).",
  "- Plain markdown only — no HTML and no custom block components (no callouts, cards, verdicts, or pills).",
  SUMMARY_STRUCTURE_BULLETS[SUMMARY_STRUCTURE_BULLETS.length - 1]!,
];

/** The shipped kinds, in picker order. `standard` is first: it is the default. */
export const SHIPPED_CAPTURE_PRESETS: readonly CapturePreset[] = [
  {
    id: DEFAULT_CAPTURE_KIND,
    label: "Standard",
    instruction: SUMMARY_STRUCTURE_BULLETS.join("\n"),
    run: DEFAULT_RUN,
  },
  {
    id: "deep",
    label: "Deep (opus, full thinking)",
    // Same structure as standard: the difference is the model call, which is the
    // "PR B" option of mimir's muninn-capture-summary-quality plan.
    instruction: SUMMARY_STRUCTURE_BULLETS.join("\n"),
    run: { thinking: "inherit", model: "opus" },
  },
  {
    id: "talk-notes",
    label: "Talk notes (timeline)",
    instruction: TALK_NOTES_STRUCTURE_BULLETS.join("\n"),
    run: DEFAULT_RUN,
  },
];

/**
 * Whether a connector can run {@link CAPTURE_DEEP_MODEL}: its model ids are
 * Anthropic's. `claude-cli` and `claude-sdk` speak that namespace directly;
 * `copilot-sdk` carries the id VERBATIM in its catalog (measured 2026-09-05 via
 * `CopilotClient.listModels()`: `claude-opus-5` is listed as-is — its
 * `resolveCopilotModelId` strips a trailing 8-digit date and respells a
 * trailing `-N-M` version, and this id has neither, so it is looked up
 * verbatim; a respelled catalog entry such as `claude-opus-5.1` would make
 * Copilot fall back to its default model with only a server-side error line,
 * and the document would still say `deep` — re-measure when the constant
 * moves). On `openai-compat` the model is whatever the endpoint serves
 * — `qwen3.5:35b`, `google/gemini-2.5-flash` — and a Claude id there is a 400
 * from the endpoint, not a bigger model.
 */
export function connectorRunsOpus(connector: ConnectorType | undefined): boolean {
  const c = connector ?? "claude-cli";
  return c === "claude-cli" || c === "claude-sdk" || c === "copilot-sdk";
}

/**
 * Resolve the kinds a bot OFFERS: the shipped set in order, with a per-bot
 * `captureSummary.<id>.md` of the same id replacing that kind's INSTRUCTION in
 * place (label and run options kept — a file cannot state run options, and an
 * override that silently dropped `deep` to the capped call would be a kind
 * lying about itself), then the bot's remaining new ids appended with the
 * default run options.
 *
 * A kind whose run options this bot's CONNECTOR cannot honour is not offered
 * at all: `deep` promises the opus model, and on a connector that cannot name
 * it the capture would run on the bot's own model and still be stamped
 * `summary_kind: deep` — a document lying about itself, with the only signal a
 * server-side warn. Omitted here, the picker never shows it and the route 400s
 * a client that asks anyway. A per-bot override of such a kind goes with it:
 * the run options are the kind's, not the file's.
 *
 * Never empty (`standard` always survives), and blank is absent at this layer
 * too (the share sibling's rule: the loader drops an empty file, but a
 * `BotPrompts` from any other producer handing over `"  \n"` would otherwise
 * replace a kind's whole structure with nothing).
 */
export function resolveCapturePresets(
  prompts: BotPrompts | undefined,
  connector?: ConnectorType,
): CapturePreset[] {
  const overrides = new Map<string, { label: string; content: string }>();
  for (const v of prompts?.captureSummaryVariants ?? []) {
    if (v.content.trim() === "") continue;
    overrides.set(v.id, { label: v.label, content: v.content });
  }

  const runsOpus = connectorRunsOpus(connector);
  const resolved: CapturePreset[] = [];
  for (const shipped of SHIPPED_CAPTURE_PRESETS) {
    const override = overrides.get(shipped.id);
    overrides.delete(shipped.id);
    if (shipped.run.model === "opus" && !runsOpus) continue;
    resolved.push(override ? { ...shipped, instruction: override.content } : shipped);
  }
  for (const [id, extra] of overrides) {
    resolved.push({ id, label: extra.label, instruction: extra.content, run: DEFAULT_RUN });
  }
  return resolved;
}

/**
 * Look one kind up by id. ABSENT (or blank) ⇒ `standard`; PRESENT BUT UNKNOWN
 * ⇒ **undefined**, so the route can 400 rather than summarize with a kind the
 * reader did not pick (the share sibling's rule, for the same reason).
 */
export function findCapturePreset(
  presets: readonly CapturePreset[],
  id: string | undefined,
): CapturePreset | undefined {
  const wanted = id?.trim();
  if (!wanted) return presets.find((p) => p.id === DEFAULT_CAPTURE_KIND) ?? presets[0];
  return presets.find((p) => p.id === wanted);
}

/** The `{id, label}` projection the picker renders. */
export function capturePresetOptions(
  presets: readonly CapturePreset[],
): { id: string; label: string }[] {
  return presets.map((p) => ({ id: p.id, label: p.label }));
}

/**
 * The bot config a kind's model call runs with: `opus` swaps the model on a
 * connector {@link connectorRunsOpus} admits, and otherwise returns the config
 * UNCHANGED. That second branch is defence only — {@link resolveCapturePresets}
 * does not offer an opus kind to such a bot, and the route refuses one — so a
 * caller that reaches it (a direct `summarizeVimeo` call with a hand-built
 * preset) gets the bot's model and, in the summarizer, one warn saying so.
 */
export function captureBotConfigFor(botConfig: BotConfig, preset: CapturePreset): BotConfig {
  if (preset.run.model !== "opus") return botConfig;
  return connectorRunsOpus(botConfig.connector) ? { ...botConfig, model: CAPTURE_DEEP_MODEL } : botConfig;
}

/**
 * The `thinkingMaxTokens` argument for `runCaptureOneShot`: `undefined` takes
 * the seam's capped default, `null` inherits the bot's budget.
 */
export function captureThinkingFor(preset: CapturePreset): number | null | undefined {
  return preset.run.thinking === "inherit" ? null : undefined;
}
