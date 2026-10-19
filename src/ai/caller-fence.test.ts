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

async function probe(plan: ScriptedToolUse[], run: () => Promise<unknown>): Promise<Outcome> {
  f.api.setPlan(plan);
  rmSync(f.mcpStartedPath, { force: true });
  const hits = f.page.hits();
  const calls = f.mcpCalls();
  await run();
  const results = f.api.toolResults();
  const secrets = [...f.secrets, FRAME_SECRET, KEPT_SECRET];
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

/** One per-tool outcome row, printed for the PR's table. */
function report(caller: string, connector: string, o: Outcome) {
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

    test("YouTube text-only capture: nothing runs", async () => {
      const jobId = createJob(VIDEO_ID, "A talk", `https://www.youtube.com/watch?v=${VIDEO_ID}`);
      const o = await probe(hostileFrom(f.allowedDir, "traversal.txt"), () =>
        summarizeVideo(jobId, VIDEO_ID, "A talk", captureConfig(), bot(connector), {
          preset: STANDARD,
          deps: { fetchAuthor: async () => undefined, sourceDraft: false },
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
