/**
 * Re-run a real YouTube capture against a stub huginn, as many times and in as
 * many kinds as you like, and write down exactly what ran.
 *
 * ## Why a harness rather than "capture it twice"
 *
 * Three properties of the live vertical make comparing kinds on a real video
 * impossible through the route:
 *
 *  - the route answers `duplicate` BEFORE a job exists, so the second capture of
 *    a video never runs at all;
 *  - `summarizeVideo` ingests into huginn and fires the source drafter
 *    unconditionally, so a comparison run would write documents and wiki
 *    proposals about a video already captured;
 *  - and the remedy the shape suggests — delete the document, capture again —
 *    is exactly what must not be done to a production corpus.
 *
 * So this drives the summarizer DIRECTLY, over the seams it already has: the
 * yt-dlp/ffmpeg `deps`, a stub `knowledgeApiUrl` on loopback, a temp frames
 * root, and `sourceDraft: false`. It never talks to the real huginn, never
 * writes under `~/.muninn/frames`, and never drafts a wiki page.
 *
 * The MODEL CALL is real: this runs on the resolved summarizer bot
 * (`SUMMARIZER_BOT`, jarvis on claude-sdk here) and spends money. That is the
 * point — the question it answers is what Deep actually costs and returns.
 *
 * ## Fixtures
 *
 * Two files, saved once, both of them kept OUT of the repo:
 *
 *   curl -s 'http://127.0.0.1:8321/api/youtube/transcript/<id>?timestamps=1' > transcript.json
 *   yt-dlp -f 'bv[height<=720][ext=mp4][vcodec^=avc1]/bv[height<=720][ext=mp4]/bv[height<=720]' \
 *          --no-playlist -o '<id>.mp4' 'https://www.youtube.com/watch?v=<id>'
 *
 * The transcript file is huginn's own JSON answer (`{transcript, timestamps}`),
 * so the stub can serve it byte for byte and the windowed-transcript path is
 * driven exactly as it is in production.
 *
 * ## Usage
 *
 *   bun scripts/replay-youtube.ts \
 *     --video <local.mp4> --transcript <transcript.json> --video-id <11 chars> \
 *     --title "…" --kind standard|deep --frames --runs 2 --out <dir>
 *
 * Per run it writes `<out>/<kind>-<n>/`: `summary.md` (the stored body),
 * `ingest.json` (the body posted to the stub), `frames/` (the frames the summary
 * quoted) and `run.json` (requested vs observed model, thinking budget,
 * connector, tokens, cost, elapsed).
 */

import { mkdir, copyFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { configure, type LogRecord } from "@logtape/logtape";
import { loadConfig } from "../src/config.ts";
import { discoverAllBots, resolveSummarizerBot } from "../src/bots/config.ts";
import { connectorCapabilities } from "../src/ai/one-shot.ts";
import { agentStatus } from "../src/observability/agent-status.ts";
import {
  CAPTURE_DEEP_MODEL,
  captureBotConfigFor,
  captureThinkingFor,
  findCapturePreset,
  resolveCapturePresets,
} from "../src/summaries/presets.ts";
import { CAPTURE_THINKING_MAX_TOKENS } from "../src/summaries/summarizer-shared.ts";
import { CAPTURE_FRAME_HEIGHT, extractCadenceFramesFromFile } from "../src/summaries/frames.ts";
import { summarizeVideo } from "../src/youtube/summarizer.ts";
import { createJob, getJob } from "../src/youtube/state.ts";
import type { DownloadResult, YtDlpInfo } from "../src/video/media.ts";

// --- arguments --------------------------------------------------------------

interface Args {
  video: string;
  transcript: string;
  videoId: string;
  title: string;
  kind: string;
  frames: boolean;
  out: string;
  runs: number;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  let frames = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--frames") { frames = true; continue; }
    if (!arg.startsWith("--")) die(`Unexpected argument: ${arg}`);
    const value = argv[++i];
    if (value === undefined) die(`${arg} needs a value`);
    flags.set(arg.slice(2), value);
  }
  const need = (name: string): string => flags.get(name) ?? die(`--${name} is required`);
  const runs = Number(flags.get("runs") ?? "1");
  if (!Number.isInteger(runs) || runs < 1) die("--runs must be a positive integer");
  return {
    video: resolve(need("video")),
    transcript: resolve(need("transcript")),
    videoId: need("video-id"),
    title: flags.get("title") ?? "Replay capture",
    kind: flags.get("kind") ?? "standard",
    frames,
    out: resolve(flags.get("out") ?? "./replay-out"),
    runs,
  };
}

function die(message: string): never {
  console.error(`replay-youtube: ${message}`);
  process.exit(1);
}

// --- the video's duration ---------------------------------------------------

/**
 * The duration of the local file, from ffprobe.
 *
 * It is what the probe seam answers with, so the frame budget, the cadence and
 * both timeouts are sized exactly as they are in a live capture — a hardcoded
 * number here would make every frame count in the output a fiction.
 */
async function probeDurationSec(file: string): Promise<number> {
  const proc = Bun.spawn(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0) die(`ffprobe failed on ${file}`);
  const seconds = Math.round(Number(out));
  if (!Number.isFinite(seconds) || seconds <= 0) die(`ffprobe reported no duration for ${file}`);
  return seconds;
}

// --- main -------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
if (!existsSync(args.video)) die(`No such video file: ${args.video}`);
if (!existsSync(args.transcript)) die(`No such transcript file: ${args.transcript}`);
if (!isAbsolute(args.out)) die("--out must resolve to an absolute path");

/** Everything the summarizer logs, so `run.json` can quote what actually ran. */
const logs: LogRecord[] = [];
await configure({
  sinks: {
    capture: (record: LogRecord) => {
      logs.push(record);
      // Every part, not only the strings: LogTape's `message` alternates text
      // and interpolated VALUES, so keeping the strings alone prints the line
      // with every number missing.
      const line = record.message.map((part) => (typeof part === "string" ? part : String(part))).join("");
      if (record.level === "warning" || record.level === "error" || line.includes("Summarized")) {
        console.log(`  [${record.level}] ${line.trim()}`);
      }
    },
  },
  loggers: [{ category: ["muninn"], lowestLevel: "info", sinks: ["capture"] }],
});

const transcriptPayload = await Bun.file(args.transcript).json() as {
  transcript?: string;
  timestamps?: boolean;
};
if (!transcriptPayload.transcript) die(`${args.transcript} has no "transcript" field`);

/**
 * The stub huginn.
 *
 * It serves the saved transcript and RECORDS the ingest instead of performing
 * one — the whole reason this harness exists. It answers `file_path` and an
 * empty `similar`, i.e. the shape `ingestSummary` reads, so the capture's
 * post-ingest path (the `onIngested` hook, `completeJob`) runs unchanged.
 */
// A holder rather than a bare `let`: the assignment happens inside the
// server's handler, which TypeScript's control flow cannot see, so a plain
// variable narrows to `null` after the per-run reset below.
const ingest: { body: Record<string, unknown> | null } = { body: null };
const huginn = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/youtube/transcript/")) {
      return Response.json(transcriptPayload);
    }
    if (url.pathname === "/api/youtube/ingest") {
      ingest.body = (await req.json()) as Record<string, unknown>;
      return Response.json({ file_path: `replay/${args.videoId}.md`, similar: [] });
    }
    return new Response("replay stub: not found", { status: 404 });
  },
});

const config = { ...loadConfig(), knowledgeApiUrl: `http://127.0.0.1:${huginn.port}` };
const botConfig = resolveSummarizerBot(discoverAllBots());
if (!botConfig) die("No bots discovered — nothing to run the capture on");

const presets = resolveCapturePresets(botConfig.prompts, botConfig.connector, {
  requireThinkingControl: true,
});
const preset = findCapturePreset(presets, args.kind);
if (!preset) {
  die(`Unknown kind "${args.kind}" on bot ${botConfig.name} — offered: ${presets.map((p) => p.id).join(", ")}`);
}
const runBot = captureBotConfigFor(botConfig, preset);
const durationSec = await probeDurationSec(args.video);

console.log(
  `replay: ${args.videoId} (${durationSec}s) · kind=${preset.id} · frames=${args.frames} · ` +
    `bot=${botConfig.name}/${botConfig.connector ?? "claude-cli"} · model=${runBot.model ?? "(bot default)"} · ` +
    `runs=${args.runs} · huginn stub on ${huginn.port}`,
);

await mkdir(args.out, { recursive: true });

for (let run = 1; run <= args.runs; run++) {
  const runDir = join(args.out, `${preset.id}-${run}`);
  await rm(runDir, { recursive: true, force: true });
  const framesRoot = join(runDir, "kept");
  await mkdir(framesRoot, { recursive: true });
  ingest.body = null;
  const logsBefore = logs.length;

  const jobId = createJob(args.videoId, args.title, `https://www.youtube.com/watch?v=${args.videoId}`);
  const startedAt = Date.now();
  await summarizeVideo(jobId, args.videoId, args.title, config, botConfig, {
    frames: args.frames,
    preset,
    // Never a wiki proposal: this ingests into a stub, so a draft would be a
    // gate item about a document that does not exist.
    sourceDraft: false,
    deps: {
      // The probe seam answers from the local file — no yt-dlp, no network.
      probeVideoInfo: async (): Promise<YtDlpInfo> => ({
        id: args.videoId,
        title: args.title,
        duration: durationSec,
        uploader: "replay",
      }),
      // The summarizer UNLINKS what the download hands it, so the fixture is
      // copied into the work dir rather than handed over.
      downloadVideo: async (_url: string, workDir: string): Promise<DownloadResult> => {
        await mkdir(workDir, { recursive: true });
        const target = join(workDir, basename(args.video));
        await copyFile(args.video, target);
        return {
          videoPath: target,
          id: args.videoId,
          title: args.title,
          duration: durationSec,
          uploader: "replay",
          canonicalUrl: `https://www.youtube.com/watch?v=${args.videoId}`,
        };
      },
      // The REAL extractor: the cadence and the frame count are what a live
      // capture of this video would get.
      extractFrames: ({ file, durationSec: seconds, outDir }) =>
        extractCadenceFramesFromFile(file, seconds, outDir, { height: CAPTURE_FRAME_HEIGHT }),
      framesRoot,
    },
  });
  const elapsedMs = Date.now() - startedAt;

  const job = getJob(jobId);
  // The completion line is where the summarizer states what actually ran: the
  // connector's own `ClaudeExecResult.model`, and the effective thinking budget.
  const summarized = logs
    .slice(logsBefore)
    .map((r) => r.properties as Record<string, unknown>)
    .findLast((p) => typeof p.model === "string" && typeof p.summaryKind === "string");
  // Token totals and cost land on the /agents run at the terminal transition.
  const agentRun = agentStatus.getRecentCompleted().at(-1);

  await writeFile(join(runDir, "summary.md"), job?.summary ?? job?.text ?? "");
  await writeFile(join(runDir, "ingest.json"), JSON.stringify(ingest.body, null, 2));
  const keptDir = join(framesRoot, "youtube", args.videoId);
  const keptFrames = existsSync(keptDir) ? (await readdir(keptDir)).sort() : [];

  const runJson = {
    videoId: args.videoId,
    title: args.title,
    durationSec,
    kind: preset.id,
    framesRequested: args.frames,
    status: job?.status,
    error: job?.error ?? null,
    category: job?.category ?? null,
    bot: botConfig.name,
    connector: botConfig.connector ?? "claude-cli",
    // What was ASKED for, from the resolved run config …
    requestedModel: runBot.model ?? "(bot default)",
    deepModelConstant: CAPTURE_DEEP_MODEL,
    // … and what the connector REPORTED. "unknown" means the connector named no
    // model; it is never inferred from the request.
    observedModel: (summarized?.model as string | undefined) ?? "unknown",
    // The summarizer's own label for the budget it ran with: `capped:<n>` is the
    // capture cap, `inherit:<n>` the bot's own, `connector-default` a connector
    // that does not honour the field at all.
    thinking: (summarized?.thinking as string | undefined) ?? "unknown",
    thinkingPolicy: captureThinkingFor(preset) === null ? "inherit" : "capped",
    captureThinkingCap: CAPTURE_THINKING_MAX_TOKENS,
    botThinkingMaxTokens: runBot.thinkingMaxTokens ?? null,
    supportsThinkingBudget: connectorCapabilities(runBot).supportsThinkingBudget,
    inputTokens: agentRun?.inputTokens ?? null,
    outputTokens: agentRun?.outputTokens ?? null,
    costUsd: agentRun?.costUsd ?? null,
    numTurns: agentRun?.numTurns ?? null,
    toolCount: agentRun?.toolCount ?? null,
    elapsedMs,
    summaryChars: (job?.summary ?? "").length,
    ingestSummaryKind: (ingest.body as Record<string, unknown> | null)?.summary_kind ?? null,
    // Numerically, not by filename: `readdir` sorts "1236.jpg" before "98.jpg".
    keptFrames: keptFrames
      .map((f) => Number(f.replace(/\.jpg$/, "")))
      .filter((n) => !Number.isNaN(n))
      .sort((a, b) => a - b),
    keptFrameCount: keptFrames.length,
  };
  await writeFile(join(runDir, "run.json"), `${JSON.stringify(runJson, null, 2)}\n`);
  console.log(`run ${run}/${args.runs} → ${runDir}`);
  console.log(JSON.stringify(runJson, null, 2));
}

huginn.stop(true);
process.exit(0);
