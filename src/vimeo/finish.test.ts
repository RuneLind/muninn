/**
 * The Vimeo post-model tail, driven OUTSIDE a capture job — how PR 3's re-run
 * will call it.
 *
 * The case that matters most is the NEGATIVE one: this vertical runs no
 * enforcement pass, so a summary quoting a second that was never extracted keeps
 * its (broken) reference and simply copies nothing. That is today's behaviour and
 * the re-run must not quietly acquire the YouTube pass instead.
 */

import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finishVimeoSummary } from "./finish.ts";
import type { CaptureFrame } from "../summaries/frames.ts";

const VIDEO_ID = "1223358361";
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tmpRoot(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}

function frames(seconds: readonly number[]): CaptureFrame[] {
  const dir = join(tmpRoot("vimeo-finish-work-"), "frames");
  mkdirSync(dir, { recursive: true });
  return seconds.map((t) => {
    const path = join(dir, `${t}.jpg`);
    writeFileSync(path, `jpeg-${t}`);
    return { path, tSeconds: t };
  });
}

function quote(sec: number): string {
  return `![Slide at 00:00:${sec}](/api/frames/vimeo/${VIDEO_ID}/${sec}.jpg)`;
}

describe("finishVimeoSummary", () => {
  test("parses the envelope and tells the caller the category once", async () => {
    const seen: string[] = [];
    const out = await finishVimeoSummary({
      raw: "CATEGORY: ai/rag\n\nSUMMARY:\n### Heading\n- point",
      jobId: "v1",
      videoId: VIDEO_ID,
      frames: [],
      framesRoot: tmpRoot("vimeo-finish-root-"),
      onCategory: (c) => seen.push(c),
    });
    expect(out.category).toBe("ai/rag");
    expect(out.summary).toBe("### Heading\n- point");
    expect(seen).toEqual(["ai/rag"]);
  });

  test("copies exactly the frames the summary quotes, and nothing else", async () => {
    const root = tmpRoot("vimeo-finish-root-");
    const out = await finishVimeoSummary({
      raw: `CATEGORY: ai/rag\n\nSUMMARY:\n${quote(30)}`,
      jobId: "v2",
      videoId: VIDEO_ID,
      frames: frames([10, 30, 50]),
      framesRoot: root,
    });
    expect(out.kept).toEqual([30]);
    expect(readdirSync(join(root, "vimeo", VIDEO_ID))).toEqual(["30.jpg"]);
  });

  test("NO enforcement pass: an invented quote is kept in the text and copies nothing", async () => {
    const root = tmpRoot("vimeo-finish-root-");
    const out = await finishVimeoSummary({
      raw: `CATEGORY: ai/rag\n\nSUMMARY:\n${quote(30)}\n\n${quote(99)}`,
      jobId: "v3",
      videoId: VIDEO_ID,
      frames: frames([30]),
      framesRoot: root,
    });
    expect(out.kept).toEqual([30]);
    // The YouTube tail would have removed this line. This one does not — the
    // difference is the property, and the re-run inherits it.
    expect(out.summary).toContain(`/${VIDEO_ID}/99.jpg`);
    expect(readdirSync(join(root, "vimeo", VIDEO_ID))).toEqual(["30.jpg"]);
  });

  test("a transcript-only summary copies nothing and creates no directory", async () => {
    const root = tmpRoot("vimeo-finish-root-");
    const out = await finishVimeoSummary({
      raw: "CATEGORY: ai/rag\n\nSUMMARY:\nno pictures here",
      jobId: "v4",
      videoId: VIDEO_ID,
      frames: [],
      framesRoot: root,
    });
    expect(out.kept).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
  });
});
