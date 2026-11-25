/**
 * `tracked-files.ts` on a real temp git repo: tracked, untracked, ignored,
 * write-artifact, symlink-out and `../` cases, a wiki in a subdirectory of the
 * repo, a non-ASCII name returned by grep and read back, and a glob whose
 * out-of-glob hits sort before the cap. Invented content only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { realGit, type GitRun } from "./decision-triage/git.ts";
import { WIKI_LOCK_BASENAME } from "./lockfile.ts";
import { testTempDir } from "../test/temp-dir.ts";
import { GREP_SCAN_LINES, chunkPaths, globMatches, grepTracked, historyFor, isSafeRelPath, readTracked, trackedFiles } from "./tracked-files.ts";

let repo = "";
let wiki = ""; // a wiki in a subdirectory of `repo`
let outside = "";
const NB = "notes/Feil i drift — mønstre.md";

async function git(cwd: string, ...args: string[]) {
  const res = await realGit(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args]);
  if (!res.ok) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout;
}

async function put(rel: string, text: string) {
  await mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
  await writeFile(path.join(repo, rel), text);
}

beforeAll(async () => {
  const base = await realpath(await testTempDir(path.join(tmpdir(), "muninn-tracked-")));
  repo = path.join(base, "repo");
  outside = path.join(base, "outside.md");
  wiki = path.join(repo, "wiki");
  await mkdir(repo, { recursive: true });
  await writeFile(outside, "KEY-1 outside the wiki\n");
  await git(repo, "init", "-q", "-b", "main");
  await put("README.md", "KEY-1 in the repo root, outside the wiki\n");
  await put("wiki/a.md", "line one\nKEY-1 first\nline three\n");
  await put(`wiki/${NB}`, "Overskrift\nKEY-1 står her — med æøå\n");
  await put("wiki/plans/Q-3.csv", "id;key\n1;KEY-1\n");
  await put("wiki/.gitignore", "ignored.md\n");
  await put("wiki/ignored.md", "KEY-1 ignored\n");
  await put(`wiki/${WIKI_LOCK_BASENAME}`, "KEY-1 lock\n");
  await git(repo, "add", "-A");
  await git(repo, "add", "-f", `wiki/${WIKI_LOCK_BASENAME}`, "wiki/ignored.md");
  await git(repo, "commit", "-q", "-m", "first: add KEY-1");
  // Untracked after the commit; `ignored.md` is tracked-then-removed from the index below.
  await git(repo, "rm", "-q", "--cached", "wiki/ignored.md");
  await symlink(outside, path.join(wiki, "link-out.md"));
  await git(repo, "add", "wiki/link-out.md");
  await put("wiki/draft.md", "KEY-1 untracked draft\n");
  await put("wiki/b.md", "no key here\n");
  await git(repo, "add", "wiki/b.md");
  await git(repo, "commit", "-q", "-m", "second: link and b, drop ignored");
  await put("wiki/b.md", "now KEY-1 too\n");
  await git(repo, "commit", "-q", "-am", "third: KEY-1 into b");
});

afterAll(async () => {
  await rm(path.dirname(repo), { recursive: true, force: true });
});

describe("trackedFiles", () => {
  test("lists tracked files root-relative, without untracked, ignored or write artifacts", async () => {
    const res = await trackedFiles(wiki);
    if (!res.ok) throw new Error(res.error);
    expect(res.files.sort()).toEqual([".gitignore", "a.md", "b.md", "link-out.md", NB, "plans/Q-3.csv"].sort());
  });
  test("a directory outside any work tree is an error, not an empty list", async () => {
    const res = await trackedFiles(path.dirname(repo));
    expect(res.ok).toBe(false);
  });
});

describe("grepTracked", () => {
  test("finds a key in tracked files only, with wiki-root-relative paths, a non-ASCII one verbatim", async () => {
    const res = await grepTracked(wiki, "KEY-1");
    if (!res.ok) throw new Error(res.error);
    const files = [...new Set(res.hits.map((h) => h.relPath))].sort();
    expect(files).toEqual(["a.md", "b.md", NB, "plans/Q-3.csv"].sort());
    expect(res.hits.find((h) => h.relPath === "a.md")).toEqual({ relPath: "a.md", line: 2, text: "KEY-1 first" });
    expect(res.hits.find((h) => h.relPath === NB)!.text).toBe("KEY-1 står her — med æøå");
    expect(res).toMatchObject({ totalLines: 4, totalFiles: 4, atLeast: false });
  });
  test("zero hits (git grep's exit 1) is an empty result, not an error", async () => {
    const res = await grepTracked(wiki, "NO-SUCH-KEY-77");
    expect(res).toEqual({ ok: true, hits: [], totalLines: 0, totalFiles: 0, atLeast: false });
  });
  test("a fixed string is not a regex; regex: true reads it as one", async () => {
    const fixed = await grepTracked(wiki, "KEY-.");
    expect(fixed.ok && fixed.hits.length).toBe(0);
    const re = await grepTracked(wiki, "KEY-[0-9]", { regex: true });
    expect(re.ok && re.hits.length).toBe(4);
  });
  test("a pattern starting with - is a pattern, not an option", async () => {
    const res = await grepTracked(wiki, "--no-index");
    expect(res).toEqual({ ok: true, hits: [], totalLines: 0, totalFiles: 0, atLeast: false });
  });
  test("max cuts the returned hits and the totals still count every line", async () => {
    const res = await grepTracked(wiki, "KEY-1", { max: 1 });
    if (!res.ok) throw new Error(res.error);
    expect(res.hits).toHaveLength(1);
    expect(res).toMatchObject({ totalLines: 4, totalFiles: 4 });
  });
  test("a glob limits what git searches, so hits outside it that sort first do not use up the cap", async () => {
    // a.md and b.md sort before plans/Q-3.csv; with max 1 and no glob they would fill it.
    const res = await grepTracked(wiki, "KEY-1", { glob: "*.csv", max: 1 });
    if (!res.ok) throw new Error(res.error);
    expect(res.hits).toEqual([{ relPath: "plans/Q-3.csv", line: 2, text: "1;KEY-1" }]);
    expect(res).toMatchObject({ totalLines: 1, totalFiles: 1, atLeast: false });
    const none = await grepTracked(wiki, "KEY-1", { glob: "*.nothing" });
    expect(none).toEqual({ ok: true, hits: [], totalLines: 0, totalFiles: 0, atLeast: false });
  });
  test("the scan bound turns the totals into lower bounds", async () => {
    const fake: GitRun = async (cwd, args, opts) => {
      if (args.includes("grep")) {
        const lines = Array.from({ length: opts!.maxLines! }, (_, i) => `f${i}.md\x00${i + 1}\x00KEY-1`);
        return { ok: true, stdout: lines.join("\n"), capped: true };
      }
      return realGit(cwd, args, opts);
    };
    const res = await grepTracked(wiki, "KEY-1", { git: fake, max: 3 });
    if (!res.ok) throw new Error(res.error);
    expect(res).toMatchObject({ totalLines: GREP_SCAN_LINES, atLeast: true });
    expect(res.hits).toHaveLength(3);
  });
  test("a byte-capped run drops its last, possibly cut line", async () => {
    const fake: GitRun = async () => ({ ok: true, stdout: "a.md\x001\x00KEY-1 whole\nb.md\x002\x00KEY-1 cu", capped: true });
    const res = await grepTracked(wiki, "KEY-1", { git: fake });
    expect(res.ok && res.hits.map((h) => h.relPath)).toEqual(["a.md"]);
  });
  test("a git failure is an error", async () => {
    const fake: GitRun = async () => ({ ok: false, stdout: "", stderr: "fatal: bad thing", exitCode: 128 });
    const res = await grepTracked(wiki, "KEY-1", { git: fake });
    expect(res).toEqual({ ok: false, error: "git grep failed: fatal: bad thing" });
  });
});

describe("globMatches and chunkPaths", () => {
  test("a glob without / also matches the file name at any depth", () => {
    expect(globMatches("*.csv", "plans/x/Q-3.csv")).toBe(true);
    expect(globMatches("plans/**", "plans/x/Q-3.csv")).toBe(true);
    expect(globMatches("plans/*.csv", "plans/x/Q-3.csv")).toBe(false);
    expect(globMatches("*.md", "plans/x/Q-3.csv")).toBe(false);
  });
  test("paths are split by byte size, order kept, nothing lost", () => {
    const paths = Array.from({ length: 50 }, (_, i) => `dir/file-${i}-æøå.md`);
    const chunks = chunkPaths(paths, 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(paths);
    for (const c of chunks) expect(c.reduce((n, p) => n + Buffer.byteLength(p) + 1, 0)).toBeLessThanOrEqual(200);
  });
  test("a glob hands git the expanded literal paths, never a dot", async () => {
    const seen: string[][] = [];
    const spy: GitRun = async (cwd, args, opts) => {
      if (args.includes("grep")) seen.push(args.slice(args.indexOf("--") + 1));
      return realGit(cwd, args, opts);
    };
    const res = await grepTracked(wiki, "KEY-1", { git: spy, glob: "**" });
    expect(res.ok && res.totalFiles).toBe(4);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain(".");
  });
});

describe("historyFor", () => {
  test("lists the commits that changed the term's count, newest first, with root-relative files", async () => {
    const res = await historyFor(wiki, "KEY-1");
    if (!res.ok) throw new Error(res.error);
    expect(res.commits.map((c) => c.subject)).toEqual(["third: KEY-1 into b", "second: link and b, drop ignored", "first: add KEY-1"]);
    expect(res.commits[0]!.files).toEqual(["b.md"]);
    // `--relative`: README.md (outside the wiki) is not named, the wiki's files have no `wiki/` prefix.
    const first = res.commits[2]!.files;
    expect(first).toContain(NB);
    expect(first).toContain("a.md");
    expect(first).not.toContain("README.md");
    expect(first.some((f) => f.startsWith("wiki/"))).toBe(false);
  });
  test("path and limit narrow it", async () => {
    const one = await historyFor(wiki, "KEY-1", { path: "b.md" });
    expect(one.ok && one.commits.map((c) => c.subject)).toEqual(["third: KEY-1 into b"]);
    const lim = await historyFor(wiki, "KEY-1", { limit: 1 });
    expect(lim.ok && lim.commits).toHaveLength(1);
  });
  test("a path climbing out of the wiki is refused", async () => {
    expect((await historyFor(wiki, "KEY-1", { path: "../README.md" })).ok).toBe(false);
    expect((await historyFor(wiki, "KEY-1", { path: "/etc" })).ok).toBe(false);
  });
});

describe("readTracked", () => {
  test("reads a tracked file numbered, the non-ASCII path grep returned included", async () => {
    const grep = await grepTracked(wiki, "æøå");
    if (!grep.ok) throw new Error(grep.error);
    const res = await readTracked(wiki, grep.hits[0]!.relPath);
    expect(res).toEqual({ ok: true, relPath: NB, text: "1: Overskrift\n2: KEY-1 står her — med æøå", fromLine: 1, toLine: 2, totalLines: 2, more: false });
  });
  test("offset and limit window it", async () => {
    const res = await readTracked(wiki, "./a.md", { offset: 2, limit: 1 });
    expect(res).toMatchObject({ ok: true, relPath: "a.md", text: "2: KEY-1 first", fromLine: 2, toLine: 2, totalLines: 3, more: true });
  });
  test("refuses untracked, ignored, artifact, symlink-out, ../, .git and absolute paths", async () => {
    for (const p of ["draft.md", "ignored.md", WIKI_LOCK_BASENAME, "link-out.md", "../README.md", "../wiki/a.md", ".git/config", "../.git/config", path.join(wiki, "a.md"), "nope.md"]) {
      const res = await readTracked(wiki, p);
      expect({ p, ok: res.ok }).toEqual({ p, ok: false });
    }
    const link = await readTracked(wiki, "link-out.md");
    expect(!link.ok && link.error).toContain("leads outside");
  });
  test("isSafeRelPath", () => {
    expect(isSafeRelPath("a/b.md")).toBe(true);
    expect(isSafeRelPath("a/../b.md")).toBe(false);
    expect(isSafeRelPath("")).toBe(false);
    expect(isSafeRelPath("/a")).toBe(false);
  });
});
