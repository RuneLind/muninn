/**
 * The active list through the REAL git walk: a fixture repo, the real
 * `buildWikiIndex`, then the digest. A burst of metadata-only commits on fewer
 * than 10 pages (what a lint accept or a `wiki-stamp` run commits) is not a
 * sweep, so only the metadata-only filter behind `gitTouchedMs` keeps those
 * pages out of the active list.
 */

import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDir } from "../../test/temp-dir.ts";
import { buildWikiIndex } from "../store.ts";
import { buildWorkMapDigest } from "./digest.ts";
import { WORK_MAP_FILE } from "./write.ts";

const DAY = 86_400_000;

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(
    ["git", "-C", cwd, "-c", "user.email=fixture@example.com", "-c", "user.name=fixture", "-c", "commit.gpgsign=false", ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
}

async function commitAt(dir: string, ms: number, message: string): Promise<void> {
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "--date", new Date(ms).toISOString(), "-m", message);
}

const page = (title: string, status: string, prose: string) =>
  `---\ntitle: ${title}\nplan_status: ${status}\n---\n\n# ${title}\n\n${prose}\n`;

test("a metadata-only burst on 3 pages does not enter the active list; a prose edit does", async () => {
  const dir = await testTempDir(path.join(tmpdir(), "work-map-git-"));
  const now = Date.now();
  try {
    await mkdir(path.join(dir, "plans"), { recursive: true });
    const write = (rel: string, text: string) => writeFile(path.join(dir, rel), text);
    for (const n of ["a", "b", "c", "d"]) await write(`plans/${n}.mdx`, page(n, "in-flight", `Prose of ${n}.`));
    await git(dir, "init", "-q", "-b", "main");
    await commitAt(dir, now - 60 * DAY, "seed");

    // A lint accept: plan_status flips on three pages, nothing else.
    for (const n of ["a", "b", "c"]) await write(`plans/${n}.mdx`, page(n, "shipped", `Prose of ${n}.`));
    await commitAt(dir, now - 2 * DAY, "[lint] accept: 3 pages");
    // A real edit on d.
    await write("plans/d.mdx", page("d", "in-flight", "Rewritten prose of d."));
    await commitAt(dir, now - 1 * DAY, "edit d");
    // The map itself, committed like the write seam does.
    await write(WORK_MAP_FILE, "{}\n");
    await commitAt(dir, now - 1 * DAY, "work-map: organize fixture");

    const index = await buildWikiIndex(dir);
    expect(index.gitMetadataFilter).toEqual({ degraded: false });
    expect(index.pages.map((p) => p.relPath)).not.toContain(WORK_MAP_FILE);
    const digest = buildWorkMapDigest({
      wiki: "fixture",
      nowMs: now,
      pages: index.pages,
      outgoing: index.outgoing,
      threads: [],
      sessionsSinceMs: now - 8 * DAY,
      sessionsAsOfMs: now,
      gitTouches: index.gitTouches!,
      logText: null,
      resolveLink: () => undefined,
      previous: null,
    });
    expect(digest.active).toEqual(["plans/d.mdx"]);
    // The burst still counts in the per-day commits `gitTouches` carries.
    expect(index.gitTouches!.get("plans/a.mdx")!.length).toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

test("the walk reports a degraded filter when a page's metadata-only run outlasts the step limit", async () => {
  const dir = await testTempDir(path.join(tmpdir(), "work-map-git-steps-"));
  const now = Date.now();
  try {
    await mkdir(path.join(dir, "plans"), { recursive: true });
    const write = (rel: string, text: string) => writeFile(path.join(dir, rel), text);
    await write("plans/a.mdx", page("a", "s0", "Prose."));
    await git(dir, "init", "-q", "-b", "main");
    await commitAt(dir, now - 60 * DAY, "seed");
    // Nine stamps in a row: one more than METADATA_TOUCH_MAX_STEPS walks back.
    for (let i = 1; i <= 9; i++) {
      await write("plans/a.mdx", page("a", `s${i}`, "Prose."));
      await commitAt(dir, now - (20 - i) * DAY, `stamp ${i}`);
    }
    const index = await buildWikiIndex(dir);
    expect(index.gitMetadataFilter).toEqual({ degraded: true, reason: "steps", pages: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
