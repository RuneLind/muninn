import { parse as parseYaml } from "yaml";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  BenchmarkManifest,
  ImplementationRef,
  RepoRef,
} from "./types.ts";

/**
 * Load and validate a benchmark manifest YAML file.
 *
 * The manifest describes one issue: where the gold lives, which commits to
 * use as worktree base, and which claims are highlighted. See the v2.2 plan
 * §3 for the full schema.
 *
 * Throws on missing required fields or unparseable YAML — manifests should
 * be small enough to fail loud rather than silently.
 */
export async function loadManifest(path: string): Promise<BenchmarkManifest> {
  const text = await readFile(path, "utf8");
  const raw = parseYaml(text) as unknown;

  if (!raw || typeof raw !== "object") {
    throw new Error(`Manifest ${path} did not parse to an object`);
  }

  const m = raw as Partial<BenchmarkManifest>;

  if (typeof m.schemaVersion !== "number") {
    throw new Error(`Manifest ${path} missing schemaVersion`);
  }
  if (m.schemaVersion !== 1) {
    throw new Error(
      `Manifest ${path} has schemaVersion=${m.schemaVersion}, only 1 is supported`,
    );
  }
  if (!m.issueKey || typeof m.issueKey !== "string") {
    throw new Error(`Manifest ${path} missing issueKey`);
  }
  if (!m.gold || typeof m.gold !== "object") {
    throw new Error(`Manifest ${path} missing gold`);
  }
  if (!m.gold.path) {
    throw new Error(`Manifest ${path} missing gold.path`);
  }

  // Resolve gold path against the manifest's directory if relative.
  const manifestDir = resolve(path, "..");
  const goldPath = m.gold.path.startsWith("/")
    ? m.gold.path
    : resolve(manifestDir, m.gold.path);

  return {
    schemaVersion: m.schemaVersion,
    issueKey: m.issueKey,
    title: m.title ?? "",
    category: m.category ?? "",
    gold: { source: m.gold.source ?? "implementeringsplan", path: goldPath },
    repos: normaliseRepos(m.repos),
    baseCommits: m.baseCommits ?? {},
    implementationCommits: normaliseImplementationCommits(m.implementationCommits),
    highlightedClaims: m.highlightedClaims ?? [],
    curationLog: m.curationLog,
  };
}

function normaliseRepos(raw: unknown): RepoRef[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => ({ name: String(r.name), path: String(r.path) }));
}

function normaliseImplementationCommits(
  raw: unknown,
): Record<string, ImplementationRef> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, ImplementationRef> = {};
  for (const [repo, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    if (typeof v.branch !== "string" || typeof v.head !== "string") continue;
    out[repo] = { branch: v.branch, head: v.head };
  }
  return out;
}

/**
 * Find a manifest by issue key. Looks in benchmarks/issues/<key>.yml relative
 * to the muninn repo root.
 */
export async function loadManifestByKey(
  issueKey: string,
  benchmarksDir = "benchmarks",
): Promise<BenchmarkManifest> {
  const path = resolve(benchmarksDir, "issues", `${issueKey}.yml`);
  return loadManifest(path);
}
