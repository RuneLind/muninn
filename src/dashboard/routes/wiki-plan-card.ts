/**
 * `GET /api/wiki/plan-card?wiki=&relPath=[&since=YYYY-MM-DD][&id=S1]` — the
 * reader's Agent lens (reader-lenses D4, D7). Runs `plan-card.ts` through
 * `PLAN_CARD_BIN` on the page and answers `{text, chars, cuts, ms}`, the card
 * word for word. See `src/wiki/plan-card.ts` for the scope rule and the child
 * environment.
 *
 * Refusals, in order: 403 role not admin · 400 a malformed `since`/`id` (checked
 * before anything reaches argv) · 501 `PLAN_CARD_BIN` unset · 400/404/503 the
 * page ladder `/api/wiki/page` answers · 404 a page outside D7's scope (no
 * `plan_status`, or a wiki root that is not one of plan-card's roots) · 504 the
 * child ran past {@link PLAN_CARD_TIMEOUT_MS} · 502 the child failed or printed
 * no card.
 *
 * It STARTS A PROCESS, so the path is on `SIDE_EFFECTING_GETS` (a cross-site
 * `<img>` must not start children), and at most one child runs per page and
 * argument set: a second request with the same key while one runs waits on it;
 * a request with other arguments starts its own child after it. In the `wiki`
 * route group, which `MUNINN_PROFILE=nais` drops.
 */
import path from "node:path";
import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { resolveServingProfile } from "../../config.ts";
import { parseFrontmatter, readWikiPage, resolveWikiRoot } from "../../wiki/store.ts";
import { resolveScopedPage } from "./wiki-read-scope.ts";
import { servesWikiReadSliceOnly } from "../route-groups.ts";
import {
  PLAN_CARD_BIN_ENV,
  PLAN_CARD_TIMEOUT_MS,
  isPlanCardId,
  isPlanCardSince,
  parsePlanCardJson,
  planCardArgs,
  planCardChildEnv,
  planCardConfigFromEnv,
  planCardRootFor,
  type PlanCardConfig,
} from "../../wiki/plan-card.ts";
import { stampInterpreterArgv } from "./wiki-stamp.ts";
import { ProcTimeoutError, runProc, type ProcResult } from "../../utils/run-proc.ts";
import { getLog } from "../../logging.ts";

const log = getLog("wiki", "plan-card");

export const WIKI_PLAN_CARD_PATH = "/api/wiki/plan-card";

export interface PlanCardRouteDeps {
  config?: () => PlanCardConfig;
  runProc?: typeof runProc;
  timeoutMs?: number;
  /** The interpreter argv before the script. Default: the running Bun with
   *  `--no-env-file`, so Bun does not reload muninn's `.env`. */
  interpreter?: string[];
  /** The port the child's `PLAN_CARD_MUNINN_URL` names; default the config's. */
  port?: number;
}

type RunOutcome = { ok: true; proc: ProcResult; ms: number } | { ok: false; timeout: boolean; message: string };

export function registerWikiPlanCardRoute(app: Hono, config: Config, deps: PlanCardRouteDeps = {}): void {
  // Single flight per page + argument set: same key ⇒ share the running child.
  const inFlight = new Map<string, Promise<RunOutcome>>();

  app.get(WIKI_PLAN_CARD_PATH, async (c) => {
    // Admin only (D7). The zone model already denies role `user` here (the
    // path is in no user zone); this is the second lock, and with auth off
    // (`role` unset) the viewer is admin.
    if ((c.get("role") ?? "admin") !== "admin") return c.json({ error: "the Agent lens is for admins" }, 403);

    const since = c.req.query("since") ?? "";
    const id = c.req.query("id") ?? "";
    if (since && !isPlanCardSince(since)) return c.json({ error: "since must be a YYYY-MM-DD day" }, 400);
    if (id && !isPlanCardId(id)) return c.json({ error: "id must look like D7, S12, Q-14 or MEL-545776" }, 400);

    const cfg = (deps.config ?? planCardConfigFromEnv)();
    if (!cfg.bin) return c.json({ error: `${PLAN_CARD_BIN_ENV} is not set on this instance` }, 501);

    const profile = config.profile ?? resolveServingProfile();
    const page = await resolveScopedPage(servesWikiReadSliceOnly(profile), {
      wiki: c.req.query("wiki"),
      bot: c.req.query("bot"),
      relPath: c.req.query("relPath"),
      name: c.req.query("name"),
    });
    if (!page.ok) return c.json({ error: page.error }, page.status);
    const root = planCardRootFor(resolveWikiRoot(page.entry?.root), cfg.roots);
    if (!root) return c.json({ error: "this wiki is not one of plan-card's roots", reason: "out-of-scope" }, 404);
    const markdown = await readWikiPage(page.index, page.meta);
    if (markdown === null) return c.json({ error: "page file unreadable" }, 503);
    if (parseFrontmatter(markdown).plan_status === undefined) {
      return c.json({ error: "the page carries no plan_status", reason: "out-of-scope" }, 404);
    }

    // plan-card's own spelling of the root, so its containment test agrees.
    const abs = path.join(root, page.meta.relPath);
    const argv = [...(deps.interpreter ?? stampInterpreterArgv(process.execPath)), ...planCardArgs(cfg.bin, abs, { since, id })];
    const key = JSON.stringify([abs, since, id]);
    const run = async (): Promise<RunOutcome> => {
      // Wait for any running child of the same page before starting ours, so
      // one page never runs two children at once.
      const t0 = performance.now();
      try {
        const proc = await (deps.runProc ?? runProc)(argv, deps.timeoutMs ?? PLAN_CARD_TIMEOUT_MS, "plan-card", {
          env: planCardChildEnv(deps.port ?? config.dashboardPort),
        });
        return { ok: true, proc, ms: Math.round(performance.now() - t0) };
      } catch (err) {
        return { ok: false, timeout: err instanceof ProcTimeoutError, message: err instanceof Error ? err.message : String(err) };
      }
    };
    let pending = inFlight.get(key);
    if (!pending) {
      // Another argument set for the same page: start after it settles.
      const samePage = [...inFlight.entries()].filter(([k]) => JSON.parse(k)[0] === abs).map(([, p]) => p);
      pending = Promise.allSettled(samePage).then(run);
      inFlight.set(key, pending);
      void pending.finally(() => {
        if (inFlight.get(key) === pending) inFlight.delete(key);
      });
    }
    const outcome = await pending;

    if (!outcome.ok) {
      log.warn("plan-card {kind}: {error}", { kind: outcome.timeout ? "timed out" : "failed to start", error: outcome.message });
      return outcome.timeout
        ? c.json({ error: `plan-card did not answer within ${Math.round((deps.timeoutMs ?? PLAN_CARD_TIMEOUT_MS) / 1000)} s`, reason: "timeout" }, 504)
        : c.json({ error: outcome.message }, 502);
    }
    const card = parsePlanCardJson(outcome.proc.stdout);
    if (outcome.proc.exitCode !== 0 || !card) {
      let message = outcome.proc.stderr.trim().split("\n")[0] || "plan-card printed no card";
      try {
        const e = JSON.parse(outcome.proc.stdout) as { error?: unknown };
        if (typeof e.error === "string") message = e.error;
      } catch {
        // not JSON: keep stderr's first line
      }
      return c.json({ error: message, exitCode: outcome.proc.exitCode }, 502);
    }
    return c.json({ text: card.text, chars: card.chars, cuts: card.cuts, ms: outcome.ms });
  });
}
