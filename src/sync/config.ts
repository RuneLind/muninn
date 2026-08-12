/**
 * `SYNC_REPOS` — the repo-sync loop's config surface.
 *
 * Muninn runs on two machines (laptop + Mac mini) against the same shared repos
 * — the mimir wiki, huginn-jarvis (a wiki nested inside a bigger repo), the
 * skills repo, muninn itself — and they converge ONLY through GitHub. Nothing
 * synced them automatically before this; the laptop once sat a commit behind for
 * a week. This module declares WHICH repos the loop touches and HOW.
 *
 * Format — comma-separated `name=path:mode`:
 *
 *   SYNC_REPOS=mimir=../mimir:wiki,claude-skills=~/.claude/skills:plain,muninn=.:status-only
 *
 * Paths take the SAME resolution as the wiki registry (`resolveConfiguredPath`
 * in `src/wiki/registry.ts` — trim, `~` expansion, relative resolved against the
 * muninn repo root); the resolver is imported rather than re-spelled precisely
 * so a `wiki`-mode entry lands on the same absolute string the registry built.
 *
 * Modes:
 *  - `wiki`        — auto-commit (quiet-period filtered) + rebase + push. MUST
 *                    resolve to a REGISTERED wiki root, because the sync's local
 *                    section takes that wiki's write lock and the lock key only
 *                    exists for a registered root. An unmatched path is warned
 *                    about and DROPPED (never silently downgraded — a silent
 *                    downgrade to `plain` would leave the machine committing
 *                    nothing while the card claimed the repo was covered).
 *  - `plain`       — never auto-commits, never pushes, but pulls (fetch+rebase).
 *  - `status-only` — fetch + report. Never commits, never pulls. For the muninn
 *                    CODE repo, where a background rebase under a running dev
 *                    server is not something a sync loop should ever decide.
 *
 * A malformed entry, an unknown mode and a duplicate name are each warned about
 * and dropped: the loop must never guess what to do with a repo.
 */

import path from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { resolveConfiguredPath } from "../wiki/registry.ts";
import { getWikiRegistry } from "../wiki/registry-memo.ts";
import type { WikiRegistryEntry } from "../wiki/registry.ts";
import { gitToplevel } from "../wiki/commit.ts";
import { getLog } from "../logging.ts";

const log = getLog("sync", "config");

export const SYNC_MODES = ["wiki", "plain", "status-only"] as const;
export type SyncMode = (typeof SYNC_MODES)[number];

export interface SyncRepo {
  /** Canonical name — the card's label and the `?repo=` selector. */
  name: string;
  /** Absolute path the loop runs git in (a wiki root may be nested below the
   *  repo toplevel — the loop derives the toplevel itself). */
  path: string;
  mode: SyncMode;
  /** `wiki` mode only: the registered wiki this entry resolved to. The ROOT is
   *  the registry's own string, so `wikiWriteQueueKey` derives the same chain
   *  key the page writers use. */
  wikiRoot?: string;
  /** NON-`wiki` modes only: registered wiki roots that live INSIDE this repo. A
   *  `plain` rebase rewrites their working trees, so the run takes each one's
   *  write lock. Absent ⇒ this repo contains no wiki anyone else writes. */
  containedWikiRoots?: string[];
  /** `wiki` mode only: the wiki's huginn collections (drives the optional
   *  post-sync reindex kick). Absent/empty ⇒ no reindex is ever attempted. */
  collections?: string[];
}

export interface ParsedSyncRepos {
  repos: SyncRepo[];
  /** Human-readable reasons entries were dropped — logged AND surfaced on the
   *  card, since a dropped entry is invisible otherwise (the repo simply never
   *  appears, which reads as "not configured" rather than "misconfigured"). */
  warnings: string[];
}

/** Compare two directory paths for identity, tolerating symlinked prefixes
 *  (macOS `/tmp` → `/private/tmp`) and a trailing separator. Falls back to the
 *  lexical form when either path does not exist yet. */
function sameDir(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const resolved = path.resolve(p);
    try {
      return realpathSync(resolved);
    } catch {
      return resolved;
    }
  };
  return norm(a) === norm(b);
}

/** Normalize for comparison: absolute, symlinks resolved when the path exists. */
function normDir(p: string): string {
  const resolved = path.resolve(p);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** Is `inner` the same directory as `outer`, or below it? Compared on normalized
 *  paths with a separator-terminated prefix, so `/a/wiki-old` is not "inside"
 *  `/a/wiki`. */
function containsDir(outer: string, inner: string): boolean {
  const o = normDir(outer);
  const i = normDir(inner);
  return i === o || i.startsWith(o.endsWith(path.sep) ? o : `${o}${path.sep}`);
}

/**
 * The git toplevel containing `abs`, found by walking up for a `.git` entry —
 * SYNCHRONOUSLY, because this parse is pure and has no business spawning git.
 * Falls back to the path itself when nothing is found (a directory that is not a
 * repo yet dedups by its own path, which is the strictest safe answer).
 *
 * Only used for the same-repo dedup below, where an approximate answer degrades
 * to "we did not notice these two are one repo" — the pre-existing behaviour.
 */
function gitToplevelSync(abs: string): string {
  let dir = normDir(abs);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return normDir(abs);
    dir = parent;
  }
}

/**
 * Parse a raw `SYNC_REPOS` string against the wiki registry. Pure apart from the
 * `realpathSync`/`existsSync` probes (no git spawn, no env reads), so the whole
 * config surface is unit-testable.
 */
export function parseSyncRepos(
  raw: string | undefined,
  wikis: WikiRegistryEntry[],
  repoRoot?: string,
): ParsedSyncRepos {
  const repos: SyncRepo[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  /** Resolved git toplevel → the entry that claimed it. Two entries on ONE repo
   *  (e.g. `jarvis=…/data/wiki:wiki` beside `jarvis-code=…:status-only`) pass
   *  every later check — the in-flight guard and the ledger are keyed by NAME —
   *  and then run two ticks against one index and one branch. */
  const seenTops = new Map<string, string>();

  for (const rawEntry of (raw ?? "").split(",")) {
    const entry = rawEntry.trim();
    if (!entry) continue;

    const eq = entry.indexOf("=");
    const name = (eq === -1 ? "" : entry.slice(0, eq)).trim();
    const rest = eq === -1 ? "" : entry.slice(eq + 1).trim();
    // The mode is the tail after the LAST colon, so a Windows-ish or otherwise
    // colon-carrying path still round-trips.
    const lastColon = rest.lastIndexOf(":");
    const modeRaw = lastColon === -1 ? "" : rest.slice(lastColon + 1).trim();
    const pathRaw = lastColon === -1 ? "" : rest.slice(0, lastColon).trim();

    if (!name || !pathRaw || !modeRaw) {
      warnings.push(`SYNC_REPOS: skipping malformed entry "${entry}" (expected name=path:mode)`);
      continue;
    }
    if (!(SYNC_MODES as readonly string[]).includes(modeRaw)) {
      warnings.push(
        `SYNC_REPOS: skipping "${name}" — unknown mode "${modeRaw}" (expected ${SYNC_MODES.join(" | ")})`,
      );
      continue;
    }
    const mode = modeRaw as SyncMode;
    const key = name.toLowerCase();
    if (seen.has(key)) {
      warnings.push(`SYNC_REPOS: skipping "${name}" — duplicate name`);
      continue;
    }

    const abs = resolveConfiguredPath(pathRaw, repoRoot);
    const top = gitToplevelSync(abs);
    const owner = seenTops.get(top);
    if (owner) {
      warnings.push(
        `SYNC_REPOS: skipping "${name}" — the same git repo as "${owner}" (${top}); ` +
          `two entries on one repo would run two ticks against one index`,
      );
      continue;
    }

    if (mode === "wiki") {
      const wiki = wikis.find((w) => sameDir(w.root, abs));
      if (!wiki) {
        warnings.push(
          `SYNC_REPOS: skipping "${name}" — mode "wiki" needs a REGISTERED wiki root, and ${abs} matches none ` +
            `(register it via a bot's wikiDir or WIKI_EXTRA, or use mode "plain")`,
        );
        continue;
      }
      seen.add(key);
      seenTops.set(top, name);
      repos.push({
        name,
        path: abs,
        mode,
        wikiRoot: wiki.root,
        ...(wiki.collections && wiki.collections.length > 0
          ? { collections: wiki.collections }
          : {}),
      });
      continue;
    }

    // A non-wiki entry over a repo that CONTAINS a registered wiki is the shape
    // the wiki-mode failure message actively steers people into ("… or use mode
    // plain"): a `plain` rebase rewrites that wiki's working tree, and without
    // the wiki write lock it can land mid-gardener-write. Warned loudly here;
    // the run takes the contained roots' locks (see `withLocks`).
    const contained = wikis.filter((w) => containsDir(abs, w.root));
    if (contained.length > 0) {
      warnings.push(
        `SYNC_REPOS: "${name}" (mode "${mode}") contains the registered wiki ` +
          `${contained.map((w) => `"${w.name}"`).join(", ")} — its rebase will take that wiki's ` +
          `write lock, but nothing here commits the wiki's pages; use mode "wiki" on the wiki root if that is what you meant`,
      );
    }

    seen.add(key);
    seenTops.set(top, name);
    repos.push({
      name,
      path: abs,
      mode,
      ...(contained.length > 0 ? { containedWikiRoots: contained.map((w) => w.root) } : {}),
    });
  }

  return { repos, warnings };
}

// ── Process-wide memo ────────────────────────────────────────────────────────
//
// Mirrors `registry-memo.ts`: the config is static until restart, so parse once
// and log the warnings once rather than on every 15-minute tick + every card
// poll.

let cached: ParsedSyncRepos | null = null;

export function getSyncRepos(): ParsedSyncRepos {
  if (cached) return cached;
  cached = parseSyncRepos(process.env.SYNC_REPOS, getWikiRegistry());
  for (const w of cached.warnings) log.warn(w);
  if (cached.repos.length > 0) {
    log.info("Repo sync configured for {n} repo(s): {names}", {
      n: cached.repos.length,
      names: cached.repos.map((r) => `${r.name}(${r.mode})`).join(", "),
    });
  }
  return cached;
}

/** Test-only: drop the memo so a test can re-derive from a fresh env. */
export function __resetSyncReposForTest(): void {
  cached = null;
}

/** Look up one configured repo by name (case-insensitive). */
export function findSyncRepo(repos: SyncRepo[], name: string | undefined): SyncRepo | undefined {
  const wanted = name?.trim();
  if (!wanted) return undefined;
  return repos.find((r) => r.name.toLowerCase() === wanted.toLowerCase());
}

/**
 * True when a `wiki`-mode sync entry covers the git repo at `top`.
 *
 * This is the SWEEPER-SUBSUMPTION test: on a machine running the sync loop, the
 * daily `wiki-committer` watcher must stand down for the repos the loop owns.
 * Leaving both running would void the quiet-period guarantee (the sweeper
 * commits a file the loop is deliberately holding back because it was edited 30
 * seconds ago) and produce silent non-fast-forward sweeper pushes (the sweeper
 * pushes without ever rebasing).
 *
 * Compared on git TOPLEVELS, not on the configured paths: huginn-jarvis's wiki
 * root is `…/huginn-jarvis/data/wiki` while the sweeper is handed the same root
 * — but mimir's wiki root IS its toplevel, and a future entry could name any
 * directory inside the repo. The toplevel is the only spelling that is the same
 * question on both sides.
 */
export async function findSyncRepoCoveringToplevel(
  top: string,
  repos?: SyncRepo[],
): Promise<SyncRepo | null> {
  const list = repos ?? getSyncRepos().repos;
  for (const repo of list) {
    if (repo.mode !== "wiki") continue;
    const repoTop = await gitToplevel(repo.path);
    if (repoTop && sameDir(repoTop, top)) return repo;
  }
  return null;
}

/** Boolean form of {@link findSyncRepoCoveringToplevel} — CONFIGURATION only. A
 *  caller deciding whether the sweeper may stand down wants `syncSubsumesSweeper`
 *  (`run.ts`), which also requires evidence that the loop has actually run. */
export async function syncCoversToplevel(top: string, repos?: SyncRepo[]): Promise<boolean> {
  return (await findSyncRepoCoveringToplevel(top, repos)) !== null;
}
