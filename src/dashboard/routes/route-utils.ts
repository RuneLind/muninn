import type { Context } from "hono";
import { getLog } from "../../logging.ts";
import { isWikiReadonly, WIKI_READONLY_REASON } from "../../wiki/readonly.ts";

/** The logger a `readonlyRefusal` caller passes — `getLog`'s return type, named
 *  so the helper does not have to import logtape's own. */
type RouteLog = ReturnType<typeof getLog>;

/**
 * The wiki-readonly refusal, as the FIRST statement of a mutation route.
 *
 * The write seams refuse on their own, so this is not the only line of defence —
 * it exists so the refusal costs no DB round-trip, no model call and no
 * filesystem read, and so it leaves a trace: a seam that is never reached warns
 * about nothing, and "why did the mini do nothing?" was otherwise unanswerable
 * from the logs. Returns null when writes are allowed.
 *
 * One implementation, three route files (`wiki-routes`, `wiki-gardener-routes`,
 * `plans-routes`) — it was copied byte-identically into all three, which is one
 * copy-edit away from three different refusal bodies for one flag. The CALLER's
 * logger is passed in so each file's refusals still land under its own category.
 */
export function readonlyRefusal(c: Context, log: RouteLog) {
  if (!isWikiReadonly()) return null;
  log.info("Wiki-readonly instance refused {method} {path}", {
    method: c.req.method,
    path: new URL(c.req.url).pathname,
  });
  return c.json({ error: WIKI_READONLY_REASON, readonly: true }, 403);
}

/**
 * Parse an integer query param — `Number()` → `Math.round` → clamp to `[min, max]`.
 *
 * The ONE copy of this rule. It existed twice, byte-identically: `clampDays` in
 * `dashboard/claude-usage-overview.ts` (itself mirroring claude-usage's upstream
 * `clampInt`) and `clampRecentWindowDays` in `db/summary-candidates.ts` — the second
 * of which was a query-string parser living in the DB layer. Callers keep their own
 * bounds and default; only the parse semantics are shared.
 *
 * Deliberately NOT `parseInt`: it reads `1e2` as 1, `12abc` as 12 and truncates `7.9`
 * to 7 — i.e. silently answers a different window than the query string asked for (and,
 * for the claude-usage route, a different one than the upstream service would).
 *
 * Absent / blank / unparseable ⇒ `fallback`. Out of range ⇒ clamped, never an error.
 * A non-finite literal (`Infinity`) takes the FALLBACK rather than `max` — it fails the
 * finite check before the clamp is ever reached.
 */
export function clampIntQuery(
  raw: string | undefined | null,
  opts: { min: number; max: number; fallback: number },
): number {
  if (raw == null || raw.trim() === "") return opts.fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return opts.fallback;
  return Math.min(opts.max, Math.max(opts.min, Math.round(n)));
}

/** Parse a numeric query param with fallback and bounds clamping. */
export function parseIntParam(value: string | undefined, defaultVal: number, max: number): number {
  const parsed = parseInt(value ?? String(defaultVal), 10);
  if (isNaN(parsed) || parsed < 1) return defaultVal;
  return Math.min(parsed, max);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Check if a string is a valid UUID v4 format. */
export function isValidUuid(value: string): boolean {
  return UUID_RE.test(value);
}
