/**
 * Wiki bucket mirror — keeps a local copy of a GCS bucket (or a prefix of one)
 * under the process's temp space, and serves it as a read-only wiki root.
 *
 * One curator uploads pages (`gcloud storage cp page.mdx gs://<bucket>/plans/`);
 * each mirror polls the bucket's JSON API, downloads objects whose `generation`
 * changed, deletes files whose objects are gone and busts the wiki index. A
 * restart starts from whatever the directory holds (empty in a pod) and fills
 * on the first poll.
 *
 * The mirror DELETES files, so its root is guarded before the first poll (see
 * `BucketMirror.prepare`): inside `os.tmpdir()`, registered as a wiki, listed in
 * `WIKI_READONLY_ROOTS` by the enforcement predicate itself, either empty or
 * carrying the mirror's own marker naming the same source, and locked against a
 * second process. Every poll re-verifies the root before it writes or deletes. A
 * failed or empty listing never deletes anything.
 */
import path from "node:path";
import os from "node:os";
import { closeSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rmdir, unlink, utimes, writeFile } from "node:fs/promises";
import { getLog } from "../logging.ts";
import {
  GCS_DEFAULT_BASE,
  type WikiBucketMirrorConfig,
  type WikiBucketMirrorEntry,
} from "../config.ts";
import { adcTokens, type GcpTokenProvider } from "../gcp/access-token.ts";
import { readBounded, readBoundedBytes } from "../utils/bounded-fetch.ts";
import { isReadonlyWikiRoot } from "./readonly.ts";
import { findWikiByRoot, getWikiRegistry } from "./registry-memo.ts";
import { getWikiIndex } from "./store.ts";

const log = getLog("wiki", "bucket-mirror");

/** Marks a directory as the mirror's own and names its source; a non-empty dir
 *  without it, or with it naming another source, is refused. */
export const MIRROR_MARKER = ".bucket-mirror";
/** One writer per root: `O_EXCL`-created, holding the owner's pid. */
export const MIRROR_LOCK = ".bucket-mirror.lock";
/** Per-object cap on the bytes actually read (decoded), enforced while streaming.
 *  2 MB: the largest pages measured 2026-09-29 are 0.80 MB (melosys-kode-wiki)
 *  and 1.26 MB (mimir `log.md`), and reading up to the cap grew RSS ~4× the cap
 *  until the next GC (5 MB measured 21.7–28.5 MB against an inflating object). */
export const MAX_OBJECT_BYTES = 2 * 1024 * 1024;
/** Object-count cap; a listing past it is refused whole (no downloads, no deletes). */
export const MAX_OBJECTS = 2000;
/** Cap on one list page's JSON (at most 1000 items of a few hundred bytes each). */
const MAX_LIST_PAGE_BYTES = 8 * 1024 * 1024;
/** Cap on an error body read for the log line. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;
/** The only hidden file admitted, and only at the root. */
const READER_CONFIG = ".wiki-reader.json";
/** Pages only: no route serves wiki images, so an image would be unreachable bytes. */
const ALLOWED_EXTENSIONS = new Set([".md", ".mdx", ".html"]);
/** Temp files for the atomic write — hidden, so the wiki scan skips them. */
const TMP_INFIX = ".bmtmp-";
/** `.` + name + `.bmtmp-` + a 36-char UUID: the temp name is the segment plus 44 bytes. */
const TMP_AFFIX_BYTES = 1 + TMP_INFIX.length + 36;
/** 211 bytes: 255 (NAME_MAX) minus the temp affix, so the temp file fits too. */
export const MAX_SEGMENT_BYTES = 255 - TMP_AFFIX_BYTES;
const LIST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** Backoff ceiling: a recovered bucket is picked up within the 5-minute acceptance. */
const MAX_BACKOFF_MS = 5 * 60_000;

/** C0, DEL, C1, the Unicode line/paragraph separators and the bidi overrides. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/** An object name as it may appear in a log line: quoted and escaped, so a name
 *  carrying `\n` cannot forge a line in the pod's log aggregator. */
function logName(name: string): string {
  return JSON.stringify(name).replace(/[\u0080-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ── Object name → local relPath ──────────────────────────────────

/** `quiet`: an expected non-page (a folder placeholder) — logged at debug. */
export type RelPathResult = { relPath: string } | { refused: string; quiet?: boolean };

/** Validate a path RELATIVE to the mirror root. Shared by the listing and the
 *  on-disk manifest rebuild, so both admit exactly the same set. */
export function validateMirrorRelPath(rel: string): RelPathResult {
  if (rel === "") return { refused: "empty name (the prefix itself)", quiet: true };
  if (rel.endsWith("/")) return { refused: "folder placeholder", quiet: true };
  if (rel.startsWith("/")) return { refused: "absolute name" };
  if (rel.includes("\\")) return { refused: "backslash in name" };
  if (CONTROL_CHARS.test(rel)) return { refused: "control character in name" };
  const segments = rel.split("/");
  for (const seg of segments) {
    if (seg === "") return { refused: "empty path segment" };
    if (seg === "." || seg === "..") return { refused: "'.' or '..' segment" };
    if (Buffer.byteLength(seg) > MAX_SEGMENT_BYTES) {
      return { refused: `path segment longer than ${MAX_SEGMENT_BYTES} bytes` };
    }
  }
  if (rel === READER_CONFIG) return { relPath: rel };
  if (segments.some((s) => s.startsWith("."))) return { refused: "hidden path segment" };
  const ext = path.posix.extname(rel).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) return { refused: `extension "${ext || "(none)"}" not allowed` };
  return { relPath: rel };
}

/** Map a GCS object name under `prefix` to a local relPath, or refuse it. */
export function objectRelPath(name: string, prefix: string): RelPathResult {
  if (!name.startsWith(prefix)) return { refused: "outside the prefix" };
  return validateMirrorRelPath(name.slice(prefix.length));
}

/** Two names a case-insensitive, normalization-insensitive filesystem (APFS)
 *  stores as ONE file share this key. */
function foldKey(rel: string): string {
  return rel.normalize("NFC").toLowerCase();
}

// ── Root safety ──────────────────────────────────────────────────

/** Symlink-resolve `p` through its deepest EXISTING ancestor, so a root that
 *  does not exist yet still resolves (`/tmp/x` → `/private/tmp/x` on macOS). */
export function resolveThroughAncestors(p: string): string {
  const abs = path.resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** The location rule: absolute, strictly inside tmpdir after symlink resolution.
 *  Returns the symlink-resolved root to operate on, or a refusal reason. */
export function checkMirrorRoot(root: string, tmpDir: string = os.tmpdir()): { realRoot: string } | { refused: string } {
  if (!path.isAbsolute(root)) return { refused: "root is not absolute" };
  const realRoot = resolveThroughAncestors(root);
  const realTmp = resolveThroughAncestors(tmpDir);
  if (realRoot === path.parse(realRoot).root) return { refused: "root is the filesystem root" };
  if (realRoot === realTmp) return { refused: "root is the temp directory itself" };
  if (!realRoot.startsWith(realTmp + path.sep)) {
    return { refused: `root is outside the temp directory (${realTmp})` };
  }
  return { realRoot };
}

/**
 * Two entries whose roots resolve to the same directory, or one inside the
 * other, would adopt and delete each other's files. Keep the first of any such
 * pair and refuse the rest. Compared case- and NFC-folded as well, which
 * over-refuses on a case-sensitive filesystem — refusing is the safe direction.
 */
export function refuseOverlappingMirrors(entries: WikiBucketMirrorEntry[]): {
  kept: WikiBucketMirrorEntry[];
  refused: { entry: WikiBucketMirrorEntry; reason: string }[];
} {
  const kept: { entry: WikiBucketMirrorEntry; key: string }[] = [];
  const refused: { entry: WikiBucketMirrorEntry; reason: string }[] = [];
  for (const entry of entries) {
    const key = foldKey(resolveThroughAncestors(entry.root));
    const clash = kept.find((k) => k.key === key || key.startsWith(k.key + path.sep) || k.key.startsWith(key + path.sep));
    if (clash) {
      refused.push({ entry, reason: `root is the same as, or nested with, the root of gs://${clash.entry.bucket}/${clash.entry.prefix} (${clash.entry.root})` });
      continue;
    }
    kept.push({ entry, key });
  }
  return { kept: kept.map((k) => k.entry), refused };
}

function markerBody(source: string): string {
  return `source: ${source}\n` +
    "This directory is owned by muninn's wiki bucket mirror (src/wiki/bucket-mirror.ts).\n" +
    "Files here are created and deleted to match that GCS source.\n";
}

/** The `source:` line of a marker, or null for a marker that names none. */
function markerSource(body: string): string | null {
  const m = /^source: (.+)$/m.exec(body);
  return m ? m[1]!.trim() : null;
}

export type LockResult = { ok: true } | { heldBy: number };

/**
 * Create or adopt the root. A missing or EMPTY directory is created/claimed and
 * marked; a directory marked for the same source (or for none) is adopted; a
 * directory marked for another source, or non-empty without a marker, is
 * refused. `lock` runs after the ownership check and before the walk, whose
 * temp-file cleanup would otherwise unlink another process's in-flight write.
 * Returns the relPaths already on disk that the mirror may manage.
 */
export async function prepareMirrorRoot(
  realRoot: string,
  source: string,
  lock: () => LockResult = () => ({ ok: true }),
): Promise<{ files: string[] } | { refused: string } | { heldBy: number }> {
  let st;
  try {
    st = await lstat(realRoot);
  } catch {
    st = null;
  }
  if (st && (st.isSymbolicLink() || !st.isDirectory())) return { refused: "root exists and is not a plain directory" };
  if (!st) await mkdir(realRoot, { recursive: true });
  const entries = st ? await readdir(realRoot) : [];
  const markerPath = path.join(realRoot, MIRROR_MARKER);
  if (!entries.includes(MIRROR_MARKER)) {
    if (entries.length > 0) return { refused: `root is not empty and has no ${MIRROR_MARKER} marker` };
    await writeFile(markerPath, markerBody(source));
  } else {
    const named = markerSource(await readFile(markerPath, "utf8"));
    if (named !== null && named !== source) return { refused: `root is marked for ${logName(named)}, not this source` };
    if (named === null) await writeFile(markerPath, markerBody(source));
  }
  const locked = lock();
  if ("heldBy" in locked) return locked;
  const files: string[] = [];
  await walk(realRoot, "", files);
  return { files };
}

/** Collect managed files; delete leftover temp files; never follow symlinks. */
async function walk(realRoot: string, relDir: string, out: string[]): Promise<void> {
  const abs = relDir ? path.join(realRoot, relDir) : realRoot;
  for (const ent of await readdir(abs, { withFileTypes: true })) {
    const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) {
      if (!ent.name.startsWith(".")) await walk(realRoot, rel, out);
      continue;
    }
    if (!ent.isFile()) continue;
    if (ent.name.startsWith(".") && ent.name.includes(TMP_INFIX)) {
      await unlink(path.join(realRoot, rel)).catch(() => {});
      continue;
    }
    if ("relPath" in validateMirrorRelPath(rel)) out.push(rel);
  }
}

// ── The root lock ────────────────────────────────────────────────

/** Roots whose lock a live `BucketMirror` in THIS process holds — the lock file
 *  carries only a pid, which cannot tell two mirrors of one process apart. */
const heldInProcess = new Set<string>();

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockPid(lockPath: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Take the root's lock. A lock whose pid is gone — or is this process's own pid
 * without a live mirror here holding it (a container restart reuses pids) — is
 * stale and reclaimed. The reclaim can race another reclaimer; the per-poll
 * {@link BucketMirror} root check re-reads the pid, so the loser stops there.
 */
export function acquireRootLock(realRoot: string): LockResult {
  const lockPath = path.join(realRoot, MIRROR_LOCK);
  if (heldInProcess.has(realRoot)) return { heldBy: process.pid };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o644);
      try {
        writeSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      heldInProcess.add(realRoot);
      return { ok: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const pid = readLockPid(lockPath);
    if (pid !== null && pid !== process.pid && pidAlive(pid)) return { heldBy: pid };
    try {
      unlinkSync(lockPath);
    } catch {
      // Someone else removed it first — retry the create.
    }
  }
  return { heldBy: readLockPid(lockPath) ?? -1 };
}

function releaseRootLock(realRoot: string): void {
  if (!heldInProcess.delete(realRoot)) return;
  const lockPath = path.join(realRoot, MIRROR_LOCK);
  if (readLockPid(lockPath) === process.pid) {
    try {
      unlinkSync(lockPath);
    } catch {
      // Already gone.
    }
  }
}

// ── File operations ──────────────────────────────────────────────

/** mkdir -p `relDir` under the root, refusing any existing segment that is a
 *  symlink or not a directory — a planted symlink must not redirect a write. */
async function ensureDir(realRoot: string, relDir: string): Promise<void> {
  let cur = realRoot;
  for (const seg of relDir.split("/").filter(Boolean)) {
    cur = path.join(cur, seg);
    let st;
    try {
      st = await lstat(cur);
    } catch {
      await mkdir(cur);
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${cur} is not a plain directory`);
  }
}

/** Write `bytes` to `relPath` atomically: temp file in the same dir + rename.
 *  `mtimeMs` (the object's upload time) is set on the temp file, so the page
 *  never shows the download time. */
export async function atomicWrite(realRoot: string, relPath: string, bytes: Uint8Array, mtimeMs?: number): Promise<void> {
  const dir = path.posix.dirname(relPath);
  await ensureDir(realRoot, dir === "." ? "" : dir);
  const final = path.join(realRoot, relPath);
  const tmp = path.join(path.dirname(final), `.${path.basename(final)}${TMP_INFIX}${crypto.randomUUID()}`);
  try {
    await writeFile(tmp, bytes);
    if (mtimeMs !== undefined) await utimes(tmp, mtimeMs / 1000, mtimeMs / 1000);
    await rename(tmp, final);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Refuse any existing parent of `relPath` that is a symlink or not a directory.
 *  Returns false when a parent is missing (the file is gone already). */
async function plainParents(realRoot: string, relPath: string): Promise<boolean> {
  let cur = realRoot;
  for (const seg of path.posix.dirname(relPath).split("/").filter((s) => s && s !== ".")) {
    cur = path.join(cur, seg);
    const st = await lstat(cur).catch(() => null);
    if (!st) return false;
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${cur} is not a plain directory`);
  }
  return true;
}

/** Are these two relPaths one file on disk (a case/normalization alias)? */
async function sameFile(realRoot: string, a: string, b: string): Promise<boolean> {
  if (!(await plainParents(realRoot, a)) || !(await plainParents(realRoot, b))) return false;
  const [sa, sb] = await Promise.all([
    lstat(path.join(realRoot, a)).catch(() => null),
    lstat(path.join(realRoot, b)).catch(() => null),
  ]);
  return !!sa && !!sb && sa.dev === sb.dev && sa.ino === sb.ino;
}

/** Delete one managed file (only a regular file) and prune emptied parent dirs. */
async function removeManaged(realRoot: string, relPath: string): Promise<void> {
  // A symlinked parent would point the unlink outside the root.
  if (!(await plainParents(realRoot, relPath))) return;
  const abs = path.join(realRoot, relPath);
  try {
    const st = await lstat(abs);
    if (st.isFile()) await unlink(abs);
  } catch {
    // Already gone.
  }
  let dir = path.posix.dirname(relPath);
  while (dir !== "." && dir !== "") {
    try {
      await rmdir(path.join(realRoot, dir)); // fails (ENOTEMPTY) when not empty — that ends the prune
    } catch {
      break;
    }
    dir = path.posix.dirname(dir);
  }
}

// ── GCS ──────────────────────────────────────────────────────────

interface GcsObject {
  name: string;
  generation: string;
  size: number;
  /** RFC 3339 upload time of this generation. */
  updated?: string;
}

export class GcsHttpError extends Error {
  constructor(readonly status: number, what: string, body: string) {
    // GCS answers `{"error":{"message":…}}` pretty-printed; keep the log line one line.
    let detail = body;
    try {
      const msg = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message;
      if (typeof msg === "string") detail = msg;
    } catch {
      // Not JSON — use the text as is.
    }
    detail = detail.replace(/\s+/g, " ").replace(new RegExp(CONTROL_CHARS.source, "g"), "?").trim().slice(0, 200);
    super(`${what} answered ${status}${detail ? `: ${detail}` : ""}`);
  }
}

/** Sends a bearer token, or none. Returned per call so a 401 can invalidate. */
export interface TokenSource {
  acquire(): Promise<{ token: string; generation: number } | null>;
  invalidate(generation: number): void;
}

/** ADC for the real Google host; no token at all for any other base — a test
 *  base must never receive the process's Google credential. */
export function tokenSourceFor(gcsBase: string, provider: GcpTokenProvider): TokenSource {
  if (gcsBase !== GCS_DEFAULT_BASE) return { acquire: async () => null, invalidate: () => {} };
  return { acquire: () => provider.acquire(), invalidate: (g) => provider.invalidate(g) };
}

/** Delay before the next poll after `failures` consecutive failures. */
export function backoffDelayMs(intervalMs: number, failures: number): number {
  if (failures <= 0) return intervalMs;
  return Math.min(intervalMs * 2 ** Math.min(failures, 20), Math.max(intervalMs, MAX_BACKOFF_MS));
}

// ── The mirror ───────────────────────────────────────────────────

export interface PollResult {
  listed: number;
  downloaded: number;
  deleted: number;
  skipped: number;
  failed: number;
  /** The wiki index was rebuilt this poll (after changes, or a refresh owed). */
  refreshed: boolean;
  /** The rebuild failed; it is retried on every poll until one succeeds. */
  refreshError?: string;
  /** The listing would have deleted every mirrored file and written none. */
  massDeleteRefused?: boolean;
}

export interface BucketMirrorDeps {
  gcsBase: string;
  intervalMs: number;
  tokens: TokenSource;
  tmpDir?: string;
  /** The registered wiki root this mirror's root is, as the registry spells it
   *  (the store caches by that string), or undefined when none is. */
  registeredWikiRoot?: (root: string) => string | undefined;
  /** The `WIKI_READONLY_ROOTS` enforcement predicate. */
  isReadonlyRoot?: (root: string) => boolean;
  /** Busts the wiki index after a changed poll. */
  refreshIndex?: (root: string) => Promise<unknown>;
}

class RootLostError extends Error {}

export class BucketMirror {
  /** relPath → generation last written ("" = on disk, generation unknown). */
  readonly manifest = new Map<string, string>();
  #realRoot: string | null = null;
  #wikiRoot: string | null = null;
  #state: "new" | "ready" | "refused" = "new";
  #timer: ReturnType<typeof setTimeout> | null = null;
  #current: Promise<void> | null = null;
  #stopped = false;
  #abort = new AbortController();
  #failures = 0;
  #lastError: string | null = null;
  #refreshOwed = false;
  #lastGuardWarn: string | null = null;
  /** Per-object warnings already emitted (name + generation + reason), pruned
   *  to the names in the latest listing. */
  #warnedObjects = new Set<string>();

  constructor(readonly entry: WikiBucketMirrorEntry, private readonly deps: BucketMirrorDeps) {}

  get source(): string {
    return `gs://${this.entry.bucket}/${this.entry.prefix}`;
  }

  get state(): "new" | "ready" | "refused" {
    return this.#state;
  }

  #refuse(reason: string): false {
    this.#state = "refused";
    if (this.#realRoot) releaseRootLock(this.#realRoot);
    log.warn("Wiki bucket mirror {source} → {root} refused: {reason}", {
      source: this.source, root: this.entry.root, reason,
    });
    return false;
  }

  /** Apply the safety rules and claim the root. Idempotent once ready or refused;
   *  a root locked by another live process stays "new" and throws, so a later
   *  poll can take it over. */
  async prepare(): Promise<boolean> {
    if (this.#state !== "new") return this.#state === "ready";
    const checked = checkMirrorRoot(this.entry.root, this.deps.tmpDir);
    if ("refused" in checked) return this.#refuse(checked.refused);
    // The registry and read-only predicates compare realpaths, which only hold
    // once the directory exists; creating an empty dir inside tmpdir is harmless.
    let realRoot: string;
    try {
      const st = await lstat(checked.realRoot).catch(() => null);
      if (st && (st.isSymbolicLink() || !st.isDirectory())) return this.#refuse("root exists and is not a plain directory");
      if (!st) await mkdir(checked.realRoot, { recursive: true });
      realRoot = realpathSync(checked.realRoot);
    } catch (err) {
      return this.#refuse(errorMessage(err));
    }
    if (realRoot !== checked.realRoot) return this.#refuse("root moved while it was being created");
    const wikiRoot = (this.deps.registeredWikiRoot ?? registeredWikiRoot)(this.entry.root);
    if (!wikiRoot) return this.#refuse("root is not registered as a wiki (add it to WIKI_EXTRA)");
    if (!(this.deps.isReadonlyRoot ?? isReadonlyWikiRoot)(wikiRoot)) {
      return this.#refuse("root is not listed in WIKI_READONLY_ROOTS");
    }
    let prepared;
    try {
      prepared = await prepareMirrorRoot(realRoot, this.source, () => acquireRootLock(realRoot));
    } catch (err) {
      return this.#refuse(errorMessage(err));
    }
    if ("heldBy" in prepared) {
      throw new Error(`root is locked by another live process (pid ${prepared.heldBy}); retrying`);
    }
    if ("refused" in prepared) return this.#refuse(prepared.refused);
    this.#realRoot = realRoot;
    this.#wikiRoot = wikiRoot;
    for (const rel of prepared.files) this.manifest.set(rel, "");
    this.#state = "ready";
    log.info("Wiki bucket mirror {source} → {root} ready ({files} file(s) adopted)", {
      source: this.source, root: this.entry.root, files: prepared.files.length,
    });
    return true;
  }

  /** The root must still be the directory `prepare()` claimed — not a symlink,
   *  not moved, still marked, still locked by us — or this entry stops. */
  async #verifyRoot(): Promise<void> {
    const realRoot = this.#realRoot!;
    let reason: string | null = null;
    try {
      const st = await lstat(realRoot);
      if (st.isSymbolicLink() || !st.isDirectory()) reason = "root is no longer a plain directory";
      else if (realpathSync(realRoot) !== realRoot) reason = "root now resolves to another directory";
      else if (!(await lstat(path.join(realRoot, MIRROR_MARKER)).catch(() => null))?.isFile()) reason = "marker is gone";
      else if (readLockPid(path.join(realRoot, MIRROR_LOCK)) !== process.pid) reason = "lock is no longer held by this process";
    } catch {
      reason = "root is gone";
    }
    if (reason) {
      this.#refuse(`${reason} — mirroring stopped, nothing written or deleted`);
      throw new RootLostError(reason);
    }
  }

  /** One poll. Throws on a failed listing or credential — having changed nothing. */
  async pollOnce(): Promise<PollResult> {
    if (!(await this.prepare())) throw new Error("mirror refused");
    const signal = this.#abort.signal;
    const realRoot = this.#realRoot!;
    const objects = await this.#listAll(signal);
    const result: PollResult = { listed: objects.length, downloaded: 0, deleted: 0, skipped: 0, failed: 0, refreshed: false };

    const listedNames = new Set(objects.map((o) => o.name));
    for (const key of this.#warnedObjects) {
      if (!listedNames.has(key.slice(0, key.indexOf("\u0000")))) this.#warnedObjects.delete(key);
    }

    // Validate, then drop names that collide on a case-/normalization-insensitive
    // filesystem: they would share one file, and a delete of one would unlink the
    // other's live copy. The code-unit-smallest name wins, deterministically.
    const candidates: { rel: string; obj: GcsObject }[] = [];
    for (const obj of objects) {
      const mapped = objectRelPath(obj.name, this.entry.prefix);
      if ("refused" in mapped) {
        result.skipped++;
        this.#warnObject(obj, mapped.refused, mapped.quiet);
        continue;
      }
      candidates.push({ rel: mapped.relPath, obj });
    }
    candidates.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    const byFold = new Map<string, string>();
    // Every validly-named listed object keeps its local file, even one skipped
    // below (oversized): only an object that is GONE is a delete.
    const present = new Set<string>();
    const wanted: { rel: string; obj: GcsObject }[] = [];
    for (const { rel, obj } of candidates) {
      const winner = byFold.get(foldKey(rel));
      if (winner !== undefined) {
        result.skipped++;
        this.#warnObject(obj, `collides with ${logName(winner)} on a case- or normalization-insensitive filesystem`);
        continue;
      }
      byFold.set(foldKey(rel), rel);
      present.add(rel);
      if (obj.size > MAX_OBJECT_BYTES) {
        result.skipped++;
        this.#warnObject(obj, `larger than ${MAX_OBJECT_BYTES} bytes (${obj.size})`);
        continue;
      }
      if (this.manifest.get(rel) !== obj.generation) wanted.push({ rel, obj });
    }
    const toDelete = [...this.manifest.keys()].filter((rel) => !present.has(rel));

    // A listing that would empty the wiki is far likelier a wrong prefix, an
    // `rm -r` or a proxy answering `{}` than an intended purge: keep the copy.
    if (this.manifest.size > 0 && toDelete.length === this.manifest.size && wanted.length === 0) {
      result.massDeleteRefused = true;
      const note = `${objects.length}/${this.manifest.size}`;
      if (this.#lastGuardWarn !== note) {
        this.#lastGuardWarn = note;
        log.warn(
          "Wiki bucket mirror {source}: the listing ({listed} object(s)) would delete all {files} mirrored file(s) and write none — refused, local copy kept",
          { source: this.source, listed: objects.length, files: this.manifest.size },
        );
      }
      return result;
    }
    this.#lastGuardWarn = null;

    if (wanted.length > 0) await this.#verifyRoot();
    for (const { rel, obj } of wanted) {
      signal.throwIfAborted();
      try {
        const bytes = await this.#download(obj, signal);
        signal.throwIfAborted();
        const updated = obj.updated ? Date.parse(obj.updated) : NaN;
        await atomicWrite(realRoot, rel, bytes, Number.isFinite(updated) ? updated : undefined);
        this.manifest.set(rel, obj.generation);
        result.downloaded++;
      } catch (err) {
        if (signal.aborted) throw err;
        result.failed++;
        this.#warnObject(obj, errorMessage(err));
      }
    }

    if (toDelete.length > 0) await this.#verifyRoot();
    for (const rel of toDelete) {
      signal.throwIfAborted();
      try {
        // A case-only or NFC/NFD rename: the old name is the file just written
        // under the new one. Forget it; unlinking it would delete the live page.
        const twin = byFold.get(foldKey(rel));
        if (twin !== undefined && twin !== rel && (await sameFile(realRoot, rel, twin))) {
          this.manifest.delete(rel);
          continue;
        }
        await removeManaged(realRoot, rel);
        this.manifest.delete(rel);
        result.deleted++;
      } catch (err) {
        result.failed++;
        log.warn("Wiki bucket mirror {source}: could not delete {rel}: {error}", {
          source: this.source, rel: logName(rel), error: errorMessage(err),
        });
      }
    }

    // Owed until a rebuild succeeds: the manifest is already current, so a poll
    // after a failed rebuild sees no change and would otherwise never retry it.
    if (result.downloaded + result.deleted > 0) this.#refreshOwed = true;
    if (this.#refreshOwed) {
      signal.throwIfAborted();
      try {
        await (this.deps.refreshIndex ?? ((root) => getWikiIndex({ root, refresh: true })))(this.#wikiRoot!);
        this.#refreshOwed = false;
        result.refreshed = true;
      } catch (err) {
        result.refreshError = errorMessage(err);
        log.warn("Wiki bucket mirror {source}: files updated but the wiki index rebuild failed (retried next poll): {error}", {
          source: this.source, error: result.refreshError,
        });
      }
    }
    if (result.downloaded + result.deleted > 0) {
      log.info("Wiki bucket mirror {source}: {downloaded} downloaded, {deleted} deleted, {listed} listed", {
        source: this.source, ...result,
      });
    }
    return result;
  }

  /** Start the loop: first poll now, then `intervalMs` after each finishes. */
  start(): void {
    if (this.#stopped || this.#current || this.#timer) return;
    this.#tick();
  }

  /** Abort the in-flight poll (its fetches and its next file operation), wait
   *  for it at most 5 s, and release the root lock. A file operation already
   *  running when the abort lands completes; nothing after it starts. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#abort.abort(new Error("wiki bucket mirror stopped"));
    const current = this.#current;
    if (current) await Promise.race([current.catch(() => {}), Bun.sleep(5_000)]);
    if (this.#realRoot) releaseRootLock(this.#realRoot);
  }

  #tick(): void {
    this.#timer = null;
    this.#current = this.pollOnce().then(
      () => {
        if (this.#failures > 0) log.info("Wiki bucket mirror {source} recovered", { source: this.source });
        this.#failures = 0;
        this.#lastError = null;
      },
      (err) => {
        if (this.#state === "refused" || this.#stopped) return;
        this.#failures++;
        const message = errorMessage(err);
        // Warn on a NEW error; a repeat of the same one is debug, since the
        // backoff below already spaces them out.
        if (message !== this.#lastError) {
          log.warn("Wiki bucket mirror {source} poll failed ({failures}x), local copy kept: {error}", {
            source: this.source, failures: this.#failures, error: message,
          });
        } else {
          log.debug("Wiki bucket mirror {source} poll failed again: {error}", { source: this.source, error: message });
        }
        this.#lastError = message;
      },
    ).finally(() => {
      this.#current = null;
      if (this.#stopped || this.#state === "refused") return;
      this.#timer = setTimeout(() => this.#tick(), backoffDelayMs(this.deps.intervalMs, this.#failures));
    });
  }

  #warnObject(obj: GcsObject, reason: string, quiet = false): void {
    const key = `${obj.name}\u0000${obj.generation}\u0000${reason}`;
    if (this.#warnedObjects.has(key)) return;
    this.#warnedObjects.add(key);
    const props = { source: this.source, name: logName(obj.name), reason };
    const message = "Wiki bucket mirror {source}: object {name} skipped: {reason}";
    if (quiet) log.debug(message, props);
    else log.warn(message, props);
  }

  /** GET with the bearer token; one retry with a fresh token on 401. */
  async #get(url: string, timeoutMs: number, signal: AbortSignal, headers: Record<string, string> = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const tok = await this.deps.tokens.acquire();
      const res = await fetch(url, {
        headers: tok ? { ...headers, Authorization: `Bearer ${tok.token}` } : headers,
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
      if (res.status === 401 && tok && attempt === 0) {
        await res.body?.cancel().catch(() => {});
        this.deps.tokens.invalidate(tok.generation);
        continue;
      }
      return res;
    }
  }

  async #errorBody(res: Response, what: string): Promise<string> {
    return (await readBounded(res, MAX_ERROR_BODY_BYTES, what).catch(() => "")).trim();
  }

  async #listAll(signal: AbortSignal): Promise<GcsObject[]> {
    const out: GcsObject[] = [];
    let pageToken: string | undefined;
    const what = `list gs://${this.entry.bucket}`;
    const bucketUrl = `${this.deps.gcsBase}/storage/v1/b/${encodeURIComponent(this.entry.bucket)}/o`;
    do {
      const params = new URLSearchParams({ fields: "items(name,generation,size,updated),nextPageToken" });
      if (this.entry.prefix) params.set("prefix", this.entry.prefix);
      if (pageToken) params.set("pageToken", pageToken);
      const res = await this.#get(`${bucketUrl}?${params}`, LIST_TIMEOUT_MS, signal);
      if (!res.ok) throw new GcsHttpError(res.status, what, await this.#errorBody(res, what));
      const text = await readBounded(res, MAX_LIST_PAGE_BYTES, what);
      let body: { items?: unknown; nextPageToken?: unknown };
      try {
        body = JSON.parse(text) as typeof body;
      } catch {
        throw new Error(`${what} answered 200 with a body that is not JSON`);
      }
      if (typeof body !== "object" || body === null) throw new Error(`${what} answered 200 with a non-object body`);
      const items = Array.isArray(body.items) ? body.items as { name?: unknown; generation?: unknown; size?: unknown; updated?: unknown }[] : [];
      for (const item of items) {
        if (typeof item?.name !== "string" || item.generation === undefined) continue;
        out.push({
          name: item.name,
          generation: String(item.generation),
          size: Number(item.size ?? 0),
          ...(typeof item.updated === "string" ? { updated: item.updated } : {}),
        });
      }
      if (out.length > MAX_OBJECTS) {
        throw new Error(`gs://${this.entry.bucket}/${this.entry.prefix} lists more than ${MAX_OBJECTS} objects — refusing the whole listing`);
      }
      pageToken = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : undefined;
    } while (pageToken);
    return out;
  }

  async #download(obj: GcsObject, signal: AbortSignal): Promise<Uint8Array> {
    const url = `${this.deps.gcsBase}/storage/v1/b/${encodeURIComponent(this.entry.bucket)}/o/` +
      `${encodeURIComponent(obj.name)}?alt=media&generation=${encodeURIComponent(obj.generation)}`;
    // identity: a gzip-stored object (`gcloud storage cp -Z`) is otherwise sent
    // compressed and inflated by fetch, so its declared length says nothing.
    const res = await this.#get(url, DOWNLOAD_TIMEOUT_MS, signal, { "Accept-Encoding": "identity" });
    if (!res.ok) throw new GcsHttpError(res.status, "download", await this.#errorBody(res, "download"));
    return await readBoundedBytes(res, MAX_OBJECT_BYTES, "download");
  }
}

/** The registry's spelling of the wiki whose root is `root` (realpath-aware). */
function registeredWikiRoot(root: string): string | undefined {
  return findWikiByRoot(getWikiRegistry(), root)?.root;
}

/** Boot entry: one mirror per configured entry, one process-wide ADC token cache. */
export function startWikiBucketMirrors(
  config: WikiBucketMirrorConfig,
  deps: Partial<Pick<BucketMirrorDeps, "tmpDir" | "registeredWikiRoot" | "isReadonlyRoot" | "refreshIndex">> & { autostart?: boolean } = {},
): { mirrors: BucketMirror[]; stop(): Promise<void> } {
  for (const { entry, reason } of config.refused) {
    log.warn("WIKI_BUCKET_MIRRORS entry {entry} refused: {reason}", { entry: logName(entry), reason });
  }
  if (config.intervalRefused) {
    log.warn("WIKI_BUCKET_MIRROR_INTERVAL_MS={value} ignored: {reason}", {
      value: logName(config.intervalRefused.value), reason: config.intervalRefused.reason,
    });
  }
  const { kept, refused } = refuseOverlappingMirrors(config.mirrors);
  for (const { entry, reason } of refused) {
    log.warn("Wiki bucket mirror gs://{bucket}/{prefix} → {root} refused: {reason}", { ...entry, reason });
  }
  const tokens = tokenSourceFor(config.gcsBase, adcTokens);
  const { autostart = true, ...mirrorDeps } = deps;
  const mirrors = kept.map((entry) =>
    new BucketMirror(entry, { gcsBase: config.gcsBase, intervalMs: config.intervalMs, tokens, ...mirrorDeps }));
  if (autostart) for (const m of mirrors) m.start();
  if (mirrors.length > 0) {
    log.info("Wiki bucket mirrors started: {count}, every {intervalMs} ms from {base}", {
      count: mirrors.length, intervalMs: config.intervalMs, base: config.gcsBase,
    });
  }
  return { mirrors, stop: async () => { await Promise.all(mirrors.map((m) => m.stop())); } };
}
