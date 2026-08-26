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
 * 2. An `Origin` header ⇒ it must be an entry in `MUNINN_ALLOWED_ORIGINS` or a
 *    loopback literal at the CONFIGURED port. Anything else, including the
 *    literal `null` a sandboxed iframe sends, is refused. It is never compared
 *    against the request's own `Host` header — see `loopbackOrigins`.
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
  // A one-time CONSUME: reading it destroys it.
  "/chat/pending/",
  "/simulator/pending/", // the legacy alias `src/index.ts` 301s from
  // Spends a retrieval + synthesis turn.
  "/api/research/ask",
  // Spend a model call on page content, and the fact-check pair reaches the
  // LIVE WEB through its prompt's WebFetch/search instructions — the same
  // routes `WIKI_READONLY_ROOTS` guards for exactly that reason. `sel` on the
  // fact-check routes is attacker-controllable, so an `<img>` on any page the
  // host browser visits is unbounded model spend plus outbound egress carrying
  // wiki content.
  "/api/wiki/ask",
  "/api/wiki/digest",
  "/api/wiki/explain",
  "/api/wiki/factcheck",
  "/api/wiki/factcheck/claim",
  // The two WebSocket upgrades. They never reach this middleware — `src/index.ts`
  // handles them inside `Bun.serve`'s `fetch`, before `app.fetch` — and the
  // enforcement point is `src/auth/ws-upgrade.ts`, which consults this same
  // list through `decideOrigin`. They are listed here rather than special-cased
  // there so that (a) the upgrade's origin rule IS the HTTP one, byte for byte,
  // and (b) if a future refactor ever routes them through Hono they arrive
  // guarded rather than exempt. A handshake is the largest READ surface muninn
  // has: it streams every event the subscriber is entitled to for as long as the
  // tab is open, and handshakes are not subject to CORS.
  "/chat/ws",
  "/simulator/ws",
];

/**
 * ⚠️ **HEAD is NOT safe, and treating it as safe is a hole rather than an
 * optimisation.** Hono dispatches `HEAD /x` to the handler registered with
 * `app.get("/x")` and RUNS ITS BODY — so exempting HEAD does not skip a
 * bodyless read, it skips the same side effect with the response discarded.
 * Measured against a live server: `GET /chat/pending/x` cross-site answered
 * 403 and consumed nothing, while `HEAD` on the identical path answered 200
 * and consumed the message. `fetch(…, {method:"HEAD", mode:"no-cors"})` needs
 * no preflight, so it is reachable from any page. HEAD therefore falls through
 * to the GET rule; the two read-only `app.on("HEAD", …)` report/spec routes are
 * not on the list and are unaffected.
 */
export function isSideEffectingRequest(method: string, path: string): boolean {
  const m = method.toUpperCase();
  // OPTIONS only: a CORS preflight has no side effect, and refusing it would
  // break the very preflight `src/auth/cors.ts` answers.
  if (m === "OPTIONS") return false;
  if (m !== "GET" && m !== "HEAD") return true;
  return SIDE_EFFECTING_GETS.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));
}

export interface OriginDecisionInput {
  readonly method: string;
  readonly path: string;
  /** The `Origin` request header, verbatim. */
  readonly origin: string | undefined;
  /** The `Sec-Fetch-Site` request header, verbatim. */
  readonly secFetchSite: string | undefined;
  /**
   * Every origin this instance accepts a side effect from: `MUNINN_ALLOWED_ORIGINS`
   * plus the loopback literals at the configured `DASHBOARD_PORT`.
   *
   * There is deliberately NO `host` field. An earlier cut compared the `Origin`
   * against the request's own `Host` header, which asks "does this request agree
   * with itself" rather than "is this my origin" — and review demonstrated the
   * consequence on a live server: `Host: evil.example:3013` with
   * `Origin: http://evil.example:3013` created a real conversation. That is the
   * DNS-rebinding shape an origin check exists to stop: a name the attacker
   * controls, rebound to 127.0.0.1, makes the browser send a matching
   * Host/Origin pair while the loopback bypass supplies the pinned identity.
   */
  readonly allowedOrigins: readonly string[];
}

export interface OriginDecision {
  readonly allowed: boolean;
  /** Short, log-shaped. Never echoed to the client — a refusal that explains
   *  which allowlist entry was missing is a probe oracle. */
  readonly reason: string;
}

/**
 * The loopback origins this instance answers on, derived from the CONFIGURED
 * port rather than from anything in the request.
 *
 * These are safe to accept without configuration because a browser will not
 * send `Origin: http://127.0.0.1:<port>` for a page served from anywhere else —
 * unlike a `Host` comparison, there is no name here an attacker can own.
 *
 * A proxied origin (the tailnet name `tailscale serve` publishes) is NOT
 * derivable this way and must be listed in `MUNINN_ALLOWED_ORIGINS`, which is
 * already a boot requirement in an authenticating mode. Note the scheme matters
 * again as a result: `https://<tailnet-name>` is what the browser sends, and
 * that exact string is what belongs in the allowlist.
 */
export function loopbackOrigins(port: number): string[] {
  return [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ];
}

export function decideOrigin(input: OriginDecisionInput): OriginDecision {
  if (!isSideEffectingRequest(input.method, input.path)) {
    return { allowed: true, reason: "not side-effecting" };
  }

  const origin = input.origin?.trim();
  if (origin) {
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
export function createOriginMiddleware(
  allowedOrigins: readonly string[],
  dashboardPort: number,
): MiddlewareHandler {
  // Computed once: the set is a property of the configuration, never of a
  // request. Normalised through the same `normalizeOrigin` the allowlist parser
  // uses, so a configured origin and an incoming header can never be compared
  // in two different shapes.
  const accepted = [
    ...allowedOrigins,
    ...loopbackOrigins(dashboardPort).map((o) => normalizeOrigin(o)).filter((o): o is string => o !== null),
  ];
  return async (c: Context, next) => {
    const decision = decideOrigin({
      method: c.req.method,
      path: c.req.path,
      origin: c.req.header("origin"),
      secFetchSite: c.req.header("sec-fetch-site"),
      allowedOrigins: accepted,
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
