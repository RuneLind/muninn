/**
 * What the running muninn loaded, as a content fingerprint, for the `restart=`
 * probe (mimir plan muninn-wiki-owner-step-checks, PR 2b). Dates never prove
 * anything here: they only refuse.
 *
 * - **Inputs** (`inputPaths`): every file `git ls-files -co --exclude-standard`
 *   lists in muninn's checkout (tracked, and untracked but not ignored: git's
 *   own ignore rules rather than a second walker that would disagree with
 *   them), every `.env` file Bun may load from the working directory, and per
 *   bot directory the files discovery reads once at boot (`CLAUDE.md`,
 *   `config.json`, `.mcp.json`, `.claude/settings*.json`, `prompts/*.md`).
 *   The fingerprint is sha256 over sorted path + content hash; an absent input
 *   counts as absent. It never leaves the process.
 * - **The boot race.** Modules are read before any of this runs. A file whose
 *   mtime is later than (`performance.timeOrigin` − {@link RACE_MARGIN_MS}),
 *   read AFTER its bytes were hashed, marks the boot fingerprint unproven for
 *   the life of the process. Every module loaded before the fingerprint must be
 *   one of its inputs; one loaded after it is late and unproven at the probe.
 * - **Browser bundles** are built by `Bun.build` from files the runtime never
 *   loads, so `bun --watch` never reloads on them and a memoized bundle can
 *   differ from the disk. {@link bundleRecorderPlugin} reads each checkout
 *   source itself, records the hash of exactly the bytes it hands the bundler,
 *   and the probe requires every recorded hash to equal the disk.
 *
 * Under `bun --watch` a reload re-evaluates every module in the same pid with a
 * new `performance.timeOrigin` (measured on Bun 1.3.10), so this state resets
 * with it.
 */

import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { BunPlugin } from "bun";

/** muninn's own checkout: three levels above this file, symlinks resolved (module keys and bundler paths are real paths). */
export const MUNINN_CHECKOUT = realpathSync(path.resolve(import.meta.dir, "../../.."));

/** An input whose mtime is later than the process start minus this refuses the boot fingerprint: covers a 1 s mtime granularity, and a FAT volume's 2 s. */
export const RACE_MARGIN_MS = 2_000;
/** How long after the dashboard listens the boot fingerprint is taken: boot's own dynamic imports land first, so they are not late. */
export const BOOT_FINGERPRINT_DELAY_MS = 2_000;
/** Files read at once while fingerprinting. */
const READ_CONCURRENCY = 32;

/** Every `.env` file Bun may load from its working directory, whatever `NODE_ENV` is. */
export const ENV_FILES = [".env", ".env.local", ".env.development", ".env.production", ".env.test", ".env.development.local", ".env.production.local", ".env.test.local"] as const;
/** What bot discovery reads once at boot in each bot directory (`discoverBotsInternal`, `serena/config.ts`), besides `prompts/*.md`. */
export const BOT_FILES = ["CLAUDE.md", "config.json", ".mcp.json", ".claude/settings.json", ".claude/settings.local.json"] as const;

export type FileRead = { bytes: Uint8Array } | { missing: true } | { failed: true };

export interface FingerprintIo {
  /** `git ls-files -z -co --exclude-standard` in `dir`, relative paths; null on any failure. */
  listCheckout(dir: string): Promise<string[] | null>;
  /** `dir`'s subdirectories and regular files by name; empty when `dir` does not exist; null on another failure. */
  listDir(dir: string): Promise<{ dirs: string[]; files: string[] } | null>;
  read(file: string): Promise<FileRead>;
  /** null when the file does not exist. */
  mtimeMs(file: string): Promise<number | null | "failed">;
}

export interface FingerprintSources {
  /** muninn's own checkout. */
  checkout: string;
  /** Where Bun loaded `.env` from: the working directory. */
  envDir: string;
  /** The bots root discovery walked (`MUNINN_BOTS_DIR`, else the checkout's `bots/`). */
  botsDir: string;
}

export interface DiskSnapshot {
  fingerprint: string;
  /** sha256 hex per input by absolute path; null for an absent input. */
  hashes: ReadonlyMap<string, string | null>;
}

export type BootFingerprint = { proven: true; snapshot: DiskSnapshot; modules: ReadonlySet<string> } | { proven: false; why: string };

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The absolute paths fingerprinted, or why they cannot be listed. */
export async function inputPaths(src: FingerprintSources, io: FingerprintIo): Promise<string[] | { failed: string }> {
  const listed = await io.listCheckout(src.checkout);
  if (!listed) return { failed: "git could not list muninn's checkout" };
  const out = new Set(listed.map((rel) => path.join(src.checkout, rel)));
  for (const name of ENV_FILES) out.add(path.join(src.envDir, name));
  const bots = await io.listDir(src.botsDir);
  if (!bots) return { failed: "the bots directory could not be listed" };
  for (const bot of bots.dirs) {
    const dir = path.join(src.botsDir, bot);
    for (const name of BOT_FILES) out.add(path.join(dir, name));
    const prompts = await io.listDir(path.join(dir, "prompts"));
    if (!prompts) return { failed: "a bot's prompts directory could not be listed" };
    for (const f of prompts.files) if (f.endsWith(".md")) out.add(path.join(dir, "prompts", f));
  }
  return [...out].sort();
}

export function fingerprintOf(hashes: ReadonlyMap<string, string | null>): string {
  const h = createHash("sha256");
  for (const file of [...hashes.keys()].sort()) h.update(`${file}\0${hashes.get(file) ?? "-"}\n`);
  return h.digest("hex");
}

/**
 * Every input hashed now. With `raceSince`, each file's mtime is read after its
 * bytes, and one later than `raceSince` answers `raced`: an edit landing
 * between the hash and the stat is still seen.
 */
export async function takeDiskSnapshot(src: FingerprintSources, io: FingerprintIo, opts: { raceSince?: number } = {}): Promise<DiskSnapshot | { failed: string } | { raced: true }> {
  const files = await inputPaths(src, io);
  if (!Array.isArray(files)) return files;
  const hashes = new Map<string, string | null>();
  let failed = false;
  let raced = false;
  for (let i = 0; i < files.length && !failed && !raced; i += READ_CONCURRENCY) {
    await Promise.all(
      files.slice(i, i + READ_CONCURRENCY).map(async (file) => {
        const read = await io.read(file);
        if ("failed" in read) return void (failed = true);
        hashes.set(file, "bytes" in read ? sha256Hex(read.bytes) : null);
        if (opts.raceSince === undefined) return;
        const m = await io.mtimeMs(file);
        if (m === "failed") failed = true;
        else if (m !== null && m > opts.raceSince) raced = true;
      }),
    );
  }
  if (failed) return { failed: "a file muninn fingerprints could not be read" };
  if (raced) return { raced: true };
  return { fingerprint: fingerprintOf(hashes), hashes };
}

const NODE_MODULES = `${path.sep}node_modules${path.sep}`;

/**
 * The module keys that are muninn's own files: absolute paths not inside any
 * `node_modules` (a worktree resolves its dependencies from the main
 * checkout's, measured). Builtins (`bun:`, `node:`) have no path.
 * Dependencies are not fingerprinted (`bun.lock` is, as a tracked file).
 */
export function accountableModules(keys: readonly string[]): string[] {
  return keys.filter((k) => path.isAbsolute(k) && !k.includes(NODE_MODULES));
}

/** Modules loaded after the boot fingerprint: their bytes at load time are unknown. */
export function lateModules(keys: readonly string[], boot: ReadonlySet<string>): string[] {
  return accountableModules(keys).filter((k) => !boot.has(k));
}

/**
 * The boot fingerprint: the modules loaded so far, then every input hashed with
 * the race check against `startedAt` (`performance.timeOrigin`). Unproven when
 * an input changed within {@link RACE_MARGIN_MS} of the start or later, when it
 * cannot be read, or when a loaded module is not an input with content.
 */
export async function takeBootFingerprint(src: FingerprintSources, io: FingerprintIo, loadedModules: () => string[], startedAt: number): Promise<BootFingerprint> {
  // Listed BEFORE hashing: a module in this set was read before its bytes were hashed.
  const modules = accountableModules(loadedModules());
  const snap = await takeDiskSnapshot(src, io, { raceSince: startedAt - RACE_MARGIN_MS });
  if ("raced" in snap) return { proven: false, why: "a file changed while muninn was starting, so what it loaded is not proven: restart" };
  if ("failed" in snap) return { proven: false, why: `muninn could not fingerprint what it loaded: ${snap.failed}` };
  if (modules.some((m) => !snap.hashes.get(m))) return { proven: false, why: "muninn loaded a file its fingerprint does not cover" };
  return { proven: true, snapshot: snap, modules: new Set(modules) };
}

// ── process state ────────────────────────────────────────────────────────

interface BootState {
  sources: FingerprintSources | null;
  listenPort: number | null;
  boot: Promise<BootFingerprint> | null;
}

const state: BootState = { sources: null, listenPort: null, boot: null };
const bundleInputs = new Map<string, Set<string>>();
let bundleUnaccounted = false;

/** Called once the dashboard listens: records the port and the sources, and takes the boot fingerprint `delayMs` later. */
export function scheduleBootFingerprint(sources: FingerprintSources, port: number, io: FingerprintIo, opts: { delayMs?: number; loadedModules: () => string[]; startedAt: number }): void {
  state.sources = sources;
  state.listenPort = port;
  const timer = setTimeout(() => {
    state.boot = takeBootFingerprint(sources, io, opts.loadedModules, opts.startedAt).catch(() => ({ proven: false as const, why: "muninn could not fingerprint what it loaded" }));
  }, opts.delayMs ?? BOOT_FINGERPRINT_DELAY_MS);
  timer.unref?.();
}

export const bootState = (): Readonly<BootState> => state;

export const bundleRecords = (): { inputs: ReadonlyMap<string, ReadonlySet<string>>; unaccounted: boolean } => ({ inputs: bundleInputs, unaccounted: bundleUnaccounted });

/** One bundler input: the hash of exactly the bytes handed to `Bun.build`. */
export function recordBundleInput(file: string, bytes: Uint8Array): void {
  const set = bundleInputs.get(file) ?? new Set<string>();
  set.add(sha256Hex(bytes));
  bundleInputs.set(file, set);
}

/**
 * A `Bun.build` plugin that hands the bundler each of muninn's own sources
 * itself and records their hashes. A dependency (any path inside a
 * `node_modules`) falls through to Bun's loader (dependencies are not
 * fingerprinted); any other input, or one in another namespace, marks the
 * bundles unaccounted and falls through.
 */
export function bundleRecorderPlugin(checkout: string): BunPlugin {
  const own = checkout + path.sep;
  return {
    name: "muninn-bundle-recorder",
    setup(build) {
      build.onLoad({ filter: /.*/ }, (args) => {
        if (args.namespace === "file" && args.path.includes(NODE_MODULES)) return undefined;
        if (args.namespace !== "file" || !args.path.startsWith(own)) {
          bundleUnaccounted = true;
          return undefined;
        }
        const bytes = readFileSync(args.path);
        recordBundleInput(args.path, bytes);
        return { contents: bytes, loader: args.loader };
      });
    },
  };
}

/** Test seam: forget the process state. */
export function resetBootStateForTest(): void {
  state.sources = null;
  state.listenPort = null;
  state.boot = null;
  bundleInputs.clear();
  bundleUnaccounted = false;
}
