/**
 * Git-tracked reads of one wiki: list, grep, history and a confined read.
 *
 * Every path in and out is relative to the wiki root, also when the wiki is a
 * subdirectory of a larger repo (huginn-nav/wiki). Only tracked files count,
 * minus the write artifacts (`isWikiWriteArtifact`): an untracked draft or an
 * ignored file never reaches a model through these. Every git child goes
 * through `realGit` (its own process group, a byte and line bound, a timeout)
 * with `core.quotePath=false` and NUL-separated output, so æøå and em dashes
 * come back verbatim.
 *
 * No git config may change what these return: the user's and the system's
 * files are not read at all, and the repo's own `.git/config` is outvoted by
 * `-c` on each key that would widen the search or change the output's shape.
 */

import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { cutLine, realGit, type GitResult, type GitRun } from "./decision-triage/git.ts";
import { keyCharBefore } from "./key-kinds.ts";
import { isWikiWriteArtifact } from "./lockfile.ts";

/** `-c` beats every config file. fallbackToNoIndex would grep untracked files
 *  outside a repo, submodule.recurse text a read refuses, column and fullName
 *  break the parse and the root-relative paths, logOutputEncoding the subjects. */
const PINNED_CONFIG = [
  "-c", "core.quotePath=false",
  "-c", "grep.fallbackToNoIndex=false",
  "-c", "submodule.recurse=false",
  "-c", "grep.column=false",
  "-c", "grep.fullName=false",
  "-c", "i18n.logOutputEncoding=UTF-8",
] as const;
const NO_USER_CONFIG = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } as const;

/** `git` with the config pinned. */
function pinned(git: GitRun): GitRun {
  return (cwd, args, opts = {}) => git(cwd, [...PINNED_CONFIG, ...args], { ...opts, env: { ...opts.env, ...NO_USER_CONFIG } });
}

export interface TrackedOpts {
  git?: GitRun;
}

export type TrackedFilesResult = { ok: true; files: string[] } | { ok: false; error: string };

function gitError(res: GitResult, what: string): string {
  if (res.timedOut) return `${what} timed out`;
  const first = (res.stderr ?? "").trim().split("\n")[0] ?? "";
  return first ? `${what} failed: ${cutLine(first)}` : `${what} failed`;
}

/** The wiki's tracked files, root-relative, sorted as git lists them. */
export async function trackedFiles(root: string, opts: TrackedOpts = {}): Promise<TrackedFilesResult> {
  const git = pinned(opts.git ?? realGit);
  const res = await git(root, ["ls-files", "-z", "--", "."]);
  if (!res.ok || res.capped) return { ok: false, error: res.capped ? "git ls-files output ran past its bound" : gitError(res, "git ls-files") };
  const files = res.stdout.split("\0").filter((f) => f !== "" && !isWikiWriteArtifact(path.posix.basename(f)));
  return { ok: true, files };
}

/** `*`, `?`, `[` and `{` are what Bun.Glob treats as wildcards. */
const hasWildcard = (glob: string) => /[*?[{]/.test(glob);

export type NormalizedGlob = { ok: true; kind: "all" | "path" | "pattern"; value: string } | { ok: false; error: string };

/**
 * The one reading of a caller's glob; nothing else looks at the raw string.
 * Doubled `/` collapse, any run of leading `./` and `/` goes, and so do
 * trailing `/`. Whitespace is kept, so a stray space matches literally (and
 * then selects nothing). Left empty or `.`: the whole wiki. A leading `!`
 * (Bun.Glob negation) is refused. A wildcard makes a Bun.Glob pattern; anything
 * else is a file or folder path from the root.
 */
export function normalizeGlob(raw: string): NormalizedGlob {
  const value = raw.replace(/\/{2,}/g, "/").replace(/^(?:\.?\/)+/, "").replace(/\/+$/, "");
  if (value === "" || value === ".") return { ok: true, kind: "all", value: "." };
  if (value.startsWith("!")) {
    const read = value === raw ? "" : ` (read as ${JSON.stringify(value)})`;
    return { ok: false, error: `glob ${JSON.stringify(raw)}${read} starts with !: negation is not supported; name the folder or files to search instead` };
  }
  return { ok: true, kind: hasWildcard(value) ? "pattern" : "path", value };
}

/**
 * Does the normalized glob select `relPath`? Case-sensitive. A path selects
 * the file or folder of that name at the root: `plans` is the root folder
 * `plans` (never `x/plans`). A pattern is matched from the root, and without
 * `/` also against the basename at any depth (`*.csv` finds `plans/x/Q-3.csv`).
 */
function selects(g: Extract<NormalizedGlob, { ok: true }>, relPath: string): boolean {
  if (g.kind === "all") return true;
  if (g.kind === "path") return relPath === g.value || relPath.startsWith(`${g.value}/`);
  const bg = new Bun.Glob(g.value);
  return bg.match(relPath) || (!g.value.includes("/") && bg.match(path.posix.basename(relPath)));
}

/** Does `glob` select `relPath` ({@link normalizeGlob}, then {@link selects})? A refused glob selects nothing. */
export function globMatches(glob: string, relPath: string): boolean {
  const g = normalizeGlob(glob);
  return g.ok && selects(g, relPath);
}

export interface GrepHit {
  relPath: string;
  line: number;
  /** The line's text, cut at `GIT_LINE_CHARS`. */
  text: string;
  /** With `fullText`: the line uncut. Only realGit's 4 MB bound on git's whole output limits it (mimir had a 25,804-character line on 2026-11-25). */
  full?: string;
}

export interface GrepOpts extends TrackedOpts {
  /** A Perl-compatible regex (`-P`), or an extended one (`-E`) on a git built
   *  without PCRE; otherwise the pattern is a fixed string (`-F`). */
  regex?: boolean;
  /** Search only tracked files this glob selects (see {@link normalizeGlob}). */
  glob?: string;
  /** Hits returned; the rest are only counted. */
  max?: number;
  /** Carry each hit's uncut line as `full`, for a caller that parses what the cut text would lose. */
  fullText?: boolean;
  /** Keep only lines that hold the fixed-string pattern as a whole key ({@link wholeKeyCount}); the totals count those alone. Not with `regex`. */
  wholeKey?: boolean;
}

export type GrepResult =
  | {
      ok: true;
      hits: GrepHit[];
      /** Matching lines seen, and the files they are in. With `atLeast`, the scan stopped at its bound and these are lower bounds. */
      totalLines: number;
      totalFiles: number;
      atLeast: boolean;
      /** With `regex`: the engine that ran. `ere` only when this git has no PCRE: POSIX ERE, where backslash classes such as `\d` are not portable (glibc reads `\w` as a word character and `\d` as `d`). */
      regexEngine?: "pcre" | "ere";
    }
  | { ok: false; error: string };

/** UTF-8, so a regex matches by character: under git's C locale `.` and `[æø]` meet one byte of æ. A fixed string stays byte-exact. */
const GREP_LOCALE = { LC_ALL: "C.UTF-8" } as const;
/** Git's own message, anchored: a bad pattern's error quotes the pattern after `fatal: -e option,`, so a pattern holding these words cannot pass for it. */
const isNoPcre = (res: GitResult) => !res.ok && res.exitCode !== 1 && /^fatal: cannot use Perl-compatible regexes/m.test(res.stderr ?? "");

export const GREP_DEFAULT_MAX = 100;
export const GREP_MAX_RESULTS = 500;
/** How many matching lines one search counts before it stops: past it, totals read «at least». */
export const GREP_SCAN_LINES = 5_000;
/** Pathspec bytes per `git grep` when a glob expands to a file list. */
export const GREP_PATHSPEC_CHUNK_BYTES = 64_000;

/** Split `paths` into argument lists of at most `maxBytes` bytes each. */
export function chunkPaths(paths: readonly string[], maxBytes = GREP_PATHSPEC_CHUNK_BYTES): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let bytes = 0;
  for (const p of paths) {
    const b = Buffer.byteLength(p) + 1;
    if (cur.length > 0 && bytes + b > maxBytes) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(p);
    bytes += b;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** A character that continues a key: a Unicode letter or digit. `_` and `-`
 *  are not, so `MEL-1_notes` and `MEL-1-fix` mention MEL-1, and `MEL-10`,
 *  `XMEL-1` and `MEL-1å` do not. The character before a match is checked as a
 *  whole code point ({@link keyCharBefore}), not by a lookbehind, which reads
 *  one UTF-16 unit under Bun/JSC and let `𝐀MEL-1` count. */
const KEY_CHAR = "[\\p{L}\\p{N}]";
const reEscape = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
const wholeKeyRes = new Map<string, RegExp>();

/** How often `key` occurs in `text` as a whole key: with no Unicode letter or digit right before or after it. */
export function wholeKeyCount(text: string, key: string): number {
  let re = wholeKeyRes.get(key);
  if (!re) {
    if (wholeKeyRes.size > 64) wholeKeyRes.clear();
    re = new RegExp(`${reEscape(key)}(?!${KEY_CHAR})`, "gu");
    wholeKeyRes.set(key, re);
  }
  re.lastIndex = 0;
  let n = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    if (keyCharBefore(text, m.index)) re.lastIndex = m.index + 1;
    else n++;
  }
  return n;
}

/** `path\0line\0text` lines from `git grep --null -n`; with `keep`, only lines whose uncut text it accepts. */
function parseGrep(stdout: string, fullText: boolean, keep?: (line: string) => boolean): GrepHit[] {
  const hits: GrepHit[] = [];
  for (const raw of stdout.split("\n")) {
    if (!raw) continue;
    const a = raw.indexOf("\0");
    const b = a === -1 ? -1 : raw.indexOf("\0", a + 1);
    if (b === -1) continue;
    const line = Number(raw.slice(a + 1, b));
    if (!Number.isInteger(line)) continue;
    const text = raw.slice(b + 1);
    if (keep && !keep(text)) continue;
    hits.push({ relPath: raw.slice(0, a), line, text: cutLine(text), ...(fullText ? { full: text } : {}) });
  }
  return hits;
}

/**
 * `git grep` over the wiki's tracked files. A glob is expanded here against
 * {@link trackedFiles} and the chosen paths go to git as literal pathspecs, in
 * chunks, so git searches only what the glob allows: filtering git's output
 * afterwards would filter text the line bound had already cut.
 */
export async function grepTracked(root: string, pattern: string, opts: GrepOpts = {}): Promise<GrepResult> {
  const refused = refusePattern(pattern);
  if (refused) return refused;
  if (opts.regex && opts.wholeKey) return { ok: false, error: "wholeKey takes a fixed string, not a regex" };
  const rawGit = opts.git ?? realGit;
  const git = pinned(rawGit);
  const max = Math.min(Math.max(1, Math.floor(opts.max ?? GREP_DEFAULT_MAX)), GREP_MAX_RESULTS);
  const engine: Engine = opts.regex ? "pcre" : undefined;
  let pathspecs: string[][];
  const glob = opts.glob ? normalizeGlob(opts.glob) : undefined;
  if (glob && !glob.ok) return glob;
  // The whole wiki is the no-glob search.
  if (glob && glob.kind !== "all") {
    const listed = await trackedFiles(root, { git: rawGit });
    if (!listed.ok) return listed;
    const selected = listed.files.filter((f) => selects(glob, f));
    // Never a zero-hit search: that reads as «the key is nowhere».
    if (selected.length === 0) {
      return { ok: false, error: `glob ${JSON.stringify(opts.glob)} selects no tracked file (globs match wiki-root-relative paths, case-sensitively, from the root: plans or plans/** is the top-level folder plans, a nested one needs its path or **/name/**)` };
    }
    pathspecs = chunkPaths(selected);
  } else pathspecs = [["."]];

  return counted(await grepChunks(root, git, pattern, engine, pathspecs, GREP_SCAN_LINES, opts.fullText === true, wholeKeyFilter(pattern, opts.wholeKey)), max);
}

const wholeKeyFilter = (key: string, on: boolean | undefined) => (on ? (line: string) => wholeKeyCount(line, key) > 0 : undefined);

function refusePattern(pattern: string): { ok: false; error: string } | null {
  if (pattern === "") return { ok: false, error: "the pattern is empty" };
  if (pattern.includes("\n") || pattern.includes("\0")) return { ok: false, error: "the pattern may not hold a newline or NUL" };
  return null;
}

/** The first `max` hits, and the totals over every hit the scan saw. */
function counted(res: Awaited<ReturnType<typeof grepChunks>>, max: number): GrepResult {
  if (!res.ok) return res;
  return {
    ok: true,
    hits: res.hits.slice(0, max),
    totalLines: res.hits.length,
    totalFiles: new Set(res.hits.map((h) => h.relPath)).size,
    atLeast: res.atLeast,
    ...(res.engine ? { regexEngine: res.engine } : {}),
  };
}

type Engine = "pcre" | "ere" | undefined;

/** The search itself: each chunk of pathspecs in turn until `scanLines` matching lines are seen, write artifacts dropped. `engine` undefined is a fixed string; `pcre` falls back to `ere` on a git without PCRE. `keep` filters the lines git returned; the scan bound counts git's lines, so a filtered search that hits it is still `atLeast`. */
async function grepChunks(
  root: string,
  git: GitRun,
  pattern: string,
  engine: Engine,
  pathspecs: string[][],
  scanLines: number,
  fullText: boolean,
  keep?: (line: string) => boolean,
): Promise<{ ok: true; hits: GrepHit[]; atLeast: boolean; engine: Engine } | { ok: false; error: string }> {
  const all: GrepHit[] = [];
  let atLeast = false;
  let seen = 0;
  for (const chunk of pathspecs) {
    const budget = scanLines - seen;
    if (budget <= 0) {
      atLeast = true;
      break;
    }
    const run = () => {
      const mode = engine === "pcre" ? "-P" : engine === "ere" ? "-E" : "-F";
      return git(root, ["grep", "--no-recurse-submodules", "--null", "-n", "-I", "--no-color", mode, "-e", pattern, "--", ...chunk], { maxLines: budget, env: GREP_LOCALE });
    };
    let res = await run();
    if (engine === "pcre" && isNoPcre(res)) {
      engine = "ere";
      res = await run();
    }
    // Exit 1 with nothing on stderr is git grep's «no match», not a failure.
    if (!res.ok && !(res.exitCode === 1 && !res.stderr)) return { ok: false, error: gitError(res, "git grep") };
    let stdout = res.stdout;
    if (res.capped) {
      atLeast = true;
      // At the line bound realGit keeps `budget` whole lines; at the byte bound
      // (4 MB) the last line can be cut mid-text, so it is dropped.
      const lineCapped = stdout.split("\n").filter(Boolean).length >= budget;
      if (!lineCapped && !stdout.endsWith("\n")) stdout = stdout.slice(0, stdout.lastIndexOf("\n") + 1);
    }
    const hits = parseGrep(stdout, fullText);
    seen += hits.length;
    all.push(...(keep ? parseGrep(stdout, fullText, keep) : hits));
    if (res.capped) break;
  }
  const isWriteArtifact = (h: GrepHit) => isWikiWriteArtifact(path.posix.basename(h.relPath));
  return { ok: true, hits: all.filter((h) => !isWriteArtifact(h)), atLeast, engine };
}

/** The wiki's own log, at its root. A literal pathspec: never a nested `x/log.md`. */
export const ROOT_LOG = "log.md";
/** Header lines {@link rootLogHeaders} reads before it stops: mimir's log had 1,355 `##` lines on 2026-11-25. */
export const LOG_HEADER_SCAN_LINES = 10_000;

/**
 * `git grep` for a fixed string in the root `log.md` alone, with its own
 * budget, so a busy key's hits elsewhere cannot use up the log's. An untracked
 * or missing `log.md` has no hits.
 */
export async function grepRootLog(root: string, pattern: string, opts: Omit<GrepOpts, "regex" | "glob"> = {}): Promise<GrepResult> {
  const refused = refusePattern(pattern);
  if (refused) return refused;
  const max = Math.min(Math.max(1, Math.floor(opts.max ?? GREP_DEFAULT_MAX)), GREP_MAX_RESULTS);
  return counted(await grepChunks(root, pinned(opts.git ?? realGit), pattern, undefined, [[ROOT_LOG]], GREP_SCAN_LINES, opts.fullText === true, wholeKeyFilter(pattern, opts.wholeKey)), max);
}

export interface LogHeader {
  line: number;
  /** The `##` line uncut: the caller parses it with the reader's `parseLogEntries`. */
  text: string;
}

/**
 * Every `##` line (not `###`) of the root `log.md`, numbered: a superset of
 * the reader's entry headers, which the caller keeps by parsing each with
 * `parseLogEntries`. `atLeast` when more lines matched than
 * {@link LOG_HEADER_SCAN_LINES}. An untracked or missing `log.md` has none.
 */
export async function rootLogHeaders(root: string, opts: TrackedOpts = {}): Promise<{ ok: true; headers: LogHeader[]; atLeast: boolean } | { ok: false; error: string }> {
  const res = await grepChunks(root, pinned(opts.git ?? realGit), "^##[^#]", "ere", [[ROOT_LOG]], LOG_HEADER_SCAN_LINES, true);
  if (!res.ok) return res;
  return { ok: true, headers: res.hits.map((h) => ({ line: h.line, text: h.full ?? h.text })), atLeast: res.atLeast };
}

export interface HistoryCommit {
  hash: string;
  /** Author date, ISO 8601. */
  date: string;
  author: string;
  subject: string;
  /** Files the commit touched, root-relative: the first {@link HISTORY_FILES_SHOWN}. */
  files: string[];
  /** How many files it touched in all. */
  fileCount: number;
}

export type HistoryResult =
  | {
      ok: true;
      commits: HistoryCommit[];
      /** git's output ran past realGit's bound: the possibly cut last commit was dropped and more may follow. With `wholeKey`: a candidate could not be counted (`uncounted`), the candidate listing reached {@link HISTORY_WHOLE_KEY_SCAN}, more than `limit` commits changed, a patch run timed out after at least one commit was read whole (the commits counted until then are kept), or the names run timed out or ran past its bound (a commit it did not describe carries its hash alone: empty date, author and subject, no files). */
      partial: boolean;
      /** `wholeKey` only: candidate commits whose own patch ran past realGit's bound, so their change was not counted. */
      uncounted?: string[];
    }
  | { ok: false; error: string };

export const HISTORY_DEFAULT_LIMIT = 20;
/** Files listed per commit; one bulk commit touched 415 (huginn-nav/wiki). */
export const HISTORY_FILES_SHOWN = 20;
export const HISTORY_MAX_LIMIT = 100;
export const HISTORY_TIMEOUT_MS = 30_000;

/** A root-relative path a caller may hand to git: no absolute path, no `..`, no NUL. */
export function isSafeRelPath(rel: string): boolean {
  if (rel === "" || rel.includes("\0") || path.isAbsolute(rel) || rel.startsWith("\\")) return false;
  return !rel.split(/[\\/]/).includes("..");
}

/** Candidate commits {@link historyFor} checks for a whole key: a listing that reaches it makes the answer `partial`, since older candidates were not listed. */
export const HISTORY_WHOLE_KEY_SCAN = 300;
/** The part of {@link HISTORY_TIMEOUT_MS} a whole-key history keeps for its names run: the listing and patch runs stop that much before the deadline, so a timeout among them leaves the names run time to describe what was counted. That run reads `--name-only` for at most `limit` commits; on melosys-kode-wiki (2026-11-26) it took 72–76 ms for MEL-409394's 40 commits and 142–152 ms for MEL-545776's 86. */
export const HISTORY_NAMES_RESERVE_MS = 3_000;

/** The commits whose diff changes how often `term` occurs (`git log -S`), newest first. With `wholeKey`, how often it occurs as a whole key ({@link wholeKeyCount}): see {@link wholeKeyHistory}. */
export async function historyFor(root: string, term: string, opts: TrackedOpts & { path?: string; limit?: number; wholeKey?: boolean } = {}): Promise<HistoryResult> {
  if (term === "") return { ok: false, error: "the term is empty" };
  if (term.includes("\0")) return { ok: false, error: "the term may not hold a NUL" };
  if (opts.path !== undefined && !isSafeRelPath(opts.path)) return { ok: false, error: "the path must be relative to the wiki root, without `..`" };
  // git reads the path literally (`--literal-pathspecs`): a glob would find no commit and read as «never added».
  if (opts.path !== undefined && /[*?[]/.test(opts.path)) return { ok: false, error: "path takes a file or folder path relative to the wiki root, not a glob (no *, ? or [)" };
  const git = pinned(opts.git ?? realGit);
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? HISTORY_DEFAULT_LIMIT)), HISTORY_MAX_LIMIT);
  if (opts.wholeKey) return wholeKeyHistory(root, git, term, opts.path ?? ".", limit);
  const res = await git(
    root,
    ["log", "--no-show-signature", "--no-color", "--relative", "-z", `-S${term}`, `--max-count=${limit}`, "--format=%x1e%H%x1f%aI%x1f%an%x1f%s", "--name-only", "--", opts.path ?? "."],
    { timeoutMs: HISTORY_TIMEOUT_MS },
  );
  if (!res.ok) return { ok: false, error: gitError(res, "git log") };
  return { ok: true, commits: parseHistory(res), partial: res.capped === true };
}

/** The `--name-only -z` records of a history `git log`; past the bound the possibly cut last one is dropped. */
function parseHistory(res: GitResult): HistoryCommit[] {
  const records = res.stdout.split("\x1e");
  // Past the bound the last record can stop mid file list, so it is dropped.
  if (res.capped) records.pop();
  const commits: HistoryCommit[] = [];
  for (const record of records) {
    if (!record.trim()) continue;
    const [head = "", ...rest] = record.split("\0");
    const [hash = "", date = "", author = "", subject = ""] = head.split("\x1f");
    if (!/^[0-9a-f]{7,64}$/.test(hash)) continue;
    const files = rest.map((f) => f.replace(/^\n+/, "")).filter((f) => f !== "");
    commits.push({ hash, date, author, subject: cutLine(subject), files: files.slice(0, HISTORY_FILES_SHOWN), fileCount: files.length });
  }
  return commits;
}

/** `term` for git's POSIX ERE, every metacharacter escaped. */
export const ereEscape = (s: string): string => s.replace(/[.[\]()*+?{}|^$\\]/g, "\\$&");

/**
 * The commits that change how often `key` occurs as a whole key, newest first.
 * `git log -S` counts the key as a substring (`MEL-1` inside `MEL-10`), and
 * git's pickaxe takes no PCRE, so: `-G` with a POSIX ERE that wants a byte
 * other than an ASCII letter or digit (or the line's edge) on each side picks
 * the candidates. Under git's C locale every byte of a non-ASCII letter passes
 * that test, so the candidates are a superset of the commits sought: any change
 * in the whole-key count adds or removes a line that holds the key. Each
 * candidate's patch (`-U0`, only the files `-G` matched) is counted here with
 * {@link wholeKeyCount}: a commit stays when some file's removed and added
 * lines hold the key a different number of times, which is `-S`'s rule (old
 * count against new), since unchanged lines cancel. A last `git log` reads
 * the kept commits' `--name-only` records, in log order; their `files` are
 * the ones `-G` matched.
 *
 * The candidates are listed first as bare hashes, and their patches are read
 * with `--no-walk --stdin`, so a patch past realGit's bound cuts only the run
 * it is in: the next run starts at the cut commit, and a commit cut when it is
 * the first of its run is past the bound alone and goes into `uncounted`
 * (fix round 2: one patch of 4 MB used to lose every older commit).
 *
 * All runs share one {@link HISTORY_TIMEOUT_MS} deadline. The listing and the
 * patch runs stop {@link HISTORY_NAMES_RESERVE_MS} before it; the names run
 * gets what is left, never less than that reserve. A bound never throws away
 * what was counted: a patch run that times out after a commit was read whole
 * ends the scan as `partial` with the commits counted so far, and a names run
 * that times out or is cut leaves each commit it did not describe as its bare
 * hash, `partial`. A timeout before any commit was read whole, and a git
 * failure at any step, are errors (class check, Discuss v2 PR 6: the table is
 * in `tracked-files-whole-key.test.ts`).
 */
async function wholeKeyHistory(root: string, git: GitRun, key: string, pathspec: string, limit: number): Promise<HistoryResult> {
  const deadline = Date.now() + HISTORY_TIMEOUT_MS;
  /** Time left for the listing and the patch runs; 0 or less is none. */
  const scanLeft = () => deadline - HISTORY_NAMES_RESERVE_MS - Date.now();
  const pickaxe = ["--no-show-signature", "--no-color", "--no-ext-diff", "--no-textconv", "--relative", `-G(^|[^[:alnum:]])${ereEscape(key)}([^[:alnum:]]|$)`];
  const listed = await git(root, ["log", ...pickaxe, `--max-count=${HISTORY_WHOLE_KEY_SCAN}`, "--format=%H", "--", pathspec], { timeoutMs: Math.max(1, scanLeft()) });
  if (!listed.ok) return { ok: false, error: gitError(listed, "git log") };
  // Never cut: no line bound is set, and 300 `%H` lines are at most 300 × 65
  // bytes, far under realGit's 4 MB byte bound.
  const hashes = listed.stdout.split("\n").filter((h) => /^[0-9a-f]{7,64}$/.test(h));
  // A full listing may leave out older candidates.
  let more = hashes.length >= HISTORY_WHOLE_KEY_SCAN;
  const changed: string[] = [];
  const uncounted: string[] = [];
  let read = 0;
  // Past `limit` changed commits the answer is `partial` whatever the rest hold.
  for (let i = 0; i < hashes.length && changed.length <= limit; ) {
    const batch = hashes.slice(i);
    const budget = scanLeft();
    // No scan time left is a run that timed out before it read anything.
    const run: GitResult =
      budget <= 0
        ? { ok: false, stdout: "", timedOut: true }
        : await git(root, ["log", "--no-walk=unsorted", "--stdin", ...pickaxe, "-p", "--unified=0", "--format=%x1e%H", "--", pathspec], {
            timeoutMs: budget,
            stdin: `${batch.join("\n")}\n`,
          });
    if (!run.ok && !run.timedOut) return { ok: false, error: gitError(run, "git log") };
    const cut = run.capped === true || run.timedOut === true;
    const got = wholeKeyChanges(run.stdout, key, cut);
    changed.push(...got.changed);
    read += got.read.length;
    if (!cut) break;
    if (run.timedOut) {
      if (read === 0) return { ok: false, error: gitError(run, "git log") };
      more = true;
      break;
    }
    // Capped: the run stopped inside the commit after the last one read whole.
    const last = got.read.length ? batch.indexOf(got.read.at(-1)!) : -1;
    if (got.read.length && (last < 0 || last + 1 >= batch.length)) {
      // The output's headers do not line up with the list: stop rather than guess.
      more = true;
      break;
    }
    if (last < 0) {
      // Cut while it was the first of its run: its patch alone is past the bound.
      uncounted.push(batch[0]!);
      i += 1;
    } else i += last + 1;
  }
  const out = (commits: HistoryCommit[], namesCut: boolean): HistoryResult => ({
    ok: true,
    commits,
    partial: more || uncounted.length > 0 || namesCut || changed.length > limit,
    ...(uncounted.length ? { uncounted } : {}),
  });
  const kept = changed.slice(0, limit);
  if (kept.length === 0) return out([], false);
  const names = await git(root, ["log", "--no-walk=unsorted", "--stdin", ...pickaxe, "-z", "--format=%x1e%H%x1f%aI%x1f%an%x1f%s", "--name-only", "--", pathspec], {
    timeoutMs: Math.max(HISTORY_NAMES_RESERVE_MS, deadline - Date.now()),
    stdin: `${kept.join("\n")}\n`,
  });
  if (!names.ok && !names.timedOut) return { ok: false, error: gitError(names, "git log") };
  // A timed-out run can stop mid record, as a cut one can: its last is dropped.
  const byHash = new Map(parseHistory({ ...names, capped: names.capped === true || names.timedOut === true }).map((c) => [c.hash, c]));
  const commits = kept.map((hash) => byHash.get(hash) ?? { hash, date: "", author: "", subject: "", files: [], fileCount: 0 });
  return out(
    commits,
    kept.some((h) => !byHash.has(h)),
  );
}

/** The commits, in log order, of a `-p -U0 --format=%x1e%H` log whose patch changes some file's whole-key count, and the commits it read whole. A line that starts with RS is a commit header: a patch line starts with a diff character. When `cut`, the last commit may be cut and is not read. */
function wholeKeyChanges(stdout: string, key: string, cut: boolean): { changed: string[]; read: string[] } {
  const changed: string[] = [];
  const read: string[] = [];
  let hash: string | null = null;
  let hit = false;
  let file: { removed: number; added: number; inHunk: boolean } | null = null;
  const endFile = () => {
    if (file && file.removed !== file.added) hit = true;
    file = null;
  };
  const endCommit = () => {
    endFile();
    if (hash) read.push(hash);
    if (hash && hit) changed.push(hash);
    hash = null;
    hit = false;
  };
  for (const line of stdout.split("\n")) {
    if (line.startsWith("\x1e")) {
      endCommit();
      hash = line.slice(1).trim();
    } else if (line.startsWith("diff --git ")) {
      endFile();
      file = { removed: 0, added: 0, inHunk: false };
    } else if (!file) continue;
    else if (line.startsWith("@@")) file.inHunk = true;
    // Before the first hunk: `index`, `---`, `+++`, mode and rename lines.
    else if (!file.inHunk) continue;
    else if (line.startsWith("+")) file.added += wholeKeyCount(line.slice(1), key);
    else if (line.startsWith("-")) file.removed += wholeKeyCount(line.slice(1), key);
  }
  if (cut) hash = null;
  endCommit();
  return { changed, read };
}

export const READ_MAX_LINES = 2_000;
export const READ_MAX_BYTES = 256 * 1024;
/** A file larger than this is not read at all. */
const READ_FILE_MAX_BYTES = 32 * 1024 * 1024;

export type ReadResult =
  | {
      ok: true;
      relPath: string;
      /** `N: text` lines, numbered from 1. */
      text: string;
      fromLine: number;
      toLine: number;
      totalLines: number;
      /** More lines follow `toLine`. */
      more: boolean;
    }
  | { ok: false; error: string };

/** Strip a leading `./` and turn `\` into `/`, so a caller's spelling meets git's. */
function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

/**
 * Read one tracked file of the wiki, numbered. Served only when the path is in
 * {@link trackedFiles}, its realpath stays under the root's realpath and no
 * part of it under the root is a symlink: that rules out `../`, any symlink,
 * `.git`, ignored and untracked files.
 */
export async function readTracked(root: string, relPath: string, opts: TrackedOpts & { offset?: number; limit?: number } = {}): Promise<ReadResult> {
  const rel = normalizeRel(relPath);
  if (!isSafeRelPath(rel)) return { ok: false, error: `not a path in this wiki: ${relPath}` };
  const listed = await trackedFiles(root, opts);
  if (!listed.ok) return listed;
  if (!listed.files.includes(rel)) return { ok: false, error: `not a tracked file in this wiki: ${rel}` };
  let realRoot: string;
  let real: string;
  try {
    realRoot = await realpath(root);
    real = await realpath(path.join(root, rel));
  } catch {
    return { ok: false, error: `cannot read ${rel}: it does not exist on disk` };
  }
  if (!real.startsWith(realRoot + path.sep)) return { ok: false, error: `not a path in this wiki: ${rel} leads outside it` };
  // A link that stays inside can still reach an ignored file or `.git`, so no part under the root may be one.
  const parts = rel.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const st = await lstat(path.join(root, ...parts.slice(0, i))).catch(() => null);
    if (!st) return { ok: false, error: `cannot read ${rel}: it does not exist on disk` };
    if (st.isSymbolicLink()) return { ok: false, error: `not served: ${parts.slice(0, i).join("/")} is a symlink` };
  }
  const st = await stat(real).catch(() => null);
  if (!st?.isFile()) return { ok: false, error: `not a file: ${rel}` };
  if (st.size > READ_FILE_MAX_BYTES) return { ok: false, error: `${rel} is ${st.size} bytes, too large to read` };
  const bytes = new Uint8Array(await Bun.file(real).arrayBuffer());
  if (bytes.subarray(0, 8000).includes(0)) return { ok: false, error: `${rel} is a binary file` };
  const lines = new TextDecoder().decode(bytes).split("\n");
  // A last newline ends a line rather than opening one, and an empty file has none.
  if (lines[lines.length - 1] === "") lines.pop();
  const totalLines = lines.length;
  const fromLine = Math.max(1, Math.floor(opts.offset ?? 1));
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? READ_MAX_LINES)), READ_MAX_LINES);
  const out: string[] = [];
  let size = 0;
  let n = fromLine;
  for (; n <= totalLines && n < fromLine + limit; n++) {
    const line = `${n}: ${lines[n - 1]!.replace(/\r$/, "")}`;
    const b = Buffer.byteLength(line) + 1;
    if (out.length > 0 && size + b > READ_MAX_BYTES) break;
    out.push(b > READ_MAX_BYTES ? line.slice(0, READ_MAX_BYTES / 4) + "…" : line);
    size += b;
  }
  const toLine = n - 1;
  return { ok: true, relPath: rel, text: out.join("\n"), fromLine, toLine, totalLines, more: toLine < totalLines };
}
