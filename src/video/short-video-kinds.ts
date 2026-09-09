import type { BotPrompts, ConnectorType } from "../bots/config.ts";
import { resolveCapturePresets, type CapturePreset } from "../summaries/presets.ts";

/**
 * The summary kinds the SHORT-VIDEO verticals offer on a given summarizer bot —
 * TikTok and X video, one set, because they run one job.
 *
 * `requireThinkingControl` is what makes it the short-video set rather than the
 * shared one, exactly as it makes the YouTube set (`src/youtube/kinds.ts`); the
 * reason it is a per-caller argument, and the accepted consequence that a
 * Copilot summarizer bot is offered `deep` for Vimeo and refused it here, is
 * documented once, on that option in `src/summaries/presets.ts`.
 *
 * Every caller goes through here — the two options endpoints and the two
 * `400 bad_kind` checks — so a picker cannot offer a kind a POST refuses.
 */
export function shortVideoCaptureKinds(summarizerBot: {
  prompts?: BotPrompts;
  connector?: ConnectorType;
}): CapturePreset[] {
  return resolveCapturePresets(summarizerBot.prompts, summarizerBot.connector, {
    requireThinkingControl: true,
  });
}
