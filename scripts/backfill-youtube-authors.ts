/**
 * One-off: add YouTube oEmbed's `author` to the `youtube-summaries` documents
 * captured before the capture started sending it (PR 3b). `author` ONLY — no
 * `upload_date`/`duration_sec`, which would need yt-dlp, and a sustained probe
 * pass is what trips YouTube's bot wall for the same host's live captures.
 *
 * Run on the machine whose huginn holds the collection, in a window with no
 * capture running. The order, each step gated on the one before:
 *
 *   bun scripts/backfill-youtube-authors.ts --dry-run
 *       Fetches oEmbed at 2 req/s for every document with no `author`, caches
 *       each answer (author AND title) per video id, prints counts and 20
 *       diffs. 400/401/403/404 are answers about the video (nonexistent,
 *       private or embed-off, login-required, deleted): cached as unavailable
 *       and never retried. Aborts after 5 consecutive OTHER failures (429,
 *       5xx, timeouts, a non-JSON body). Lists the documents whose oEmbed
 *       title shares little with their own title — a legacy `url` can name a
 *       different video — and writes them to `title-review.txt` in the state
 *       dir, which is an `--exclude` file: delete the lines you have checked
 *       and are fine, and pass the rest. The review always covers EVERY
 *       candidate, `--exclude`d or not (marked), and the script never
 *       overwrites that file: when it exists, a later dry run writes
 *       `title-review-<time>.txt` beside it and says so, so your pruned copy
 *       stays exactly as you left it.
 *   bun scripts/backfill-youtube-authors.ts --limit 20 [--exclude <file>]
 *       The pilot: tarballs the tree, writes the 20 NEWEST candidates from the
 *       cache, runs huginn's `/update` and checks `metadata.author` on each.
 *   bun scripts/backfill-youtube-authors.ts [--exclude <file>]
 *       The full write, from the cache, then `/update`. Run it at the start of a
 *       quiet day: `/update` re-reads files newer than its last indexed mtime
 *       minus a day, so for about a day every update re-embeds the collection.
 *   bun scripts/backfill-youtube-authors.ts --rollback
 *       Undoes EVERY write run, and takes no path. Each file the backfill
 *       planned to write is restored from the tarball its own run took before
 *       writing — only when its CURRENT bytes are exactly that snapshot plus
 *       the one `author:` line the run inserted. A file captured or re-run
 *       since is left alone whatever its mtime; a file deleted since is not
 *       resurrected. The restored files are re-stamped back into their
 *       original place, the newer files behind them re-stamped too, then
 *       `/update`. Every file not restored is listed with its reason, and the
 *       full per-file report goes to `rollback-report-<time>.txt`.
 *
 * `--exclude <file>`: one path relative to the root per line, `#` comments
 * allowed; the write step never touches those files. Unknown flags, stray
 * words and a value flag with no value exit 2 before anything runs.
 *
 * Writes add the key only where it is absent and never touch the body. Each
 * is atomic: a temp file in `<state-dir>/tmp/`, given its stamp, then renamed
 * over the target, so no reader sees new bytes with a "now" mtime or a
 * truncated file. Every mode refuses (exit 2, before it creates or removes
 * anything) a state dir equal to or under the root — huginn's reader indexes
 * every file there, dotfiles and `.tmp` included — a root under the state
 * dir, and a state dir on another filesystem, where the rename fails with
 * EXDEV. Every mode takes `<state-dir>/lock`; a second run on the same state
 * dir, dry run included, exits 2 naming the holder. A lock left by a killed
 * run is reported as stale with the command that removes it, never taken
 * over. Only with the lock held does a run remove any `*.author-backfill.tmp`
 * an earlier build of this script left in the root, and clear its `tmp/`.
 * A file whose mtime moved between read and write is skipped.
 * Every run re-stamps its sequence (every file from the oldest one it changes
 * onward, changed or not) with increasing mtimes 1 ms apart in original-mtime
 * order, so `/update` reads them and the collection's relative order survives.
 *
 * State, in the state dir: `lock`, `oembed-cache.json`, the per-run tarballs, and
 * `journal.jsonl` — a run's whole plan (each file's pre-backfill mtime, its
 * stamp, the author it gets) is appended BEFORE its first write, and each
 * file's outcome after it, so a run killed at any point is fully known to the
 * rollback and to the next run's original-mtime lookup.
 *
 * Flags: --root <dir> (default huginn's youtube-articles tree), --state-dir <dir>
 * (default ~/.muninn/youtube-author-backfill) — both made canonical (absolute,
 * symlinks resolved) before anything is journaled, so any cwd can roll back — --huginn <url> (default
 * KNOWLEDGE_API_URL or http://127.0.0.1:8321), --no-update (skip huginn
 * entirely), --collection <name> (default youtube-summaries).
 *
 * Exit codes: 0 done, 1 a failure (an oEmbed abort, a failed or unreadable
 * `/update`, an author mismatch after it), 2 a usage or state error.
 */
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { $ } from "bun";
import {
  assignStamps,
  insertFrontmatterAuthor,
  lastWrites,
  mtimeMsFromNs,
  nextFailureStreak,
  nfcPath,
  OEMBED_ABORT_STREAK,
  originalMtimeFor,
  originalMtimeIndex,
  parseBackfillArgs,
  parseExcludeList,
  parseJournal,
  planSequence,
  rollbackDisposition,
  titleSimilarity,
  TITLE_REVIEW_THRESHOLD,
  type JournalEvent,
  type JournalRun,
  checkStatePlacement,
  lockRefusal,
  parseLock,
  type NotRestoredReason,
  type PlannedStamp,
} from "../src/summaries/author-backfill.ts";
import { parseCaptureFrontmatter, decodeFrontmatterScalar } from "../src/summaries/transcript-split.ts";
import { extractYouTubeVideoId } from "../src/youtube/url.ts";
import { capFrontmatterAuthor, fetchYouTubeOembed, type YouTubeOembedResult } from "../src/youtube/metadata.ts";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const USAGE =
  "usage: bun scripts/backfill-youtube-authors.ts [--dry-run | --limit <n> | --rollback] " +
  "[--exclude <file>] [--root <dir>] [--state-dir <dir>] [--huginn <url>] [--collection <name>] [--no-update]";

const parsed = parseBackfillArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`${parsed.error}\n${USAGE}`);
  process.exit(2);
}
const ARGS = parsed.args;
const HUGINN = (ARGS.huginn ?? process.env.KNOWLEDGE_API_URL ?? "http://127.0.0.1:8321").replace(/\/+$/, "");
const COLLECTION = ARGS.collection ?? "youtube-summaries";
const REQUEST_SPACING_MS = 500; // 2 requests per second
/** Test hook for the interrupted-run drill: sleep this long after each file. */
const DEBUG_SLEEP_MS = Number(process.env.BACKFILL_DEBUG_SLEEP_MS ?? 0) || 0;
/** Test hook: hold each atomic write between its temp file and the rename, so a spec can see where the temp lives. */
const DEBUG_TEMP_PAUSE_MS = Number(process.env.BACKFILL_DEBUG_TEMP_PAUSE_MS ?? 0) || 0;
/** Test hook: the oEmbed host, so a spec can answer the dry run from a local server. */
const OEMBED_BASE = process.env.BACKFILL_OEMBED_BASE || undefined;
for (const name of ["BACKFILL_DEBUG_SLEEP_MS", "BACKFILL_DEBUG_TEMP_PAUSE_MS", "BACKFILL_OEMBED_BASE"]) {
  if (process.env[name]) console.error(`warning: test hook ${name}=${process.env[name]} is set`);
}
/**
 * Defensive only: with no locale bsdtar's `-t` listing escapes every non-ASCII
 * byte (measured: 180 of 1,313 names), which is why the rollback never parses
 * a listing — it extracts and walks. Extraction round-trips names without it.
 */
const TAR_ENV = { ...process.env, LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" };

// ---------------------------------------------------------------------------
// Startup — `acquireRun()` is the only code that runs before a mode, and it
// decides whether this run may touch anything before it touches anything.
//
//   instances on the state dir | mode      | state dir                   | outcome
//   ---------------------------+-----------+-----------------------------+-----------------------------------------
//   1                          | any       | outside root, same fs       | runs; sweep + clear tmp/ after the lock
//   1                          | any       | = root, under root          | exit 2, nothing created under the root
//   1                          | any       | root under it               | exit 2, nothing created
//   1                          | any       | other filesystem            | exit 2 (EXDEV), nothing created
//   1                          | any       | journal names another root  | exit 2, nothing swept or cleared
//   1                          | any       | legacy manifest.json        | exit 2, nothing swept or cleared
//   2+ concurrent              | any × any | same state dir              | the later one exits 2 naming the holder;
//                              |           |                             | the holder's temp and tree are untouched
//   1 after a crash (kill -9)  | any       | stale lock left             | exit 2 "stale", prints the rm command;
//                              |           |                             | never stolen
//
// Order: (a) canonical root and state dir, placement + same-filesystem check
// (read-only; a missing state dir is resolved through its nearest ancestor,
// not created); (b) legacy manifest + the journal's root (read-only);
// (c) create the state dir, take `<state>/lock` with `wx` — every mode, the
// dry run included (it writes the cache and the review file); re-check (b)
// under the lock; (d) only then sweep backfill temps from the root and clear
// `<state>/tmp/`. The lock is released on exit, including exit 2 and SIGINT/
// SIGTERM; a crash leaves it, and the next run refuses — the safe side.
// ---------------------------------------------------------------------------

/** Absolute, symlinks resolved — through the nearest existing ancestor when `p` does not exist yet. */
function canonical(p: string): { path: string; existing: string } {
  const rest: string[] = [];
  let cur = resolve(p);
  while (!existsSync(cur)) {
    rest.unshift(basename(cur));
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  const existing = realpathSync(cur);
  return { path: join(existing, ...rest), existing };
}

/** Every `*.author-backfill.tmp` under `dir`, dot entries included — huginn reads those too. */
function leftoverTemps(dir: string, out: string[] = []): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) leftoverTemps(abs, out);
    else if (ent.name.endsWith(".author-backfill.tmp")) out.push(abs);
  }
  return out;
}

function refuse(message: string): never {
  console.error(message);
  process.exit(2);
}

/** The foreign-root refusal, or the runs. Read-only. */
function readJournal(journalPath: string, root: string): JournalRun[] {
  if (!existsSync(journalPath)) return [];
  const { runs, badLines } = parseJournal(readFileSync(journalPath, "utf8"));
  if (badLines > 0) console.warn(`journal: ${badLines} unreadable line(s) ignored (a torn last append?)`);
  const foreign = runs.find((r) => r.root !== root);
  if (foreign) {
    refuse(
      `journal ${journalPath} records runs against the root ${foreign.root}, but this run's --root is ${root} — ` +
        `rerun with --root ${foreign.root}`,
    );
  }
  return runs;
}

let heldLock: string | null = null;
function releaseLock(): void {
  if (heldLock === null) return;
  const path = heldLock;
  heldLock = null;
  rmSync(path, { force: true });
}
process.on("exit", releaseLock);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it runs, as someone else.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function acquireRun(): { root: string; stateDir: string; journal: JournalRun[] } {
  // (a) placement
  const rootArg = resolve(ARGS.root ?? join(homedir(), "source/private/huginn/data/sources/youtube-articles"));
  if (!existsSync(rootArg)) refuse(`root does not exist: ${rootArg}`);
  const root = realpathSync(rootArg);
  const state = canonical(ARGS.stateDir ?? join(homedir(), ".muninn/youtube-author-backfill"));
  const placement = checkStatePlacement({
    root,
    stateDir: state.path,
    rootDev: statSync(root).dev,
    stateDev: statSync(state.existing).dev,
  });
  if (!placement.ok) refuse(placement.error);
  const stateDir = state.path;

  // (b) state the dir already holds
  if (existsSync(join(stateDir, "manifest.json"))) {
    refuse(`${stateDir} holds a manifest.json from an earlier version of this script — pass another --state-dir`);
  }
  const journalPath = join(stateDir, "journal.jsonl");
  readJournal(journalPath, root);

  // (c) the lock
  mkdirSync(stateDir, { recursive: true });
  const lockPath = join(stateDir, "lock");
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const holder = parseLock(readFileSync(lockPath, "utf8"));
    refuse(lockRefusal(lockPath, holder, holder !== null && pidAlive(holder.pid)));
  }
  heldLock = lockPath;
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, mode: ARGS.mode, startedAt: new Date().toISOString() }) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // Again under the lock: a run that held it may have journaled since (b).
  const journal = readJournal(journalPath, root);

  // (d) the only mutations before a mode runs
  for (const abs of leftoverTemps(root)) {
    rmSync(abs, { force: true });
    console.log(`removed a temp file an earlier build left in the root: ${relative(root, abs)}`);
  }
  const tmp = join(stateDir, "tmp");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp);
  return { root, stateDir, journal };
}

const { root: ROOT, stateDir: STATE_DIR, journal } = acquireRun();
const CACHE_PATH = join(STATE_DIR, "oembed-cache.json");
const JOURNAL_PATH = join(STATE_DIR, "journal.jsonl");
/** Cleared at startup under the lock; holds the one in-flight write's temp. */
const TMP_DIR = join(STATE_DIR, "tmp");

// ---------------------------------------------------------------------------
// State files
// ---------------------------------------------------------------------------

type CacheEntry = { kind: "ok"; author: string; title?: string } | { kind: "unavailable"; status: number };
type Cache = Record<string, CacheEntry>;

function loadJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
const cache: Cache = loadJson<Cache>(CACHE_PATH, {});
function saveCache(): void {
  const tmp = `${CACHE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n");
  renameSync(tmp, CACHE_PATH);
}


/** Append journal lines and fsync, so a line reported written survives a crash. */
function appendJournal(events: readonly JournalEvent[]): void {
  const fd = openSync(JOURNAL_PATH, "a");
  try {
    writeSync(fd, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function nextRunId(): number {
  return journal.reduce((m, r) => Math.max(m, r.run), 0) + 1;
}

/** See `mtimeMsFromNs` — never `statSync().mtimeMs` in this script. */
function mtimeOf(abs: string): number {
  return mtimeMsFromNs(statSync(abs, { bigint: true }).mtimeNs);
}

/**
 * `bytes` onto `abs` atomically, already carrying its stamp: a temp file in
 * `TMP_DIR` (the startup check refused a state dir under the root, which
 * huginn indexes whole, or on another filesystem), the original mode, fsynced,
 * stamped, then renamed over the target. One temp name is enough: the lock
 * makes this the only run on the state dir.
 */
function atomicWrite(abs: string, bytes: string | Uint8Array, atime: Date, stampMs: number): void {
  const tmp = join(TMP_DIR, "write.tmp");
  const mode = statSync(abs).mode & 0o777;
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, mode);
  utimesSync(tmp, atime, stampMs / 1000);
  if (DEBUG_TEMP_PAUSE_MS > 0) Bun.sleepSync(DEBUG_TEMP_PAUSE_MS);
  renameSync(tmp, abs);
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

interface Doc {
  /** NFC, relative to ROOT. */
  path: string;
  abs: string;
  mtimeMs: number;
  originalMtimeMs: number;
  bytes: Buffer;
  text: string;
  videoId: string | null;
  hasFrontmatter: boolean;
  hasAuthor: boolean;
}

/** Every `.md` under `dir`, keyed by NFC relative path → the real absolute path. */
function walk(dir: string, base: string = dir, out: Map<string, string> = new Map()): Map<string, string> {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith(".")) continue;
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) walk(abs, base, out);
    else if (ent.isFile() && ent.name.endsWith(".md")) out.set(nfcPath(relative(base, abs)), abs);
  }
  return out;
}

function inventory(): Doc[] {
  const idx = originalMtimeIndex(journal);
  return [...walk(ROOT)].map(([path, abs]) => {
    const mtimeMs = mtimeOf(abs);
    const bytes = readFileSync(abs);
    const text = bytes.toString("utf8");
    const fm = parseCaptureFrontmatter(text);
    const url = fm.byKey.url !== undefined ? String(decodeFrontmatterScalar(fm.byKey.url)) : "";
    return {
      path,
      abs,
      mtimeMs,
      originalMtimeMs: originalMtimeFor(idx, path, mtimeMs),
      bytes,
      text,
      videoId: url ? extractYouTubeVideoId(url) : null,
      hasFrontmatter: fm.present,
      hasAuthor: fm.present && "author" in fm.byKey,
    };
  });
}

function loadExcludes(docs: readonly Doc[]): Set<string> {
  if (ARGS.exclude === undefined) return new Set();
  if (!existsSync(ARGS.exclude)) {
    console.error(`--exclude file not found: ${ARGS.exclude}`);
    process.exit(2);
  }
  const set = parseExcludeList(readFileSync(ARGS.exclude, "utf8"));
  const known = new Set(docs.map((d) => d.path));
  const unknown = [...set].filter((p) => !known.has(p));
  console.log(`--exclude: ${set.size} path(s)${unknown.length ? `, ${unknown.length} not in the tree` : ""}`);
  for (const p of unknown) console.log(`  not in the tree: ${p}`);
  return set;
}

// ---------------------------------------------------------------------------
// huginn
// ---------------------------------------------------------------------------

async function runUpdate(): Promise<boolean> {
  const base = `${HUGINN}/api/collections/${encodeURIComponent(COLLECTION)}`;
  const deadline = Date.now() + 30 * 60_000;
  try {
    for (;;) {
      const res = await fetch(`${base}/update`, { method: "POST" });
      if (res.status === 409) {
        if (Date.now() > deadline) {
          console.error("update: still 409 after 30 min — giving up");
          return false;
        }
        console.log("update: 409 (a rebuild is running) — retrying in 10 s");
        await Bun.sleep(10_000);
        continue;
      }
      if (!res.ok) {
        console.error(`update: HTTP ${res.status} ${await res.text()}`);
        return false;
      }
      break;
    }
    console.log("update: started");
    for (;;) {
      await Bun.sleep(5_000);
      const res = await fetch(`${base}/update-status`);
      const body = await res.text();
      let st: { status?: string; error?: string | null };
      try {
        st = JSON.parse(body) as typeof st;
      } catch {
        console.error(`update-status: HTTP ${res.status}, not JSON: ${body.slice(0, 200)}`);
        return false;
      }
      if (st.status === "succeeded") {
        console.log("update: succeeded");
        return true;
      }
      if (st.status === "failed") {
        console.error(`update: failed — ${st.error ?? "(no error text)"}`);
        return false;
      }
      if (Date.now() > deadline) {
        console.error(`update: still ${st.status} after 30 min — stopped polling`);
        return false;
      }
    }
  } catch (err) {
    console.error(`update: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function checkAuthors(expected: Array<{ path: string; author: string }>): Promise<boolean> {
  let ok = 0;
  const bad: string[] = [];
  for (const { path, author } of expected) {
    try {
      const res = await fetch(`${HUGINN}/api/document/${encodeURIComponent(COLLECTION)}/${encodeURIComponent(path)}`);
      const doc = res.ok ? ((await res.json()) as { metadata?: { author?: unknown } }) : null;
      if (doc?.metadata?.author === author) ok++;
      else bad.push(`${path}: HTTP ${res.status}, metadata.author=${JSON.stringify(doc?.metadata?.author)}`);
    } catch (err) {
      bad.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`check: ${ok}/${expected.length} documents carry the written author`);
  for (const b of bad) console.log(`  MISMATCH ${b}`);
  return bad.length === 0;
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

function showDiff(doc: Doc, next: string): void {
  const before = parseCaptureFrontmatter(doc.text).entries.map((e) => `${e.key}: ${e.raw}`);
  const after = parseCaptureFrontmatter(next).entries.map((e) => `${e.key}: ${e.raw}`);
  console.log(`--- ${doc.path}`);
  for (const line of after) console.log(before.includes(line) ? `  ${line}` : `+ ${line}`);
}

function docTitle(path: string): string {
  return basename(path).replace(/\.md$/, "");
}

async function dryRun(): Promise<void> {
  const docs = inventory();
  const excludes = loadExcludes(docs);
  const missing = docs.filter((d) => d.hasFrontmatter && !d.hasAuthor);
  const present = docs.filter((d) => d.hasAuthor).length;
  const noFrontmatter = docs.filter((d) => !d.hasFrontmatter).length;
  const noId = missing.filter((d) => d.videoId === null);
  const ids = [...new Set(missing.flatMap((d) => (d.videoId ? [d.videoId] : [])))];
  // An `ok` entry from before titles were cached is fetched again, once, for the title review.
  const toFetch = ids.filter((id) => cache[id] === undefined || (cache[id]!.kind === "ok" && cache[id]!.title === undefined));
  console.log(`${docs.length} files; ${present} already carry author; ${missing.length} lack it (${ids.length} video ids, ${toFetch.length} to fetch)`);
  if (toFetch.length > 0) {
    console.log(`fetching oEmbed at 2 req/s — about ${Math.ceil((toFetch.length * REQUEST_SPACING_MS) / 60_000)} min`);
  }
  let streak = 0;
  const errors: string[] = [];
  for (const [i, id] of toFetch.entries()) {
    const started = Date.now();
    const result: YouTubeOembedResult = await fetchYouTubeOembed(id, { baseUrl: OEMBED_BASE });
    streak = nextFailureStreak(streak, result);
    if (result.kind === "ok") cache[id] = { kind: "ok", author: result.author, ...(result.title ? { title: result.title } : {}) };
    else if (result.kind === "unavailable") cache[id] = { kind: "unavailable", status: result.status };
    else errors.push(`${id}: ${result.error}`);
    if ((i + 1) % 50 === 0) {
      saveCache();
      console.log(`  ${i + 1}/${toFetch.length}`);
    }
    if (streak >= OEMBED_ABORT_STREAK) {
      saveCache();
      console.error(`ABORT: ${streak} consecutive oEmbed failures. Last errors:`);
      for (const e of errors.slice(-OEMBED_ABORT_STREAK)) console.error(`  ${e}`);
      process.exit(1);
    }
    const wait = REQUEST_SPACING_MS - (Date.now() - started);
    if (wait > 0) await Bun.sleep(wait);
  }
  saveCache();

  const okDocs = missing.filter((d) => d.videoId && cache[d.videoId]?.kind === "ok");
  const overCap = okDocs.filter((d) => capFrontmatterAuthor((cache[d.videoId!] as { author: string }).author) === undefined);
  const excluded = okDocs.filter((d) => excludes.has(d.path));
  const toWrite = okDocs.filter((d) => !excludes.has(d.path) && !overCap.includes(d));
  const unavailable = missing.filter((d) => d.videoId && cache[d.videoId]?.kind === "unavailable");
  const uncached = missing.filter((d) => d.videoId && cache[d.videoId] === undefined);
  console.log("");
  console.log(`to write:         ${toWrite.length}`);
  console.log(`already present:  ${present}`);
  console.log(`excluded:         ${excluded.length}`);
  console.log(`author > 512 B:   ${overCap.length}${overCap.length ? " — " + overCap.map((d) => d.path).join(", ") : ""}`);
  console.log(`unavailable:      ${unavailable.length}`);
  for (const d of unavailable) {
    console.log(`  ${(cache[d.videoId!] as { status: number }).status} ${d.videoId} ${d.path}`);
  }
  console.log(`no video id:      ${noId.length}${noId.length ? " — " + noId.map((d) => d.path).join(", ") : ""}`);
  console.log(`no frontmatter:   ${noFrontmatter}`);
  console.log(`errors (retry):   ${uncached.length}`);
  for (const e of errors) console.log(`  ${e}`);

  // Title review: a legacy document's `url` can name ANOTHER video, and the
  // write would then give it that video's channel. Not blocked automatically —
  // YouTube retitles are common — but listed, lowest overlap first.
  // Over EVERY candidate, `--exclude`d or not: a review built from what is left
  // after the exclude erases the flags the exclude file came from.
  const review = okDocs
    .filter((d) => !overCap.includes(d))
    .flatMap((d) => {
      const entry = cache[d.videoId!] as { author: string; title?: string };
      if (entry.title === undefined) return [];
      const score = titleSimilarity(docTitle(d.path), entry.title);
      return score !== null && score < TITLE_REVIEW_THRESHOLD ? [{ d, entry, score }] : [];
    })
    .sort((a, b) => a.score - b.score);
  // Never overwritten: the operator prunes this file and passes it back.
  const firstReview = join(STATE_DIR, "title-review.txt");
  const reviewPath = existsSync(firstReview)
    ? join(STATE_DIR, `title-review-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`)
    : firstReview;
  const mark = (d: Doc): string => (excludes.has(d.path) ? " (already --exclude'd)" : "");
  writeFileSync(
    reviewPath,
    `# title overlap < ${TITLE_REVIEW_THRESHOLD}: an --exclude file. Delete the lines you checked and are fine.\n` +
      review.map((r) => `# ${r.score.toFixed(2)} oEmbed: ${JSON.stringify(r.entry.title)} by ${r.entry.author}${mark(r.d)}\n${r.d.path}\n`).join(""),
  );
  console.log("");
  if (reviewPath !== firstReview) console.log(`${firstReview} exists and was left untouched; this review is a new file`);
  console.log(`title review (overlap < ${TITLE_REVIEW_THRESHOLD}): ${review.length} → ${reviewPath}`);
  for (const r of review) {
    console.log(`  ${r.score.toFixed(2)}  ${r.d.path}${mark(r.d)}\n        oEmbed: ${JSON.stringify(r.entry.title)} — ${r.entry.author}`);
  }
  console.log("");
  for (const d of toWrite.slice(0, 20)) {
    const next = insertFrontmatterAuthor(d.text, (cache[d.videoId!] as { author: string }).author);
    if (next !== null) showDiff(d, next);
  }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * A real event-loop turn after each file, even at 0 ms: a SIGINT handler runs
 * only on one, so without it Ctrl-C would wait for the whole run to finish.
 */
async function debugPause(): Promise<void> {
  await Bun.sleep(DEBUG_SLEEP_MS);
}

/** Runs one planned sequence: journal the plan, then each file, then `end`. */
async function executePlan(
  run: number,
  plan: readonly PlannedStamp[],
  byPath: ReadonlyMap<string, Doc>,
  bytesFor: (p: PlannedStamp, doc: Doc) => string | Uint8Array | null,
  doneStatus: "written" | "restored",
): Promise<{ changed: string[]; restamped: number; skipped: string[] }> {
  const changed: string[] = [];
  const skipped: string[] = [];
  let restamped = 0;
  for (const p of plan) {
    const doc = byPath.get(p.path)!;
    let event: JournalEvent;
    if (!existsSync(doc.abs) || mtimeOf(doc.abs) !== doc.mtimeMs) {
      skipped.push(`${p.path} (changed since read)`);
      event = { t: "done", run, path: p.path, status: "skipped", reason: "changed since read" };
    } else {
      const atime = statSync(doc.abs).atime;
      if (p.write) {
        const bytes = bytesFor(p, doc);
        if (bytes === null) {
          skipped.push(`${p.path} (insert refused)`);
          appendJournal([{ t: "done", run, path: p.path, status: "skipped", reason: "insert refused" }]);
          continue;
        }
        atomicWrite(doc.abs, bytes, atime, p.stampMs);
        changed.push(p.path);
        event = { t: "done", run, path: p.path, status: doneStatus };
      } else {
        utimesSync(doc.abs, atime, p.stampMs / 1000);
        restamped++;
        event = { t: "done", run, path: p.path, status: "restamped" };
      }
    }
    appendJournal([event]);
    await debugPause();
  }
  appendJournal([{ t: "end", run }]);
  return { changed, restamped, skipped };
}

async function write(): Promise<void> {
  const docs = inventory();
  const excludes = loadExcludes(docs);
  const byPath = new Map(docs.map((d) => [d.path, d] as const));
  const authorOf = (d: Doc): string | undefined => {
    const e = d.videoId ? cache[d.videoId] : undefined;
    return e?.kind === "ok" ? capFrontmatterAuthor(e.author) : undefined;
  };
  const candidates = new Set(
    docs
      .filter((d) => d.hasFrontmatter && !d.hasAuthor && !excludes.has(d.path) && authorOf(d) !== undefined)
      .map((d) => d.path),
  );
  const sequence = planSequence(
    docs.filter((d) => d.hasFrontmatter).map((d) => ({ path: d.path, originalMtimeMs: d.originalMtimeMs, title: basename(d.path) })),
    candidates,
    ARGS.limit,
  );
  if (sequence.length === 0) {
    console.log(`nothing to write (${candidates.size} candidates in the cache)`);
    return;
  }
  const backup = join(STATE_DIR, `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`);
  await $`tar -czf ${backup} -C ${ROOT} .`.env(TAR_ENV);
  console.log(`snapshot tarball: ${backup}`);

  const run = nextRunId();
  const plan = assignStamps(sequence, Date.now());
  appendJournal([
    { t: "run", run, kind: "write", at: new Date().toISOString(), root: ROOT, tarball: backup },
    ...plan.map((p): JournalEvent => {
      const author = p.write ? authorOf(byPath.get(p.path)!) : undefined;
      return {
        t: "plan",
        run,
        path: p.path,
        originalMtimeMs: p.originalMtimeMs,
        stampMs: p.stampMs,
        write: p.write,
        ...(author !== undefined ? { author } : {}),
      };
    }),
  ]);
  const { changed, restamped, skipped } = await executePlan(
    run,
    plan,
    byPath,
    (_p, doc) => insertFrontmatterAuthor(doc.text, authorOf(doc)!),
    "written",
  );
  console.log(`wrote ${changed.length}, re-stamped ${restamped} (mtime only), skipped ${skipped.length}`);
  for (const s of skipped) console.log(`  skipped ${s}`);
  console.log(`stamps ${plan[0]!.stampMs} … ${plan[plan.length - 1]!.stampMs} (${new Date(plan[plan.length - 1]!.stampMs).toISOString()})`);
  console.log(`journal: ${JOURNAL_PATH} (run ${run})`);
  if (ARGS.noUpdate) {
    console.log("--no-update: huginn not called");
    return;
  }
  const written = changed.map((path) => ({ path, author: authorOf(byPath.get(path)!)! }));
  if (!(await runUpdate()) || !(await checkAuthors(written))) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

async function rollback(): Promise<void> {
  const writes = lastWrites(journal);
  if (writes.size === 0) {
    console.log("nothing to roll back: the journal holds no write run");
    return;
  }
  const tarballs = [...new Set([...writes.values()].map((w) => w.tarball))];
  const lost = tarballs.filter((t) => !existsSync(t));
  if (lost.length > 0) {
    console.error(`snapshot tarball(s) missing — nothing restored:\n  ${lost.join("\n  ")}`);
    process.exit(2);
  }
  const scratch = mkdtempSync(join(tmpdir(), "yt-author-rollback-"));
  try {
    // Extract, then WALK: no `tar -t` output is parsed, and both sides are NFC.
    const snapshots = new Map<string, Map<string, string>>();
    for (const [i, t] of tarballs.entries()) {
      const dir = join(scratch, String(i));
      mkdirSync(dir);
      await $`tar -xzf ${t} -C ${dir}`.env(TAR_ENV);
      snapshots.set(t, walk(dir));
    }
    const docs = inventory();
    const byPath = new Map(docs.map((d) => [d.path, d] as const));

    const targets = new Map<string, Buffer>();
    const notRestored: Array<{ path: string; reason: NotRestoredReason | "never written" }> = [];
    for (const [path, w] of writes) {
      const snapAbs = snapshots.get(w.tarball)!.get(path);
      const preWrite = snapAbs !== undefined ? readFileSync(snapAbs) : null;
      const current = byPath.get(path)?.bytes ?? null;
      const d = rollbackDisposition({ current, preWrite, author: w.author });
      if (d.restore) targets.set(path, preWrite!);
      else notRestored.push({ path, reason: d.reason });
    }
    const everInSnapshot = new Set<string>();
    for (const m of snapshots.values()) for (const p of m.keys()) everInSnapshot.add(p);
    for (const p of everInSnapshot) if (!writes.has(p)) notRestored.push({ path: p, reason: "never written" });

    console.log(
      `${writes.size} file(s) the backfill planned to write; ${targets.size} still hold exactly what it wrote and will be restored`,
    );
    let changed: string[] = [];
    let skipped: string[] = [];
    if (targets.size > 0) {
      const sequence = planSequence(
        docs
          .filter((d) => d.hasFrontmatter)
          .map((d) => ({
            path: d.path,
            // A restored file goes back to the place its pre-backfill mtime gave it.
            originalMtimeMs: targets.has(d.path) ? writes.get(d.path)!.originalMtimeMs : d.originalMtimeMs,
            title: basename(d.path),
          })),
        new Set(targets.keys()),
      );
      const run = nextRunId();
      const plan = assignStamps(sequence, Date.now());
      appendJournal([
        { t: "run", run, kind: "rollback", at: new Date().toISOString(), root: ROOT },
        ...plan.map((p): JournalEvent => ({
          t: "plan",
          run,
          path: p.path,
          originalMtimeMs: p.originalMtimeMs,
          stampMs: p.stampMs,
          write: p.write,
        })),
      ]);
      const result = await executePlan(run, plan, byPath, (p) => targets.get(p.path) ?? null, "restored");
      changed = result.changed;
      skipped = result.skipped;
      console.log(`restored ${changed.length}, re-stamped ${result.restamped} (mtime only), skipped ${skipped.length}`);
      for (const s of skipped) console.log(`  skipped ${s}`);
    }

    const reportPath = join(STATE_DIR, `rollback-report-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`);
    const lines = [
      ...changed.map((p) => `restored\t${p}`),
      ...skipped.map((s) => `skipped\t${s}`),
      ...notRestored.sort((a, b) => a.reason.localeCompare(b.reason) || a.path.localeCompare(b.path)).map((n) => `${n.reason}\t${n.path}`),
    ];
    writeFileSync(reportPath, lines.join("\n") + "\n");
    const counts = new Map<string, number>();
    for (const n of notRestored) counts.set(n.reason, (counts.get(n.reason) ?? 0) + 1);
    console.log(`not restored: ${notRestored.length} — ${[...counts].map(([r, c]) => `${r} ${c}`).join(", ") || "none"}`);
    // Inline: the files whose bytes the backfill no longer owns. "never written"
    // and "unchanged from snapshot" (a planned file the run never reached, or
    // already restored) need no action; the report lists them too.
    const quiet = new Set(["never written", "unchanged from snapshot"]);
    for (const n of notRestored) if (!quiet.has(n.reason)) console.log(`  ${n.reason}: ${n.path}`);
    console.log(`report (every snapshot file not restored, with its reason): ${reportPath}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (ARGS.noUpdate) {
    console.log("--no-update: huginn not called");
    return;
  }
  if (!(await runUpdate())) process.exitCode = 1;
}

if (ARGS.mode === "rollback") await rollback();
else if (ARGS.mode === "dry-run") await dryRun();
else await write();
