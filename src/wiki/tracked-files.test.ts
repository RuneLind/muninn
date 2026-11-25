/**
 * `tracked-files.ts` on a real temp git repo: tracked, untracked, ignored,
 * write-artifact, symlink-out and `../` cases, a wiki in a subdirectory of the
 * repo, a non-ASCII name returned by grep and read back, and a glob whose
 * out-of-glob hits sort before the cap. Invented content only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
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

describe("regex mode", () => {
  test("is PCRE: \\b and \\d work", async () => {
    const res = await grepTracked(wiki, "\\bKEY-\\d\\b", { regex: true });
    expect(res.ok && res.hits.length).toBe(4);
  });
  test("matches by character, so a class or a dot meets a non-ASCII letter", async () => {
    const cls = await grepTracked(wiki, "st[åa]r", { regex: true });
    expect(cls.ok && cls.hits.map((h) => h.relPath)).toEqual([NB]);
    const dot = await grepTracked(wiki, "med æ.å", { regex: true });
    expect(dot.ok && dot.hits.map((h) => h.relPath)).toEqual([NB]);
  });
  test("a non-ASCII fixed string still matches byte for byte", async () => {
    const res = await grepTracked(wiki, "står her — med", {});
    expect(res.ok && res.hits.map((h) => h.relPath)).toEqual([NB]);
  });
  test("a git without PCRE falls back to an extended regex and says so", async () => {
    const seen: string[] = [];
    const noPcre: GitRun = async (cwd, args, opts) => {
      if (args.includes("grep")) {
        seen.push(args.includes("-P") ? "-P" : args.includes("-E") ? "-E" : "?");
        if (args.includes("-P")) return { ok: false, stdout: "", stderr: "fatal: cannot use Perl-compatible regexes when not compiled with USE_LIBPCRE", exitCode: 128 };
      }
      return realGit(cwd, args, opts);
    };
    const res = await grepTracked(wiki, "KEY-[0-9]", { regex: true, git: noPcre });
    expect(res).toMatchObject({ ok: true, totalLines: 4, regexEngine: "ere" });
    expect(seen).toEqual(["-P", "-E"]);
    const pcre = await grepTracked(wiki, "KEY-[0-9]", { regex: true });
    expect(pcre).toMatchObject({ ok: true, regexEngine: "pcre" });
  });
  test("a bad pattern that names PCRE is an error, not a fall back", async () => {
    const res = await grepTracked(wiki, "Perl-compatible regexes PCRE(", { regex: true });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain("missing closing parenthesis");
  });
});

describe("readTracked and symlinks inside the wiki", () => {
  let sroot = "";
  beforeAll(async () => {
    sroot = path.join(await realpath(await testTempDir(path.join(tmpdir(), "muninn-tracked-sym-"))), "w");
    await mkdir(path.join(sroot, "d"), { recursive: true });
    await mkdir(path.join(sroot, "p"), { recursive: true });
    await git(sroot, "init", "-q", "-b", "main");
    await writeFile(path.join(sroot, ".gitignore"), ".env\nq/\n");
    await writeFile(path.join(sroot, ".env"), "SECRET=hunter2\n");
    await writeFile(path.join(sroot, "plain.md"), "plain\n");
    await writeFile(path.join(sroot, "p/x.md"), "tracked x\n");
    await symlink(".env", path.join(sroot, "notes.md"));
    await symlink("../.env", path.join(sroot, "d/inner.md"));
    await symlink(".git/config", path.join(sroot, "cfg.md"));
    await git(sroot, "add", "-A");
    await git(sroot, "commit", "-q", "-m", "links");
    // A tracked file whose parent directory became a symlink into an ignored folder.
    await mkdir(path.join(sroot, "q"));
    await writeFile(path.join(sroot, "q/x.md"), "SECRET via a parent link\n");
    await rm(path.join(sroot, "p"), { recursive: true });
    await symlink("q", path.join(sroot, "p"));
  });
  test.each(["notes.md", "d/inner.md", "cfg.md", "p/x.md"])("a tracked symlink to an ignored file, .git or through a linked parent is refused: %s", async (p) => {
    const res = await readTracked(sroot, p);
    expect({ ok: res.ok, secret: res.ok && /SECRET|\[core\]/.test(res.text) }).toEqual({ ok: false, secret: false });
    expect(!res.ok && res.error).toContain("symlink");
  });
  test("a plain tracked file beside them still reads", async () => {
    expect(await readTracked(sroot, "plain.md")).toMatchObject({ ok: true, text: "1: plain" });
  });
});

/**
 * A user's global config and a repo's own `.git/config` can flip keys that change
 * what git grep searches or prints. The global one is injected as `HOME` through
 * a wrapping runner; the commits are ssh-signed so `log.showSignature` has
 * something to print.
 */
describe("git config cannot change what the reads return", () => {
  const sshKeygen = Bun.which("ssh-keygen");
  let base = "";
  let crepo = "";
  let cwiki = "";
  let fakeHome = "";
  const clean = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  async function cgit(cwd: string, ...args: string[]) {
    const res = await realGit(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { env: clean });
    if (!res.ok) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  }
  const withHome: GitRun = (cwd, args, opts = {}) => realGit(cwd, args, { ...opts, env: { ...opts.env, HOME: fakeHome } });
  const BAD = "[grep]\n\tcolumn = true\n\tfullName = true\n\tfallbackToNoIndex = true\n[submodule]\n\trecurse = true\n[log]\n\tshowSignature = true\n";
  const BAD_LOCAL = `${BAD}[i18n]\n\tlogOutputEncoding = ISO-8859-1\n`;

  beforeAll(async () => {
    if (!sshKeygen) return;
    base = await realpath(await testTempDir(path.join(tmpdir(), "muninn-tracked-cfg-")));
    crepo = path.join(base, "repo");
    cwiki = path.join(crepo, "w");
    fakeHome = path.join(base, "home");
    const sub = path.join(base, "subsrc");
    await mkdir(path.join(cwiki), { recursive: true });
    await mkdir(sub);
    await mkdir(fakeHome);
    execFileSync(sshKeygen, ["-q", "-t", "ed25519", "-N", "", "-f", path.join(base, "key")]);
    await cgit(sub, "init", "-q", "-b", "main");
    await writeFile(path.join(sub, "x.md"), "KEY-2 inside the submodule\n");
    await cgit(sub, "add", "-A");
    await cgit(sub, "commit", "-q", "-m", "sub");
    await cgit(crepo, "init", "-q", "-b", "main");
    await cgit(crepo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "w/sub");
    await cgit(crepo, "commit", "-q", "-m", "submodule");
    const sign = ["-c", "gpg.format=ssh", "-c", `user.signingkey=${path.join(base, "key.pub")}`, "commit", "-q", "-S"];
    await writeFile(path.join(cwiki, "a.md"), "KEY-2 æ\n");
    await cgit(crepo, "add", "-A");
    await cgit(crepo, ...sign, "-m", "første: KEY-2");
    await writeFile(path.join(cwiki, "b.md"), "KEY-2 i b\n");
    await cgit(crepo, "add", "-A");
    await cgit(crepo, ...sign, "-m", "andre: KEY-2 i b");
    await writeFile(path.join(base, ".env"), "KEY-2 SECRET\n");
  });

  const expectedHits = [
    { relPath: "a.md", line: 1, text: "KEY-2 æ" },
    { relPath: "b.md", line: 1, text: "KEY-2 i b" },
  ];
  const expectedHistory = [
    { subject: "andre: KEY-2 i b", files: ["b.md"] },
    { subject: "første: KEY-2", files: ["a.md"] },
  ];
  const shape = (res: Awaited<ReturnType<typeof historyFor>>) => (res.ok ? res.commits.map((c) => ({ subject: c.subject, files: c.files })) : res.error);

  // `core.attributesFile` is global-only here: no `-c` names it, so only dropping the
  // user's config keeps grep -I from reading every .md as binary.
  async function badGlobal() {
    await writeFile(path.join(base, "attrs"), "*.md binary\n");
    await writeFile(path.join(fakeHome, ".gitconfig"), `${BAD}[i18n]\n\tlogOutputEncoding = ISO-8859-1\n[core]\n\tattributesFile = ${path.join(base, "attrs")}\n`);
  }
  async function badLocal(fn: () => Promise<void>) {
    await writeFile(path.join(fakeHome, ".gitconfig"), "");
    const cfg = path.join(crepo, ".git", "config");
    const before = await Bun.file(cfg).text();
    try {
      await writeFile(cfg, before + BAD_LOCAL);
      await fn();
    } finally {
      await writeFile(cfg, before);
    }
  }

  test.skipIf(!sshKeygen)("global config: grep's paths and text are unchanged", async () => {
    await badGlobal();
    const grep = await grepTracked(cwiki, "KEY-2", { git: withHome });
    expect(grep.ok && grep.hits).toEqual(expectedHits);
    const re = await grepTracked(cwiki, "KEY-[0-9]", { git: withHome, regex: true });
    expect(re.ok && re.hits).toEqual(expectedHits);
  });
  test.skipIf(!sshKeygen)("global config: history is unchanged", async () => {
    await badGlobal();
    expect(shape(await historyFor(cwiki, "KEY-2", { git: withHome }))).toEqual(expectedHistory);
  });
  test.skipIf(!sshKeygen)("global config: outside any repo grep still fails rather than searching untracked files", async () => {
    await badGlobal();
    const noRepo = await grepTracked(base, "KEY-2", { git: withHome });
    expect(noRepo.ok ? noRepo.hits.map((h) => h.text) : "refused").toBe("refused");
  });
  test.skipIf(!sshKeygen)("repo config: grep's paths and text are unchanged", async () => {
    await badLocal(async () => {
      const grep = await grepTracked(cwiki, "KEY-2", { git: withHome });
      expect(grep.ok && grep.hits).toEqual(expectedHits);
    });
  });
  test.skipIf(!sshKeygen)("repo config: history is unchanged", async () => {
    await badLocal(async () => {
      expect(shape(await historyFor(cwiki, "KEY-2", { git: withHome }))).toEqual(expectedHistory);
    });
  });
});
