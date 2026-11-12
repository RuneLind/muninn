/**
 * `GET /api/wiki/step-checks?wiki=&relPath=` (mimir plan
 * muninn-wiki-owner-step-checks, PR 2): the page's owner-step checks answered
 * on this machine (`src/wiki/step-checks/`). It reads one page file and then
 * only reads: `.env` key names, `schema_migrations`, `git` (with one
 * `ls-remote` per repo, the network read). It spawns git, so it is on
 * `SIDE_EFFECTING_GETS`. A read-only instance answers it like any other: it
 * writes nothing. A page with no checked step answers `steps: []` and runs
 * no probe. Registered in the `wiki` group: a pod has no such route.
 */

import path from "node:path";
import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { getWikiIndex } from "../../wiki/store.ts";
import { getWikiRegistry } from "../../wiki/registry-memo.ts";
import { defaultPageWriteIo } from "../../wiki/page-write.ts";
import type { WikiRegistryEntry } from "../../wiki/registry.ts";
import { answerStepChecks, type AnswerDeps } from "../../wiki/step-checks/answer.ts";
import { realProbeDeps, stepCheckCache } from "../../wiki/step-checks/real-deps.ts";

const log = getLog("dashboard", "wiki-step-checks");

export const STEP_CHECKS_PATH = "/api/wiki/step-checks";

export interface StepChecksRouteDeps {
  registry: () => readonly WikiRegistryEntry[];
  answer: AnswerDeps;
}

export function realStepChecksDeps(config: Config): StepChecksRouteDeps {
  return { registry: getWikiRegistry, answer: { probes: realProbeDeps(config), machine: config.machine, cache: stepCheckCache } };
}

export function registerWikiStepChecksRoute(app: Hono, config: Config, depsFor: () => StepChecksRouteDeps = () => realStepChecksDeps(config)): void {
  app.get(STEP_CHECKS_PATH, async (c) => {
    const wiki = c.req.query("wiki")?.trim();
    const relPath = c.req.query("relPath")?.trim();
    if (!wiki || !relPath) return c.json({ error: "wiki and relPath are required" }, 400);
    try {
      const deps = depsFor();
      const entry = deps.registry().find((e) => e.name.toLowerCase() === wiki.toLowerCase());
      if (!entry) return c.json({ error: `no wiki ${wiki}` }, 404);
      const index = await getWikiIndex({ root: entry.root });
      if (!index) return c.json({ error: "wiki directory not found" }, 503);
      const target = index.resolveRelPath(relPath);
      if (!target) return c.json({ error: `no page ${relPath}` }, 404);
      const current = await defaultPageWriteIo(entry.root).readFile(path.join(entry.root, target.relPath));
      if (current === null) return c.json({ error: `${target.relPath} cannot be read` }, 409);
      return c.json({ relPath: target.relPath, ...(await answerStepChecks(current, deps.answer)) });
    } catch (err) {
      log.error("Step checks failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "the step checks could not be read" }, 500);
    }
  });
}
