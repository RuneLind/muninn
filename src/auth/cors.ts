/**
 * The per-site CORS disposition — `Access-Control-Allow-Origin`, once, instead
 * of twelve hand-written `"*"` literals across eight files.
 *
 * ## Why a wildcard is not merely untidy
 *
 * `Access-Control-Allow-Origin: *` cannot be combined with credentials, so it
 * does not by itself hand a cross-site page the RESPONSE to an authenticated
 * request. What it does hand over is everything the route answers to a request
 * that needs no credential — and on an instance where the loopback bypass
 * authenticates a browser running on the muninn host, "needs no credential" is
 * every request that browser makes. Two of the wildcard sites also SPEND a
 * model turn (`POST /api/research/chat`, the Jira draft routes), and one is a
 * WRITE that §4 moves to the admin zone
 * (`PUT /chat/bot-preferences/:botName/default-user`).
 *
 * ## The disposition, and why it is mode-gated
 *
 * - **`MUNINN_AUTH` off** — the header stays `*`, byte for byte. There is no
 *   session to ride, every guard in PRs C–D is inert by design, and the four
 *   Chrome extensions in `extensions/` call these routes against
 *   `http://localhost:3010` today. Changing them there would break a working
 *   tool to close nothing.
 * - **an authenticating mode** — the request's own `Origin` is ECHOED when it
 *   is on `MUNINN_ALLOWED_ORIGINS`, and otherwise no
 *   `Access-Control-Allow-Origin` is sent at all. An extension keeps working by
 *   being named: `MUNINN_ALLOWED_ORIGINS=…,chrome-extension://<id>`.
 *
 * That is the "keep it behind the origin check" disposition from §4, applied
 * uniformly. It is deliberately NOT a blanket drop: a blanket drop is the
 * change most likely to break the extensions, and §4 says so explicitly.
 *
 * ## What this does and does not enforce
 *
 * Nothing here is a security boundary on its own — CORS is a rule the BROWSER
 * applies to reading a response, not a rule the server applies to performing
 * the side effect. The side effect is refused by `src/auth/origin.ts`. These
 * two must stay consistent, which is why both read the same allowlist through
 * the same `normalizeOrigin`.
 */
import type { Context } from "hono";
import { normalizeOrigin } from "../config.ts";
import { isAuthenticatingInstance, policyAllowedOrigins } from "./policy.ts";

/**
 * The value `Access-Control-Allow-Origin` should carry for this request, or
 * `null` when the header must be omitted entirely.
 *
 * Exported separately from `applyCors` because three sites build a `Headers`
 * object for a `new Response(...)` rather than calling `c.header(...)`, and a
 * second copy of the rule is exactly what would drift.
 */
export function corsAllowOrigin(requestOrigin: string | undefined | null): string | null {
  if (!isAuthenticatingInstance()) return "*";
  if (!requestOrigin) return null;
  const normalized = normalizeOrigin(requestOrigin);
  if (!normalized) return null;
  return policyAllowedOrigins().includes(normalized) ? requestOrigin : null;
}

/** `c.header("Access-Control-Allow-Origin", …)`, mode-aware. A no-op when the
 *  origin is not allowed, which is the same wire result as never having set it. */
export function applyCors(c: Context): void {
  const value = corsAllowOrigin(c.req.header("origin"));
  if (!value) return;
  c.header("Access-Control-Allow-Origin", value);
  // Only once the answer stops being constant: an echoed origin makes the
  // response origin-dependent, and without `Vary` a shared cache could serve
  // one origin's allowed response to another. With auth off the answer is `*`
  // for everyone, and adding `Vary` there would change today's wire bytes for
  // nothing.
  if (value !== "*") c.header("Vary", "Origin");
}

/** The `Headers`-object form, for the sites that construct a bare `Response`. */
export function corsHeaders(c: Context, extra: Record<string, string> = {}): Record<string, string> {
  const value = corsAllowOrigin(c.req.header("origin"));
  if (!value) return { ...extra };
  const headers: Record<string, string> = { "Access-Control-Allow-Origin": value };
  if (value !== "*") headers["Vary"] = "Origin";
  return { ...headers, ...extra };
}
