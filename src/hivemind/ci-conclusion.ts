import { $ } from "bun";
import { getLog } from "../logging.ts";

const log = getLog("hivemind", "ci-conclusion");

/**
 * The one irreversible assertion in the dev loop is "spec verified — acceptance
 * criteria met." The orchestrate peer's `<!-- e2e: green -->` marker comes from a
 * freeform autonomous agent, so before flipping the spec we VERIFY (don't trust)
 * by fetching the GitHub Actions run *conclusion* from the CI URL the peer
 * returns. Mechanism is the `gh` CLI (already authed for the user running muninn).
 */

export interface CiConclusion {
  /** GitHub run conclusion: "success" | "failure" | "cancelled" | "timed_out" | … or null while in-progress. */
  conclusion: string | null;
  /** GitHub run status: "completed" | "in_progress" | "queued" | … */
  status: string | null;
  /** The run the conclusion was fetched for. */
  repo: string;
  runId: string;
}

/** A confirmed-green run: GitHub finished it AND it succeeded. The green gate. */
export function isConfirmedGreen(c: CiConclusion | null): boolean {
  return c?.status === "completed" && c?.conclusion === "success";
}

/**
 * Pull the first GitHub Actions run URL out of a freeform peer reply, e.g.
 * `https://github.com/navikt/melosys-api/actions/runs/123456789` →
 * `{ repo: "navikt/melosys-api", runId: "123456789" }`. A trailing `/job/<id>`
 * or `?query` is tolerated. Returns null if the text has no such URL.
 */
export function parseGithubRunUrl(text: string): { repo: string; runId: string } | null {
  const m = text.match(
    /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)/,
  );
  if (!m) return null;
  return { repo: m[1]!, runId: m[2]! };
}

/** Injection seam for tests — defaults to the real `gh` CLI via Bun.$. */
export type GhRunner = (
  repo: string,
  runId: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const defaultGhRunner: GhRunner = async (repo, runId) => {
  const res = await $`gh run view ${runId} --repo ${repo} --json conclusion,status`
    .quiet()
    .nothrow();
  return {
    exitCode: res.exitCode,
    stdout: res.stdout.toString(),
    stderr: res.stderr.toString(),
  };
};

/**
 * Fetch the CI conclusion for the GitHub Actions run URL found in `text` (a
 * freeform peer reply or a bare URL) via `gh run view`. Returns null when no run
 * URL is present, `gh` fails (not installed / not authed / unknown run), or the
 * JSON is unparseable — every failure mode keeps the green gate CLOSED (a null
 * conclusion is never confirmed-green), so a flaky fetch can't hallucinate a
 * verification.
 */
export async function fetchCiConclusion(
  text: string,
  runner: GhRunner = defaultGhRunner,
): Promise<CiConclusion | null> {
  const parsed = parseGithubRunUrl(text);
  if (!parsed) {
    log.warn("No GitHub Actions run URL found in CI reply text", {});
    return null;
  }
  try {
    const { exitCode, stdout, stderr } = await runner(parsed.repo, parsed.runId);
    if (exitCode !== 0) {
      log.warn("gh run view failed (exit {code}) for {repo} run {runId}: {stderr}", {
        code: exitCode, repo: parsed.repo, runId: parsed.runId, stderr: stderr.trim().slice(0, 200),
      });
      return null;
    }
    const json = JSON.parse(stdout) as { conclusion?: string | null; status?: string | null };
    return {
      conclusion: json.conclusion ?? null,
      status: json.status ?? null,
      repo: parsed.repo,
      runId: parsed.runId,
    };
  } catch (err) {
    log.warn("Failed to fetch CI conclusion for {repo} run {runId}: {error}", {
      repo: parsed.repo, runId: parsed.runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
