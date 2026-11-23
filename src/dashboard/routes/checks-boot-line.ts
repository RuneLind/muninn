/**
 * `GET /api/checks/boot-line?v=1` (mimir plan «Drain the owner-step queue»,
 * P1b): this machine's own boot line, in the closed shape the other machine's
 * `GET /api/wiki/boot-line` shows as a peer row (`boot-line-peer.ts`).
 *
 * - It answers only its own line and never asks its peers, so two instances
 *   that list each other do not loop.
 * - The line is read as the local route reads it (same git slots, same origin
 *   cache), bound by `PEER_BOOT_ROUTE_BOUND_MS` so it answers before the asker
 *   gives up; a part still running then reads «not read». No path leaves.
 * - At most {@link BOOT_LINE_PEER_MAX_IN_FLIGHT} requests run at once; another
 *   is answered 429 at once.
 * - The same treatment as `GET /api/checks/answer`: it spawns git, so it is on
 *   `SIDE_EFFECTING_GETS`; under an authenticating mode it has no zone entry
 *   and falls to the admin default. It writes nothing, so a read-only instance
 *   answers too. Registered in the `wiki` group: a pod has no such route.
 */

import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { BOOT_LINE_PEER_PATH, BOOT_LINE_PEER_VERSION, PEER_BOOT_ROUTE_BOUND_MS, toPeerBootLine } from "../../wiki/step-checks/boot-line-peer.ts";
import { readOwnBootLine, realBootLineDeps, type BootLineRouteDeps } from "./wiki-boot-line.ts";

const log = getLog("dashboard", "checks-boot-line");

/** Requests to this route running at once; one more is answered 429 and runs nothing. */
export const BOOT_LINE_PEER_MAX_IN_FLIGHT = 2;
let inFlight = 0;

/** The local route's deps without peers: this route never relays. */
export function realPeerBootLineDeps(config: Pick<Config, "machine">): BootLineRouteDeps {
  return { ...realBootLineDeps({ machine: config.machine, peers: new Map() }), boundMs: PEER_BOOT_ROUTE_BOUND_MS };
}

export function registerChecksBootLineRoute(app: Hono, config: Pick<Config, "machine">, depsFor: () => BootLineRouteDeps = () => realPeerBootLineDeps(config)): void {
  app.get(BOOT_LINE_PEER_PATH, async (c) => {
    if (c.req.query("v") !== String(BOOT_LINE_PEER_VERSION)) return c.json({ error: `v must be ${BOOT_LINE_PEER_VERSION}` }, 400);
    if (inFlight >= BOOT_LINE_PEER_MAX_IN_FLIGHT) return c.json({ error: "busy: too many boot-line requests at once" }, 429);
    inFlight++;
    try {
      const deps = depsFor();
      // `deps.peers` is ignored on purpose: the answer is this instance's line alone.
      const line = await readOwnBootLine(deps);
      return c.json({ v: BOOT_LINE_PEER_VERSION, machine: deps.machine ?? null, line: toPeerBootLine(line) });
    } catch (err) {
      log.error("Peer boot line failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "the boot line could not be read" }, 500);
    } finally {
      inFlight--;
    }
  });
}
