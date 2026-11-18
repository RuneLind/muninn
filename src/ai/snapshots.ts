/**
 * Read-only snapshots for the `{ readSearch }` tool surface: the directories a
 * read-and-search run is given instead of a live checkout.
 *
 * A fence can allow or refuse a tool call by its input; it cannot filter what
 * a search prints, so a run pointed at a checkout could still Grep a line out
 * of `.env`. A snapshot holds only what may be read:
 *
 *  - a code repo ({@link codeSnapshot}): `git archive` of `origin/<default
 *    branch>` (the ref the decision triage resolves), keyed by repo and commit,
 *    so `.git/`, `.env` and every untracked or ignored file are absent by
 *    construction, and a moved commit gets a new snapshot;
 *  - a wiki ({@link wikiSnapshot}): the working tree's files that git does not
 *    ignore (`git ls-files -co --exclude-standard`, which takes no status lock),
 *    minus the wiki's own write artifacts, keyed by content, so a changed tree
 *    gets a new copy and a copy another turn reads is never replaced in place.
 *
 * A code snapshot drops the symlinks that leave it; a wiki snapshot copies
 * only regular files reached through no symlink at all ({@link wikiSourceFile}). Snapshots live in their own bucket of the agent home ({@link snapshotRootDir}), a sibling of the fenced
 * working directory, so a run can read one only when it names it. A snapshot
 * is removed by {@link sweepSnapshots} once no turn has used it for
 * {@link SNAPSHOT_IDLE_MS}; {@link startSnapshotSweeper} runs that at boot and
 * then periodically.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  copyFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { snapshotRootDir } from "./agent-cwd.ts";
import { defaultBranch, realGit, type GitRun } from "../wiki/decision-triage/git.ts";
import { isWikiWriteArtifact } from "../wiki/lockfile.ts";
import { runProc } from "../utils/run-proc.ts";
import { getLog } from "../logging.ts";

const log = getLog("ai", "snapshots");

/** A snapshot unused for this long is removed by the next sweep. */
export const SNAPSHOT_IDLE_MS = 60 * 60 * 1000;
/** A half-built snapshot (`.tmp-*`) older than this is a crashed build. */
export const SNAPSHOT_TMP_STALE_MS = 15 * 60 * 1000;
/** How often the sweeper runs after its boot pass. */
export const SNAPSHOT_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
/** A wiki larger than this is refused rather than copied on every turn. */
export const WIKI_SNAPSHOT_MAX_FILES = 50_000;
export const WIKI_SNAPSHOT_MAX_BYTES = 1024 * 1024 * 1024;
const ARCHIVE_TIMEOUT_MS = 120_000;

export interface Snapshot {
  kind: "code" | "wiki";
  /** The directory a `{ readSearch }` surface names. */
  dir: string;
  /** Its name in the snapshot directory: the repo and commit, or the wiki and a content hash. */
  key: string;
  /** The source it was taken from (the repo's top level, or the wiki directory). */
  source: string;
  /** Code snapshots only: the commit archived and its branch. */
  commit?: string;
  branch?: string;
}

export interface SnapshotOptions {
  /** The snapshot directory; defaults to {@link snapshotRootDir}. */
  root?: string;
  /** The git runner; defaults to the decision triage's allowlisted one. */
  git?: GitRun;
  /** Wiki snapshots: the byte and file-count limits; default {@link WIKI_SNAPSHOT_MAX_BYTES} and {@link WIKI_SNAPSHOT_MAX_FILES}. */
  maxBytes?: number;
  maxFiles?: number;
}

/** In-process leases: a leased snapshot is never swept, whatever its age. */
const leases = new Map<string, number>();
/** One build per key at a time. */
const inflight = new Map<string, Promise<Snapshot>>();

function rootOf(opts: SnapshotOptions): string {
  const root = opts.root ?? snapshotRootDir();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function shortHash(text: string, n = 8): string {
  return createHash("sha256").update(text).digest("hex").slice(0, n);
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^\.+/, "_").slice(0, 60) || "_";
}

/** Mark a snapshot used now: its directory's mtime is the "last used" clock the sweep reads. */
export function touchSnapshot(dir: string): void {
  const now = new Date();
  try {
    utimesSync(dir, now, now);
  } catch {
    /* swept or never built: the next use rebuilds it */
  }
}

/**
 * Hold a snapshot for a turn: it is marked used now and never swept while
 * held. The returned function releases it and marks it used again, so the
 * idle hour counts from the end of the turn.
 */
export function leaseSnapshot(snapshot: Pick<Snapshot, "dir">): () => void {
  const dir = snapshot.dir;
  leases.set(dir, (leases.get(dir) ?? 0) + 1);
  touchSnapshot(dir);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (leases.get(dir) ?? 1) - 1;
    if (n <= 0) leases.delete(dir);
    else leases.set(dir, n);
    touchSnapshot(dir);
  };
}

/** Whether `path`, lexically, is `root` or inside it. */
function lexicallyInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Remove every symlink under `root` that could lead out of it: an absolute
 * target, a relative one that climbs out, and (after that pass) any link whose
 * real path is not inside the real root, a dangling link included. Returns how
 * many were removed.
 */
export function dropEscapingLinks(root: string): number {
  const links: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) links.push(path);
      else if (entry.isDirectory()) walk(path);
    }
  };
  walk(root);
  let removed = 0;
  const kept: string[] = [];
  for (const link of links) {
    const target = readlinkSync(link);
    if (isAbsolute(target) || !lexicallyInside(resolve(dirname(link), target), root)) {
      unlinkSync(link);
      removed++;
    } else {
      kept.push(link);
    }
  }
  const realRoot = realpathSync(root);
  for (const link of kept) {
    let real: string | null;
    try {
      real = realpathSync(link);
    } catch {
      real = null;
    }
    if (real === null || !(real === realRoot || real.startsWith(realRoot + sep))) {
      unlinkSync(link);
      removed++;
    }
  }
  return removed;
}

/** Move a finished build into place; a concurrent build that got there first wins and this one is discarded. */
function publish(tmp: string, dir: string): void {
  try {
    renameSync(tmp, dir);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    if (!existsSync(dir)) throw err;
  }
}

function singleFlight(key: string, build: () => Promise<Snapshot>): Promise<Snapshot> {
  const running = inflight.get(key);
  if (running) return running;
  const p = build().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function repoTop(dir: string, git: GitRun): Promise<string> {
  const res = await git(dir, ["rev-parse", "--show-toplevel"]);
  if (!res.ok || res.capped) throw new Error(`snapshot: ${dir} is not inside a git repository.`);
  return realpathSync(res.stdout.trim());
}

/**
 * The snapshot of a code repo: the tracked files of `origin/<default branch>`
 * as last fetched, extracted with `git archive`. Reused while that commit is
 * the branch's tip; a moved tip builds a new one beside it.
 */
export async function codeSnapshot(repoDir: string, opts: SnapshotOptions = {}): Promise<Snapshot> {
  const git = opts.git ?? realGit;
  const top = await repoTop(repoDir, git);
  const branch = await defaultBranch(top, git);
  if (!branch) throw new Error(`snapshot: ${top} has no origin default branch.`);
  const rev = await git(top, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}^{commit}`]);
  const commit = rev.stdout.trim();
  if (!rev.ok || !/^[0-9a-f]{40,64}$/.test(commit)) throw new Error(`snapshot: cannot resolve origin/${branch} in ${top}.`);
  const root = rootOf(opts);
  const key = `code-${safeName(basename(top))}-${shortHash(top)}-${commit}`;
  const dir = join(root, key);
  const snapshot: Snapshot = { kind: "code", dir, key, source: top, commit, branch };
  if (existsSync(dir)) {
    touchSnapshot(dir);
    return snapshot;
  }
  return singleFlight(key, async () => {
    if (existsSync(dir)) return snapshot;
    const tmp = join(root, `.tmp-${randomUUID()}`);
    const tar = `${tmp}.tar`;
    mkdirSync(tmp, { mode: 0o700 });
    try {
      const archive = await runProc(["git", "-C", top, "archive", "--format=tar", "-o", tar, commit], ARCHIVE_TIMEOUT_MS, "snapshot git archive", { processGroup: true });
      if (archive.exitCode !== 0) throw new Error(`snapshot: git archive failed in ${top}: ${archive.stderr.trim().slice(0, 200)}`);
      const untar = await runProc(["tar", "-xf", tar, "-C", tmp], ARCHIVE_TIMEOUT_MS, "snapshot tar", { processGroup: true });
      if (untar.exitCode !== 0) throw new Error(`snapshot: extracting the archive of ${top} failed: ${untar.stderr.trim().slice(0, 200)}`);
      dropEscapingLinks(tmp);
      publish(tmp, dir);
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      throw err;
    } finally {
      rmSync(tar, { force: true });
    }
    touchSnapshot(dir);
    log.info("Built code snapshot {key} from {source}", { key, source: top });
    return snapshot;
  });
}

/** The files a wiki snapshot holds, relative to the wiki directory, sorted. */
export async function wikiSnapshotFiles(wikiDir: string, git: GitRun = realGit): Promise<string[]> {
  // -z: names verbatim. An untracked nested repository is listed as `dir/`, which is skipped.
  // The global ignore rules can live under XDG_CONFIG_HOME or GIT_CONFIG_GLOBAL, which the runner's allowlist drops.
  const env: Record<string, string> = {};
  for (const name of ["XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL"] as const) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  const res = await git(wikiDir, ["ls-files", "-co", "--exclude-standard", "-z"], { env });
  if (!res.ok || res.capped || res.timedOut) {
    throw new Error(`snapshot: cannot list the files of ${wikiDir}${res.capped ? " (the listing was cut short)" : ""}.`);
  }
  const names = new Set(
    res.stdout
      .split("\0")
      .filter((p) => p !== "" && !p.endsWith("/") && !isWikiWriteArtifact(basename(p)))
      .filter((p) => !p.split("/").includes(".git")),
  );
  return [...names].sort();
}

/**
 * The size of `rel` under `base` (a real path) when it is a regular file that
 * no symlink leads to: its folder's real path must be exactly its folder under
 * `base`, so a link in any folder part (`keys` -> `~/.ssh` under a tracked
 * `keys/x`) disqualifies it, and the file itself must not be a link. Anything
 * else (gone, a link, a directory) is null and is not copied. The folder, not
 * the file, is resolved: Bun's realpath opens its argument, so an unreadable
 * file would otherwise drop out silently instead of failing its copy.
 */
function wikiSourceFile(base: string, rel: string): number | null {
  const path = join(base, rel);
  try {
    if (realpathSync(dirname(path)) !== dirname(path)) return null;
    const st = lstatSync(path);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/** The files of `files` that {@link wikiSourceFile} accepts, and their summed size; nothing is read. */
function wikiSourceFiles(base: string, files: string[]): { present: string[]; bytes: number } {
  const real = realpathSync(base);
  const present: string[] = [];
  let bytes = 0;
  for (const rel of files) {
    const size = wikiSourceFile(real, rel);
    if (size === null) continue;
    present.push(rel);
    bytes += size;
  }
  return { present, bytes };
}

/** A content hash over each of `files` under `base` that {@link wikiSourceFile} accepts: its path and bytes. */
function contentKey(base: string, files: string[]): string {
  const real = realpathSync(base);
  const h = createHash("sha256");
  for (const rel of files) {
    if (wikiSourceFile(real, rel) === null) continue;
    const data = readFileSync(join(real, rel));
    h.update(`${rel}\0${data.length}\0`).update(data).update("\n");
  }
  return h.digest("hex");
}

/**
 * The snapshot of a wiki's working tree: every file git does not ignore,
 * uncommitted edits and untracked pages included, minus the wiki's write
 * artifacts. The key is the content hash, so an unchanged tree reuses the
 * last copy and a changed one gets a new copy; a copy is never written to
 * once it is in place. The hash is taken over the copy itself, so a file
 * edited while it is being copied cannot give a copy a key it does not match.
 */
export async function wikiSnapshot(wikiDir: string, opts: SnapshotOptions = {}): Promise<Snapshot> {
  const git = opts.git ?? realGit;
  const source = realpathSync(wikiDir);
  const maxFiles = opts.maxFiles ?? WIKI_SNAPSHOT_MAX_FILES;
  const maxBytes = opts.maxBytes ?? WIKI_SNAPSHOT_MAX_BYTES;
  const files = await wikiSnapshotFiles(source, git);
  if (files.length > maxFiles) throw new Error(`snapshot: ${source} holds ${files.length} files, over ${maxFiles}.`);
  // The limits are checked on the sizes alone, before any file is read.
  const live = wikiSourceFiles(source, files);
  if (live.bytes > maxBytes) throw new Error(`snapshot: ${source} holds ${live.bytes} bytes, over ${maxBytes}.`);
  const root = rootOf(opts);
  const prefix = `wiki-${safeName(basename(source))}-${shortHash(source)}-`;
  const liveKey = prefix + contentKey(source, live.present).slice(0, 32);
  const liveDir = join(root, liveKey);
  if (existsSync(liveDir)) {
    touchSnapshot(liveDir);
    return { kind: "wiki", dir: liveDir, key: liveKey, source };
  }
  return singleFlight(liveKey, async () => {
    const tmp = join(root, `.tmp-${randomUUID()}`);
    mkdirSync(tmp, { mode: 0o700 });
    try {
      for (const rel of live.present) {
        // Checked again: a part may have become a link since it was hashed; the copy's own hash decides the key.
        if (wikiSourceFile(source, rel) === null) continue;
        const to = join(tmp, rel);
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(join(source, rel), to);
      }
      const key = prefix + contentKey(tmp, live.present).slice(0, 32);
      const dir = join(root, key);
      publish(tmp, dir);
      touchSnapshot(dir);
      log.info("Built wiki snapshot {key} from {source}", { key, source });
      return { kind: "wiki", dir, key, source } satisfies Snapshot;
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      throw err;
    }
  });
}

/**
 * Remove every snapshot unused for `idleMs` that no turn in this process
 * holds, and every half-built `.tmp-*` older than {@link SNAPSHOT_TMP_STALE_MS}.
 * Returns the names removed.
 */
export function sweepSnapshots(opts: { root?: string; idleMs?: number; now?: number } = {}): string[] {
  const root = opts.root ?? snapshotRootDir();
  const idleMs = opts.idleMs ?? SNAPSHOT_IDLE_MS;
  const now = opts.now ?? Date.now();
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of entries) {
    const path = join(root, name);
    if (leases.has(path)) continue;
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    const isTmp = name.startsWith(".tmp-");
    const limit = isTmp ? SNAPSHOT_TMP_STALE_MS : idleMs;
    if (now - mtime < limit) continue;
    if (!isTmp && !/^(code|wiki)-/.test(name)) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(name);
  }
  if (removed.length > 0) log.info("Swept {count} snapshot(s)", { count: removed.length });
  return removed;
}

/** Sweep once now (the boot sweep), then every {@link SNAPSHOT_SWEEP_INTERVAL_MS}. Returns a stop function. */
export function startSnapshotSweeper(): () => void {
  const run = () => {
    try {
      sweepSnapshots();
    } catch (err) {
      log.warn("Snapshot sweep failed: {error}", { error: err instanceof Error ? err.message : String(err) });
    }
  };
  run();
  const timer = setInterval(run, SNAPSHOT_SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
