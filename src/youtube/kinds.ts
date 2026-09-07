import type { BotPrompts, ConnectorType } from "../bots/config.ts";
import { resolveCapturePresets, type CapturePreset } from "../summaries/presets.ts";

/**
 * The summary kinds THIS vertical offers on a given summarizer bot.
 *
 * `requireThinkingControl` is what makes it the YouTube set rather than the
 * shared one; the reason it is a per-caller argument is documented once, on
 * that option in `src/summaries/presets.ts`.
 *
 * Every caller goes through here — the options endpoint, the `400 bad_kind`
 * and the replay harness — so a picker cannot offer a kind the POST refuses.
 */
export function youtubeCaptureKinds(summarizerBot: {
  prompts?: BotPrompts;
  connector?: ConnectorType;
}): CapturePreset[] {
  return resolveCapturePresets(summarizerBot.prompts, summarizerBot.connector, {
    requireThinkingControl: true,
  });
}
