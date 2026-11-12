/**
 * The real readers behind the step-check probes. Read only: one `.env` read
 * (key names leave `envFileKeyStates` and nothing else does), one
 * `SELECT version FROM schema_migrations` per cache window under a server-side
 * statement timeout, and `git` through the triage's runner (allowlisted
 * environment, no prompts, no optional locks).
 */

import path from "node:path";
import type { Config } from "../../config.ts";
import { withStatementTimeout } from "../../db/statement-timeout.ts";
import { parseRepoRoots, realGit } from "../decision-triage/git.ts";
import type { EnvFileRead, ProbeDeps } from "./probes.ts";
import { ProbeCache } from "./answer.ts";

/** The applied-set read's server-side statement timeout; under the migration probe's 3 s. The wait for a pool connection is not inside it. */
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

export function realProbeDeps(config: Config): ProbeDeps {
  return {
    git: realGit,
    roots: config.decisionTriageRepoRoots ? parseRepoRoots(config.decisionTriageRepoRoots) : null,
    readEnvFile: () => readDotEnv(),
    processHasEnv: (key) => (process.env[key] ?? "").trim() !== "",
    appliedMigrations: readAppliedMigrations,
  };
}

/** One cache for the process, shared by every request. */
export const stepCheckCache = new ProbeCache();
