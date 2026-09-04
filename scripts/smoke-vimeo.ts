/**
 * A Vimeo transcript MEASUREMENT, end to end, against the real site.
 *
 * The Vimeo capture vertical rests on one mechanism that can rot without any
 * code changing: Vimeo's own player. Four cheaper paths were measured closed on
 * 2026-09-04 (yt-dlp's web client, the `/config` endpoint over curl and from page
 * context, UA spoofing), so what muninn does is load the watch page in a headless
 * Chromium, start playback, and harvest the signed caption URL the real player
 * requests. Nothing about that is guaranteed by a contract — which is exactly why
 * it needs a script that DRIVES THE SHIPPED CODE against a real video and prints
 * what happened, rather than a test with a fixture that can stay green for months
 * after the mechanism died.
 *
 * It answers four questions:
 *
 *   1. Does the metadata half work with NO browser? oEmbed is a plain
 *      unauthenticated GET; if it answers, a capture has a title, an author and a
 *      duration even when the harvest fails.
 *   2. Does the harvest still find a caption track — and how long does it take?
 *      The timing table below is the evidence behind the 60 s whole-operation
 *      budget; a run that creeps toward it is the early warning.
 *   3. Does the signed URL download through the HOST-PINNED `downloadVtt`?
 *   4. Does the VTT window into the shape a summarizer gets? The first two
 *      windows are printed verbatim, because "27 windows" is not evidence that
 *      the text is the talk's.
 *
 *     bun scripts/smoke-vimeo.ts https://vimeo.com/1223642971
 *     … --window=120     (window width in seconds, default 120)
 *     … --timeout=60000  (whole-operation harvest budget in ms)
 *     … --json           (JSON on stdout, prose on stderr)
 *
 * Network-dependent by construction, so it is NOT in the test chain. It writes
 * nothing, persists nothing, and needs no credential — but it does need a
 * Chromium: `bunx playwright install chromium`.
 */
import {
  chooseTrack,
  downloadVtt,
  harvestVimeoCaptions,
  VimeoBrowserMissingError,
  type VimeoCaptions,
} from "../src/vimeo/captions.ts";
import { fetchVimeoOembed, isNotPublic } from "../src/vimeo/oembed.ts";
import { extractVimeoVideoId, vimeoWatchUrl } from "../src/vimeo/url.ts";
import { detectCaptionKind, parseVttCues, segmentsToMarkdown, vttToSegments } from "../src/vimeo/vtt.ts";

const JSON_MODE = process.argv.includes("--json");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flag = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

const target = args[0];
if (!target) {
  console.error("usage: bun scripts/smoke-vimeo.ts <vimeo url|id> [--window=120] [--timeout=60000] [--json]");
  process.exit(2);
}
const windowSec = Number(flag("window") ?? 120);
const timeoutMs = Number(flag("timeout") ?? 60_000);

const ref = /^\d+$/.test(target) ? { id: target } : extractVimeoVideoId(target);
if (!ref) {
  console.error(`Not a Vimeo URL: ${target}`);
  process.exit(2);
}

/** Prose goes to stderr in `--json` mode so stdout stays machine-readable. */
function say(line: string): void {
  if (JSON_MODE) console.error(line);
  else console.log(line);
}

const timings: Record<string, number> = {};
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    timings[label] = Date.now() - started;
  }
}

const wallStart = Date.now();

// 1. Metadata, no browser.
const metadata = await timed("oembed", async () => {
  try {
    return await fetchVimeoOembed(vimeoWatchUrl(ref));
  } catch (err) {
    return err as Error;
  }
});
if (metadata instanceof Error) {
  say(`oEmbed FAILED: ${metadata.message}`);
} else if (isNotPublic(metadata)) {
  say(`oEmbed says NOT PUBLIC (HTTP ${metadata.status}) — a private, walled or deleted video.`);
  process.exit(1);
} else {
  say(`title       ${metadata.title}`);
  say(`author      ${metadata.author}`);
  say(`duration    ${metadata.durationSec}s`);
  say(`uploaded    ${metadata.uploadDate}`);
}

// 2. Harvest.
let captions: VimeoCaptions;
try {
  captions = await timed("harvest", () => harvestVimeoCaptions(ref.id, { hash: ref.hash, timeoutMs }));
} catch (err) {
  if (err instanceof VimeoBrowserMissingError) {
    say(`HARVEST FAILED (no browser): ${err.message}`);
    process.exit(1);
  }
  say(`HARVEST FAILED: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  process.exit(1);
}

say("");
say(`page title  ${captions.title}`);
say(`player says ${captions.durationSec ? `${captions.durationSec}s` : "unknown (MSE, no duration)"}`);
say(`manifest    ${captions.manifestUrl ? "captured (for a future audio path)" : "not seen"}`);
say(`tracks      ${captions.tracks.length}`);
for (const track of captions.tracks) {
  say(`  - ${track.lang} (${detectCaptionKind(track.lang)}) "${track.label}"`);
}

const chosen = chooseTrack(captions.tracks);
if (!chosen) {
  say("No usable caption track — this video would need the audio path.");
  process.exit(1);
}
say(`chosen      ${chosen.lang} (${detectCaptionKind(chosen.lang)})`);

// 3. Download, host-pinned.
const vtt = await timed("download", () => downloadVtt(chosen.vttUrl));
const cues = parseVttCues(vtt);
const segments = vttToSegments(vtt, windowSec);
const markdown = segmentsToMarkdown(segments);

say("");
say(`vtt         ${vtt.length} chars, ${cues.length} cues`);
say(`windows     ${segments.length} × ${windowSec}s`);
say("");
say("--- first two windows -------------------------------------------------");
say(segmentsToMarkdown(segments.slice(0, 2)));
say("-----------------------------------------------------------------------");

timings.total = Date.now() - wallStart;
say("");
say("| step     | ms |");
say("|----------|----|");
for (const step of ["oembed", "harvest", "download", "total"]) {
  if (timings[step] !== undefined) say(`| ${step.padEnd(8)} | ${timings[step]} |`);
}

if (JSON_MODE) {
  console.log(
    JSON.stringify(
      {
        videoId: captions.videoId,
        metadata: metadata instanceof Error ? { error: metadata.message } : metadata,
        title: captions.title,
        durationSec: captions.durationSec,
        tracks: captions.tracks.map((t) => ({ lang: t.lang, label: t.label, kind: detectCaptionKind(t.lang) })),
        chosen: { lang: chosen.lang, kind: detectCaptionKind(chosen.lang) },
        cues: cues.length,
        windows: segments.length,
        windowSec,
        markdownChars: markdown.length,
        timings,
      },
      null,
      2,
    ),
  );
}
