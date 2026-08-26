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
import { AUTH_EXCLUDED_PATHS, type AuthConfig } from "./mode.ts";
import { decideZone, isAuditedCollectionRead } from "./zones.ts";
import { auditAdminCollectionRead } from "./audit.ts";

const log = getLog("auth", "zones");

/** Warn-once per (method, path): an authenticated `user` clicking through the
 *  operator nav would otherwise write a line per click, and a refused poller
 *  one per tick — the `middleware.ts` / `origin.ts` discipline. */
const warnedRefusals = new Set<string>();
export function __resetZoneWarningsForTest(): void {
  warnedRefusals.clear();
}

export function createZoneMiddleware(config: AuthConfig): MiddlewareHandler {
  return async (c: Context, next) => {
    if (AUTH_EXCLUDED_PATHS.includes(c.req.path)) return next();

    const role = c.get("role") ?? null;
    const decision = decideZone({ method: c.req.method, path: c.req.path, role });

    if (!decision.allowed) {
      const key = `${c.req.method} ${c.req.path}`;
      if (!warnedRefusals.has(key)) {
        warnedRefusals.add(key);
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
