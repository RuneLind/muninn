/**
 * The Hono middleware that applies `zones.ts`.
 *
 * Mounted on the TOP-LEVEL app in `src/index.ts`, third and last, inside the
 * `isAuthenticatingMode` branch — after `createAuthMiddleware` (so a request
 * with no credential is answered 401 by identity rather than 403 by role) and
 * after `createOriginMiddleware` (so a cross-origin side effect is refused
 * before role is even consulted). NOT inside `createDashboardRoutes`: the chat
 * sub-app is a second `app.route` and would be uncovered.
 *
 * It skips `AUTH_EXCLUDED_PATHS` for the same reason the auth middleware does —
 * those two paths ARE the open zone in its no-credential form, and there is no
 * role on the context to decide with.
 *
 * The audit hook lives here rather than in the route files because there is one
 * path list and one place that reads it. It fires BEFORE `next()`: the row means
 * an ATTEMPTED read, so a 404 or an empty result still rows.
 */
import type { Context, MiddlewareHandler } from "hono";
import { getLog } from "../logging.ts";
import { AUTH_EXCLUDED_PATHS, isAuthenticatingMode, type AuthConfig } from "./mode.ts";
import { decideZone, isAuditedCollectionRead } from "./zones.ts";
import { auditAdminCollectionRead } from "./audit.ts";

const log = getLog("auth", "zones");

/**
 * The most distinct (method, path) refusals to remember for warn-once.
 *
 * Default-deny means EVERY unknown path is a refusal, so a role-`user` scan of
 * many distinct paths would grow an unbounded set — and this is the first such
 * set reachable AFTER successful auth and on every 404. Bounded as a rolling
 * window: past the cap the oldest key is evicted, so the worst case is a single
 * re-warn for an old path, never unbounded memory. (The sibling warn-sets in
 * `origin.ts` / `middleware.ts` share the shape and are a separate follow-up.)
 */
export const WARNED_REFUSALS_MAX = 1024;

/** Warn-once per (method, path): an authenticated `user` clicking through the
 *  operator nav would otherwise write a line per click, and a refused poller
 *  one per tick — the `middleware.ts` / `origin.ts` discipline. Bounded, see
 *  `WARNED_REFUSALS_MAX`. */
const warnedRefusals = new Set<string>();

/** True the first time a key is seen (so the caller warns); adds it, evicting
 *  the oldest entry when the set is full. A Set preserves insertion order, so
 *  `values().next()` is the oldest. */
function shouldWarnRefusal(key: string): boolean {
  if (warnedRefusals.has(key)) return false;
  if (warnedRefusals.size >= WARNED_REFUSALS_MAX) {
    const oldest = warnedRefusals.values().next().value;
    if (oldest !== undefined) warnedRefusals.delete(oldest);
  }
  warnedRefusals.add(key);
  return true;
}

export function __resetZoneWarningsForTest(): void {
  warnedRefusals.clear();
}
export function __zoneWarningsSizeForTest(): number {
  return warnedRefusals.size;
}

export function createZoneMiddleware(config: AuthConfig): MiddlewareHandler {
  return async (c: Context, next) => {
    if (AUTH_EXCLUDED_PATHS.includes(c.req.path)) return next();

    const role = c.get("role") ?? null;

    // Defence in depth: this middleware is mounted ONLY in an authenticating
    // mode, so a null role here is a bug — the auth middleware ahead of it
    // should have 401'd, redirected or granted a role first. `decideZone`
    // answers "auth off ⇒ allow everything" for a null role, which is the right
    // answer when no middleware is mounted (mode `off`) and exactly the WRONG
    // one here: it would open every route AND skip the deny list. Fail closed
    // rather than delegate that decision. The genuine auth-off path never
    // reaches this line (no middleware is mounted), so it is untouched.
    if (isAuthenticatingMode(config.mode) && role == null) {
      const key = `NOROLE ${c.req.method} ${c.req.path}`;
      if (shouldWarnRefusal(key)) {
        log.warn(
          "Refused {method} {path}: no role on the context in authenticating mode {mode} — the auth " +
          "middleware should have resolved one first. Failing closed.",
          { method: c.req.method, path: c.req.path, mode: config.mode },
        );
      }
      return c.json({ error: "forbidden", reason: "admin-only route" }, 403);
    }

    const decision = decideZone({ method: c.req.method, path: c.req.path, role });

    if (!decision.allowed) {
      const key = `${c.req.method} ${c.req.path}`;
      if (shouldWarnRefusal(key)) {
        log.warn("Refused {method} {path} for role {role} ({reason})", {
          method: c.req.method, path: c.req.path, role, reason: decision.reason,
        });
      }
      // The reason is NOT echoed: naming which allowlist was missed tells a
      // prober where to aim. `admin-only` is the whole answer a caller needs.
      return c.json({ error: "forbidden", reason: "admin-only route" }, 403);
    }

    if (role === "admin" && isAuditedCollectionRead(c.req.method, c.req.path)) {
      const reader = c.get("identity")?.userId;
      if (reader) auditAdminCollectionRead({ mode: config.mode, reader, path: c.req.path });
    }

    return next();
  };
}
