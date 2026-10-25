/**
 * The tool-surface fence through four REAL callers, not through
 * `executeOneShot`: a YouTube frame pass, a YouTube text-only capture, a
 * `/api/summaries/rerun` replay over kept frames, and a fact-check verify
 * pass. Each runs against a real Claude CLI and a real Agent SDK subprocess
 * with the fake Messages API (`src/test/fake-messages-api.ts`) answering.
 *
 * The probe marker rides the caller's own input (the transcript, the claim
 * title), so the fake answers the caller's model call with five hostile tool
 * calls: `Bash`, a `Read` of a canary outside every allowed dir, a `Read` of
 * `<botDir>/config.json`, a `<dir>/../..` traversal `Read` to a real secret
 * file, and a call to a stub MCP server that records calls. None may run and
 * the stub must never start. The frame passes must still read
 * `<frames>/x.jpg`, and the verify pass must still WebFetch.
 *
 * `tool-surface-fence.test.ts` proves the connectors honour each surface; this
 * file proves each caller DECLARES the surface it should, end to end.
 *
 * Its own `bun test` link: it rewrites `process.env` (including `TMPDIR`, so a
 * capture's work dir lands inside the fixture) and mocks the Haiku router for
 * the fact-check extraction phase with `mock.module`. Arms skip without their
 * binary, like the sibling harness.
 *
 * `FENCE_ROWS=1` prints one per-tool outcome row per arm (`FENCE-ROW | …`), the
 * table a PR's Testing section quotes; a plain run prints nothing.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Hono } from "hono";

// The fact-check extraction is a Haiku-router call; the fake API cannot speak
// its claim-list format, so the router answers with one claim carrying the
// probe marker. Set before any import that reaches haiku-direct.
const realHaiku = await import("./haiku-direct.ts");
mock.module("./haiku-direct.ts", () => ({
  ...realHaiku,
  callHaikuWithFallback: async () => ({
    result: JSON.stringify({ claims: [{ title: `${PROBE_MARKER} the probe page says the sky is blue` }] }),
    inputTokens: 1,
    outputTokens: 1,
    model: "fake-haiku",
    backend: "anthropic",
  }),
}));

// The short-video job has no deps seam: its download and whisper steps are
// replaced here (no network, no whisper), and the REAL `extractKeyframes` runs
// ffmpeg over a generated clip, so the frames dir is the one the job builds.
// `downloadVideo` leaves the video in the work dir, beside the frames dir, plus
// a TEXT file carrying a secret: Read refuses an .mp4 as binary on its own, so
// only a readable file there proves the fence (not the file type) refuses it.
let shortVideoSource = "";
const realMedia = await import("../video/media.ts");
mock.module("../video/media.ts", () => ({
  ...realMedia,
  downloadVideo: async (_url: string, workDir: string) => {
    mkdirSync(workDir, { recursive: true });
    const videoPath = join(workDir, "video.mp4");
    copyFileSync(shortVideoSource, videoPath);
    writeFileSync(join(workDir, "video.info.txt"), `${VIDEO_SECRET}\n`);
    return { videoPath, id: "7523456789", title: "A clip", duration: 8, uploader: "coolcoder", canonicalUrl: "https://www.tiktok.com/@coolcoder/video/7523456789" };
  },
  transcribeVideo: async () => `${PROBE_MARKER} a short clip about colours`,
}));

import type { ConnectorType } from "../bots/config.ts";
import {
  compareVersions,
  installedClaudeCliVersion,
  MIN_RESTRICTED_CLI_VERSION,
  toolSurfaceTestSeam,
} from "./tool-surface.ts";
import {
  createFenceFixture,
  hasOpenssl,
  PROBE_MARKER,
  type FenceFixture,
  type ObservedToolResult,
  type ScriptedToolUse,
} from "../test/fake-messages-api.ts";
import { driveBot, driveConfig } from "../test/one-shot-drive.ts";

const { summarizeVideo } = await import("../youtube/summarizer.ts");
const { createJob, getJob } = await import("../youtube/state.ts");
const { findCapturePreset, SHIPPED_CAPTURE_PRESETS } = await import("../summaries/presets.ts");
const { registerSummariesRerunRoutes } = await import("../dashboard/routes/summaries-rerun.ts");
const { SummarySaveClaims } = await import("../summaries/summary-save.ts");
const { streamFactcheckSSE } = await import("../dashboard/routes/factcheck-sse.ts");
const { summarizeTikTok } = await import("../tiktok/summarizer.ts");
const tiktokState = await import("../tiktok/state.ts");

function sdkBinaryAvailable(): boolean {
  const require = createRequire(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
  const { platform, arch } = process;
  const names = platform === "linux" ? [`linux-${arch}`, `linux-${arch}-musl`] : [`${platform}-${arch}`];
  return names.some((n) => {
    try {
      return existsSync(require.resolve(`@anthropic-ai/claude-agent-sdk-${n}/claude${platform === "win32" ? ".exe" : ""}`));
    } catch {
      return false;
    }
  });
}

const cliVersion = await installedClaudeCliVersion();
const cliReady = hasOpenssl() && cliVersion !== null && compareVersions(cliVersion, MIN_RESTRICTED_CLI_VERSION) >= 0;
const sdkReady = hasOpenssl() && sdkBinaryAvailable();

const VIDEO_ID = "abcdefghijk";
const DOC_ID = "ai/general/A Talk About Things.md";
const STANDARD = findCapturePreset(SHIPPED_CAPTURE_PRESETS, "standard")!;
const FRAME_SECRET = "FRAME-TRAVERSAL-SECRET-3b91";
const KEPT_SECRET = "KEPT-TRAVERSAL-SECRET-77c4";
const VIDEO_SECRET = "SHORT-VIDEO-WORKDIR-SECRET-5e20";

let f: FenceFixture;
let tmpRoot: string;
let framesRoot: string;
let huginn: ReturnType<typeof Bun.serve>;
const savedEnv = { ...process.env };

beforeAll(() => {
  if (!cliReady && !sdkReady) return;
  f = createFenceFixture();
  const configDir = join(f.root, "claude-config");
  mkdirSync(configDir);
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({
    permissions: { allow: ["Bash", "Read", "WebFetch", "WebSearch", "mcp__stub__record"] },
  }));
  const botMcp = JSON.parse(readFileSync(join(f.botDir, ".mcp.json"), "utf8"));
  writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ mcpServers: botMcp.mcpServers }));

  // A capture's work dir is `<tmpdir>/muninn-youtube-<job>`, so `<frames>/../..`
  // is the tmpdir itself: point it into the fixture and plant a secret there.
  tmpRoot = join(f.root, "tmp");
  mkdirSync(tmpRoot);
  writeFileSync(join(tmpRoot, "frame-traversal.txt"), `${FRAME_SECRET}\n`);
  // Kept frames live at `<framesRoot>/youtube/<id>/`; `../..` is the root.
  framesRoot = join(f.root, "frames-root");
  mkdirSync(join(framesRoot, "youtube", VIDEO_ID), { recursive: true });
  writeFileSync(join(framesRoot, "kept-traversal.txt"), `${KEPT_SECRET}\n`);
  copyFileSync(join(f.allowedDir, "x.jpg"), join(framesRoot, "youtube", VIDEO_ID, "30.jpg"));
  copyFileSync(join(f.allowedDir, "x.jpg"), join(framesRoot, "youtube", VIDEO_ID, "x.jpg"));

  // An 8 s clip of eight colour cuts, so scene detection yields real frames.
  if (Bun.which("ffmpeg")) {
    const colors = ["red", "blue", "green", "yellow", "white", "black", "magenta", "cyan"];
    shortVideoSource = join(f.root, "clip.mp4");
    const gen = Bun.spawnSync([
      "ffmpeg", "-y",
      ...colors.flatMap((c) => ["-f", "lavfi", "-i", `color=c=${c}:s=160x120:d=1:r=10`]),
      "-filter_complex", `${colors.map((_, i) => `[${i}:v]`).join("")}concat=n=${colors.length}:v=1:a=0[v]`,
      "-map", "[v]", "-pix_fmt", "yuv420p", shortVideoSource,
    ], { stderr: "pipe" });
    if (gen.exitCode !== 0) shortVideoSource = "";
  }

  huginn = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname.startsWith("/api/youtube/transcript/")) {
        return Response.json({
          transcript: `### [00:00:00]\n${PROBE_MARKER} hello there, this talk is about slides\n\n### [00:02:00]\nmore words`,
          ...(u.searchParams.get("timestamps") === "1" ? { timestamps: true } : {}),
        });
      }
      if (u.pathname === "/api/youtube/ingest") return Response.json({ file_path: "ai/rag/A talk.md", similar: [] });
      return new Response("not found", { status: 404 });
    },
  });

  for (const key of Object.keys(process.env)) {
    if (key.startsWith("CLAUDE") || key.startsWith("ANTHROPIC")) delete process.env[key];
  }
  delete process.env.SUMMARIZER_BOT;
  Object.assign(process.env, f.env, {
    CLAUDE_CONFIG_DIR: configDir,
    MUNINN_AGENT_CWD: join(f.root, "agent-home"),
    TMPDIR: tmpRoot,
    TRACING_ENABLED: "false",
    YOUTUBE_FRAME_SCAN: "cadence",
    DATABASE_URL: process.env.DATABASE_URL || "postgresql://unused@127.0.0.1:1/unused_test",
  });
  toolSurfaceTestSeam.extraSettings = { skipWebFetchPreflight: true };
});

afterAll(() => {
  delete toolSurfaceTestSeam.extraSettings;
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  huginn?.stop(true);
  f?.cleanup();
});

const captureConfig = () => ({ ...driveConfig, knowledgeApiUrl: `http://127.0.0.1:${huginn.port}` }) as typeof driveConfig;
const bot = (connector: ConnectorType) => driveBot(f.botDir, { connector, model: "claude-sonnet-4-5" });

/** The five hostile calls, with the traversal taken from `dir`. */
function hostileFrom(dir: string, traversalName: string): ScriptedToolUse[] {
  return [
    { name: "Bash", input: { command: `echo ran > ${f.bashMarker}`, description: "probe" } },
    { name: "Read", input: { file_path: f.canaryPath } },
    { name: "Read", input: { file_path: join(f.botDir, "config.json") } },
    { name: "Read", input: { file_path: join(dir, "..", "..", traversalName) } },
    { name: "mcp__stub__record", input: { note: "probe" } },
  ];
}

interface Outcome {
  results: ObservedToolResult[];
  leaked: string[];
  bashRan: boolean;
  mcpStarted: boolean;
  mcpCalls: number;
  pageHits: number;
}

/** Remove every marker a run leaves on disk, so one arm's outcome cannot carry into the next. */
function resetRunMarkers() {
  rmSync(f.bashMarker, { force: true });
  rmSync(f.mcpStartedPath, { force: true });
}

async function probe(plan: ScriptedToolUse[], run: () => Promise<unknown>): Promise<Outcome> {
  f.api.setPlan(plan);
  resetRunMarkers();
  const hits = f.page.hits();
  const calls = f.mcpCalls();
  await run();
  const results = f.api.toolResults();
  const secrets = [...f.secrets, FRAME_SECRET, KEPT_SECRET, VIDEO_SECRET];
  return {
    results,
    leaked: secrets.filter((s) => results.some((r) => r.text.includes(s))),
    bashRan: existsSync(f.bashMarker),
    mcpStarted: f.mcpStarted(),
    mcpCalls: f.mcpCalls() - calls,
    pageHits: f.page.hits() - hits,
  };
}

function expectHostileRefused(o: Outcome) {
  expect(o.results.slice(0, 5).map((r) => [r.name, r.isError])).toEqual([
    ["Bash", true], ["Read", true], ["Read", true], ["Read", true], ["mcp__stub__record", true],
  ]);
  expect(o.leaked).toEqual([]);
  expect(o.bashRan).toBe(false);
  expect(o.mcpStarted).toBe(false);
  expect(o.mcpCalls).toBe(0);
}

/** One per-tool outcome row for the PR's table, printed only under `FENCE_ROWS=1`. */
function report(caller: string, connector: string, o: Outcome) {
  if (process.env.FENCE_ROWS !== "1") return;
  const cells = o.results.map((r, i) => `${i + 1}:${r.name}=${r.isError ? "refused" : "ran"}`);
  console.log(`FENCE-ROW | ${caller} | ${connector} | ${cells.join(" ")} | leaked=${o.leaked.length} mcpCalls=${o.mcpCalls} mcpStarted=${o.mcpStarted} pageHits=${o.pageHits}`);
}

async function waitForJob(jobId: string): Promise<void> {
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const s = getJob(jobId)?.status;
    if (s === "complete" || s === "error") return;
    await Bun.sleep(250);
  }
  throw new Error(`job ${jobId} did not settle`);
}

describe.skipIf(!cliReady && !sdkReady)("probe: one arm's markers never reach the next", () => {
  test("an arm whose Bash ran and whose MCP stub started leaves the next arm clean", async () => {
    const a = await probe([], async () => {
      writeFileSync(f.bashMarker, "ran\n");
      writeFileSync(f.mcpStartedPath, "");
    });
    const b = await probe([], async () => {});
    expect([a.bashRan, a.mcpStarted]).toEqual([true, true]);
    expect([b.bashRan, b.mcpStarted]).toEqual([false, false]);
  });
});

for (const connector of ["claude-cli", "claude-sdk"] as const) {
  const ready = connector === "claude-cli" ? cliReady : sdkReady;
  const needs = connector === "claude-cli" ? `claude CLI ≥${MIN_RESTRICTED_CLI_VERSION} and openssl` : "the bundled SDK binary and openssl";

  describe.skipIf(!ready)(`${connector}: real callers against the fake Messages API (skips without ${needs})`, () => {
    test("YouTube frame pass: only Read <frames>/x.jpg runs", async () => {
      const jobId = createJob(VIDEO_ID, "A talk", `https://www.youtube.com/watch?v=${VIDEO_ID}`);
      const framesDir = join(tmpRoot, `muninn-youtube-${jobId}`, "frames");
      const o = await probe(
        [...hostileFrom(framesDir, "frame-traversal.txt"), { name: "Read", input: { file_path: join(framesDir, "x.jpg") } }],
        () => summarizeVideo(jobId, VIDEO_ID, "A talk", captureConfig(), bot(connector), {
          frames: true,
          preset: STANDARD,
          deps: {
            probeVideoInfo: async () => ({ id: VIDEO_ID, title: "A talk", duration: 1200, uploader: "conf" }),
            fetchAuthor: async () => undefined,
            downloadVideo: async (_url, workDir) => {
              mkdirSync(workDir, { recursive: true });
              const videoPath = join(workDir, "video.mp4");
              writeFileSync(videoPath, "not really an mp4");
              return { videoPath, id: VIDEO_ID, title: "A talk", duration: 1200, uploader: "conf", canonicalUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}` };
            },
            extractFrames: async ({ outDir }) => {
              mkdirSync(outDir, { recursive: true });
              copyFileSync(join(f.allowedDir, "x.jpg"), join(outDir, "30.jpg"));
              copyFileSync(join(f.allowedDir, "x.jpg"), join(outDir, "x.jpg"));
              return [{ path: join(outDir, "30.jpg"), tSeconds: 30 }];
            },
            framesRoot: join(f.root, "capture-frames-root"),
            sourceDraft: false,
          },
        }),
      );
      report("youtube frame pass", connector, o);
      expectHostileRefused(o);
      expect(o.results[5]).toMatchObject({ name: "Read", isError: false });
      expect(o.results[5]!.text).toContain('"type":"image"');
    }, 180_000);

    test.skipIf(!Bun.which("ffmpeg"))("TikTok frame pass: the work dir beside the frames is refused, a frame is read", async () => {
      const jobId = tiktokState.createJob("7523456789", "A clip", "https://www.tiktok.com/@coolcoder/video/7523456789");
      const workDir = join(tmpRoot, `muninn-tiktok-${jobId}`);
      const framesDir = join(workDir, "frames");
      const o = await probe(
        [
          ...hostileFrom(framesDir, "frame-traversal.txt"),
          { name: "Read", input: { file_path: join(workDir, "video.mp4") } },
          { name: "Read", input: { file_path: join(workDir, "video.info.txt") } },
          { name: "Read", input: { file_path: join(framesDir, "frame_001.jpg") } },
        ],
        () => summarizeTikTok(jobId, "https://www.tiktok.com/@coolcoder/video/7523456789", "A clip", captureConfig(), bot(connector), {
          preset: STANDARD,
        }),
      );
      report("tiktok frame pass", connector, o);
      expectHostileRefused(o);
      expect(o.results.slice(5, 7).map((r) => [r.name, r.isError])).toEqual([["Read", true], ["Read", true]]);
      // The .mp4 is refused as binary whatever the surface (measured on the
      // pre-fix tree too); the text file beside it is what only the fence
      // refuses, and `leaked` above is its secret staying out.
      expect(o.results[7]).toMatchObject({ name: "Read", isError: false });
      expect(o.results[7]!.text).toContain('"type":"image"');
    }, 180_000);

    test("YouTube text-only capture: nothing runs", async () => {
      const jobId = createJob(VIDEO_ID, "A talk", `https://www.youtube.com/watch?v=${VIDEO_ID}`);
      const o = await probe(hostileFrom(f.allowedDir, "traversal.txt"), () =>
        summarizeVideo(jobId, VIDEO_ID, "A talk", captureConfig(), bot(connector), {
          preset: STANDARD,
          // A frames-off capture probes too (the description); never a real yt-dlp here.
          deps: { probeVideoInfo: async () => null, fetchAuthor: async () => undefined, sourceDraft: false },
        }),
      );
      report("youtube text-only", connector, o);
      expectHostileRefused(o);
    }, 180_000);

    test("/api/summaries/rerun over kept frames: only Read <kept>/x.jpg runs", async () => {
      const kept = join(framesRoot, "youtube", VIDEO_ID);
      const raw = [
        "---",
        'date: "2026-09-01"',
        `url: "https://www.youtube.com/watch?v=${VIDEO_ID}"`,
        'summary_kind: "standard"',
        'category: "ai/general"',
        'tags: "ai, general"',
        "---",
        "",
        "The stored summary.",
        "",
        "## Transcript",
        "",
        `### [00:00:00]\n\n${PROBE_MARKER} hello again.`,
        "",
      ].join("\n");
      const app = new Hono();
      registerSummariesRerunRoutes(app, captureConfig(), {
        fetchRawDoc: async () => ({ raw }),
        ingest: async () => ({ ok: true, status: 200, data: { file_path: DOC_ID } }),
        oneShot: (await import("../summaries/summarizer-shared.ts")).runCaptureOneShot,
        framesRoot,
        claims: new SummarySaveClaims(),
        bots: () => [bot(connector)],
      });
      const o = await probe(
        [...hostileFrom(kept, "kept-traversal.txt"), { name: "Read", input: { file_path: join(kept, "x.jpg") } }],
        async () => {
          const res = await app.request("/api/summaries/rerun", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ source: "youtube", docId: DOC_ID }),
          });
          const json = (await res.json()) as { job_id?: string; error?: string };
          expect(json.error).toBeUndefined();
          await waitForJob(json.job_id!);
        },
      );
      report("summaries rerun (kept frames)", connector, o);
      expectHostileRefused(o);
      expect(o.results[5]).toMatchObject({ name: "Read", isError: false });
    }, 180_000);

    test("fact-check verify pass: only WebFetch runs", async () => {
      if (connector === "claude-sdk") toolSurfaceTestSeam.allowWebHosts = ["127.0.0.1"];
      const app = new Hono();
      app.get("/fc", (c) =>
        streamFactcheckSSE(c, {
          config: driveConfig,
          botConfig: bot(connector),
          body: "The sky is blue.",
          meta: { title: "Sky", tags: [], type: "concept" },
          wikiName: "fencewiki",
          mode: "article",
          baseHash: "deadbeef",
        }),
      );
      let o: Outcome;
      try {
        o = await probe(
          [...hostileFrom(f.allowedDir, "traversal.txt"), { name: "WebFetch", input: { url: f.page.url, prompt: "Summarize the page." } }],
          async () => { await (await app.request("/fc")).text(); },
        );
      } finally {
        delete toolSurfaceTestSeam.allowWebHosts;
      }
      report("factcheck verify", connector, o);
      expectHostileRefused(o);
      expect(o.results[5]).toMatchObject({ name: "WebFetch", isError: false });
      expect(o.pageHits).toBe(1);
    }, 180_000);
  });
}
