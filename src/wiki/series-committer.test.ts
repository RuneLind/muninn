/**
 * `seriesCommitterWarning` — which wikis a series edit is committed on, and the
 * one where it is not.
 *
 * A `SyncRepo[]` is data, so the sync-loop rule needs no registry or loop; the
 * sweeper rule compares git toplevels, so its cases run on temp git repos.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  seriesCommitterWarning,
  seriesSelfCommitBlocker,
  seriesUncommittedReason,
  sweeperCommits,
  type SeriesCommitterWiki,
} from "./series-committer.ts";
import { gitToplevel, listWikiSubtreeDirty } from "./commit.ts";
import type { SyncRepo } from "../sync/config.ts";
import { testTempDir } from "../test/temp-dir.ts";

const wiki = (over: Partial<SeriesCommitterWiki> = {}): SeriesCommitterWiki => ({
  name: "mimir",
  root: "/repos/mimir",
  source: "extra",
  ...over,
});

async function initRepo(dir: string): Promise<void> {
  const proc = Bun.spawn(["git", "-C", dir, "init", "-q"], { stdout: "pipe", stderr: "pipe", detached: true });
  if ((await proc.exited) !== 0) throw new Error(`git init ${dir} failed`);
}

const repo = (over: Partial<SyncRepo> = {}): SyncRepo => ({
  name: "mimir",
  path: "/repos/mimir",
  mode: "wiki",
  ...over,
});

describe("seriesCommitterWarning", () => {
  test("warns on a standalone wiki no SYNC_REPOS entry covers", async () => {
    const line = await seriesCommitterWarning(wiki({ name: "scratch", root: "/tmp/scratch" }), [repo()], []);
    expect(line).toContain("scratch");
    expect(line).toContain("/tmp/scratch");
    expect(line).toContain("NO");
  });

  test("says nothing when the repo-sync loop owns the wiki", async () => {
    // A `wiki`-mode entry covers it as the wiki it syncs, and by the root
    // simply living under the repo path.
    expect(await seriesCommitterWarning(wiki(), [repo({ wikiRoot: "/repos/mimir" })], [])).toBeNull();
    expect(
      await seriesCommitterWarning(wiki({ root: "/repos/mimir/pages" }), [repo({ path: "/repos/mimir" })], []),
    ).toBeNull();
    // A trailing separator is the same directory.
    expect(await seriesCommitterWarning(wiki(), [repo({ path: "/repos/mimir/" })], [])).toBeNull();
  });

  test("a SIBLING directory is not coverage", async () => {
    // `/repos/mimir-notes` starts with `/repos/mimir`; only a path SEGMENT
    // boundary counts, or every neighbour of a synced repo reads as covered.
    expect(await seriesCommitterWarning(wiki({ root: "/repos/mimir-notes" }), [repo()], [])).not.toBeNull();
  });

  /** A temp dir holding `jarvis/wiki`, a git repo (the swept bot wikiDir). */
  async function withSweptRepo(fn: (base: string, wikiDir: string) => Promise<void>): Promise<void> {
    const base = await realpath(await testTempDir(path.join(tmpdir(), "muninn-series-swept-")));
    try {
      const wikiDir = path.join(base, "jarvis", "wiki");
      await mkdir(path.join(wikiDir, "notes"), { recursive: true });
      await initRepo(wikiDir);
      await fn(base, wikiDir);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  }

  test("a swept bot wikiDir covers the wiki whatever its source; a bot wiki with no sweeper is not covered", () =>
    withSweptRepo(async (_base, wikiDir) => {
      const swept = [wikiDir];
      expect(await seriesCommitterWarning(wiki({ source: "bot", root: wikiDir }), [], swept)).toBeNull();
      // A WIKI_EXTRA wiki at (or under) a swept bot's wikiDir is swept too.
      expect(await seriesCommitterWarning(wiki({ source: "extra", root: wikiDir }), [], swept)).toBeNull();
      expect(await seriesCommitterWarning(wiki({ source: "extra", root: path.join(wikiDir, "notes") }), [], swept)).toBeNull();
      // No enabled sweeper row: a bot wiki has no committer.
      expect(await seriesCommitterWarning(wiki({ source: "bot", root: wikiDir }), [], [])).toContain("NO committer");
      // …and the bare `WIKI_DIR` override is never warned about.
      expect(await seriesCommitterWarning(null, [], [])).toBeNull();
    }));

  test("sweeperCommits: a swept dir covers itself and what lies under it, not a sibling", () =>
    withSweptRepo(async (base, wikiDir) => {
      await mkdir(path.join(base, "jarvis", "wiki-old"));
      expect(await sweeperCommits(wikiDir, [`${wikiDir}/`])).toBe(true);
      expect(await sweeperCommits(path.join(wikiDir, "notes"), [wikiDir])).toBe(true);
      expect(await sweeperCommits(path.join(base, "jarvis", "wiki-old"), [wikiDir])).toBe(false);
      expect(await sweeperCommits(path.join(base, "jarvis"), [wikiDir])).toBe(false);
    }));

  test("sweeperCommits: a wiki that is its own git repo inside the swept dir is NOT swept", () =>
    withSweptRepo(async (_base, wikiDir) => {
      // The sweeper commits in the wikiDir's repo, where this nested repo is a
      // gitlink: nothing inside it is ever committed.
      const nested = path.join(wikiDir, "notes");
      await initRepo(nested);
      expect(await sweeperCommits(nested, [wikiDir])).toBe(false);
      expect(await seriesCommitterWarning(wiki({ source: "extra", root: nested }), [], [wikiDir])).toContain("NO committer");
    }));

  test("sweeperCommits: a swept dir outside git sweeps nothing", async () => {
    const base = await realpath(await testTempDir(path.join(tmpdir(), "muninn-series-nogit-")));
    try {
      expect(await sweeperCommits(base, [base])).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("a root reached through a symlink is still covered", async () => {
    // `SyncRepo.path` is stored realpath'd; the registry keeps the configured
    // spelling. A lexical miss would now COMMIT a repo the sync loop owns.
    const base = await realpath(await testTempDir(path.join(tmpdir(), "muninn-series-link-")));
    try {
      const real = path.join(base, "mimir");
      const link = path.join(base, "linked");
      await mkdir(real);
      await symlink(real, link);
      expect(await seriesCommitterWarning(wiki({ root: link }), [repo({ path: real })], [])).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("a plain or status-only entry is not coverage — neither mode commits", async () => {
    for (const mode of ["plain", "status-only"] as const) {
      const line = await seriesCommitterWarning(wiki({ root: "/repos/big/wiki" }), [
        repo({ path: "/repos/big", mode, containedWikiRoots: ["/repos/big/wiki"] }),
      ], []);
      expect(line).not.toBeNull();
      // The wiki IS inside SYNC_REPOS here, so the line must not say otherwise.
      expect(line).not.toContain("outside SYNC_REPOS");
      expect(line).toContain("wiki-mode");
    }
  });

  test("a wiki-mode entry at / covers every root", async () => {
    expect(await seriesCommitterWarning(wiki(), [repo({ path: "/" })], [])).toBeNull();
  });
});

describe("seriesSelfCommitBlocker", () => {
  async function git(cwd: string, args: string[]): Promise<void> {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
  }

  async function withTemp(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await realpath(await testTempDir(path.join(tmpdir(), "muninn-series-blocker-")));
    try {
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("null for a remote-less repo the wiki owns", () =>
    withTemp(async (dir) => {
      await git(dir, ["init", "-q"]);
      expect(await seriesSelfCommitBlocker(dir)).toBeNull();
    }));

  test("names each blocker, so the warn says the true cause", () =>
    withTemp(async (dir) => {
      expect(await seriesSelfCommitBlocker(dir)).toBe("not a git repo");
      await git(dir, ["init", "-q"]);
      const nested = path.join(dir, "docs", "wiki");
      await mkdir(nested, { recursive: true });
      expect(await seriesSelfCommitBlocker(nested)).toBe(`the wiki sits inside the larger repo ${dir}`);
      await git(dir, ["remote", "add", "origin", path.join(dir, "nowhere.git")]);
      expect(await seriesSelfCommitBlocker(dir)).toBe("the repo has a remote");
    }));
});

describe("seriesUncommittedReason", () => {
  test("silent when the route's own commit landed or had nothing to commit", () => {
    expect(seriesUncommittedReason(null, { committed: true })).toBeNull();
    // The edit put the page back to its HEAD bytes: the tree is clean.
    expect(seriesUncommittedReason(null, { committed: false, reason: "nothing-to-commit" })).toBeNull();
  });

  test("names why the edit stayed uncommitted", () => {
    expect(seriesUncommittedReason(null, { committed: false, reason: "not-default-branch" })).toBe(
      "not-default-branch",
    );
    // The commit seam threw, so `writeWikiPage` reported no result at all.
    expect(seriesUncommittedReason(null, undefined)).toBe("commit failed");
    // The route never tried: the blocker IS the reason.
    expect(seriesUncommittedReason("not a git repo", undefined)).toBe("not a git repo");
  });
});

/**
 * F35 class check, surface 2: `sweeperCommits` over every kind of root, each
 * cell checked against the sweeper's real staging. The ground truth is what
 * the sweeper itself would stage: a new page is written under the root and
 * looked for in `listWikiSubtreeDirty(<swept dir's toplevel>, <swept dir>)`,
 * the exact listing `checkWikiCommitter` commits. A cell passes only when
 * `sweeperCommits` agrees with that listing AND with the expected column.
 */
describe("sweeperCommits — the root classification table", () => {
  async function git(cwd: string, ...args: string[]): Promise<void> {
    const proc = Bun.spawn(["git", "-C", cwd, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
  }

  /** What one cell sets up under `base`: the swept dir and the wiki root. */
  type Cell = { name: string; expected: boolean; setup: (base: string) => Promise<{ dir: string; root: string }> };

  /** `base/repo` is a git repo with one commit; `base/repo/wiki` the swept dir. */
  async function sweptRepo(base: string): Promise<string> {
    const top = path.join(base, "repo");
    await mkdir(path.join(top, "wiki"), { recursive: true });
    await git(top, "init", "-q", "-b", "main");
    await Bun.write(path.join(top, "wiki", "seed.md"), "seed\n");
    await git(top, "add", "-A");
    await git(top, "commit", "-q", "-m", "seed");
    return path.join(top, "wiki");
  }

  const CELLS: Cell[] = [
    {
      name: "root outside the swept dir",
      expected: false,
      setup: async (base) => {
        const dir = await sweptRepo(base);
        const root = path.join(base, "repo", "elsewhere");
        await mkdir(root);
        return { dir, root };
      },
    },
    {
      name: "inside, same toplevel, tracked and clean",
      expected: true,
      setup: async (base) => {
        const dir = await sweptRepo(base);
        return { dir, root: dir };
      },
    },
    {
      name: "inside, same toplevel, an untracked (not ignored) subfolder",
      expected: true,
      setup: async (base) => {
        const dir = await sweptRepo(base);
        const root = path.join(dir, "fresh");
        await mkdir(root);
        await Bun.write(path.join(root, "draft.md"), "x\n");
        return { dir, root };
      },
    },
    {
      name: "inside, the root itself ignored by .gitignore",
      expected: false,
      setup: async (base) => {
        const dir = await sweptRepo(base);
        await Bun.write(path.join(base, "repo", ".gitignore"), "wiki/private/\n");
        const root = path.join(dir, "private");
        await mkdir(root);
        return { dir, root };
      },
    },
    {
      name: "inside, a parent of the root ignored by .gitignore (the bots/* shape)",
      expected: false,
      setup: async (base) => {
        const dir = await sweptRepo(base);
        await Bun.write(path.join(base, "repo", ".gitignore"), "wiki/bots/*\n");
        const root = path.join(dir, "bots", "jarvis", "wiki");
        await mkdir(root, { recursive: true });
        return { dir, root };
      },
    },
    {
      name: "inside, ignored by .git/info/exclude",
      expected: false,
      setup: async (base) => {
        const dir = await sweptRepo(base);
        await Bun.write(path.join(base, "repo", ".git", "info", "exclude"), "wiki/excluded/\n");
        const root = path.join(dir, "excluded");
        await mkdir(root);
        return { dir, root };
      },
    },
    {
      name: "inside, ignored by a core.excludesFile (the global excludes mechanism)",
      expected: false,
      setup: async (base) => {
        const dir = await sweptRepo(base);
        const excludes = path.join(base, "global-excludes");
        await Bun.write(excludes, "scratch/\n");
        await git(path.join(base, "repo"), "config", "core.excludesFile", excludes);
        const root = path.join(dir, "scratch");
        await mkdir(root);
        return { dir, root };
      },
    },
    {
      name: "inside, one page extension ignored (*.mdx)",
      expected: false,
      setup: async (base) => {
        const dir = await sweptRepo(base);
        await Bun.write(path.join(base, "repo", ".gitignore"), "*.mdx\n");
        return { dir, root: dir };
      },
    },
    {
      name: "a nested repo inside the swept dir",
      expected: false,
      setup: async (base) => {
        const dir = await sweptRepo(base);
        const root = path.join(dir, "nested");
        await mkdir(root);
        await git(root, "init", "-q", "-b", "main");
        return { dir, root };
      },
    },
    {
      name: "the swept dir inside a linked worktree (.git file), root under it",
      expected: true,
      setup: async (base) => {
        await sweptRepo(base);
        const wt = path.join(base, "wt");
        await git(path.join(base, "repo"), "worktree", "add", "-q", "-b", "side", wt);
        const dir = path.join(wt, "wiki");
        const root = path.join(dir, "notes");
        await mkdir(root);
        return { dir, root };
      },
    },
    {
      name: "a separate linked worktree nested inside the swept dir",
      expected: false,
      setup: async (base) => {
        const dir = await sweptRepo(base);
        const root = path.join(dir, "wt");
        await git(path.join(base, "repo"), "worktree", "add", "-q", "-b", "side2", root);
        return { dir, root };
      },
    },
    {
      name: "the root reached through a symlink into the swept dir",
      expected: true,
      setup: async (base) => {
        const dir = await sweptRepo(base);
        await mkdir(path.join(dir, "real"));
        const root = path.join(base, "link-to-real");
        await symlink(path.join(dir, "real"), root);
        return { dir, root };
      },
    },
    {
      name: "the swept dir reached through a symlink",
      expected: true,
      setup: async (base) => {
        const real = await sweptRepo(base);
        const dir = path.join(base, "link-to-wiki");
        await symlink(real, dir);
        return { dir, root: dir };
      },
    },
    {
      name: "a symlink inside the swept dir pointing outside it",
      expected: false,
      setup: async (base) => {
        const dir = await sweptRepo(base);
        const outside = path.join(base, "outside");
        await mkdir(outside);
        const root = path.join(dir, "out-link");
        await symlink(outside, root);
        return { dir, root };
      },
    },
    {
      name: "a non-git dir",
      expected: false,
      setup: async (base) => {
        const dir = path.join(base, "plain");
        await mkdir(dir);
        return { dir, root: dir };
      },
    },
    {
      name: "a bare repo as the swept dir",
      expected: false,
      setup: async (base) => {
        const dir = path.join(base, "bare.git");
        await mkdir(dir);
        await git(dir, "init", "-q", "--bare");
        return { dir, root: dir };
      },
    },
  ];

  /** Would the sweeper of `dir` stage a new page, `.md` AND `.mdx`, written under `root`? */
  async function sweeperStages(dir: string, root: string): Promise<boolean> {
    const top = await gitToplevel(dir);
    if (!top) return false;
    const pages = [".md", ".mdx"].map((ext) => path.join(root, `probe-${crypto.randomUUID()}${ext}`));
    for (const page of pages) await Bun.write(page, "new page\n");
    const { dirty } = await listWikiSubtreeDirty(top, dir);
    const canonicalDir = await realpath(dir);
    const rels = await Promise.all(pages.map(async (p) => path.relative(canonicalDir, await realpath(p)).split(path.sep).join("/")));
    for (const page of pages) await rm(page, { force: true });
    return rels.every((rel) => dirty.includes(rel));
  }

  for (const cell of CELLS) {
    test(cell.name, async () => {
      const base = await realpath(await testTempDir(path.join(tmpdir(), "muninn-sweep-cell-")));
      try {
        const { dir, root } = await cell.setup(base);
        const answer = await sweeperCommits(root, [dir]);
        const truth = await sweeperStages(dir, root);
        expect({ answer, truth }).toEqual({ answer: cell.expected, truth: cell.expected });
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });
  }
});
