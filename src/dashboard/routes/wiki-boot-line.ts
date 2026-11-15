/**
 * `GET /api/wiki/boot-line` (mimir plan «Drain the owner-step queue», P1): the
 * commit this process started from and what has moved in its checkout since
 * (`src/wiki/step-checks/boot-line.ts`), for the Your work card. One cache
 * entry of the probes' 30-second lifetime, its own key: at most one
 * `ls-remote` per 30 seconds. It spawns git, so it is on
 * `SIDE_EFFECTING_GETS`. Registered in the `wiki` group beside the step
 * checks: a pod has no such route, and no `.git` either.
 */

import type { Hono } from "hono";
import { getLog } from "../../logging.ts";
import { realGit, type GitRun } from "../../wiki/decision-triage/git.ts";
import { ProbeCache, sharedGitSlots, type ProbeSlots } from "../../wiki/step-checks/answer.ts";
import { bootLineGit, readBootLine, type BootLine, type BootLineDeps } from "../../wiki/step-checks/boot-line.ts";
import { bootRecord, type BootRecord } from "../../wiki/step-checks/boot-record.ts";

const log = getLog("dashboard", "wiki-boot-line");

export const BOOT_LINE_PATH = "/api/wiki/boot-line";
const CACHE_KEY = "boot-line";

export interface BootLineRouteDeps {
  record: () => Promise<BootRecord>;
  git: GitRun;
  slots: ProbeSlots;
  cache: ProbeCache;
  compare?: BootLineDeps["compare"];
}

const sharedCache = new ProbeCache();

export const realBootLineDeps = (): BootLineRouteDeps => ({ record: bootRecord, git: realGit, slots: sharedGitSlots, cache: sharedCache });

export function registerWikiBootLineRoute(app: Hono, depsFor: () => BootLineRouteDeps = realBootLineDeps): void {
  app.get(BOOT_LINE_PATH, async (c) => {
    try {
      const deps = depsFor();
      const line: BootLine = await deps.cache.getKey(CACHE_KEY, async () =>
        readBootLine(await deps.record(), { git: bootLineGit(deps.git, deps.slots), ...(deps.compare ? { compare: deps.compare } : {}) }),
      );
      // The checkout's path stays on the server.
      const record = line.record.known ? (({ dir: _dir, ...rest }) => rest)(line.record) : line.record;
      return c.json({ ...line, record });
    } catch (err) {
      log.error("Boot line failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "the boot line could not be read" }, 500);
    }
  });
}
