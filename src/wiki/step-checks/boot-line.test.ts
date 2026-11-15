/**
 * The boot record and line against real git on throwaway repos: a bare origin,
 * a second clone that pushes to it, and the checkout muninn "started" from.
 * Origin's URL is faked to a network one (`networkOrigin`); every other call,
 * the live `ls-remote --symref` included, reaches the real bare repo.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { testTempDirSync } from "../../test/temp-dir.ts";
import { hermeticGit, networkOrigin } from "../../test/hermetic-git.ts";
import type { GitRun } from "../decision-triage/git.ts";
import { ProbeCache, ProbeSlots } from "./answer.ts";
import { bootLineGit, formatStartTime, readBootLine, type BootLine } from "./boot-line.ts";
import { parseStatusV2, prOfSubject, takeBootRecord, type BootRecord } from "./boot-record.ts";
import { registerWikiBootLineRoute } from "../../dashboard/routes/wiki-boot-line.ts";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
const NETWORK = networkOrigin("https://example.invalid/muninn.git");
const AT = new Date(2026, 10, 14, 20, 58).getTime();
const START = formatStartTime(AT);

let n = 0;
const commit = (dir: string, subject: string) => {
  writeFileSync(path.join(dir, "f"), `${subject} ${n++}\n`);
  sh(dir, "commit", "-q", "-am", subject);
  return sh(dir, "rev-parse", "HEAD");
};

/** A bare origin with one commit on main, the clone that pushes to it, and the checkout muninn starts from. */
function fixture() {
  const base = realpathSync(testTempDirSync(path.join(tmpdir(), "boot-line-")));
  const remote = path.join(base, "muninn.git");
  const work = path.join(base, "work");
  const clone = path.join(base, "muninn");
  sh(base, "init", "-q", "--bare", "-b", "main", remote);
  sh(base, "clone", "-q", remote, work);
  writeFileSync(path.join(work, "f"), "one\n");
  sh(work, "add", "f");
  sh(work, "commit", "-q", "-m", "Start here (#864)");
  sh(work, "push", "-q", "-u", "origin", "HEAD:main");
  sh(base, "clone", "-q", remote, clone);
  return { base, remote, work, clone };
}

const push = (work: string, subject: string) => {
  const sha = commit(work, subject);
  sh(work, "push", "-q", "origin", "HEAD:main");
  return sha;
};

const record = (dir: string, git: GitRun = NETWORK) => takeBootRecord(dir, git, () => AT);
const lineOf = (rec: BootRecord, git: GitRun = NETWORK) => readBootLine(rec, { git: bootLineGit(git, new ProbeSlots(4)) });
const known = (rec: BootRecord) => {
  if (!rec.known) throw new Error(`unknown record: ${rec.reason}`);
  return rec;
};
const short = (sha: string) => sha.slice(0, 8);

describe("the record", () => {
  test("a clean start on the default branch: the commit, the branch, clean, the subject's PR", async () => {
    const { clone } = fixture();
    const rec = known(await record(path.join(clone)));
    expect(rec).toEqual({ known: true, dir: clone, commit: sh(clone, "rev-parse", "HEAD"), branch: "main", dirty: false, pr: 864, at: AT });
  });

  test("read in the repo holding the folder it is given, from a subdirectory too", async () => {
    const { clone } = fixture();
    execFileSync("mkdir", ["-p", path.join(clone, "src/wiki")]);
    expect(known(await record(path.join(clone, "src/wiki"))).dir).toBe(clone);
  });

  test("a folder with no git: unknown, named as such", async () => {
    const dir = realpathSync(testTempDirSync(path.join(tmpdir(), "boot-nogit-")));
    expect(await record(dir)).toEqual({ known: false, reason: "muninn did not start from a git checkout", at: AT });
  });

  test("git that cannot run: unknown", async () => {
    const noGit: GitRun = async () => ({ ok: false, stdout: "", stderr: "spawn failed" });
    expect(await record("/x", noGit)).toEqual({ known: false, reason: "git could not run at start", at: AT });
  });

  test("a slow read: unknown, never a guess", async () => {
    const slow: GitRun = async () => ({ ok: false, stdout: "", timedOut: true });
    expect(await record("/x", slow)).toEqual({ known: false, reason: "git rev-parse timed out at start", at: AT });
  });

  test("a pull racing the start (HEAD moves between rev-parse and status): unknown", async () => {
    const { clone } = fixture();
    let moved = false;
    const racing: GitRun = async (cwd, args, opts) => {
      if (args.includes("status") && !moved) {
        moved = true;
        commit(clone, "landed mid-start (#900)");
      }
      return NETWORK(cwd, args, opts);
    };
    expect(await record(clone, racing)).toEqual({ known: false, reason: "the checkout moved while muninn started", at: AT });
  });

  test("parse helpers", () => {
    expect(prOfSubject("Keep focus (#865)")).toBe(865);
    expect(prOfSubject("Merge pull request #12 from x/y")).toBeNull();
    expect(parseStatusV2("# branch.oid abc\0# branch.head (detached)\0")).toEqual({ oid: "abc", branch: null, dirty: false });
    expect(parseStatusV2("# branch.oid abc\0# branch.head main\x001 .M N... 100644 100644 100644 a b f\0")).toEqual({ oid: "abc", branch: "main", dirty: true });
  });
});

describe("the line, first row that fits", () => {
  test("where it started: the start commit and the time, nothing else", async () => {
    const { clone } = fixture();
    const rec = known(await record(clone));
    const line = await lineOf(rec);
    expect(line.row).toBe("same");
    expect(line.defaultBranch).toBe("main");
    expect(line.text).toBe(`started from ${short(rec.commit)} (#864) on ${START}`);
  });

  test("newer PRs on the default branch after a pull: listed by number, oldest first, with commits lacking one counted", async () => {
    const { work, clone } = fixture();
    const rec = known(await record(clone));
    push(work, "First (#865)");
    push(work, "no number here");
    push(work, "Second (#866)");
    sh(clone, "pull", "-q", "--ff-only");
    const line = await lineOf(rec);
    expect(line.row).toBe("newer");
    expect(line.text).toBe(`started from ${short(rec.commit)} (#864) on ${START} · the checkout holds 2 newer PRs: #865, #866 and 1 commit without a PR number: restart`);
  });

  test("one commit without a PR number and no PR", async () => {
    const { work, clone } = fixture();
    const rec = known(await record(clone));
    push(work, "hand commit");
    sh(clone, "pull", "-q", "--ff-only");
    expect((await lineOf(rec)).text).toEndWith("· the checkout holds 1 commit without a PR number: restart");
  });

  test("a PR merged without squash: its merge commit counts as a commit without a PR number, its branch commits not at all", async () => {
    const { clone } = fixture();
    const rec = known(await record(clone));
    sh(clone, "checkout", "-q", "-b", "topic");
    commit(clone, "topic work (#1)");
    commit(clone, "more topic work (#2)");
    sh(clone, "checkout", "-q", "main");
    sh(clone, "merge", "-q", "--no-ff", "-m", "Merge pull request #3 from x/topic", "topic");
    const line = await lineOf(rec);
    expect(line.row).toBe("newer");
    expect(line.text).toContain("the checkout holds 1 commit without a PR number: restart");
  });

  test("origin ahead, nothing pulled: «origin is ahead: pull» beside the start commit", async () => {
    const { work, clone } = fixture();
    const rec = known(await record(clone));
    push(work, "Merged after start (#870)");
    const line = await lineOf(rec);
    expect(line.row).toBe("same");
    expect(line.text).toBe(`started from ${short(rec.commit)} (#864) on ${START} · origin is ahead: pull`);
  });

  test("a stale origin-tracking ref does not hide origin being ahead: origin is read live", async () => {
    const { work, clone } = fixture();
    const rec = known(await record(clone));
    push(work, "one (#871)");
    sh(clone, "fetch", "-q");
    sh(clone, "merge", "-q", "--ff-only", "origin/main");
    push(work, "two (#872)");
    const line = await lineOf(rec);
    expect(line.text).toBe(`started from ${short(rec.commit)} (#864) on ${START} · the checkout holds 1 newer PR: #871: restart · origin is ahead: pull`);
  });

  test("switched to another branch after start: names it, no restart or pull advice even when origin is ahead and files differ", async () => {
    const { work, clone } = fixture();
    const rec = known(await record(clone));
    sh(clone, "checkout", "-q", "-b", "feature");
    writeFileSync(path.join(clone, "f"), "edited\n");
    push(work, "ahead (#880)");
    const line = await lineOf(rec);
    expect(line.row).toBe("elsewhere");
    expect(line.text).toBe(`started from ${short(rec.commit)} (#864) on ${START} · the checkout is on feature now, and code loaded on first use comes from it`);
  });

  test("detached HEAD after start: names the commit it sits on", async () => {
    const { clone } = fixture();
    const rec = known(await record(clone));
    const next = commit(clone, "next (#881)");
    sh(clone, "checkout", "-q", "--detach", next);
    const line = await lineOf(rec);
    expect(line.row).toBe("elsewhere");
    expect(line.text).toEndWith(`the checkout is on a detached HEAD at ${short(next)} now, and code loaded on first use comes from it`);
  });

  test("moved backwards after start: «moved off the start commit: restart»", async () => {
    const { clone } = fixture();
    const first = sh(clone, "rev-parse", "HEAD");
    commit(clone, "after (#882)");
    const rec = known(await record(clone));
    sh(clone, "reset", "-q", "--hard", first);
    const line = await lineOf(rec, networkOrigin("https://example.invalid/muninn.git"));
    expect(line.row).toBe("moved-off");
    expect(line.text).toBe(`started from ${short(rec.commit)} (#882) on ${START} · the checkout has moved off the start commit: restart`);
  });

  test("reset onto another line of history: moved off", async () => {
    const { clone } = fixture();
    const rec = known(await record(clone));
    sh(clone, "checkout", "-q", "--orphan", "other");
    commit(clone, "unrelated root (#5)");
    sh(clone, "branch", "-f", "main", "other");
    sh(clone, "checkout", "-q", "main");
    expect((await lineOf(rec)).row).toBe("moved-off");
  });

  test("a tracked file edited after start, HEAD unchanged: «tracked files differ from HEAD since start»", async () => {
    const { clone } = fixture();
    const rec = known(await record(clone));
    writeFileSync(path.join(clone, "f"), "edited after start\n");
    const line = await lineOf(rec);
    expect(line.row).toBe("same");
    expect(line.text).toBe(`started from ${short(rec.commit)} (#864) on ${START} · tracked files differ from HEAD since start`);
  });

  test("an untracked file is not a tracked difference", async () => {
    const { clone } = fixture();
    const rec = known(await record(clone));
    writeFileSync(path.join(clone, "new-file"), "x\n");
    expect((await lineOf(rec)).text).toBe(`started from ${short(rec.commit)} (#864) on ${START}`);
  });
});

describe("the line, unknowns and the start's own facts", () => {
  test("a start from a modified tree: named, and still modified: «they differed at start too»", async () => {
    const { clone } = fixture();
    writeFileSync(path.join(clone, "f"), "dirty at start\n");
    const rec = known(await record(clone));
    expect(rec.dirty).toBe(true);
    const line = await lineOf(rec);
    expect(line.text).toBe(`started from ${short(rec.commit)} (#864) on ${START}, from a modified tree · tracked files differ from HEAD, they differed at start too`);
  });

  test("a start from a modified tree followed by a pull: the newer PR shows, the start stays named modified", async () => {
    const { work, clone } = fixture();
    writeFileSync(path.join(clone, "g"), "untracked becomes nothing\n");
    writeFileSync(path.join(clone, "f"), "dirty at start\n");
    const rec = known(await record(clone));
    sh(clone, "checkout", "-q", "--", "f");
    push(work, "Pulled later (#890)");
    sh(clone, "pull", "-q", "--ff-only");
    const line = await lineOf(rec);
    expect(line.row).toBe("newer");
    expect(line.text).toBe(`started from ${short(rec.commit)} (#864) on ${START}, from a modified tree · the checkout holds 1 newer PR: #890: restart`);
  });

  test("a start on a branch other than the default one, still there: named, and the row is «elsewhere»", async () => {
    const { clone } = fixture();
    sh(clone, "checkout", "-q", "-b", "feat");
    const rec = known(await record(clone));
    const line = await lineOf(rec);
    expect(line.row).toBe("elsewhere");
    expect(line.text).toBe(`started from ${short(rec.commit)} (#864) on ${START} on branch feat · the checkout is on feat now, and code loaded on first use comes from it`);
  });

  test("a start on a branch, then back on the default branch: the start names its branch", async () => {
    const { clone } = fixture();
    sh(clone, "checkout", "-q", "-b", "feat");
    const rec = known(await record(clone));
    sh(clone, "checkout", "-q", "main");
    expect((await lineOf(rec)).text).toBe(`started from ${short(rec.commit)} (#864) on ${START} on branch feat`);
  });

  test("a start on a detached HEAD: named", async () => {
    const { clone } = fixture();
    sh(clone, "checkout", "-q", "--detach");
    const rec = known(await record(clone));
    expect(rec.branch).toBeNull();
    expect((await lineOf(rec)).text).toStartWith(`started from ${short(rec.commit)} (#864) on ${START}, detached HEAD · the checkout is on a detached HEAD`);
  });

  test("origin unreachable: the start facts and «not compared: origin not read», nothing else", async () => {
    const { remote, work, clone } = fixture();
    const rec = known(await record(clone));
    push(work, "never seen (#891)");
    writeFileSync(path.join(clone, "f"), "edited\n");
    rmSync(remote, { recursive: true, force: true });
    const line = await lineOf(rec);
    expect(line.row).toBe("not-compared");
    expect(line.defaultBranch).toBeNull();
    expect(line.text).toBe(`started from ${short(rec.commit)} (#864) on ${START} on branch main · not compared: origin not read`);
  });

  test("a local origin (never proven another repository): not compared", async () => {
    const { clone } = fixture();
    const rec = known(await record(clone, hermeticGit));
    expect((await lineOf(rec, hermeticGit)).row).toBe("not-compared");
  });

  test("an unknown record: the line says so and reads nothing", async () => {
    let calls = 0;
    const counting: GitRun = async () => {
      calls++;
      return { ok: false, stdout: "" };
    };
    const line = await lineOf({ known: false, reason: "muninn did not start from a git checkout", at: AT }, counting);
    expect(line).toMatchObject({ row: "start-unknown", text: "start commit unknown: muninn did not start from a git checkout" });
    expect(calls).toBe(0);
  });
});

describe("GET /api/wiki/boot-line", () => {
  test("answers the line, and a second ask inside 30 s runs no git (one ls-remote per window)", async () => {
    const { clone } = fixture();
    const rec = known(await record(clone));
    let lsRemote = 0;
    const counting: GitRun = async (cwd, args, opts) => {
      if (args[0] === "ls-remote" && args.includes("--symref")) lsRemote++;
      return NETWORK(cwd, args, opts);
    };
    const app = new Hono();
    const cache = new ProbeCache();
    registerWikiBootLineRoute(app, () => ({ record: async () => rec, git: counting, slots: new ProbeSlots(4), cache }));
    const a = (await (await app.request("/api/wiki/boot-line")).json()) as BootLine;
    const b = (await (await app.request("/api/wiki/boot-line")).json()) as BootLine;
    expect(a.row).toBe("same");
    expect(b.text).toBe(a.text);
    expect(a.record).toEqual({ known: true, commit: rec.commit, branch: "main", dirty: false, pr: 864, at: AT } as unknown as BootRecord);
    expect(JSON.stringify(a)).not.toContain(clone);
    expect(lsRemote).toBe(1);
  });

  test("every git call holds one of the shared slots", async () => {
    const { clone } = fixture();
    const rec = known(await record(clone));
    const slots = new ProbeSlots(1);
    let inside = 0;
    let most = 0;
    const tracking: GitRun = async (cwd, args, opts) => {
      inside++;
      most = Math.max(most, inside);
      try {
        return await NETWORK(cwd, args, opts);
      } finally {
        inside--;
      }
    };
    let held = false;
    // Hold the only slot: the line waits until it is released.
    let release!: () => void;
    const holder = slots.run(() => new Promise<void>((r) => (release = r)).then(() => void (held = true)));
    const pending = readBootLine(rec, { git: bootLineGit(tracking, slots) });
    await Bun.sleep(50);
    expect(inside).toBe(0);
    release();
    await holder;
    expect(held).toBe(true);
    expect((await pending).row).toBe("same");
    expect(most).toBe(1);
  });
});
