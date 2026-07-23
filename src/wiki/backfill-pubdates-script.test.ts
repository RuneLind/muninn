/**
 * Acceptance test for the `--commit` convention on scripts/backfill-wiki-pubdates.ts
 * (PR 2, piece C). Runs the real script as a subprocess against a fixture git wiki
 * repo and asserts it lands exactly one `[script:backfill-wiki-pubdates]` commit
 * carrying the edited page. The reindex POST is pointed at an unreachable host, so
 * it degrades to a warning (non-fatal) — the commit is what we verify here.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "backfill-wiki-pubdates.ts");

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out;
}

async function runScript(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", SCRIPT, ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    // Unreachable huginn → the reindex POST fails fast (warn), never blocks the commit.
    env: { ...process.env, KNOWLEDGE_API_URL: "http://127.0.0.1:1" },
  });
  const out =
    (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  const code = await proc.exited;
  return { code, out };
}

describe("backfill-wiki-pubdates --commit", () => {
  let base: string;
  let repo: string;
  let wikiDir: string;
  let transcripts: string;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "backfill-script-"));
    repo = await mkdtemp(path.join(base, "repo-"));
    wikiDir = path.join(repo, "data", "wiki");
    transcripts = await mkdtemp(path.join(base, "transcripts-")); // empty
    await mkdir(path.join(wikiDir, "sources"), { recursive: true });
    // A source page with an in-page `Date:` line but no parseable `Source:` line —
    // Case A folds the URL:/Date: block into one canonical `Source:` line.
    await writeFile(
      path.join(wikiDir, "sources", "page.md"),
      "---\ntype: source\ntitle: Test Capture\n---\n\n# Test Capture\n\nURL: https://example.com/x\nDate: 2026-05-01\n\nBody prose.\n",
    );
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.email", "a@b.c"]);
    await git(repo, ["config", "user.name", "Fixture"]);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "init"]);
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("--apply --commit lands exactly one [script:…] commit with the edited page", async () => {
    const { code, out } = await runScript(repo, [
      "--apply",
      "--commit",
      "--wiki-dir",
      wikiDir,
      "--transcripts-dir",
      transcripts,
    ]);
    expect(code, out).toBe(0);

    // Exactly one new commit on top of init, with the script's message.
    const subjects = (await git(repo, ["log", "--format=%s"])).split("\n");
    expect(subjects).toEqual(["[script:backfill-wiki-pubdates] update: 1 pages", "init"]);
    // It carries the edited source page (repo-relative under data/wiki).
    const names = await git(repo, ["show", "--name-only", "--format=", "HEAD"]);
    expect(names).toBe("data/wiki/sources/page.md");
    // Tree clean afterward.
    expect(await git(repo, ["status", "--porcelain"])).toBe("");
    // The edit itself landed: a canonical dated Source line.
    const written = await Bun.file(path.join(wikiDir, "sources", "page.md")).text();
    expect(written).toContain("Source: Web, 2026-05-01 — https://example.com/x");
  });

  test("--apply --no-commit writes the edit but leaves it uncommitted", async () => {
    const { code, out } = await runScript(repo, [
      "--apply",
      "--no-commit",
      "--wiki-dir",
      wikiDir,
      "--transcripts-dir",
      transcripts,
    ]);
    expect(code, out).toBe(0);
    // No new commit — still just "init".
    expect(await git(repo, ["log", "--format=%s"])).toBe("init");
    // The edit is present on disk, uncommitted.
    expect(await git(repo, ["status", "--porcelain"])).toContain("data/wiki/sources/page.md");
  });
});
