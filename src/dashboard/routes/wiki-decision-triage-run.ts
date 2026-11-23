/**
 * `POST /api/wiki/decision-triage/run?wiki=`: Run now (PR 3 of mimir
 * plans/muninn-decision-triage-visibility.mdx). One pass over one wiki through the
 * loop's own half (`TriageLoopDeps.run`), so its run line, state and warnings are a
 * night's (D3), and it answers when the pass ends with the outcome and card count.
 *
 * Refuses: 400 without a wiki; 403 on a readonly instance or root; 404 outside the
 * status line's scope; 409 while the model call is on (D3: a button never spends),
 * while the pass is off for this wiki, or while a pass holds the single-flight the
 * loop shares (`tryHoldTriagePass`). Admin-only by the zone model's default; in the
 * tool group, so nais drops it.
 */

import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { triageLoopDepsFor, tryHoldTriagePass, type TriageLoopDeps, type TriagePassOutcome } from "../../wiki/decision-triage/loop-deps.ts";
import { triagePassView } from "../../wiki/decision-triage/pass.ts";
import { NIGHTLY_MODEL_OFF, scopeVerdict, triageScope } from "../../wiki/decision-triage/scope.ts";
import { wikiNoEgressReason } from "../../wiki/readonly.ts";
import { TRIAGE_PASS_BOUND_MS } from "../../wiki/work-map/loop.ts";
import { requireJsonRequest } from "./json-request.ts";
import { readonlyRefusal } from "./route-utils.ts";
import { realTriageStatusDeps, type TriageStatusDeps } from "./wiki-decision-triage-status.ts";

const log = getLog("dashboard", "wiki-decision-triage-run");

export const TRIAGE_RUN_PATH = "/api/wiki/decision-triage/run";

export type TriageRunBody = { wiki: string } & TriagePassOutcome;

export interface TriageRunDeps extends TriageStatusDeps {
  /** The loop's half, shared with the loop; null when the pass is off. */
  loop: () => TriageLoopDeps | null;
  modelOff: () => boolean;
  hold: () => (() => void) | null;
  /** The pass's wall clock, as the loop's (`TRIAGE_PASS_BOUND_MS`). */
  boundMs: number;
}

export function realTriageRunDeps(config: Config): TriageRunDeps {
  return { ...realTriageStatusDeps(config), loop: () => triageLoopDepsFor(config), modelOff: () => NIGHTLY_MODEL_OFF, hold: tryHoldTriagePass, boundMs: TRIAGE_PASS_BOUND_MS };
}

export function registerWikiDecisionTriageRunRoute(app: Hono, depsFor: () => TriageRunDeps): void {
  app.post(TRIAGE_RUN_PATH, async (c) => {
    const notJson = requireJsonRequest(c);
    if (notJson) return notJson;
    const readonly = readonlyRefusal(c, log);
    if (readonly) return readonly;
    const wiki = c.req.query("wiki")?.trim();
    if (!wiki) return c.json({ error: "wiki is required" }, 400);
    let release: (() => void) | null = null;
    try {
      const deps = depsFor();
      const registry = deps.registry();
      const entryOf = (name: string) => registry.find((e) => e.name.toLowerCase() === name.toLowerCase());
      const named = entryOf(wiki);
      if (named && deps.isReadonlyRoot(named.root)) {
        log.info("Read-only wiki {wiki} refused POST {path}", { wiki: named.name, path: TRIAGE_RUN_PATH });
        return c.json({ error: wikiNoEgressReason(named.name), readonly: true }, 403);
      }
      // The status line's scope, so Run now answers exactly where the line shows.
      const scope = await triageScope({ workMapWikis: deps.config().workMapWikis, answerWikis: deps.answerWikis(), entryOf, isReadonlyRoot: deps.isReadonlyRoot });
      const verdict = scopeVerdict(scope, wiki);
      if ("reason" in verdict) return c.json({ error: `no decision triage here: ${verdict.reason}` }, 404);
      const name = verdict.entry.name;
      if (!deps.modelOff()) return c.json({ error: "the model call is on: Run now never calls the model", modelOn: true }, 409);
      const pass = await triagePassView(deps.config(), deps);
      const loop = deps.loop();
      const off = pass.why ?? (!pass.covered.includes(name) ? "the pass does not cover this wiki" : !loop ? "DECISION_TRIAGE_REPO_ROOTS is not set" : null);
      if (off || !loop) return c.json({ error: `the pass is off: ${off}`, off: true }, 409);
      release = deps.hold();
      if (!release) return c.json({ error: "a triage pass is still running: try again when it has ended", busy: true }, 409);
      // A pass outlives Bun's 255 s idleTimeout only with the timer off for this request.
      (c.env as { timeout?: (req: Request, seconds: number) => void } | undefined)?.timeout?.(c.req.raw, 0);
      // The scope the loop's own check would read, so the run line's floor covers the same wikis.
      await loop.wikis(pass.covered);
      // The bound only aborts: the hold ends in `finally`, once the pass has returned.
      const signal = AbortSignal.timeout(deps.boundMs);
      let res = await loop.run(name, signal);
      if (res.outcome === "aborted" && signal.aborted) {
        const error = `the pass timed out after ${deps.boundMs} ms`;
        res = { outcome: (await loop.recordFailed(name, error)) || "failed", reason: error };
      }
      log.info("Run now for {wiki}: {outcome}, {cards} card(s)", { wiki: name, outcome: res.outcome, cards: res.cards ?? 0 });
      const body: TriageRunBody = { wiki: name, ...res };
      return c.json(body);
    } catch (err) {
      log.error("Run now for {wiki} failed: {error}", { wiki, error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "the triage pass failed" }, 500);
    } finally {
      release?.();
    }
  });
}
