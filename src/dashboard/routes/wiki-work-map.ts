/**
 * The work map's two routes (`src/wiki/work-map/`), in the `wiki` tool group,
 * so `MUNINN_PROFILE=nais` drops them with the rest of the filesystem-bound
 * wiki surface.
 *
 *  - `GET /api/wiki/work-map?wiki=` reads `.work-map.json` and adds
 *    `organizable` (this instance runs the loop for this wiki) and, on that
 *    instance, the last attempt and its error from the state file. A local
 *    read: no model call, no spawn.
 *  - `POST /api/wiki/work-map/refresh?wiki=[&force=1]` starts a run, or joins
 *    the one in flight, and answers 202 at once — a run can outlast Bun's 255 s
 *    `idleTimeout`, so the card polls the GET. It refuses with 403, before any
 *    model call, unless the `organizable` predicate holds here (the per-wiki
 *    egress guard alone checks only readonly roots), and with 429 when the last
 *    success, or the newest post-model failure, is under 10 minutes old and
 *    the request does not say `force=1`. The 429 is not recorded as an
 *    attempt, so it never touches the loop's retry gate.
 */

import type { Context, Hono } from "hono";
import path from "node:path";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { isReadonlyWikiRoot, wikiNoEgressReason } from "../../wiki/readonly.ts";
import { getWikiRegistry } from "../../wiki/registry-memo.ts";
import { resolveWikiRequest } from "../../wiki/registry.ts";
import { workMapRunDepsFor } from "../../wiki/work-map/loop.ts";
import { startWorkMapRun, workMapOrganizable, workMapRunInFlight, type WorkMapRunDeps } from "../../wiki/work-map/run.ts";
import { parseWorkMap } from "../../wiki/work-map/schema.ts";
import { WORK_MAP_FILE } from "../../wiki/work-map/write.ts";
import { requireJsonRequest } from "./json-request.ts";
import { readonlyRefusal } from "./route-utils.ts";

const log = getLog("dashboard", "wiki-work-map");

/** The ↻ cooldown: a POST under this long after the last success, or after
 *  the START of the last post-model failure (an attempt's `at` is its start),
 *  needs `force=1`. */
export const WORK_MAP_REFRESH_COOLDOWN_MS = 10 * 60_000;

function resolve(c: Context, deps: WorkMapRunDeps) {
  const { entry } = resolveWikiRequest([...deps.registry()], c.req.query("wiki"), c.req.query("bot"), undefined);
  return entry;
}

export function registerWikiWorkMapRoutes(
  app: Hono,
  config: Config,
  depsFor: () => WorkMapRunDeps = () => workMapRunDepsFor(config),
): void {
  app.get("/api/wiki/work-map", async (c) => {
    const deps = depsFor();
    if (!c.req.query("wiki")?.trim()) return c.json({ error: "wiki is required" }, 400);
    const entry = resolve(c, deps);
    if (!entry) return c.json({ error: "no wiki configured for that name" }, 404);
    const text = await deps.readText(path.join(entry.root, WORK_MAP_FILE));
    const map = text === null ? null : parseWorkMap(text);
    const org = workMapOrganizable(entry.name, deps);
    const body: Record<string, unknown> = {
      wiki: entry.name,
      map,
      ...(text !== null && map === null ? { mapError: `${WORK_MAP_FILE} could not be read as a work map` } : {}),
      organizable: org.ok,
    };
    if (!org.ok) body.organizableReason = org.reason;
    else {
      const state = await deps.state.read(entry.name);
      const last = state?.attempts[0];
      if (last) body.lastAttempt = last;
      if (state?.lastSuccessAt !== undefined) body.lastSuccessAt = state.lastSuccessAt;
      const running = workMapRunInFlight(entry.name);
      if (running) body.running = running;
    }
    return c.json(body);
  });

  app.post("/api/wiki/work-map/refresh", async (c) => {
    const notJson = requireJsonRequest(c);
    if (notJson) return notJson;
    const readonly = readonlyRefusal(c, log);
    if (readonly) return readonly;
    const deps = depsFor();
    if (!c.req.query("wiki")?.trim()) return c.json({ error: "wiki is required" }, 400);
    const entry = resolve(c, deps);
    if (!entry) return c.json({ error: "no wiki configured for that name" }, 404);
    // The per-wiki egress prologue, before anything else touches the wiki.
    if ((deps.isReadonlyRoot ?? isReadonlyWikiRoot)(entry.root)) {
      log.info("Read-only wiki {wiki} refused POST /api/wiki/work-map/refresh (no model calls)", { wiki: entry.name });
      return c.json({ error: wikiNoEgressReason(entry.name), readonly: true }, 403);
    }
    const org = workMapOrganizable(entry.name, deps);
    if (!org.ok) return c.json({ error: org.reason, organizable: false }, 403);
    const running = workMapRunInFlight(entry.name);
    if (running) return c.json({ joined: true, startedAt: running.startedAt }, 202);
    const force = c.req.query("force") === "1";
    if (!force) {
      const state = await deps.state.read(entry.name);
      const last = state?.lastSuccessAt;
      const now = deps.now();
      if (last !== undefined && now - last < WORK_MAP_REFRESH_COOLDOWN_MS) {
        return c.json(
          {
            error: "the work map ran less than 10 minutes ago",
            lastSuccessAt: last,
            retryAfterMs: WORK_MAP_REFRESH_COOLDOWN_MS - (now - last),
          },
          429,
        );
      }
      const failedAt = state?.attempts.find((a) => a.outcome === "failed")?.at;
      if (failedAt !== undefined && now - failedAt < WORK_MAP_REFRESH_COOLDOWN_MS) {
        return c.json(
          {
            error: "a work map run that failed started less than 10 minutes ago",
            lastFailedAt: failedAt,
            retryAfterMs: WORK_MAP_REFRESH_COOLDOWN_MS - (now - failedAt),
          },
          429,
        );
      }
    }
    const run = startWorkMapRun(entry.name, deps);
    run.promise.catch(() => {});
    return c.json({ joined: run.joined, startedAt: run.startedAt }, 202);
  });
}
