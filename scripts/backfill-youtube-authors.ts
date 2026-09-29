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
 *       each answer per video id, prints counts and 20 diffs. Aborts after 5
 *       consecutive failures other than 401/404 (private/deleted videos).
 *   bun scripts/backfill-youtube-authors.ts --limit 20
 *       The pilot: tarballs the tree, writes the 20 NEWEST candidates from the
 *       cache, runs huginn's `/update` and checks `metadata.author` on each.
 *   bun scripts/backfill-youtube-authors.ts
 *       The full write, from the cache, then `/update`. Run it at the start of a
 *       quiet day: `/update` re-reads files newer than its last indexed mtime
 *       minus a day, so for about a day every update re-embeds the collection.
 *   bun scripts/backfill-youtube-authors.ts --rollback <tarball>
 *       Restores from the tarball only the files whose current mtime is one of
 *       this backfill's own stamps on that file, stamps them forward, `/update`.
 *
 * Writes add the key only where it is absent, never touch the body, and skip a
 * file whose mtime moved between read and write. Every run re-stamps its
 * sequence (every file from the oldest one it writes onward, written or not)
 * with increasing mtimes 1 ms apart in original-mtime order, so `/update` reads
 * them and the collection's relative order survives. The stamps, with each
 * file's pre-backfill mtime, go to `manifest.json` in the state dir — the
 * rollback's filter and the next run's "original mtime" both read it.
 *
 * Flags: --root <dir> (default huginn's youtube-articles tree), --state-dir <dir>
 * (default ~/.muninn/youtube-author-backfill), --huginn <url> (default
 * KNOWLEDGE_API_URL or http://127.0.0.1:8321), --no-update (skip huginn
 * entirely), --collection <name> (default youtube-summaries).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { $ } from "bun";
import {
  assignStamps,
  insertFrontmatterAuthor,
  needsAuthor,
  nextFailureStreak,
  OEMBED_ABORT_STREAK,
  planSequence,
  rollbackTargets,
  compareByOriginalOrder,
  mtimeIsStamp,
  mtimeMsFromNs,
  type PlannedStamp,
} from "../src/summaries/author-backfill.ts";
import { parseCaptureFrontmatter, decodeFrontmatterScalar } from "../src/summaries/transcript-split.ts";
import { extractYouTubeVideoId } from "../src/youtube/url.ts";
import { fetchYouTubeOembed, type YouTubeOembedResult } from "../src/youtube/metadata.ts";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function flag(name: string): boolean {
  return argv.includes(name);
}
function value(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const ROOT = value("--root") ?? join(homedir(), "source/private/huginn/data/sources/youtube-articles");
const STATE_DIR = value("--state-dir") ?? join(homedir(), ".muninn/youtube-author-backfill");
const HUGINN = (value("--huginn") ?? process.env.KNOWLEDGE_API_URL ?? "http://127.0.0.1:8321").replace(/\/+$/, "");
const COLLECTION = value("--collection") ?? "youtube-summaries";
const NO_UPDATE = flag("--no-update");
const DRY_RUN = flag("--dry-run");
const ROLLBACK = value("--rollback");
const LIMIT_RAW = value("--limit");
const LIMIT = LIMIT_RAW === undefined ? undefined : Number(LIMIT_RAW);
const REQUEST_SPACING_MS = 500; // 2 requests per second
const CACHE_PATH = join(STATE_DIR, "oembed-cache.json");
const MANIFEST_PATH = join(STATE_DIR, "manifest.json");

if (LIMIT !== undefined && (!Number.isInteger(LIMIT) || LIMIT < 1)) {
  console.error(`--limit must be a positive integer, got ${LIMIT_RAW}`);
  process.exit(2);
}
if (!existsSync(ROOT)) {
  console.error(`root does not exist: ${ROOT}`);
  process.exit(2);
}
mkdirSync(STATE_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// State files
// ---------------------------------------------------------------------------

type CacheEntry = { kind: "ok"; author: string } | { kind: "unavailable"; status: number };
type Cache = Record<string, CacheEntry>;

interface ManifestEntry {
  path: string;
  originalMtimeMs: number;
  stampMs: number;
  wrote: boolean;
}
interface ManifestRun {
  kind: "write" | "rollback";
  at: string;
  tarball?: string;
  entries: ManifestEntry[];
}
interface Manifest {
  root: string;
  runs: ManifestRun[];
}

function loadJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
const cache: Cache = loadJson<Cache>(CACHE_PATH, {});
const manifest: Manifest = loadJson<Manifest>(MANIFEST_PATH, { root: ROOT, runs: [] });
if (manifest.root !== ROOT) {
  console.error(`manifest ${MANIFEST_PATH} belongs to ${manifest.root}, not ${ROOT} — pass another --state-dir`);
  process.exit(2);
}
function saveCache(): void {
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");
}
function saveManifest(): void {
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
}

/** Per path: every stamp any backfill WRITE run put on it, and the pre-backfill mtime. */
function stampIndex(): { stamps: Map<string, Set<number>>; original: Map<string, number>; byStamp: Map<string, Map<number, number>> } {
  const stamps = new Map<string, Set<number>>();
  const original = new Map<string, number>();
  const byStamp = new Map<string, Map<number, number>>();
  for (const run of manifest.runs) {
    if (run.kind !== "write") continue;
    for (const e of run.entries) {
      if (!stamps.has(e.path)) stamps.set(e.path, new Set());
      stamps.get(e.path)!.add(e.stampMs);
      if (!original.has(e.path)) original.set(e.path, e.originalMtimeMs);
      if (!byStamp.has(e.path)) byStamp.set(e.path, new Map());
      byStamp.get(e.path)!.set(e.stampMs, e.originalMtimeMs);
    }
  }
  return { stamps, original, byStamp };
}

/** See `mtimeMsFromNs` — never `statSync().mtimeMs` in this script. */
function mtimeOf(abs: string): number {
  return mtimeMsFromNs(statSync(abs, { bigint: true }).mtimeNs);
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

interface Doc {
  path: string;
  abs: string;
  mtimeMs: number;
  originalMtimeMs: number;
  text: string;
  videoId: string | null;
  hasFrontmatter: boolean;
  hasAuthor: boolean;
}

function walk(dir: string, out: string[]): void {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith(".")) continue;
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) walk(abs, out);
    else if (ent.isFile() && ent.name.endsWith(".md")) out.push(abs);
  }
}

function inventory(): Doc[] {
  const idx = stampIndex();
  const files: string[] = [];
  walk(ROOT, files);
  return files.map((abs) => {
    const path = relative(ROOT, abs);
    const mtimeMs = mtimeOf(abs);
    const text = readFileSync(abs, "utf8");
    const fm = parseCaptureFrontmatter(text);
    const url = fm.byKey.url !== undefined ? String(decodeFrontmatterScalar(fm.byKey.url)) : "";
    // A file still carrying one of OUR stamps keeps the place it had before
    // the backfill touched it; anything else is ordered by what it says now.
    const stamped = idx.byStamp.get(path)?.get(Math.round(mtimeMs));
    return {
      path,
      abs,
      mtimeMs,
      originalMtimeMs: stamped ?? mtimeMs,
      text,
      videoId: url ? extractYouTubeVideoId(url) : null,
      hasFrontmatter: fm.present,
      hasAuthor: fm.present && "author" in fm.byKey,
    };
  });
}

// ---------------------------------------------------------------------------
// huginn
// ---------------------------------------------------------------------------

async function runUpdate(): Promise<boolean> {
  const base = `${HUGINN}/api/collections/${encodeURIComponent(COLLECTION)}`;
  const deadline = Date.now() + 30 * 60_000;
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
    const st = (await (await fetch(`${base}/update-status`)).json()) as { status?: string; error?: string | null };
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
}

async function checkAuthors(expected: Array<{ path: string; author: string }>): Promise<void> {
  let ok = 0;
  const bad: string[] = [];
  for (const { path, author } of expected) {
    const res = await fetch(`${HUGINN}/api/document/${encodeURIComponent(COLLECTION)}/${encodeURIComponent(path)}`);
    const doc = res.ok ? ((await res.json()) as { metadata?: { author?: unknown } }) : null;
    if (doc?.metadata?.author === author) ok++;
    else bad.push(`${path}: HTTP ${res.status}, metadata.author=${JSON.stringify(doc?.metadata?.author)}`);
  }
  console.log(`check: ${ok}/${expected.length} documents carry the written author`);
  for (const b of bad) console.log(`  MISMATCH ${b}`);
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

function showDiff(doc: Doc, next: string): void {
  const before = parseCaptureFrontmatter(doc.text).entries.map((e) => `${e.key}: ${e.raw}`);
  const after = parseCaptureFrontmatter(next).entries.map((e) => `${e.key}: ${e.raw}`);
  console.log(`--- ${doc.path}`);
  for (const line of after) console.log(before.includes(line) ? `  ${line}` : `+ ${line}`);
}

async function dryRun(): Promise<void> {
  const docs = inventory();
  const missing = docs.filter((d) => d.hasFrontmatter && !d.hasAuthor);
  const present = docs.filter((d) => d.hasAuthor).length;
  const noFrontmatter = docs.filter((d) => !d.hasFrontmatter).length;
  const noId = missing.filter((d) => d.videoId === null);
  const ids = [...new Set(missing.flatMap((d) => (d.videoId ? [d.videoId] : [])))];
  const toFetch = ids.filter((id) => cache[id] === undefined);
  console.log(`${docs.length} files; ${present} already carry author; ${missing.length} lack it (${ids.length} video ids, ${toFetch.length} not cached yet)`);
  if (toFetch.length > 0) {
    console.log(`fetching oEmbed at 2 req/s — about ${Math.ceil((toFetch.length * REQUEST_SPACING_MS) / 60_000)} min`);
  }
  let streak = 0;
  const errors: string[] = [];
  for (const [i, id] of toFetch.entries()) {
    const started = Date.now();
    const result: YouTubeOembedResult = await fetchYouTubeOembed(id);
    streak = nextFailureStreak(streak, result);
    if (result.kind === "ok") cache[id] = { kind: "ok", author: result.author };
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

  const toWrite = missing.filter((d) => d.videoId && cache[d.videoId]?.kind === "ok");
  const unavailable = missing.filter((d) => d.videoId && cache[d.videoId]?.kind === "unavailable");
  const uncached = missing.filter((d) => d.videoId && cache[d.videoId] === undefined);
  console.log("");
  console.log(`to write:         ${toWrite.length}`);
  console.log(`already present:  ${present}`);
  console.log(`unavailable:      ${unavailable.length}`);
  for (const d of unavailable) {
    console.log(`  ${(cache[d.videoId!] as { status: number }).status} ${d.videoId} ${d.path}`);
  }
  console.log(`no video id:      ${noId.length}${noId.length ? " — " + noId.map((d) => d.path).join(", ") : ""}`);
  console.log(`no frontmatter:   ${noFrontmatter}`);
  console.log(`errors (retry):   ${uncached.length}`);
  for (const e of errors) console.log(`  ${e}`);
  console.log("");
  for (const d of toWrite.slice(0, 20)) {
    const next = insertFrontmatterAuthor(d.text, (cache[d.videoId!] as { author: string }).author);
    if (next !== null) showDiff(d, next);
  }
}

async function write(): Promise<void> {
  const docs = inventory();
  const byPath = new Map(docs.map((d) => [d.path, d] as const));
  const candidates = new Set(
    docs
      .filter((d) => d.hasFrontmatter && !d.hasAuthor && d.videoId && cache[d.videoId]?.kind === "ok")
      .map((d) => d.path),
  );
  const sequence = planSequence(
    docs.filter((d) => d.hasFrontmatter).map((d) => ({ path: d.path, originalMtimeMs: d.originalMtimeMs, title: basename(d.path) })),
    candidates,
    LIMIT,
  );
  if (sequence.length === 0) {
    console.log(`nothing to write (${candidates.size} candidates in the cache)`);
    return;
  }
  const backup = join(STATE_DIR, `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`);
  await $`tar -czf ${backup} -C ${ROOT} .`;
  console.log(`rollback tarball: ${backup}`);

  const plan = assignStamps(sequence, Date.now());
  const run: ManifestRun = { kind: "write", at: new Date().toISOString(), tarball: backup, entries: [] };
  manifest.runs.push(run);
  let wrote = 0;
  let restamped = 0;
  const skipped: string[] = [];
  const written: Array<{ path: string; author: string }> = [];
  try {
    for (const p of plan) {
      const doc = byPath.get(p.path)!;
      const atime = statSync(doc.abs).atime;
      if (mtimeOf(doc.abs) !== doc.mtimeMs) {
        skipped.push(`${p.path} (mtime moved since read)`);
        continue;
      }
      if (p.write) {
        const author = (cache[doc.videoId!] as { author: string }).author;
        const next = insertFrontmatterAuthor(doc.text, author);
        if (next === null) {
          skipped.push(`${p.path} (insert refused)`);
          continue;
        }
        writeFileSync(doc.abs, next);
        written.push({ path: p.path, author });
        wrote++;
      } else {
        restamped++;
      }
      utimesSync(doc.abs, atime, p.stampMs / 1000);
      run.entries.push({ path: p.path, originalMtimeMs: p.originalMtimeMs, stampMs: p.stampMs, wrote: p.write });
    }
  } finally {
    saveManifest();
  }
  console.log(`wrote ${wrote}, re-stamped ${restamped} (mtime only), skipped ${skipped.length}`);
  for (const s of skipped) console.log(`  skipped ${s}`);
  if (plan.length > 0) {
    console.log(`stamps ${plan[0]!.stampMs} … ${plan[plan.length - 1]!.stampMs} (${new Date(plan[plan.length - 1]!.stampMs).toISOString()})`);
  }
  console.log(`manifest: ${MANIFEST_PATH}`);
  if (NO_UPDATE) {
    console.log("--no-update: huginn not called");
    return;
  }
  if (await runUpdate()) await checkAuthors(written);
}

async function rollback(tarPath: string): Promise<void> {
  if (!existsSync(tarPath)) {
    console.error(`tarball not found: ${tarPath}`);
    process.exit(2);
  }
  const members = (await $`tar -tzf ${tarPath}`.text())
    .split("\n")
    .map((m) => m.replace(/^\.\//, ""))
    .filter((m) => m.endsWith(".md"));
  const current = new Map<string, number>();
  for (const m of members) {
    const abs = join(ROOT, m);
    if (existsSync(abs)) current.set(m, mtimeOf(abs));
  }
  const { stamps } = stampIndex();
  const targets = rollbackTargets({ tarballMembers: members, currentMtimeMs: current, stampsByPath: stamps });
  console.log(`${members.length} files in the tarball; ${targets.length} still carry a backfill stamp and will be restored`);
  if (targets.length === 0) return;

  const scratch = mkdtempSync(join(tmpdir(), "yt-author-rollback-"));
  try {
    await $`tar -xzf ${tarPath} -C ${scratch}`;
    // Restored files keep the TARBALL's mtime as their order key, then are
    // stamped forward so `/update` reads them — a restore alone would keep the
    // old mtimes, and `/update` would skip every one.
    const restored = targets
      .map((path) => ({ path, title: basename(path), originalMtimeMs: mtimeOf(join(scratch, path)), write: true }))
      .sort(compareByOriginalOrder);
    const plan: PlannedStamp[] = assignStamps(restored, Date.now());
    const run: ManifestRun = { kind: "rollback", at: new Date().toISOString(), tarball: tarPath, entries: [] };
    manifest.runs.push(run);
    let done = 0;
    try {
      for (const p of plan) {
        const abs = join(ROOT, p.path);
        // Re-check at the moment of copying: a capture since the filter ran wins.
        if (!existsSync(abs) || !mtimeIsStamp(mtimeOf(abs), stamps.get(p.path))) continue;
        cpSync(join(scratch, p.path), abs);
        utimesSync(abs, new Date(), p.stampMs / 1000);
        run.entries.push({ path: p.path, originalMtimeMs: p.originalMtimeMs, stampMs: p.stampMs, wrote: true });
        done++;
      }
    } finally {
      saveManifest();
    }
    console.log(`restored ${done}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (NO_UPDATE) {
    console.log("--no-update: huginn not called");
    return;
  }
  await runUpdate();
}

if (ROLLBACK !== undefined) await rollback(ROLLBACK);
else if (DRY_RUN) await dryRun();
else await write();
