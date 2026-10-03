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
      expect(
        seriesCommitterWarning(wiki({ root: "/repos/big/wiki" }), [
          repo({ path: "/repos/big", mode, containedWikiRoots: ["/repos/big/wiki"] }),
        ]),
      ).not.toBeNull();
    }
  });

  test("a wiki-mode entry at / covers every root", () => {
    expect(seriesCommitterWarning(wiki(), [repo({ path: "/" })])).toBeNull();
  });
});

describe("seriesUncommittedReason", () => {
  test("silent when the route's own commit landed or had nothing to commit", () => {
    expect(seriesUncommittedReason(true, { committed: true })).toBeNull();
    // The edit put the page back to its HEAD bytes: the tree is clean.
    expect(seriesUncommittedReason(true, { committed: false, reason: "nothing-to-commit" })).toBeNull();
  });

  test("names why the edit stayed uncommitted", () => {
    expect(seriesUncommittedReason(true, { committed: false, reason: "not-default-branch" })).toBe(
      "not-default-branch",
    );
    // The commit seam threw, so `writeWikiPage` reported no result at all.
    expect(seriesUncommittedReason(true, undefined)).toBe("commit failed");
    expect(seriesUncommittedReason(false, undefined)).toContain("remote");
  });
});
