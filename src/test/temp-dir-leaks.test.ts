import { test, expect, describe } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Test files that create temp dirs remove them again.
 *
 * Each file runs in its own `bun test` with TMPDIR pointed at an empty probe
 * dir; whatever is left in the probe afterwards leaked. Before this guard,
 * these four left ~18 `muninn-popup-` dirs plus one each of the others per
 * run, and a dev machine had collected 2,000+ of them.
 */

const ROOT = join(import.meta.dir, "..", "..");

const FILES = [
  "src/youtube/popup-settle.test.ts",
  "src/dashboard/routes/summaries-export.test.ts",
  "src/vimeo/summarizer.test.ts",
  "src/summaries/huginn-filename.test.ts",
];

describe("temp dir leaks", () => {
  for (const file of FILES) {
    test(`${file} leaves nothing under TMPDIR`, () => {
      const probe = mkdtempSync(join(tmpdir(), "muninn-leak-probe-"));
      try {
        const run = Bun.spawnSync([process.execPath, "test", file], {
          cwd: ROOT,
          env: { ...process.env, TMPDIR: probe },
          stdout: "pipe",
          stderr: "pipe",
        });
        if (run.exitCode !== 0) throw new Error(`${file} failed:\n${run.stderr.toString().slice(-2000)}`);
        expect(readdirSync(probe)).toEqual([]);
      } finally {
        rmSync(probe, { recursive: true, force: true });
      }
    }, 120_000);
  }
});
