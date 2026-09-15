/**
 * The ONE way muninn reads JSON out of claude-usage.
 *
 * Three server-side proxies of that service exist — the `/models` Pipeline
 * ledger card (`dashboard/claude-usage-overview.ts`), the `/plans` board
 * (`plans/ledger.ts`) and the wiki provenance chips (`wiki/session-ledger.ts`) —
 * and before this module each carried its own verbatim copy of the same
 * fetch → bounded read → `JSON.parse` sequence. The copies had already drifted:
 * the third lost the base URL on a body-read failure, which is precisely the
 * slow-or-wrong-service case the URL is in the message for.
 *
 * Every failure names `label` (the full URL by default; a caller whose URL
 * carries the payload — the session ledger's `?ids=` — passes the base URL
 * instead, so a log line cannot grow with the request). The BROWSER never calls
 * claude-usage in any of the three: tailnet viewers reach a loopback port on
 * their own machine, and a cross-host one is mixed content under
 * `tailscale serve`.
 */

import type { getLog } from "../logging.ts";
import { readBounded, BOUNDED_FETCH_TIMEOUT_MS, BOUNDED_FETCH_MAX_BYTES } from "./bounded-fetch.ts";

type Logger = ReturnType<typeof getLog>;

export interface ClaudeUsageJsonOptions {
  /** Wall-clock budget for this ONE read. Ignored when `signal` is passed —
   *  a shared deadline across several reads is the caller's to own. */
  timeoutMs?: number;
  maxBytes?: number;
  /**
   * A deadline the caller owns, typically shared across several calls so the
   * whole enrichment is bounded rather than each leg of it. When present it
   * REPLACES the per-call timeout: two budgets on one fetch means the looser one
   * never applies and reads as slack that is not there.
   */
  signal?: AbortSignal;
  /** What every error message names. Defaults to `${root}${path}`. */
  label?: string;
}

/**
 * `GET ${root}${path}`, bounded in time and bytes, parsed as JSON.
 *
 * Throws — with a message naming `label` — on a transport failure, a non-200, an
 * over-cap or interrupted body, and a body that is not JSON. Returns `unknown`:
 * every caller validates its own payload shape, because a wrong service on the
 * port answers 200 with JSON that is not the contract.
 */
export async function claudeUsageJson(
  root: string,
  path: string,
  opts: ClaudeUsageJsonOptions = {},
): Promise<unknown> {
  const url = `${root}${path}`;
  const label = opts.label ?? url;
  const maxBytes = opts.maxBytes ?? BOUNDED_FETCH_MAX_BYTES;
  const signal = opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? BOUNDED_FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    throw new Error(named(err, label));
  }
  if (!res.ok) throw new Error(`claude-usage returned HTTP ${res.status} for ${label}`);

  let text: string;
  try {
    // The bounded read fails too — a deadline that fires AFTER headers, a
    // mid-stream socket error — and those must name the label like every other
    // failure here or the slow/wrong-service case is exactly what loses it.
    text = await readBounded(res, maxBytes, label);
  } catch (err) {
    throw new Error(named(err, label));
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    // A non-JSON body (an HTML error page from something else on the port) reads
    // as a degraded source, never as an empty ledger.
    throw new Error(named(err, label));
  }
}

function named(err: unknown, label: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes(label) ? msg : `${msg} (${label})`;
}

/**
 * Warn-once for a degraded claude-usage, shared by all three proxies.
 *
 * A configured-but-down service is polled by every open tab on a 5-minute timer
 * and re-read on every page open, so the first sighting warns and repeats drop
 * to info. The key is per (base URL, caller's reason): the base URL because one
 * process can read two claude-usage hosts and "the ledger is down" about the
 * wrong one is a wrong answer, and the reason because a caller that collapses
 * volatile parts of a message out of its key (the plans board's digit collapse)
 * must keep doing so.
 *
 * ── One registry PER CALLER, keyed on `what` ────────────────────────────────
 * The three proxies churn at wildly different rates. The `/models` card polls a
 * fixed endpoint every 5 minutes; the provenance chips fire on every page open
 * and their keys carry the failing endpoint, so a bad afternoon mints a steady
 * stream of distinct ones. Sharing ONE 100-entry set that is cleared WHOLESALE
 * at the cap meant the noisy caller evicted the quiet one's single key and the
 * `/models` card re-warned — a "first sighting" warn for an outage in its tenth
 * hour. Each caller now gets its own capped set, so one caller's volume cannot
 * reset another's dedup, and a caller can only ever evict itself.
 */
const warnedClaudeUsage = new Map<string, Set<string>>();

/** Entries one caller's registry holds before it is cleared. Per caller, so the
 *  budget is not a shared resource three callers compete for. */
const WARN_REGISTRY_MAX = 100;

export function claudeUsageWarnOnce(opts: {
  log: Logger;
  baseUrl: string;
  /** The caller's dedup key for this error — NOT necessarily the message. */
  key: string;
  /** The full message, logged verbatim. */
  error: string;
  /** Lead of the log line, e.g. `"plan ledger"`. ALSO the registry key: two
   *  callers with different `what` values never share a dedup budget. */
  what: string;
}): void {
  let seen = warnedClaudeUsage.get(opts.what);
  if (!seen) {
    seen = new Set<string>();
    warnedClaudeUsage.set(opts.what, seen);
  }
  const key = `${opts.baseUrl}\0${opts.key}`;
  if (seen.has(key)) {
    opts.log.info("{what} still degraded: {error}", { what: opts.what, error: opts.error });
    return;
  }
  if (seen.size >= WARN_REGISTRY_MAX) seen.clear();
  seen.add(key);
  opts.log.warn("{what} degraded: {error}", { what: opts.what, error: opts.error });
}

/** Test-only: forget which errors have already warned. */
export function __resetClaudeUsageWarnsForTest(): void {
  warnedClaudeUsage.clear();
}
