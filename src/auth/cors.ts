/**
 * The per-site CORS disposition — `Access-Control-Allow-Origin`, once, instead
 * of the wildcard literals it replaced (13 of them across 7 files, counted on
 * `main`; an eighth file only names the header in a comment).
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
 * ## The disposition, per mode
 *
 * Both modes ECHO the request's own `Origin` when it is accepted and otherwise
 * send no `Access-Control-Allow-Origin` at all; there is no `*`. What
 * "accepted" means is the one thing that differs:
 *
 * - **`MUNINN_AUTH` off** — `offModeOriginAccepted` from `origin.ts`: a
 *   loopback literal at the configured port, any `chrome-extension:` origin
 *   (the four extensions in `extensions/` have unpinned per-install ids), or an
 *   entry in the optional `MUNINN_ALLOWED_ORIGINS`. The extensions keep working
 *   with no configuration.
 * - **an authenticating mode** — `MUNINN_ALLOWED_ORIGINS` only. An extension
 *   keeps working by being named: `MUNINN_ALLOWED_ORIGINS=…,chrome-extension://<id>`.
 *
 * That is the "keep it behind the origin check" disposition from §4. It is
 * deliberately NOT a blanket drop: a blanket drop is the change most likely to
 * break the extensions, and §4 says so explicitly.
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
import { acceptedOrigins, offModeOriginAccepted } from "./origin.ts";
import { isAuthenticatingInstance, policyAllowedOrigins, policyDashboardPort } from "./policy.ts";

/**
 * The value `Access-Control-Allow-Origin` should carry for this request, or
 * `null` when the header must be omitted entirely.
 *
 * Exported separately from `applyCors` because three sites build a `Headers`
 * object for a `new Response(...)` rather than calling `c.header(...)`, and a
 * second copy of the rule is exactly what would drift.
 */
export function corsAllowOrigin(requestOrigin: string | undefined | null): string | null {
  if (!requestOrigin) return null;
  if (!isAuthenticatingInstance()) {
    const accepted = acceptedOrigins(policyAllowedOrigins(), policyDashboardPort());
    return offModeOriginAccepted(requestOrigin, accepted) ? requestOrigin : null;
  }
  const normalized = normalizeOrigin(requestOrigin);
  if (!normalized) return null;
  return policyAllowedOrigins().includes(normalized) ? requestOrigin : null;
}

/** `c.header("Access-Control-Allow-Origin", …)`, mode-aware. A no-op when the
 *  origin is not allowed, which is the same wire result as never having set it. */
export function applyCors(c: Context): void {
  // `Vary` on BOTH outcomes, not only when a header is emitted. The response
  // is origin-dependent in both directions — an accepted origin gets
  // `ACAO: <origin>`, any other gets no header at all — so declaring it only on
  // the permissive branch lets a shared cache store the header-LESS variant and
  // replay it to an allowed origin, silently breaking the extension.
  c.header("Vary", "Origin", { append: true });
  const value = corsAllowOrigin(c.req.header("origin"));
  if (value) c.header("Access-Control-Allow-Origin", value);
}

/** The `Headers`-object form, for the sites that construct a bare `Response`. */
export function corsHeaders(c: Context, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { Vary: "Origin" };
  const value = corsAllowOrigin(c.req.header("origin"));
  if (value) headers["Access-Control-Allow-Origin"] = value;
  return { ...headers, ...extra };
}
