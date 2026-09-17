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
import {
  ProcTimeoutError,
  runProc,
  RUN_PROC_MAX_OUTPUT_BYTES,
  RUN_PROC_TRUNCATED_MARKER,
} from "./run-proc.ts";

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

  test("rejects past the timeout, with a TYPED error", async () => {
    // The type is what lets a caller tell a deadline from a `Bun.spawn` throw:
    // the Stamp route answers 409 `stamp-timeout` for one and 502 for the other,
    // and matching on the message string would work until someone edits it.
    const err = await runProc(["bash", "-c", "sleep 5"], 120, "slow").catch((e) => e);
    expect(err).toBeInstanceOf(ProcTimeoutError);
    expect((err as Error).message).toMatch(/timed out after 120ms/);
  });

  describe("the output cap", () => {
    // The drain is `new Response(stream).text()`, which buffers the WHOLE stream
    // in this process — so an endlessly-printing child is an unbounded
    // allocation inside the dashboard's event loop, and the timeout does not
    // help: a fast writer reaches gigabytes well inside 15 s.

    test("stdout past the cap is truncated to the cap, with a marker", async () => {
      const cap = 4096;
      const r = await runProc(
        ["bash", "-c", `head -c 200000 /dev/zero | tr '\\0' 'a'`],
        10_000,
        "big",
        { maxOutputBytes: cap },
      );
      expect(r.stdout.endsWith(RUN_PROC_TRUNCATED_MARKER)).toBe(true);
      const payload = r.stdout.slice(0, r.stdout.length - RUN_PROC_TRUNCATED_MARKER.length);
      expect(payload.length).toBe(cap);
      expect(payload).toMatch(/^a+$/);
    });

    test("stderr is capped independently of stdout", async () => {
      const cap = 1024;
      const r = await runProc(
        ["bash", "-c", `echo small; head -c 50000 /dev/zero | tr '\\0' 'b' >&2`],
        10_000,
        "big",
        { maxOutputBytes: cap },
      );
      expect(r.stdout.trim()).toBe("small");
      expect(r.stderr.endsWith(RUN_PROC_TRUNCATED_MARKER)).toBe(true);
      expect(r.stderr.length - RUN_PROC_TRUNCATED_MARKER.length).toBe(cap);
    });

    test("output UNDER the cap is byte-identical and carries no marker", async () => {
      const r = await runProc(["bash", "-c", "printf 'hello'"], 5_000, "small", {
        maxOutputBytes: 4096,
      });
      expect(r.stdout).toBe("hello");
      expect(r.stdout).not.toContain("truncated");
    });

    test("a multi-byte character split across a chunk boundary still decodes", async () => {
      // The decode is STREAMING; a naive per-chunk `TextDecoder().decode()`
      // turns a split UTF-8 sequence into U+FFFD, corrupting a large payload at
      // every chunk boundary.
      //
      // The character is deliberately THREE bytes (U+20AC, `€`). A pipe hands
      // this process power-of-two chunks, so a two-byte character can only ever
      // land on an even offset and never splits — a test written with `å` is
      // green with the streaming flag removed, which is exactly what a mutation
      // run showed. 3 does not divide any power of two, so at this volume a
      // boundary lands mid-character many times over.
      const CHARS = 400_000; // 1.2 MB, ~18 pipe chunks
      const r = await runProc(
        ["bash", "-c", `printf '\\u20ac%.0s' $(seq 1 ${CHARS})`],
        20_000,
        "utf8",
        { maxOutputBytes: 8 * 1024 * 1024 },
      );
      expect(r.stdout).not.toContain("\ufffd");
      expect(r.stdout.length).toBe(CHARS);
    });

    test("output ending in a TRUNCATED utf-8 sequence flushes to one replacement char", () => {
      // The only state in which the final `decoder.decode()` (no argument) is
      // observable, enumerated rather than sampled: a flush emits whatever
      // partial sequence is still pending, and a sequence is pending at
      // end-of-stream exactly when the child's last bytes are an incomplete
      // UTF-8 character. Well-formed output leaves nothing pending and the two
      // spellings are identical; this is the other case. Without the flush the
      // bytes vanish silently, which is a payload that lost its tail with
      // nothing saying so.
      return runProc(
        // The first TWO bytes of U+20AC, and then nothing.
        ["bash", "-c", `printf '\\xe2\\x82'`],
        5_000,
        "truncated",
        { maxOutputBytes: 4096 },
      ).then((r) => {
        expect(r.stdout).toBe("\ufffd");
      });
    });

    test("the default cap is the claude-usage read cap", () => {
      expect(RUN_PROC_MAX_OUTPUT_BYTES).toBe(8 * 1024 * 1024);
    });
  });
});
