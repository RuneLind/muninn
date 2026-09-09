/**
 * The Vimeo post-model tail, driven OUTSIDE a capture job — how PR 3's re-run
 * will call it.
 *
 * The case that matters most is the NEGATIVE one: this vertical runs no
 * enforcement pass, so a summary quoting a second that was never extracted keeps
 * its (broken) reference and simply copies nothing. That is today's behaviour and
 * the re-run must not quietly acquire the YouTube pass instead.
 */

import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { configure, reset as resetLogging, type LogRecord } from "@logtape/logtape";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finishVimeoSummary } from "./finish.ts";
import type { CaptureFrame } from "../summaries/frames.ts";

const VIDEO_ID = "1223358361";
const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  await resetLogging();
});

/** Per test with `reset: true` — the `src/tiktok/finish.test.ts` shape. */
let logs: LogRecord[] = [];
beforeEach(async () => {
  logs = [];
  await configure({
    sinks: { capture: (r: LogRecord) => logs.push(r) },
    loggers: [
      { category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" },
      { category: ["logtape", "meta"], sinks: [], lowestLevel: "error" },
    ],
    reset: true,
  });
});

/** Every record this TAIL wrote — not the frames seam's, which has its own category. */
function tailLogs(): LogRecord[] {
  return logs.filter((r) => r.category[1] === "vimeo");
}

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

  test("the category is announced BEFORE the frame copy, not after it", async () => {
    // The ORDER is the property: the live card is told while the copies are
    // still pending, exactly as it was when this tail was inline. The injected
    // root starts empty, so what the callback sees IS the answer — a callback
    // moved below `await keepReferencedFrames` would see the copied file.
    const root = tmpRoot("vimeo-finish-root-");
    // An ARRAY of snapshots, not one: it pins that the callback fired exactly
    // once as well as what it saw.
    const rootAtCategory: string[][] = [];
    const out = await finishVimeoSummary({
      raw: `CATEGORY: ai/rag\n\nSUMMARY:\n${quote(30)}`,
      jobId: "v5",
      videoId: VIDEO_ID,
      frames: frames([30]),
      framesRoot: root,
      onCategory: () => {
        rootAtCategory.push(readdirSync(root));
      },
    });
    expect(rootAtCategory).toEqual([[]]);
    // …and the copy really did land afterwards, so the emptiness above is an
    // ordering fact and not a run that copied nothing.
    expect(out.kept).toEqual([30]);
    expect(readdirSync(root)).toEqual(["vimeo"]);
    expect(readdirSync(join(root, "vimeo", VIDEO_ID))).toEqual(["30.jpg"]);
  });

  test("a copy failure does not fail the capture: the text comes back whole, with a log line", async () => {
    // A regular FILE where the served root should be: `mkdir` inside the copy
    // fails with ENOTDIR, so the whole seam throws rather than one file failing.
    // This vertical has no repair pass, so the reference SURVIVES (broken
    // images, a log line) — which is exactly the shape a re-run must inherit.
    const rootFile = join(tmpRoot("vimeo-finish-root-"), "not-a-dir");
    writeFileSync(rootFile, "not a directory");
    const out = await finishVimeoSummary({
      raw: `CATEGORY: ai/rag\n\nSUMMARY:\n${quote(30)}`,
      jobId: "v6",
      videoId: VIDEO_ID,
      frames: frames([30]),
      framesRoot: rootFile,
    });
    expect(out.category).toBe("ai/rag");
    expect(out.kept).toEqual([]);
    expect(out.summary).toContain(`/${VIDEO_ID}/30.jpg`);
    expect(
      tailLogs().some(
        (r) => r.level === "error" && String(r.message).includes("keeping quoted frames failed"),
      ),
    ).toBe(true);
  });

  test("the tail logs under the VERTICAL's category, `muninn.vimeo.summarizer`", async () => {
    // The searchable field, not the file name: the JSONL sink is queried by
    // category, and moving this code into `finish.ts` must not move the records
    // a saved query already selects.
    const rootFile = join(tmpRoot("vimeo-finish-root-"), "not-a-dir");
    writeFileSync(rootFile, "not a directory");
    await finishVimeoSummary({
      raw: `CATEGORY: ai/rag\n\nSUMMARY:\n${quote(30)}`,
      jobId: "v7",
      videoId: VIDEO_ID,
      frames: frames([30]),
      framesRoot: rootFile,
    });
    const err = tailLogs().find((r) => String(r.message).includes("keeping quoted frames failed"));
    expect(err).toBeDefined();
    expect(err!.category).toEqual(["muninn", "vimeo", "summarizer"]);
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
