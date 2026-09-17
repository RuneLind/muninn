/**
 * The shared bounded spawn helper.
 *
 * It was `src/video/media.ts`'s private one until the wiki Stamp route needed
 * it: a route in the wiki group must not import the capture-vertical graph
 * (yt-dlp, whisper, ffmpeg) to spawn one CLI. The hoist adds an `env` option,
 * which is what these cases are about — `{ ...process.env, X }`, never a bare
 * `{ X }`, since a replaced environment drops `PATH` and every spawn then fails
 * with an empty stderr.
 */

import { describe, expect, test } from "bun:test";
import { runProc } from "./run-proc.ts";

describe("runProc", () => {
  test("captures stdout, stderr and the exit code", async () => {
    const r = await runProc(
      ["bash", "-c", "echo out; echo err >&2; exit 3"],
      5_000,
      "test",
    );
    expect(r.stdout.trim()).toBe("out");
    expect(r.stderr.trim()).toBe("err");
    expect(r.exitCode).toBe(3);
  });

  test("with no env option the child inherits this process's environment", async () => {
    const r = await runProc(["bash", "-c", "echo \"${PATH:-missing}\""], 5_000, "test");
    expect(r.stdout.trim()).not.toBe("");
    expect(r.stdout.trim()).not.toBe("missing");
  });

  test("an env option REPLACES the child environment, so a caller must spread process.env", async () => {
    // The trap the Stamp route's `{ ...process.env, WIKI_STAMP_ROOTS }` exists
    // for. `HOME`, not `PATH`: bash substitutes a default PATH of its own when
    // none is inherited, so PATH cannot tell a replaced environment from an
    // inherited one — which is exactly the shape that makes this trap silent.
    const probe = "echo \"HOME=${HOME:-missing} ROOTS=${WIKI_STAMP_ROOTS:-missing}\"";
    const bare = await runProc(["/bin/bash", "-c", probe], 5_000, "test", {
      env: { WIKI_STAMP_ROOTS: "/tmp/roots" },
    });
    expect(bare.stdout).toContain("HOME=missing");
    expect(bare.stdout).toContain("ROOTS=/tmp/roots");

    const spread = await runProc(["/bin/bash", "-c", probe], 5_000, "test", {
      env: { ...process.env, WIKI_STAMP_ROOTS: "/tmp/roots" },
    });
    expect(spread.stdout).not.toContain("HOME=missing");
    expect(spread.stdout).toContain("ROOTS=/tmp/roots");
  });

  test("rejects past the timeout", async () => {
    await expect(runProc(["bash", "-c", "sleep 5"], 120, "slow")).rejects.toThrow(
      /timed out after 120ms/,
    );
  });
});
