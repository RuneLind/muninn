import type { BotPrompts, ConnectorType } from "../bots/config.ts";
import { capabilitiesForConnectorType } from "../ai/connector-capabilities.ts";
import { restrictedCliBlocker } from "../ai/tool-surface.ts";
import {
  CAPTURE_THINKING_MAX_TOKENS,
  resolveCapturePresets,
  type CapturePreset,
  type CaptureRunOptions,
} from "../summaries/presets.ts";

/**
 * The thinking budget a SHORT-VIDEO capture sends, on every kind — `null`, the
 * bot's own, which is this vertical's answer since before the picker existed.
 *
 * A named constant because it has a SECOND reader: `/summaries/prompts` shows a
 * run chip per cell and derives it from the kind's preset, which says `capped`
 * on three of the four short-video cells. Both sides read this, so the page
 * cannot advertise a budget the job does not send. Why the value is `null` is
 * documented where it is spent — the model call in `./short-video.ts`.
 *
 * The TYPE is the two values a run chip can say and no others: `capped` means
 * exactly {@link CAPTURE_THINKING_MAX_TOKENS}, so a third budget would be shown
 * as one of these two rather than as itself. A number this vocabulary cannot
 * express is a tsc error here rather than a wrong chip on the page.
 */
export const SHORT_VIDEO_THINKING: null | typeof CAPTURE_THINKING_MAX_TOKENS = null;

/**
 * The same budget in the vocabulary a preset's run options speak — what the
 * prompts page's two short-video rows override their kinds' `thinking` with.
 * `null` at the seam IS `inherit`: `runCaptureOneShot` omits the key, so the
 * connector sees the bot's own budget.
 */
export const SHORT_VIDEO_RUN_OVERRIDE: Pick<CaptureRunOptions, "thinking"> = {
  thinking: SHORT_VIDEO_THINKING === null ? "inherit" : "capped",
};

/**
 * Why this summarizer bot cannot run this short-video capture, or null when it
 * can — the sentence both options endpoints report and both POSTs 503 with.
 *
 * One function, because the two must not disagree. A capture with frames on
 * (the default) declares `{ read: [framesDir] }`, so it needs a connector with a
 * fenced Read and, on claude-cli, a CLI new enough for `--restricted`: without
 * this check a TikTok downloads, transcribes and extracts frames, and only then
 * fails. A capture with `frames: false` declares `"none"`, which every
 * connector runs, so it is never blocked here.
 *
 * The options endpoints ask about the default capture (frames on), which is
 * what a client sends unless the reader turns frames off.
 *
 * `frameNoun` is each vertical's own wording, kept because both 503 bodies
 * already shipped with it.
 */
export async function shortVideoCaptureBlocker(
  summarizerBot: { name: string; connector?: ConnectorType },
  frameNoun: string,
  opts: { frames: boolean },
): Promise<string | null> {
  if (!opts.frames) return null;
  const connector = summarizerBot.connector ?? "claude-cli";
  if (!capabilitiesForConnectorType(connector).supportsExtraDirs) {
    return (
      `Summarizer bot "${summarizerBot.name}" uses connector "${connector}", which cannot read the ` +
      `extracted ${frameNoun} (no extra-dirs support). Set SUMMARIZER_BOT to a claude-cli or claude-sdk bot.`
    );
  }
  const cli = await restrictedCliBlocker(connector, "read");
  return cli === null
    ? null
    : `Summarizer bot "${summarizerBot.name}" cannot read the extracted ${frameNoun}: ${cli}`;
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
