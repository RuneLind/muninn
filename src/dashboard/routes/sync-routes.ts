/**
 * Repo-sync routes — `GET /api/sync/status` (read-only card feed) and
 * `POST /api/sync/run` (the one code path both triggers use).
 *
 * ONE endpoint, two triggers: the 15-minute launchd job curls exactly the POST
 * the dashboard's "Sync now" / "Sync all" buttons post. There is deliberately no
 * second scheduled path inside muninn — a repo sync that only runs while the
 * process is up is the failure mode this whole loop exists to remove.
 *
 * No auth, like every other dashboard route: the server binds loopback by
 * default and reaches the tailnet only through `tailscale serve`, so the tailnet
 * IS the boundary. Nothing here takes a path from the request — the repo set
 * comes from `SYNC_REPOS`, and `?repo=` only SELECTS from it.
 *
 * Never 5xx: a degraded repo is a card state, not an HTTP failure.
 */

import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { findSyncRepo, getSyncRepos } from "../../sync/config.ts";
import {
  defaultSyncDeps,
  readRepoStatus,
  runSync,
  type RepoSyncResult,
} from "../../sync/run.ts";
import { activityLog } from "../../observability/activity-log.ts";
import { getLog } from "../../logging.ts";

const log = getLog("dashboard", "sync");

/**
 * Read the `?dry-run` flag.
 *
 * The first cut tested `=== "1"`, so `?dry-run=true` and a bare `?dry-run` both
 * ran FOR REAL — a silent misread of the one flag whose entire job is "change
 * nothing", on the one route that commits and pushes. Ambiguity therefore 400s
 * rather than falling through to the destructive branch; a bare `?dry-run`
 * (empty value) is the usual "flag present" spelling and counts as dry.
 */
export function parseDryRunParam(
  raw: string | undefined,
): { ok: true; dryRun: boolean } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, dryRun: false };
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "1" || v === "true") return { ok: true, dryRun: true };
  return {
    ok: false,
    error: `invalid dry-run value "${raw}" — use "1", "true", or the bare flag (omit it to sync for real)`,
  };
}

/** The card row for a repo whose status read THREW — see the GET handler. */
function errorRow(repo: { name: string; mode: RepoSyncResult["mode"]; path: string }, message: string): RepoSyncResult {
  return {
    name: repo.name,
    mode: repo.mode,
    path: repo.path,
    branch: null,
    onDefaultBranch: false,
    upstream: null,
    upstreamFallback: false,
    ahead: null,
    behind: null,
    dirtyCount: 0,
    warnings: [],
    remoteCommitMs: null,
    lastFetchMs: null,
    state: "error",
    reason: message,
    error: message,
    tone: "bad",
    label: `error: ${message}`,
    dryRun: false,
    committed: [],
    deferredFiles: [],
    denied: [],
    rebased: false,
    pushed: false,
    actions: [],
    durationMs: 0,
    lastRunMs: null,
    lastSuccessMs: null,
    consecutiveDeferrals: 0,
  };
}

export function registerSyncRoutes(app: Hono, config: Config): void {
  const deps = defaultSyncDeps(config.knowledgeApiUrl);

  /**
   * The card feed. Fetch-FREE by design (see `readRepoStatus`): ahead/behind and
   * the remote commit date are measured against the last-fetched ref and paired
   * with the last sync time, so a stale view reads as stale instead of as
   * "in sync". A poll that fetched would spend network per open tab.
   */
  app.get("/api/sync/status", async (c) => {
    const { repos, warnings } = getSyncRepos();
    const now = Date.now();
    const out: RepoSyncResult[] = [];
    const errors: string[] = [];
    for (const repo of repos) {
      try {
        out.push(await readRepoStatus(repo, now));
      } catch (err) {
        // A repo that cannot be READ still has to appear, as an error row. The
        // family's `errors[]` convention plus a visible row — dropping it made a
        // broken repo look exactly like an unconfigured one (the card simply
        // stopped listing it, which reads as "not set up" rather than "broken").
        const message = err instanceof Error ? err.message : String(err);
        log.warn("Sync status failed for {name}: {error}", { name: repo.name, error: message });
        errors.push(`${repo.name}: ${message}`);
        out.push(errorRow(repo, message));
      }
    }
    return c.json({ repos: out, warnings, errors, configured: repos.length > 0 });
  });

  /**
   * Run the loop. `?repo=<name>` scopes it to one configured repo (the per-row
   * "Sync now"); omitted ⇒ every repo ("Sync all" and the launchd tick).
   * `?dry-run=1` reports what WOULD be committed / rebased / pushed and touches
   * nothing — including the ledger, so a dry run can never reset the deferral
   * streak or clear the error the card is showing.
   */
  app.post("/api/sync/run", async (c) => {
    const { repos, warnings } = getSyncRepos();
    const dry = parseDryRunParam(c.req.query("dry-run") ?? c.req.query("dryRun"));
    if (!dry.ok) return c.json({ repos: [], warnings, error: dry.error }, 400);
    const dryRun = dry.dryRun;
    const wanted = c.req.query("repo");

    let selected = repos;
    if (wanted) {
      const one = findSyncRepo(repos, wanted);
      if (!one) {
        return c.json({ repos: [], warnings, error: `no SYNC_REPOS entry named "${wanted}"` }, 400);
      }
      selected = [one];
    }
    if (selected.length === 0) {
      return c.json({
        repos: [],
        warnings,
        configured: false,
        error: "SYNC_REPOS is not configured on this instance",
      });
    }

    const report = await runSync(selected, deps, { dryRun, warnings });
    if (!dryRun) {
      activityLog.push(
        "system",
        `Repo sync: ${report.repos.map((r) => `${r.name} ${r.label}`).join(" · ")}`,
        {
          metadata: {
            source: "sync",
            repos: report.repos.length,
            notable: report.repos.filter((r) => r.state !== "ok" && r.state !== "status-only").length,
          },
        },
      );
    }
    // Every repo answered `running` ⇒ this call did nothing at all, because
    // another tick owns them. 409 is the family's single-flight answer (the
    // claim-retry / share routes), and it keeps the click distinguishable from a
    // real run in the logs. Mixed outcomes stay 200 — some work DID happen.
    const running = report.repos.filter((r) => r.state === "running");
    if (running.length > 0 && running.length === report.repos.length) {
      return c.json(
        {
          ...report,
          configured: true,
          state: "running",
          error: `a sync is already in flight for ${running.map((r) => r.name).join(", ")}`,
        },
        409,
      );
    }
    return c.json({ ...report, configured: true });
  });
}
