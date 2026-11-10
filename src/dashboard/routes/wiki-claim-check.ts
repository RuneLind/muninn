/**
 * `GET /api/wiki/claim-check?wiki=&relPath=` — the claim check for one page
 * (`src/wiki/claim-check.ts`): whether its status lines disagree with GitHub.
 * In the `wiki` tool group beside the Stale check, so `MUNINN_PROFILE=nais`
 * drops it; scoped like `GET /api/wiki/work-map/checks`: `wiki` is required,
 * an unknown wiki is a 404, and a `WIKI_READONLY_ROOTS` root or
 * `WORK_MAP_GH_CHECK=off` answers `notChecked: {reason: "disabled"}` without
 * spawning. It can spawn `gh` (through the work map check's per-wiki cache),
 * so it is on `SIDE_EFFECTING_GETS`.
 */

import type { Hono } from "hono";
import { getLog } from "../../logging.ts";
import { checkPageClaims, disabledClaimBody } from "../../wiki/claim-check.ts";
import { isReadonlyWikiRoot } from "../../wiki/readonly.ts";
import { getWikiRegistry } from "../../wiki/registry-memo.ts";
import { resolveWikiRequest, type WikiRegistryEntry } from "../../wiki/registry.ts";
import { realGhCheckDeps, type GhCheckDeps } from "../../wiki/work-map/gh-check.ts";

const log = getLog("dashboard", "wiki-claim-check");

export interface ClaimCheckRouteDeps {
  registry: () => WikiRegistryEntry[];
  isReadonlyRoot: (root: string) => boolean;
  gh: GhCheckDeps;
  now: () => number;
}

let realDeps: ClaimCheckRouteDeps | null = null;
function realClaimCheckDeps(): ClaimCheckRouteDeps {
  realDeps ??= { registry: () => [...getWikiRegistry()], isReadonlyRoot: isReadonlyWikiRoot, gh: realGhCheckDeps(), now: Date.now };
  return realDeps;
}

export function registerWikiClaimCheckRoute(app: Hono, depsFor: () => ClaimCheckRouteDeps = realClaimCheckDeps): void {
  app.get("/api/wiki/claim-check", async (c) => {
    const deps = depsFor();
    if (!c.req.query("wiki")?.trim()) return c.json({ error: "wiki is required" }, 400);
    const relPath = c.req.query("relPath")?.trim();
    if (!relPath) return c.json({ error: "relPath is required" }, 400);
    const { entry } = resolveWikiRequest(deps.registry(), c.req.query("wiki"), undefined, undefined);
    if (!entry) return c.json({ error: "no wiki configured for that name" }, 404);
    if (deps.gh.disabled() || deps.isReadonlyRoot(entry.root)) return c.json(disabledClaimBody(entry.name, relPath, deps.now()));
    try {
      const body = await checkPageClaims({ wiki: entry.name, root: entry.root, relPath }, deps.gh, deps.now);
      if (!body) return c.json({ error: "no such page in this wiki" }, 404);
      return c.json(body);
    } catch (err) {
      log.warn("The claim check for {wiki} {relPath} failed: {error}", { wiki: entry.name, relPath, error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "the claim check failed" }, 500);
    }
  });
}
