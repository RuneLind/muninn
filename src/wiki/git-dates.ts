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
 * **A mtime is only evidence when a HUMAN moved it.** `dirty` is what hands a page
 * back to the mtime rule, and a mechanical frontmatter write — a series join, a
 * plan-status flip — moves every touched page's mtime while changing nothing a
 * reader would call an edit. Such a page is dropped from `dirty` and dates from its
 * git history like a clean one. The metadata-only section below states the three
 * verdicts and the three rules that keep a real edit from being dropped with it;
 * everywhere else points there.
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
import { isMarkdownWikiPath, splitFrontmatter } from "./page-text.ts";
import { PROVENANCE_FRONTMATTER_KEYS } from "./provenance.ts";

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
 * Deliberately NOT scaled to wiki size, though jarvis (952 pages) is ~2.5× mimir
 * (387) and ~6× its plans folder: "how many files did one intentional edit
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
   * page every one of whose commits was a sweep (19 of mimir's 151 plans at
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
   *
   * MINUS the metadata-only edits — see {@link classifyPageChange} and the section
   * it belongs to: a tracked page whose body matches `HEAD` and whose frontmatter
   * differs only in metadata keys was written by a mechanical pass, so its mtime is
   * that pass's timestamp and not an edit.
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
      if (e.status === "R" && e.from !== undefined) {
        // A RENAME moves a page: the destination IS the source, so it inherits both
        // dates, and the source path is retired from `touched` so a later file
        // reusing that exact path can't inherit a predecessor's edit history. If the
        // source is unknown (renamed in from outside the pathspec) the destination
        // falls back to the rename commit for creation, and to nothing for update.
        firstSeen(e.path, created.get(e.from) ?? ts);
        const carried = touched.get(e.from);
        if (carried !== undefined) touched.set(e.path, carried);
        touched.delete(e.from);
      } else if (e.from !== undefined) {
        // A COPY is a NEW page that happens to share text with an existing one, so it
        // inherits NEITHER date — dating it to its source would sink a genuinely new
        // page in "Recently added", which is this module's whole job. The source is
        // untouched by a copy and keeps its own dates (git emits no entry for it).
        //
        // Unreachable today: `-C` is not passed to `git log`, so git never emits a
        // `C` status. Handled anyway so that turning `-C` on later is a behavior
        // change to weigh, not a silent mis-dating.
        firstSeen(e.path, ts);
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

// ── The metadata-only rule: which dirty pages' mtime is NOT evidence ──────────
//
// A mechanical write that only rewrites frontmatter keys — a series join writing
// `series:` onto twelve pages, the /plans board writing `priority:` or
// `plan_status` + `status_date` in a burst of clicks — moves every touched page's
// mtime, and the dirty probe above then hands all of them to the mtime rule: the
// rail reads twelve pages as edited three hours ago.
//
// So a TRACKED, MODIFIED page is COMPARED against its `HEAD` blob, and dropped
// from `dirty` — dating from git history like a clean page — on either of two
// verdicts. Three rules and one degrade make that safe.
//
// **The three verdicts, stated once** ({@link classifyPageChange}; everything
// else in this module points here rather than restating them):
//
//  - `metadata-only` — both sides carry frontmatter, the BODY after the fence is
//    byte-identical, and with every column-0 {@link METADATA_ONLY_FRONTMATTER_KEYS}
//    line stripped from both blocks the two remainders are identical IN ORDER —
//    so a hand edit that only reordered `title:` and `tags:` is an edit. Dropped.
//  - `identical` — the two texts are equal, which `git status` still reports as
//    modified for a mode-only change (`chmod`). No edit to hide. Dropped.
//  - `edit` — everything else, and it is the DEFAULT: a body difference, a page
//    with no frontmatter on either side, a differing key outside the set, an
//    indented or otherwise unparsed frontmatter line, a HEAD blob the repo does
//    not hold, an unreadable or non-UTF-8 or NUL-carrying file, a path a
//    `cat-file --batch` line cannot carry. Kept dirty.
//
// **The three rules.** Each is a way the rule would otherwise hide a real edit:
//
//  1. The comparison is against `HEAD`, never the worktree's own index state.
//     Both wiki writers (`commitWikiChange` and the repo-sync loop's
//     `stagePaths`) `git add` before they commit, so a STAGED real prose edit is
//     invisible to anything that compares against the index — the one kind of
//     edit this must never hide.
//  2. Only tracked-MODIFIED paths are classified (`isTrackedModifiedStatus`).
//     `listWikiSubtreeDirty` also reports untracked and deleted paths; an
//     untracked page has no HEAD blob at all, and dropping it would both hide a
//     brand-new page's only date signal and push it into `store.ts`'s
//     unexplained-miss counter — a coverage alarm about a bug that does not
//     exist. Untracked and deleted paths pass through untouched.
//  3. A changed line counts as metadata only INSIDE the frontmatter block, and
//     the block is the one `parseFrontmatter` reads (`splitFrontmatter`). mimir
//     documents these very keys, so `prs: [...]` and `sessions: [...]` occur at
//     column 0 inside body code fences.
//
// **The degrade is always "keep the page dirty"** — there is no absent-verdict
// state: every candidate gets a positive answer or defaults to `edit`. Hiding a
// real edit is the only outcome worth engineering against; showing a sweep's
// timestamp is what shipped before this rule existed.
//
// (Fix round 1 replaced a `git diff HEAD -U0` TEXT parse, which had five ways to
// leave a candidate unnamed — a space in the path, a C-quoted header, a
// binary-detected page, a `diff.noprefix`-style user config, and a deletion whose
// hunk anchors on the closing fence — and dropped every one of them.)

/**
 * The frontmatter keys whose ADDITION, REMOVAL or REWRITE is not an edit of the
 * page: the four provenance keys claude-usage's stamper writes, plus the five
 * muninn's own mechanical writers do — the series editor (`series`/`series_label`,
 * one call per member of a join) and the `/plans` board (`priority`, and
 * `plan_status` + `status_date` together).
 *
 * The rule is derived from the KEY SET, not from a claim about its writers: the
 * gardener's lint-proposals path writes `series:` WITH a `log.md` entry, so "every
 * writer of these keys takes the no-log path" is false. What makes a key belong
 * here is that its value says something about the page's PLACE in the wiki rather
 * than about its content — which is what a reader asking "when was this last
 * edited" wants left out.
 *
 * Lives here because `git-dates.ts` is the only consumer, and is a superset of
 * {@link PROVENANCE_FRONTMATTER_KEYS} rather than a second list, so a key added
 * there is covered here by construction.
 */
export const METADATA_ONLY_FRONTMATTER_KEYS = [
  ...PROVENANCE_FRONTMATTER_KEYS,
  "series",
  "series_label",
  "priority",
  "plan_status",
  "status_date",
] as const;

/** A frontmatter line whose KEY is one a mechanical writer owns. Column 0 and a
 *  literal `:`, matching `parseFrontmatter`'s own key shape (which admits no
 *  leading space), so an indented child, a list item and a comment are never
 *  metadata — and a page whose only change is one of those keeps its mtime. Every
 *  key is a bare identifier, so none needs escaping into the alternation. */
const METADATA_FRONTMATTER_LINE_RE = new RegExp(
  `^(?:${METADATA_ONLY_FRONTMATTER_KEYS.join("|")}):`,
);

/** What a dirty page's two texts say about each other. See the section comment
 *  above for the full rule; `edit` is the default and the only one that keeps the
 *  page's mtime. */
export type PageChangeVerdict = "identical" | "metadata-only" | "edit";

/**
 * Compare a page's `HEAD` text with its worktree text. Pure, so the whole rule is
 * unit-testable without a repo.
 *
 * A page with no frontmatter on EITHER side is an `edit` whenever the two texts
 * differ at all: there is no block a mechanical writer could have written into, so
 * every difference is body. (Equal texts answer `identical` before the split runs,
 * so a frontmatter-less page that did not change is still dropped.)
 */
export function classifyPageChange(headText: string, workText: string): PageChangeVerdict {
  if (headText === workText) return "identical";
  const head = splitFrontmatter(headText);
  const work = splitFrontmatter(workText);
  if (head.frontmatter === null || work.frontmatter === null) return "edit";
  if (head.body !== work.body) return "edit";
  return frontmatterDiffIsMetadataOnly(head.frontmatter, work.frontmatter)
    ? "metadata-only"
    : "edit";
}

/**
 * Does the frontmatter differ ONLY in metadata key lines? Line-based rather than
 * a key-by-key parse, deliberately: a parse answers nothing about the lines it
 * does not model — a value-less block opener, a list item, a comment, a depth-2
 * child, an unparseable line — and "not modelled" would read as "not changed",
 * i.e. as a page nobody edited.
 *
 * The test is ORDER-SENSITIVE: strip every metadata line from both sides and the
 * two remainders must be identical, in sequence. A multiset of lines was the
 * first cut, and it read a hand edit that only reordered `title:` and `tags:`
 * as "nothing changed" — every line present on both sides, count zero. With the
 * remainders equal, whatever differs between the blocks is a metadata line by
 * construction, added, removed, rewritten or moved.
 *
 * A trailing `\r` needs no trimming: the key regex is anchored at column 0 and
 * open at the end, so a CRLF page's metadata lines match with it in place.
 */
function frontmatterDiffIsMetadataOnly(head: string, work: string): boolean {
  const remainder = (block: string) =>
    block
      .split("\n")
      .filter((line) => !METADATA_FRONTMATTER_LINE_RE.test(line))
      .join("\n");
  return remainder(head) === remainder(work);
}

/**
 * Wall-clock budget for the metadata-only classification — its OWN, not a share of
 * {@link GIT_DATES_TIMEOUT_MS}. Same number for the same reason (this also runs
 * inside `buildWikiIndex`), but a separate budget, because the two degrade
 * differently: the dirty probe losing its race costs the mtime rule for every
 * page, while this one losing its own costs only the metadata-only DROP — the
 * unclassified dirty set is returned whole.
 */
export const GIT_DATES_CLASSIFY_TIMEOUT_MS = 5_000;

let classifyBudgetMs: number = GIT_DATES_CLASSIFY_TIMEOUT_MS;

/** Test seam: shrink the classification budget so the degrade path can be driven
 *  against a real slow `git` inside `bun test`'s own 5 s per-test default. `null`
 *  restores {@link GIT_DATES_CLASSIFY_TIMEOUT_MS}. */
export function __setClassifyBudgetForTest(ms: number | null): void {
  classifyBudgetMs = ms ?? GIT_DATES_CLASSIFY_TIMEOUT_MS;
}

/**
 * Read `HEAD:<path>` for each repo-relative path through ONE `git cat-file
 * --batch`, answering the text per path IN INPUT ORDER (`null` where there is no
 * usable text). `null` for the whole call when the read failed or timed out.
 *
 * The paths go in on STDIN, which is what makes this immune to the class of bug it
 * replaces: a batch line carries spaces, quotes and non-ASCII verbatim, needs no
 * shell or argv quoting, and no `diff.*` user config can change the spelling an
 * answer comes back under. Answers are matched by POSITION rather than by the
 * echoed name for the same reason.
 */
async function readHeadTexts(toplevel: string, repoRel: string[]): Promise<(string | null)[] | null> {
  try {
    const proc = Bun.spawn(["git", "-C", toplevel, "cat-file", "--batch"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    // The same kill the module's other spawns take, on this call's own budget —
    // without it a hung `cat-file` outlives the race that gave up on it.
    const timer = setTimeout(() => proc.kill(), classifyBudgetMs);
    try {
      // stdout is consumed CONCURRENTLY with the write: the request is one line
      // per candidate and a large dirty set exceeds a pipe buffer, so writing it
      // all before reading would deadlock.
      const stdoutPromise = new Response(proc.stdout).arrayBuffer();
      proc.stdin.write(repoRel.map((p) => `HEAD:${p}\n`).join(""));
      const [buf, code] = await Promise.all([
        stdoutPromise,
        proc.exited,
        Promise.resolve(proc.stdin.end()),
      ]);
      if (code !== 0) return null;
      return parseCatFileBatch(new Uint8Array(buf), repoRel.length);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/**
 * Parse `git cat-file --batch` output into one entry per request, in order.
 *
 * Each answer is either `<oid> <type> <size>\n<size bytes>\n` or `<input>
 * <reason>\n` (`missing`, `ambiguous`) — the second form echoes the whole input
 * line, which may itself contain spaces, so it is recognised by NOT being the
 * three-field content form rather than by matching a reason word. Anything that is
 * not a `blob` answers `null` and consumes its bytes.
 */
function parseCatFileBatch(bytes: Uint8Array, expected: number): (string | null)[] {
  const out: (string | null)[] = [];
  const ascii = new TextDecoder("utf-8", { fatal: false });
  let pos = 0;
  while (out.length < expected) {
    const lf = bytes.indexOf(0x0a, pos);
    if (lf === -1) break;
    const header = ascii.decode(bytes.subarray(pos, lf));
    pos = lf + 1;
    const fields = header.split(" ");
    const size = fields.length === 3 ? Number(fields[2]) : NaN;
    if (fields.length !== 3 || !Number.isSafeInteger(size) || size < 0) {
      out.push(null); // missing / ambiguous: no content follows
      continue;
    }
    const end = pos + size;
    if (end > bytes.length) break; // truncated output — the rest is unanswered
    // `blob` is the only type a tracked-modified page can resolve to (a status
    // `[ M][ M]` path is a file in HEAD); the check is a statement, not a branch.
    out.push(fields[1] === "blob" ? decodeStrict(bytes.subarray(pos, end)) : null);
    pos = end + 1; // the LF git writes after every object's content
  }
  while (out.length < expected) out.push(null);
  return out;
}

/** Bytes → text, or `null` for anything a line comparison must not be run over: a
 *  NUL (what makes git call a page binary) or invalid UTF-8, where a lossy decode
 *  would map two different byte sequences onto one string of U+FFFD. */
function decodeStrict(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The worktree half, through the same strict decode. Unreadable ⇒ `null` ⇒ the
 *  page keeps its mtime. */
async function readWorktreeText(abs: string): Promise<string | null> {
  try {
    return decodeStrict(new Uint8Array(await Bun.file(abs).arrayBuffer()));
  } catch {
    return null;
  }
}

/** The wiki-relative paths whose only change is metadata (or nothing at all). An
 *  empty set is the honest answer for "nothing to drop" AND for "nothing could be
 *  read" — both keep every page dirty. */
async function classifyCandidates(
  toplevel: string,
  canonicalRoot: string,
  relPrefix: string,
  candidates: string[],
): Promise<Set<string>> {
  // A newline in a path cannot be carried by a `cat-file --batch` line, and a path
  // with no spelling has no verdict — so it keeps its mtime.
  const usable = candidates.filter((p) => !p.includes("\n"));
  const [headTexts, workTexts] = await Promise.all([
    readHeadTexts(toplevel, usable.map((p) => relPrefix + p)),
    Promise.all(usable.map((p) => readWorktreeText(path.join(canonicalRoot, p)))),
  ]);
  const drop = new Set<string>();
  if (headTexts === null) return drop; // the whole read failed — keep every page
  for (let i = 0; i < usable.length; i++) {
    const head = headTexts[i];
    const work = workTexts[i];
    // No usable text on either side ⇒ `edit`, the default. `undefined` is the
    // same answer as `null` here: a short batch answer is a read that did not
    // happen, not a page that did not change.
    if (typeof head !== "string" || typeof work !== "string") continue;
    if (classifyPageChange(head, work) !== "edit") drop.add(usable[i]!);
  }
  return drop;
}

/**
 * The dirty list MINUS the pages whose only change is frontmatter metadata (or
 * nothing at all). Never throws, and every degrade — a failed read, a thrown
 * error, its own budget expiring — answers the UNCLASSIFIED dirty set, i.e. the
 * behaviour of a muninn that never had this rule.
 *
 * Bounded by {@link GIT_DATES_CLASSIFY_TIMEOUT_MS}, its own budget: it runs inside
 * `buildWikiIndex`, and a pathological repo must degrade the drop rather than
 * stall every /wiki request behind a cold index build.
 */
async function dropMetadataOnlyEdits(
  root: string,
  toplevel: string,
  canonicalRoot: string,
  relPrefix: string,
  listed: { dirty: string[]; trackedModified: string[] },
): Promise<string[]> {
  const candidates = listed.trackedModified.filter(isMarkdownWikiPath);
  if (candidates.length === 0) return listed.dirty;

  const drop = await Promise.race([
    classifyCandidates(toplevel, canonicalRoot, relPrefix, candidates).catch(() => null),
    new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), classifyBudgetMs).unref?.(),
    ),
  ]);
  if (drop === null) {
    log.debug(
      "wiki {root}: metadata-only classification exceeded its budget — every dirty page keeps its mtime",
      { root },
    );
    return listed.dirty;
  }
  if (drop.size === 0) return listed.dirty;
  log.debug("wiki {root}: {n} dirty page(s) are metadata-only — mtime rule dropped", {
    root,
    n: drop.size,
  });
  return listed.dirty.filter((p) => !drop.has(p));
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
  // repo-relative prefix of the wiki subtree, shared by the dirty classification
  // (which talks to git in repo-relative paths) and the map strip below.
  const prefix = !rel ? "" : rel.endsWith("/") ? rel : rel + "/";

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
  //
  // RACED against the same budget as the log walk, because `listWikiSubtreeDirty`
  // uses `commit.ts`'s own git helper, which has no timer — and this promise is
  // awaited on the index-build critical path. Without the race, `GIT_DATES_TIMEOUT_MS`
  // would bound only half of what this function spawns, and a `git status` stat-walk
  // over a large or network-mounted worktree could park every /wiki request behind a
  // cold index build. Losing the race costs only the mtime rule for dirty pages.
  //
  // The metadata-only classification hangs off the RESULT rather than sitting
  // inside the race: it carries its own budget (see `dropMetadataOnlyEdits`) whose
  // loser is the unclassified dirty set. Inside this race its loser would be `[]`
  // — a slow classification silently deleting the mtime rule for the untracked and
  // deleted pages it never looks at.
  const dirtyPromise = Promise.race([
    listWikiSubtreeDirty(toplevel, root),
    new Promise<Awaited<ReturnType<typeof listWikiSubtreeDirty>>>((resolve) =>
      setTimeout(() => {
        log.debug("wiki {root}: dirty probe exceeded its budget — mtime rule disabled", { root });
        resolve({ dirty: [], deletions: [], trackedModified: [] });
      }, GIT_DATES_TIMEOUT_MS).unref?.(),
    ),
  ])
    .then((listed) => dropMetadataOnlyEdits(root, toplevel, canonicalRoot, prefix, listed))
    .catch(() => [] as string[]);

  const stdout = await git(toplevel, args);
  if (stdout === null) {
    // A repo with no commits yet exits non-zero on `log`. Nothing to warn about
    // loudly — the sort just keeps its previous behavior.
    log.debug("wiki {root}: git date walk unavailable", { root });
    return null;
  }

  const { created, touched } = parseGitLog(stdout);
  // `listWikiSubtreeDirty` already returns WIKI-relative paths, so it needs no strip.
  const dirty = new Set(await dirtyPromise);
  if (!rel) return { created, touched, dirty };

  // Translate repo-relative → wiki-relative, dropping anything outside the subtree
  // (the pathspec makes that rare, but a rename's SOURCE can legitimately sit
  // outside it and would otherwise land in the map under a bogus key).
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
