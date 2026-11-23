/**
 * The decision triage's status (PR 2 of mimir plans/muninn-decision-triage-visibility.mdx):
 *
 * - `GET /api/wiki/decision-triage/status?wiki=`: one wiki's last run, its nights
 *   and the next due time (`triageWikiStatus`), for the Your work card's line. The
 *   wikis the decision inbox serves; any other answers 404 as the inbox does.
 * - `GET /api/wiki/decision-triage/overview`: whether the pass is on, the model
 *   switch, the wikis covered and skipped, and each covered wiki's last run, for /models.
 *
 * Both read only the nightly log and the state file: no git, no model, nothing
 * runs. Admin-only by the zone model's default; in the tool group, so nais drops them.
 */

import type { Hono } from "hono";
import { resolveWikiAnswerConfig, type Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { DECISION_TRIAGE_DIR, nightlyLogPath, readLog, triageStateStore } from "../../wiki/decision-triage/log.ts";
import { triagePassView, type TriagePassDeps, type TriagePassView } from "../../wiki/decision-triage/pass.ts";
import { scopeVerdict, triageScope } from "../../wiki/decision-triage/scope.ts";
import { triageWikiStatus, type TriageWikiStatus } from "../../wiki/decision-triage/status.ts";
import { isReadonlyWikiRoot, isWikiReadonly } from "../../wiki/readonly.ts";
import { getWikiRegistry } from "../../wiki/registry-memo.ts";

const log = getLog("dashboard", "wiki-decision-triage-status");

export const TRIAGE_STATUS_PATH = "/api/wiki/decision-triage/status";
export const TRIAGE_OVERVIEW_PATH = "/api/wiki/decision-triage/overview";

export type TriageStatusBody = TriageWikiStatus & { pass: Pick<TriagePassView, "on" | "why" | "modelOff"> };

export interface TriageOverviewBody {
  pass: TriagePassView;
  wikis: Pick<TriageWikiStatus, "wiki" | "lastRun" | "reposNotFound" | "nextDueAt">[];
}

export interface TriageStatusDeps extends TriagePassDeps {
  config: () => Pick<Config, "schedulerEnabled" | "workMapWikis" | "workMapHour" | "workMapModel" | "profile" | "decisionTriageRepoRoots">;
  dir: string;
  now: () => number;
}

export function realTriageStatusDeps(config: Config): TriageStatusDeps {
  return {
    config: () => config,
    dir: DECISION_TRIAGE_DIR,
    now: Date.now,
    registry: getWikiRegistry,
    isReadonly: isWikiReadonly,
    isReadonlyRoot: isReadonlyWikiRoot,
    answerWikis: () => (config.wikiAnswers ?? resolveWikiAnswerConfig()).wikis,
  };
}

async function wikiStatus(wiki: string, deps: TriageStatusDeps): Promise<TriageWikiStatus> {
  const [parsed, state] = await Promise.all([readLog(nightlyLogPath(wiki, deps.dir)), triageStateStore(deps.dir).read(wiki)]);
  return triageWikiStatus(wiki, parsed, state, deps.now(), deps.config().workMapHour);
}

export function registerWikiDecisionTriageStatusRoutes(app: Hono, depsFor: () => TriageStatusDeps): void {
  app.get(TRIAGE_STATUS_PATH, async (c) => {
    const wiki = c.req.query("wiki")?.trim();
    if (!wiki) return c.json({ error: "wiki is required" }, 400);
    const deps = depsFor();
    try {
      const registry = deps.registry();
      // The inbox's own scope check, so the line shows exactly where the inbox does.
      const scope = await triageScope({
        workMapWikis: deps.config().workMapWikis,
        answerWikis: deps.answerWikis(),
        entryOf: (name) => registry.find((e) => e.name.toLowerCase() === name.toLowerCase()),
        isReadonlyRoot: deps.isReadonlyRoot,
      });
      const verdict = scopeVerdict(scope, wiki);
      if ("reason" in verdict) return c.json({ error: `no decision triage here: ${verdict.reason}` }, 404);
      const [status, pass] = await Promise.all([wikiStatus(verdict.entry.name, deps), triagePassView(deps.config(), deps)]);
      const covered = pass.covered.includes(verdict.entry.name);
      const why = pass.why ?? (covered ? null : "the pass does not cover this wiki");
      const body: TriageStatusBody = { ...status, pass: { on: why === null, why, modelOff: pass.modelOff } };
      return c.json(body);
    } catch (err) {
      log.error("The triage status for {wiki} failed: {error}", { wiki, error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "the triage status could not be read" }, 500);
    }
  });

  app.get(TRIAGE_OVERVIEW_PATH, async (c) => {
    const deps = depsFor();
    try {
      const pass = await triagePassView(deps.config(), deps);
      const wikis = await Promise.all(
        pass.covered.map(async (w) => {
          const { wiki, lastRun, reposNotFound, nextDueAt } = await wikiStatus(w, deps);
          return { wiki, lastRun, reposNotFound, nextDueAt };
        }),
      );
      const body: TriageOverviewBody = { pass, wikis };
      return c.json(body);
    } catch (err) {
      log.error("The triage overview failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "the triage overview could not be read" }, 500);
    }
  });
}
