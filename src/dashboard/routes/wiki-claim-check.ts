/**
 * `GET /api/wiki/claim-check?wiki=&relPath=` — the status date check for one
 * page (`src/wiki/status-date-check.ts`): is its `status_date` older than the
 * newest merge among its `prs:`? In the `wiki` tool group beside the Stale
 * routes, so `MUNINN_PROFILE=nais` drops it.
 *
 * Answers in this order: a missing parameter 400; an unknown wiki 404; an
 * unknown page 404 (looked up before the gate, so a read-only root still
 * 404s); a page other than `.md`/`.mdx` 400; a page the work map card's check
 * does not read (`isLiveCheckPage`) `notChecked: not-live`, with no spawn and
 * whatever the gate says; then the work map's `gh` gate
 * (`workMapGhGate`, the code `GET /api/wiki/work-map/checks` runs), which
 * answers `notChecked: disabled` with no spawn. It can spawn `gh`, so it is on
 * `SIDE_EFFECTING_GETS`.
 */

import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { resolveWikiRequest } from "../../wiki/registry.ts";
import { splitFrontmatter } from "../../wiki/page-text.ts";
import { checkStatusDate, disabledStatusDateBody, isStatusDatePage, notLiveStatusDateBody } from "../../wiki/status-date-check.ts";
import { getWikiIndex, readWikiPage, type WikiIndex, type WikiPageMeta } from "../../wiki/store.ts";
import { workMapRunDepsFor } from "../../wiki/work-map/loop.ts";
import { workMapGhGate, type WorkMapRunDeps } from "../../wiki/work-map/run.ts";

const log = getLog("dashboard", "wiki-claim-check");

export interface ClaimCheckRouteDeps {
  /** The work map's deps: the registry, the clock and the `gh` gate's inputs. */
  workMap: () => WorkMapRunDeps;
  index: (root: string) => Promise<WikiIndex | null>;
  /** The page's text, for its raw frontmatter; defaults to `readWikiPage`. */
  readPage?: (index: WikiIndex, meta: WikiPageMeta) => Promise<string | null>;
}

export function registerWikiClaimCheckRoute(
  app: Hono,
  config: Config,
  deps: ClaimCheckRouteDeps = { workMap: () => workMapRunDepsFor(config), index: (root) => getWikiIndex({ root }) },
): void {
  app.get("/api/wiki/claim-check", async (c) => {
    const wm = deps.workMap();
    if (!c.req.query("wiki")?.trim()) return c.json({ error: "wiki is required" }, 400);
    const relPath = c.req.query("relPath")?.trim();
    if (!relPath) return c.json({ error: "relPath is required" }, 400);
    const { entry } = resolveWikiRequest([...wm.registry()], c.req.query("wiki"), undefined, undefined);
    if (!entry) return c.json({ error: "no wiki configured for that name" }, 404);
    try {
      const index = await deps.index(entry.root);
      const meta = index?.resolveRelPath(relPath);
      if (!meta) return c.json({ error: "no such page in this wiki" }, 404);
      if (!isStatusDatePage(meta.relPath)) return c.json({ error: "only .md and .mdx pages carry a status date" }, 400);
      const notLive = notLiveStatusDateBody(entry.name, meta, wm.now());
      if (notLive) return c.json(notLive);
      const gate = await workMapGhGate(entry, wm);
      if (!gate.ok) return c.json(disabledStatusDateBody(entry.name, meta.relPath, wm.now()));
      const text = await (deps.readPage ?? readWikiPage)(index!, meta);
      const frontmatter = text === null ? null : splitFrontmatter(text).frontmatter;
      return c.json(await checkStatusDate({ wiki: entry.name, meta, frontmatter }, gate.gh, wm.now));
    } catch (err) {
      log.warn("The status date check for {wiki} {relPath} failed: {error}", { wiki: entry.name, relPath, error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "the status date check failed" }, 500);
    }
  });
}
