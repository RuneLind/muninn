/**
 * Per-page CREATION and last-UPDATE dates derived from git history — the durable
 * recency signals for wikis whose filesystem timestamps are checkout artifacts.
 *
 * ## Why this exists
 *
 * Both of the reader's recency sorts ranked on filesystem timestamps, and in a
 * git-managed wiki neither one answers the question it is asked.
 *
 * **"Recently added" ranked on BIRTHTIME**, which is not a creation date — it is
 * "when this inode last appeared", and three routine operations reset it for every
 * file they touch:
 *
 *  - `git mv` (mimir's 2026-07-08 `wiki/`→`projects/` reorg: 302 files birthtimed
 *    that day),
 *  - a re-clone / fresh checkout,
 *  - any sweep that writes via temp-file + rename rather than in place (mimir's
 *    2026-07-31 plan-status backfill: 148 files, all birthtimed 12:31 that day —
 *    verified: an in-place overwrite PRESERVES birthtime, temp+rename RESETS it).
 *
 * **"Recently updated" ranked on MTIME**, which a sweep moves just as wholesale:
 * the same backfill made all 148 plans read as edited today. That is *truthful* and
 * useless — it says the sweep happened, not what the pages are.
 *
 * mimir declares no `created:`/`updated:` (1 of 154 plans has one), so after the
 * backfill both sorts collapsed into a single block ordered by title. git is the
 * one record in the repo that a sweep cannot move.
 *
 * ## What it returns
 *
 * `{ created, touched, dirty }` — see `WikiGitDates`. `null` when the wiki is not
 * in a git repo, git is unavailable, or the walk exceeded its budget; every caller
 * then keeps exactly the pre-existing frontmatter+mtime+birthtime behavior.
 *
 * **ONE `git log` walk produces both maps.** The same `--name-status` output already
 * carries, per commit, a timestamp AND the list of files it touched, so the sweep
 * classification is a property of a commit's own entry count — no second subprocess,
 * no second traversal. (`dirty` is a separate, cheap `git status` probe; see below.)
 *
 * A page whose history begins with a move INTO this wiki from another repo (the 10
 * plans imported in mimir's 2026-05-04 consolidation) dates to the import, not to
 * its original authorship. That is a floor, not a lie — "mimir has had it since" —
 * and `pageAddedMs` takes the OLDEST of all available signals, so a page that also
 * carries a truer `created:` keeps it.
 */

import path from "node:path";
import { realpath } from "node:fs/promises";
import { getLog } from "../logging.ts";
import { listWikiSubtreeDirty } from "./commit.ts";

const log = getLog("wiki", "git-dates");

/**
 * Wall-clock budget for the whole walk (spawn + read + parse). One `git log` over
 * mimir's full history measures ~135 ms (3223 output lines, 83 renames), so this is
 * ~40× headroom. It exists because the walk runs INSIDE `buildWikiIndex`: a
 * pathological repo (huge history, a hung filesystem, an index.lock contender) must
 * degrade the sort, never stall every /wiki request behind a cold index build.
 */
export const GIT_DATES_TIMEOUT_MS = 5_000;

/**
 * How many files a single commit must touch inside the wiki subtree before it is
 * read as a SWEEP — a mechanical pass whose timestamp says nothing about any one
 * page — and excluded from the `touched` map.
 *
 * Flat 10, matching mimir's own `scripts/plan-status/git-touch.ts`, which uses the
 * same count over `plans/` and exists for the same reason: the 2026-07-08 reorg is
 * the LAST commit for 62 of its 145 plans, so a naive `git log -1` dates them all
 * to a rename. Measured over mimir's 492 commits, 32 classify as sweeps at 10.
 *
 * Deliberately NOT scaled to wiki size, though mimir (150 plans) and jarvis (1001
 * pages) are an order of magnitude apart: "how many files did one intentional edit
 * touch" is a property of how people work, not of how big the wiki is, and a
 * relative threshold would let a 50-file sweep count as real work on a large wiki.
 * The cost of the flat number is at the boundary — a genuine 12-file refactor reads
 * as a sweep and its pages show an older date than the truth — which is a strictly
 * better failure than a 145-file sweep making every page claim to be brand new.
 * Revisit only if a wiki misclassifies visibly.
 */
export const SWEEP_THRESHOLD = 10;

/** The three durable per-page date signals a wiki's git history can supply. All
 *  maps/sets are keyed by WIKI-relative posix path, exactly as `WikiPageMeta.relPath`
 *  spells it. */
export interface WikiGitDates {
  /** Epoch ms of the commit that first introduced each path, rename-aware. */
  created: Map<string, number>;
  /**
   * Epoch ms of the most recent NON-SWEEP commit to touch each path. Absent for a
   * page every one of whose commits was a sweep (12 of mimir's 150 plans at
   * threshold 10) — the caller falls back to the creation date rather than treating
   * such a page as undated.
   */
  touched: Map<string, number>;
  /**
   * Paths `git status` reports as dirty (modified / untracked / deleted) inside the
   * wiki subtree — the ONLY pages whose mtime still carries information. A clean
   * file's mtime is a checkout or sweep artifact; a dirty file's mtime is a real
   * edit that git has not recorded yet, and is the one signal a git-only ranking
   * would lose. Empty (never null) when the tree is clean or the probe failed.
   */
  dirty: Set<string>;
}

/** A file entry from `--name-status`: a status letter, optional similarity score,
 *  then a TAB. Commit stamps (`--format=%at`, a bare integer) can never match it,
 *  which is what makes the two line kinds unambiguous without a sentinel. */
const NAME_STATUS_RE = /^([A-Z])(\d*)\t(.*)$/;

/** Spawn `git -C <cwd> <args…>`, bounded by `GIT_DATES_TIMEOUT_MS`. Never throws
 *  and never rejects — a failure is `null`, which the caller degrades on. */
async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    // `core.quotePath=false` is LOAD-BEARING, not hygiene. It defaults to TRUE, and
    // with it on, any path holding a non-ASCII byte comes back double-quoted and
    // octal-escaped — `"wiki/concepts/\303\205rsavregning.md"` for `Årsavregning.md`.
    // That key matches no `relPath` and doesn't even survive the subtree strip, so the
    // page is dropped from the map and silently keeps the birthtime this module exists
    // to replace. Measured on huginn-nav before the flag: 171 of 540 pages (32%) —
    // every `æøå`/`é`/em-dash name — and INVISIBLE, because the ASCII majority still
    // matched so the zero-hit warn could never fire. A command-line `-c` outranks every
    // config file, so a repo that sets `quotePath` explicitly can't reintroduce it.
    const proc = Bun.spawn(["git", "-C", cwd, "-c", "core.quotePath=false", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      // A wiki root is never a credential-needing op here (log/rev-parse are
      // local), but the same guard commit.ts uses costs nothing and keeps a
      // misconfigured repo from parking on a prompt.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const timer = setTimeout(() => proc.kill(), GIT_DATES_TIMEOUT_MS);
    try {
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      return code === 0 ? stdout : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** One parsed `--name-status` file entry. `from` is set only for renames/copies. */
interface FileEntry {
  status: string;
  path: string;
  from?: string;
}

/**
 * Walk `git log --name-status` output oldest-first and record, per path, when it
 * first appeared and when it was last touched by a non-sweep commit. Pure (no
 * spawn, no fs) so the rename/sweep semantics are unit-testable against literal git
 * output.
 *
 * Expects `--reverse --name-status -M --format=%at` — oldest commit first, which is
 * what makes both maps single-pass: a rename's source is always already recorded
 * when the rename is read, and "last write wins" on `touched` lands on the newest
 * qualifying commit without a second sort.
 *
 * **Creation — first appearance wins.** Deliberately not `--diff-filter=A`-only:
 * with the pathspec scoping below, the first commit that mentions a path IS its
 * arrival in this wiki, whatever letter git labels it. That also survives grafted or
 * rewritten history where no `A` record exists at all.
 *
 * **Update — newest non-sweep commit wins.** A commit touching ≥ `sweepThreshold`
 * entries is a mechanical pass (a backfill, a reorg, a lint fix) whose timestamp
 * describes the sweep and not the page, so it contributes no update date at all. A
 * page with no qualifying commit is simply ABSENT from `touched`; inventing a date
 * for it here would bury the distinction the caller needs to fall back on.
 *
 * **A rename CARRIES both dates.** `R100\told\tnew` — mimir renames plans wholesale
 * (`wiki/`→`projects/`, `.md`→`.mdx` conversions), and without this every renamed
 * page would date to the rename commit, reproducing the exact bug this module exists
 * to fix. The update date must carry too, and for the *sharper* reason: the reorg
 * that renames a page is itself a sweep, so a non-carrying `touched` would strand
 * the page's entire real edit history under a path that no longer exists. `new`
 * inherits `old`'s dates; if `old` is unknown (renamed in from outside the pathspec)
 * `new` falls back to the rename commit for creation, and to nothing for update.
 */
export function parseGitLog(
  stdout: string,
  sweepThreshold = SWEEP_THRESHOLD,
): { created: Map<string, number>; touched: Map<string, number> } {
  const created = new Map<string, number>();
  const touched = new Map<string, number>();

  const firstSeen = (p: string, at: number) => {
    if (p && !created.has(p)) created.set(p, at);
  };

  /** Apply one commit's entries. Sweep-ness is a property of the whole commit, so
   *  entries are buffered until the commit is complete before any is applied. */
  const flush = (ts: number, entries: FileEntry[]) => {
    if (!ts || entries.length === 0) return;
    const isSweep = entries.length >= sweepThreshold;
    for (const e of entries) {
      if (e.from !== undefined) {
        // Creation: a COPY leaves the source in place, so it must not lose its own
        // date; `firstSeen` only ever fills an unset key, so the guard is implicit.
        firstSeen(e.path, created.get(e.from) ?? ts);
        // Update: inherit the source's history, then let a non-sweep rename count
        // as its own touch (renaming a page IS an edit to it). A rename retires the
        // source path, so its entry is dropped — a later file reusing that exact
        // path must not inherit a predecessor's edit history.
        const carried = touched.get(e.from);
        if (carried !== undefined) touched.set(e.path, carried);
        if (e.status === "R") touched.delete(e.from);
      } else {
        firstSeen(e.path, ts);
      }
      if (!isSweep) touched.set(e.path, ts);
    }
  };

  let ts = 0;
  let entries: FileEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const m = NAME_STATUS_RE.exec(line);
    if (!m) {
      // A bare integer is the commit stamp — and the commit BOUNDARY, so it flushes
      // the previous commit. Anything else (a `--format` artifact, a path with no
      // status prefix) is skipped rather than guessed at, and does NOT end a commit.
      const n = /^\d+$/.test(line) ? Number(line) : NaN;
      if (!Number.isFinite(n)) continue;
      flush(ts, entries);
      entries = [];
      ts = n * 1000;
      continue;
    }
    if (!ts) continue; // file entry before any stamp — malformed, ignore
    const status = m[1]!;
    const rest = m[3]!;
    if (status === "R" || status === "C") {
      // `R100\told\tnew` — the paths are TAB-separated in `rest`.
      const tab = rest.indexOf("\t");
      if (tab === -1) {
        entries.push({ status, path: rest });
        continue;
      }
      entries.push({ status, path: rest.slice(tab + 1), from: rest.slice(0, tab) });
      continue;
    }
    entries.push({ status, path: rest });
  }
  flush(ts, entries); // the last commit has no following stamp to trigger its flush

  return { created, touched };
}

/**
 * Build the per-page date signals for the wiki rooted at `root`.
 *
 * The wiki root is often a SUBDIRECTORY of its repo (jarvis's wiki lives at
 * `huginn/huginn-jarvis/data/wiki`; mimir's root IS its toplevel), so the walk
 * resolves the toplevel, scopes `git log` to the wiki subtree with a pathspec, and
 * translates repo-relative paths back to wiki-relative. Scoping is what keeps the
 * cost proportional to the wiki rather than to the whole repo's history — and it is
 * also what makes the sweep count mean "files inside the wiki subtree" for free, for
 * every wiki that is a subdirectory. For a wiki that IS its repo (mimir) the count is
 * necessarily whole-repo, which is the same thing said differently.
 *
 * `--diff-merges=first-parent` mirrors mimir's own `scripts/plan-status/git-touch.ts`:
 * a bare log prints a MERGE's combined diff, which is empty for a clean merge, so
 * merge commits would contribute nothing and (worse) a merge that carried a file's
 * only introduction would hide it. The flag is a no-op on non-merge commits.
 *
 * The `dirty` probe is a SECOND subprocess (`git status`, via `listWikiSubtreeDirty`
 * — the same call the reader's Index card already makes), run concurrently with the
 * log walk. It cannot come from history by construction: it is precisely the state
 * history does not know about yet.
 */
export async function buildWikiGitDates(root: string): Promise<WikiGitDates | null> {
  const top = await git(root, ["rev-parse", "--show-toplevel"]);
  if (!top) return null; // not a git repo (or git missing) — caller degrades
  const toplevel = top.trim();
  if (!toplevel) return null;

  // Pathspec for the wiki subtree, repo-relative and posix. Empty when the wiki
  // root IS the toplevel, in which case the log is unscoped (already whole-repo).
  //
  // `--show-toplevel` reports a SYMLINK-RESOLVED path, so the registry's own spelling
  // of the root must be resolved too before they can be subtracted — on macOS a wiki
  // under `/tmp` (the e2e fixtures' `WIKI_EXTRA`, and any mkdtemp root) reports its
  // toplevel as `/private/tmp/…`, and the raw subtraction escapes upward into a `..`
  // path that gets read as "outside the repo" and degrades the whole walk. Same
  // realpath-before-compare rule as `wikiWriteQueueKey` and `commitWikiChange`.
  const canonicalRoot = await realpath(root).catch(() => root);
  const rel = path.relative(toplevel, canonicalRoot).split(path.sep).join("/");
  // A wiki root OUTSIDE its reported toplevel would mean a symlink crossing repos;
  // scoping to `..` is not a thing git accepts, so degrade rather than guess.
  if (rel.startsWith("..")) return null;

  const args = [
    "log",
    "--reverse",
    "--name-status",
    // Bare `-M` (50% similarity) is deliberate — do NOT tighten it. A stricter
    // threshold would stop an unrelated add/delete pair being read as a rename and
    // inheriting a wrong date, but that is theoretical here (measured: 0 delete-then-
    // re-add across mimir + huginn-nav + huginn-jarvis, 2257 paths) while real renames
    // in mimir spread across R051–R100 — 70 at R100, but 6 genuine ones below 90%.
    // `-M90%` would therefore mis-date 6 real pages to prevent 1 hypothetical.
    "-M",
    "--diff-merges=first-parent",
    "--format=%at",
  ];
  if (rel) args.push("--", rel);

  // Kicked off BEFORE the log is awaited so the two subprocesses overlap. Already
  // best-effort internally (a failed `git status` degrades to empty); the catch is
  // belt-and-braces so a dirty-probe failure can never take the walk down with it.
  const dirtyPromise = listWikiSubtreeDirty(toplevel, root).catch(() => ({
    dirty: [] as string[],
    deletions: [] as string[],
  }));

  const stdout = await git(toplevel, args);
  if (stdout === null) {
    // A repo with no commits yet exits non-zero on `log`. Nothing to warn about
    // loudly — the sort just keeps its previous behavior.
    log.debug("wiki {root}: git date walk unavailable", { root });
    return null;
  }

  const { created, touched } = parseGitLog(stdout);
  // `listWikiSubtreeDirty` already returns WIKI-relative paths, so it needs no strip.
  const dirty = new Set((await dirtyPromise).dirty);
  if (!rel) return { created, touched, dirty };

  // Translate repo-relative → wiki-relative, dropping anything outside the subtree
  // (the pathspec makes that rare, but a rename's SOURCE can legitimately sit
  // outside it and would otherwise land in the map under a bogus key).
  const prefix = rel.endsWith("/") ? rel : rel + "/";
  const strip = (m: Map<string, number>) => {
    const out = new Map<string, number>();
    for (const [p, ms] of m) if (p.startsWith(prefix)) out.set(p.slice(prefix.length), ms);
    return out;
  };
  const out = { created: strip(created), touched: strip(touched), dirty };
  // The strip is the one step that can throw away EVERYTHING while git reported
  // success — a wrong prefix, or paths in a spelling the prefix can't match (the
  // `core.quotePath` class of bug). Distinguished here from the innocent
  // empty-subtree case, which the caller must not mistake for a key mismatch.
  if (created.size > 0 && out.created.size === 0) {
    log.warn(
      "wiki {root}: git returned {scanned} path(s) but none under the wiki subtree " +
        "{prefix} — creation and update dates unavailable",
      { root, scanned: created.size, prefix },
    );
  }
  return out;
}
