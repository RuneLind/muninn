/**
 * The two health endpoints the open zone exists for.
 *
 * They are the only paths in `AUTH_EXCLUDED_PATHS`, i.e. the only ones an
 * authenticating instance answers with no credential at all — so neither may
 * carry a byte of per-user data, and neither may become a lever. `/api/live`
 * touches nothing and is a literal in `routes.ts`; `/api/ready` runs `SELECT 1`
 * through the probe below.
 *
 * **The readiness verdict is briefly cached**, and that is a property of the
 * route rather than an optimisation: it is unauthenticated and instance-wide,
 * so an uncached version is an open handle on the connection pool that anyone
 * reachable can pull as fast as they like — failures included, which is when a
 * flood is most likely. A platform probe runs on the order of seconds, so a
 * two-second window costs it nothing.
 */
import { getDb } from "../db/client.ts";

/** How long a readiness verdict is reused. Shorter than any sane probe
 *  interval, long enough that a flood costs one query. */
export const READINESS_CACHE_MS = 2_000;

export interface Readiness {
  readonly ready: boolean;
  /** Present only on a failure — the reason, for whoever is reading a probe
   *  log. It names the failure, never the connection string. */
  readonly error?: string;
}

let cached: { at: number; value: Readiness } | null = null;

/**
 * The database ping, as a seam.
 *
 * An in-process override rather than a parameter: the route must not be able to
 * choose what "ready" means, and a test needs the FAILURE branch without taking
 * the real database away from the rest of the run (`__setLoopbackBypassForTest`
 * is the same shape). Unreachable over HTTP.
 */
let probeOverride: (() => Promise<void>) | null = null;

export function __setReadinessProbeForTest(probe: (() => Promise<void>) | null): void {
  probeOverride = probe;
  cached = null;
}

/** Test-only: forget the cached verdict. */
export function __resetReadinessCacheForTest(): void {
  cached = null;
}

async function defaultProbe(): Promise<void> {
  await getDb()`SELECT 1`;
}

export async function readiness(now = Date.now()): Promise<Readiness> {
  if (cached && now - cached.at < READINESS_CACHE_MS) return cached.value;
  let value: Readiness;
  try {
    await (probeOverride ?? defaultProbe)();
    value = { ready: true };
  } catch (err) {
    value = { ready: false, error: err instanceof Error ? err.message : String(err) };
  }
  cached = { at: now, value };
  return value;
}
