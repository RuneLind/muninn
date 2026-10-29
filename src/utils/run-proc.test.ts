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
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ProcTimeoutError,
  runProc,
  RUN_PROC_KILL_GRACE_MS,
  RUN_PROC_MAX_OUTPUT_BYTES,
  RUN_PROC_TRUNCATED_MARKER,
} from "./run-proc.ts";
import { testTempDirSync } from "../test/temp-dir.ts";

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

describe("runProc: the timeout's kill", () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const pidAt = (file: string) => Number(readFileSync(file, "utf8").trim());

  test("a child that traps SIGTERM gets SIGKILL after the grace, and the rejection waits for its exit", async () => {
    const dir = testTempDirSync(path.join(tmpdir(), "run-proc-kill-"));
    const pidFile = path.join(dir, "pid");
    try {
      const t0 = performance.now();
      const err = await runProc(
        ["/bin/bash", "-c", `echo $$ > ${pidFile}; trap '' TERM; while :; do sleep 0.05; done`],
        150,
        "trap",
        { killGraceMs: 300 },
      ).catch((e) => e);
      const ms = performance.now() - t0;
      expect(err).toBeInstanceOf(ProcTimeoutError);
      // Rejected only once the child is gone, which took the SIGKILL.
      expect(alive(pidAt(pidFile))).toBe(false);
      expect(ms).toBeGreaterThanOrEqual(150 + 300 - 20);
    } finally {
      try {
        process.kill(pidAt(pidFile), "SIGKILL");
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a child that dies on SIGTERM settles the timeout without the grace", async () => {
    const t0 = performance.now();
    const err = await runProc(["/bin/bash", "-c", "sleep 5"], 100, "plain").catch((e) => e);
    expect(err).toBeInstanceOf(ProcTimeoutError);
    expect(performance.now() - t0).toBeLessThan(100 + RUN_PROC_KILL_GRACE_MS);
  });

  test("processGroup: the timeout reaches what the child started", async () => {
    const dir = testTempDirSync(path.join(tmpdir(), "run-proc-group-"));
    const pidFile = path.join(dir, "pid");
    try {
      const err = await runProc(["/bin/bash", "-c", `sleep 30 & echo $! > ${pidFile}; wait`], 150, "group", {
        processGroup: true,
        killGraceMs: 300,
      }).catch((e) => e);
      expect(err).toBeInstanceOf(ProcTimeoutError);
      await Bun.sleep(50);
      expect(alive(pidAt(pidFile))).toBe(false);
    } finally {
      try {
        process.kill(pidAt(pidFile), "SIGKILL");
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("processGroup: a member that traps SIGTERM dies once its leader died on it, without the grace", async () => {
    const dir = testTempDirSync(path.join(tmpdir(), "run-proc-member-"));
    const pidFile = path.join(dir, "pid");
    try {
      const t0 = performance.now();
      const err = await runProc(
        ["/bin/bash", "-c", `bash -c "trap '' TERM; while :; do sleep 0.05; done" & echo $! > ${pidFile}; wait`],
        300,
        "member",
        // A grace far past the assertions: the member's SIGKILL must not come
        // from the grace timer.
        { processGroup: true, killGraceMs: 10_000 },
      ).catch((e) => e);
      expect(err).toBeInstanceOf(ProcTimeoutError);
      expect(performance.now() - t0).toBeLessThan(2_000);
      // Reparented, then reaped: allow that a moment.
      const member = pidAt(pidFile);
      const deadline = performance.now() + 1_000;
      while (alive(member) && performance.now() < deadline) await Bun.sleep(20);
      expect(alive(member)).toBe(false);
    } finally {
      try {
        process.kill(pidAt(pidFile), "SIGKILL");
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("processGroup + groupGrace: a member that traps SIGTERM keeps the grace after its leader died, then gets SIGKILL", async () => {
    const dir = testTempDirSync(path.join(tmpdir(), "run-proc-group-grace-"));
    const pidFile = path.join(dir, "pid");
    try {
      const t0 = performance.now();
      const err = await runProc(
        ["/bin/bash", "-c", `bash -c "trap 'sleep 0.3; touch ${dir}/cleaned' TERM; while :; do sleep 0.05; done" & echo $! > ${pidFile}; wait`],
        200,
        "group-grace",
        { processGroup: true, groupGrace: true, killGraceMs: 800 },
      ).catch((e) => e);
      const ms = performance.now() - t0;
      expect(err).toBeInstanceOf(ProcTimeoutError);
      expect(existsSync(path.join(dir, "cleaned"))).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(200 + 800 - 30);
      expect(ms).toBeLessThan(200 + 800 + 1_000);
      const member = pidAt(pidFile);
      const deadline = performance.now() + 1_000;
      while (alive(member) && performance.now() < deadline) await Bun.sleep(20);
      expect(alive(member)).toBe(false);
    } finally {
      try {
        process.kill(pidAt(pidFile), "SIGKILL");
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a timed-out call leaves nothing that holds the event loop: no timer, no pipe a setsid grandchild keeps open", async () => {
    const dir = testTempDirSync(path.join(tmpdir(), "run-proc-hold-"));
    const pidFile = path.join(dir, "outside");
    const script = path.join(dir, "hold.ts");
    await Bun.write(
      script,
      `import { runProc } from ${JSON.stringify(path.resolve(import.meta.dir, "run-proc.ts"))};
const t0 = performance.now();
await runProc(["/bin/sh", "-c", "perl -MPOSIX -e 'POSIX::setsid(); sleep 6' & echo $! > ${pidFile}; exec sleep 30"], 150, "hold", { processGroup: true, quietTimeout: true }).catch(() => {});
process.on("exit", () => console.log(Math.round(performance.now() - t0)));
`,
    );
    try {
      const t0 = performance.now();
      const out = await Bun.$`bun ${script}`.quiet().text();
      // Returned at the bound, and the process ended with it: not after the kill timers or the grandchild's 6 s.
      expect(Number(out.trim())).toBeLessThan(150 + 500);
      expect(performance.now() - t0).toBeLessThan(150 + 1_500);
    } finally {
      try {
        process.kill(pidAt(pidFile), "SIGKILL");
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cwd: the child runs where it is told", async () => {
    const dir = testTempDirSync(path.join(tmpdir(), "run-proc-cwd-"));
    try {
      const r = await runProc(["/bin/bash", "-c", "pwd -P"], 5_000, "cwd", { cwd: dir });
      expect(r.stdout.trim()).toBe(realpathSync(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A detached group is out of reach of the terminal's Ctrl-C and of muninn's
 *  shutdown: the parent's exit has to kill it (arch review 2026-10, finding 24
 *  fix round 1). */
describe("runProc: live process groups die with the parent", () => {
  const RUN_PROC = path.resolve(import.meta.dir, "run-proc.ts");
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const goneWithin = async (pid: number, ms: number) => {
    const deadline = performance.now() + ms;
    while (alive(pid) && performance.now() < deadline) await Bun.sleep(20);
    return !alive(pid);
  };
  const waitForPid = async (file: string) => {
    const deadline = performance.now() + 10_000;
    for (;;) {
      try {
        const pid = Number(readFileSync(file, "utf8").trim());
        if (pid > 0) return pid;
      } catch {}
      if (performance.now() > deadline) throw new Error(`no pid in ${file}`);
      await Bun.sleep(20);
    }
  };
  const groupCmd = (pidFile: string) => ["/bin/bash", "-c", `sleep 30 & echo $! > ${pidFile}; wait`];

  test("killLiveProcessGroups — the drain shutdown runs — kills a running group", async () => {
    const { killLiveProcessGroups } = await import("./run-proc.ts");
    const dir = testTempDirSync(path.join(tmpdir(), "run-proc-drain-"));
    const pidFile = path.join(dir, "pid");
    let member = 0;
    try {
      const run = runProc(groupCmd(pidFile), 60_000, "drain", { processGroup: true });
      member = await waitForPid(pidFile);
      expect(alive(member)).toBe(true);
      expect(killLiveProcessGroups()).toBe(1);
      const r = await run;
      expect(r.exitCode).not.toBe(0);
      expect(await goneWithin(member, 2_000)).toBe(true);
      // The drain emptied the registry (pinned on its own below).
      expect(killLiveProcessGroups()).toBe(0);
    } finally {
      try {
        if (member) process.kill(member, "SIGKILL");
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Records the pgids `fn` sends SIGKILL to, forwarding every call. */
  const groupKillsDuring = <T>(fn: () => T): { result: T; pgids: number[] } => {
    const pgids: number[] = [];
    const realKill = process.kill;
    process.kill = ((pid: number, sig?: string | number) => {
      if (pid < 0 && sig === "SIGKILL") pgids.push(-pid);
      return realKill.call(process, pid, sig);
    }) as typeof process.kill;
    try {
      return { result: fn(), pgids };
    } finally {
      process.kill = realKill;
    }
  };

  test("a group whose leader exits on its own leaves the registry, so shutdown never signals its pgid", async () => {
    const { killLiveProcessGroups } = await import("./run-proc.ts");
    killLiveProcessGroups();
    const r = await runProc(["/bin/bash", "-c", "exit 0"], 5_000, "self-exit", { processGroup: true });
    expect(r.exitCode).toBe(0);
    // The pgid of a finished job may already belong to someone else.
    const { result, pgids } = groupKillsDuring(() => killLiveProcessGroups());
    expect(pgids).toEqual([]);
    expect(result).toBe(0);
  });

  test("a drain forgets what it signalled: a second drain straight after signals nothing", async () => {
    const { killLiveProcessGroups } = await import("./run-proc.ts");
    killLiveProcessGroups();
    const dir = testTempDirSync(path.join(tmpdir(), "run-proc-redrain-"));
    const pidFile = path.join(dir, "pid");
    let member = 0;
    try {
      const run = runProc(groupCmd(pidFile), 60_000, "redrain", { processGroup: true });
      member = await waitForPid(pidFile);
      const first = groupKillsDuring(() => killLiveProcessGroups());
      expect(first.pgids.length).toBe(1);
      // Synchronous, so the leader's exit has not been observed yet: only the
      // drain itself can have emptied the registry.
      const second = groupKillsDuring(() => killLiveProcessGroups());
      expect(second.pgids).toEqual([]);
      expect(second.result).toBe(0);
      await run;
    } finally {
      try {
        if (member) process.kill(member, "SIGKILL");
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A bun parent that runs `head`, starts a group, then does `tail`. Returns
   *  the parent and the group member's pid. */
  async function parentWithGroup(
    name: string,
    tail: string,
    head = "",
    opts: { cmd?: (pidFile: string, dir: string) => string[]; wrap?: string[]; timeoutMs?: number; groupGrace?: boolean } = {},
  ) {
    const dir = testTempDirSync(path.join(tmpdir(), `run-proc-${name}-`));
    const pidFile = path.join(dir, "pid");
    const script = path.join(dir, "parent.ts");
    const cmd = (opts.cmd ?? groupCmd)(pidFile, dir);
    await Bun.write(
      script,
      [
        `import { runProc } from ${JSON.stringify(RUN_PROC)};`,
        head,
        `void runProc(${JSON.stringify(cmd)}, ${opts.timeoutMs ?? 60_000}, "parent", { processGroup: true, quietTimeout: true, groupGrace: ${!!opts.groupGrace} }).catch(() => {});`,
        tail,
        `setInterval(() => {}, 1_000);`,
      ].join("\n"),
    );
    const parent = Bun.spawn([...(opts.wrap ?? []), "bun", script], { stdout: "ignore", stderr: "pipe" });
    const member = await waitForPid(pidFile);
    return { dir, parent, member };
  }
  /** A member that writes `term` in `dir` when SIGTERM reaches it, then lives on until SIGKILL. */
  const termRecorder = (pidFile: string, dir: string) => [
    "/bin/bash",
    "-c",
    // The member writes its pid once its trap is set, so no signal can beat the trap.
    `bash -c "trap 'touch ${dir}/term' TERM; echo \\$\\$ > ${pidFile}; while :; do sleep 0.05; done" & wait`,
  ];
  /** A test's own cleanup, red or green: the bun parent, then the member (its leader only waits on it). */
  const reapAll = (parent: { kill(sig?: NodeJS.Signals | number): void }, member: number) => {
    parent.kill("SIGKILL");
    try {
      process.kill(member, "SIGKILL");
    } catch {}
  };

  test("SIGINT to a parent with no handler of its own: the parent still dies on it, and the group with it", async () => {
    const { dir, parent, member } = await parentWithGroup("sigint", "");
    try {
      expect(alive(member)).toBe(true);
      parent.kill("SIGINT");
      await parent.exited;
      // Its default exit on SIGINT is unchanged.
      expect(parent.signalCode).toBe("SIGINT");
      expect(await goneWithin(member, 2_000)).toBe(true);
    } finally {
      reapAll(parent, member);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SIGTERM to a parent that handles it itself, the way muninn's shutdown does: its exit code stands, the group dies", async () => {
    const { dir, parent, member } = await parentWithGroup(
      "shutdown",
      `process.on("SIGTERM", () => { setTimeout(() => process.exit(7), 100); });`,
    );
    try {
      parent.kill("SIGTERM");
      expect(await parent.exited).toBe(7);
      expect(await goneWithin(member, 2_000)).toBe(true);
    } finally {
      reapAll(parent, member);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a process.once handler registered before the first group keeps its own exit", async () => {
    // EventEmitter removes a once listener before calling it, so a hook that
    // runs after it would count itself alone and re-raise the default death.
    const { dir, parent, member } = await parentWithGroup(
      "once",
      "",
      `process.once("SIGINT", () => { setTimeout(() => process.exit(5), 100); });`,
    );
    try {
      parent.kill("SIGINT");
      expect(await parent.exited).toBe(5);
      expect(await goneWithin(member, 2_000)).toBe(true);
    } finally {
      reapAll(parent, member);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SIGHUP to a parent with no handler: the parent dies on it, and the group with it", async () => {
    const { dir, parent, member } = await parentWithGroup("sighup", "");
    try {
      parent.kill("SIGHUP");
      await parent.exited;
      expect(parent.signalCode).toBe("SIGHUP");
      expect(await goneWithin(member, 2_000)).toBe(true);
    } finally {
      reapAll(parent, member);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const [sig, wrap] of [
    ["SIGHUP", ["nohup"]],
    ["SIGINT", ["/bin/sh", "-c", `trap '' INT; exec "$@"`, "sh"]],
  ] as const) {
    test(`${sig} inherited as ignored (${wrap[0]}) stays ignored: the parent and its group live on`, async () => {
      const { dir, parent, member } = await parentWithGroup(`ign-${sig}`, "", "", { wrap: [...wrap] });
      try {
        parent.kill(sig);
        const r = await Promise.race([parent.exited, Bun.sleep(1_000).then(() => "alive")]);
        expect(r).toBe("alive");
        expect(alive(member)).toBe(true);
      } finally {
        reapAll(parent, member);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("inheritedIgnore reads this process's own dispositions", async () => {
    const { inheritedIgnore } = await import("./run-proc.ts");
    const probe = `import { inheritedIgnore } from ${JSON.stringify(RUN_PROC)}; console.log(["SIGHUP","SIGINT","SIGTERM"].map((s) => inheritedIgnore(s as any)).join(","));`;
    const run = async (wrap: string[]) => (await Bun.$`${wrap} bun -e ${probe}`.quiet().text()).trim();
    expect(await run([])).toBe("false,false,false");
    expect(await run(["nohup"])).toBe("true,false,false");
    expect(await run(["/bin/sh", "-c", `trap '' INT TERM; exec "$@"`, "sh"])).toBe("false,true,true");
    expect(typeof inheritedIgnore("SIGHUP")).toBe("boolean");
  });

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    test(`${sig} to a parent with no handler reaches the group as SIGTERM first, then SIGKILL within the grace`, async () => {
      const { RUN_PROC_EXIT_TERM_GRACE_MS } = await import("./run-proc.ts");
      const { dir, parent, member } = await parentWithGroup(`term-first-${sig}`, "", "", { cmd: termRecorder });
      try {
        const t0 = performance.now();
        parent.kill(sig);
        await parent.exited;
        expect(parent.signalCode).toBe(sig);
        expect(await goneWithin(member, 1_000)).toBe(true);
        expect(existsSync(path.join(dir, "term"))).toBe(true);
        expect(performance.now() - t0).toBeGreaterThanOrEqual(RUN_PROC_EXIT_TERM_GRACE_MS - 50);
        expect(performance.now() - t0).toBeLessThan(RUN_PROC_EXIT_TERM_GRACE_MS + 1_500);
      } finally {
        reapAll(parent, member);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("process.exit() reaches a live group as SIGTERM first, then SIGKILL", async () => {
    const { dir, parent, member } = await parentWithGroup("exit-term", `setTimeout(() => process.exit(0), 300);`, "", { cmd: termRecorder });
    try {
      expect(await parent.exited).toBe(0);
      expect(await goneWithin(member, 1_000)).toBe(true);
      expect(existsSync(path.join(dir, "term"))).toBe(true);
    } finally {
      reapAll(parent, member);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a signal inside a timeout's grace still ends a member the timeout has not killed yet", async () => {
    // The leader dies on the timeout's SIGTERM; the member traps it and, with groupGrace, keeps the grace.
    // Forgetting the group when its leader died would leave the member to a SIGKILL the dead parent never sends.
    const { dir, parent, member } = await parentWithGroup("grace-signal", "", "", { cmd: termRecorder, timeoutMs: 200, groupGrace: true });
    try {
      for (const end = performance.now() + 3_000; !existsSync(path.join(dir, "term")) && performance.now() < end; ) await Bun.sleep(10);
      expect(existsSync(path.join(dir, "term"))).toBe(true);
      parent.kill("SIGINT");
      await parent.exited;
      expect(await goneWithin(member, 1_500)).toBe(true);
    } finally {
      reapAll(parent, member);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("process.exit() with a group running kills the group", async () => {
    const { dir, parent, member } = await parentWithGroup(
      "exit",
      `setTimeout(() => process.exit(0), 300);`,
    );
    try {
      expect(await parent.exited).toBe(0);
      expect(await goneWithin(member, 2_000)).toBe(true);
    } finally {
      reapAll(parent, member);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
