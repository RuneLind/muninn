/**
 * The real readers behind the step-check probes. Read only: one `.env` read
 * (key names leave `envFileKeyNames` and nothing else does), one
 * `schema_migrations` select under a statement timeout, `git` through the
 * triage's runner (allowlisted environment, no prompts, no optional locks)
 * and file mtimes.
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../../config.ts";
import { withStatementTimeout } from "../../db/statement-timeout.ts";
import { parseRepoRoots, realGit } from "../decision-triage/git.ts";
import type { EnvFileRead, ProbeDeps } from "./probes.ts";
import { ProbeCache } from "./answer.ts";

/** The checkout this module was loaded from: `src/wiki/step-checks/` is three levels down. */
const OWN_REPO_DIR = path.resolve(import.meta.dir, "../../..");

/** Bun loads `.env` from the working directory it starts in. */
export async function readDotEnv(dir: string = process.cwd()): Promise<EnvFileRead> {
  try {
    return { text: await Bun.file(path.join(dir, ".env")).text() };
  } catch (err) {
    return (err as { code?: string }).code === "ENOENT" ? { missing: true } : { failed: true };
  }
}

export function realProbeDeps(config: Config): ProbeDeps {
  return {
    git: realGit,
    roots: config.decisionTriageRepoRoots ? parseRepoRoots(config.decisionTriageRepoRoots) : null,
    readEnvFile: () => readDotEnv(),
    processHasEnv: (key) => (process.env[key] ?? "").trim() !== "",
    hasMigration: (version) =>
      withStatementTimeout({ statementTimeoutMs: 2_000 }, async (sql) => (await sql`SELECT 1 FROM schema_migrations WHERE version = ${version} LIMIT 1`).length > 0),
    dashboardPort: config.dashboardPort,
    ownRepoDir: OWN_REPO_DIR,
    // A `bun --watch` reload re-executes the process, which moves this (measured, PR body).
    processStartMs: performance.timeOrigin,
    mtimeMs: async (p) => (await stat(p).catch(() => null))?.mtimeMs ?? null,
  };
}

/** One cache for the process, shared by every request. */
export const stepCheckCache = new ProbeCache();
