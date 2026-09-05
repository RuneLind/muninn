#!/usr/bin/env bun
/**
 * Live smoke for the Vimeo MEDIA seam (`src/vimeo/media.ts`): harvest the
 * signed manifest off the real player, download one 6 s segment of one
 * rendition as an fMP4, and pull a JPEG out of it with ffmpeg.
 *
 *   bun scripts/smoke-vimeo-media.ts https://vimeo.com/1223642971
 *   bun scripts/smoke-vimeo-media.ts --at 1390 --height 720 https://vimeo.com/1223642971
 *   bun scripts/smoke-vimeo-media.ts --audio https://vimeo.com/1223642971   # one Opus segment, ffprobe only
 *
 * Read-only against Vimeo; writes under an OS temp dir it names and keeps
 * (`--keep` is implicit — the point of a smoke is to look at the output).
 * An unknown or unparseable flag is REFUSED (exit 2), never ignored.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harvestVimeoCaptions } from "../src/vimeo/captions.ts";
import { resolveVimeoRef } from "../src/vimeo/url.ts";
import {
  chooseRepresentation,
  downloadRendition,
  fetchVimeoManifest,
  segmentIndexAt,
} from "../src/vimeo/media.ts";

function usage(code: number): never {
  console.error("usage: bun scripts/smoke-vimeo-media.ts [--at <sec>] [--height <px>] [--audio] <vimeo url or id>");
  process.exit(code);
}

let at = 60;
let height = 720;
let audio = false;
let target: string | undefined;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  const eq = a.indexOf("=");
  const name = a.startsWith("--") ? (eq > 0 ? a.slice(0, eq) : a) : null;
  const value = () => {
    if (eq > 0) return a.slice(eq + 1);
    const v = args[++i];
    if (v === undefined) usage(2);
    return v;
  };
  if (name === "--at") {
    at = Number(value());
    if (!Number.isFinite(at) || at < 0) usage(2);
  } else if (name === "--height") {
    height = Number(value());
    if (!Number.isInteger(height) || height <= 0) usage(2);
  } else if (name === "--audio") {
    audio = true;
  } else if (name === "--help" || name === "-h") {
    usage(0);
  } else if (name !== null) {
    console.error(`unknown flag: ${a}`);
    usage(2);
  } else if (target === undefined) {
    target = a;
  } else {
    usage(2);
  }
}
if (!target) usage(2);

const ref = resolveVimeoRef(target);
if (!ref) {
  console.error(`not a Vimeo video: ${target}`);
  process.exit(2);
}

const say = (line: string) => console.log(line);
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

say(`video       ${ref.id}${ref.hash ? ` (hash ${ref.hash})` : ""}`);
const captions = await harvestVimeoCaptions(ref.id, { ...(ref.hash ? { hash: ref.hash } : {}) });
say(`harvest     ${captions.tracks.length} caption track(s), manifest ${captions.manifestUrl ? "captured" : "NOT seen"} [${stamp()}]`);
if (!captions.manifestUrl) {
  console.error("the player requested no manifest inside the budget — nothing to download");
  process.exit(1);
}

const manifest = await fetchVimeoManifest(captions.manifestUrl);
say(
  `manifest    clip ${manifest.clipId}: ${manifest.video.length} video (${manifest.video
    .map((r) => `${r.height}p`)
    .join(", ")}), ${manifest.audio.length} audio (${manifest.audio.map((r) => r.codecs).join(", ")}) [${stamp()}]`,
);

const rep = audio
  ? chooseRepresentation(manifest, { kind: "audio", codec: "opus" })
  : chooseRepresentation(manifest, { kind: "video", height });
if (!rep) {
  console.error("no representation of that kind in the manifest");
  process.exit(1);
}
say(
  `rendition   ${rep.id} ${rep.kind} ${rep.codecs}${rep.height ? ` ${rep.width}x${rep.height}` : ""} avg ${Math.round(
    rep.avgBitrate / 1000,
  )} kbps, ${rep.segments.length} segments, ${rep.durationSec.toFixed(1)} s`,
);

const index = segmentIndexAt(rep, at);
const seg = rep.segments[index]!;
const dir = mkdtempSync(join(tmpdir(), "vimeo-media-smoke-"));
const out = join(dir, `${ref.id}-${rep.kind}-${index}.mp4`);
const file = await downloadRendition(captions.manifestUrl, manifest, rep, [index], out);
say(`segment     #${index} ${seg.start.toFixed(2)}–${seg.end.toFixed(2)} s, declared ${seg.size} B, wrote ${file.bytes} B [${stamp()}]`);
say(`file        ${out}`);

const probe = Bun.spawnSync(
  [
    "ffprobe",
    "-v",
    "error",
    "-show_entries",
    "format=start_time,duration",
    "-show_entries",
    "stream=codec_name,width,height,sample_rate",
    "-of",
    "default=noprint_wrappers=1",
    out,
  ],
  { stdout: "pipe", stderr: "pipe" },
);
say(`ffprobe     exit ${probe.exitCode}\n${probe.stdout.toString().trim().split("\n").map((l) => `            ${l}`).join("\n")}`);
if (probe.exitCode !== 0) {
  console.error(probe.stderr.toString());
  process.exit(1);
}

if (!audio) {
  // Seek RELATIVE to the segment's start: input `-ss` on this fMP4 is measured
  // from the file's `start_time`, which is the segment's absolute start.
  const offset = Math.max(0, Math.min(at - seg.start, seg.end - seg.start - 0.04));
  const jpg = join(dir, `${ref.id}-${Math.round(at)}s.jpg`);
  const ff = Bun.spawnSync(
    ["ffmpeg", "-v", "error", "-y", "-ss", offset.toFixed(2), "-i", out, "-frames:v", "1", "-vf", `scale=${height}:-2`, jpg],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (ff.exitCode !== 0) {
    console.error(ff.stderr.toString());
    process.exit(1);
  }
  const size = Bun.file(jpg).size;
  say(`frame       t=${at}s (offset ${offset.toFixed(2)} s into the segment) → ${jpg} (${size} B) [${stamp()}]`);
}
say(`done        [${stamp()}]`);
