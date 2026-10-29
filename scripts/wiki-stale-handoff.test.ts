import { test, expect, describe } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "../src/test/temp-dir.ts";
import { COSTED_PAGE_CAP, gitRunner, planChecks, resolvePage, runGate, runHandoff, type Git, type PageRef } from "./wiki-stale-handoff.ts";
import type { FetchJson, PostJson, PostSse } from "./wiki-stale.ts";

/** Fixture repos get a repo-local identity: CI has no global one. */
const git = gitRunner();
async function g(cwd: string, ...args: string[]): Promise<string> {
  const r = await git(args, cwd, 20_000);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
const tmp = () => realpathSync(testTempDirSync(path.join(tmpdir(), "wiki-stale-handoff-")));
function write(root: string, rel: string, text: string) {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
}
/** A repo with `plans/a.md` and `repos/b.md` committed on `branch`. */
async function repo(branch = "main"): Promise<string> {
  const dir = tmp();
  await g(dir, "init", "-q", "-b", branch);
  await g(dir, "config", "user.name", "T");
  await g(dir, "config", "user.email", "t@example.com");
  write(dir, "plans/a.md", "# A\n");
  write(dir, "repos/b.md", "# B\n");
  await g(dir, "add", ".");
  await g(dir, "commit", "-q", "-m", "init");
  return dir;
}
/** A bare remote, a pushing clone and the main checkout cloned from it. */
async function withRemote(branch = "main"): Promise<{ bare: string; up: string; main: string }> {
  const up = await repo(branch);
  const bare = path.join(tmp(), "w.git");
  await g(path.dirname(bare), "clone", "-q", "--bare", up, bare);
  await g(up, "remote", "add", "origin", bare);
  await g(up, "fetch", "-q", "origin");
  const main = path.join(tmp(), "wiki");
  await g(path.dirname(main), "clone", "-q", bare, main);
  await g(main, "config", "user.name", "T");
  await g(main, "config", "user.email", "t@example.com");
  return { bare, up, main };
}
async function page(abs: string): Promise<PageRef> {
  const r = await resolvePage(abs, git);
  if ("skip" in r) throw new Error(r.skip);
  return r;
}

describe("resolvePage: absolute paths only, worktree paths mapped to the main checkout's relPath", () => {
  test("a relative path is refused; a worktree page and its main copy are one page", async () => {
    expect(await resolvePage("plans/a.md", git)).toEqual({ given: "plans/a.md", skip: "not an absolute path" });
    const main = await repo();
    await g(main, "branch", "fix");
    const wt = path.join(tmp(), "wt");
    await g(main, "worktree", "add", "-q", wt, "fix");
    const inMain = await page(path.join(main, "plans/a.md"));
    const inWt = await page(path.join(wt, "plans/a.md"));
    expect(inMain).toMatchObject({ rel: "plans/a.md", main, exists: true });
    expect(inMain.worktree).toBeUndefined();
    expect(inWt).toMatchObject({ rel: "plans/a.md", main, worktree: realpathSync(wt), exists: true });
  });

  test("a deleted page, its folder gone too, still maps", async () => {
    const main = await repo();
    rmSync(path.join(main, "repos"), { recursive: true });
    expect(await page(path.join(main, "repos/b.md"))).toMatchObject({ rel: "repos/b.md", main, exists: false });
  });
});

describe("the gate", () => {
  test("a clone on its default branch pulls fast-forward; committed and uncommitted pages", async () => {
    const { up, main } = await withRemote();
    write(up, "plans/a.md", "# A\nnew\n");
    await g(up, "commit", "-qam", "upstream");
    await g(up, "push", "-q", "origin", "main");
    write(main, "repos/b.md", "# B\ndirty\n");
    const gate = await runGate(main, [await page(path.join(main, "plans/a.md")), await page(path.join(main, "repos/b.md"))], git);
    expect(gate.lines).toEqual([
      "gate: pulled 1 commit(s) from origin/main",
      "gate: committed plans/a.md",
      "gate: uncommitted repos/b.md — commit your own edits to it path-scoped before --check, never hunks you did not make",
      "gate: Check skip — uncommitted edits on repos/b.md",
      `fix path: main checkout ${main}: repos/b.md uncommitted; ${dirtyNote(main)}; ${byHand(main)}`,
    ]);
  });

  test("gap: no upstream — a default branch with no tracking info still pulls, a remote without the branch is a note, not a skip", async () => {
    const { main } = await withRemote();
    await g(main, "branch", "--unset-upstream");
    expect((await runGate(main, [], git)).lines[0]).toBe("gate: up to date with origin/main");
    const { main: m2, bare } = await withRemote();
    await g(bare, "branch", "-m", "main", "trunk");
    const gate = await runGate(m2, [], git);
    expect(gate.skip).toBeUndefined();
    expect(gate.note).toBe("no upstream — origin has no branch main; nothing to pull");
  });

  test("gap: offline — the remote cannot be reached; a note, Check may still run", async () => {
    const { main } = await withRemote();
    await g(main, "remote", "set-url", "origin", "/nonexistent/wiki.git");
    const gate = await runGate(main, [await page(path.join(main, "plans/a.md"))], git);
    expect(gate.skip).toBeUndefined();
    expect(gate.note).toStartWith("offline — could not reach origin (");
    expect(gate.lines.at(-2)).toBe("gate: Check may run");
    // A pull that never answers is the same, bounded.
    const hung: Git = (args, cwd, ms) => (args.includes("pull") ? Promise.resolve({ code: -1, stdout: "", stderr: "", timedOut: true }) : git(args, cwd, ms));
    expect((await runGate(main, [], hung)).note).toBe("offline — could not reach origin (no answer in 30 s); the main checkout is as last pulled");
  });

  test("a pull that refuses (diverged) skips, with the worktree fix path", async () => {
    const { up, main } = await withRemote();
    write(up, "plans/a.md", "# A\nup\n");
    await g(up, "commit", "-qam", "up");
    await g(up, "push", "-q", "origin", "main");
    write(main, "plans/a.md", "# A\nlocal\n");
    await g(main, "commit", "-qam", "local");
    const gate = await runGate(main, [], git);
    expect(gate.skip).toStartWith("git pull --ff-only refused");
    expect(gate.fixPath).toBe(`fix in a worktree: git -C ${main} worktree add <dir> origin/main; commit there, git push origin HEAD:main. Check skips until ${main} pulls cleanly`);
  });

  test("defect 1: no remote and the main checkout on another branch — a fix path that needs no push", async () => {
    const main = await repo();
    await g(main, "checkout", "-q", "-b", "feature");
    const gate = await runGate(main, [], git);
    expect(gate.skip).toBe("main checkout on feature, not main");
    expect(gate.fixPath).toBe(`fix in a worktree on main: git -C ${main} worktree add <dir> main; commit there (no remote: the commit moves main itself). Check skips until ${main} is back on main`);
    expect(gate.fixPath).not.toContain("push");
    // The path works: a worktree on main, a commit there, and main moved.
    const wt = path.join(tmp(), "wt");
    await g(main, "worktree", "add", "-q", wt, "main");
    write(wt, "plans/a.md", "# A\nfixed\n");
    await g(wt, "commit", "-qam", "fix");
    expect(await g(main, "log", "-1", "--format=%s", "main")).toBe("fix");
  });

  test("no remote, on the default branch: nothing to pull, fix in place", async () => {
    const main = await repo();
    const gate = await runGate(main, [await page(path.join(main, "plans/a.md"))], git);
    expect(gate.lines[0]).toBe("gate: no remote, nothing to pull");
    expect(gate.skip).toBeUndefined();
    expect(gate.fixPath).toBe(byHand(main, false));
  });

  test("gap: a master default branch, with and without a remote", async () => {
    const local = await repo("master");
    const a = await runGate(local, [], git);
    expect([a.defaultBranch, a.skip]).toEqual(["master", undefined]);
    const { main } = await withRemote("master");
    const b = await runGate(main, [], git);
    expect([b.defaultBranch, b.skip, b.note]).toEqual(["master", undefined, "up to date with origin/master"]);
  });

  test("a detached HEAD skips and is named", async () => {
    const main = await repo();
    await g(main, "checkout", "-q", "--detach");
    expect((await runGate(main, [], git)).skip).toBe("main checkout on a detached HEAD, not main");
  });

  test("a worktree page: carried when the bytes match, NOT carried otherwise, with the by-hand fix path when there is no remote", async () => {
    const main = await repo();
    await g(main, "branch", "fix");
    const wt = path.join(tmp(), "wt");
    await g(main, "worktree", "add", "-q", wt, "fix");
    const carried = await runGate(main, [await page(path.join(wt, "plans/a.md"))], git);
    expect(carried.pages[0]!.state).toBe("carried");
    expect(carried.skip).toBeUndefined();
    write(wt, "plans/a.md", "# A\nfixed in the worktree\n");
    await g(wt, "commit", "-qam", "fix"); // batch 2: an uncommitted worktree edit is «uncommitted», not «NOT carried»
    const not = await runGate(main, [await page(path.join(wt, "plans/a.md"))], git);
    expect(not.pages[0]!.state).toBe("not-carried");
    expect(not.skip).toBe("the main checkout lacks your text of plans/a.md");
    expect(not.fixPath).toBe(`worktree ${realpathSync(wt)} (branch fix): plans/a.md not carried; ${byHand(main, false)}`);
  });

  test("fix round 1: the pull never autostashes or rebases, whatever the repo's config says", async () => {
    for (const cfg of [["merge.autoStash", "true"], ["pull.rebase", "true"], ["rebase.autoStash", "true"]] as const) {
      const { up, main } = await withRemote();
      write(up, "plans/a.md", "# A\nupstream\n");
      await g(up, "commit", "-qam", "upstream");
      await g(up, "push", "-q", "origin", "main");
      await g(main, "config", "merge.autoStash", "true");
      await g(main, "config", "rebase.autoStash", "true");
      await g(main, "config", cfg[0], cfg[1]);
      // Another session's uncommitted edit on the page the pull would change.
      write(main, "plans/a.md", "# A\nanother session's edit\n");
      const gate = await runGate(main, [], git);
      expect(readFileSync(path.join(main, "plans/a.md"), "utf8")).toBe("# A\nanother session's edit\n");
      expect(await g(main, "stash", "list")).toBe("");
      expect(gate.skip).toStartWith("git pull --ff-only refused (");
    }
  });

  test("defect 3: a deleted page is a state, not a skip; an uncommitted deletion asks for its commit", async () => {
    const main = await repo();
    rmSync(path.join(main, "repos/b.md"));
    const uncommitted = await runGate(main, [await page(path.join(main, "repos/b.md"))], git);
    expect(uncommitted.pages[0]!.state).toBe("deleted-uncommitted");
    expect(uncommitted.skip).toBe("uncommitted edits on repos/b.md");
    await g(main, "commit", "-qam", "delete b");
    const committed = await runGate(main, [await page(path.join(main, "repos/b.md")), await page(path.join(main, "nope/never.md"))], git);
    expect(committed.pages.map((p) => p.state)).toEqual(["deleted", "missing"]);
    expect(committed.skip).toBeUndefined();
    expect(committed.lines).toContain("gate: deleted repos/b.md — not a page to Check");
  });
});

/** Whether `pid` is gone within `ms`. */
async function diesWithin(pid: number, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
  }
  return false;
}
/** A test's own cleanup: no stub process outlives it. */
const reap = (...pids: number[]) => {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
};
async function waitFor(file: string, ms: number): Promise<void> {
  for (const end = Date.now() + ms; !existsSync(file); await Bun.sleep(20)) if (Date.now() > end) throw new Error(`no ${file} in ${ms} ms`);
}

describe("gitRunner: bounded, no shell, no prompt", () => {
  test("gap: https never prompts — the env every git call gets; a local call gets no ssh command (batch 2: network calls only)", async () => {
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_SSH")));
    const r = await gitRunner("env", base)([], tmpdir());
    expect(r.stdout).toContain("GIT_TERMINAL_PROMPT=0");
    expect(r.stdout).not.toContain("GIT_SSH_COMMAND=");
  });

  test("a call past its bound is killed and says so", async () => {
    const t0 = Date.now();
    const r = await gitRunner("sleep")(["5"], tmpdir(), 100);
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  test("fix round 1: a stalled remote whose helper's child holds the pipes still returns within the bound, the whole group killed", async () => {
    // A fake `stall::` remote helper: a child that keeps git's stderr (our pipe) open, then it waits too.
    // Fix round 2 batch 2: the child ignores SIGTERM, so only the SIGKILL after it ends the child; git may not start the helper
    // inside a short bound on a loaded machine, so the bound doubles until it has.
    const bin = tmp();
    const pidFile = path.join(bin, "child.pid");
    writeFileSync(path.join(bin, "git-remote-stall"), `#!/bin/sh\n(trap '' TERM; exec sleep 30) &\necho $! > ${pidFile}.tmp && mv ${pidFile}.tmp ${pidFile}\nsleep 30\n`);
    chmodSync(path.join(bin, "git-remote-stall"), 0o755);
    const main = await repo();
    const stallGit = gitRunner("git", { ...process.env, PATH: `${bin}:${process.env.PATH}` });
    for (let bound = 1_000; !existsSync(pidFile); bound *= 2) {
      if (bound > 8_000) throw new Error("git never started the stub helper");
      const t0 = Date.now();
      const r = await stallGit(["fetch", "stall::x"], main, bound);
      expect(r.timedOut).toBe(true);
      expect(Date.now() - t0).toBeLessThan(bound + 3_000);
    }
    const child = Number(readFileSync(pidFile, "utf8"));
    try {
      expect(await diesWithin(child, 2_000)).toBe(true);
    } finally {
      reap(child);
    }
  }, 40_000);

  test("fix round 1: a grandchild that leaves the group and keeps the pipe open does not hold the call past the bound", async () => {
    const bin = tmp();
    writeFileSync(path.join(bin, "git-remote-stall"), `#!/bin/sh\nperl -MPOSIX -e 'POSIX::setsid(); sleep 5' &\nsleep 30\n`);
    chmodSync(path.join(bin, "git-remote-stall"), 0o755);
    const main = await repo();
    const t0 = Date.now();
    const r = await gitRunner("git", { ...process.env, PATH: `${bin}:${process.env.PATH}` })(["fetch", "stall::x"], main, 500);
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3_000);
  }, 15_000);

  test("fix round 2 batch 2: a timed-out call that holds index.lock leaves no lock behind", async () => {
    // git removes its lock files on SIGTERM, not on SIGKILL: a pre-commit hook that sleeps holds index.lock past the bound.
    const main = await repo();
    const hookPid = path.join(main, "hook.pid");
    // The hook's own SIGTERM cleanup takes 0.3 s, as git's lock removal takes its time: the SIGKILL must wait for it.
    const cleaned = path.join(main, "hook.cleaned");
    writeFileSync(path.join(main, ".git/hooks/pre-commit"), `#!/bin/sh\n(trap '' TERM; exec sleep 30) </dev/null >/dev/null 2>&1 &\necho "$$ $!" > ${hookPid}\ntrap 'sleep 0.3; touch ${cleaned}; exit 1' TERM\nsleep 30\n`);
    chmodSync(path.join(main, ".git/hooks/pre-commit"), 0o755);
    write(main, "plans/a.md", "# A, edited\n");
    const r = await git(["commit", "-a", "-q", "-m", "x"], main, 700);
    // The hook, and a child of it that ignores SIGTERM and closed its pipes, so the call returns before the SIGKILL is due.
    const pids = existsSync(hookPid) ? readFileSync(hookPid, "utf8").trim().split(" ").map(Number) : [];
    try {
      expect(r.timedOut).toBe(true);
      expect(pids.length).toBe(2);
      expect(existsSync(path.join(main, ".git/index.lock"))).toBe(false);
      for (const pid of pids) expect([pid, await diesWithin(pid, 3_000)]).toEqual([pid, true]);
      expect(existsSync(cleaned)).toBe(true);
    } finally {
      reap(...pids);
    }
  }, 15_000);

  test("fix round 2 batch 2: SIGINT, SIGTERM, SIGHUP or an exit while a call stalls kills the call's whole group", async () => {
    // The helper's child ignores SIGTERM: only the SIGKILL that follows ends it.
    const bin = tmp();
    const helperPid = path.join(bin, "helper.pid");
    const childPid = path.join(bin, "child.pid");
    writeFileSync(path.join(bin, "git-remote-stall"), `#!/bin/sh\necho $$ > ${helperPid}\n(trap '' TERM; exec sleep 30) &\necho $! > ${childPid}.tmp && mv ${childPid}.tmp ${childPid}\nsleep 30\n`);
    chmodSync(path.join(bin, "git-remote-stall"), 0o755);
    const driver = path.join(bin, "driver.ts");
    writeFileSync(
      driver,
      `import { existsSync } from "node:fs";
import { gitRunner } from ${JSON.stringify(path.join(import.meta.dir, "wiki-stale-handoff.ts"))};
const [mode, main, bin] = process.argv.slice(2);
const call = gitRunner("git", { ...process.env, PATH: bin + ":" + process.env.PATH })(["fetch", "stall::x"], main, 60_000);
if (mode === "exit") {
  while (!existsSync(${JSON.stringify(childPid)})) await Bun.sleep(20);
  process.exit(0);
}
await call;
`,
    );
    const main = await repo();
    for (const [mode, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129], ["exit", 0]] as const) {
      rmSync(childPid, { force: true });
      rmSync(helperPid, { force: true });
      const proc = Bun.spawn([process.execPath, "--no-env-file", driver, mode, main, bin], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      let pids: number[] = [];
      try {
        await waitFor(childPid, 15_000);
        pids = [Number(readFileSync(helperPid, "utf8")), Number(readFileSync(childPid, "utf8"))];
        if (mode !== "exit") proc.kill(mode);
        const exited = await Promise.race([proc.exited, Bun.sleep(5_000).then(() => "hung")]);
        expect([mode, exited]).toEqual([mode, code]);
        for (const pid of pids) expect([mode, pid, await diesWithin(pid, 2_000)]).toEqual([mode, pid, true]);
      } finally {
        proc.kill("SIGKILL");
        reap(...pids);
      }
    }
  }, 90_000);

  test("fix round 1: an inherited GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE never aims a call at another repo", async () => {
    const other = await repo();
    await g(other, "commit", "-q", "--allow-empty", "-m", "the other repo");
    const main = await repo();
    const leaked = { GIT_DIR: path.join(other, ".git"), GIT_WORK_TREE: other, GIT_INDEX_FILE: path.join(other, ".git/index"), GIT_COMMON_DIR: path.join(other, ".git"), GIT_OBJECT_DIRECTORY: path.join(other, ".git/objects"), GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(other, ".git/objects"), GIT_NAMESPACE: "x", GIT_PREFIX: "repos/" };
    const r = await gitRunner("git", { ...process.env, ...leaked })(["log", "-1", "--format=%s"], main);
    expect(r.stdout.trim()).toBe("init");
    const env = (await gitRunner("env", { ...process.env, ...leaked })([], tmpdir())).stdout;
    for (const k of Object.keys(leaked)) expect(env).not.toContain(`\n${k}=`);
    expect(existsSync(path.join(main, ".git"))).toBe(true);
  });

  test("gap: git missing — every page is a line and the run ends in a Stale line", async () => {
    const out = await runHandoff(["--handoff", "--pages", "/x/plans/a.md"], { git: gitRunner("/nonexistent/bin/git") });
    expect(out).toEqual(["skipped /x/plans/a.md — git not found", "Stale: not checked (git not found — fix your own lines by hand)"]);
  });
});

// A stub muninn: page reports by relPath, Check streams, sends recorded.
type Linking = { relPath: string; verdict?: { verdict: string; reason?: string } };
type Page = { hits?: { line: number; target: string; text: string; confirmation?: unknown }[]; toCheck?: Linking[]; readonly?: string | false };
function muninn(
  pages: Record<string, Page>,
  opts: {
    verdicts?: Record<string, { relPath: string; verdict: string; edit?: { old: string; new: string } | null }[]>;
    failGet?: string[];
    failCheck?: string[];
    hangGet?: string[];
    /** The work memo's pages for any `--session`; `failSession` makes that ask unreachable. */
    session?: string[];
    failSession?: boolean;
    /** Pages answered with a body the shape guard refuses: a page error, «unexpected answer». */
    badGet?: string[];
  } = {},
) {
  const asked: string[] = [];
  const checked: string[] = [];
  const sent: string[] = [];
  const fetchJson: FetchJson = async (url, signal) => {
    const q = new URL(url).searchParams;
    if (q.get("session")) {
      if (opts.failSession) throw new Error("connection refused");
      return { status: 200, body: { wiki: "w", readonly: false, session: { found: (opts.session ?? []).length > 0, pages: opts.session ?? [] } } };
    }
    const rel = q.get("page") ?? "";
    asked.push(rel);
    if (opts.badGet?.includes(rel)) return { status: 200, body: { wiki: "w" } };
    if (opts.failGet?.includes(rel)) throw new Error("connection refused");
    // A muninn that never answers this page: the run's deadline aborts it.
    if (opts.hangGet?.includes(rel)) return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const p = pages[rel];
    if (!p) return { status: 404, body: { error: `no page ${rel}`, readonly: false } };
    const toCheck = p.toCheck ?? [];
    return {
      status: 200,
      body: {
        wiki: "w",
        readonly: p.readonly ?? false,
        page: { relPath: rel, title: rel },
        lastChangeMs: Date.parse("2026-10-28T00:00:00Z"),
        hits: (p.hits ?? []).map((h) => ({ said: ["proposed"], now: "shipped", confirmation: "unconfirmed", ...h })),
        buckets: toCheck.length
          ? { counts: { toCheck: toCheck.length }, linking: toCheck.map((l) => ({ ...l, title: l.relPath, bucket: "toCheck", passages: [{ line: 3, text: "t", claim: "date" }] })) }
          : null,
      },
    };
  };
  const postSse: PostSse = async (_url, body) => {
    const page = String(body.page);
    checked.push(page);
    if (opts.failCheck?.includes(page)) throw new Error("connection refused");
    const vs = opts.verdicts?.[page] ?? [];
    return {
      status: 200,
      events: (async function* () {
        yield { event: "start", data: { toCheck: vs.length, cached: 0, toCall: vs.length, left: 0 } };
        for (const v of vs) yield { event: "verdict", data: { reason: "r", cached: false, edit: null, ...v } };
        yield { event: "done", data: { calls: vs.length, verdicts: vs.length, errors: 0 } };
      })(),
    };
  };
  const postJson: PostJson = async (_url, body) => {
    sent.push(String(body.linking));
    return { status: 200, body: { ok: true, outcome: "sent", groupKey: "g", pages: [body.linking] } };
  };
  return { asked, checked, sent, deps: { fetchJson, postSse, postJson, env: {} } };
}

describe("runHandoff: two calls", () => {
  test("first call: gate, report, and only the session's own lines to fix; second call lists none of them once fixed and sends the rest", async () => {
    const main = await repo();
    const pages = ["--pages", path.join(main, "plans/a.md"), path.join(main, "repos/b.md")];
    const first = muninn({
      "plans/a.md": { hits: [{ line: 7, target: "plans/x.mdx", text: "- [[plans/x]] in-flight" }, { line: 9, target: "plans/y.mdx", text: "fine", confirmation: { verdict: "true" } }], toCheck: [{ relPath: "repos/b.md" }, { relPath: "repos/other.md" }] },
      "repos/b.md": {},
    });
    const out1 = await runHandoff(["--handoff", ...pages], { ...first.deps, git });
    const fix = out1.slice(out1.indexOf("fix by hand (your own pages; every other page goes through --check's sends):") + 1);
    expect(fix).toEqual([
      "  plans/a.md L7 after [[plans/x.mdx]]: - [[plans/x]] in-flight",
      "  repos/b.md L3 — to check after plans/a.md: read it against the change",
      "then: commit (and push) those fixes by the fix path, then run the same command with --check",
    ]);
    expect(out1.at(0)).toBe(`== ${path.basename(main)} (${main})`);
    expect(first.checked).toEqual([]);

    // The session fixed both; repos/other.md is stale with a drafted edit.
    const second = muninn(
      { "plans/a.md": { toCheck: [{ relPath: "repos/other.md" }] }, "repos/b.md": {} },
      { verdicts: { "plans/a.md": [{ relPath: "repos/other.md", verdict: "stale", edit: { old: "o", new: "n" } }] } },
    );
    const out2 = await runHandoff(["--handoff", "--check", ...pages], { ...second.deps, git });
    expect(second.sent).toEqual(["repos/other.md"]);
    expect(out2.at(-1)).toBe(`Stale: ${path.basename(main)} — 1 fixes sent to the Gardener`);
    expect(out2.join("\n")).not.toContain("plans/a.md — plans/a.md"); // reports read, not printed
  });

  test("defect 3: a deleted page does not block Check and is never asked for", async () => {
    const main = await repo();
    rmSync(path.join(main, "repos/b.md"));
    await g(main, "commit", "-qam", "delete b");
    const m = muninn({ "plans/a.md": { toCheck: [{ relPath: "repos/c.md" }] } }, { verdicts: { "plans/a.md": [{ relPath: "repos/c.md", verdict: "true" }] } });
    const out = await runHandoff(["--handoff", "--check", "--pages", path.join(main, "plans/a.md"), path.join(main, "repos/b.md")], { ...m.deps, git });
    expect(m.asked).toEqual(["plans/a.md"]);
    expect(m.checked).toEqual(["plans/a.md"]);
    expect(out).toContain("gate: Check may run");
    expect(out.at(-1)).toBe(`Stale: ${path.basename(main)} — nothing stale on the changed pages`);
  });

  test("defect 2: a muninn that fails mid-run keeps every verdict and send before it", async () => {
    const main = await repo();
    write(main, "plans/c.md", "# C\n");
    await g(main, "add", ".");
    await g(main, "commit", "-qm", "c");
    const m = muninn(
      { "plans/a.md": { toCheck: [{ relPath: "repos/x.md" }] }, "repos/b.md": { toCheck: [{ relPath: "repos/y.md" }] } },
      { failGet: ["plans/c.md"], failCheck: ["repos/b.md"], verdicts: { "plans/a.md": [{ relPath: "repos/x.md", verdict: "stale", edit: { old: "o", new: "n" } }] } },
    );
    const out = await runHandoff(["--handoff", "--check", "--pages", ...["plans/a.md", "repos/b.md", "plans/c.md"].map((r) => path.join(main, r))], { ...m.deps, git });
    expect(m.sent).toEqual(["repos/x.md"]);
    expect(out.at(-1)).toBe(
      `Stale: ${path.basename(main)} — 1 fixes sent to the Gardener; to check: plans/c.md (not reported: muninn not reachable), repos/y.md (connection refused)`,
    );
  });

  test("defect 4 and tag counting: the cap counts only pages that will spend model calls", async () => {
    const reports = (spec: [string, Linking[]][]) => spec.map(([rel, linking]) => ({ page: { relPath: rel }, buckets: { linking: linking.map((l) => ({ ...l, bucket: "toCheck" })) } }));
    const cached = (r: string): Linking => ({ relPath: r, verdict: { verdict: "stale" } });
    // 3 costed + 2 whose To-check verdicts are all cached (a [stale] tag included): every page runs.
    const fits = planChecks(reports([["a", [{ relPath: "x" }]], ["b", [{ relPath: "y" }, cached("z")]], ["c", [{ relPath: "w" }]], ["d", [cached("v")]], ["e", [cached("u"), { relPath: "t", verdict: { verdict: "true" } }]]]));
    expect(fits).toEqual({ check: ["d", "e", "a", "b", "c"], costed: ["a", "b", "c"], free: ["d", "e"], overCap: false });
    // One costed page over the cap: only the free ones run.
    const over = planChecks(reports([["a", [{ relPath: "x" }]], ["b", [{ relPath: "y" }]], ["c", [{ relPath: "w" }]], ["f", [{ relPath: "s" }]], ["d", [cached("v")]]]));
    expect(over).toMatchObject({ check: ["d"], overCap: true });
    expect(COSTED_PAGE_CAP).toBe(3);
  });

  test("over the cap, the skipped pages are listed with the reason and the bound is printed", async () => {
    const main = await repo();
    const rels = ["p1.md", "p2.md", "p3.md", "p4.md"];
    for (const r of rels) write(main, r, "x\n");
    await g(main, "add", ".");
    await g(main, "commit", "-qm", "pages");
    const m = muninn(Object.fromEntries(rels.map((r, i) => [r, { toCheck: [{ relPath: `o${i}.md` }] }])));
    const out = await runHandoff(["--handoff", "--check", "--pages", ...rels.map((r) => path.join(main, r))], { ...m.deps, git, now: () => 0 });
    expect(m.checked).toEqual([]);
    expect(out).toContain("Check: 4 page(s) spend model calls — over 3, so only the 0 cached one(s) run, 0 cached only; bound ≤ 0 model calls, ≤ 1 min for the whole run (the gate took 0 s)");
    expect(out.at(-1)).toContain("to check: o0.md (Check skipped: over 3 pages), o1.md (Check skipped: over 3 pages)");
  });

  test("gap: a readonly wiki says so, and its To-check pages are listed as Check skipped", async () => {
    const main = await repo();
    const m = muninn({ "plans/a.md": { readonly: "root", toCheck: [{ relPath: "repos/z.md" }] } });
    const out = await runHandoff(["--handoff", "--check", "--pages", path.join(main, "plans/a.md")], { ...m.deps, git });
    expect(m.checked).toEqual([]);
    expect(out.at(-1)).toBe(`Stale: ${path.basename(main)} — to check: repos/z.md (Check skipped: readonly wiki); check unavailable: readonly wiki`);
  });

  test("a gate skip (no remote, feature branch) reads the reports, runs no Check, and names the reason", async () => {
    const main = await repo();
    await g(main, "checkout", "-q", "-b", "feature");
    const m = muninn({ "plans/a.md": { toCheck: [{ relPath: "repos/z.md" }] } });
    const out = await runHandoff(["--handoff", "--check", "--pages", path.join(main, "plans/a.md")], { ...m.deps, git });
    expect(m.checked).toEqual([]);
    expect(out.at(-1)).toBe(`Stale: ${path.basename(main)} — to check: plans/a.md (not re-read: main checkout on feature, not main), repos/z.md (Check skipped: main checkout on feature, not main)`);
  });

  test("muninn not reachable on the first call: a Stale line at once, nothing for --check to add", async () => {
    const main = await repo();
    const out = await runHandoff(["--handoff", "--pages", path.join(main, "plans/a.md"), "--base-url", "http://127.0.0.1:9"], { git, env: {} });
    expect(out.slice(-2)).toEqual([
      "fix by hand: no report (muninn not reachable) — read your own pages for status lines yourself",
      `Stale: ${path.basename(main)} — not checked (muninn not reachable)`,
    ]);
  });

  test("a page named by its main copy and its worktree copy is reported once", async () => {
    const main = await repo();
    await g(main, "branch", "fix");
    const wt = path.join(tmp(), "wt");
    await g(main, "worktree", "add", "-q", wt, "fix");
    const m = muninn({ "plans/a.md": {} });
    await runHandoff(["--handoff", "--pages", path.join(main, "plans/a.md"), path.join(wt, "plans/a.md")], { ...m.deps, git });
    expect(m.asked).toEqual(["plans/a.md"]);
  });

  test("usage: a relative page, a relative --main, --wiki over two repos — each a line and a Stale line", async () => {
    expect(await runHandoff(["--handoff", "--pages", "plans/a.md"], { git })).toEqual(["skipped plans/a.md — not an absolute path", "Stale: not checked (no page could be mapped to a wiki)"]);
    expect(await runHandoff(["--handoff", "--main", "wiki", "--pages", "/a.md"], { git })).toEqual([
      "wiki-stale: --main must be an absolute path (or ~/…), not wiki",
      "Stale: not checked (--main is not an absolute path)",
    ]);
    const [a, b] = [await repo(), await repo()];
    const out = await runHandoff(["--handoff", "--wiki", "w", "--pages", path.join(a, "plans/a.md"), path.join(b, "plans/a.md")], { git });
    expect(out.at(-1)).toBe("Stale: not checked (--wiki with pages in several repos)");
    expect(await runHandoff(["--handoff"], { git })).toEqual(["Stale: not checked (no wiki page changed)"]);
  });

  test("the script exits 0 with --handoff and its last line is a Stale line", async () => {
    const proc = Bun.spawn(["bun", "--no-env-file", `${import.meta.dir}/wiki-stale.ts`, "--handoff", "--pages", "relative.md"], { stdout: "pipe", stderr: "pipe" });
    const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    expect(code).toBe(0);
    expect(out.trim().split("\n").at(-1)).toBe("Stale: not checked (no page could be mapped to a wiki)");
  });
});

// Fix round 1 batch 2: the user's ssh, worktree dirt.

describe("fix round 1 batch 2: the user's ssh command is kept, and an auth failure is not «offline»", () => {
  const noSshEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_SSH")));
  /** A main checkout whose origin is an ssh URL; `ssh` on PATH and a user's own ssh, both local stubs that log their argv. */
  async function sshSetup() {
    const { main } = await withRemote();
    await g(main, "remote", "set-url", "origin", "ssh://git@example.invalid/wiki.git");
    const bin = tmp();
    const log = path.join(bin, "ssh.log");
    writeFileSync(path.join(bin, "ssh"), `#!/bin/sh\necho "default $*" >> '${log}'\necho "ssh: Could not resolve hostname example.invalid: nodename nor servname provided, or not known" >&2\nexit 255\n`);
    writeFileSync(path.join(bin, "userssh"), `#!/bin/sh\necho "user $*" >> '${log}'\necho "git@example.invalid: Permission denied (publickey)." >&2\nexit 255\n`);
    chmodSync(path.join(bin, "ssh"), 0o755);
    chmodSync(path.join(bin, "userssh"), 0o755);
    const env = { ...noSshEnv(), PATH: `${bin}:${process.env.PATH}` };
    const logged = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
    return { main, bin, env, logged, user: path.join(bin, "userssh") };
  }
  const authNote = "not authorized — could not authenticate to origin (git@example.invalid: Permission denied (publickey).); the main checkout is as last pulled";

  test("nothing configured: the pull's ssh runs in batch mode, and a host it cannot reach is offline", async () => {
    const s = await sshSetup();
    const gate = await runGate(s.main, [], gitRunner("git", s.env));
    expect(s.logged()).toContain("default -o BatchMode=yes -o ConnectTimeout=10");
    expect(gate.note).toStartWith("offline — could not reach origin (ssh: Could not resolve hostname");
    expect(gate.skip).toBeUndefined();
  });

  test("the repo's core.sshCommand is used as configured", async () => {
    const s = await sshSetup();
    await g(s.main, "config", "core.sshCommand", s.user);
    const gate = await runGate(s.main, [], gitRunner("git", s.env));
    expect(s.logged()).toContain("user ");
    expect(s.logged()).not.toContain("default ");
    expect(gate.note).toBe(authNote);
  });

  test("a GIT_SSH_COMMAND or GIT_SSH in the environment is used as configured", async () => {
    for (const k of ["GIT_SSH_COMMAND", "GIT_SSH"]) {
      const s = await sshSetup();
      const gate = await runGate(s.main, [], gitRunner("git", { ...s.env, [k]: s.user }));
      expect([k, s.logged().includes("user "), s.logged().includes("default ")]).toEqual([k, true, false]);
      expect(gate.note).toBe(authNote);
    }
  });

  test("auth and permission failures are their own note; network failures stay offline", async () => {
    const { main } = await withRemote();
    const pullSays = (stderr: string): Git => (args, cwd, ms) => (args.includes("pull") ? Promise.resolve({ code: 128, stdout: "", stderr }) : git(args, cwd, ms));
    const cases: [string, "auth" | "offline"][] = [
      ["git@h: Permission denied (publickey).\nfatal: Could not read from remote repository.", "auth"],
      ["Host key verification failed.\nfatal: Could not read from remote repository.", "auth"],
      ["fatal: could not read Username for 'https://h': terminal prompts disabled", "auth"],
      ["remote: Invalid username or password.\nfatal: Authentication failed for 'https://h/'", "auth"],
      ["fatal: unable to access 'https://h/': The requested URL returned error: 403", "auth"],
      ["ERROR: Permission to o/w.git denied to someone.\nfatal: Could not read from remote repository.", "auth"],
      ["ssh: Could not resolve hostname h: nodename nor servname provided\nfatal: Could not read from remote repository.", "offline"],
      ["fatal: unable to access 'https://h/': Could not resolve host: h", "offline"],
      ["ssh: connect to host h port 22: Connection refused\nfatal: Could not read from remote repository.", "offline"],
    ];
    for (const [stderr, kind] of cases) {
      const gate = await runGate(main, [], pullSays(stderr));
      expect([stderr, gate.note?.split(" — ")[0], gate.skip]).toEqual([stderr, kind === "auth" ? "not authorized" : "offline", undefined]);
    }
  });
});

describe("fix round 1 batch 2: a worktree page is carried only when its committed text is the main checkout's clean copy", () => {
  async function wtSetup() {
    const main = await repo();
    await g(main, "branch", "fix");
    const wt = path.join(tmp(), "wt");
    await g(main, "worktree", "add", "-q", wt, "fix");
    return { main, wt };
  }

  test("uncommitted edits in the worktree are uncommitted, even when the main copy has the same uncommitted bytes", async () => {
    const { main, wt } = await wtSetup();
    write(wt, "plans/a.md", "# A\nsame edit\n");
    write(main, "plans/a.md", "# A\nsame edit\n");
    const gate = await runGate(main, [await page(path.join(wt, "plans/a.md"))], git);
    expect(gate.pages[0]!.state).toBe("uncommitted");
    expect(gate.lines).toContain(`gate: uncommitted plans/a.md (worktree ${realpathSync(wt)}) — commit your own edits to it path-scoped before --check, never hunks you did not make`);
    expect(gate.skip).toBe("uncommitted edits on plans/a.md");
  });

  test("an uncommitted new page in the worktree is uncommitted", async () => {
    const { main, wt } = await wtSetup();
    write(wt, "plans/new.md", "# New\n");
    const gate = await runGate(main, [await page(path.join(wt, "plans/new.md"))], git);
    expect(gate.pages[0]!.state).toBe("uncommitted");
  });

  test("the main copy holding the worktree's text as an uncommitted edit is not carried", async () => {
    const { main, wt } = await wtSetup();
    write(wt, "plans/a.md", "# A\nfixed\n");
    await g(wt, "commit", "-qam", "fix");
    write(main, "plans/a.md", "# A\nfixed\n");
    const gate = await runGate(main, [await page(path.join(wt, "plans/a.md"))], git);
    expect(gate.pages[0]!.state).toBe("main-uncommitted");
    expect(gate.lines).toContain(`gate: NOT carried plans/a.md (worktree ${realpathSync(wt)}) — the main copy has uncommitted edits, which Check would read instead of your commit`);
    expect(gate.skip).toBe("uncommitted edits on the main copy of plans/a.md");
  });

  test("committed in the worktree and merged into a clean main: carried", async () => {
    const { main, wt } = await wtSetup();
    write(wt, "plans/a.md", "# A\nfixed\n");
    await g(wt, "commit", "-qam", "fix");
    await g(main, "merge", "-q", "--ff-only", "fix");
    const gate = await runGate(main, [await page(path.join(wt, "plans/a.md"))], git);
    expect(gate.pages[0]!.state).toBe("carried");
    expect(gate.skip).toBeUndefined();
  });
});

// Rebuild (Rune, 29.10): the fix path is text only — no git command the session could paste.
const RUNNABLE = /\bgit\s+(-C\s+\S+\s+)?(push|merge|cherry-pick|commit|pull|rebase|reset|stash|checkout)\b/;
const FORBIDDEN = /\brebase\b|\bstash\b|\breset\b|--force|commit or settle/;
const byHand = (main: string, remote = true) =>
  `carry your commits into ${main} by hand (merge or cherry-pick), commit only your own edits${remote ? `, push main to origin — first check that the unpushed commits in ${main} are yours to push —` : ""}, then rerun --handoff`;
const pushOnly = (main: string) => `push main from ${main} to origin (check its unpushed commits are yours first), then rerun --handoff`;
const dirtyNote = (main: string) => `${main} holds uncommitted edits: leave any you did not make`;
const count = (s: string, part: string) => s.split(part).length - 1;
async function identity(dir: string) {
  await g(dir, "config", "user.name", "T");
  await g(dir, "config", "user.email", "t@example.com");
}

describe("class check: the fix path is text — main dirty × worktrees × remote × main pages × main ahead", () => {
  interface Cell { dirty: boolean; wts: 0 | 1 | 2; remote: boolean; mainPage: boolean; ahead: boolean }
  const cells: Cell[] = [];
  for (const dirty of [false, true])
    for (const wts of [0, 1, 2] as const)
      for (const remote of [true, false])
        for (const mainPage of [true, false])
          // Ahead of a remote needs a remote.
          for (const ahead of remote ? [false, true] : [false]) cells.push({ dirty, wts, remote, mainPage, ahead });

  /**
   * Every cell lists plans/s.md through worktree 0, which carries nothing (ready, never named). «main page» adds
   * repos/b.md, committed (ready), and plans/m.md, new and uncommitted, in main. Worktree 1 (branch fix1) commits
   * plans/a.md; worktree 2 (detached) commits plans/c.md. «dirty» edits notes/u.md in main, a file no page names;
   * «ahead» commits notes/n.md in main, unpushed.
   */
  async function build(c: Cell) {
    const main = c.remote ? (await withRemote()).main : await repo();
    for (const rel of ["plans/c.md", "plans/s.md", "notes/u.md"]) write(main, rel, `# ${rel}\n`);
    await g(main, "add", ".");
    await g(main, "commit", "-qm", "more pages");
    if (c.remote) await g(main, "push", "-q", "origin", "main");
    const wts: string[] = [];
    for (let k = 0; k <= c.wts; k++) {
      const wt = path.join(tmp(), `wt${k}`);
      await g(main, "worktree", "add", "-q", ...(k === 2 ? ["--detach"] : ["-b", `fix${k}`]), wt, "main");
      if (k) {
        const rel = k === 1 ? "plans/a.md" : "plans/c.md";
        write(wt, rel, `# fixed in worktree ${k}\n`);
        await g(wt, "commit", "-qm", `worktree ${k}`, "--", rel);
      }
      wts.push(realpathSync(wt));
    }
    if (c.ahead) {
      write(main, "notes/n.md", "# another session's commit\n");
      await g(main, "add", "notes/n.md");
      await g(main, "commit", "-qm", "unpushed");
    }
    if (c.mainPage) write(main, "plans/m.md", "# the session's new page\n");
    if (c.dirty) write(main, "notes/u.md", "# another session's edit\n");
    const pages = [
      path.join(wts[0]!, "plans/s.md"),
      ...(c.mainPage ? [path.join(main, "repos/b.md"), path.join(main, "plans/m.md")] : []),
      ...(wts[1] ? [path.join(wts[1], "plans/a.md")] : []),
      ...(wts[2] ? [path.join(wts[2], "plans/c.md")] : []),
    ];
    return { main, wts, pages };
  }
  const name = (c: Cell) =>
    `main ${c.dirty ? "dirty" : "clean"}, ${c.wts} worktree(s) to carry, ${c.remote ? "remote" : "no remote"}, main page ${c.mainPage ? "present" : "absent"}, ${c.ahead ? "main ahead" : "not ahead"}`;

  for (const c of cells) {
    test(name(c), async () => {
      const { main, wts, pages } = await build(c);
      const gate = await runGate(main, await Promise.all(pages.map(page)), git);
      const fp = gate.fixPath;
      const bad: string[] = [];
      const want = (ok: boolean, what: string) => ok || bad.push(what);
      want(gate.lines.at(-1) === `fix path: ${fp}`, "the gate's last line is the fix path");
      want(!RUNNABLE.test(fp), `no runnable git command (got ${fp.match(RUNNABLE)?.[0]})`);
      want(!FORBIDDEN.test(fp), "no rebase/stash/reset/--force/«commit or settle»");
      // Every page not ready, with its state, under its checkout; the ready ones are not named.
      if (c.mainPage) want(fp.includes(`main checkout ${main}: plans/m.md uncommitted`), "main page named with its state");
      else want(!fp.includes("main checkout"), "no main checkout entry");
      if (wts[1]) want(fp.includes(`worktree ${wts[1]} (branch fix1): plans/a.md not carried`), "worktree 1 named with its page's state");
      if (wts[2]) want(fp.includes(`worktree ${wts[2]} (detached HEAD ${await g(wts[2], "rev-parse", "--short", "HEAD")}): plans/c.md not carried`), "worktree 2 named with its page's state");
      want(count(fp, "worktree ") === c.wts, "only the worktrees to carry are named");
      for (const ready of ["repos/b.md", "plans/s.md"]) want(!fp.includes(ready), `ready page ${ready} not named`);
      // The dirty note iff the main checkout holds an uncommitted edit (the unrelated file, or the session's new page).
      want(count(fp, dirtyNote(main)) === (c.dirty || c.mainPage ? 1 : 0), "dirty note iff main is dirty");
      // One instruction line, or the push line when main is ahead and no page needs a carry.
      const pushCell = c.ahead && !c.mainPage && !c.wts;
      want(count(fp, byHand(main, c.remote)) === (pushCell ? 0 : 1), pushCell ? "no instruction line" : "the instruction line once");
      want(count(fp, pushOnly(main)) === (pushCell ? 1 : 0), pushCell ? "the push line once" : "no push line");
      // The push clause iff a remote; the «commits not on» state only beside the instruction line.
      want(/\bpush\b/.test(fp) === c.remote, "push clause iff a remote");
      want(count(fp, `main in ${main} has commits not on origin`) === (c.ahead && !pushCell ? 1 : 0), "ahead state beside the instruction line");
      expect(bad).toEqual([]);
    }, 30_000);
  }

  test("a dirty main copy of a worktree page: named with its state, the dirty note, and no command", async () => {
    const { main, wts, pages } = await build({ dirty: false, wts: 1, remote: true, mainPage: false, ahead: false });
    write(main, "plans/s.md", "# another session's edit\n");
    const gate = await runGate(main, await Promise.all(pages.map(page)), git);
    expect(gate.pages.map((p) => p.state)).toEqual(["main-uncommitted", "not-carried"]);
    expect(gate.fixPath).toBe(
      `worktree ${wts[0]} (branch fix0): plans/s.md main copy uncommitted; worktree ${wts[1]} (branch fix1): plans/a.md not carried; ${dirtyNote(main)}; the main copy of plans/s.md is probably another session's: Check skips it; rerun once that session has committed, or list plans/s.md in your resume prompt; ${byHand(main)}`,
    );
  });

  test("a main copy edit that status cannot see (skip-worktree) still gets the dirty note", async () => {
    const { main, pages } = await build({ dirty: false, wts: 1, remote: true, mainPage: false, ahead: false });
    await g(main, "update-index", "--skip-worktree", "plans/s.md");
    write(main, "plans/s.md", "# another session's hidden edit\n");
    expect(await g(main, "status", "--porcelain", "--untracked-files=no")).toBe("");
    const gate = await runGate(main, await Promise.all(pages.map(page)), git);
    expect(count(gate.fixPath, dirtyNote(main))).toBe(1);
    expect(gate.fixPath.endsWith(byHand(main))).toBe(true);
  });

  test("a remote without the default branch: the main checkout's commits are unpushed, never «not ahead»", async () => {
    const main = await repo();
    const bare = path.join(tmp(), "empty.git");
    await g(path.dirname(bare), "init", "-q", "--bare", bare);
    await g(main, "remote", "add", "origin", bare);
    const wt = path.join(tmp(), "wt");
    await g(main, "worktree", "add", "-q", "-b", "fix", wt, "main");
    const gate = await runGate(main, [await page(path.join(wt, "plans/a.md"))], git);
    expect([gate.note, gate.pages[0]!.state]).toEqual(["no upstream — origin has no branch main; nothing to pull", "carried"]);
    expect(gate.fixPath).toBe(pushOnly(main));
  });

  test("one detached worktree without a remote: named by its short sha, and no command reads its HEAD", async () => {
    const { main, wts, pages } = await build({ dirty: false, wts: 0, remote: false, mainPage: false, ahead: false });
    const wt = path.join(tmp(), "wtd");
    await g(main, "worktree", "add", "-q", "--detach", wt, "main");
    write(wt, "plans/a.md", "# fixed, detached\n");
    await g(wt, "commit", "-qm", "detached fix", "--", "plans/a.md");
    const gate = await runGate(main, await Promise.all([...pages, path.join(wt, "plans/a.md")].map(page)), git);
    expect(gate.fixPath).toBe(`worktree ${realpathSync(wt)} (detached HEAD ${await g(wt, "rev-parse", "--short", "HEAD")}): plans/a.md not carried; ${byHand(main, false)}`);
    expect(wts).toHaveLength(1);
  });
});

describe("class check: the fix path names worktrees and paths as they are", () => {
  /** A clone with a worktree on `fix` from origin/main; the worktree's page committed there. */
  async function remoteWt(opts: { mainName?: string; wtName?: string } = {}) {
    const { main: m0, bare } = await withRemote();
    let main = m0;
    if (opts.mainName) {
      main = path.join(path.dirname(m0), opts.mainName);
      await g(path.dirname(m0), "clone", "-q", bare, main);
      await identity(main);
    }
    const wt = path.join(tmp(), opts.wtName ?? "wt");
    await g(main, "worktree", "add", "-q", "-b", "fix", wt, "origin/main");
    write(wt, "plans/a.md", "# A\nfixed in the worktree\n");
    await g(wt, "commit", "-qm", "worktree fix", "--", "plans/a.md");
    return { main, wt: realpathSync(wt), bare };
  }

  test("worktree branch already pushed as -u origin fix: named by its branch, and fix and origin/fix are not touched", async () => {
    const { main, wt } = await remoteWt();
    await g(wt, "push", "-q", "-u", "origin", "fix");
    const refs = await g(main, "for-each-ref", "--format=%(refname) %(objectname)");
    const gate = await runGate(main, [await page(path.join(wt, "plans/a.md"))], git);
    expect(gate.fixPath).toBe(`worktree ${wt} (branch fix): plans/a.md not carried; ${byHand(main)}`);
    expect(await g(main, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(refs);
    expect(await g(wt, "status", "-sb")).toBe("## fix...origin/fix");
  });

  test("paths with spaces and a quote are quoted", async () => {
    const { main, wt } = await remoteWt({ mainName: "my wiki's", wtName: "my wt" });
    write(wt, "my notes/a b.md", "# new page\n");
    await g(wt, "add", "my notes/a b.md");
    await g(wt, "commit", "-qm", "spaced page", "--", "my notes/a b.md");
    const gate = await runGate(main, [await page(path.join(wt, "plans/a.md")), await page(path.join(wt, "my notes/a b.md"))], git);
    const q = `'${main.replace(/'/g, `'\\''`)}'`;
    expect(gate.fixPath).toBe(`worktree '${wt}' (branch fix): plans/a.md not carried, 'my notes/a b.md' not carried; ${byHand(q)}`);
  });

  test("two pages in one worktree: one entry for that worktree, both pages in it", async () => {
    const { main, wt } = await remoteWt();
    write(wt, "repos/b.md", "# B\nfixed in the worktree\n");
    await g(wt, "commit", "-qm", "b", "--", "repos/b.md");
    const gate = await runGate(main, [await page(path.join(wt, "plans/a.md")), await page(path.join(wt, "repos/b.md"))], git);
    expect(gate.fixPath).toBe(`worktree ${wt} (branch fix): plans/a.md not carried, repos/b.md not carried; ${byHand(main)}`);
  });
});
// Fix round 2 batch 1: call 2's Stale line lists what is open now. No fixed count, and nothing is saved between the calls.
describe("fix round 2 batch 1: the Stale line lists what is open, and nothing is saved between the calls", () => {
  const hit = (line: number, target: string) => ({ line, target, text: `- [[${target}]] in-flight` });
  const pagesOf = (root: string, rels: string[]) => ["--pages", ...rels.map((r) => path.join(root, r))];

  test("(a) an own hit the session fixed is not listed, and the line says nothing about fixes", async () => {
    const main = await repo();
    const pages = pagesOf(main, ["plans/a.md"]);
    await runHandoff(["--handoff", ...pages], { ...muninn({ "plans/a.md": { hits: [hit(7, "plans/x.mdx")] } }).deps, git });
    write(main, "plans/a.md", "# A\nfixed\n");
    await g(main, "commit", "-qam", "fix a");
    const out = await runHandoff(["--handoff", "--check", ...pages], { ...muninn({ "plans/a.md": {} }).deps, git });
    expect(out.at(-1)).toBe(`Stale: ${path.basename(main)} — nothing stale on the changed pages`);
  });

  test("(b) an own hit still stale is listed with its label, whether or not a first call ran or the session edited it", async () => {
    const main = await repo();
    const pages = pagesOf(main, ["plans/a.md", "repos/b.md"]);
    const still = { "plans/a.md": { hits: [hit(7, "plans/x.mdx")] }, "repos/b.md": { hits: [{ ...hit(4, "plans/y.mdx"), confirmation: { verdict: "stale" } }] } };
    const want = `Stale: ${path.basename(main)} — to check: plans/a.md (unconfirmed status line L7, yours), repos/b.md (stale status line L4, yours)`;
    expect((await runHandoff(["--handoff", "--check", ...pages], { ...muninn(still).deps, git })).at(-1)).toBe(want);
    // Call 1, then an edit that leaves plans/a.md's line stale with new text: still listed, never «fixed».
    await runHandoff(["--handoff", ...pages], { ...muninn(still).deps, git });
    write(main, "plans/a.md", "# A\nedited\n");
    await g(main, "commit", "-qam", "edit a");
    const edited = { ...still, "plans/a.md": { hits: [{ line: 7, target: "plans/x.mdx", text: "- [[plans/x]] still in-flight" }] } };
    expect((await runHandoff(["--handoff", "--check", ...pages], { ...muninn(edited).deps, git })).at(-1)).toBe(want);
  });

  test("(c) an own page call 2 could not read is listed with its reason: uncommitted, not carried, no page, unreachable, deadline, gate-wide skip", async () => {
    const main = await repo();
    await g(main, "branch", "fix");
    const wt = path.join(tmp(), "wt");
    await g(main, "worktree", "add", "-q", wt, "fix");
    write(wt, "plans/a.md", "# A\nfixed in the worktree\n");
    await g(wt, "commit", "-qam", "fix a");
    write(main, "repos/b.md", "# B\nfixed, uncommitted\n");
    write(main, "plans/c.md", "# C\n");
    await g(main, "add", "plans/c.md");
    await g(main, "commit", "-qm", "c");
    const name = path.basename(main);
    // The reports read the main checkout's text, so they still show the hits the session fixed.
    const stale = { "plans/a.md": { hits: [hit(7, "plans/x.mdx")] }, "repos/b.md": { hits: [hit(4, "plans/y.mdx")] } };
    const out = await runHandoff(["--handoff", "--check", "--pages", path.join(wt, "plans/a.md"), path.join(main, "repos/b.md"), path.join(main, "plans/c.md")], { ...muninn(stale).deps, git });
    expect(out.at(-1)).toBe(`Stale: ${name} — to check: plans/a.md (not re-read: not carried), repos/b.md (not re-read: uncommitted), plans/c.md (not re-read: not in the main checkout)`);

    // A clean checkout: the report stops at an unreachable muninn, or at the deadline.
    const m2 = await repo();
    const p2 = pagesOf(m2, ["plans/a.md", "repos/b.md"]);
    const n2 = path.basename(m2);
    const down = await runHandoff(["--handoff", "--check", ...p2], { ...muninn(stale, { failGet: ["repos/b.md"] }).deps, git });
    expect(down.at(-1)).toBe(`Stale: ${n2} — to check: plans/a.md (unconfirmed status line L7, yours), repos/b.md (not reported: muninn not reachable)`);
    const slow = await runHandoff(["--handoff", "--check", ...p2], { ...muninn(stale, { hangGet: ["repos/b.md"] }).deps, git, deadlineMs: 1000 });
    expect(slow.at(-1)).toBe(`Stale: ${n2} — to check: plans/a.md (unconfirmed status line L7, yours), repos/b.md (not reported: muninn did not answer in 1 s)`);

    // The main checkout on another branch: no page reads the session's text.
    await g(m2, "checkout", "-q", "-b", "feature");
    const wide = await runHandoff(["--handoff", "--check", ...p2], { ...muninn({ "plans/a.md": {}, "repos/b.md": {} }).deps, git });
    expect(wide.at(-1)).toBe(`Stale: ${n2} — to check: plans/a.md (not re-read: main checkout on feature, not main), repos/b.md (not re-read: main checkout on feature, not main)`);
  });

  test("(d) neither call writes a file under the OS temp dir", async () => {
    const main = await repo();
    const t = tmp();
    const pages = pagesOf(main, ["plans/a.md"]);
    const old = process.env.TMPDIR;
    process.env.TMPDIR = t;
    try {
      await runHandoff(["--handoff", ...pages], { ...muninn({ "plans/a.md": { hits: [hit(7, "plans/x.mdx")] } }).deps, git });
      expect(readdirSync(t)).toEqual([]);
      await runHandoff(["--handoff", "--check", ...pages], { ...muninn({ "plans/a.md": {} }).deps, git });
      expect(readdirSync(t)).toEqual([]);
    } finally {
      if (old === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = old;
    }
  });
});

describe("fix round 1 batch 3: own items are labelled by their state", () => {
  test("unconfirmed and stale hits say which; an own To-check page that Check or the cache settled is neither listed nor counted", async () => {
    const main = await repo();
    for (const r of ["plans/c.md", "repos/d.md", "repos/e.md", "repos/f.md", "repos/g.md"]) write(main, r, `# ${r}\n`);
    await g(main, "add", ".");
    await g(main, "commit", "-qm", "pages");
    const pages = ["--pages", ...["plans/a.md", "repos/b.md", "plans/c.md", "repos/d.md", "repos/e.md", "repos/f.md", "repos/g.md"].map((r) => path.join(main, r))];
    const spec = (f?: Linking["verdict"]): Record<string, Page> => ({
      "plans/a.md": { hits: [{ line: 7, target: "plans/x.mdx", text: "x in-flight" }] },
      "repos/b.md": { hits: [{ line: 4, target: "plans/y.mdx", text: "y in-flight", confirmation: { verdict: "stale" } }] },
      "plans/c.md": { toCheck: [{ relPath: "repos/d.md" }, { relPath: "repos/e.md" }, { relPath: "repos/f.md", ...(f ? { verdict: f } : {}) }, { relPath: "repos/g.md" }] },
      "repos/d.md": {},
      "repos/e.md": {},
      "repos/f.md": {},
      "repos/g.md": {},
    });
    await runHandoff(["--handoff", ...pages], { ...muninn(spec()).deps, git });
    // Nothing fixed by hand. Check settles repos/d.md (still true) and finds repos/e.md stale; repos/f.md comes back with a cached «fixed».
    const second = muninn(spec({ verdict: "fixed" }), { verdicts: { "plans/c.md": [{ relPath: "repos/d.md", verdict: "true" }, { relPath: "repos/e.md", verdict: "stale" }, { relPath: "repos/g.md", verdict: "unsure" }] } });
    const out = await runHandoff(["--handoff", "--check", ...pages], { ...second.deps, git });
    expect(second.checked).toEqual(["plans/c.md"]);
    expect(out.at(-1)).toBe(
      `Stale: ${path.basename(main)} — to check: plans/a.md (unconfirmed status line L7, yours), repos/b.md (stale status line L4, yours), repos/e.md (stale, yours), repos/g.md (unsure, yours)`,
    );
  });
});

// Fix round 1 batch 4: the run flow when the reports stop early or a Check fails.
describe("fix round 1 batch 4: Check after a stopped report stage, and the run's bound", () => {
  async function commitPages(main: string, rels: string[]) {
    for (const r of rels) write(main, r, `# ${r}\n`);
    await g(main, "add", ".");
    await g(main, "commit", "-qm", "pages");
  }

  test("the reports stop at their deadline: no Check on an unreported page, none on a costed one, the cached one still runs", async () => {
    const main = await repo();
    const rels = ["p1.md", "p2.md", "p3.md"];
    await commitPages(main, rels);
    // p1 needs model calls, p2's To-check verdict is cached, p3's report never comes back.
    const m = muninn(
      { "p1.md": { toCheck: [{ relPath: "o1.md" }] }, "p2.md": { toCheck: [{ relPath: "o2.md", verdict: { verdict: "true" } }] }, "p3.md": { toCheck: [{ relPath: "o3.md" }] } },
      { hangGet: ["p3.md"], verdicts: { "p2.md": [{ relPath: "o2.md", verdict: "true" }], "p1.md": [{ relPath: "o1.md", verdict: "stale" }] } },
    );
    const out = await runHandoff(["--handoff", "--check", "--pages", ...rels.map((r) => path.join(main, r))], { ...m.deps, git, deadlineMs: 1000, now: () => 0 });
    expect(m.checked).toEqual(["p2.md"]);
    expect(out.find((l) => l.startsWith("Check: "))).toBe("Check: 1 page(s) spend model calls — the reports stopped (muninn did not answer in 1 s), so only the 1 cached one(s) run, 1 cached only; bound ≤ 0 model calls, ≤ 6 min for the whole run (the gate took 0 s)");
    expect(out.at(-1)).toBe(
      `Stale: ${path.basename(main)} — to check: p3.md (not reported: muninn did not answer in 1 s), o1.md (Check skipped: muninn did not answer in 1 s)`,
    );
  });

  test("a Check that could run past the run's printed bound is not started", async () => {
    const main = await repo();
    let off = 0;
    const m = muninn({ "plans/a.md": { toCheck: [{ relPath: "repos/z.md" }] } });
    // The report stage took 10 min of the clock: more than the reports' share of the bound.
    const fetchJson: FetchJson = async (url, signal) => {
      off = 10 * 60_000;
      return m.deps.fetchJson(url, signal);
    };
    const out = await runHandoff(["--handoff", "--check", "--pages", path.join(main, "plans/a.md")], { ...m.deps, fetchJson, git, now: () => off });
    expect(m.checked).toEqual([]);
    expect(out).toContain("wiki-stale: check plans/a.md not started — it could run past the 6-min bound");
    expect(out.at(-1)).toBe(`Stale: ${path.basename(main)} — to check: repos/z.md (Check skipped: past the 6-min bound)`);
  });

  test("the same run inside its bound starts the Check", async () => {
    const main = await repo();
    const m = muninn({ "plans/a.md": { toCheck: [{ relPath: "repos/z.md" }] } }, { verdicts: { "plans/a.md": [{ relPath: "repos/z.md", verdict: "true" }] } });
    // The gate took 55 s of the clock: measured, it does not eat the Check's share of the bound.
    let reads = 0;
    const out = await runHandoff(["--handoff", "--check", "--pages", path.join(main, "plans/a.md")], { ...m.deps, git, now: () => (reads++ ? 55_000 : 0) });
    expect(out.find((l) => l.startsWith("Check: "))).toEndWith("≤ 7 min for the whole run (the gate took 55 s)");
    expect(m.checked).toEqual(["plans/a.md"]);
    expect(out.at(-1)).toBe(`Stale: ${path.basename(main)} — nothing stale on the changed pages`);
  });
});

describe("fix round 1 batch 4: a first call with a page unreported says its fix list is partial", () => {
  test("a page whose report failed is named with its reason", async () => {
    const main = await repo();
    const m = muninn({ "plans/a.md": { hits: [{ line: 7, target: "plans/x.mdx", text: "x in-flight" }] }, "repos/b.md": {} }, { failGet: ["repos/b.md"] });
    const out = await runHandoff(["--handoff", "--pages", path.join(main, "plans/a.md"), path.join(main, "repos/b.md")], { ...m.deps, git });
    const fix = out.slice(out.indexOf("fix by hand (your own pages; every other page goes through --check's sends):") + 1);
    expect(fix).toEqual([
      "  plans/a.md L7 after [[plans/x.mdx]]: x in-flight",
      "  not complete — no report for repos/b.md (muninn not reachable): read those pages for status lines yourself",
      "then: commit (and push) those fixes by the fix path, then run the same command with --check",
    ]);
  });

  test("a run the deadline stopped mid-list names the pages it did not reach, and says no «nothing»", async () => {
    const main = await repo();
    const m = muninn({ "plans/a.md": {}, "repos/b.md": {} }, { hangGet: ["repos/b.md"] });
    const out = await runHandoff(["--handoff", "--pages", path.join(main, "plans/a.md"), path.join(main, "repos/b.md")], { ...m.deps, git, deadlineMs: 1000 });
    const fix = out.slice(out.indexOf("fix by hand (your own pages; every other page goes through --check's sends):") + 1);
    expect(fix).toEqual([
      "  not complete — no report for repos/b.md (muninn did not answer in 1 s): read those pages for status lines yourself",
      "then: commit (and push) those fixes by the fix path, then run the same command with --check",
    ]);
  });
});

describe("fix round 1 batch 4: a failed Check falls back to the cached verdict", () => {
  test("a cached settled verdict is not listed, a cached stale or unsure one as such, only an uncached page as failed", async () => {
    const main = await repo();
    const m = muninn(
      {
        "plans/a.md": {
          toCheck: [
            { relPath: "repos/x.md", verdict: { verdict: "true" } },
            { relPath: "repos/y.md" },
            { relPath: "repos/w.md", verdict: { verdict: "stale" } },
            { relPath: "repos/u.md", verdict: { verdict: "unsure" } },
            { relPath: "repos/b.md", verdict: { verdict: "fixed" } },
          ],
        },
        "repos/b.md": {},
      },
      { failCheck: ["plans/a.md"] },
    );
    const out = await runHandoff(["--handoff", "--check", "--pages", path.join(main, "plans/a.md"), path.join(main, "repos/b.md")], { ...m.deps, git });
    expect(m.checked).toEqual(["plans/a.md"]);
    expect(out.at(-1)).toBe(
      `Stale: ${path.basename(main)} — to check: repos/y.md (connection refused), repos/w.md (stale, not sent: connection refused), repos/u.md (unsure)`,
    );
  });
});

describe("fix round 1 batch 5: the Stale line and the gate's wording", () => {
  test("muninn not reachable on --check: the Stale line names every page — the ones to act on with the gate's reason, the rest not reported", async () => {
    const main = await repo();
    // A committed deletion needs nothing from the session, so it is not listed.
    write(main, "plans/gone.md", "# Gone\n");
    await g(main, "add", ".");
    await g(main, "commit", "-qm", "gone");
    rmSync(path.join(main, "plans/gone.md"));
    await g(main, "commit", "-qam", "delete gone");
    write(main, "repos/b.md", "# B\ndirty\n");
    const pages = ["--pages", path.join(main, "plans/a.md"), path.join(main, "plans/gone.md"), path.join(main, "repos/b.md"), path.join(main, "nope/never.md")];
    const out = await runHandoff(["--handoff", "--check", ...pages, "--base-url", "http://127.0.0.1:9"], { git, env: {} });
    expect(out.at(-1)).toBe(`Stale: ${path.basename(main)} — to check: plans/a.md (not reported: muninn not reachable), repos/b.md (not re-read: uncommitted), nope/never.md (not re-read: not in the main checkout)`);
  });

  test("a missing page reads «not re-read: not in the main checkout» when muninn answers too", async () => {
    const main = await repo();
    const out = await runHandoff(["--handoff", "--check", "--pages", path.join(main, "plans/a.md"), path.join(main, "nope/never.md")], { ...muninn({ "plans/a.md": {} }).deps, git });
    expect(out.at(-1)).toStartWith(`Stale: ${path.basename(main)} — to check: nope/never.md (not re-read: not in the main checkout)`);
  });

  test("a refused pull names git's error, not its first hint", async () => {
    const { up, main } = await withRemote();
    write(up, "plans/a.md", "# A\nup\n");
    await g(up, "commit", "-qam", "up");
    await g(up, "push", "-q", "origin", "main");
    write(main, "plans/a.md", "# A\nlocal\n");
    await g(main, "commit", "-qam", "local");
    // Hints on, whatever the developer's config says.
    await g(main, "config", "advice.diverging", "true");
    const gate = await runGate(main, [], git);
    expect(gate.skip).toBe("git pull --ff-only refused (fatal: Not possible to fast-forward, aborting.)");
  });

  test("every pull note takes the error: or fatal: line, else the first non-hint line, else the exit code", async () => {
    const { main } = await withRemote();
    const pulling = (code: number, stderr: string): Git => (args, cwd, ms) => (args.includes("pull") ? Promise.resolve({ code, stdout: "", stderr }) : git(args, cwd, ms));
    const hints = "hint: one\nhint: two\n";
    expect((await runGate(main, [], pulling(1, `${hints}remote: noise\nfatal: Authentication failed for 'https://x/'`))).note).toBe(
      "not authorized — could not authenticate to origin (fatal: Authentication failed for 'https://x/'); the main checkout is as last pulled",
    );
    expect((await runGate(main, [], pulling(1, `${hints}error: could not resolve host x`))).note).toBe("offline — could not reach origin (error: could not resolve host x); the main checkout is as last pulled");
    // ssh names the cause; git's «could not read from remote» after it does not.
    expect((await runGate(main, [], pulling(1, "git@h: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\nPlease make sure"))).note).toBe(
      "not authorized — could not authenticate to origin (git@h: Permission denied (publickey).); the main checkout is as last pulled",
    );
    expect((await runGate(main, [], pulling(1, `${hints}something odd\nelse`))).skip).toBe("git pull --ff-only refused (something odd)");
    expect((await runGate(main, [], pulling(2, hints))).skip).toBe("git pull --ff-only refused (exit 2)");
  });
});

describe("fix round 2 batch 3: a local «Permission denied» is a refused pull, not «not authorized»", () => {
  /** Upstream changes plans/a.md; the main checkout has not pulled it. */
  async function behind() {
    const r = await withRemote();
    write(r.up, "plans/a.md", "# A\nup\n");
    await g(r.up, "commit", "-qam", "up");
    await g(r.up, "push", "-q", "origin", "main");
    return r;
  }
  test("real git: a read-only page folder or .git refuses the pull, and Check skips", async () => {
    for (const dir of ["plans", ".git"]) {
      const { main } = await behind();
      chmodSync(path.join(main, dir), 0o555);
      try {
        const gate = await runGate(main, [await page(path.join(main, "plans/a.md"))], git);
        expect([dir, gate.note?.startsWith("git pull --ff-only refused ("), gate.note, gate.skip]).toEqual([dir, true, gate.skip, gate.skip]);
        expect(gate.note).toContain("Permission denied");
        expect(gate.lines).toContain(`gate: Check skip — ${gate.skip}`);
      } finally {
        chmodSync(path.join(main, dir), 0o755);
      }
    }
  });

  test("stubbed: local EACCES shapes refuse; remote auth shapes are «not authorized»", async () => {
    const { main } = await withRemote();
    const pullSays = (stderr: string): Git => (args, cwd, ms) => (args.includes("pull") ? Promise.resolve({ code: 128, stdout: "", stderr }) : git(args, cwd, ms));
    const cases: [string, "auth" | "refused"][] = [
      ["error: unable to unlink old 'plans/a.md': Permission denied", "refused"],
      ["error: cannot open .git/FETCH_HEAD: Permission denied", "refused"],
      ["fatal: Unable to create '/w/.git/index.lock': Permission denied", "refused"],
      ["git@h: Permission denied (publickey,password).\nfatal: Could not read from remote repository.", "auth"],
      ["git@h: Permission denied, please try again.\nfatal: Could not read from remote repository.", "auth"],
      ["ERROR: Repository not found.\nfatal: Could not read from remote repository.", "auth"],
      ["remote: Repository not found.\nfatal: repository 'https://h/o/w.git/' not found", "auth"],
      ["remote: Permission to o/w.git denied to someone.\nfatal: unable to access 'https://h/o/w.git/': The requested URL returned error: 403", "auth"],
      ["fatal: unable to access 'https://h/': The requested URL returned error: 401", "auth"],
    ];
    for (const [stderr, kind] of cases) {
      const gate = await runGate(main, [], pullSays(stderr));
      const want = kind === "auth" ? ["not authorized", undefined] : ["git pull --ff-only refused (", true];
      expect([stderr, gate.note?.split(" — ")[0]!.slice(0, kind === "auth" ? undefined : 28), kind === "auth" ? gate.skip : gate.skip === gate.note]).toEqual([stderr, ...want]);
    }
  });
});

describe("fix round 2 batch 3: index flags and ignore rules cannot hide a page's working bytes from the gate", () => {
  test("skip-worktree and assume-unchanged on an edited main copy: uncommitted, Check skips", async () => {
    for (const flag of ["--skip-worktree", "--assume-unchanged"]) {
      const main = await repo();
      await g(main, "update-index", flag, "plans/a.md");
      write(main, "plans/a.md", "# A\nhidden edit\n");
      expect(await g(main, "status", "--porcelain")).toBe("");
      const gate = await runGate(main, [await page(path.join(main, "plans/a.md"))], git);
      expect([flag, gate.pages[0]!.state, gate.skip]).toEqual([flag, "uncommitted", "uncommitted edits on plans/a.md"]);
    }
  });

  test("a flagged main copy behind a worktree's commit: not carried", async () => {
    const main = await repo();
    await g(main, "branch", "fix");
    const wt = path.join(tmp(), "wt");
    await g(main, "worktree", "add", "-q", wt, "fix");
    write(wt, "plans/a.md", "# A\nfixed\n");
    await g(wt, "commit", "-qam", "fix");
    await g(main, "merge", "-q", "--ff-only", "fix");
    await g(main, "update-index", "--skip-worktree", "plans/a.md");
    write(main, "plans/a.md", "# A\nsomeone else's hidden edit\n");
    const gate = await runGate(main, [await page(path.join(wt, "plans/a.md"))], git);
    expect(gate.pages[0]!.state).toBe("main-uncommitted");
    expect(gate.skip).toBe("uncommitted edits on the main copy of plans/a.md");
  });

  test("a gitignored page was never committed: uncommitted, Check skips", async () => {
    const main = await repo();
    write(main, ".gitignore", "plans/ign.md\n");
    await g(main, "add", ".gitignore");
    await g(main, "commit", "-qm", "ignore");
    write(main, "plans/ign.md", "# Ignored\n");
    expect(await g(main, "status", "--porcelain")).toBe("");
    const gate = await runGate(main, [await page(path.join(main, "plans/ign.md"))], git);
    expect([gate.pages[0]!.state, gate.skip]).toEqual(["uncommitted", "uncommitted edits on plans/ign.md"]);
  });

  test("a deletion hidden by skip-worktree is uncommitted; a hidden edit in the worktree is uncommitted too", async () => {
    const main = await repo();
    await g(main, "update-index", "--skip-worktree", "plans/a.md");
    rmSync(path.join(main, "plans/a.md"));
    expect(await g(main, "status", "--porcelain")).toBe("");
    expect((await runGate(main, [await page(path.join(main, "plans/a.md"))], git)).pages[0]!.state).toBe("deleted-uncommitted");
    const m2 = await repo();
    await g(m2, "branch", "fix");
    const wt = path.join(tmp(), "wt");
    await g(m2, "worktree", "add", "-q", wt, "fix");
    await g(wt, "update-index", "--assume-unchanged", "plans/a.md");
    write(wt, "plans/a.md", "# A\nthe session's unsaved fix\n");
    expect((await runGate(m2, [await page(path.join(wt, "plans/a.md"))], git)).pages[0]!.state).toBe("uncommitted");
  });

  test("a page new in the worktree's commit and absent from the main checkout is not carried, not a main-copy edit", async () => {
    const main = await repo();
    await g(main, "branch", "fix");
    const wt = path.join(tmp(), "wt");
    await g(main, "worktree", "add", "-q", wt, "fix");
    write(wt, "plans/new.md", "# New\n");
    await g(wt, "add", ".");
    await g(wt, "commit", "-qm", "new");
    expect((await runGate(main, [await page(path.join(wt, "plans/new.md"))], git)).pages[0]!.state).toBe("not-carried");
  });

  test("an ignored page git cannot read is not clean", async () => {
    const main = await repo();
    write(main, ".gitignore", "plans/ign.md\n");
    await g(main, "add", ".gitignore");
    await g(main, "commit", "-qm", "ignore");
    write(main, "plans/ign.md", "# Ignored\n");
    chmodSync(path.join(main, "plans/ign.md"), 0o000);
    try {
      expect((await runGate(main, [await page(path.join(main, "plans/ign.md"))], git)).pages[0]!.state).toBe("uncommitted");
    } finally {
      chmodSync(path.join(main, "plans/ign.md"), 0o644);
    }
  });

  test("a clean page whose working bytes differ from the blob only by its eol filter stays committed", async () => {
    const main = await repo();
    write(main, ".gitattributes", "*.md text eol=crlf\n");
    write(main, "plans/crlf.md", "# C\r\nline\r\n");
    await g(main, "add", ".");
    await g(main, "commit", "-qm", "crlf");
    const gate = await runGate(main, [await page(path.join(main, "plans/crlf.md"))], git);
    expect([gate.pages[0]!.state, gate.skip]).toEqual(["committed", undefined]);
  });
});

describe("fix round 2 batch 3: the run's bound starts after the gate and uses the injected deadlines", () => {
  test("verifier's scenario: the pull times out, a report hits its deadline, the cached Check still runs and sends", async () => {
    const { main } = await withRemote();
    let off = 0;
    // The runner returns a timed-out pull by its bound plus its 1.5 s of graces.
    const slowPull: Git = (args, cwd, ms) => {
      if (!args.includes("pull")) return git(args, cwd, ms);
      off += 31_500;
      return Promise.resolve({ code: -1, stdout: "", stderr: "", timedOut: true });
    };
    const m = muninn(
      { "plans/a.md": { toCheck: [{ relPath: "repos/z.md", verdict: { verdict: "stale" } }] }, "repos/b.md": { toCheck: [{ relPath: "repos/y.md" }] } },
      { hangGet: ["repos/b.md"], verdicts: { "plans/a.md": [{ relPath: "repos/z.md", verdict: "stale", edit: { old: "o", new: "n" } }] } },
    );
    const fetchJson: FetchJson = async (url, signal) => {
      signal?.addEventListener("abort", () => (off += 1_000));
      return m.deps.fetchJson(url, signal);
    };
    const out = await runHandoff(["--handoff", "--check", "--pages", path.join(main, "plans/a.md"), path.join(main, "repos/b.md")], { ...m.deps, fetchJson, git: slowPull, deadlineMs: 1000, now: () => off });
    expect(out).toContain("gate: offline — could not reach origin (no answer in 30 s); the main checkout is as last pulled");
    expect(out.filter((l) => l.includes("not started"))).toEqual([]);
    expect(m.checked).toEqual(["plans/a.md"]);
    expect(m.sent).toEqual(["repos/z.md"]);
    expect(out.find((l) => l.startsWith("Check: "))).toBe(
      "Check: 0 page(s) spend model calls — the reports stopped (muninn did not answer in 1 s), so only the 1 cached one(s) run, 1 cached only; bound ≤ 0 model calls, ≤ 7 min for the whole run (the gate took 32 s)",
    );
  });

  test("the guard budgets the Check and the sends from the injected deadlines: the edge starts, one ms past it does not", async () => {
    const lines: (string | undefined)[] = [];
    for (const [late, runs] of [[3_000, true], [3_001, false]] as const) {
      const main = await repo();
      let off = 0;
      const m = muninn({ "plans/a.md": { toCheck: [{ relPath: "repos/z.md" }] } }, { verdicts: { "plans/a.md": [{ relPath: "repos/z.md", verdict: "true" }] } });
      // The report stage reads `late` ms on the clock: bound = 1 s reports + 2 s margin + 60 s Check + 60 s sends.
      const fetchJson: FetchJson = async (url, signal) => {
        off = late;
        return m.deps.fetchJson(url, signal);
      };
      const out = await runHandoff(["--handoff", "--check", "--pages", path.join(main, "plans/a.md")], {
        ...m.deps, fetchJson, git, now: () => off, deadlineMs: 1000, checkDeadlineMs: 60_000, sendDeadlineMs: 60_000,
      });
      expect([late, m.checked]).toEqual([late, runs ? ["plans/a.md"] : []]);
      if (!runs) expect(out).toContain("wiki-stale: check plans/a.md not started — it could run past the 3-min bound");
      lines.push(out.find((l) => l.startsWith("Check: ")));
    }
    expect(lines).toEqual(Array(2).fill("Check: 1 page(s) spend model calls, 0 cached only; bound ≤ 10 model calls, ≤ 3 min for the whole run (the gate took 0 s)"));
  });
});

/*
 * Class check (round 3, the `Stale:` line): every session page gets exactly one entry, from one precedence —
 * wide gate skip → gate state to act on → no report → Check skipped → own item → To-check verdict → nothing.
 * The cells: page origin {--pages, memo only, both} × gate state × run × own-item state, every one run through
 * `runHandoff` on real git and the stub muninn, so `oneWiki`'s assembly is in the cell, not only `staleLine`.
 * Collapsed: a memo-only page has no gate state (runGate sees only `--pages`), so it is one column, not eight.
 */
describe("class check: the Stale line's cells — origin × gate state × run × own item", () => {
  const STATES = ["committed", "uncommitted", "carried", "not-carried", "main-uncommitted", "deleted", "deleted-uncommitted", "missing"] as const;
  type State = (typeof STATES)[number];
  const OWN = ["none", "stale", "unconfirmed", "unsure", "unchecked", "settled"] as const;
  type Own = (typeof OWN)[number];
  const RUNS = ["wide", "wide-refused", "ok", "error", "nopage", "refused", "deadline"] as const;
  type Run = (typeof RUNS)[number];
  const WIDE = "main checkout on feature, not main";
  const rel = (s: State) => `s/${s}.md`;
  const Q = "s/q.md";
  const MEMO = "s/memo.md";
  const IN_WORKTREE = new Set<State>(["carried", "not-carried", "main-uncommitted"]);
  const ACT: Partial<Record<State, string>> = {
    uncommitted: "uncommitted",
    "not-carried": "not carried",
    "main-uncommitted": "the main copy has uncommitted edits",
    "deleted-uncommitted": "deleted, uncommitted",
    missing: "not in the main checkout",
  };
  const ASKED = new Set<State>(["committed", "uncommitted", "carried", "not-carried", "main-uncommitted"]);

  /** One checkout with a page in each gate state, Q (whose report carries the own To-check items) and the memo-only page. */
  async function fixture(wide: boolean) {
    const main = await repo();
    for (const s of STATES) if (s !== "missing") write(main, rel(s), `# ${s}\n`);
    write(main, Q, "# q\n");
    write(main, MEMO, "# memo\n");
    await g(main, "add", ".");
    await g(main, "commit", "-qm", "pages");
    rmSync(path.join(main, rel("deleted")));
    await g(main, "commit", "-qam", "delete");
    await g(main, "branch", "fix");
    const wt = path.join(tmp(), "wt");
    await g(main, "worktree", "add", "-q", wt, "fix");
    write(wt, rel("not-carried"), "# not carried, committed in the worktree\n");
    await g(wt, "commit", "-qam", "wt edit");
    write(main, rel("uncommitted"), "# uncommitted edit\n");
    write(main, rel("main-uncommitted"), "# main copy edit\n");
    rmSync(path.join(main, rel("deleted-uncommitted")));
    if (wide) await g(main, "checkout", "-q", "-b", "feature");
    const abs = (s: State) => path.join(IN_WORKTREE.has(s) ? wt : main, rel(s));
    return { main, pages: [path.join(main, Q), ...STATES.map(abs)] };
  }

  /** The cell's single entry, or null: the precedence spelled out from the spec, not from the code. */
  function expected(state: State | "memo", origin: "pages" | "both", run: Run, own: Own): string | null {
    if (run === "wide" || run === "wide-refused") return `not re-read: ${WIDE}`;
    const act = state === "memo" ? undefined : ACT[state];
    if (act) return `not re-read: ${act}`;
    const asked = state === "memo" || origin === "both" || ASKED.has(state);
    if (asked && run === "error") return "not reported: unexpected answer";
    if (asked && run === "nopage") return "not re-read: not in the main checkout";
    if (asked && run === "refused") return "not reported: muninn not reachable";
    if (asked && run === "deadline") return "not reported: muninn did not answer in 0.3 s";
    if (own === "unchecked") return "unchecked, yours";
    if (asked && (own === "stale" || own === "unconfirmed" || own === "unsure")) return `${own} status line L5, yours`;
    return null;
  }

  const report = (own: Own): Page => {
    const confirmation = own === "stale" ? { verdict: "stale" } : own === "unsure" ? { verdict: "unsure" } : own === "settled" ? { verdict: "true" } : "unconfirmed";
    return own === "none" || own === "unchecked" ? {} : { hits: [{ line: 5, target: "plans/x.mdx", text: "x in-flight", confirmation }] };
  };

  /** The `to check:` list split at the known page names. */
  function entries(line: string, rels: string[]): Map<string, string> {
    const list = line.match(/to check: (.*?)(?:; check unavailable.*)?$/)?.[1] ?? "";
    const start = (r: string) => {
      for (let i = list.indexOf(`${r} (`); i >= 0; i = list.indexOf(`${r} (`, i + 1)) if (i === 0 || list.slice(i - 2, i) === ", ") return i;
      return -1;
    };
    const at = rels.map((r) => ({ r, i: start(r) })).filter((x) => x.i >= 0).sort((a, b) => a.i - b.i);
    const out = new Map<string, string>();
    at.forEach(({ r, i }, n) => {
      const end = n + 1 < at.length ? at[n + 1]!.i - 2 : list.length;
      out.set(r, list.slice(i + r.length + 2, end - 1));
    });
    return out;
  }

  const fixtures: Partial<Record<"wide" | "narrow", Promise<Awaited<ReturnType<typeof fixture>>>>> = {};
  const fx = (wide: boolean) => (fixtures[wide ? "wide" : "narrow"] ??= fixture(wide));

  test("the fixture's gate states are the eight the table names", async () => {
    for (const wide of [false, true]) {
      const { main, pages } = await fx(wide);
      const gate = await runGate(main, await Promise.all(pages.map(page)), git, { pull: false });
      expect(gate.pages.map((p) => p.state)).toEqual(["committed", ...STATES]);
      expect(gate.wideSkip).toBe(wide ? WIDE : undefined);
    }
  });

  for (const origin of ["pages", "both"] as const) {
    for (const run of RUNS) {
      test(`origin ${origin}, run ${run}: each page's one entry, for every own-item state`, async () => {
        const { main, pages } = await fx(run.startsWith("wide"));
        const P = [...STATES.map(rel), ...(origin === "both" ? [MEMO] : [])];
        const bad: string[] = [];
        for (const own of OWN) {
          const spec: Record<string, Page> = { [Q]: own === "unchecked" ? { toCheck: P.map((relPath) => ({ relPath })) } : {} };
          if (run !== "nopage") for (const p of P) spec[p] = report(own);
          const firstAsked = rel("committed");
          const m = muninn(spec, {
            ...(origin === "both" ? { session: P } : {}),
            ...(run === "error" ? { badGet: P } : {}),
            ...(run === "refused" || run === "wide-refused" ? { failGet: P } : {}),
            ...(run === "deadline" ? { hangGet: [firstAsked] } : {}),
          });
          const argv = ["--handoff", "--check", "--pages", ...pages, ...(origin === "both" ? ["--session", "S1"] : [])];
          const line = (await runHandoff(argv, { ...m.deps, git, ...(run === "deadline" ? { deadlineMs: 300 } : {}) })).at(-1)!;
          const got = entries(line, [Q, ...P]);
          const cells: [string, State | "memo"][] = [...STATES.map((s): [string, State] => [rel(s), s]), ...(origin === "both" ? [[MEMO, "memo"] as [string, "memo"]] : [])];
          for (const [r, state] of cells) {
            const want = expected(state, origin, run, own);
            const have = got.get(r) ?? null;
            if (want !== have) bad.push(`${origin} × ${state} × ${run} × ${own}: want ${JSON.stringify(want)}, got ${JSON.stringify(have)}`);
          }
          // Q has no item of its own: listed only under the wide skip.
          const qWant = run.startsWith("wide") ? `not re-read: ${WIDE}` : null;
          if ((got.get(Q) ?? null) !== qWant) bad.push(`${origin} × Q × ${run} × ${own}: want ${JSON.stringify(qWant)}, got ${JSON.stringify(got.get(Q) ?? null)}`);
          // Every listed name is a cell: no entry the table did not ask for, and an act-on page always makes «nothing stale» false.
          if (line.includes("nothing stale")) bad.push(`${origin} × ${run} × ${own}: «nothing stale» with act-on pages`);
          if (!line.startsWith(`Stale: ${path.basename(main)} — to check: `)) bad.push(`${origin} × ${run} × ${own}: line shape ${line}`);
        }
        expect(bad).toEqual([]);
      }, 60_000);
    }
  }
});

describe("class check: the Stale line's coverage set and the «nothing stale» rule", () => {
  const hitOn = (line: number) => ({ hits: [{ line, target: "plans/x.mdx", text: "x in-flight" }] });

  test("verifier's repro: main checkout on feature, --session only, a memo page with a hit in call 1 and none in call 2 is listed", async () => {
    const main = await repo();
    await g(main, "checkout", "-q", "-b", "feature");
    const argv = ["--handoff", "--session", "S1", "--main", main];
    await runHandoff(argv, { ...muninn({ "plans/a.md": hitOn(7) }, { session: ["plans/a.md"] }).deps, git });
    const out = await runHandoff([...argv, "--check"], { ...muninn({ "plans/a.md": {} }, { session: ["plans/a.md"] }).deps, git });
    expect(out.at(-1)).toBe(`Stale: ${path.basename(main)} — to check: plans/a.md (not re-read: ${"main checkout on feature, not main"})`);
  });

  test("--pages a --session with memo page b under a wide skip: both listed with the reason", async () => {
    const main = await repo();
    await g(main, "checkout", "-q", "-b", "feature");
    const m = muninn({ "plans/a.md": {}, "repos/b.md": {} }, { session: ["repos/b.md"] });
    const out = await runHandoff(["--handoff", "--check", "--pages", path.join(main, "plans/a.md"), "--session", "S1"], { ...m.deps, git });
    const why = "not re-read: main checkout on feature, not main";
    expect(out.at(-1)).toBe(`Stale: ${path.basename(main)} — to check: plans/a.md (${why}), repos/b.md (${why})`);
  });

  test("a wide skip with no session page says «not checked», never «nothing stale»", async () => {
    const main = await repo();
    await g(main, "checkout", "-q", "-b", "feature");
    const out = await runHandoff(["--handoff", "--check", "--session", "S1", "--main", main], { ...muninn({}, { session: [] }).deps, git });
    expect(out.at(-1)).toBe(`Stale: ${path.basename(main)} — not checked (main checkout on feature, not main)`);
  });

  test("a --main that is not a git checkout: the memo's pages are listed with that reason", async () => {
    const dir = tmp();
    const out = await runHandoff(["--handoff", "--check", "--session", "S1", "--main", dir], { ...muninn({ "plans/a.md": {} }, { session: ["plans/a.md"] }).deps, git });
    expect(out.at(-1)).toBe(`Stale: ${path.basename(dir)} — to check: plans/a.md (not re-read: ${dir} is not a git checkout)`);
  });

  test("a memo muninn did not answer: the line says the session's pages are not known, never «nothing stale»", async () => {
    const main = await repo();
    const out = await runHandoff(["--handoff", "--check", "--pages", path.join(main, "plans/a.md"), "--session", "S1"], { ...muninn({ "plans/a.md": {} }, { failSession: true }).deps, git });
    expect(out.at(-1)).toBe(`Stale: ${path.basename(main)} — session S1's pages not known (muninn not reachable)`);
  });

  test("a memo-only page another page lists To check is the session's own: unchecked, yours — not sent, not Check's", async () => {
    const main = await repo();
    const m = muninn({ "plans/a.md": { toCheck: [{ relPath: "repos/b.md" }] }, "repos/b.md": {} }, { session: ["repos/b.md"] });
    const out = await runHandoff(["--handoff", "--check", "--pages", path.join(main, "plans/a.md"), "--session", "S1"], { ...m.deps, git });
    expect(out.at(-1)).toBe(`Stale: ${path.basename(main)} — to check: repos/b.md (unchecked, yours)`);
  });

  test("an uncommitted deletion alone is listed with its reason, not «deleted only — nothing to check»", async () => {
    const main = await repo();
    rmSync(path.join(main, "repos/b.md"));
    const m = muninn({});
    const out = await runHandoff(["--handoff", "--check", "--pages", path.join(main, "repos/b.md")], { ...m.deps, git });
    expect(m.asked).toEqual([]);
    expect(out.at(-1)).toBe(`Stale: ${path.basename(main)} — to check: repos/b.md (not re-read: deleted, uncommitted)`);
  });

  test("a committed deletion alone has no report read: «deleted only», not «nothing stale»", async () => {
    const main = await repo();
    rmSync(path.join(main, "repos/b.md"));
    await g(main, "commit", "-qam", "delete b");
    const out = await runHandoff(["--handoff", "--check", "--pages", path.join(main, "repos/b.md")], { ...muninn({}).deps, git });
    expect(out.at(-1)).toBe(`Stale: ${path.basename(main)} — deleted only: repos/b.md — nothing to check`);
  });

  test("«nothing stale» when every session page, memo included, was read and nothing is open", async () => {
    const main = await repo();
    const m = muninn({ "plans/a.md": {}, "repos/b.md": {} }, { session: ["repos/b.md"] });
    const out = await runHandoff(["--handoff", "--check", "--pages", path.join(main, "plans/a.md"), "--session", "S1"], { ...m.deps, git });
    expect(m.asked).toEqual(["plans/a.md", "repos/b.md"]);
    expect(out.at(-1)).toBe(`Stale: ${path.basename(main)} — nothing stale on the changed pages`);
  });
});
