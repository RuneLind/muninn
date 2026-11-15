/**
 * `GET /api/wiki/boot-line` (mimir plan «Drain the owner-step queue», P1): the
 * commit this process started from and what has moved in its checkout since
 * (`src/wiki/step-checks/boot-line.ts`), for the Your work card.
 *
 * The local reads run on every request, so a pull shows on the next read; only
 * origin's `ls-remote` answer is cached, 30 seconds, in this route's own cache
 * under its own key. Every git call carries `CHECKOUT_GIT_ENV` and holds one of
 * the probes' shared git slots, and the whole answer is bound by
 * `BOOT_LINE_BOUND_MS`. It spawns git, so it is on `SIDE_EFFECTING_GETS`, and
 * it is admin-only under `MUNINN_AUTH` by default-deny. Registered in the
 * `wiki` group beside the step checks: a pod has no such route, and no `.git`.
 */

import type { Hono } from "hono";
import { getLog } from "../../logging.ts";
import { realGit, type GitRun } from "../../wiki/decision-triage/git.ts";
import { ProbeCache, sharedGitSlots, type ProbeSlots } from "../../wiki/step-checks/answer.ts";
import { bootLineGit, readBootLine } from "../../wiki/step-checks/boot-line.ts";
import { bootRecord, type BootRecord } from "../../wiki/step-checks/boot-record.ts";
import { readOriginHead, type OriginHeadRead } from "../../wiki/step-checks/probes.ts";

const log = getLog("dashboard", "wiki-boot-line");

export const BOOT_LINE_PATH = "/api/wiki/boot-line";
const ORIGIN_KEY = "boot-line:origin-head";

export interface BootLineRouteDeps {
  record: () => Promise<BootRecord>;
  /** The raw runner: the route adds the env and the slots. */
  git: GitRun;
  slots: ProbeSlots;
  /** Holds origin's answer only. */
  cache: ProbeCache;
  /** The uncached origin read; a test counts its calls. */
  originHead?: OriginHeadRead;
  boundMs?: number;
  now?: () => number;
}

const sharedCache = new ProbeCache();

export const realBootLineDeps = (): BootLineRouteDeps => ({ record: bootRecord, git: realGit, slots: sharedGitSlots, cache: sharedCache });

export function registerWikiBootLineRoute(app: Hono, depsFor: () => BootLineRouteDeps = realBootLineDeps): void {
  app.get(BOOT_LINE_PATH, async (c) => {
    try {
      const deps = depsFor();
      const read = deps.originHead ?? readOriginHead;
      const cachedOrigin: OriginHeadRead = (dir, git) => deps.cache.getKey(ORIGIN_KEY, () => read(dir, git));
      const line = await readBootLine(deps.record(), {
        git: bootLineGit(deps.git, deps.slots),
        originHead: cachedOrigin,
        ...(deps.boundMs !== undefined ? { boundMs: deps.boundMs } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      });
      return c.json(line);
    } catch (err) {
      log.error("Boot line failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "the boot line could not be read" }, 500);
    }
  });
}
