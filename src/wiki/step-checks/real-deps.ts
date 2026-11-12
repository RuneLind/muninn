/**
 * The real readers behind the step-check probes. Read only: one `.env` read
 * (key names leave `envFileKeyStates` and nothing else does), one
 * `SELECT version FROM schema_migrations` per cache window under a server-side
 * statement timeout, `git` through the triage's runner (allowlisted
 * environment, no prompts, no optional locks), and for `restart=` the boot
 * fingerprint's inputs as bytes (hashed, never decoded or logged).
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../../config.ts";
import { withStatementTimeout } from "../../db/statement-timeout.ts";
import { parseRepoRoots, realGit } from "../decision-triage/git.ts";
import type { EnvFileRead, ProbeDeps, RestartDeps } from "./probes.ts";
import { ProbeCache } from "./answer.ts";
import { MUNINN_CHECKOUT, bootState, bundleRecords, scheduleBootFingerprint, sha256Hex, takeDiskSnapshot, type FileRead, type FingerprintIo, type FingerprintSources } from "./boot-fingerprint.ts";

/** The applied-set read's server-side statement timeout; under the migration probe's 3 s. The wait for a pool connection is not inside it. */
export const MIGRATIONS_READ_MS = 2_000;

/** Bun loads `.env` from the working directory it starts in. Raw bytes: `.text()` would strip a BOM and decode UTF-16 that Bun's loader does not. */
export async function readDotEnv(dir: string = process.cwd()): Promise<EnvFileRead> {
  try {
    return { bytes: await Bun.file(path.join(dir, ".env")).bytes() };
  } catch (err) {
    return (err as { code?: string }).code === "ENOENT" ? { missing: true } : { failed: true };
  }
}

/**
 * Every applied migration version, in a `SET LOCAL statement_timeout`
 * transaction. Never cancelled from the client: a postgres.js `cancel()` on a
 * pipelined query lands on whatever its backend runs then, usually another
 * caller's statement (reproduced). The probe answers `unknown` at its own bound
 * by a timer race and leaves this read to finish; it may wait in the pool's
 * queue past that bound.
 */
export function readAppliedMigrations(): Promise<Set<string>> {
  return withStatementTimeout({ statementTimeoutMs: MIGRATIONS_READ_MS }, async (sql) => new Set((await sql<{ version: string }[]>`SELECT version FROM schema_migrations`).map((r) => r.version)));
}

/** `ls-files` of the checkout: a few hundred ms is already far over its measured ~15 ms. */
const LS_FILES_MS = 5_000;

const errCode = (err: unknown) => (err as { code?: string }).code;

/** The real filesystem and git behind the fingerprint. Raw bytes only; nothing decoded, nothing logged. */
export const realFingerprintIo: FingerprintIo = {
  async listCheckout(dir) {
    const res = await realGit(dir, ["ls-files", "-z", "-co", "--exclude-standard"], { timeoutMs: LS_FILES_MS });
    if (!res.ok || res.capped || res.exitCode !== 0) return null;
    return res.stdout.split("\0").filter((p) => p !== "");
  },
  async listDir(dir) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return { dirs: entries.filter((e) => e.isDirectory()).map((e) => e.name), files: entries.filter((e) => e.isFile()).map((e) => e.name) };
    } catch (err) {
      return errCode(err) === "ENOENT" || errCode(err) === "ENOTDIR" ? { dirs: [], files: [] } : null;
    }
  },
  async read(file): Promise<FileRead> {
    try {
      return { bytes: await Bun.file(file).bytes() };
    } catch (err) {
      return errCode(err) === "ENOENT" ? { missing: true } : { failed: true };
    }
  },
  async mtimeMs(file) {
    try {
      return (await stat(file)).mtimeMs;
    } catch (err) {
      return errCode(err) === "ENOENT" ? null : "failed";
    }
  },
};

/**
 * Starts the boot fingerprint for this process (`index.ts`, once the dashboard
 * listens). The modules come from `require.cache`, which lists every ES module
 * Bun has loaded (measured, Bun 1.3.10); the start is `performance.timeOrigin`,
 * which a `bun --watch` reload resets.
 */
export function startBootFingerprint(sources: Omit<FingerprintSources, "checkout">, port: number): void {
  scheduleBootFingerprint({ ...sources, checkout: MUNINN_CHECKOUT }, port, realFingerprintIo, { loadedModules: () => Object.keys(require.cache), startedAt: performance.timeOrigin });
}

export function realRestartDeps(): RestartDeps {
  return {
    listenPort: () => bootState().listenPort,
    boot: () => bootState().boot,
    disk: async () => {
      const sources = bootState().sources;
      if (!sources) return { failed: "muninn has not recorded what it fingerprints" };
      const snap = await takeDiskSnapshot(sources, realFingerprintIo);
      return "raced" in snap ? { failed: "the disk could not be fingerprinted" } : snap;
    },
    loadedModules: () => Object.keys(require.cache),
    bundles: bundleRecords,
    hashNow: async (file) => {
      const read = await realFingerprintIo.read(file);
      return "bytes" in read ? sha256Hex(read.bytes) : "missing" in read ? null : "failed";
    },
    checkout: MUNINN_CHECKOUT,
  };
}

export function realProbeDeps(config: Config): ProbeDeps {
  return {
    git: realGit,
    roots: config.decisionTriageRepoRoots ? parseRepoRoots(config.decisionTriageRepoRoots) : null,
    readEnvFile: () => readDotEnv(),
    processHasEnv: (key) => (process.env[key] ?? "").trim() !== "",
    appliedMigrations: readAppliedMigrations,
    restart: realRestartDeps(),
  };
}

/** One cache for the process, shared by every request. */
export const stepCheckCache = new ProbeCache();
