/**
 * `scripts/wiki-work-replay.ts` driven as a subprocess against git fixtures
 * built in a temp dir, with frozen ledger answers: the commit it checks out,
 * what its mtime stamping touches, the clone left behind on a signal, and the
 * frozen captures it accepts. No network, no `.env` (the child runs in a temp
 * cwd with an explicit env).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDir } from "../src/test/temp-dir.ts";
import { WORK_WINDOW_MS } from "../src/wiki/work-focus.ts";

const SCRIPT = path.join(import.meta.dir, "wiki-work-replay.ts");
const H = 3_600_000;
/** 2026-10-18T12:00:00Z — every fixture's `--at`. */
const AT = Date.UTC(2026, 9, 18, 12);
const SINCE = AT - WORK_WINDOW_MS;

/** Git with no global or system config, so a developer's hooks or signing
 *  settings never reach a fixture. */
const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: cwd, ...GIT_ENV, ...env },
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out.trim();
}

/** Commit everything with the given author and committer instants (ms). */
async function commit(repo: string, msg: string, authorMs: number, committerMs: number): Promise<string> {
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", msg], {
    GIT_AUTHOR_DATE: `${authorMs / 1000} +0000`,
    GIT_COMMITTER_DATE: `${committerMs / 1000} +0000`,
  });
  return git(repo, ["rev-parse", "HEAD"]);
}

const page = (title: string) => `---\ntitle: ${title}\n---\n\n# ${title}\n`;

interface Fixture {
  base: string;
  repo: string;
  /** The script's TMPDIR: where it makes its clone. */
  scriptTmp: string;
}

async function fixture(): Promise<Fixture> {
  const base = await testTempDir(path.join(tmpdir(), "wiki-work-replay-test-"));
  const repo = path.join(base, "wiki");
  const scriptTmp = path.join(base, "tmp");
  await mkdir(repo);
  await mkdir(scriptTmp);
  await mkdir(path.join(base, "bots"));
  await mkdir(path.join(base, "cwd"));
  await git(repo, ["init", "-q", "-b", "main"]);
  return { base, repo, scriptTmp };
}

interface Frozen {
  sessions?: Record<string, unknown>;
  pre?: Record<string, unknown>;
  /** The summary form at `until = at`; written only when given. */
  summary?: Record<string, unknown>;
  /** A whole body written in place of the sessions or pre capture. */
  raw?: { sessions?: unknown; pre?: unknown };
}

async function writeFrozen(f: Fixture, over: Frozen = {}): Promise<string[]> {
  const sessions =
    over.raw && "sessions" in over.raw
      ? over.raw.sessions
      : { form: "sessions", root: f.repo, since: SINCE, until: AT, limit: 200, truncated: false, sessions: [], ...over.sessions };
  const pre =
    over.raw && "pre" in over.raw
      ? over.raw.pre
      : { root: f.repo, pageCount: 0, bulk: 10, limit: 5000, truncated: false, until: SINCE, pages: [], ...over.pre };
  const sessionsPath = path.join(f.base, "sessions.json");
  const prePath = path.join(f.base, "pre.json");
  await writeFile(sessionsPath, JSON.stringify(sessions));
  await writeFile(prePath, JSON.stringify(pre));
  const args = ["--sessions-json", sessionsPath, "--pre-json", prePath];
  if (over.summary) {
    const summary = { root: f.repo, pageCount: 0, bulk: 10, limit: 5000, truncated: false, until: AT, pages: [], ...over.summary };
    const summaryPath = path.join(f.base, "summary.json");
    await writeFile(summaryPath, JSON.stringify(summary));
    args.push("--summary-json", summaryPath);
  }
  return args;
}

/** `detached` puts the script in its own process group, so a test can kill
 *  it and anything it left behind in one call. */
function spawnReplay(f: Fixture, frozenArgs: string[], env: Record<string, string> = {}, detached = false) {
  return Bun.spawn(["bun", SCRIPT, "--wiki", "fx", "--at", new Date(AT).toISOString(), ...frozenArgs], {
    detached,
    cwd: path.join(f.base, "cwd"),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: f.base,
      TMPDIR: f.scriptTmp,
      WIKI_EXTRA: `fx=${f.repo}`,
      MUNINN_BOTS_DIR: path.join(f.base, "bots"),
      LOG_DIR: "none",
      ...GIT_ENV,
      ...env,
    },
  });
}

async function runReplay(f: Fixture, frozenArgs: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = spawnReplay(f, frozenArgs);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

const clonesIn = async (dir: string) => (await readdir(dir)).filter((n) => n.startsWith("wiki-work-replay-"));

describe("the commit it replays", () => {
  test("is the newest first-parent commit COMMITTED at or before --at, not the newest authored before it", async () => {
    const f = await fixture();
    await writeFile(path.join(f.repo, "a.md"), page("A"));
    const c1 = await commit(f.repo, "a", AT - 2 * H, AT - 2 * H);
    await writeFile(path.join(f.repo, "b.md"), page("B"));
    await commit(f.repo, "b", AT + 1 * H, AT + 1 * H);
    // Rebased onto b: authored before --at, committed after it.
    await writeFile(path.join(f.repo, "c.md"), page("C"));
    const c3 = await commit(f.repo, "c", AT - 1 * H, AT + 2 * H);

    const r = await runReplay(f, await writeFrozen(f));
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`commit ${c1.slice(0, 10)}`);
    expect(r.out).not.toContain(`commit ${c3.slice(0, 10)}`);
  }, 30_000);
});

describe("mtime stamping", () => {
  const mtimeOf = async (file: string) => (await stat(file)).mtimeMs;
  // Imported here, not at the top: a failed import fails these tests only.
  const stampMtimes = async (repo: string, atSec: number) => (await import("./wiki-work-replay-git.ts")).stampMtimes(repo, atSec);

  test("dates a file by its last commit's committer time", async () => {
    const f = await fixture();
    // Authored three hours before --at, committed one hour before it.
    await writeFile(path.join(f.repo, "talk.html"), "<!doctype html><title>Talk</title>");
    await commit(f.repo, "talk", AT - 3 * H, AT - 1 * H);

    expect(await stampMtimes(f.repo, AT / 1000)).toBe(1);
    expect(await mtimeOf(path.join(f.repo, "talk.html"))).toBe(AT - 1 * H);
  });

  test("never dates a file after --at, even when an ancestor was committed after it", async () => {
    const f = await fixture();
    // The parent's committer clock ran ahead: committed after --at, below a
    // child committed before it.
    await writeFile(path.join(f.repo, "late.html"), "<!doctype html><title>Late</title>");
    await commit(f.repo, "late", AT - 3 * H, AT + 5 * H);
    await writeFile(path.join(f.repo, "a.md"), page("A"));
    await commit(f.repo, "a", AT - 2 * H, AT - 2 * H);

    await stampMtimes(f.repo, AT / 1000);
    expect(await mtimeOf(path.join(f.repo, "late.html"))).toBe(AT);
    expect(await mtimeOf(path.join(f.repo, "a.md"))).toBe(AT - 2 * H);
  });

  test("never follows a tracked symlink out of the clone", async () => {
    const f = await fixture();
    const outside = path.join(f.base, "outside.html");
    await writeFile(outside, "<!doctype html><title>Out</title>");
    const before = new Date("2001-02-03T04:05:06Z");
    await utimes(outside, before, before);
    await writeFile(path.join(f.repo, "a.md"), page("A"));
    await symlink(outside, path.join(f.repo, "linked.html"));
    await commit(f.repo, "a + link", AT - 2 * H, AT - 2 * H);

    const r = await runReplay(f, await writeFrozen(f));
    expect(r.code).toBe(0);
    expect((await stat(outside)).mtime.toISOString()).toBe(before.toISOString());
  }, 30_000);
});

/** True while `pid` is running; false once it has exited (or never existed). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** `ps -o <field>=` for one pid, or "" once it is gone. */
function psField(pid: number, field: "stat" | "pgid"): string {
  return Bun.spawnSync(["ps", "-o", `${field}=`, "-p", String(pid)]).stdout.toString().trim();
}

/**
 * The teardown matrix: hooks git runs × what happens to the script. Each row
 * spawns the replay against a fixture whose post-checkout hook leaves sleeps
 * behind, does one thing to the script, and asserts that no sleep survives.
 * Process signals go through `process.kill`: on macOS Bun's `Subprocess.kill`
 * maps SIGTSTP, SIGCONT and SIGSTOP by Linux numbers and sends other signals.
 */
describe("git teardown", () => {
  /** Every process group a test started or saw a sleep in: the replay's own
   *  (spawned detached) and each sleep's. `afterEach` SIGKILLs all of them,
   *  also the ones whose leader exited, since an orphan keeps a group alive. */
  const groups = new Set<number>();
  afterEach(() => {
    for (const g of groups) {
      try {
        process.kill(-g, "SIGKILL");
      } catch {
        // the group is empty
      }
    }
    groups.clear();
  });

  /**
   * - `fg`: the hook runs `sleep` in the foreground and holds the checkout.
   * - `orphan`: as `fg`, after starting a second `sleep` with `&` in a subshell
   *   that exits, so that sleep runs on with ppid 1 while git still runs.
   * - `bg-held`: the hook starts `sleep` with `&` and exits; the sleep keeps
   *   git's stdout and stderr open after git has exited.
   * - `bg-free`: as `bg-held`, with the sleep's output sent to /dev/null, so git
   *   returns at once and the script runs to its end.
   * - `bg-fail`: as `bg-free`, and the hook exits 1, so the checkout fails.
   */
  type Hook = "fg" | "orphan" | "bg-held" | "bg-free" | "bg-fail";

  /** A fixture with a `kind` hook; each sleep's pid goes to a marker file. */
  async function hooked(kind: Hook): Promise<{ f: Fixture; hookEnv: Record<string, string>; markers: string[] }> {
    const f = await fixture();
    await writeFile(path.join(f.repo, "a.md"), page("A"));
    await commit(f.repo, "a", AT - 2 * H, AT - 2 * H);
    const hooks = path.join(f.base, "hooks");
    await mkdir(hooks);
    const [m1, m2] = [path.join(f.base, "sleep-1"), path.join(f.base, "sleep-2")];
    const body = {
      fg: `echo $$ > "${m1}"\nexec sleep 20`,
      orphan: `( sleep 20 >/dev/null 2>&1 & echo $! > "${m2}" )\necho $$ > "${m1}"\nexec sleep 20`,
      "bg-held": `sleep 20 &\necho $! > "${m1}"\nexit 0`,
      "bg-free": `sleep 20 >/dev/null 2>&1 &\necho $! > "${m1}"\nexit 0`,
      "bg-fail": `sleep 20 >/dev/null 2>&1 &\necho $! > "${m1}"\nexit 1`,
    }[kind];
    await writeFile(path.join(hooks, "post-checkout"), `#!/bin/sh\n${body}\n`);
    await chmod(path.join(hooks, "post-checkout"), 0o755);
    const hookEnv = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: hooks };
    return { f, hookEnv, markers: kind === "orphan" ? [m1, m2] : [m1] };
  }

  /** The replay, in its own process group so `afterEach` can kill it all. */
  async function start(kind: Hook, env: Record<string, string> = {}) {
    const { f, hookEnv, markers } = await hooked(kind);
    const proc = spawnReplay(f, await writeFrozen(f), { ...hookEnv, ...env }, true);
    groups.add(proc.pid);
    return { f, proc, markers };
  }

  /** Waits for the hook to write every marker; returns the sleeps' pids and
   *  records their groups for `afterEach`. */
  async function sleepsOf(markers: string[]): Promise<number[]> {
    const deadline = Date.now() + 20_000;
    const pids: number[] = [];
    for (const m of markers) {
      while (!existsSync(m) || !(await Bun.file(m).text()).trim()) {
        if (Date.now() > deadline) throw new Error("the checkout hook never ran");
        await Bun.sleep(50);
      }
      pids.push(Number((await Bun.file(m).text()).trim()));
    }
    for (const pid of pids) {
      const g = Number(psField(pid, "pgid"));
      if (g > 1) groups.add(g);
    }
    return pids;
  }

  /** True once every pid has exited, polled for up to 3 s. */
  async function allGone(pids: number[]): Promise<boolean> {
    for (const until = Date.now() + 3_000; Date.now() < until; await Bun.sleep(50)) {
      if (!pids.some(alive)) return true;
    }
    return false;
  }

  /** True once `ps` shows every pid stopped (`want`) or running (`!want`). */
  async function stopped(pids: number[], want: boolean): Promise<boolean> {
    for (const until = Date.now() + 3_000; Date.now() < until; await Bun.sleep(50)) {
      if (pids.every((p) => psField(p, "stat").startsWith("T") === want)) return true;
    }
    return false;
  }

  const exitOrHang = (proc: { exited: Promise<number> }, ms = 10_000) =>
    Promise.race([proc.exited, Bun.sleep(ms).then(() => "hung" as const)]);

  describe("the script ends on its own", () => {
    test("bg-free, normal exit: the sleep the hook left behind is killed", async () => {
      const { proc, markers } = await start("bg-free");
      expect(await exitOrHang(proc)).toBe(0);
      expect(await allGone(await sleepsOf(markers))).toBe(true);
    }, 30_000);

    test("bg-held, normal exit: a sleep holding git's output open neither holds the exit nor survives it", async () => {
      const { proc, markers } = await start("bg-held");
      const sleeps = await sleepsOf(markers);
      expect(await exitOrHang(proc)).toBe(0);
      expect(await allGone(sleeps)).toBe(true);
    }, 30_000);

    test("bg-fail, git error exit: the sleep the hook left behind is killed", async () => {
      const { proc, markers } = await start("bg-fail");
      const code = await exitOrHang(proc);
      expect(code).not.toBe("hung");
      expect(code).not.toBe(0);
      expect(await allGone(await sleepsOf(markers))).toBe(true);
    }, 30_000);
  });

  type Send = { name: string; send: (pid: number) => void; code: number | null };
  const sends: Send[] = [
    { name: "SIGINT to the script", send: (p) => process.kill(p, "SIGINT"), code: 130 },
    { name: "SIGTERM to the script", send: (p) => process.kill(p, "SIGTERM"), code: 143 },
    { name: "SIGHUP to the script", send: (p) => process.kill(p, "SIGHUP"), code: 129 },
    // As a terminal sends Ctrl-C and Ctrl-\ to its foreground job.
    { name: "SIGINT to its process group", send: (p) => process.kill(-p, "SIGINT"), code: 130 },
    { name: "SIGQUIT to its process group", send: (p) => process.kill(-p, "SIGQUIT"), code: 131 },
    // Neither can be handled: no exit code to check, and the clone remains.
    { name: "SIGKILL to its process group", send: (p) => process.kill(-p, "SIGKILL"), code: null },
    { name: "SIGKILL to the script alone", send: (p) => process.kill(p, "SIGKILL"), code: null },
  ];
  for (const kind of ["fg", "orphan"] as const) {
    describe(`a ${kind} hook holding the checkout`, () => {
      for (const { name, send, code } of sends) {
        test(`${name}: no sleep survives${code === null ? "" : `, the clone is removed and the script exits ${code}`}`, async () => {
          const { f, proc, markers } = await start(kind);
          const sleeps = await sleepsOf(markers);
          expect(await clonesIn(f.scriptTmp)).toHaveLength(1);

          send(proc.pid);
          const exited = await exitOrHang(proc);
          expect(exited).not.toBe("hung");
          expect(await allGone(sleeps)).toBe(true);
          if (code !== null) {
            expect(proc.signalCode).toBeNull();
            expect(exited).toBe(code);
            expect(await clonesIn(f.scriptTmp)).toEqual([]);
          }
        }, 40_000);
      }

      test("SIGTSTP then SIGCONT to the script: the sleeps stop and resume with it", async () => {
        const { f, proc, markers } = await start(kind);
        const sleeps = await sleepsOf(markers);

        process.kill(proc.pid, "SIGTSTP");
        expect(await stopped(sleeps, true)).toBe(true);
        expect(await stopped([proc.pid], true)).toBe(true);
        process.kill(proc.pid, "SIGCONT");
        expect(await stopped(sleeps, false)).toBe(true);
        expect(await stopped([proc.pid], false)).toBe(true);

        process.kill(proc.pid, "SIGTERM");
        expect(await exitOrHang(proc)).toBe(143);
        expect(await allGone(sleeps)).toBe(true);
        expect(await clonesIn(f.scriptTmp)).toEqual([]);
      }, 40_000);
    });
  }

  test("bg-held, SIGTERM while the sleep holds git's output: the sleep dies and the script exits", async () => {
    const { f, proc, markers } = await start("bg-held");
    const sleeps = await sleepsOf(markers);
    process.kill(proc.pid, "SIGTERM");
    // The signal may land after the script has finished (0) or during it (143).
    expect([0, 143] as (number | "hung")[]).toContain(await exitOrHang(proc));
    expect(await allGone(sleeps)).toBe(true);
    expect(await clonesIn(f.scriptTmp)).toEqual([]);
  }, 40_000);

  test("without ps on PATH, SIGTERM still stops the hook and exits 143", async () => {
    const realGit = Bun.which("git");
    const realSleep = Bun.which("sleep");
    if (!realGit || !realSleep) throw new Error("no git or sleep on PATH");
    const base = await testTempDir(path.join(tmpdir(), "wiki-work-replay-bin-"));
    await writeFile(path.join(base, "git"), `#!/bin/sh\nexec "${realGit}" "$@"\n`);
    await chmod(path.join(base, "git"), 0o755);
    await symlink(realSleep, path.join(base, "sleep"));
    await symlink(process.execPath, path.join(base, "bun"));
    const { f, proc, markers } = await start("fg", { PATH: base });
    const sleeps = await sleepsOf(markers);

    process.kill(proc.pid, "SIGTERM");
    expect(await exitOrHang(proc)).toBe(143);
    expect(await allGone(sleeps)).toBe(true);
    expect(await clonesIn(f.scriptTmp)).toEqual([]);
  }, 40_000);

  test("a git child and hook that ignore SIGTERM do not hold the exit", async () => {
    const realGit = Bun.which("git");
    if (!realGit) throw new Error("no git on PATH");
    const { f, hookEnv, markers } = await hooked("fg");
    // The hook's sleep ignores SIGTERM too.
    await writeFile(path.join(f.base, "hooks", "post-checkout"), `#!/bin/sh\necho $$ > "${markers[0]}"\ntrap '' TERM\nsleep 20\n`);
    // A `git` on PATH that ignores SIGTERM and runs the real one under it.
    const bin = path.join(f.base, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "git"), `#!/bin/sh\ntrap '' TERM\n"${realGit}" "$@"\n`);
    await chmod(path.join(bin, "git"), 0o755);
    const proc = spawnReplay(f, await writeFrozen(f), { ...hookEnv, PATH: `${bin}:${process.env.PATH ?? ""}` }, true);
    groups.add(proc.pid);
    const sleeps = await sleepsOf(markers);

    const sent = Date.now();
    process.kill(proc.pid, "SIGTERM");
    // A second signal, as a user would send on a stuck exit.
    const second = setTimeout(() => process.kill(proc.pid, "SIGINT"), 2_000);
    const exited = await exitOrHang(proc);
    clearTimeout(second);
    expect(exited).not.toBe("hung");
    expect(Date.now() - sent).toBeLessThan(10_000);
    expect(await allGone(sleeps)).toBe(true);
  }, 40_000);
});

describe("live ledger answers", () => {
  test("each of the three is asked for the registered root on the full files route", async () => {
    const f = await fixture();
    await writeFile(path.join(f.repo, "a.md"), page("A"));
    await commit(f.repo, "a", AT - 2 * H, AT - 2 * H);
    const asked: string[] = [];
    const summary = (until: number) => ({ root: f.repo, pageCount: 0, bulk: 10, limit: 5000, truncated: false, until, pages: [] });
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        asked.push(url.pathname + url.search);
        const q = url.searchParams;
        if (q.get("sessions") === "1") {
          return Response.json({ form: "sessions", root: f.repo, since: SINCE, until: AT, limit: 200, truncated: false, sessions: [] });
        }
        return Response.json(summary(Number(q.get("until"))));
      },
    });
    try {
      const proc = spawnReplay(f, [], { CLAUDE_USAGE_URL: `http://127.0.0.1:${server.port}` });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(err).toBe("");
      expect(code).toBe(0);
      expect(out).toContain(`wiki fx at ${new Date(AT).toISOString()}`);
      const route = `/api/files?root=${encodeURIComponent(f.repo)}&`;
      expect(asked.sort()).toEqual(
        [`${route}sessions=1&since=${SINCE}&until=${AT}`, `${route}summary=1&until=${AT}`, `${route}summary=1&until=${SINCE}`].sort(),
      );
    } finally {
      server.stop(true);
    }
  }, 30_000);
});

describe("signalHandler", () => {
  const signalHandler = async (...a: Parameters<typeof import("./wiki-work-replay-git.ts").signalHandler>) =>
    (await import("./wiki-work-replay-git.ts")).signalHandler(...a);
  test("the first signal exits with its code once cleanup is done", async () => {
    const exits: number[] = [];
    let done!: () => void;
    const onSignal = await signalHandler(() => new Promise<void>((r) => (done = r)), (c) => void exits.push(c));
    onSignal(143);
    await Bun.sleep(20);
    expect(exits).toEqual([]);
    done();
    await Bun.sleep(20);
    expect(exits).toEqual([143]);
  });

  test("a cleanup that rejects still exits with the signal's code", async () => {
    const exits: number[] = [];
    const onSignal = await signalHandler(() => Promise.reject(new Error("EACCES")), (c) => void exits.push(c));
    onSignal(129);
    await Bun.sleep(20);
    expect(exits).toEqual([129]);
  });

  test("cleanup waits until every killed git child has exited", async () => {
    const order: string[] = [];
    let gitExit!: () => void;
    const exited = new Promise<void>((r) => (gitExit = r));
    const onSignal = await signalHandler(
      async () => void order.push("cleanup"),
      (c) => void order.push(`exit ${c}`),
      () => [{ exited }],
    );
    onSignal(130);
    await Bun.sleep(20);
    expect(order).toEqual([]);
    gitExit();
    await Bun.sleep(20);
    expect(order).toEqual(["cleanup", "exit 130"]);
  });

  test("a kill step that throws still runs cleanup and exits with the signal's code", async () => {
    const order: string[] = [];
    const onSignal = await signalHandler(
      async () => void order.push("cleanup"),
      (c) => void order.push(`exit ${c}`),
      () => {
        throw new Error("ps: not found");
      },
    );
    onSignal(143);
    await Bun.sleep(20);
    expect(order).toEqual(["cleanup", "exit 143"]);
  });

  test("a second signal during a stalled cleanup exits at once with its own code", async () => {
    const exits: number[] = [];
    const onSignal = await signalHandler(() => new Promise<void>(() => {}), (c) => void exits.push(c));
    onSignal(143);
    await Bun.sleep(20);
    expect(exits).toEqual([]);
    onSignal(130);
    expect(exits).toEqual([130]);
  });
});

describe("frozen captures", () => {
  async function oneCommit(): Promise<Fixture> {
    const f = await fixture();
    await writeFile(path.join(f.repo, "a.md"), page("A"));
    await commit(f.repo, "a", AT - 2 * H, AT - 2 * H);
    return f;
  }

  /** The full route each refusal tells the operator to capture with. */
  const captureQuery = (f: Fixture, file: string): string => {
    const route = `/api/files?root=${encodeURIComponent(f.repo)}&`;
    const query = {
      "sessions.json": `sessions=1&since=${SINCE}&until=${AT}`,
      "pre.json": `summary=1&until=${SINCE}`,
      "summary.json": `summary=1&until=${AT}`,
    }[file];
    if (query === undefined) throw new Error(`no capture query for ${file}`);
    return route + query;
  };

  test("an exact capture of all three files prints no Δ line", async () => {
    const f = await oneCommit();
    const r = await runReplay(f, await writeFrozen(f, { summary: {} }));
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("ledger answers: frozen (files)");
    expect(r.out).not.toContain("Δ");
    expect(r.out).not.toContain("frozen capture");
  }, 30_000);

  test("a capture of this window is accepted", async () => {
    const f = await oneCommit();
    const r = await runReplay(f, await writeFrozen(f));
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("ledger answers: frozen");
  }, 30_000);

  test("a pre-window capture a few seconds off is re-stamped and accepted", async () => {
    const f = await oneCommit();
    const r = await runReplay(f, await writeFrozen(f, { pre: { until: SINCE - 30_000 } }));
    expect(r.code).toBe(0);
    expect(r.out).toContain("re-stamped");
  }, 30_000);

  test("a pre-window capture from another window is refused", async () => {
    const f = await oneCommit();
    const r = await runReplay(f, await writeFrozen(f, { pre: { until: SINCE - 24 * H } }));
    expect(r.code).toBe(1);
    expect(r.err).toContain("pre.json");
    expect(r.err).toContain("another window");
    expect(r.out).not.toContain("ledger answers: frozen");
  }, 30_000);

  test("a sessions capture from another window is refused", async () => {
    const f = await oneCommit();
    const r = await runReplay(f, await writeFrozen(f, { sessions: { since: SINCE - 24 * H, until: AT - 24 * H } }));
    expect(r.code).toBe(1);
    expect(r.err).toContain("sessions.json");
    expect(r.err).toContain("another window");
  }, 30_000);

  test("a capture that records no window is refused", async () => {
    const f = await oneCommit();
    const r = await runReplay(f, await writeFrozen(f, { pre: { until: undefined } }));
    expect(r.code).toBe(1);
    expect(r.err).toContain("pre.json");
    expect(r.err).toContain("records no window");
    expect(r.err).toContain(captureQuery(f, "pre.json"));
  }, 30_000);

  test("a sessions capture that records no window is refused", async () => {
    const f = await oneCommit();
    const r = await runReplay(f, await writeFrozen(f, { sessions: { since: undefined } }));
    expect(r.code).toBe(1);
    expect(r.err).toContain("sessions.json");
    expect(r.err).toContain("records no window");
    expect(r.err).toContain(captureQuery(f, "sessions.json"));
  }, 30_000);

  const MIN = 60_000;
  const SLACK = 5 * MIN;

  /** Each echoed bound against this replay's: a bound past the window (a
   *  later `until`, an earlier `since`) is refused at any offset; one inside it misses at most the slack and is
   *  accepted with a Δ line naming the file and field. */
  const windowCases: [string, Frozen, string, "refused" | { delta: string }][] = [
    ["sessions until 1 ms after --at", { sessions: { until: AT + 1 } }, "sessions.json", "refused"],
    ["sessions until 4 min after --at", { sessions: { until: AT + 4 * MIN } }, "sessions.json", "refused"],
    ["sessions until a day early, since right", { sessions: { until: AT - 24 * H } }, "sessions.json", "refused"],
    ["sessions until exactly the slack early", { sessions: { until: AT - SLACK } }, "sessions.json: until", { delta: "Δ -300.0 s" }],
    ["sessions until 1 ms more than the slack early", { sessions: { until: AT - SLACK - 1 } }, "sessions.json", "refused"],
    ["sessions since 1 ms before the window start", { sessions: { since: SINCE - 1 } }, "sessions.json", "refused"],
    ["sessions since exactly the slack late", { sessions: { since: SINCE + SLACK } }, "sessions.json: since", { delta: "Δ +300.0 s" }],
    ["sessions since 1 ms more than the slack late", { sessions: { since: SINCE + SLACK + 1 } }, "sessions.json", "refused"],
    ["sessions from a later window", { sessions: { since: SINCE + 24 * H, until: AT + 24 * H } }, "sessions.json", "refused"],
    ["pre until 1 ms after the window start", { pre: { until: SINCE + 1 } }, "pre.json", "refused"],
    ["pre until exactly the slack early", { pre: { until: SINCE - SLACK } }, "pre.json: until", { delta: "Δ -300.0 s" }],
    ["pre until 1 ms more than the slack early", { pre: { until: SINCE - SLACK - 1 } }, "pre.json", "refused"],
    ["pre from a later window", { pre: { until: SINCE + 24 * H } }, "pre.json", "refused"],
    ["summary until 1 ms after --at", { summary: { until: AT + 1 } }, "summary.json", "refused"],
    ["summary until 4 min after --at", { summary: { until: AT + 4 * MIN } }, "summary.json", "refused"],
    ["summary until exactly the slack early", { summary: { until: AT - SLACK } }, "summary.json: until", { delta: "Δ -300.0 s" }],
    ["summary until 1 ms more than the slack early", { summary: { until: AT - SLACK - 1 } }, "summary.json", "refused"],
    ["summary from a later window", { summary: { until: AT + 24 * H } }, "summary.json", "refused"],
  ];
  for (const [name, over, where, outcome] of windowCases) {
    test(`${name}: ${outcome === "refused" ? "refused" : "accepted"}`, async () => {
      const f = await oneCommit();
      const r = await runReplay(f, await writeFrozen(f, over));
      if (outcome !== "refused") {
        expect(r.err).toBe("");
        expect(r.code).toBe(0);
        // The Δ line: which file and field, and by how much.
        expect(r.out).toContain(where);
        expect(r.out).toContain(outcome.delta);
      } else {
        expect(r.code).toBe(1);
        expect(r.err).toContain(where);
        expect(r.err).toContain("another window");
        expect(r.err).toContain(`capture it again with \`${captureQuery(f, where)}\``);
        expect(r.out).not.toContain("ledger answers: frozen");
      }
    }, 30_000);
  }

  /** A bound past the window, per field and file: why it cannot be read. */
  const pastCases: [string, Frozen, string, string][] = [
    ["sessions until after --at", { sessions: { until: AT + 1 } }, "sessions.json", "it holds writes made after --at"],
    ["sessions since before the window start", { sessions: { since: SINCE - 1 } }, "sessions.json", "it holds sessions that had left the window by --at"],
    ["pre until after the window start", { pre: { until: SINCE + 1 } }, "pre.json", "it counts writes made inside the window as before it"],
    ["summary until after --at", { summary: { until: AT + 1 } }, "summary.json", "it holds writes made after --at"],
  ];
  for (const [name, over, file, why] of pastCases) {
    test(`${name}: the refusal names its own reason and the full capture route`, async () => {
      const f = await oneCommit();
      const r = await runReplay(f, await writeFrozen(f, over));
      expect(r.code).toBe(1);
      expect(r.err).toContain(`${file}: captured for another window`);
      expect(r.err).toContain(`${why}, so any offset is refused`);
      expect(r.err).not.toContain("rows --at had not seen");
      expect(r.err).toContain(`capture it again with \`${captureQuery(f, file)}\``);
    }, 30_000);
  }

  test("a sessions body that is not the sessions form says so, before any window check", async () => {
    for (const body of [[], null]) {
      const f = await oneCommit();
      const r = await runReplay(f, await writeFrozen(f, { raw: { sessions: body } }));
      expect(r.code).toBe(1);
      expect(r.err).toContain('does not echo form: "sessions" — upstream does not answer the sessions form yet');
      expect(r.err).not.toContain("window");
    }
  }, 30_000);

  test("a pre body that is not the summary form says so, before any window check", async () => {
    const f = await oneCommit();
    const r = await runReplay(f, await writeFrozen(f, { raw: { pre: [] } }));
    expect(r.code).toBe(1);
    expect(r.err).toContain("summary at window start answer did not parse");
    expect(r.err).not.toContain("window (");
  }, 30_000);

  test("a window recorded as an ISO string is named as such, not as missing", async () => {
    const f = await oneCommit();
    const r = await runReplay(f, await writeFrozen(f, { sessions: { until: new Date(AT).toISOString() } }));
    expect(r.code).toBe(1);
    expect(r.err).toContain("sessions.json");
    expect(r.err).toContain("records the window as string");
    expect(r.err).toContain("expected epoch ms");
    expect(r.err).toContain(captureQuery(f, "sessions.json"));
    expect(r.err).not.toContain("records no window");
  }, 30_000);

  test("a summary captured without until= is refused with the until= to capture it with", async () => {
    const f = await oneCommit();
    const r = await runReplay(f, await writeFrozen(f, { summary: { until: undefined } }));
    expect(r.code).toBe(1);
    expect(r.err).toContain("summary.json");
    expect(r.err).toContain("records no window");
    expect(r.err).toContain(captureQuery(f, "summary.json"));
  }, 30_000);

  test("a summary capture of this window is accepted, one from another window refused", async () => {
    const f = await oneCommit();
    const ok = await runReplay(f, await writeFrozen(f, { summary: {} }));
    expect(ok.err).toBe("");
    expect(ok.code).toBe(0);
    const bad = await runReplay(f, await writeFrozen(f, { summary: { until: AT - 24 * H } }));
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("summary.json");
    expect(bad.err).toContain("another window");
  }, 30_000);
});
