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
}

async function writeFrozen(f: Fixture, over: Frozen = {}): Promise<string[]> {
  const sessions = { form: "sessions", root: f.repo, since: SINCE, until: AT, limit: 200, truncated: false, sessions: [], ...over.sessions };
  const pre = { root: f.repo, pageCount: 0, bulk: 10, limit: 5000, truncated: false, until: SINCE, pages: [], ...over.pre };
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

describe("a signal mid-run", () => {
  /** The replay processes and hook sleepers a test started, killed after it
   *  only when an assertion failed first and left them running. */
  const started: number[] = [];
  afterEach(() => {
    for (const pid of started.splice(0)) {
      for (const target of [-pid, pid]) {
        try {
          process.kill(target, "SIGKILL");
        } catch {
          // not a group leader, or already gone
        }
      }
    }
  });

  /** A fixture whose post-checkout hook writes its pid to the returned marker,
   *  then holds the checkout for 20 s: the signal lands between the clone and
   *  the build. `ignoreTerm` makes the hook and its sleep ignore SIGTERM. */
  async function heldCheckout(ignoreTerm = false): Promise<{ f: Fixture; hooks: string; marker: string }> {
    const f = await fixture();
    await writeFile(path.join(f.repo, "a.md"), page("A"));
    await commit(f.repo, "a", AT - 2 * H, AT - 2 * H);
    const hooks = path.join(f.base, "hooks");
    const marker = path.join(f.base, "checkout-running");
    await mkdir(hooks);
    await writeFile(path.join(hooks, "post-checkout"), `#!/bin/sh\necho $$ > "${marker}"\n${ignoreTerm ? "trap '' TERM\nsleep 20" : "exec sleep 20"}\n`);
    await chmod(path.join(hooks, "post-checkout"), 0o755);
    return { f, hooks, marker };
  }

  /** Spawn the replay (its own process group, so a failed test can kill it
   *  all) and wait for the hook; returns the process and the hook's pid. */
  async function startHeld(f: Fixture, hooks: string, marker: string, env: Record<string, string> = {}) {
    const hookEnv = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: hooks };
    const proc = spawnReplay(f, await writeFrozen(f), { ...hookEnv, ...env }, true);
    started.push(proc.pid);
    const deadline = Date.now() + 20_000;
    while (!existsSync(marker) || !(await Bun.file(marker).text()).trim()) {
      if (Date.now() > deadline) throw new Error("the checkout hook never ran");
      await Bun.sleep(50);
    }
    const sleeper = Number((await Bun.file(marker).text()).trim());
    started.push(sleeper);
    expect(await clonesIn(f.scriptTmp)).toHaveLength(1);
    return { proc, sleeper };
  }

  /** Waits up to 2 s for `pid` to be reaped after its group is killed. */
  async function goneSoon(pid: number): Promise<boolean> {
    for (const until = Date.now() + 2_000; Date.now() < until; await Bun.sleep(50)) if (!alive(pid)) return true;
    return !alive(pid);
  }

  for (const [signal, code] of [
    ["SIGTERM", 143],
    ["SIGHUP", 129],
    ["SIGINT", 130],
  ] as const) {
    test(`${signal} removes the temp clone and stops the hook git started`, async () => {
      const { f, hooks, marker } = await heldCheckout();
      const { proc, sleeper } = await startHeld(f, hooks, marker);

      const sent = Date.now();
      proc.kill(signal);
      expect(await proc.exited).toBe(code);
      // The handler stops the git child instead of waiting out its 20 s hook.
      expect(Date.now() - sent).toBeLessThan(10_000);
      expect(await clonesIn(f.scriptTmp)).toEqual([]);
      // ...and the hook with it: killing git alone leaves `sleep` reparented.
      expect(await goneSoon(sleeper)).toBe(true);
    }, 40_000);
  }

  test("a git child and hook that ignore SIGTERM do not hold the exit", async () => {
    const { f, hooks, marker } = await heldCheckout(true);
    // A `git` on PATH that ignores SIGTERM and runs the real one under it.
    const realGit = Bun.which("git");
    if (!realGit) throw new Error("no git on PATH");
    const bin = path.join(f.base, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "git"), `#!/bin/sh\ntrap '' TERM\n"${realGit}" "$@"\n`);
    await chmod(path.join(bin, "git"), 0o755);
    const { proc, sleeper } = await startHeld(f, hooks, marker, { PATH: `${bin}:${process.env.PATH ?? ""}` });

    const sent = Date.now();
    proc.kill("SIGTERM");
    // A second signal, as a user would send on a stuck exit.
    const second = setTimeout(() => proc.kill("SIGINT"), 2_000);
    const exited = await Promise.race([proc.exited, Bun.sleep(10_000).then(() => "hung" as const)]);
    clearTimeout(second);
    expect(exited).not.toBe("hung");
    expect(Date.now() - sent).toBeLessThan(10_000);
    expect(await goneSoon(sleeper)).toBe(true);
  }, 40_000);
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
  }, 30_000);

  test("a sessions capture that records no window is refused", async () => {
    const f = await oneCommit();
    const r = await runReplay(f, await writeFrozen(f, { sessions: { since: undefined } }));
    expect(r.code).toBe(1);
    expect(r.err).toContain("sessions.json");
    expect(r.err).toContain("records no window");
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
