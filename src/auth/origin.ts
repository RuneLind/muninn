/**
 * The global origin / `Sec-Fetch-Site` check — CSRF, which loopback was
 * silently answering until PR B made muninn reachable with a credential.
 *
 * Every guard in this campaign keys on WHO the session is, which a forged
 * cross-site request satisfies by construction: the browser attaches the
 * ambient `muninn_session` cookie (or, on the muninn host itself, the loopback
 * bypass grants the pinned identity before any cookie is read). This is not
 * hypothetical here — `src/dashboard/routes/jira-routes.ts` carries a comment
 * recording a MEASURED cross-origin `text/plain` POST that landed two messages
 * in a thread, mitigated one route at a time with a 415.
 *
 * ## Scoped to side effects, not to methods
 *
 * `SameSite=Lax` already blocks the cross-site POST half **for requests that
 * arrive through the proxy** — so a test written against a proxied POST is
 * green whether or not this file exists. Two halves it does not cover, and
 * which this middleware is actually for:
 *
 *  1. **The side-effecting top-level GET.** `GET /chat/pending/:threadId` is a
 *     one-time CONSUME, so a cross-site `<img>` riding the ambient session
 *     destroys the victim's pending research message without ever reading a
 *     response. `GET /api/research/ask` spends a full retrieval + synthesis
 *     turn. Neither carries an `Origin` header at all — a browser sends none on
 *     an `<img>`/`<script>` load — which is exactly why the check reads
 *     `Sec-Fetch-Site` and not only `Origin`.
 *  2. **Anything from a browser ON the muninn host**, which the loopback bypass
 *     authenticates before the cookie is consulted, so `SameSite` is irrelevant
 *     to it.
 *
 * GET is therefore not treated as safe by fiat; it is safe when the PATH says
 * so. `SIDE_EFFECTING_GETS` is the enumerated exception list, and it is checked
 * in rather than remembered.
 *
 * ## The decision, in order
 *
 * 1. Not a side-effecting request ⇒ allow. (`OPTIONS` included: a CORS
 *    preflight has no side effect, and refusing it would break the very
 *    preflight the disposition in `cors.ts` answers.)
 * 2. An `Origin` header ⇒ it must be this instance's own origin or an entry in
 *    `MUNINN_ALLOWED_ORIGINS`. Anything else, including the literal `null` a
 *    sandboxed iframe sends, is refused.
 * 3. No `Origin`, but a `Sec-Fetch-Site` ⇒ `same-origin` and `none` pass;
 *    `cross-site` and `same-site` are refused. This is the `<img>` case.
 * 4. Neither header ⇒ allow. A non-browser client (curl, the launchd health
 *    check, a script) sends neither, and every browser that can be steered
 *    cross-site sends at least one. Refusing here would break every scripted
 *    caller to close nothing.
 *
 * Note the ORDER of 2 and 3: an allowlisted `chrome-extension://…` origin is
 * granted before `Sec-Fetch-Site` is consulted, because an extension-initiated
 * fetch can arrive with `Sec-Fetch-Site: cross-site`.
 */
import type { Context, MiddlewareHandler } from "hono";
import { getLog } from "../logging.ts";
import { normalizeOrigin } from "../config.ts";

const log = getLog("auth", "origin");

/**
 * GET paths that change server state or spend money, listed as PATHS rather
 * than line numbers. Prefix entries end in `/` and match a path parameter.
 *
 * `GET /api/research/ask` is admin-zone under the deferred zone model, which
 * buys it nothing today AND would buy it nothing then: §4 has already
 * established that an admin is a real person browsing the real web.
 */
export const SIDE_EFFECTING_GETS: readonly string[] = [
  "/chat/pending/",
  "/api/research/ask",
];

export function isSideEffectingRequest(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (m === "OPTIONS" || m === "HEAD") return false;
  if (m !== "GET") return true;
  return SIDE_EFFECTING_GETS.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));
}

export interface OriginDecisionInput {
  readonly method: string;
  readonly path: string;
  /** The `Origin` request header, verbatim. */
  readonly origin: string | undefined;
  /** The `Sec-Fetch-Site` request header, verbatim. */
  readonly secFetchSite: string | undefined;
  /** The `Host` request header — what "this instance's own origin" means for a
   *  request that actually arrived, including through a proxy that rewrote it. */
  readonly host: string | undefined;
  readonly allowedOrigins: readonly string[];
}

export interface OriginDecision {
  readonly allowed: boolean;
  /** Short, log-shaped. Never echoed to the client — a refusal that explains
   *  which allowlist entry was missing is a probe oracle. */
  readonly reason: string;
}

/**
 * Same-origin by HOST, not by full origin.
 *
 * The scheme is deliberately not compared: `tailscale serve` terminates TLS, so
 * a browser on `https://rune-mini-m4.tail…` sends that as `Origin` while muninn
 * itself is plain HTTP behind it. Comparing schemes would refuse every write
 * from the one deployment this campaign exists for. The host+port pair is what
 * distinguishes an attacker page, and it is what a browser will not let a page
 * forge.
 */
function isSelfOrigin(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.trim().toLowerCase();
  } catch {
    return false;
  }
}

export function decideOrigin(input: OriginDecisionInput): OriginDecision {
  if (!isSideEffectingRequest(input.method, input.path)) {
    return { allowed: true, reason: "not side-effecting" };
  }

  const origin = input.origin?.trim();
  if (origin) {
    if (isSelfOrigin(origin, input.host)) return { allowed: true, reason: "same origin" };
    const normalized = normalizeOrigin(origin);
    if (normalized && input.allowedOrigins.includes(normalized)) {
      return { allowed: true, reason: "allowlisted origin" };
    }
    // `Origin: null` lands here — a sandboxed iframe or a redirected
    // cross-origin POST. It is not this instance and it is not on the list.
    return { allowed: false, reason: "origin not allowed" };
  }

  const site = input.secFetchSite?.trim().toLowerCase();
  if (site && site !== "same-origin" && site !== "none") {
    return { allowed: false, reason: `sec-fetch-site ${site}` };
  }

  return { allowed: true, reason: site ? `sec-fetch-site ${site}` : "no browser origin headers" };
}

/** Warn-once per path: an exposed instance being probed would otherwise write
 *  one line per attempt (the `middleware.ts` `warnedRejectedPaths` discipline). */
const warnedPaths = new Set<string>();
export function __resetOriginWarningsForTest(): void {
  warnedPaths.clear();
}

/**
 * Mounted on the TOP-LEVEL app in `src/index.ts`, in an authenticating mode
 * only — after `createAuthMiddleware`, so a request with no credential is
 * answered 401 by identity rather than 403 by origin.
 *
 * Not mounted with auth off: there is no ambient session to ride, every guard
 * is a no-op, and adding a refusal there would change today's muninn for no
 * gain — the "off is off" rule this whole campaign is written to.
 */
export function createOriginMiddleware(allowedOrigins: readonly string[]): MiddlewareHandler {
  return async (c: Context, next) => {
    const decision = decideOrigin({
      method: c.req.method,
      path: c.req.path,
      origin: c.req.header("origin"),
      secFetchSite: c.req.header("sec-fetch-site"),
      host: c.req.header("host"),
      allowedOrigins,
    });
    if (decision.allowed) return next();

    if (!warnedPaths.has(c.req.path)) {
      warnedPaths.add(c.req.path);
      log.warn("Refused a cross-origin {method} {path} ({reason})", {
        method: c.req.method,
        path: c.req.path,
        reason: decision.reason,
      });
    }
    return c.json({ error: "forbidden", reason: "cross-origin request" }, 403);
  };
}
