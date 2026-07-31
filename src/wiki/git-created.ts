/**
 * Per-page CREATION dates derived from git history — the durable "Recently added"
 * signal for wikis that carry no `created:` frontmatter.
 *
 * ## Why this exists
 *
 * `pageAddedMs` (`views/components/wiki-filter.ts`) ranked "Recently added" on the
 * frontmatter `created` date and the file's BIRTHTIME. In a git-managed wiki the
 * birthtime is not a creation date — it is "when this inode last appeared", and
 * three routine operations reset it for every file they touch:
 *
 *  - `git mv` (mimir's 2026-07-08 `wiki/`→`projects/` reorg: 302 files birthtimed
 *    that day),
 *  - a re-clone / fresh checkout,
 *  - any sweep that writes via temp-file + rename rather than in place (mimir's
 *    2026-07-31 plan-status backfill: 148 files, all birthtimed 12:31 that day —
 *    verified: an in-place overwrite PRESERVES birthtime, temp+rename RESETS it).
 *
 * mimir declares no `created:` (1 of 154 plans has one), so after the backfill
 * every plan reported the same creation day and the sort collapsed into one block
 * ordered by title. git is the only signal in the repo that a sweep cannot move.
 *
 * ## What it returns
 *
 * relPath (wiki-relative, posix) → epoch ms of the commit that first introduced
 * that path, rename-aware. `null` when the wiki is not in a git repo, git is
 * unavailable, or the walk exceeded its budget — every caller then keeps exactly
 * the pre-existing frontmatter+birthtime behavior.
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

const log = getLog("wiki", "git-created");

/**
 * Wall-clock budget for the whole walk (spawn + read + parse). One `git log` over
 * mimir's full history measures ~135 ms (3223 output lines, 83 renames), so this is
 * ~40× headroom. It exists because the walk runs INSIDE `buildWikiIndex`: a
 * pathological repo (huge history, a hung filesystem, an index.lock contender) must
 * degrade the sort, never stall every /wiki request behind a cold index build.
 */
export const GIT_CREATED_TIMEOUT_MS = 5_000;

/** A file entry from `--name-status`: a status letter, optional similarity score,
 *  then a TAB. Commit stamps (`--format=%at`, a bare integer) can never match it,
 *  which is what makes the two line kinds unambiguous without a sentinel. */
const NAME_STATUS_RE = /^([A-Z])(\d*)\t(.*)$/;

/** Spawn `git -C <cwd> <args…>`, bounded by `GIT_CREATED_TIMEOUT_MS`. Never throws
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
    const timer = setTimeout(() => proc.kill(), GIT_CREATED_TIMEOUT_MS);
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

/**
 * Walk `git log --name-status` output oldest-first and record when each path first
 * appeared. Pure (no spawn, no fs) so the rename/parse semantics are unit-testable
 * against literal git output.
 *
 * Expects `--reverse --name-status -M --format=%at` — oldest commit first, so a
 * rename's source is always already in the map when the rename is read.
 *
 * Two rules:
 *  - **First appearance wins.** Deliberately not `--diff-filter=A`-only: with the
 *    pathspec scoping below, the first commit that mentions a path IS its arrival
 *    in this wiki, whatever letter git labels it. That also survives grafted or
 *    rewritten history where no `A` record exists at all.
 *  - **A rename CARRIES the source's date.** `R100\told\tnew` — mimir renames plans
 *    wholesale (`wiki/`→`projects/`, `.md`→`.mdx` conversions), and without this
 *    every renamed page would date to the rename commit, reproducing the exact bug
 *    this module exists to fix. `new` inherits `old`'s date; if `old` is unknown
 *    (renamed in from outside the pathspec) `new` gets the rename commit's date.
 */
export function parseGitCreatedLog(stdout: string): Map<string, number> {
  const out = new Map<string, number>();
  let ts = 0;
  const first = (p: string, at: number) => {
    if (p && !out.has(p)) out.set(p, at);
  };
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const m = NAME_STATUS_RE.exec(line);
    if (!m) {
      // A bare integer is the commit stamp. Anything else (a `--format` artifact,
      // a path with no status prefix) is skipped rather than guessed at.
      const n = /^\d+$/.test(line) ? Number(line) : NaN;
      if (Number.isFinite(n)) ts = n * 1000;
      continue;
    }
    if (!ts) continue; // file entry before any stamp — malformed, ignore
    const status = m[1]!;
    const rest = m[3]!;
    if (status === "R" || status === "C") {
      // `R100\told\tnew` — the paths are TAB-separated in `rest`.
      const tab = rest.indexOf("\t");
      if (tab === -1) {
        first(rest, ts);
        continue;
      }
      const from = rest.slice(0, tab);
      const to = rest.slice(tab + 1);
      // A COPY leaves the source in place, so it must not lose its own date; both
      // branches only ever fill an unset key, so the guard is implicit.
      first(to, out.get(from) ?? ts);
      continue;
    }
    first(rest, ts);
  }
  return out;
}

/**
 * Build the relPath→creation-ms map for the wiki rooted at `root`.
 *
 * The wiki root is often a SUBDIRECTORY of its repo (jarvis's wiki lives at
 * `huginn/huginn-jarvis/data/wiki`; mimir's root IS its toplevel), so the walk
 * resolves the toplevel, scopes `git log` to the wiki subtree with a pathspec, and
 * translates repo-relative paths back to wiki-relative. Scoping is what keeps the
 * cost proportional to the wiki rather than to the whole repo's history.
 *
 * `--diff-merges=first-parent` mirrors mimir's own `scripts/plan-status/git-touch.ts`:
 * a bare log prints a MERGE's combined diff, which is empty for a clean merge, so
 * merge commits would contribute nothing and (worse) a merge that carried a file's
 * only introduction would hide it. The flag is a no-op on non-merge commits.
 */
export async function buildGitCreatedMap(root: string): Promise<Map<string, number> | null> {
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

  const stdout = await git(toplevel, args);
  if (stdout === null) {
    // A repo with no commits yet exits non-zero on `log`. Nothing to warn about
    // loudly — the sort just keeps its previous behavior.
    log.debug("wiki {root}: git creation-date walk unavailable", { root });
    return null;
  }

  const repoRelative = parseGitCreatedLog(stdout);
  if (!rel) return repoRelative;

  // Translate repo-relative → wiki-relative, dropping anything outside the subtree
  // (the pathspec makes that rare, but a rename's SOURCE can legitimately sit
  // outside it and would otherwise land in the map under a bogus key).
  const prefix = rel.endsWith("/") ? rel : rel + "/";
  const out = new Map<string, number>();
  for (const [p, ms] of repoRelative) {
    if (p.startsWith(prefix)) out.set(p.slice(prefix.length), ms);
  }
  // The strip is the one step that can throw away EVERYTHING while git reported
  // success — a wrong prefix, or paths in a spelling the prefix can't match (the
  // `core.quotePath` class of bug). Distinguished here from the innocent
  // empty-subtree case, which the caller must not mistake for a key mismatch.
  if (repoRelative.size > 0 && out.size === 0) {
    log.warn(
      "wiki {root}: git returned {scanned} path(s) but none under the wiki subtree " +
        "{prefix} — creation dates unavailable",
      { root, scanned: repoRelative.size, prefix },
    );
  }
  return out;
}
