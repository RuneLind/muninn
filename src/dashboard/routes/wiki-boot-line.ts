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
 *
 * With `MUNINN_PEERS` AND `MUNINN_MACHINE` set (P1b) the payload also carries
 * `machine` (this machine's name, the local line's prefix) and `peers`: each
 * peer's own line, read in parallel with the local one through
 * `boot-line-peer.ts`, each bound apart, so a slow peer reads «no answer» and
 * never blanks the local row. Without either, both keys are absent and no peer
 * is asked: peers need this machine's name exactly as step checks do, and an
 * unnamed muninn listing its own url would otherwise ask itself.
 */

import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { realGit, type GitRun } from "../../wiki/decision-triage/git.ts";
import { ProbeCache, sharedGitSlots, type ProbeSlots } from "../../wiki/step-checks/answer.ts";
import { readBootLine, type BootLine } from "../../wiki/step-checks/boot-line.ts";
import { sharedBootLinePeerReader, type BootLinePeerReader, type BootLinePeerRow } from "../../wiki/step-checks/boot-line-peer.ts";
import { bootRecord, type BootRecord } from "../../wiki/step-checks/boot-record.ts";
import { readOriginHead, type OriginHeadRead } from "../../wiki/step-checks/probes.ts";

const log = getLog("dashboard", "wiki-boot-line");

export const BOOT_LINE_PATH = "/api/wiki/boot-line";
const ORIGIN_KEY = "boot-line:origin-head";

export interface BootLineRouteDeps {
  record: () => Promise<BootRecord>;
  /** The raw runner: `readBootLine` adds the env, the slots and the cancel. */
  git: GitRun;
  slots: ProbeSlots;
  /** Holds origin's answer only. */
  cache: ProbeCache;
  /** The uncached origin read; a test counts its calls. */
  originHead?: OriginHeadRead;
  boundMs?: number;
  /** Test seam: the bound expires when the promise settles ({@link readBootLine}'s `expiry`). */
  expiry?: () => Promise<unknown>;
  now?: () => number;
  /** `MUNINN_MACHINE`, or null: the local line's prefix when there are peers; null asks no peer. */
  machine?: string | null;
  /** The peers' lines; absent when `MUNINN_PEERS` lists none or `MUNINN_MACHINE` is unset. */
  peers?: BootLinePeerReader;
}

/** What the card gets: the local line, and with peers this machine's name and each peer's row. */
export type BootLinePayload = BootLine & { machine?: string; peers?: BootLinePeerRow[] };

const sharedCache = new ProbeCache();

export const realBootLineDeps = (config?: Pick<Config, "machine" | "peers">): BootLineRouteDeps => {
  const peers = config?.machine ? sharedBootLinePeerReader(config.peers) : undefined;
  return { record: bootRecord, git: realGit, slots: sharedGitSlots, cache: sharedCache, machine: config?.machine ?? null, ...(peers ? { peers } : {}) };
};

/** This instance's own line: the local reads, origin through the route's cache. The peer route answers with it too. */
export function readOwnBootLine(deps: BootLineRouteDeps): Promise<BootLine> {
  const read = deps.originHead ?? readOriginHead;
  const cachedOrigin: OriginHeadRead = (dir, git) => deps.cache.getKey(ORIGIN_KEY, () => read(dir, git));
  return readBootLine(deps.record(), {
    git: deps.git,
    slots: deps.slots,
    originHead: cachedOrigin,
    ...(deps.boundMs !== undefined ? { boundMs: deps.boundMs } : {}),
    ...(deps.expiry ? { expiry: deps.expiry() } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
}

export function registerWikiBootLineRoute(app: Hono, depsFor: () => BootLineRouteDeps = realBootLineDeps): void {
  app.get(BOOT_LINE_PATH, async (c) => {
    try {
      const deps = depsFor();
      const machine = deps.machine ?? null;
      const reader = machine ? deps.peers : undefined;
      // Started together; the reader never rejects and bounds each peer itself.
      const peers = reader ? reader().catch(() => null) : null;
      const line = await readOwnBootLine(deps);
      if (!reader || !machine) return c.json(line);
      const rows = (await peers) ?? [];
      const payload: BootLinePayload = { ...line, machine, peers: rows };
      return c.json(payload);
    } catch (err) {
      log.error("Boot line failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "the boot line could not be read" }, 500);
    }
  });
}
