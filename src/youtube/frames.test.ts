/**
 * The YouTube frames path's pure half — every decision the capture makes before
 * it spends a download, an ffmpeg pass or a model turn.
 *
 * No `mock.module`, no I/O, no yt-dlp: `src/youtube/frames.ts` imports nothing,
 * which is why this file runs in the shared chunk beside `state.test.ts`.
 */
import { test, expect, describe } from "bun:test";
import {
  YOUTUBE_FRAMES_MAX_DURATION_SEC,
  YOUTUBE_FRAMES_MIN_DURATION_SEC,
  YOUTUBE_FRAME_FORMAT_SELECTOR,
  YOUTUBE_FRAME_HEIGHT,
  YOUTUBE_TRANSCRIPT_MAX_BYTES,
  appendTranscriptSection,
  capTranscriptWindows,
  decideYouTubeFrames,
  transcriptUrl,
  youtubeDownloadTimeoutFor,
  youtubeWatchUrl,
  type YouTubeFramesReason,
} from "./frames.ts";

describe("decideYouTubeFrames", () => {
  const on = { framesRequested: true, supportsExtraDirs: true };

  test("the whole decision as a table, one row per reachable answer", () => {
    const rows: Array<[Parameters<typeof decideYouTubeFrames>[0], boolean, YouTubeFramesReason]> = [
      [{ framesRequested: false, supportsExtraDirs: true, durationSec: 1200 }, false, "off"],
      // Even with everything else right, the reader not asking wins first — a
      // frames-off capture must never probe.
      [{ framesRequested: false, supportsExtraDirs: false, durationSec: null }, false, "off"],
      [{ ...on, supportsExtraDirs: false, durationSec: 1200 }, false, "unsupported"],
      // The route pre-flights the connector, so `unsupported` outranks every
      // duration answer: a job that got here on a file-blind connector must be
      // reported as that, not as a short video.
      [{ ...on, supportsExtraDirs: false, durationSec: 5 }, false, "unsupported"],
      [{ ...on, durationSec: null }, false, "duration_unknown"],
      // `parseYtDlpJson` maps a MISSING duration to 0 — a live stream. It must
      // not fall under the "too short" cut by accident.
      [{ ...on, durationSec: 0 }, false, "duration_unknown"],
      [{ ...on, durationSec: -1 }, false, "duration_unknown"],
      [{ ...on, durationSec: Number.NaN }, false, "duration_unknown"],
      [{ ...on, durationSec: Number.POSITIVE_INFINITY }, false, "duration_unknown"],
      [{ ...on, durationSec: 59 }, false, "too_short"],
      [{ ...on, durationSec: YOUTUBE_FRAMES_MIN_DURATION_SEC }, true, "on"],
      [{ ...on, durationSec: 1200 }, true, "on"],
      [{ ...on, durationSec: YOUTUBE_FRAMES_MAX_DURATION_SEC }, true, "on"],
      [{ ...on, durationSec: YOUTUBE_FRAMES_MAX_DURATION_SEC + 1 }, false, "too_long"],
    ];
    for (const [input, frames, reason] of rows) {
      const got = decideYouTubeFrames(input);
      expect([input.durationSec, got.frames, got.reason]).toEqual([input.durationSec, frames, reason]);
    }
  });

  test("the cuts are on DURATION, both inclusive at the floor and at the cap", () => {
    // Named separately from the table because these two are the boundary the
    // constants promise, and a table row reads as one case among many.
    expect(decideYouTubeFrames({ ...on, durationSec: 60 }).frames).toBe(true);
    expect(decideYouTubeFrames({ ...on, durationSec: 59.9 }).frames).toBe(false);
    expect(decideYouTubeFrames({ ...on, durationSec: 10_800 }).frames).toBe(true);
    expect(decideYouTubeFrames({ ...on, durationSec: 10_800.1 }).frames).toBe(false);
  });
});

describe("the yt-dlp target and the transcript URL", () => {
  test("the watch URL is built from the id alone, never from a caller's url", () => {
    expect(youtubeWatchUrl("dQw4w9WgXcQ")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  test("?timestamps=1 rides ONLY the frames path, and is never sent blank", () => {
    // huginn answers 422 for an empty value, so "always append the param and
    // let the value decide" is not an option.
    expect(transcriptUrl("http://h", "dQw4w9WgXcQ", false)).toBe("http://h/api/youtube/transcript/dQw4w9WgXcQ");
    expect(transcriptUrl("http://h", "dQw4w9WgXcQ", true)).toBe(
      "http://h/api/youtube/transcript/dQw4w9WgXcQ?timestamps=1",
    );
  });
});

describe("YOUTUBE_FRAME_FORMAT_SELECTOR", () => {
  const tiers = YOUTUBE_FRAME_FORMAT_SELECTOR.split("/");

  test("every tier is VIDEO-ONLY and capped at the frame height", () => {
    // The whole point of the selector: the transcript comes from huginn, so a
    // muxed tier would download an audio track to throw it away — and an
    // uncapped one would pull 1080p only to scale it to 720.
    expect(tiers.length).toBeGreaterThan(0);
    for (const tier of tiers) {
      expect(tier.startsWith("bv")).toBe(true);
      expect(tier).toContain(`[height<=${YOUTUBE_FRAME_HEIGHT}]`);
    }
  });

  test("mp4 is preferred and there is NO uncapped tail", () => {
    expect(tiers[0]).toContain("[ext=mp4]");
    expect(tiers.some((t) => t === "b" || t === "bv" || t === "bv*+ba")).toBe(false);
  });
});

describe("youtubeDownloadTimeoutFor", () => {
  test("floor 5 min, 0.3 s per second of video, ceiling 30 min", () => {
    expect(youtubeDownloadTimeoutFor(60)).toBe(300_000);
    expect(youtubeDownloadTimeoutFor(1200)).toBe(360_000);
    expect(youtubeDownloadTimeoutFor(3600)).toBe(1_080_000);
    expect(youtubeDownloadTimeoutFor(10_800)).toBe(1_800_000);
  });

  test("a nonsense duration still yields the floor, never 0 or NaN", () => {
    // yt-dlp's duration is third-party input and this bounds a spawn: a 0 here
    // would be "no timeout at all" to a caller that passes it straight on.
    expect(youtubeDownloadTimeoutFor(0)).toBe(300_000);
    expect(youtubeDownloadTimeoutFor(-5)).toBe(300_000);
  });
});

describe("capTranscriptWindows", () => {
  /** `n` windows of `### [HH:MM:SS]` + a padded body, the huginn #129 shape. */
  function windows(n: number, bodyBytes: number): string {
    return Array.from({ length: n }, (_, i) => {
      const t = i * 120;
      const hh = String(Math.floor(t / 3600)).padStart(2, "0");
      const mm = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
      const ss = String(t % 60).padStart(2, "0");
      return `### [${hh}:${mm}:${ss}]\n${"x".repeat(bodyBytes)}`;
    }).join("\n\n");
  }

  test("a transcript under the cap is returned byte-identical", () => {
    const t = windows(5, 100);
    expect(capTranscriptWindows(t)).toEqual({ text: t, truncated: false });
  });

  test("an over-cap transcript is cut at a WINDOW boundary, never mid-window", () => {
    const t = windows(20, 100);
    const { text, truncated } = capTranscriptWindows(t, 400);
    expect(truncated).toBe(true);
    // Every surviving window is whole: each kept block still opens on its
    // heading and carries the full body it was built with. A byte cut would
    // leave a heading over half a line, and huginn's heading splitter would
    // carry that timestamp into a chunk that ends mid-word.
    const kept = text.split("\n\n").filter((w) => w.startsWith("### ["));
    expect(kept.length).toBeGreaterThan(0);
    for (const w of kept) expect(w).toMatch(/^### \[\d{2}:\d{2}:\d{2}\]\nx{100}$/);
    // and every kept window is a PREFIX of the original, in order
    expect(t.startsWith(kept.join("\n\n"))).toBe(true);
  });

  test("a truncated transcript SAYS so, in the text a reader will see", () => {
    const { text } = capTranscriptWindows(windows(20, 100), 400);
    expect(text).toContain("transcript truncated");
    expect(text.trimEnd().endsWith("_")).toBe(true);
  });

  test("the cap is measured in BYTES, not characters", () => {
    // Two windows whose bodies are 3-byte code points each: a character count
    // would fit both under a 40-"char" cap, the byte count fits neither whole.
    const t = `### [00:00:00]\n${"あ".repeat(20)}\n\n### [00:02:00]\n${"あ".repeat(20)}`;
    expect(t.length).toBeLessThan(90);
    expect(new TextEncoder().encode(t).length).toBeGreaterThan(120);
    expect(capTranscriptWindows(t, 90).truncated).toBe(true);
  });

  test("the default cap is huginn's own transcript bound", () => {
    expect(YOUTUBE_TRANSCRIPT_MAX_BYTES).toBe(2 * 1024 * 1024);
    const small = windows(3, 10);
    expect(capTranscriptWindows(small).text).toBe(small);
  });
});

describe("appendTranscriptSection", () => {
  test("the transcript lands under a level-2 `## Transcript` heading", () => {
    // Level 2 and that exact spelling, because the /summaries article view's
    // `splitTranscript` folds the tail on it and huginn's heading splitter cuts
    // the section on the `###` windows inside it.
    const out = appendTranscriptSection("SUMMARY BODY\n", "### [00:00:00]\nhello");
    expect(out).toBe("SUMMARY BODY\n\n## Transcript\n\n### [00:00:00]\nhello\n");
  });

  test("it never mutates the summary it was handed", () => {
    const summary = "### Heading\n- point";
    const out = appendTranscriptSection(summary, "### [00:00:00]\nhello");
    expect(out.startsWith(summary)).toBe(true);
    expect(out.slice(summary.length)).toBe("\n\n## Transcript\n\n### [00:00:00]\nhello\n");
  });

  test("an over-cap transcript is capped on the way in", () => {
    const long = Array.from({ length: 200_000 }, (_, i) => `### [00:00:00]\nline ${i}`).join("\n\n");
    expect(new TextEncoder().encode(long).length).toBeGreaterThan(YOUTUBE_TRANSCRIPT_MAX_BYTES);
    const out = appendTranscriptSection("S", long);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(YOUTUBE_TRANSCRIPT_MAX_BYTES + 200);
    expect(out).toContain("transcript truncated");
  });
});
