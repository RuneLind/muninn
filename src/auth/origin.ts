/**
 * The global origin / `Sec-Fetch-Site` check — CSRF. Mounted in EVERY mode:
 * an authenticating one refuses what rides the ambient session, and `off`
 * refuses what any web page the user visits can send to `http://localhost:3010`.
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
 *    literal `null` a sandboxed iframe sends, is refused. An authenticating
 *    mode never compares it against the request's own `Host` header — see
 *    `loopbackOrigins`. **`off` adds three arms** (see `OriginPolicyMode`):
 *    any `chrome-extension:` origin, an `Origin` equal to the request's own
 *    `Host`, and `Sec-Fetch-Site: same-origin`.
 * 3. No `Origin`, but a `Sec-Fetch-Site` ⇒ `same-origin` and `none` pass;
 *    `cross-site` and `same-site` are refused. This is the `<img>` case.
 * 4. Neither header ⇒ allow. A non-browser client (curl, the launchd health
 *    check, a script) sends neither, and every browser that can be steered
 *    cross-site sends at least one. Refusing here would break every scripted
 *    caller to close nothing.
 *
 * **Known residual in `off`, on a plain-http non-loopback host.** A cross-site
 * `<img>`/`<script>` GET to a `SIDE_EFFECTING_GETS` path carries neither
 * `Origin` nor `Sec-Fetch-Site` there (no Fetch Metadata to an untrustworthy
 * URL), so it passes step 4 — measured: `<img src=http://muninn.lan:3987/chat/pending/…>`
 * consumed the message. It cannot be closed without also refusing that page's
 * own same-origin GETs, which look identical. Remedy: serve over https
 * (`tailscale serve`) or run an authenticating mode.
 *
 * Note the ORDER of 2 and 3: an allowlisted `chrome-extension://…` origin is
 * granted before `Sec-Fetch-Site` is consulted, because an extension-initiated
 * fetch can arrive with `Sec-Fetch-Site: cross-site`. The allowlist and
 * loopback arm precede it too (a browser sends those origins only for this
 * instance's own pages). The `off` Host arm is the one exception: it yields to
 * a `Sec-Fetch-Site` of `cross-site` or `same-site`.
 */
import type { Context, MiddlewareHandler } from "hono";
import { getLog } from "../logging.ts";
import { normalizeOrigin } from "../config.ts";

const log = getLog("auth", "origin");

/**
 * GET paths that change server state or spend money, listed as PATHS rather
 * than line numbers. Prefix entries end in `/` and match a path parameter.
 *
 * `GET /api/research/ask` is admin-zone under the zone model, which buys it
 * nothing here: §4 has already established that an admin is a real person
 * browsing the real web, so the origin check still has to cover it.
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
  // The /summaries twin: the same engine (model spend + live-web egress) and
  // it writes a `summary_factchecks` row. Exact path — `/result` and
  // `/badges` beside it are read-only.
  "/api/summaries/factcheck",
  // Not a model call and not a write — an AMPLIFIER. One GET walks every
  // registered wiki's index and fans out into up to `PROVENANCE_REFS_MAX / 200`
  // requests to claude-usage plus one to huginn, all from this host's network
  // position. That is the property §4 cares about: an `<img src>` on any page
  // the admin's browser visits should not be able to drive this host's outbound
  // calls, however bounded each one is.
  "/api/wiki/provenance",
  // The per-page block: the SAME join (sessions, merges, handoffs, huginn) for
  // one page, split off `GET /api/wiki/page` so the page open never waits on
  // it. Listed for the same reason — it is the amplifier under its own path.
  "/api/wiki/page/provenance",
  // Graph mode: at level 2 and up the same ledger reads, for every session a
  // walk reaches — up to `GRAPH_SESSIONS_MAX` refs behind one GET.
  "/api/wiki/graph",
  // The find palette's Everywhere section: one GET carries reader-typed text to
  // huginn's search and to claude-usage's (two calls, a third for titles). An
  // amplifier like the two above; the palette's same-origin fetch passes.
  "/api/wiki/find-everywhere",
  // On a missing or stale cache it SPAWNS every stdio MCP server in the bot's `.mcp.json` to probe
  // it — so an `<img>` on any page could start local processes. The chat page
  // calls it with a same-origin `fetch`, which passes.
  "/chat/mcp-status/",
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
   * The authenticating rule deliberately never reads `host`. An earlier cut compared the `Origin`
   * against the request's own `Host` header, which asks "does this request agree
   * with itself" rather than "is this my origin" — and review demonstrated the
   * consequence on a live server: `Host: evil.example:3013` with
   * `Origin: http://evil.example:3013` created a real conversation. That is the
   * DNS-rebinding shape an origin check exists to stop: a name the attacker
   * controls, rebound to 127.0.0.1, makes the browser send a matching
   * Host/Origin pair while the loopback bypass supplies the pinned identity.
   */
  readonly allowedOrigins: readonly string[];
  /**
   * The request's own `Host` header, verbatim — read by the `off` Host arm
   * ONLY (see `OriginPolicyMode`). An authenticating mode never consults it,
   * for the rebinding reason recorded on `allowedOrigins` above.
   */
  readonly host?: string | undefined;
  /** Omitted ⇒ `"authenticating"`, the stricter rule. */
  readonly mode?: OriginPolicyMode;
}

/**
 * `off` widens the `Origin` arm by three, all so that an unconfigured instance
 * keeps working:
 *
 * - **any `chrome-extension:` origin.** The four extensions in `extensions/`
 *   carry no manifest `key`, so their ids differ per install and cannot be
 *   listed. This admits ANY installed extension, including one WITHOUT host
 *   permission for this host — it now gets a CORS echo and passes preflight.
 *   Not a regression: the `*` this replaced granted every extension the same.
 *   A web page cannot forge the scheme.
 * - **`Origin` equal to the request's own `Host`** (scheme from the `Origin`),
 *   for the dashboard served over plain http on a LAN or tailnet address
 *   (`DASHBOARD_HOST=0.0.0.0`, `http://mini:3010`). A browser sends Fetch
 *   Metadata only to a potentially-trustworthy URL (https, localhost,
 *   127.0.0.0/8), so such a page's own POST carries an `Origin` and NO
 *   `Sec-Fetch-Site`, and without this arm every write it makes answers 403.
 *   It also covers `tailscale serve`, which forwards the browser's `Host` to a
 *   TCP backend — including its WS handshake, which carries no Fetch Metadata.
 *   Skipped when `Sec-Fetch-Site` is present and not `none`: an http page on
 *   the same name as an https-proxied muninn sends a matching Origin marked
 *   `cross-site`.
 * - **`Sec-Fetch-Site: same-origin`**, a second path for an https proxy that
 *   rewrites `Host`, so the arm above does not match.
 *
 * The last two admit DNS rebinding — accepted, because `off` has no `Host`
 * allowlist, so a rebound name already reads and writes everything. The guard
 * targets drive-by cross-site pages, not rebinding. An authenticating mode
 * keeps none of the three: there, each is an identity question, and the Host
 * arm is exactly the comparison that mode rejected (see `allowedOrigins`).
 */
export type OriginPolicyMode = "authenticating" | "off";

/**
 * The origin predicate `off` mode shares with `cors.ts`: on the accepted set
 * (allowlist + loopback) or a `chrome-extension:` origin. Deliberately WITHOUT
 * the Host and same-origin arms — CORS only ever answers a cross-origin reader,
 * so a same-origin request never needs the header.
 */
export function offModeOriginAccepted(origin: string, accepted: readonly string[]): boolean {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  return accepted.includes(normalized) || normalized.startsWith("chrome-extension://");
}

/** The configured accepted set — the allowlist plus the loopback literals at
 *  `dashboardPort` (none when the port is unknown), normalised the one way. */
export function acceptedOrigins(allowedOrigins: readonly string[], dashboardPort: number | null): string[] {
  const loopback = dashboardPort === null ? [] : loopbackOrigins(dashboardPort);
  return [
    ...allowedOrigins,
    ...loopback.map((o) => normalizeOrigin(o)).filter((o): o is string => o !== null),
  ];
}

/**
 * The `off` Host arm: does `origin` name the same scheme/host/port the request
 * was sent to? The scheme comes from the `Origin` (http or https only); the
 * host and port from `Host`, normalised the same way on both sides — case,
 * default port, one trailing dot, IPv6 brackets. A missing or unparseable
 * `Host`, or one carrying anything but `host[:port]`, never matches.
 * NEVER call this in an authenticating mode.
 */
export function originMatchesHost(origin: string, host: string | undefined): boolean {
  const h = host?.trim();
  if (!h || /[\s/\\?#@]/.test(h)) return false;
  const canon = (u: URL) => `${u.protocol}//${u.hostname.replace(/\.$/, "")}:${u.port}`.toLowerCase();
  try {
    const o = new URL(origin.trim());
    if (o.protocol !== "http:" && o.protocol !== "https:") return false;
    if (o.origin === "null" || o.href !== `${o.origin}/`) return false;
    return canon(o) === canon(new URL(`${o.protocol}//${h}`));
  } catch {
    return false;
  }
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
 * derivable this way. In an authenticating mode it must be listed in
 * `MUNINN_ALLOWED_ORIGINS` (a boot requirement there); `off` admits it through
 * its Host arm (the proxy forwards `Host`; the only path for the WS handshake)
 * or its `Sec-Fetch-Site: same-origin` arm. Note the scheme matters
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

  const site = input.secFetchSite?.trim().toLowerCase();
  const origin = input.origin?.trim();
  if (origin) {
    const normalized = normalizeOrigin(origin);
    if (normalized && input.allowedOrigins.includes(normalized)) {
      return { allowed: true, reason: "allowlisted origin" };
    }
    if (input.mode === "off") {
      if (offModeOriginAccepted(origin, input.allowedOrigins)) {
        return { allowed: true, reason: "extension origin" };
      }
      // Fetch Metadata, when present, is authoritative: the Host arm is for the
      // requests that carry none (a plain-http page, a WS handshake). A
      // cross-site http page on the name an https proxy forwards as Host
      // would otherwise match it.
      if ((!site || site === "none") && originMatchesHost(origin, input.host)) {
        return { allowed: true, reason: "origin matches host" };
      }
      if (site === "same-origin") return { allowed: true, reason: "sec-fetch-site same-origin" };
    }
    // `Origin: null` lands here — a sandboxed iframe or a redirected
    // cross-origin POST. It is not this instance and it is not on the list.
    return { allowed: false, reason: "origin not allowed" };
  }

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
 * Mounted on the TOP-LEVEL app in `src/index.ts`, before any route. In an
 * authenticating mode it goes after `createAuthMiddleware`, so a request with
 * no credential is answered 401 by identity rather than 403 by origin. With
 * auth off it is mounted with `mode: "off"` — there is no session to ride, but
 * any page the user visits can still spend model turns and write state on
 * `localhost:3010`.
 */
export function createOriginMiddleware(
  allowedOrigins: readonly string[],
  dashboardPort: number,
  mode: OriginPolicyMode = "authenticating",
): MiddlewareHandler {
  // Computed once: the set is a property of the configuration, never of a
  // request. Normalised through the same `normalizeOrigin` the allowlist parser
  // uses, so a configured origin and an incoming header can never be compared
  // in two different shapes.
  const accepted = acceptedOrigins(allowedOrigins, dashboardPort);
  return async (c: Context, next) => {
    const decision = decideOrigin({
      method: c.req.method,
      path: c.req.path,
      origin: c.req.header("origin"),
      secFetchSite: c.req.header("sec-fetch-site"),
      host: c.req.header("host"),
      allowedOrigins: accepted,
      mode,
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
