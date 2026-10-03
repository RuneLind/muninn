/**
 * `seriesCommitterWarning` — which wikis a series edit is committed on, and the
 * one where it is not.
 *
 * Pure and dependency-free (a `SyncRepo[]` is data), so the rule is testable
 * without a registry, a git repo or a sync loop.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  seriesCommitterWarning,
  seriesSelfCommitBlocker,
  seriesUncommittedReason,
  type SeriesCommitterWiki,
} from "./series-committer.ts";
import type { SyncRepo } from "../sync/config.ts";

const wiki = (over: Partial<SeriesCommitterWiki> = {}): SeriesCommitterWiki => ({
  name: "mimir",
  root: "/repos/mimir",
  source: "extra",
  ...over,
});

const repo = (over: Partial<SyncRepo> = {}): SyncRepo => ({
  name: "mimir",
  path: "/repos/mimir",
  mode: "wiki",
  ...over,
});

describe("seriesCommitterWarning", () => {
  test("warns on a standalone wiki no SYNC_REPOS entry covers", () => {
    const line = seriesCommitterWarning(wiki({ name: "scratch", root: "/tmp/scratch" }), [repo()]);
    expect(line).toContain("scratch");
    expect(line).toContain("/tmp/scratch");
    expect(line).toContain("NO");
  });

  test("says nothing when the repo-sync loop owns the wiki", () => {
    // A `wiki`-mode entry covers it as the wiki it syncs, and by the root
    // simply living under the repo path.
    expect(seriesCommitterWarning(wiki(), [repo({ wikiRoot: "/repos/mimir" })])).toBeNull();
    expect(
      seriesCommitterWarning(wiki({ root: "/repos/mimir/pages" }), [repo({ path: "/repos/mimir" })]),
    ).toBeNull();
    // A trailing separator is the same directory.
    expect(seriesCommitterWarning(wiki(), [repo({ path: "/repos/mimir/" })])).toBeNull();
  });

  test("a SIBLING directory is not coverage", () => {
    // `/repos/mimir-notes` starts with `/repos/mimir`; only a path SEGMENT
    // boundary counts, or every neighbour of a synced repo reads as covered.
    expect(seriesCommitterWarning(wiki({ root: "/repos/mimir-notes" }), [repo()])).not.toBeNull();
  });

  test("a BOT wiki never warns — the daily sweeper covers it", () => {
    expect(seriesCommitterWarning(wiki({ source: "bot", root: "/bots/jarvis/wiki" }), [])).toBeNull();
    // …and neither does the bare `WIKI_DIR` override, which is a bot wiki under
    // another name.
    expect(seriesCommitterWarning(null, [])).toBeNull();
  });

  test("a root reached through a symlink is still covered", async () => {
    // `SyncRepo.path` is stored realpath'd; the registry keeps the configured
    // spelling. A lexical miss would now COMMIT a repo the sync loop owns.
    const base = await realpath(await mkdtemp(path.join(tmpdir(), "muninn-series-link-")));
    try {
      const real = path.join(base, "mimir");
      const link = path.join(base, "linked");
      await mkdir(real);
      await symlink(real, link);
      expect(seriesCommitterWarning(wiki({ root: link }), [repo({ path: real })])).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("a plain or status-only entry is not coverage — neither mode commits", () => {
    for (const mode of ["plain", "status-only"] as const) {
      const line = seriesCommitterWarning(wiki({ root: "/repos/big/wiki" }), [
        repo({ path: "/repos/big", mode, containedWikiRoots: ["/repos/big/wiki"] }),
      ]);
      expect(line).not.toBeNull();
      // The wiki IS inside SYNC_REPOS here, so the line must not say otherwise.
      expect(line).not.toContain("outside SYNC_REPOS");
      expect(line).toContain("wiki-mode");
    }
  });

  test("a wiki-mode entry at / covers every root", () => {
    expect(seriesCommitterWarning(wiki(), [repo({ path: "/" })])).toBeNull();
  });
});

describe("seriesSelfCommitBlocker", () => {
  async function git(cwd: string, args: string[]): Promise<void> {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
  }

  async function withTemp(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "muninn-series-blocker-")));
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
