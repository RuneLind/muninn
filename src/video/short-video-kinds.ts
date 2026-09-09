import type { BotPrompts, ConnectorType } from "../bots/config.ts";
import { capabilitiesForConnectorType } from "../ai/connector-capabilities.ts";
import { resolveCapturePresets, type CapturePreset } from "../summaries/presets.ts";

/**
 * Why this summarizer bot cannot run a short-video capture AT ALL, or null when
 * it can — the sentence both options endpoints report and both POSTs 503 with.
 *
 * One function, because the two must not disagree. The options endpoints used to
 * answer `frames: { supported: false }` and nothing else, which reads as "no
 * keyframes, but a capture" — and the POST then 503'd whatever `frames` was set
 * to. The pre-flight is unconditional for a reason rather than by oversight: the
 * job hands the tmp work dir to `executeOneShot` as `extraDirs` on EVERY path,
 * frames or not, and that throws on a connector which cannot express
 * `--add-dir`. A frames-off short-video capture is not something this vertical
 * does, so the payload says the capture is unsupported rather than only the
 * keyframes.
 *
 * (`src/youtube/summarizer.ts` and `src/vimeo/summarizer.ts` pass `extraDirs`
 * only when a frame came out, which is why `youtube-routes.ts` can gate its own
 * pre-flight on `frames` and these two cannot. Giving the short-video job that
 * shape would open a capture path on connectors nothing has run it on; it is
 * filed as a follow-up rather than done here.)
 *
 * `frameNoun` is each vertical's own wording, kept because both 503 bodies
 * already shipped with it.
 */
export function shortVideoCaptureBlocker(
  summarizerBot: { name: string; connector?: ConnectorType },
  frameNoun: string,
): string | null {
  const connector = summarizerBot.connector ?? "claude-cli";
  if (capabilitiesForConnectorType(connector).supportsExtraDirs) return null;
  return (
    `Summarizer bot "${summarizerBot.name}" uses connector "${connector}", which cannot read the ` +
    `extracted ${frameNoun} (no extra-dirs support). Set SUMMARIZER_BOT to a claude-cli or claude-sdk bot.`
  );
}

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
