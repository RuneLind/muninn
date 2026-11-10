/**
 * `GET /api/wiki/claim-check?wiki=&relPath=` — the status date check for one
 * page (`src/wiki/status-date-check.ts`): is its `status_date` older than the
 * newest merge among its `prs:`? In the `wiki` tool group beside the Stale
 * routes, so `MUNINN_PROFILE=nais` drops it.
 *
 * A plain read: the page's index entry and the PR states a request for the
 * work map card's check (`GET /api/wiki/work-map/checks`) left in the wiki's
 * two caches. It asks GitHub
 * nothing and spawns nothing, so it is not on `SIDE_EFFECTING_GETS`.
 *
 * Answers in this order: a missing parameter 400; an unknown wiki 404; an
 * unknown page 404; a page other than `.md`/`.mdx` 400; then the verdict
 * (`late`, `clear`, or `notChecked` with a reason).
 */

import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { resolveWikiRequest } from "../../wiki/registry.ts";
import { checkStatusDate, isStatusDatePage } from "../../wiki/status-date-check.ts";
import { getWikiIndex, type WikiIndex } from "../../wiki/store.ts";
import { workMapRunDepsFor } from "../../wiki/work-map/loop.ts";
import type { WorkMapRunDeps } from "../../wiki/work-map/run.ts";

const log = getLog("dashboard", "wiki-claim-check");

export interface ClaimCheckRouteDeps {
  /** The registry and the clock the work map's routes use, so the wiki's name is the cache's key. */
  workMap: () => Pick<WorkMapRunDeps, "registry" | "now">;
  index: (root: string) => Promise<WikiIndex | null>;
}

export function registerWikiClaimCheckRoute(
  app: Hono,
  config: Config,
  deps: ClaimCheckRouteDeps = { workMap: () => workMapRunDepsFor(config), index: (root) => getWikiIndex({ root }) },
): void {
  app.get("/api/wiki/claim-check", async (c) => {
    const wiki = c.req.query("wiki")?.trim();
    if (!wiki) return c.json({ error: "wiki is required" }, 400);
    const relPath = c.req.query("relPath")?.trim();
    if (!relPath) return c.json({ error: "relPath is required" }, 400);
    try {
      const wm = deps.workMap();
      const { entry } = resolveWikiRequest([...wm.registry()], c.req.query("wiki"), undefined, undefined);
      if (!entry) return c.json({ error: "no wiki configured for that name" }, 404);
      const index = await deps.index(entry.root);
      const meta = index?.resolveRelPath(relPath);
      if (!meta) return c.json({ error: "no such page in this wiki" }, 404);
      if (!isStatusDatePage(meta.relPath)) return c.json({ error: "only .md and .mdx pages carry a status date" }, 400);
      return c.json(checkStatusDate({ wiki: entry.name, meta }, wm.now()));
    } catch (err) {
      log.warn("The status date check for {wiki} {relPath} failed: {error}", { wiki, relPath, error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "the status date check failed" }, 500);
    }
  });
}
