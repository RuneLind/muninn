/**
 * The boot line against real git on throwaway repos (`src/test/boot-git-fixture.ts`):
 * one test per row, per addendum state and per unknown. Origin's URL is faked
 * to a network one (`networkOrigin`); every other call, the live
 * `ls-remote --symref` included, reaches the real bare repo.
 */
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { bootFixture, commit, manyCommits, pull, push, sh, signCommits } from "../../test/boot-git-fixture.ts";
import { hermeticGit, networkOrigin } from "../../test/hermetic-git.ts";
import type { GitRun } from "../decision-triage/git.ts";
import { ProbeSlots } from "./answer.ts";
import { BOOT_LINE_BOUND_MS, bootLineGit, formatStartTime, readBootLine, readRow, trackedText } from "./boot-line.ts";
import { readTracked, takeBootRecord, type BootRecord } from "./boot-record.ts";
import { checkoutCompare } from "./probes.ts";

const NETWORK = networkOrigin("https://example.invalid/muninn.git");
const AT = new Date(2026, 10, 14, 20, 58).getTime();
const NOW = new Date(2026, 10, 15, 9, 0).getTime();
const START = formatStartTime(AT, NOW);

const record = (dir: string, git: GitRun = NETWORK) => takeBootRecord(dir, git, () => AT);
const lineOf = (rec: BootRecord, git: GitRun = NETWORK) => readBootLine(rec, { git, slots: new ProbeSlots(4), now: () => NOW });
const known = (rec: BootRecord) => {
  if (!rec.known) throw new Error(`unknown record: ${rec.reason}`);
  return rec;
};
const short = (sha: string) => sha.slice(0, 8);
/** `git` whose `ls-remote` to origin fails as an unreachable host does. */
const offline: GitRun = async (cwd, args, opts) => (args[0] === "ls-remote" && args[1] === "--symref" ? { ok: false, stdout: "", stderr: "Could not resolve host", exitCode: 128 } : NETWORK(cwd, args, opts));

describe("the rows", () => {
  test("at the start commit: the start commit and the time, nothing else", async () => {
    const { clone } = bootFixture();
    const rec = known(await record(clone));
    const line = await lineOf(rec);
    expect(line).toMatchObject({ row: "same", restart: false, unread: [] });
    expect(line.text).toBe(`started from ${short(rec.commit)} (#864) on ${START}`);
  });

  test("HEAD ahead by one PR: «the checkout holds 1 newer PR: #865: restart»", async () => {
    const { clone, work } = bootFixture();
    const rec = known(await record(clone));
    push(work, "Keep focus (#865)");
    pull(clone);
    const line = await lineOf(rec);
    expect(line).toMatchObject({ row: "newer", restart: true });
    expect(line.text).toBe(`started from ${short(rec.commit)} (#864) on ${START} · the checkout holds 1 newer PR: #865: restart`);
  });

  test("a commit without (#N) is counted as one", async () => {
    const { clone, work } = bootFixture();
    const rec = known(await record(clone));
    push(work, "Hand fix");
    push(work, "Keep focus (#865)");
    pull(clone);
    expect((await lineOf(rec)).text).toEndWith(" · the checkout holds 1 newer PR: #865 and 1 commit without a PR number: restart");
  });

  test("log.showSignature on and signed newer commits: each commit counted once", async () => {
    const { clone, work } = bootFixture();
    const rec = known(await record(clone));
    signCommits(work);
    signCommits(clone);
    push(work, "Keep focus (#865)");
    pull(clone);
    expect((await lineOf(rec)).text).toEndWith(" · the checkout holds 1 newer PR: #865: restart");
  });

  test("more than 8 PRs: oldest first, then «and N more»", async () => {
    const { clone } = bootFixture();
    const rec = known(await record(clone));
    manyCommits(clone, 10, (i) => `Change ${i} (#${900 + i})`);
    expect((await lineOf(rec)).text).toEndWith(" · the checkout holds 10 newer PRs: #900, #901, #902, #903, #904, #905, #906, #907 and 2 more: restart");
  });

  test("the 500 cap: «more than 500 newer commits»", async () => {
    const { clone } = bootFixture();
    const rec = known(await record(clone));
    manyCommits(clone, 503, (i) => `Change ${i} (#${1000 + i})`);
    // The newest 500 are read: #1003 to #1502.
    expect((await lineOf(rec)).text).toEndWith(" · the checkout holds more than 500 newer commits, among them 500 newer PRs: #1003, #1004, #1005, #1006, #1007, #1008, #1009, #1010 and 492 more: restart");
  });

  test("another branch: names it, says code loaded on first use comes from it, no restart or pull advice", async () => {
    const { clone, work } = bootFixture();
    const rec = known(await record(clone));
    push(work, "Ahead (#865)");
    sh(clone, "checkout", "-q", "-b", "feature");
    const line = await lineOf(rec);
    expect(line).toMatchObject({ row: "elsewhere", restart: false });
    expect(line.text).toBe(`started from ${short(rec.commit)} (#864) on ${START} · the checkout is on feature now, and code loaded on first use comes from it · origin has commits this checkout lacks`);
  });

  test("detached when it was not: «a detached HEAD at <sha>»", async () => {
    const { clone } = bootFixture();
    const rec = known(await record(clone));
    const sha = commit(clone, "local (#870)");
    sh(clone, "checkout", "-q", "--detach");
    expect((await lineOf(rec)).text).toEndWith(` · the checkout is on a detached HEAD at ${short(sha)} now, and code loaded on first use comes from it`);
  });

  test("a tag named like the branch does not read as another branch", async () => {
    const { clone } = bootFixture();
    const rec = known(await record(clone));
    sh(clone, "tag", "main");
    expect((await lineOf(rec)).row).toBe("same");
  });

  test("reset to another history: «moved off the start commit: restart», and origin ahead without «: pull»", async () => {
    const { clone } = bootFixture();
    const rec = known(await record(clone));
    sh(clone, "checkout", "-q", "--orphan", "tmp");
    commit(clone, "other root");
    sh(clone, "branch", "-f", "main", "HEAD");
    sh(clone, "checkout", "-q", "main");
    const line = await lineOf(rec);
    expect(line).toMatchObject({ row: "moved-off", restart: true });
    expect(line.text).toBe(`started from ${short(rec.commit)} (#864) on ${START} · the checkout has moved off the start commit: restart · origin has commits this checkout lacks`);
  });

  test("the start commit pruned from the object store: moved off", async () => {
    const { clone, remote } = bootFixture();
    const rec = known(await record(clone));
    // Forget origin too, so nothing keeps the start commit reachable.
    sh(clone, "remote", "remove", "origin");
    sh(clone, "checkout", "-q", "--orphan", "tmp");
    commit(clone, "other root");
    sh(clone, "branch", "-f", "main", "HEAD");
    sh(clone, "checkout", "-q", "main");
    sh(clone, "branch", "-D", "tmp");
    sh(clone, "reflog", "expire", "--expire=now", "--all");
    sh(clone, "gc", "-q", "--prune=now");
    expect(() => sh(clone, "cat-file", "-e", `${rec.commit}^{commit}`)).toThrow();
    sh(clone, "remote", "add", "origin", remote);
    expect((await lineOf(rec)).text).toContain(" · the checkout has moved off the start commit: restart");
  });

  test("a shallow clone that moved: «moved since start: restart»", async () => {
    const { base, remote, work } = bootFixture();
    const shallow = path.join(base, "shallow");
    sh(base, "clone", "-q", "--depth", "1", `file://${remote}`, shallow);
    const rec = known(await record(shallow));
    push(work, "Next (#865)");
    sh(shallow, "fetch", "-q", "--depth", "1", "origin", "main");
    sh(shallow, "reset", "-q", "--hard", "origin/main");
    const line = await lineOf(rec);
    expect(line).toMatchObject({ row: "moved-off", restart: true });
    expect(line.text).toContain(" · the checkout has moved since start: restart");
  });

  test("started on a non-default branch, then that branch moved: newer, and the start names both branches", async () => {
    const { clone, work } = bootFixture();
    sh(work, "checkout", "-q", "-b", "feature");
    push(work, "Feature base (#866)", "feature");
    sh(clone, "fetch", "-q");
    sh(clone, "checkout", "-q", "-b", "feature", "origin/feature");
    const rec = known(await record(clone));
    push(work, "Feature next (#867)", "feature");
    sh(clone, "pull", "-q", "--ff-only", "origin", "feature");
    const line = await lineOf(rec);
    expect(line.text).toStartWith(`started from ${short(rec.commit)} (#866) on ${START} on feature (origin's default branch is main) · the checkout holds 1 newer PR: #867: restart`);
  });

  test("replace refs and grafts cannot fake ancestry: CHECKOUT_GIT_ENV reaches the row's reads", async () => {
    const { clone } = bootFixture();
    const rec = known(await record(clone));
    sh(clone, "checkout", "-q", "--orphan", "tmp");
    const other = commit(clone, "other root (#999)");
    sh(clone, "branch", "-f", "main", "HEAD");
    sh(clone, "checkout", "-q", "main");
    // Both rewrite `other`'s parent to the start commit, for any git that honours them.
    writeFileSync(path.join(clone, ".git/info/grafts"), `${other} ${rec.commit}\n`);
    sh(clone, "replace", "--graft", other, rec.commit);
    expect(sh(clone, "merge-base", "--is-ancestor", rec.commit, other)).toBe("");
    expect((await lineOf(rec)).row).toBe("moved-off");
  });

  test("a start record that is unknown: says so and why", async () => {
    const line = await lineOf({ known: false, reason: "muninn did not start from a git checkout", at: AT });
    expect(line).toMatchObject({ row: "start-unknown", text: "start commit unknown: muninn did not start from a git checkout" });
  });

  test("a row read that fails: «the checkout not read», the addenda still read", async () => {
    const { clone } = bootFixture();
    const rec = known(await record(clone));
    const broken: GitRun = async (cwd, args, opts) => (args[0] === "symbolic-ref" ? { ok: false, stdout: "", stderr: "fatal: boom", exitCode: 128 } : NETWORK(cwd, args, opts));
    const line = await lineOf(rec, broken);
    expect(line).toMatchObject({ row: "unread", unread: ["the checkout"] });
    expect(line.text).toBe(`started from ${short(rec.commit)} (#864) on ${START} · the checkout not read: git symbolic-ref failed`);
  });
});

describe("the tracked-files addendum", () => {
  test("clean at start and now: nothing", async () => {
    const { clone } = bootFixture();
    expect((await lineOf(known(await record(clone)))).text).not.toContain("tracked");
  });

  test("clean at start, edited now: «have changed since start»", async () => {
    const { clone } = bootFixture();
    const rec = known(await record(clone));
    writeFileSync(path.join(clone, "f"), "edited\n");
    expect((await lineOf(rec)).text).toBe(`started from ${short(rec.commit)} (#864) on ${START} · tracked files have changed since start`);
  });

  test("dirty at start and the same now: «as they did at start»", async () => {
    const { clone } = bootFixture();
    writeFileSync(path.join(clone, "f"), "edited\n");
    const rec = known(await record(clone));
    expect((await lineOf(rec)).text).toEndWith(" · tracked files differ from HEAD, as they did at start");
  });

  test("dirty at start, then another file edited: changed", async () => {
    const { clone } = bootFixture();
    writeFileSync(path.join(clone, "f"), "edited\n");
    const rec = known(await record(clone));
    writeFileSync(path.join(clone, "g"), "also edited\n");
    expect((await lineOf(rec)).text).toEndWith(" · tracked files have changed since start");
  });

  test("dirty at start, then the same file edited further: changed", async () => {
    const { clone } = bootFixture();
    writeFileSync(path.join(clone, "f"), "edited\n");
    const rec = known(await record(clone));
    writeFileSync(path.join(clone, "f"), "edited further\n");
    expect((await lineOf(rec)).text).toEndWith(" · tracked files have changed since start");
  });

  test("dirty at start, then reverted: changed", async () => {
    const { clone } = bootFixture();
    writeFileSync(path.join(clone, "f"), "edited\n");
    const rec = known(await record(clone));
    sh(clone, "checkout", "--", "f");
    expect((await lineOf(rec)).text).toEndWith(" · tracked files have changed since start");
  });

  test("a status that fails: «tracked files not read», the row kept", async () => {
    const { clone, work } = bootFixture();
    const rec = known(await record(clone));
    push(work, "Keep focus (#865)");
    pull(clone);
    const broken: GitRun = async (cwd, args, opts) => (args.includes("status") ? { ok: false, stdout: "", stderr: "fatal: index locked", exitCode: 128 } : NETWORK(cwd, args, opts));
    const line = await lineOf(rec, broken);
    expect(line).toMatchObject({ row: "newer", restart: true, unread: ["tracked files"] });
    expect(line.text).toBe(`started from ${short(rec.commit)} (#864) on ${START} · the checkout holds 1 newer PR: #865: restart · tracked files not read: git status failed`);
  });

  test("too large to compare at start and now: «tracked files» is in unread, as the text says", async () => {
    const { clone } = bootFixture();
    writeFileSync(path.join(clone, "f"), "edited\n");
    const capped: GitRun = async (cwd, args, opts) => (args.includes("diff") ? { ok: true, stdout: "diff --git", capped: true } : NETWORK(cwd, args, opts));
    const rec = known(await record(clone, capped));
    expect(rec.tracked).toEqual({ state: "too-large" });
    const line = await lineOf(rec, capped);
    expect(line).toMatchObject({ row: "same", unread: ["tracked files"] });
    expect(line.text).toEndWith(" · tracked files not read: the difference from HEAD is too large to compare");
  });

  test("the pairs trackedText cannot see in a real repo", () => {
    expect(trackedText({ state: "too-large" }, { state: "too-large" })).toBe("tracked files not read: the difference from HEAD is too large to compare");
    expect(trackedText({ state: "too-large" }, { state: "clean" })).toBe("tracked files have changed since start");
    expect(trackedText({ state: "clean" }, { state: "too-large" })).toBe("tracked files have changed since start");
    expect(trackedText({ state: "dirty", hash: "a" }, { state: "dirty", hash: "b" })).toBe("tracked files have changed since start");
  });
});

describe("the origin addendum", () => {
  test("origin ahead and not fetched: «origin has commits this checkout lacks: pull»", async () => {
    const { clone, work } = bootFixture();
    const rec = known(await record(clone));
    push(work, "Merged after start (#865)");
    const line = await lineOf(rec);
    expect(line.row).toBe("same");
    expect(line.text).toBe(`started from ${short(rec.commit)} (#864) on ${START} · origin has commits this checkout lacks: pull`);
  });

  test("origin unreachable with one newer PR pulled locally: still «restart», origin «not read» with the reason", async () => {
    const { clone, work } = bootFixture();
    const rec = known(await record(clone));
    push(work, "Keep focus (#865)");
    pull(clone);
    const line = await lineOf(rec, offline);
    expect(line).toMatchObject({ row: "newer", restart: true, unread: ["origin"] });
    expect(line.text).toBe(`started from ${short(rec.commit)} (#864) on ${START} · the checkout holds 1 newer PR: #865: restart · origin not read: git ls-remote failed: origin's default branch is unknown`);
  });

  test("a local-path origin: «origin not read» with the probe's own reason", async () => {
    const { clone } = bootFixture();
    const rec = known(await record(clone, hermeticGit));
    expect((await lineOf(rec, hermeticGit)).text).toEndWith(" · origin not read: the checkout's origin is not a network address: muninn cannot prove it is another repository");
  });

  test("an operation in progress: «origin not read» with the probe's reason", async () => {
    const { clone } = bootFixture();
    const rec = known(await record(clone));
    writeFileSync(path.join(clone, ".git/MERGE_HEAD"), `${rec.commit}\n`);
    expect((await lineOf(rec)).text).toEndWith(" · origin not read: the checkout has a merge in progress");
  });

  test("a partial clone: «origin not read»", async () => {
    const { clone } = bootFixture();
    const rec = known(await record(clone));
    sh(clone, "config", "remote.origin.promisor", "true");
    expect((await lineOf(rec)).text).toEndWith(" · origin not read: the checkout is a partial clone: muninn does not look up objects it would have to fetch");
  });
});

describe("the bound", () => {
  /** Each call's own bound, summed over one part's chain of calls (they run one after another). */
  const chain = async (read: (git: GitRun) => Promise<unknown>) => {
    let ms = 0;
    let calls = 0;
    await read((cwd, args, opts) => ((ms += opts?.timeoutMs ?? 0), calls++, NETWORK(cwd, args, opts)));
    return { ms, calls };
  };

  test("covers each part's longest chain of calls, every call slow but inside its own bound", async () => {
    const newer = bootFixture();
    const newerRec = known(await record(newer.clone));
    push(newer.work, "Keep focus (#865)");
    pull(newer.clone);
    const movedOff = bootFixture();
    const movedOffRec = known(await record(movedOff.clone));
    sh(movedOff.clone, "checkout", "-q", "--orphan", "tmp");
    commit(movedOff.clone, "other root");
    sh(movedOff.clone, "branch", "-f", "main", "HEAD");
    sh(movedOff.clone, "checkout", "-q", "main");
    writeFileSync(path.join(newer.clone, "g"), "edited\n");
    const chains = {
      newer: await chain((git) => readRow(newerRec, git)),
      movedOff: await chain((git) => readRow(movedOffRec, git)),
      dirty: await chain((git) => readTracked(newer.clone, git)),
      origin: await chain((git) => checkoutCompare(movedOff.work, "the checkout", git)),
    };
    // The longest chains: the row's 5 local calls, status + diff, and origin's 5 local calls + ls-remote.
    expect(Object.values(chains).map((c) => c.calls)).toEqual([5, 5, 2, 6]);
    for (const c of Object.values(chains)) expect(c.ms).toBeLessThanOrEqual(BOOT_LINE_BOUND_MS);
  });

  test("a call made after the bound expired takes no slot and never runs", async () => {
    let slotted = 0;
    const slots = new (class extends ProbeSlots {
      override run<T>(fn: () => Promise<T>): Promise<T> {
        slotted++;
        return super.run(fn);
      }
    })(1);
    let ran = 0;
    const git = bootLineGit(async () => (ran++, { ok: true, stdout: "", exitCode: 0 }), slots, () => true);
    expect(await git("/x", ["status"], {})).toMatchObject({ ok: false, timedOut: true });
    expect({ slotted, ran }).toEqual({ slotted: 0, ran: 0 });
  });
});

describe("formatStartTime", () => {
  test("the year shows only when it is not the current one", () => {
    expect(formatStartTime(new Date(2026, 10, 14, 20, 58).getTime(), NOW)).toBe("14.11 20:58");
    expect(formatStartTime(new Date(2025, 0, 2, 7, 5).getTime(), NOW)).toBe("02.01.2025 07:05");
  });
});
