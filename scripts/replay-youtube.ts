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
 *     --title "…" --kind standard|deep --frames \
 *     --visual-detail selected|detailed --scan dense|cadence --runs 2 --out <dir>
 *
 * `--visual-detail` is the SLIDES policy and is read only where `--frames` is
 * on; it defaults to `selected`, the route's own default. `--scan` writes
 * `YOUTUBE_FRAME_SCAN` — the env the summarizer actually reads — so a run can
 * compare the dense two-pass path against the cadence one it replaced; absent,
 * whatever that variable already says (unset ⇒ `dense`).
 *
 * On the dense path the harness drives the REAL ffmpeg scan, the REAL contact
 * sheets and a REAL selection model call, and wraps each of those seams to time
 * and count them.
 *
 * ## The trace half
 *
 * The harness calls `initDb`, so the capture's `capture:youtube` trace is
 * written to `DATABASE_URL` — the dev server's database — and the run shows up
 * on `/traces` and `/agents` beside a live one. If that database is not
 * answering, tracing is switched OFF for the run with one line rather than left
 * to fail one span at a time; `run.json` is unaffected either way.
 *
 * ## Output
 *
 * Per run it writes `<out>/<kind>-<visual-detail>-<n>/`: `summary.md` (the
 * stored body), `ingest.json` (the body posted to the stub), `kept/` (the frames
 * the summary quoted) and `run.json` (requested vs observed model, thinking
 * budget, connector, tokens, cost, elapsed, the four frame counts —
 * extracted / selected / referenced / retained — the seconds the stored text
 * quotes, and whether a `## Visual reference` appendix landed before
 * `## Transcript`).
 *
 * On a dense run `run.json` also carries the scan step by step — samples,
 * candidates after the dedup, candidates after the cap, sheet count, the
 * selection manifest — the two passes' spend SEPARATELY beside the accumulated
 * total, each stage's wall time, and the peak size of the two temp roots
 * (sampled while the job runs, because both are removed in its `finally`).
 */

import { mkdir, copyFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { configure, type LogRecord } from "@logtape/logtape";
import { loadConfig } from "../src/config.ts";
import { getDb, initDb } from "../src/db/client.ts";
import { discoverAllBots, resolveSummarizerBot } from "../src/bots/config.ts";
import { connectorCapabilities } from "../src/ai/one-shot.ts";
import { agentStatus } from "../src/observability/agent-status.ts";
import {
  CAPTURE_DEEP_MODEL,
  captureBotConfigFor,
  captureThinkingFor,
  findCapturePreset,
} from "../src/summaries/presets.ts";
import { youtubeCaptureKinds } from "../src/youtube/kinds.ts";
import { CAPTURE_THINKING_MAX_TOKENS } from "../src/summaries/summarizer-shared.ts";
import {
  CAPTURE_FRAME_HEIGHT,
  YOUTUBE_FRAME_SOURCE,
  extractCadenceFramesFromFile,
  referencedFrameSeconds,
} from "../src/summaries/frames.ts";
import {
  DEFAULT_VISUAL_DETAIL,
  VISUAL_DETAIL_VALUES,
  VISUAL_REFERENCE_HEADING_RE,
  isVisualDetail,
  type VisualDetail,
} from "../src/summaries/visual-detail.ts";
import { splitTranscript } from "../src/summaries/export.ts";
import { inProtectedRegion, markdownCodeRegions } from "../src/format/markdown-ast.ts";
import {
  YOUTUBE_FRAME_SCAN_ENV,
  capScanCandidates,
  dedupeScanSamples,
  resolveFrameScanMode,
  type ScanCandidate,
} from "../src/youtube/scan.ts";
import {
  buildContactSheets,
  regrabFrames,
  runDenseScan,
} from "../src/youtube/scan-run.ts";
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
  visualDetail: VisualDetail;
  out: string;
  runs: number;
  /** Which sampler to drive — written into the env the summarizer reads. */
  scan: "dense" | "cadence";
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
  // The ROUTE's own validation, not a second spelling: a harness that accepted a
  // policy the route 400s would compare a run production cannot make.
  const visualDetail = flags.get("visual-detail") ?? DEFAULT_VISUAL_DETAIL;
  if (!isVisualDetail(visualDetail)) {
    die(`--visual-detail must be one of ${VISUAL_DETAIL_VALUES.join(", ")}`);
  }
  // Set on the ENV rather than passed down, because that is the only channel the
  // summarizer reads it on — a harness flag that took another route would be
  // comparing a mode production cannot select.
  const scan = flags.get("scan");
  if (scan !== undefined) {
    if (scan !== "dense" && scan !== "cadence") die("--scan must be dense or cadence");
    process.env[YOUTUBE_FRAME_SCAN_ENV] = scan;
  }
  return {
    video: resolve(need("video")),
    transcript: resolve(need("transcript")),
    videoId: need("video-id"),
    title: flags.get("title") ?? "Replay capture",
    kind: flags.get("kind") ?? "standard",
    frames,
    visualDetail,
    out: resolve(flags.get("out") ?? "./replay-out"),
    runs,
    scan: resolveFrameScanMode().mode,
  };
}

function die(message: string): never {
  console.error(`replay-youtube: ${message}`);
  process.exit(1);
}

/**
 * Where the `## Visual reference` appendix sits relative to `## Transcript` in
 * the body that was ingested — the plan's placement rule, checkable per run.
 *
 * Both halves are the SHIPPED readers, never a harness spelling of them:
 * `VISUAL_REFERENCE_HEADING_RE` is the rule the enforcement pass locates the
 * appendix by, and `splitTranscript` is the fence-aware cut the `/summaries`
 * article view and the export both use. A harness with regexes of its own can
 * report a placement the product does not see.
 *
 * `null` when the body carries no appendix (every `selected` run, and a
 * `detailed` run whose model wrote none); otherwise true only when the appendix
 * heading really precedes the transcript heading.
 */
function appendixOrder(ingested: string | null): boolean | null {
  if (ingested === null) return null;
  const { body, transcript } = splitTranscript(ingested);
  if (hasAppendixHeading(body)) return true;
  if (transcript === null) return null;
  // No appendix before the transcript: either there is none at all, or the
  // model put it after — which is the placement rule failing, not a run with no
  // appendix.
  return hasAppendixHeading(transcript) ? false : null;
}

/** A real appendix heading in this text — never one quoted inside a fence. */
function hasAppendixHeading(markdown: string): boolean {
  const code = markdownCodeRegions(markdown);
  let offset = 0;
  for (const line of markdown.split("\n")) {
    const at = offset;
    offset += line.length + 1;
    if (inProtectedRegion(at, code)) continue;
    if (VISUAL_REFERENCE_HEADING_RE.test(line)) return true;
  }
  return false;
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

const loaded = loadConfig();

/**
 * The trace half of the evidence, or none at all — never four
 * `Failed to write span: Database not initialized` lines and no trace.
 *
 * `runCaptureOneShot` opens a `capture:youtube` trace unconditionally and the
 * tracer writes through the shared client, which nothing here used to
 * initialize. So `initDb` runs — `loadConfig` has already made `DATABASE_URL`
 * required, so there is no "unset" case to branch on — and the run then appears
 * on `/traces` and `/agents` beside a live capture, which is the point.
 *
 * What IS worth branching on is a database that is not answering (`db:up` not
 * run), which reproduces the same shape one layer down: four failed span writes
 * per run and nothing to read afterwards. One bounded probe settles it, and
 * tracing is turned off for the run with a single line instead.
 */
async function tracingUsable(): Promise<boolean> {
  if (!loaded.tracingEnabled) return false;
  initDb(loaded);
  try {
    await Promise.race([
      getDb()`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 5000)),
    ]);
    return true;
  } catch (err) {
    console.log(
      `replay-youtube: no trace this run — the database is not answering ` +
        `(${err instanceof Error ? err.message : String(err)}). Run \`bun run db:up\` for the trace half.`,
    );
    return false;
  }
}

const tracingEnabled = await tracingUsable();
// The `Config` field is NOT what the tracer reads. `Tracer` calls its own
// `isTracingEnabled()`, which re-reads the ENVIRONMENT (once, then caches on
// the first `new Tracer`), so a `tracingEnabled: false` on the object handed to
// `summarizeVideo` suppresses nothing — measured: four `Failed to write span`
// lines with the field already false. This runs before any capture, i.e. before
// the first Tracer exists.
if (!tracingEnabled) process.env.TRACING_ENABLED = "false";

const config = {
  ...loaded,
  tracingEnabled,
  knowledgeApiUrl: `http://127.0.0.1:${huginn.port}`,
};
const botConfig = resolveSummarizerBot(discoverAllBots());
if (!botConfig) die("No bots discovered — nothing to run the capture on");

// The ROUTE's offer set, not a second spelling of it: a harness that resolved
// its own kinds could run one the route would 400.
const presets = youtubeCaptureKinds(botConfig);
const preset = findCapturePreset(presets, args.kind);
if (!preset) {
  die(`Unknown kind "${args.kind}" on bot ${botConfig.name} — offered: ${presets.map((p) => p.id).join(", ")}`);
}
const runBot = captureBotConfigFor(botConfig, preset);
const durationSec = await probeDurationSec(args.video);

console.log(
  `replay: ${args.videoId} (${durationSec}s) · kind=${preset.id} · frames=${args.frames} · ` +
    `visual=${args.visualDetail} · ` +
    `bot=${botConfig.name}/${botConfig.connector ?? "claude-cli"} · model=${runBot.model ?? "(bot default)"} · ` +
    `runs=${args.runs} · huginn stub on ${huginn.port}`,
);

await mkdir(args.out, { recursive: true });

/**
 * The size of a directory in bytes, or 0 when it is not there.
 *
 * `du -sk`, because the roots hold hundreds of small JPEGs and a recursive walk
 * in-process would itself be slow enough to move the number it reports.
 */
async function dirBytes(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  const proc = Bun.spawn(["du", "-sk", dir], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return (Number(out.split(/\s+/)[0]) || 0) * 1024;
}

for (let run = 1; run <= args.runs; run++) {
  const runDir = join(args.out, `${preset.id}-${args.visualDetail}-${run}`);
  await rm(runDir, { recursive: true, force: true });
  const framesRoot = join(runDir, "kept");
  await mkdir(framesRoot, { recursive: true });
  ingest.body = null;
  const logsBefore = logs.length;

  const jobId = createJob(args.videoId, args.title, `https://www.youtube.com/watch?v=${args.videoId}`);
  const startedAt = Date.now();

  // ── what the dense path did, measured around the SHIPPED seams ────────────
  //
  // Wrapped rather than reimplemented: `scanVideo`/`buildSheets`/`regrabFrames`
  // are the real ones, and the dedup + cap below are the shipped functions over
  // the scan's own signatures — so "candidates after dedup" is the number the
  // capture itself computed, not a second opinion about it.
  let extractionStartedAt = 0;
  let extractionEndedAt = 0;
  let scanWallMs: number | null = null;
  let sheetWallMs: number | null = null;
  let regrabWallMs: number | null = null;
  let cadenceWallMs: number | null = null;
  let scannedSamples: number | null = null;
  let afterDedup: number | null = null;
  let afterCap: number | null = null;
  let sheetCount: number | null = null;
  let peakScratchBytes = 0;
  const workDir = join(tmpdir(), `muninn-youtube-${jobId}`);
  const mediaDir = join(tmpdir(), `muninn-youtube-media-${jobId}`);
  // Sampled WHILE the job runs: both roots are removed in its `finally`, so a
  // measurement after it returns is always zero.
  const scratchSampler = setInterval(() => {
    void Promise.all([dirBytes(workDir), dirBytes(mediaDir)]).then(([a, b]) => {
      peakScratchBytes = Math.max(peakScratchBytes, a + b);
    });
  }, 2000);

  await summarizeVideo(jobId, args.videoId, args.title, config, botConfig, {
    frames: args.frames,
    preset,
    visualDetail: args.visualDetail,
    deps: {
      // Never a wiki proposal: this ingests into a stub, so a draft would be a
      // gate item about a document that does not exist.
      sourceDraft: false,
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
        extractionStartedAt = Date.now();
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
      extractFrames: async ({ file, durationSec: seconds, outDir }) => {
        const t0 = Date.now();
        try {
          return await extractCadenceFramesFromFile(file, seconds, outDir, { height: CAPTURE_FRAME_HEIGHT });
        } finally {
          cadenceWallMs = Date.now() - t0;
          extractionEndedAt = Date.now();
        }
      },
      // The REAL dense pass, timed and counted on the way through.
      scanVideo: async (input) => {
        const t0 = Date.now();
        const result = await runDenseScan(input);
        scanWallMs = Date.now() - t0;
        scannedSamples = result.samples.length;
        const deduped: ScanCandidate[] = dedupeScanSamples(
          result.signatures,
          result.samples.map((sample) => sample.tSeconds),
        );
        afterDedup = deduped.length;
        afterCap = capScanCandidates(deduped).length;
        return result;
      },
      buildSheets: async (input) => {
        const t0 = Date.now();
        const plans = await buildContactSheets(input);
        sheetWallMs = Date.now() - t0;
        sheetCount = plans.length;
        return plans;
      },
      regrabFrames: async (input) => {
        const t0 = Date.now();
        try {
          return await regrabFrames(input);
        } finally {
          regrabWallMs = Date.now() - t0;
          extractionEndedAt = Date.now();
        }
      },
      framesRoot,
    },
  });
  clearInterval(scratchSampler);
  const elapsedMs = Date.now() - startedAt;

  const job = getJob(jobId);
  const runLogs = logs.slice(logsBefore).map((r) => r.properties as Record<string, unknown>);
  // The completion line is where the summarizer states what actually ran: the
  // connector's own `ClaudeExecResult.model`, and the effective thinking budget.
  //
  // Matched on its own MARKER, never on "the last record carrying a model and a
  // summaryKind": the dense path writes a SECOND line with a `model` on it (the
  // selection pass's), so a shape-based match would report whichever came last.
  const summarized = runLogs.find((p) => p.event === "capture_complete");
  const selected = runLogs.find((p) => p.event === "selection_complete");
  // Token totals and cost land on the /agents run at the terminal transition —
  // SUMMED across both passes by the job store, which is why this is the total
  // and the two per-pass numbers below are read off their own lines.
  const agentRun = agentStatus.getRecentCompleted().at(-1);

  await writeFile(join(runDir, "summary.md"), job?.summary ?? job?.text ?? "");
  await writeFile(join(runDir, "ingest.json"), JSON.stringify(ingest.body, null, 2));
  const keptDir = join(framesRoot, "youtube", args.videoId);
  const keptFrames = existsSync(keptDir) ? (await readdir(keptDir)).sort() : [];

  // Read once through the holder's declared type: TypeScript narrows
  // `ingest.body` to `null` here (it is only ever assigned inside the server's
  // handler), which is the same reason `ingestSummaryKind` below casts.
  const ingestBody = ingest.body as Record<string, unknown> | null;

  const runJson = {
    videoId: args.videoId,
    title: args.title,
    durationSec,
    kind: preset.id,
    framesRequested: args.frames,
    visualDetail: args.visualDetail,
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
    // The ACCUMULATED spend of the whole job — both passes where there were two.
    inputTokens: agentRun?.inputTokens ?? null,
    outputTokens: agentRun?.outputTokens ?? null,
    costUsd: agentRun?.costUsd ?? null,
    numTurns: agentRun?.numTurns ?? null,
    toolCount: agentRun?.toolCount ?? null,
    // ── the two passes, apart ────────────────────────────────────────────────
    scanMode: args.scan,
    // WHICH sampler actually ran, and where a dense attempt gave up:
    // `dense` · `cadence` · `scan_failed` · `selection_failed` · `regrab_failed`.
    frameScan: (summarized?.frameScan as string | undefined) ?? null,
    selectionPass: selected
      ? {
          model: selected.model ?? "unknown",
          inputTokens: selected.inputTokens ?? null,
          outputTokens: selected.outputTokens ?? null,
          costUsd: selected.costUsd ?? null,
          numTurns: selected.numTurns ?? null,
          toolCount: selected.toolCount ?? null,
          elapsedMs: selected.elapsedMs ?? null,
          chose: selected.n ?? null,
        }
      : null,
    synthesisPass: {
      model: (summarized?.model as string | undefined) ?? "unknown",
      // The summary call's own spend is the job total minus the selection
      // pass's, which is the only place either is stated per call.
      inputTokens:
        typeof summarized?.totalInputTokens === "number" && typeof selected?.inputTokens === "number"
          ? summarized.totalInputTokens - selected.inputTokens
          : (agentRun?.inputTokens ?? null),
      outputTokens:
        typeof summarized?.totalOutputTokens === "number" && typeof selected?.outputTokens === "number"
          ? summarized.totalOutputTokens - selected.outputTokens
          : (agentRun?.outputTokens ?? null),
      timeoutMs: (summarized?.synthesisTimeoutMs as number | null | undefined) ?? null,
    },
    // ── the scan, step by step ───────────────────────────────────────────────
    scanSamples: scannedSamples,
    candidatesAfterDedup: afterDedup,
    candidatesAfterCap: afterCap,
    sheetCount,
    /** The selection pass's manifest as it was parsed, entry by entry. */
    selectionManifest: summarized?.selectionManifest
      ? (JSON.parse(String(summarized.selectionManifest)) as unknown[])
      : [],
    // ── what it cost in wall time and disk ───────────────────────────────────
    scanWallMs,
    sheetWallMs,
    regrabWallMs,
    cadenceWallMs,
    /** Download start to the last frame-producing pass returning. */
    extractionWallMs: extractionEndedAt > 0 ? extractionEndedAt - extractionStartedAt : null,
    /** The largest both temp roots got together, sampled while the job ran. */
    peakScratchBytes,
    elapsedMs,
    summaryChars: (job?.summary ?? "").length,
    ingestSummaryKind: ingestBody?.summary_kind ?? null,
    // The four frame counts the summarizer's own completion line reports, kept
    // SEPARATE because each answers a different question: what the model was
    // shown, what it chose, what survived the caps and the manifest, and what is
    // on disk to serve. They are read off that line rather than recomputed, so
    // `run.json` cannot report a number production never logged.
    extractedFrames: (summarized?.frames as number | undefined) ?? null,
    selectedFrames: (summarized?.selected as number | undefined) ?? null,
    referencedFrames: (summarized?.referenced as number | undefined) ?? null,
    retainedFrames: (summarized?.kept as number | undefined) ?? null,
    // Which seconds the model CHOSE — the set `referencedSeconds` below is a
    // subset of. The difference is what the policy's caps refused, which is the
    // number a calibration run is actually reading.
    selectedSeconds:
      typeof summarized?.selectedSeconds === "string" && summarized.selectedSeconds !== ""
        ? summarized.selectedSeconds.split(",").map(Number)
        : [],
    // What the STORED text actually quotes, read back out of it with the seam's
    // own reader — the one number that is evidence rather than a report.
    referencedSeconds: referencedFrameSeconds(job?.summary ?? "", YOUTUBE_FRAME_SOURCE, args.videoId),
    // Numerically, not by filename: `readdir` sorts "1236.jpg" before "98.jpg".
    keptFrames: keptFrames
      .map((f) => Number(f.replace(/\.jpg$/, "")))
      .filter((n) => !Number.isNaN(n))
      .sort((a, b) => a - b),
    keptFrameCount: keptFrames.length,
    /** Whether the appendix landed BEFORE `## Transcript` in the ingested body. */
    appendixBeforeTranscript: appendixOrder(
      typeof ingestBody?.summary === "string" ? ingestBody.summary : null,
    ),
  };
  await writeFile(join(runDir, "run.json"), `${JSON.stringify(runJson, null, 2)}\n`);
  console.log(`run ${run}/${args.runs} → ${runDir}`);
  console.log(JSON.stringify(runJson, null, 2));
}

huginn.stop(true);
process.exit(0);
