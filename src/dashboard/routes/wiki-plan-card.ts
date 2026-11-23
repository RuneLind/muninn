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
 * `<img>` must not start children), and at most one child runs per page: a
 * second request with the same page and arguments while one runs or waits
 * shares it; a request with other arguments starts its own child after every
 * earlier one for the page has EXITED (`runProc` settles a timeout only then).
 * At most {@link PLAN_CARD_MAX_WAITING} argument sets wait per page; one more
 * answers 429. A waiting run whose every requester has gone (the reader aborted
 * the fetch) starts no child. The child runs in the script's own directory, so
 * a `bunfig.toml` in muninn's cwd does not load in it, and leads its own process
 * group, so the timeout's SIGTERM, then SIGKILL, reach what it started. In the
 * `wiki` route group, which `MUNINN_PROFILE=nais` drops.
 */
import path from "node:path";
import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { resolveServingProfile } from "../../config.ts";
import { parseFrontmatter, readWikiPage, resolveWikiRoot } from "../../wiki/store.ts";
import { resolveScopedPage } from "./wiki-read-scope.ts";
import { servesWikiReadSliceOnly } from "../route-groups.ts";
import { PLAN_CARD_MAX_WAITING } from "../../wiki/plan-card-bounds.ts";
import {
  PLAN_CARD_BIN_ENV,
  PLAN_CARD_TIMEOUT_MS,
  isPlanCardId,
  isPlanCardSince,
  planCardConfigFromEnv,
  planCardRootFor,
  type PlanCardConfig,
} from "../../wiki/plan-card.ts";
import { planCardFromOutcome, runPlanCard, type RunOutcome } from "../../wiki/plan-card-run.ts";
import type { runProc } from "../../utils/run-proc.ts";
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
  /** SIGTERM → SIGKILL grace for a timed-out child; default `runProc`'s. */
  killGraceMs?: number;
}

export { PLAN_CARD_MAX_WAITING };

export type { RunOutcome };

/** One page + argument set: its run, whether its child has started, and the
 *  abort signals of the requests waiting on it. */
export interface Flight {
  page: string;
  promise: Promise<RunOutcome>;
  started: boolean;
  signals: AbortSignal[];
}

/**
 * Join the run in flight for `key`, or queue a new one for `page` behind every
 * earlier run for that page; `"busy"` when {@link PLAN_CARD_MAX_WAITING}
 * argument sets already wait. A queued run whose every requester has gone
 * starts nothing and leaves the table AT ONCE, in the same microtask: a request
 * that reaches the table before the run's `finally` would otherwise join it and
 * get its abandoned answer. Exported for the test that interleaves one there.
 */
export function joinPlanCardFlight(
  inFlight: Map<string, Flight>,
  key: string,
  page: string,
  signal: AbortSignal,
  run: () => Promise<RunOutcome>,
): Flight | "busy" {
  const existing = inFlight.get(key);
  if (existing) {
    existing.signals.push(signal);
    return existing;
  }
  const samePage = [...inFlight.values()].filter((f) => f.page === page);
  if (samePage.filter((f) => !f.started).length >= PLAN_CARD_MAX_WAITING) return "busy";
  // Another argument set for the same page: start after every earlier child
  // has exited, so one page never runs two children at once.
  const f: Flight = { page, promise: Promise.resolve({ ok: false, abandoned: true }), started: false, signals: [signal] };
  f.promise = Promise.allSettled(samePage.map((p) => p.promise)).then((): RunOutcome | Promise<RunOutcome> => {
    if (f.signals.every((s) => s.aborted)) {
      if (inFlight.get(key) === f) inFlight.delete(key);
      return { ok: false, abandoned: true };
    }
    f.started = true;
    return run();
  });
  inFlight.set(key, f);
  void f.promise.finally(() => {
    if (inFlight.get(key) === f) inFlight.delete(key);
  });
  return f;
}

export function registerWikiPlanCardRoute(app: Hono, config: Config, deps: PlanCardRouteDeps = {}): void {
  // Single flight per page + argument set: same key ⇒ share the child.
  const inFlight = new Map<string, Flight>();

  app.get(WIKI_PLAN_CARD_PATH, async (c) => {
    // Admin only (D7). The zone model already denies role `user` here (the
    // path is in no user zone); this is the second lock, and with auth off
    // (`role` unset) the viewer is admin.
    if ((c.get("role") ?? "admin") !== "admin") return c.json({ error: "the Agent lens is for admins" }, 403);

    const since = c.req.query("since") ?? "";
    const id = c.req.query("id") ?? "";
    if (since && !isPlanCardSince(since)) return c.json({ error: "since must be a YYYY-MM-DD day" }, 400);
    if (id && !isPlanCardId(id)) return c.json({ error: "id must look like D7, S12, Q-14 or MEL-545776" }, 400);

    const profile = config.profile ?? resolveServingProfile();
    const cfg = deps.config ? deps.config() : planCardConfigFromEnv(process.env, profile);
    if (!cfg.bin) return c.json({ error: `${PLAN_CARD_BIN_ENV} is not set on this instance` }, 501);

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
    const bin = cfg.bin;
    const run = (): Promise<RunOutcome> =>
      // The test seams share the runner's option names (the process runner, the timeout, the interpreter, the kill grace).
      runPlanCard({ ...deps, bin, abs, since, id, port: deps.port ?? config.dashboardPort });
    const flight = joinPlanCardFlight(inFlight, JSON.stringify([abs, since, id]), abs, c.req.raw.signal, run);
    if (flight === "busy") {
      return c.json(
        { error: `plan-card already has ${PLAN_CARD_MAX_WAITING} runs waiting on this page; try again when one has finished`, reason: "busy" },
        429,
      );
    }
    const outcome = await flight.promise;

    const card = planCardFromOutcome(outcome, deps.timeoutMs ?? PLAN_CARD_TIMEOUT_MS);
    if (!card.ok) {
      // 499: only every requester's abort gets here, so nobody reads this answer.
      if (card.status === 499) return c.json({ error: card.error, reason: "cancelled" }, 499 as never);
      if (card.status === 504) {
        log.warn("plan-card {kind}: {error}", { kind: "timed out", error: card.error });
        return c.json({ error: card.error, reason: "timeout" }, 504);
      }
      if (card.exitCode === undefined) log.warn("plan-card {kind}: {error}", { kind: "failed to start", error: card.error });
      return c.json(card.exitCode === undefined ? { error: card.error } : { error: card.error, exitCode: card.exitCode }, 502);
    }
    return c.json({ text: card.text, chars: card.chars, cuts: card.cuts, ms: card.ms });
  });
}
