/**
 * Prompt-file lookups for benchmark cells: jiraAnalysis variants under
 * benchmarks/prompts/, judge prompts under benchmarks/judge-prompts/, and
 * the default user-message text. All paths are anchored to the muninn
 * repo root so they resolve identically whether called from the dashboard
 * or a `bun run` script.
 */

import { resolve, join } from "node:path";
import { readFile } from "node:fs/promises";
import type { BenchmarkManifest } from "./types.ts";

export function buildDefaultMessage(manifest: BenchmarkManifest, dryRun: boolean): string {
  if (dryRun) {
    // Tiny prompt — the dry-run is about plumbing, not real analysis.
    return `[DRY RUN] Analyser kort: ${manifest.issueKey} — ${manifest.title}. Svar i én setning.`;
  }
  return `${manifest.issueKey}: ${manifest.title}`;
}

/**
 * Load a jiraAnalysis prompt variant from benchmarks/prompts/<promptId>.txt.
 * Returns null for the default promptId. Throws loudly on a missing variant
 * file so typos in treatment.promptId don't silently fall back to default.
 */
export async function loadPromptVariant(promptId: string): Promise<string | null> {
  if (promptId === "default") return null;
  const path = promptVariantPath(promptId);
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Treatment requested promptId="${promptId}" but no variant file at ${path}. ` +
          `Create the file or use promptId "default" to fall back to the base bot's prompt.`,
      );
    }
    throw err;
  }
}

/**
 * Resolve the absolute path to a prompt variant file, anchored to the muninn
 * repo root (not cwd). Shared by the runner and the dashboard preview so
 * they agree on where variants live regardless of how the dashboard was
 * launched.
 */
export function promptVariantPath(promptId: string): string {
  const promptsDir = resolve(import.meta.dir, "../../benchmarks/prompts");
  return join(promptsDir, `${promptId}.txt`);
}

export function defaultJudgePromptPath(): string {
  // Highest vN.md in benchmarks/judge-prompts/
  const promptsDir = resolve(import.meta.dir, "../../benchmarks/judge-prompts");
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const files = readdirSync(promptsDir).filter((f: string) => /^v\d+\.md$/.test(f));
  if (files.length === 0) {
    throw new Error(`No judge prompts found in ${promptsDir}`);
  }
  files.sort((a: string, b: string) => {
    const av = parseInt(a.replace(/[^0-9]/g, ""), 10);
    const bv = parseInt(b.replace(/[^0-9]/g, ""), 10);
    return bv - av;
  });
  return join(promptsDir, files[0]!);
}
