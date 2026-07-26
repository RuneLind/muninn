import type { Watcher } from "../types.ts";

/**
 * Per-watcher safety-net timeout. Each checker already applies its own model
 * timeout (X: `config.timeoutMs`, default 5 min; email: `spawnHaiku`, default
 * 60s), but a stuck MCP connection or a hung subprocess can outlive that and
 * wedge the scheduler tick (which has only a tick-level overlap guard) or
 * starve the watchers queued behind it. This outer net bounds a single
 * watcher's checker run. It sits ABOVE the checker's configured timeout —
 * `max(floor, config.timeoutMs + margin)` — so a legitimately slow Sonnet
 * digest is never cut off prematurely; the net only fires when the inner
 * timeout itself is stuck.
 *
 * Lives in its own module (rather than `runner.ts`, which owns the only
 * consumer of the net itself) because a CHECKER now needs the same number to
 * derive its own internal completion budget — `checkX`'s capture leg must
 * finish inside the runner's net or the whole run is lost. Importing it from
 * `runner.ts` would close an import cycle (`runner → x → runner`), so the
 * formula is shared here and `runner.ts` re-exports it for its callers.
 */
const WATCHER_TIMEOUT_FLOOR_MS = 120_000; // 2 min for watchers with no configured timeout
const WATCHER_TIMEOUT_MARGIN_MS = 30_000; // headroom above the checker's own timeout

export function computeWatcherTimeoutMs(watcher: Watcher): number {
  const configured = (watcher.config as { timeoutMs?: number })?.timeoutMs;
  const base =
    typeof configured === "number" && configured > 0 ? configured + WATCHER_TIMEOUT_MARGIN_MS : 0;
  return Math.max(WATCHER_TIMEOUT_FLOOR_MS, base);
}
