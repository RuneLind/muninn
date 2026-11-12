/**
 * The real readers behind the step-check probes. Read only: one `.env` read
 * (key names leave `envFileKeyStates` and nothing else does), one
 * `SELECT version FROM schema_migrations` per cache window, cancelled at its
 * bound, and `git` through the triage's runner (allowlisted environment, no
 * prompts, no optional locks).
 */

import path from "node:path";
import type { Config } from "../../config.ts";
import { getDb } from "../../db/client.ts";
import { parseRepoRoots, realGit } from "../decision-triage/git.ts";
import type { EnvFileRead, ProbeDeps } from "./probes.ts";
import { ProbeCache } from "./answer.ts";

/** The applied-set read's bound, the wait for a pool connection included; under the migration probe's 3 s. */
export const MIGRATIONS_READ_MS = 2_000;

/** Bun loads `.env` from the working directory it starts in. */
export async function readDotEnv(dir: string = process.cwd()): Promise<EnvFileRead> {
  try {
    return { text: await Bun.file(path.join(dir, ".env")).text() };
  } catch (err) {
    return (err as { code?: string }).code === "ENOENT" ? { missing: true } : { failed: true };
  }
}

/**
 * A postgres.js query that rejects at `ms` and is cancelled there: still queued
 * for a connection, postgres.js drops it from the pool's queue; running, it
 * asks the server to cancel it. Neither answers late nor holds the pool.
 */
export function cancellableQuery<T>(query: PromiseLike<T> & { cancel(): unknown }, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      Promise.resolve(query.cancel()).catch(() => {});
      reject(new Error(`timed out after ${ms} ms`));
    }, ms);
  });
  return Promise.race([Promise.resolve(query), expiry]).finally(() => clearTimeout(timer));
}

export function realProbeDeps(config: Config): ProbeDeps {
  return {
    git: realGit,
    roots: config.decisionTriageRepoRoots ? parseRepoRoots(config.decisionTriageRepoRoots) : null,
    readEnvFile: () => readDotEnv(),
    processHasEnv: (key) => (process.env[key] ?? "").trim() !== "",
    appliedMigrations: async () => {
      const rows = await cancellableQuery(getDb()<{ version: string }[]>`SELECT version FROM schema_migrations`, MIGRATIONS_READ_MS);
      return new Set(rows.map((r) => r.version));
    },
  };
}

/** One cache for the process, shared by every request. */
export const stepCheckCache = new ProbeCache();
