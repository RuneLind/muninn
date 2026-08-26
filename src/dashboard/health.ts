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
import { getLog } from "../logging.ts";

const log = getLog("dashboard", "health");

/** How long a readiness verdict is reused. Shorter than any sane probe
 *  interval, long enough that a flood costs one query. */
export const READINESS_CACHE_MS = 2_000;

/**
 * The wire value on a failed probe. A CONSTANT, not the driver's message: the
 * route is in `AUTH_EXCLUDED_PATHS`, so an unauthenticated caller reads whatever
 * this carries — and a `postgres` error spells out the host, port and username
 * (`connect ECONNREFUSED 127.0.0.1:5435`, `password authentication failed for
 * user "muninn"`). The real message goes to LogTape instead, where the operator
 * reads it.
 */
export const READINESS_ERROR = "database";

export interface Readiness {
  readonly ready: boolean;
  /** Present only on a failure. Always the constant {@link READINESS_ERROR} —
   *  the real reason is logged, never put on the wire. */
  readonly error?: string;
}

let cached: { at: number; value: Readiness } | null = null;
/**
 * The probe currently in flight, if any. Concurrent misses coalesce onto it
 * rather than each opening a connection: the route is unauthenticated and
 * instance-wide, so N simultaneous requests would otherwise be N queries against
 * a `max: 5` pool — a flood the cache exists to stop is most likely exactly when
 * the DB is already struggling.
 */
let inFlight: Promise<Readiness> | null = null;

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
  inFlight = null;
}

/** Test-only: forget the cached verdict. */
export function __resetReadinessCacheForTest(): void {
  cached = null;
  inFlight = null;
}

async function defaultProbe(): Promise<void> {
  await getDb()`SELECT 1`;
}

/**
 * @param now the reference clock for the cache read. Defaults to `Date.now()`;
 *   a test passes it explicitly. When defaulted, the cache is stamped at probe
 *   COMPLETION rather than at entry — a slow probe would otherwise write an
 *   already-expired entry and the cache would do nothing for exactly the case
 *   it exists for.
 */
export async function readiness(now?: number): Promise<Readiness> {
  const injected = now !== undefined;
  const readAt = injected ? now! : Date.now();
  if (cached && readAt - cached.at < READINESS_CACHE_MS) return cached.value;
  // Single-flight: a concurrent miss awaits the running probe rather than
  // starting its own.
  if (inFlight) return inFlight;
  inFlight = runProbe(injected, readAt);
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

async function runProbe(injected: boolean, readAt: number): Promise<Readiness> {
  let value: Readiness;
  try {
    await (probeOverride ?? defaultProbe)();
    value = { ready: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The real reason goes to the operator's log; the wire gets a constant.
    log.warn("Readiness probe failed: {message}", { message });
    value = { ready: false, error: READINESS_ERROR };
  }
  // Stamp at COMPLETION. For an injected clock the two coincide (the probe is
  // instantaneous in a test); for the real clock a long probe is stamped when
  // it finished, not when it started.
  cached = { at: injected ? readAt : Date.now(), value };
  return value;
}
