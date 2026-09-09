/**
 * `buildVimeoUserPrompt`'s frame section, and the one axis a RE-RUN moves.
 *
 * `framesPromptSection` states the list's spacing — "one every ~N s of the
 * talk" — from the median gap between consecutive frames. That is true of a
 * CAPTURE, whose frames came off one sampler, and false of a re-run, whose list
 * is `listKeptFrames`: whatever the previous summary happened to QUOTE. Two
 * survivors 30 s and 900 s apart would tell the model the talk is sampled every
 * ~870 s — a number nothing measured, in a sentence the model then reasons from.
 *
 * The YouTube builder has the same opt-out and the same test; this is the Vimeo
 * half, which shipped unpinned. Both halves are checked separately here: that
 * `cadence: false` DROPS the clause, and that leaving it unset KEEPS it, so a
 * builder that ignored the flag and one that suppressed the clause for everyone
 * are two different failures.
 *
 * Every fixture is invented. This repo is public.
 */

import { describe, expect, test } from "bun:test";
import { buildVimeoUserPrompt } from "./prompt.ts";
import type { CaptureFrame } from "../summaries/frames.ts";

const VIDEO_ID = "1234567";
/** Two survivors, far apart — the shape a kept-frames listing really has. */
const FRAMES: CaptureFrame[] = [
  { path: "/nowhere/30.jpg", tSeconds: 30, note: "" },
  { path: "/nowhere/900.jpg", tSeconds: 900, note: "" },
];
const TRANSCRIPT = "### [00:00:00]\n\nAn invented opening line.";

describe("buildVimeoUserPrompt frame cadence", () => {
  test("a CAPTURE's list states its spacing", () => {
    const prompt = buildVimeoUserPrompt(TRANSCRIPT, { videoId: VIDEO_ID, frames: FRAMES });
    expect(prompt).toContain("one every ~");
    expect(prompt).toContain("Slide frames");
  });

  test("`cadence: false` drops the spacing clause and keeps everything else", () => {
    const capture = buildVimeoUserPrompt(TRANSCRIPT, { videoId: VIDEO_ID, frames: FRAMES });
    const rerun = buildVimeoUserPrompt(TRANSCRIPT, { videoId: VIDEO_ID, frames: FRAMES, cadence: false });
    expect(rerun).not.toContain("one every ~");
    // The section is still THERE — this is an opt-out, not a lost frame list.
    expect(rerun).toContain("Slide frames (read EVERY image");
    expect(rerun).toContain("30.jpg");
    expect(rerun).toContain("900.jpg");
    expect(rerun).toContain(TRANSCRIPT);
    // And the ONLY difference is the clause: removing it from the capture's own
    // prompt yields the re-run's, byte for byte. A builder that changed
    // anything else while dropping the clause fails here rather than passing on
    // a `not.toContain`.
    expect(capture.replace(/, one every ~\d+ s of the talk/, "")).toBe(rerun);
  });

  test("`cadence: true` is the capture's answer, so only `false` opts out", () => {
    expect(buildVimeoUserPrompt(TRANSCRIPT, { videoId: VIDEO_ID, frames: FRAMES, cadence: true })).toContain(
      "one every ~",
    );
  });

  test("a transcript-only pass has no frame section at all, cadence flag or not", () => {
    for (const cadence of [undefined, false, true]) {
      const prompt = buildVimeoUserPrompt(TRANSCRIPT, {
        videoId: VIDEO_ID,
        frames: [],
        ...(cadence === undefined ? {} : { cadence }),
      });
      expect(prompt).toBe(TRANSCRIPT);
    }
  });
});
