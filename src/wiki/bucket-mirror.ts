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
 * The mirror DELETES files, so its root is guarded three ways before the first
 * poll (see `checkMirrorRoot` / `prepareMirrorRoot`): inside `os.tmpdir()`,
 * listed in `WIKI_READONLY_ROOTS`, and either empty or carrying the mirror's
 * own marker file. A failed poll never deletes anything.
 */
import path from "node:path";
import os from "node:os";
import { realpathSync } from "node:fs";
import { lstat, mkdir, readdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { getLog } from "../logging.ts";
import {
  GCS_DEFAULT_BASE,
  type WikiBucketMirrorConfig,
  type WikiBucketMirrorEntry,
} from "../config.ts";
import { createAdcTokenFetcher, GcpTokenProvider } from "../gcp/access-token.ts";
import { readonlyWikiRoots } from "./readonly.ts";
import { getWikiIndex } from "./store.ts";

const log = getLog("wiki", "bucket-mirror");

/** Marks a directory as the mirror's own; a non-empty dir without it is refused. */
export const MIRROR_MARKER = ".bucket-mirror";
/** Per-object cap. The largest page in melosys-kode-wiki is well under 1 MB. */
export const MAX_OBJECT_BYTES = 5 * 1024 * 1024;
/** Object-count cap; a listing past it is refused whole (no downloads, no deletes). */
export const MAX_OBJECTS = 2000;
/** The only hidden file admitted, and only at the root. */
const READER_CONFIG = ".wiki-reader.json";
const ALLOWED_EXTENSIONS = new Set([".md", ".mdx", ".html", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]);
/** Temp files for the atomic write — hidden, so the wiki scan skips them. */
const TMP_INFIX = ".bmtmp-";
const LIST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// ── Object name → local relPath ──────────────────────────────────

export type RelPathResult = { relPath: string } | { refused: string };

/** Validate a path RELATIVE to the mirror root. Shared by the listing and the
 *  on-disk manifest rebuild, so both admit exactly the same set. */
export function validateMirrorRelPath(rel: string): RelPathResult {
  if (rel === "") return { refused: "empty name (the prefix itself)" };
  if (rel.endsWith("/")) return { refused: "folder placeholder" };
  if (rel.startsWith("/")) return { refused: "absolute name" };
  if (rel.includes("\\")) return { refused: "backslash in name" };
  if (CONTROL_CHARS.test(rel)) return { refused: "control character in name" };
  const segments = rel.split("/");
  for (const seg of segments) {
    if (seg === "") return { refused: "empty path segment" };
    if (seg === "." || seg === "..") return { refused: "'.' or '..' segment" };
    if (Buffer.byteLength(seg) > 255) return { refused: "path segment longer than 255 bytes" };
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

export interface RootCheckDeps {
  tmpDir: string;
  readonlyRoots: string[];
}

/** The two configuration rules: inside tmpdir (strictly), and listed read-only.
 *  Returns the symlink-resolved root to operate on, or a refusal reason. */
export function checkMirrorRoot(
  root: string,
  deps: RootCheckDeps = { tmpDir: os.tmpdir(), readonlyRoots: readonlyWikiRoots() },
): { realRoot: string } | { refused: string } {
  if (!path.isAbsolute(root)) return { refused: "root is not absolute" };
  const realRoot = resolveThroughAncestors(root);
  const realTmp = resolveThroughAncestors(deps.tmpDir);
  if (realRoot === path.parse(realRoot).root) return { refused: "root is the filesystem root" };
  if (realRoot === realTmp) return { refused: "root is the temp directory itself" };
  if (!realRoot.startsWith(realTmp + path.sep)) {
    return { refused: `root is outside the temp directory (${realTmp})` };
  }
  if (!deps.readonlyRoots.some((r) => resolveThroughAncestors(r) === realRoot)) {
    return { refused: "root is not listed in WIKI_READONLY_ROOTS" };
  }
  return { realRoot };
}

/**
 * Create or adopt the root. A missing or EMPTY directory is created/claimed and
 * marked; a marked one is adopted; anything else is refused. Returns the
 * relPaths already on disk that the mirror may manage (valid names only).
 */
export async function prepareMirrorRoot(realRoot: string): Promise<{ files: string[] } | { refused: string }> {
  let st;
  try {
    st = await lstat(realRoot);
  } catch {
    st = null;
  }
  if (st && !st.isDirectory()) return { refused: "root exists and is not a directory" };
  if (!st) {
    await mkdir(realRoot, { recursive: true });
    await writeFile(path.join(realRoot, MIRROR_MARKER), markerBody());
    return { files: [] };
  }
  const entries = await readdir(realRoot);
  if (!entries.includes(MIRROR_MARKER)) {
    if (entries.length > 0) return { refused: `root is not empty and has no ${MIRROR_MARKER} marker` };
    await writeFile(path.join(realRoot, MIRROR_MARKER), markerBody());
    return { files: [] };
  }
  const files: string[] = [];
  await walk(realRoot, "", files);
  return { files };
}

function markerBody(): string {
  return "This directory is owned by muninn's wiki bucket mirror (src/wiki/bucket-mirror.ts).\n" +
    "Files here are created and deleted to match a GCS bucket.\n";
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

/** Write `bytes` to `relPath` atomically: temp file in the same dir + rename. */
export async function atomicWrite(realRoot: string, relPath: string, bytes: Uint8Array): Promise<void> {
  const dir = path.posix.dirname(relPath);
  await ensureDir(realRoot, dir === "." ? "" : dir);
  const final = path.join(realRoot, relPath);
  const tmp = path.join(path.dirname(final), `.${path.basename(final)}${TMP_INFIX}${crypto.randomUUID()}`);
  try {
    await writeFile(tmp, bytes);
    await rename(tmp, final);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Delete one managed file (only a regular file) and prune emptied parent dirs. */
async function removeManaged(realRoot: string, relPath: string): Promise<void> {
  const abs = path.join(realRoot, relPath);
  // A symlinked parent would point the unlink outside the root.
  let cur = realRoot;
  for (const seg of path.posix.dirname(relPath).split("/").filter((s) => s && s !== ".")) {
    cur = path.join(cur, seg);
    const st = await lstat(cur).catch(() => null);
    if (!st) return;
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${cur} is not a plain directory`);
  }
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
    detail = detail.replace(/\s+/g, " ").trim().slice(0, 200);
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

// ── The mirror ───────────────────────────────────────────────────

export interface PollResult {
  listed: number;
  downloaded: number;
  deleted: number;
  skipped: number;
  failed: number;
}

export interface BucketMirrorDeps {
  gcsBase: string;
  intervalMs: number;
  tokens: TokenSource;
  rootCheck?: RootCheckDeps;
  /** Busts the wiki index after a changed poll. */
  refreshIndex?: (root: string) => Promise<unknown>;
}

export class BucketMirror {
  /** relPath → generation last written ("" = on disk, generation unknown). */
  readonly manifest = new Map<string, string>();
  #realRoot: string | null = null;
  #state: "new" | "ready" | "refused" = "new";
  #timer: ReturnType<typeof setTimeout> | null = null;
  #current: Promise<void> | null = null;
  #stopped = false;
  #failures = 0;
  #lastError: string | null = null;
  /** Per-object warnings already emitted (name + generation + reason). */
  #warnedObjects = new Set<string>();

  constructor(readonly entry: WikiBucketMirrorEntry, private readonly deps: BucketMirrorDeps) {}

  get source(): string {
    return `gs://${this.entry.bucket}/${this.entry.prefix}`;
  }

  get state(): "new" | "ready" | "refused" {
    return this.#state;
  }

  /** Apply the safety rules and claim the root. Idempotent. */
  async prepare(): Promise<boolean> {
    if (this.#state !== "new") return this.#state === "ready";
    const checked = checkMirrorRoot(this.entry.root, this.deps.rootCheck);
    const refuse = (reason: string) => {
      this.#state = "refused";
      log.warn("Wiki bucket mirror {source} → {root} refused: {reason}", {
        source: this.source, root: this.entry.root, reason,
      });
      return false;
    };
    if ("refused" in checked) return refuse(checked.refused);
    let prepared;
    try {
      prepared = await prepareMirrorRoot(checked.realRoot);
    } catch (err) {
      return refuse(err instanceof Error ? err.message : String(err));
    }
    if ("refused" in prepared) return refuse(prepared.refused);
    this.#realRoot = checked.realRoot;
    for (const rel of prepared.files) this.manifest.set(rel, "");
    this.#state = "ready";
    log.info("Wiki bucket mirror {source} → {root} ready ({files} file(s) adopted)", {
      source: this.source, root: this.entry.root, files: prepared.files.length,
    });
    return true;
  }

  /** One poll. Throws on a failed listing or credential — having changed nothing. */
  async pollOnce(): Promise<PollResult> {
    if (!(await this.prepare())) throw new Error("mirror refused");
    const realRoot = this.#realRoot!;
    const objects = await this.#listAll();
    const result: PollResult = { listed: objects.length, downloaded: 0, deleted: 0, skipped: 0, failed: 0 };

    // Every validly-named listed object keeps its local file, even one skipped
    // below (oversized): only an object that is GONE is a delete.
    const present = new Set<string>();
    const wanted: { rel: string; obj: GcsObject }[] = [];
    for (const obj of objects) {
      const mapped = objectRelPath(obj.name, this.entry.prefix);
      if ("refused" in mapped) {
        result.skipped++;
        this.#warnObject(obj, mapped.refused);
        continue;
      }
      present.add(mapped.relPath);
      if (obj.size > MAX_OBJECT_BYTES) {
        result.skipped++;
        this.#warnObject(obj, `larger than ${MAX_OBJECT_BYTES} bytes (${obj.size})`);
        continue;
      }
      if (this.manifest.get(mapped.relPath) !== obj.generation) wanted.push({ rel: mapped.relPath, obj });
    }

    for (const { rel, obj } of wanted) {
      try {
        const bytes = await this.#download(obj);
        await atomicWrite(realRoot, rel, bytes);
        this.manifest.set(rel, obj.generation);
        result.downloaded++;
      } catch (err) {
        result.failed++;
        this.#warnObject(obj, err instanceof Error ? err.message : String(err));
      }
    }

    for (const rel of [...this.manifest.keys()]) {
      if (present.has(rel)) continue;
      try {
        await removeManaged(realRoot, rel);
        this.manifest.delete(rel);
        result.deleted++;
      } catch (err) {
        result.failed++;
        log.warn("Wiki bucket mirror {source}: could not delete {rel}: {error}", {
          source: this.source, rel, error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (result.downloaded + result.deleted > 0) {
      await (this.deps.refreshIndex ?? ((root) => getWikiIndex({ root, refresh: true })))(this.entry.root);
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

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    // Bounded: a hung download must not hold shutdown past a pod's grace period.
    // An abandoned poll can at worst leave a hidden temp file, cleaned at next start.
    const current = this.#current;
    if (current) await Promise.race([current.catch(() => {}), Bun.sleep(5_000)]);
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
        if (this.#state === "refused") return;
        this.#failures++;
        const message = err instanceof Error ? err.message : String(err);
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
      const delay = this.#failures === 0
        ? this.deps.intervalMs
        : Math.min(this.deps.intervalMs * 2 ** this.#failures, Math.max(this.deps.intervalMs, MAX_BACKOFF_MS));
      this.#timer = setTimeout(() => this.#tick(), delay);
    });
  }

  #warnObject(obj: GcsObject, reason: string): void {
    const key = `${obj.name}\u0000${obj.generation}\u0000${reason}`;
    if (this.#warnedObjects.has(key)) return;
    this.#warnedObjects.add(key);
    log.warn("Wiki bucket mirror {source}: object {name} skipped: {reason}", {
      source: this.source, name: obj.name, reason,
    });
  }

  /** GET with the bearer token; one retry with a fresh token on 401. */
  async #get(url: string, timeoutMs: number): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const tok = await this.deps.tokens.acquire();
      const res = await fetch(url, {
        headers: tok ? { Authorization: `Bearer ${tok.token}` } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 401 && tok && attempt === 0) {
        await res.body?.cancel().catch(() => {});
        this.deps.tokens.invalidate(tok.generation);
        continue;
      }
      return res;
    }
  }

  async #listAll(): Promise<GcsObject[]> {
    const out: GcsObject[] = [];
    let pageToken: string | undefined;
    const bucketUrl = `${this.deps.gcsBase}/storage/v1/b/${encodeURIComponent(this.entry.bucket)}/o`;
    do {
      const params = new URLSearchParams({ fields: "items(name,generation,size),nextPageToken" });
      if (this.entry.prefix) params.set("prefix", this.entry.prefix);
      if (pageToken) params.set("pageToken", pageToken);
      const res = await this.#get(`${bucketUrl}?${params}`, LIST_TIMEOUT_MS);
      if (!res.ok) throw new GcsHttpError(res.status, `list gs://${this.entry.bucket}`, (await res.text().catch(() => "")).trim());
      const body = (await res.json()) as { items?: { name?: unknown; generation?: unknown; size?: unknown }[]; nextPageToken?: unknown };
      for (const item of body.items ?? []) {
        if (typeof item.name !== "string" || item.generation === undefined) continue;
        out.push({ name: item.name, generation: String(item.generation), size: Number(item.size ?? 0) });
      }
      if (out.length > MAX_OBJECTS) {
        throw new Error(`gs://${this.entry.bucket}/${this.entry.prefix} lists more than ${MAX_OBJECTS} objects — refusing the whole listing`);
      }
      pageToken = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : undefined;
    } while (pageToken);
    return out;
  }

  async #download(obj: GcsObject): Promise<Uint8Array> {
    const url = `${this.deps.gcsBase}/storage/v1/b/${encodeURIComponent(this.entry.bucket)}/o/` +
      `${encodeURIComponent(obj.name)}?alt=media&generation=${encodeURIComponent(obj.generation)}`;
    const res = await this.#get(url, DOWNLOAD_TIMEOUT_MS);
    if (!res.ok) throw new GcsHttpError(res.status, "download", (await res.text().catch(() => "")).trim());
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_OBJECT_BYTES) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`download larger than ${MAX_OBJECT_BYTES} bytes`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_OBJECT_BYTES) throw new Error(`download larger than ${MAX_OBJECT_BYTES} bytes`);
    return bytes;
  }
}

/** Boot entry: one mirror per configured entry, one shared ADC token cache. */
export function startWikiBucketMirrors(config: WikiBucketMirrorConfig): { mirrors: BucketMirror[]; stop(): Promise<void> } {
  for (const { entry, reason } of config.refused) {
    log.warn("WIKI_BUCKET_MIRRORS entry {entry} refused: {reason}", { entry, reason });
  }
  const provider = new GcpTokenProvider(createAdcTokenFetcher("GCS"), "GCS");
  const tokens = tokenSourceFor(config.gcsBase, provider);
  const mirrors = config.mirrors.map((entry) =>
    new BucketMirror(entry, { gcsBase: config.gcsBase, intervalMs: config.intervalMs, tokens }));
  for (const m of mirrors) m.start();
  if (mirrors.length > 0) {
    log.info("Wiki bucket mirrors started: {count}, every {intervalMs} ms from {base}", {
      count: mirrors.length, intervalMs: config.intervalMs, base: config.gcsBase,
    });
  }
  return { mirrors, stop: async () => { await Promise.all(mirrors.map((m) => m.stop())); } };
}
