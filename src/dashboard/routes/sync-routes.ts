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
    for (const repo of repos) {
      try {
        out.push(await readRepoStatus(repo, now));
      } catch (err) {
        log.warn("Sync status failed for {name}: {error}", {
          name: repo.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return c.json({ repos: out, warnings, configured: repos.length > 0 });
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
    const dryRun = c.req.query("dry-run") === "1" || c.req.query("dryRun") === "1";
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
      const notable = report.repos.filter(
        (r) => r.state !== "ok" && r.state !== "status-only",
      );
      activityLog.push(
        "system",
        `Repo sync: ${report.repos.map((r) => `${r.name} ${r.label}`).join(" · ")}`,
        {
          metadata: {
            source: "sync",
            repos: report.repos.length,
            notable: notable.length,
          },
        },
      );
    }
    return c.json({ ...report, configured: true });
  });
}
