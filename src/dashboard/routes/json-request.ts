import type { Context } from "hono";

/**
 * Is this a JSON POST?
 *
 * A write route that parses its body (or reads only query/params) without this
 * check can be driven cross-origin: a `text/plain` or body-less POST is a CORS
 * *simple* request, sent with no preflight, and Hono's `c.req.json()` parses the
 * body whatever the header says. Missing CORS headers stop the attacker reading
 * the RESPONSE, not the write. With `MUNINN_AUTH=off` the global origin check
 * (`src/auth/origin.ts`) is not mounted, so this per-route 415 is the guard.
 *
 * A `charset` parameter is fine; anything else is refused.
 */
export function isJsonRequest(c: Context): boolean {
  const ct = c.req.header("content-type") ?? "";
  return /^application\/json\s*(;|$)/i.test(ct.trim());
}

/** The 415 a write route answers a non-JSON POST with, or `null` to proceed. */
export function requireJsonRequest(c: Context): Response | null {
  if (isJsonRequest(c)) return null;
  return c.json({ error: "This endpoint takes application/json.", code: "bad_content_type" }, 415);
}
