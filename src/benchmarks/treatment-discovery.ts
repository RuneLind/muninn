/**
 * Discover available benchmark issues and treatment files so the dashboard's
 * live-run form can populate its dropdowns without hard-coding paths.
 *
 * Issues: every `benchmarks/issues/<KEY>.yml` that parses as a valid manifest.
 * Treatments: every `benchmarks/treatments/*.json` that parses as a valid
 * treatment. Skips files that fail validation rather than hard-erroring —
 * the dashboard should still render if one file is mis-formatted.
 */

import { readdirSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getLog } from "../logging.ts";
import type { BenchmarkTreatment } from "../db/benchmark-runs.ts";
import { loadManifest } from "./manifest.ts";

const log = getLog("benchmarks", "treatment-discovery");

export interface DiscoveredTreatment {
  /** Absolute path to the treatment JSON file. */
  path: string;
  /** File basename without .json — used as a stable label. */
  label: string;
  treatment: BenchmarkTreatment;
}

export interface DiscoveredIssue {
  issueKey: string;
  title: string;
  manifestPath: string;
  goldPath: string;
  highlightedCount: number;
}

export async function discoverIssues(benchmarksDir = "benchmarks"): Promise<DiscoveredIssue[]> {
  const issuesDir = resolve(benchmarksDir, "issues");
  if (!existsSync(issuesDir)) return [];
  const files = readdirSync(issuesDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  const out: DiscoveredIssue[] = [];
  for (const file of files) {
    const manifestPath = resolve(issuesDir, file);
    try {
      const manifest = await loadManifest(manifestPath);
      out.push({
        issueKey: manifest.issueKey,
        title: manifest.title,
        manifestPath,
        goldPath: manifest.gold.path,
        highlightedCount: manifest.highlightedClaims.length,
      });
    } catch (err) {
      log.warn("Skipping unreadable manifest {path}: {error}", {
        botName: "benchmarks",
        path: manifestPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out.sort((a, b) => a.issueKey.localeCompare(b.issueKey));
}

export async function discoverTreatments(
  benchmarksDir = "benchmarks",
): Promise<DiscoveredTreatment[]> {
  const treatmentsDir = resolve(benchmarksDir, "treatments");
  if (!existsSync(treatmentsDir)) return [];
  const files = readdirSync(treatmentsDir).filter((f) => f.endsWith(".json"));
  const out: DiscoveredTreatment[] = [];
  for (const file of files) {
    const path = resolve(treatmentsDir, file);
    try {
      const text = await readFile(path, "utf8");
      const raw = JSON.parse(text) as Partial<BenchmarkTreatment>;
      if (!raw.connector || !raw.model || !raw.mcpStack || !raw.promptId) {
        log.warn("Skipping malformed treatment {path}", { botName: "benchmarks", path });
        continue;
      }
      out.push({
        path,
        label: file.replace(/\.json$/, ""),
        treatment: {
          connector: raw.connector,
          model: raw.model,
          mcpStack: raw.mcpStack,
          promptId: raw.promptId,
        },
      });
    } catch (err) {
      log.warn("Skipping treatment {path}: {error}", {
        botName: "benchmarks",
        path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}
