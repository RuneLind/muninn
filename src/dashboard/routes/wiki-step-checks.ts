/**
 * `GET /api/wiki/step-checks?wiki=&relPath=` (mimir plan
 * muninn-wiki-owner-step-checks, PR 2): the page's owner-step checks answered
 * on this machine (`src/wiki/step-checks/`). It reads one page file and then
 * only reads: `.env` key names, `schema_migrations`, `git` (with one
 * `ls-remote` per repo, the network read). It spawns git, so it is on
 * `SIDE_EFFECTING_GETS`. Registered in the `wiki` group: a pod has no such route.
 *
 * Checks are answered on exactly the pages Done is offered on: the wiki is
 * resolved by Done's own `stepWikiScope`. A read-only root
 * (`WIKI_READONLY_ROOTS`, a page someone else authors) or a wiki outside the
 * triage scope answers 200 with `steps: []` before the page is read, so its
 * page text can make this host run no git and read no `.env`. The one
 * difference from Done: a read-only instance (`MUNINN_WIKI_READONLY`, the
 * mini) still answers, since it writes nothing and answers for its own machine.
 * A page with no checked step answers `steps: []` and runs no probe.
 */

import path from "node:path";
import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { getWikiIndex } from "../../wiki/store.ts";
import { defaultPageWriteIo } from "../../wiki/page-write.ts";
import { answerStepChecks, type AnswerDeps } from "../../wiki/step-checks/answer.ts";
import { realProbeDeps, stepCheckCache } from "../../wiki/step-checks/real-deps.ts";
import { realStepDoneDeps, stepWikiScope, type StepWikiScopeDeps } from "./wiki-step-done.ts";

const log = getLog("dashboard", "wiki-step-checks");

export const STEP_CHECKS_PATH = "/api/wiki/step-checks";

export interface StepChecksRouteDeps {
  scope: StepWikiScopeDeps;
  answer: AnswerDeps;
}

export function realStepChecksDeps(config: Config): StepChecksRouteDeps {
  return { scope: realStepDoneDeps(config), answer: { probes: realProbeDeps(config), machine: config.machine, cache: stepCheckCache } };
}

export function registerWikiStepChecksRoute(app: Hono, config: Config, depsFor: () => StepChecksRouteDeps = () => realStepChecksDeps(config)): void {
  app.get(STEP_CHECKS_PATH, async (c) => {
    const wiki = c.req.query("wiki")?.trim();
    const relPath = c.req.query("relPath")?.trim();
    if (!relPath) return c.json({ error: "relPath is required" }, 400);
    const none = (reason: string) => c.json({ relPath, offered: false, reason, laneRows: [], steps: [] });
    // A page served from an unregistered `WIKI_DIR` has no name to send: Done's list answers it the same way.
    if (!wiki) return none("the wiki has no registry name");
    try {
      const deps = depsFor();
      if (!deps.scope.registry().some((e) => e.name.toLowerCase() === wiki.toLowerCase())) return c.json({ error: `no wiki ${wiki}` }, 404);
      const found = await stepWikiScope(deps.scope, wiki);
      if ("readonlyRoot" in found) return none("the wiki is read-only here");
      if ("outside" in found) return none(found.outside);
      const index = await getWikiIndex({ root: found.entry.root });
      if (!index) return c.json({ error: "wiki directory not found" }, 503);
      const target = index.resolveRelPath(relPath);
      if (!target) return c.json({ error: `no page ${relPath}` }, 404);
      const current = await defaultPageWriteIo(found.entry.root).readFile(path.join(found.entry.root, target.relPath));
      if (current === null) return c.json({ error: `${target.relPath} cannot be read` }, 409);
      return c.json({ relPath: target.relPath, ...(await answerStepChecks(current, deps.answer)) });
    } catch (err) {
      log.error("Step checks failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "the step checks could not be read" }, 500);
    }
  });
}
