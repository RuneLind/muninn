import { afterAll, describe, expect, test, beforeEach } from "bun:test";
import { configure, reset, type LogRecord } from "@logtape/logtape";
import {
  YOUTUBE_PROBE_TEMPLATE,
  parseYouTubeProbe,
  probeYouTubeVideo,
  resetMissingYtDlpWarning,
  youtubeProbeArgs,
} from "./probe.ts";
import type { ProcResult } from "../utils/run-proc.ts";

const URL_ = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const LINE = JSON.stringify({
  id: "dQw4w9WgXcQ",
  title: "A talk",
  duration: 61.5,
  uploader: "Sample Channel",
  webpage_url: URL_,
  upload_date: "20260101",
  description: "SOURCES\n• A: https://a.example/1",
});

const warnings: string[] = [];
beforeEach(async () => {
  warnings.length = 0;
  resetMissingYtDlpWarning();
  await reset();
  await configure({
    sinks: {
      mem: (r: LogRecord) => {
        if (r.level === "warning") warnings.push(r.message.map(String).join(""));
      },
    },
    loggers: [
      { category: ["muninn", "youtube", "probe"], lowestLevel: "debug", sinks: ["mem"] },
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
    ],
  });
});

afterAll(async () => {
  await reset();
});

const answering = (result: ProcResult) => async () => result;

describe("the template and the parse", () => {
  test("ONE probe: the six shared fields plus description, metadata-only", () => {
    expect(YOUTUBE_PROBE_TEMPLATE).toBe("%(.{id,title,duration,uploader,webpage_url,upload_date,description})j");
    expect(youtubeProbeArgs(URL_)).toEqual([
      "yt-dlp",
      "--ignore-config",
      "--no-plugin-dirs",
      "-O",
      YOUTUBE_PROBE_TEMPLATE,
      "--skip-download",
      "--no-playlist",
      URL_,
    ]);
  });

  test("parses the shared fields and the description", () => {
    expect(parseYouTubeProbe(LINE)).toEqual({
      id: "dQw4w9WgXcQ",
      title: "A talk",
      duration: 61.5,
      uploader: "Sample Channel",
      webpageUrl: URL_,
      uploadDate: "20260101",
      description: "SOURCES\n• A: https://a.example/1",
    });
  });

  test("a missing, null or blank description is absent", () => {
    for (const description of [undefined, null, "", "  \n"]) {
      const parsed = parseYouTubeProbe(JSON.stringify({ id: "x", description }));
      expect(parsed).not.toBeNull();
      expect(parsed).not.toHaveProperty("description");
    }
    expect(parseYouTubeProbe("not json")).toBeNull();
  });
});

describe("the probe call", () => {
  test("answers the parsed line, and hands the timeout through", async () => {
    let seen: number | undefined;
    const out = await probeYouTubeVideo(URL_, {
      timeoutMs: 10_000,
      run: async (_cmd, timeoutMs) => {
        seen = timeoutMs;
        return { stdout: `WARNING: noise\n${LINE}\n`, stderr: "", exitCode: 0 };
      },
    });
    expect(seen).toBe(10_000);
    expect(out?.description).toContain("https://a.example/1");
  });

  test("a failed probe is null with a warn — today's capture", async () => {
    expect(await probeYouTubeVideo(URL_, { run: answering({ stdout: "", stderr: "ERROR: private", exitCode: 1 }) })).toBeNull();
    expect(await probeYouTubeVideo(URL_, { run: answering({ stdout: "nothing", stderr: "", exitCode: 0 }) })).toBeNull();
    expect(await probeYouTubeVideo(URL_, { run: async () => { throw new Error("timed out"); } })).toBeNull();
    expect(warnings).toHaveLength(3);
  });

  test("a missing yt-dlp (ENOENT) warns ONCE per process, then degrades silently", async () => {
    const missing = async (): Promise<ProcResult> => {
      throw Object.assign(new Error('Executable not found in $PATH: "yt-dlp"'), { code: "ENOENT" });
    };
    expect(await probeYouTubeVideo(URL_, { run: missing })).toBeNull();
    expect(await probeYouTubeVideo(URL_, { run: missing })).toBeNull();
    expect(await probeYouTubeVideo(URL_, { run: missing })).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not on PATH");
  });
});
