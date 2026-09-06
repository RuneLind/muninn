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
  TRANSCRIPT_TRUNCATION_NOTE,
  YOUTUBE_TRANSCRIPT_MAX_BYTES,
  appendTranscriptSection,
  capTranscriptWindows,
  decideYouTubeFrames,
  transcriptUrl,
  youtubeDownloadTimeoutFor,
  youtubeWatchUrl,
  type YouTubeFramesReason,
} from "./frames.ts";

/** The one thing this module measures in: UTF-8 bytes. */
const bytesOf = (s: string): number => new TextEncoder().encode(s).length;

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
    // One assertion over the whole table rather than one per row: a mismatch
    // prints the differing INDEX, which names the row, and neither side carries
    // a copy of the input to make the pair look like a wider comparison than it
    // is.
    const got = rows.map(([input]) => {
      const d = decideYouTubeFrames(input);
      return [d.frames, d.reason];
    });
    expect(got).toEqual(rows.map(([, frames, reason]) => [frames, reason]));
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

  test("the whole selector, pinned — H.264 first, then any ≤720 mp4, then any ≤720 rendition", () => {
    // Pinned as a STRING because the first tier is the fix: measured on
    // `SkVqJ1SGeL0`, `bv[height<=720][ext=mp4]` resolved to format 398 (av01)
    // on a video that also offered 136 (avc1) — mp4 is a container, not a
    // codec, and every ffmpeg seek then paid for an AV1 decode.
    expect(YOUTUBE_FRAME_FORMAT_SELECTOR).toBe(
      "bv[height<=720][ext=mp4][vcodec^=avc1]/bv[height<=720][ext=mp4]/bv[height<=720]",
    );
  });

  test("every tier is VIDEO-ONLY and capped at the frame height", () => {
    // The whole point of the selector: the transcript comes from huginn, so a
    // muxed tier would download an audio track to throw it away — and an
    // uncapped one would pull 1080p only to scale it to 720.
    expect(tiers.length).toBeGreaterThan(0);
    for (const tier of tiers) {
      expect(tier.startsWith("bv")).toBe(true);
      expect(tier).toContain("[height<=720]");
    }
  });

  test("mp4 is preferred, H.264 is asked for FIRST, and there is NO uncapped tail", () => {
    expect(tiers[0]).toContain("[ext=mp4]");
    expect(tiers[0]).toContain("[vcodec^=avc1]");
    // The codec is a PREFERENCE, not a requirement: the tiers below it drop it
    // again, so an upload with no H.264 rendition still gets frames.
    expect(tiers.slice(1).some((t) => t.includes("vcodec"))).toBe(false);
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
    expect(capTranscriptWindows(t)).toEqual({
      text: t,
      truncated: false,
      inputBytes: bytesOf(t),
      keptBytes: bytesOf(t),
    });
  });

  test("the note's bytes come OUT of the budget — the result never exceeds maxBytes", () => {
    // The note is part of what is returned, so a budget that ignores it hands
    // the caller a string over the cap it asked for. huginn's own transcript
    // bound is what this defends, so "a bit over" is not a rounding error.
    for (const cap of [200, 400, 1000, 4096]) {
      const out = capTranscriptWindows(windows(50, 100), cap);
      expect([cap, out.truncated, bytesOf(out.text) <= cap]).toEqual([cap, true, true]);
      expect(out.keptBytes).toBe(bytesOf(out.text));
    }
  });

  test("a FIRST window bigger than the cap keeps a head of it — never the note alone", () => {
    // The window boundary is the preferred cut, but a transcript huginn
    // windowed at 120 s can still open with one window over the budget, and
    // returning only the truncation note tells the reader nothing at all.
    const t = `### [00:00:00]\n${Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n")}`;
    expect(t.includes("\n\n")).toBe(false);
    const { text, truncated } = capTranscriptWindows(t, 400);

    expect(truncated).toBe(true);
    expect(bytesOf(text)).toBeLessThanOrEqual(400);
    expect(text).toContain("### [00:00:00]");
    expect(text).toContain("line 0");
    expect(text).toContain("transcript truncated");
    // The head is a PREFIX of the transcript, cut at a line boundary: every
    // line that survives is a whole line of the talk.
    const head = text.slice(0, text.indexOf("\n\n_("));
    expect(t.startsWith(head)).toBe(true);
    expect(t[head.length]).toBe("\n");
  });

  test("the head cut is byte-safe: a multi-byte code point is never split", () => {
    // The cut is measured in bytes and `あ` is three of them, so a naive slice
    // lands mid-character and decodes to U+FFFD in the stored document.
    //
    // The budget is COMPUTED to land inside a character rather than guessed: the
    // heading line is 15 bytes, each body line is 21 + 1, and the note plus its
    // separator comes off the top — so a head budget of 15 + 3×22 + 1 puts the
    // byte cut one byte into the fourth line's first `あ`. Guessed, an earlier
    // spelling of this fixture happened to cut on a boundary and survived the
    // mutation that removes the guard.
    const t = `### [00:00:00]\n${Array.from({ length: 60 }, () => "あ".repeat(7)).join("\n")}`;
    const headBudget = 15 + 3 * 22 + 1;
    const cap = bytesOf(TRANSCRIPT_TRUNCATION_NOTE) + 2 + headBudget;
    const { text } = capTranscriptWindows(t, cap);

    expect(bytesOf(text)).toBeLessThanOrEqual(cap);
    expect(text).not.toContain("�");
    // Whole lines only: the partial fourth line is gone, the three before it stay.
    const body = text.slice(0, text.indexOf("\n\n_("));
    expect(body).toBe(`### [00:00:00]\n${"あ".repeat(7)}\n${"あ".repeat(7)}\n${"あ".repeat(7)}`);
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

  test("the byte counts are the two a caller reports — the input's and what survived", () => {
    // `truncated` is the flag; these are what makes the summarizer's warn worth
    // reading (how much of the talk did not reach the document).
    const t = windows(50, 100);
    const out = capTranscriptWindows(t, 1000);
    expect(out.inputBytes).toBe(bytesOf(t));
    expect(out.keptBytes).toBeLessThan(out.inputBytes);
  });
});

describe("appendTranscriptSection", () => {
  test("the transcript lands under a level-2 `## Transcript` heading", () => {
    // Level 2 and that exact spelling, because the /summaries article view's
    // `splitTranscript` folds the tail on it and huginn's heading splitter cuts
    // the section on the `###` windows inside it.
    const out = appendTranscriptSection("SUMMARY BODY\n", "### [00:00:00]\nhello");
    expect(out.text).toBe("SUMMARY BODY\n\n## Transcript\n\n### [00:00:00]\nhello\n");
    expect(out.truncated).toBe(false);
  });

  test("it never mutates the summary it was handed", () => {
    const summary = "### Heading\n- point";
    const out = appendTranscriptSection(summary, "### [00:00:00]\nhello");
    expect(out.text.startsWith(summary)).toBe(true);
    expect(out.text.slice(summary.length)).toBe("\n\n## Transcript\n\n### [00:00:00]\nhello\n");
  });

  test("an over-cap transcript is capped on the way in, and SAYS it was", () => {
    const long = Array.from({ length: 200_000 }, (_, i) => `### [00:00:00]\nline ${i}`).join("\n\n");
    expect(bytesOf(long)).toBeGreaterThan(YOUTUBE_TRANSCRIPT_MAX_BYTES);
    const out = appendTranscriptSection("S", long);
    expect(bytesOf(out.text)).toBeLessThanOrEqual(YOUTUBE_TRANSCRIPT_MAX_BYTES + 200);
    expect(out.text).toContain("transcript truncated");
    // The flag and the counts are what the summarizer logs — without them the
    // truncation is invisible to everyone but a reader of the stored document.
    expect(out.truncated).toBe(true);
    expect(out.inputBytes).toBe(bytesOf(long));
    expect(out.keptBytes).toBeLessThan(out.inputBytes);
  });
});
