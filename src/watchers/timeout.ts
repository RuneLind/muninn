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
 * consumer of the net itself) because a CHECKER now needs the same numbers to
 * derive its own internal completion budget — `checkX`'s capture leg must
 * finish inside the runner's net or the whole run is lost. Importing them from
 * `runner.ts` would close an import cycle (`runner → x → runner`), so the
 * formula is shared here and `runner.ts` re-exports it for its callers.
 *
 * This module deliberately has ZERO value imports (type-only `Watcher`), so it
 * can be imported from watcher checkers AND from `src/scheduler/runner.ts`
 * without ever closing a cycle.
 */
const WATCHER_TIMEOUT_FLOOR_MS = 120_000; // 2 min for watchers with no configured timeout
/**
 * Email's floor is higher because `checkEmail` is the one checker that can spawn
 * TWICE — its Gmail tools arrive deferred and ~12.5% of spawns never resolve them,
 * so a bounded retry is the fix (see `email.ts`). Two 60s attempts plus the retry
 * budget's own 10s margin need 130s, which the generic 120s floor cannot hold: at
 * that floor the retry is clamped to ~50s, against a slowest-HEALTHY tick of 56.5s,
 * so the top decile of good runs was unrescuable.
 *
 * The alternative was documenting a `config.timeoutMs: 150000` row edit. Rejected on
 * this repo's own rule — a fix that only works after a hand-edited DB row is inert
 * where it matters, and the live row has carried no `timeoutMs` for its whole life.
 * A type-specific floor is the honest place for a per-checker requirement.
 *
 * **Why 180 and not 130.** The requirement is 130s (`EMAIL_MAX_ATTEMPTS ×
 * EMAIL_ATTEMPT_TIMEOUT_MS + EMAIL_BUDGET_SAFETY_MARGIN_MS`); 180 is that plus
 * deliberate slack, and it matches what the `config.timeoutMs: 150000` row edit this
 * replaces would have produced — so the shipped net is unchanged from the documented
 * workaround. Sizing it at exactly 130 would put the net one constant-bump away from
 * the overrun this exists to prevent.
 *
 * ⚠️ **The inputs to that arithmetic live in `email.ts`, and a real import would close
 * a cycle** — so the dependency is semantic and unenforceable from here. It is
 * asserted in `email.test.ts` ("the net holds EMAIL_MAX_ATTEMPTS attempts at FULL
 * length"), which can import both modules. Changing `EMAIL_ATTEMPT_TIMEOUT_MS`,
 * `EMAIL_MAX_ATTEMPTS` or `HAIKU_TIMEOUT_MS` (which the first aliases) without
 * re-checking that test is how this silently regresses.
 *
 * NB this widens only the SAFETY NET. It does not make any single spawn longer (the
 * per-attempt timeout is `EMAIL_ATTEMPT_TIMEOUT_MS`, still 60s), so a wedged email
 * tick occupies at most ~120s of its 180s net — and watchers run concurrently, so a
 * slower net never starves the others.
 */
const EMAIL_TIMEOUT_FLOOR_MS = 180_000;
/** Headroom the runner's net adds above the checker's own configured timeout. */
export const WATCHER_TIMEOUT_MARGIN_MS = 30_000;

/**
 * Hard ceiling on a scheduler tick — the tick races `runSchedulerTick` against this and
 * gives up when it wins. It is the TRUE upper bound on any watcher's wall clock: the
 * per-watcher net (`computeWatcherTimeoutMs`) can exceed it (X Highlights' 630s net vs
 * this 600s), in which case the tick timeout fires first. Any checker deriving an internal
 * completion budget must therefore bound itself by `min(net, tick)`, not by the net alone.
 *
 * Lives here (rather than in `src/scheduler/runner.ts`, its original home and still its
 * primary consumer) so the checkers can read it without closing a
 * `scheduler/runner → watchers/runner → x → scheduler/runner` import cycle.
 */
export const TICK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes max per tick

export function computeWatcherTimeoutMs(watcher: Watcher): number {
  const configured = (watcher.config as { timeoutMs?: number })?.timeoutMs;
  const base =
    typeof configured === "number" && configured > 0 ? configured + WATCHER_TIMEOUT_MARGIN_MS : 0;
  const floor = watcher.type === "email" ? EMAIL_TIMEOUT_FLOOR_MS : WATCHER_TIMEOUT_FLOOR_MS;
  return Math.max(floor, base);
}
