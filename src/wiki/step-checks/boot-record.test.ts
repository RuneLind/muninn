/**
 * The boot record against real git on throwaway repos (`src/test/boot-git-fixture.ts`).
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootFixture, commit, sh } from "../../test/boot-git-fixture.ts";
import { hermeticGit } from "../../test/hermetic-git.ts";
import { testTempDirSync } from "../../test/temp-dir.ts";
import type { GitRun } from "../decision-triage/git.ts";
import { parseStatusV2, prOfSubject, takeBootRecord, type BootRecord } from "./boot-record.ts";
import { CHECKOUT_GIT_ENV } from "./probes.ts";

const AT = new Date(2026, 10, 14, 20, 58).getTime();
const record = (dir: string, git: GitRun = hermeticGit) => takeBootRecord(dir, git, () => AT);
const known = (rec: BootRecord) => {
  if (!rec.known) throw new Error(`unknown record: ${rec.reason}`);
  return rec;
};

describe("the boot record", () => {
  test("a clean start: the commit, the full ref, clean, the subject's PR", async () => {
    const { clone } = bootFixture();
    expect(await record(clone)).toEqual({ known: true, dir: clone, commit: sh(clone, "rev-parse", "HEAD"), ref: "refs/heads/main", pr: 864, tracked: { state: "clean" }, at: AT });
  });

  test("read in the repo holding the folder it is given, from a subdirectory too", async () => {
    const { clone } = bootFixture();
    mkdirSync(path.join(clone, "src/wiki"), { recursive: true });
    expect(known(await record(path.join(clone, "src/wiki"))).dir).toBe(clone);
  });

  test("a detached start: ref null", async () => {
    const { clone } = bootFixture();
    sh(clone, "checkout", "-q", "--detach");
    expect(known(await record(clone)).ref).toBeNull();
  });

  test("a dirty start: a hash, stable across two reads, that moves with a further edit", async () => {
    const { clone } = bootFixture();
    writeFileSync(path.join(clone, "f"), "edited\n");
    const a = known(await record(clone)).tracked;
    const b = known(await record(clone)).tracked;
    expect(a.state).toBe("dirty");
    expect(b).toEqual(a);
    writeFileSync(path.join(clone, "f"), "edited again\n");
    expect(known(await record(clone)).tracked).not.toEqual(a);
  });

  test("an untracked file is not a difference", async () => {
    const { clone } = bootFixture();
    writeFileSync(path.join(clone, "new"), "x\n");
    expect(known(await record(clone)).tracked).toEqual({ state: "clean" });
  });

  test("a rename whose original path looks like a status header: the header is not read from it", async () => {
    const { clone } = bootFixture();
    const fake = "# branch.oid 0000000000000000000000000000000000000000";
    sh(clone, "mv", "g", fake);
    sh(clone, "commit", "-q", "-m", "odd name");
    sh(clone, "mv", fake, "g2");
    const rec = known(await record(clone));
    expect(rec.commit).toBe(sh(clone, "rev-parse", "HEAD"));
    expect(rec.tracked.state).toBe("dirty");
  });

  test("a folder with no git: unknown, named as such", async () => {
    const dir = realpathSync(testTempDirSync(path.join(tmpdir(), "boot-nogit-")));
    expect(await record(dir)).toEqual({ known: false, reason: "muninn did not start from a git checkout", at: AT });
  });

  test("git that cannot run: unknown, «could not run»", async () => {
    const noGit: GitRun = async () => ({ ok: false, stdout: "", stderr: "spawn failed" });
    expect(await record("/x", noGit)).toEqual({ known: false, reason: "git rev-parse could not run at start", at: AT });
  });

  test("a slow read: unknown, «timed out»", async () => {
    const slow: GitRun = async () => ({ ok: false, stdout: "", timedOut: true });
    expect(await record("/x", slow)).toEqual({ known: false, reason: "git rev-parse timed out at start", at: AT });
  });

  test("a capped status is no failure: the record is known, its tracked files too large", async () => {
    const { clone } = bootFixture();
    writeFileSync(path.join(clone, "f"), "edited\n");
    const capped: GitRun = async (cwd, args, opts) => {
      const res = await hermeticGit(cwd, args, opts);
      return args.includes("status") ? { ok: true, stdout: res.stdout.split("\0")[0]!, capped: true } : res;
    };
    expect(known(await record(clone, capped)).tracked).toEqual({ state: "too-large" });
  });

  test("a capped diff: too large, never a hash of a prefix", async () => {
    const { clone } = bootFixture();
    writeFileSync(path.join(clone, "f"), "edited\n");
    const capped: GitRun = async (cwd, args, opts) => (args.includes("diff") ? { ok: true, stdout: "diff --git", capped: true } : hermeticGit(cwd, args, opts));
    expect(known(await record(clone, capped)).tracked).toEqual({ state: "too-large" });
  });

  test("a pull racing the start (HEAD moves between rev-parse and status): unknown", async () => {
    const { clone } = bootFixture();
    let moved = false;
    const racing: GitRun = async (cwd, args, opts) => {
      if (args.includes("status") && !moved) {
        moved = true;
        commit(clone, "landed mid-start (#900)");
      }
      return hermeticGit(cwd, args, opts);
    };
    expect(await record(clone, racing)).toEqual({ known: false, reason: "the checkout moved while muninn started", at: AT });
  });

  test("every call carries CHECKOUT_GIT_ENV", async () => {
    const { clone } = bootFixture();
    writeFileSync(path.join(clone, "f"), "edited\n");
    const envs: (Readonly<Record<string, string>> | undefined)[] = [];
    const spy: GitRun = (cwd, args, opts) => {
      envs.push(opts?.env);
      return hermeticGit(cwd, args, opts);
    };
    known(await record(clone, spy));
    expect(envs.length).toBe(5);
    for (const env of envs) expect(env).toMatchObject(CHECKOUT_GIT_ENV);
  });
});

describe("parse helpers", () => {
  test("prOfSubject: a trailing (#N) only", () => {
    expect(prOfSubject("Keep focus (#865)")).toBe(865);
    expect(prOfSubject("Merge pull request #12 from x/y")).toBeNull();
    expect(prOfSubject("Mentions (#3) mid-line")).toBeNull();
  });

  test("parseStatusV2: headers, entries, a rename's second field, an unknown shape", () => {
    expect(parseStatusV2("# branch.oid abc\0# branch.head (detached)\0")).toEqual({ oid: "abc", entries: [] });
    expect(parseStatusV2("# branch.oid abc\x001 .M N... 100644 100644 100644 a b f\0")).toEqual({ oid: "abc", entries: ["1 .M N... 100644 100644 100644 a b f"] });
    expect(parseStatusV2("# branch.oid abc\x002 R. N... 100644 100644 100644 a a R100 new\0# branch.oid zzz\0")).toEqual({ oid: "abc", entries: ["2 R. N... 100644 100644 100644 a a R100 new\0# branch.oid zzz"] });
    expect(parseStatusV2("garbage\0")).toBeNull();
  });
});
