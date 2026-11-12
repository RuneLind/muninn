/**
 * The real readers behind the step-check probes. Read only: one `.env` read
 * (key names leave `envFileKeyStates` and nothing else does), one
 * `schema_migrations` select under a statement timeout and `git` through the
 * triage's runner (allowlisted environment, no prompts, no optional locks).
 */

import path from "node:path";
import type { Config } from "../../config.ts";
import { withStatementTimeout } from "../../db/statement-timeout.ts";
import { parseRepoRoots, realGit } from "../decision-triage/git.ts";
import type { EnvFileRead, ProbeDeps } from "./probes.ts";
import { ProbeCache } from "./answer.ts";

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
  };
}

/** One cache for the process, shared by every request. */
export const stepCheckCache = new ProbeCache();
