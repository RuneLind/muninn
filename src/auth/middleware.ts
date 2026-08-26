/**
 * The Hono middleware. Mounted on the TOP-LEVEL app (`src/index.ts`) so it
 * covers the dashboard and chat sub-apps alike, and mounted only when
 * `MUNINN_AUTH` names an authenticating mode — with auth off no middleware
 * exists at all, which is what "off is off" means.
 *
 * It sets two context variables and denies nothing else: `identity` and `role`.
 * The guards that READ them are PRs C and D; this PR only makes an identity
 * available and refuses requests that carry none.
 *
 * ⚠️ NOT covered: the `/chat/ws` (and `/simulator/ws`) upgrade. It is handled in
 * `Bun.serve`'s `fetch` before `app.fetch` ever runs, so no Hono middleware can
 * see it. `src/auth/ws-upgrade.ts` (PR D) authenticates it there, and it does so
 * by calling `resolveRequestIdentity` BELOW rather than reading the three
 * credential channels a second time — which is why that function takes
 * primitives instead of a Hono `Context`.
 */
import { setCookie } from "hono/cookie";
import { getConnInfo } from "hono/bun";
import type { Context, MiddlewareHandler, Next } from "hono";
import { getLog } from "../logging.ts";
import { AUTH_EXCLUDED_PATHS, type AuthConfig } from "./mode.ts";
import { localIdentity, type Identity, type Introspector } from "./introspect.ts";
import { resolveRole, type AuthRole } from "./role.ts";
import { mintSession, SESSION_COOKIE, SESSION_TTL_MS } from "./session.ts";
import { LOGIN_URL_HINT } from "./zones.ts";

const log = getLog("auth", "middleware");

/** Query parameter and header a client may present the shared secret on. */
export const TOKEN_QUERY_PARAM = "muninn_token";
export const TOKEN_HEADER = "x-muninn-token";

/** The placeholder in the 401's `loginUrl`. Named so a script can substitute it
 *  and a test can pin it — the real secret is never put in a response body. */
export const LOGIN_TOKEN_PLACEHOLDER = "YOUR_MUNINN_LOCAL_TOKEN";

/**
 * Header names and prefixes whose PRESENCE proves the request came through an
 * HTTP reverse proxy, and therefore did NOT originate on this machine.
 *
 * Measured 2026-08-25 against a live `tailscale serve` publishing
 * `127.0.0.1:3010` to a tailnet: a request from another tailnet device arrives
 * with peer address **`127.0.0.1`**, identical to a local `curl`. A loopback
 * check on the peer address ALONE therefore hands the bypass below to every
 * device on the tailnet. What separates them is that the proxy stamps
 * `x-forwarded-*` and `tailscale-*` while a direct `curl` sends only `host`,
 * `accept` and `user-agent`; a tailnet client that tries to strip or blank them
 * does not succeed, because the proxy overwrites.
 *
 * Prefixes rather than a fixed list of names, because review demonstrated the
 * literal-list version admitting `cf-connecting-ip`, `x-envoy-external-address`,
 * `fly-client-ip` and friends. Every name added can only make the bypass HARDER
 * to reach, which is the direction that keeps this safe: header presence only
 * ever REMOVES the bypass, so a forged header yields a request that must
 * authenticate normally rather than one that gets in.
 *
 * ⚠️ **This test cannot see an L4 forward.** A byte-forwarding proxy —
 * `tailscale serve --tcp`, an nginx `stream` block, `ssh -L`, `socat`,
 * `kubectl port-forward` — adds no headers at all, so a request through one is
 * indistinguishable from a local `curl` at the socket layer and DOES reach the
 * bypass. A bare `nginx proxy_pass` with no `proxy_set_header` is the same
 * class. That is a limit of any peer-address-based escape hatch, not something
 * a longer list can close; `src/auth/CLAUDE.md` names the voiding
 * configurations and `src/index.ts` warns about them at boot.
 */
const PROXY_HEADER_PREFIXES = ["x-forwarded-", "tailscale-", "cf-", "x-envoy-"] as const;
const PROXY_HEADER_NAMES = [
  "forwarded",
  "via",
  "x-real-ip",
  "x-client-ip",
  "true-client-ip",
  "fly-client-ip",
  "x-original-forwarded-for",
] as const;

function hasProxyHeader(headers: Headers): boolean {
  let found = false;
  // `forEach` rather than `for…of`: Headers' iterator is not in this project's
  // TS lib set, and a cast to get one would hide a real portability question.
  headers.forEach((_value, name) => {
    if (found) return;
    const lower = name.toLowerCase();
    if (PROXY_HEADER_PREFIXES.some((p) => lower.startsWith(p))) found = true;
    else if ((PROXY_HEADER_NAMES as readonly string[]).includes(lower)) found = true;
  });
  return found;
}

/**
 * Test-only override for the loopback bypass.
 *
 * Not an env var, and that is the point: §8 requires a bypass "no auth config
 * can revoke", because a wrong secret on an always-on instance is a lockout
 * from the road with no console. An in-process seam is not auth config and is
 * unreachable over HTTP — the same shape `src/wiki/readonly.ts` uses. It exists
 * because every automated test runs over loopback, so without it the 401 path
 * could not be exercised at all. Pass `null` to restore the default.
 */
let loopbackBypassOverride: boolean | null = null;
export function __setLoopbackBypassForTest(enabled: boolean | null): void {
  loopbackBypassOverride = enabled;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.trim().toLowerCase();
  if (a === "::1" || a === "0:0:0:0:0:0:0:1") return true;
  // v4-mapped forms of a v4 loopback, and 127.0.0.0/8 in full — 127.0.0.1 is
  // the common case but the whole /8 routes to this host.
  const v4 = a.startsWith("::ffff:") ? a.slice("::ffff:".length) : a;
  const octets = v4.split(".");
  if (octets.length !== 4) return false;
  const nums = octets.map((o) => (/^\d{1,3}$/.test(o) ? Number(o) : NaN));
  if (nums.some((n) => Number.isNaN(n) || n > 255)) return false;
  return nums[0] === 127;
}

/** True when the request came from this machine with no HTTP proxy in front.
 *  See `PROXY_HEADER_PREFIXES` for what this deliberately cannot detect. */
export function isDirectLoopback(address: string | undefined, headers: Headers): boolean {
  if (!isLoopbackAddress(address)) return false;
  return !hasProxyHeader(headers);
}

/** Warn-once: losing the peer address means losing the escape hatch, and a
 *  per-request warn on a page that polls would bury it. */
let warnedNoPeer = false;
/** Warn-once, keyed by path: an exposed instance being probed would otherwise
 *  write one log line per attempt, which is the house discipline `warnedNoPeer`
 *  above and `src/config.ts`'s `warnedEnvFlagValues` both follow. */
const warnedRejectedPaths = new Set<string>();

/** Test-only: forget the warn-once memories so a test can re-observe a warning. */
export function __resetAuthWarningsForTest(): void {
  warnedNoPeer = false;
  warnedRejectedPaths.clear();
}

function peerAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch (err) {
    if (!warnedNoPeer) {
      warnedNoPeer = true;
      log.error(
        "Could not resolve the peer address ({error}) — the loopback bypass is INERT, so a wrong " +
        "MUNINN_LOCAL_TOKEN now locks this instance out. app.fetch must be called as " +
        "app.fetch(req, server) for hono/bun's getConnInfo to work.",
        { error: err instanceof Error ? err.message : String(err) },
      );
    }
    return undefined;
  }
}

/** The credential a client presented explicitly, as opposed to the ambient
 *  cookie. Checked in a fixed order; the query form is last because it is the
 *  one that ends up in browser history.
 *
 *  Written over a raw `Headers` + URL rather than a Hono `Context` because PR
 *  D's WebSocket upgrade runs BEFORE `app.fetch` and has no context — and the
 *  campaign's own rule is that the upgrade reuses this decision rather than
 *  growing a second one beside it (PR C's first cut of the origin check was a
 *  second implementation, and it was the bypassable one). */
export function presentedToken(headers: Headers, url: string): string | null {
  const header = headers.get(TOKEN_HEADER);
  if (header && header.trim() !== "") return header.trim();

  const bearer = headers.get("authorization")?.match(/^bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) return bearer;

  const query = safeUrl(url)?.searchParams.get(TOKEN_QUERY_PARAM);
  if (query && query.trim() !== "") return query.trim();

  return null;
}

/** `new URL` throws on a target Bun accepted at the socket layer; a throw here
 *  would be a 500 on a path whose whole job is to answer 401. */
function safeUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Read one cookie off a raw `Headers`, for the same no-context reason as
 * {@link presentedToken}.
 *
 * No percent-decoding: `mintSession` emits `v1.<base64url>.<base64url>`, whose
 * alphabet (`A-Za-z0-9-_.`) contains nothing `encodeURIComponent` would have
 * escaped, and anything else reaching `verifySession` is rejected there — one
 * null for every defect. Decoding would only add a `URIError` throw on a
 * malformed `%` a client controls.
 */
export function readCookie(headers: Headers, name: string): string | null {
  const raw = headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value === "" ? null : value;
  }
  return null;
}

export interface IdentityDeps {
  readonly introspector: Introspector;
  /** The pinned `local` identity, or null in a mode that has none. */
  readonly pinned: Identity | null;
}

/**
 * WHICH CHANNEL established the identity — three values, not a `credentialed`
 * boolean, because the two "yes" answers are genuinely different things and the
 * boolean spelling of this got the grant wrong twice in review:
 *
 *  - `"session"` — a valid `muninn_session` cookie. The operator's SECOND and
 *    every later request through a proxy. Reading "a credential was PRESENTED"
 *    instead (`presentedToken`, which sees header/bearer/query and never the
 *    cookie) drops them to `user` permanently one redirect after login.
 *  - `"credential"` — a validly presented token, INCLUDING one presented on a
 *    request that also took the bypass. `ssh` + `curl -H 'x-muninn-token: …'`
 *    must reach the operator surface, so "did not take the bypass branch" is
 *    wrong in the other direction.
 *  - `"bypass"` — the loopback bypass alone, with no credential at all. This is
 *    the only value that must never be granted `MUNINN_LOCAL_ROLE=admin`: the
 *    bypass tests the PEER ADDRESS and is blind to an L4 forward
 *    (`tailscale serve --tcp`, `ssh -L`, `socat`, a bare `proxy_pass`), so
 *    promoting it would hand every client behind one full admin over every
 *    user's data with no credential.
 *
 * Meaningless when `identity` is `null`; `"bypass"` is the inert default there.
 * NB `mint` is NOT this decision — it is `false` in the cookie branch.
 */
export type IdentityVia = "session" | "credential" | "bypass";

export interface IdentityResolution {
  readonly identity: Identity | null;
  /** True when a session cookie should be written back — the client presented a
   *  valid explicit credential. Meaningless on the WebSocket path, which cannot
   *  set a cookie on a 101. */
  readonly mint: boolean;
  /** See {@link IdentityVia}. */
  readonly via: IdentityVia;
}

/**
 * The whole identity decision for one request, over primitives: the loopback
 * bypass, then the session cookie, then an explicitly presented credential.
 *
 * Shared by `createAuthMiddleware` and `src/auth/ws-upgrade.ts`. Extracting it
 * is the point — the upgrade must grant EXACTLY what the middleware grants, and
 * the alternative (a second reading of the same three channels) is how PR C
 * shipped a bypassable origin check.
 */
export async function resolveRequestIdentity(
  headers: Headers,
  url: string,
  peer: string | undefined,
  deps: IdentityDeps,
): Promise<IdentityResolution> {
  const presented = presentedToken(headers, url);
  let identity: Identity | null = null;
  let mint = false;
  let via: IdentityVia = "bypass";

  const bypassAllowed = loopbackBypassOverride ?? true;
  if (bypassAllowed && deps.pinned && isDirectLoopback(peer, headers)) {
    // The escape hatch. `ssh` + `curl 127.0.0.1:3010` must work whatever the
    // auth config says, and it resolves to the SAME pinned identity — at role
    // `user` unless a credential rode along, since a bypass grant costs
    // nothing to obtain and this branch cannot see an L4 forward.
    identity = deps.pinned;
    // A login link followed on the host itself should still leave a session
    // behind, so the same URL behaves the same way everywhere — and a request
    // that DID present a valid secret is credentialed even though the bypass
    // is what happened to answer first. `ssh` + a token header is the escape
    // hatch that has to keep working from the road.
    if (presented && (await deps.introspector.introspect(presented, "credential"))) {
      mint = true;
      via = "credential";
    }
  }

  if (!identity) {
    // Cookie: sessions ONLY. The local introspector also accepts the raw
    // shared secret, and honouring that here would mean a hand-set
    // `muninn_session=<MUNINN_LOCAL_TOKEN>` cookie puts the long-lived secret
    // into every request's cookie jar with no expiry — which is exactly the
    // property `src/auth/session.ts` exists to prevent.
    const cookie = readCookie(headers, SESSION_COOKIE);
    if (cookie) {
      identity = await deps.introspector.introspect(cookie, "session");
      if (identity) via = "session";
    }
  }

  if (!identity && presented) {
    identity = await deps.introspector.introspect(presented, "credential");
    if (identity) {
      mint = true;
      via = "credential";
    }
  }

  return { identity, mint, via };
}

/**
 * The role one request is granted — the ONE place `MUNINN_LOCAL_ROLE` is
 * applied, so the HTTP middleware and the WebSocket upgrade cannot disagree.
 *
 * `resolveRole` has two call sites (`createAuthMiddleware` and
 * `createWsUpgradeAuthorizer`); threading the local role through only one would
 * leave HTTP `admin` and the socket `user` for the same credential, which is a
 * failure nothing else in the suite can see.
 *
 * ⚠️ **A browser ON the muninn host stays `user`.** `resolveRequestIdentity`
 * fills `identity` from the bypass BEFORE the cookie branch is reached (it
 * reads the cookie only `if (!identity)`), so a local browser's session cookie
 * is never consulted and `via` is `"bypass"`. Through a reverse proxy — which
 * stamps `x-forwarded-*` and therefore removes the bypass — the cookie branch
 * runs and the operator gets `admin`. That ordering is shipped PR D behaviour
 * and is deliberately not restructured here.
 */
export function resolveGrantedRole(identity: Identity, via: IdentityVia, config: AuthConfig): AuthRole {
  return resolveRole(identity, config.adminIdents, via === "bypass" ? "user" : config.localRole);
}

function isSecureRequest(c: Context): boolean {
  if ((c.req.header("x-forwarded-proto") ?? "").toLowerCase().split(",")[0]?.trim() === "https") return true;
  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return false;
  }
}

function writeSessionCookie(c: Context, config: AuthConfig, userId: string): void {
  if (!config.local) return;
  setCookie(c, SESSION_COOKIE, mintSession(config.local.token, userId), {
    path: "/",
    httpOnly: true,
    // Lax, not None. Lax is the secure default and blocks the cross-site POST
    // half of the CSRF surface for requests that arrive THROUGH THE PROXY —
    // which PR C must not over-read: a browser running ON this host reaches
    // 127.0.0.1 with no proxy headers and is granted by the loopback bypass
    // before the cookie is ever consulted, so Lax protects nothing there. The
    // half Lax does not cover even remotely is the side-effecting top-level GET
    // (`GET /chat/pending/:threadId`, `GET /api/research/ask`).
    sameSite: "Lax",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    secure: isSecureRequest(c),
  });
}

/** The 401 payload, as a value, so the WebSocket upgrade — which has no Hono
 *  context — refuses in exactly the shape every other route does. §8's
 *  session-expiry UX keys on `loginUrl`, and a socket that refused in a second
 *  shape would be the one place the client could not act on. */
export function unauthenticatedBody(config: AuthConfig): { error: string; mode: string; loginUrl: string } {
  return {
    error: "unauthenticated",
    mode: config.mode,
    loginUrl:
      config.mode === "local"
        ? `/?${TOKEN_QUERY_PARAM}=${LOGIN_TOKEN_PLACEHOLDER}`
        // The chat page's HTTP expiry predicate compares against this exact
        // string (`src/chat/views/components/authed-fetch.ts`), so it is ONE
        // exported constant rather than a literal at each end.
        : LOGIN_URL_HINT,
  };
}

function unauthenticated(c: Context, config: AuthConfig): Response {
  // JSON, always — a client must be able to tell "session expired" from
  // "server broke" without a browser.
  return c.json(unauthenticatedBody(config), 401);
}

/** The same-URL-without-the-secret target. `URL.pathname` keeps a leading `//`,
 *  which a browser resolves as an absolute HOST — review demonstrated
 *  `GET //evil.example/x?muninn_token=…` answering `302 Location: //evil.example/x`
 *  with a fresh session cookie, i.e. an open redirect reached by the very
 *  "login link" this branch exists to clean up. Collapse the leading slashes. */
function tokenStrippedTarget(c: Context): string {
  const url = new URL(c.req.url);
  url.searchParams.delete(TOKEN_QUERY_PARAM);
  const path = `/${url.pathname.replace(/^\/+/, "")}`;
  return `${path}${url.search}${url.hash}`;
}

/**
 * @param introspector Built ONCE at boot by `src/index.ts` and handed to both
 * this and `createWsUpgradeAuthorizer`, deliberately rather than constructed
 * here. In `entra` mode the introspector holds the Texas cache AND is the
 * DB-provisioning path, so a second instance would mean the `/chat/ws` upgrade
 * misses the HTTP cache entirely — the chat page opens both on one token within
 * milliseconds, which is exactly the case the cache exists for — and two
 * provisioning transactions racing on a colleague's first login. `null` is
 * accepted (and refused) so the "nothing to mount with auth off" guard stays
 * where it was.
 */
export function createAuthMiddleware(config: AuthConfig, introspector: Introspector | null): MiddlewareHandler {
  if (!introspector) {
    throw new Error(`createAuthMiddleware called for MUNINN_AUTH="${config.mode}" — nothing to mount.`);
  }
  // Hoisted: the pinned identity is a constant of the config, so re-deriving it
  // per bypassed request (two sha256 digests and an allocation) bought nothing.
  const pinned = config.local ? localIdentity(config.local) : null;
  const hasExclusions = AUTH_EXCLUDED_PATHS.length > 0;

  const grant = async (c: Context, next: Next, identity: Identity, mint: boolean, via: IdentityVia) => {
    const role: AuthRole = resolveGrantedRole(identity, via, config);
    c.set("identity", identity);
    c.set("role", role);
    await next();
    // AFTER next(), not before: `setCookie` prepares a header on the context,
    // and a downstream handler returning a bare `new Response(...)` discards
    // those — only c.json/c.text/c.redirect merge them. Verified in review that
    // the post-next() write lands on a bare Response and on a streamSSE
    // response alike, without corrupting the stream.
    if (mint) writeSessionCookie(c, config, identity.userId);
  };

  return async (c, next) => {
    if (hasExclusions && AUTH_EXCLUDED_PATHS.includes(c.req.path)) return next();

    const { identity, mint, via } = await resolveRequestIdentity(
      c.req.raw.headers,
      c.req.url,
      peerAddress(c),
      { introspector, pinned },
    );

    if (!identity) {
      if (presentedToken(c.req.raw.headers, c.req.url) && !warnedRejectedPaths.has(c.req.path)) {
        warnedRejectedPaths.add(c.req.path);
        log.warn("Rejected a request presenting an invalid credential for {path}", { path: c.req.path });
      }
      return unauthenticated(c, config);
    }

    // A secret on the query string lands in history, in the address bar and in
    // any Referer the page later sends — so strip it whenever it is there on a
    // safe method, NOT only on the request that happened to authenticate with
    // it. Gating on "the cookie check failed" left a bookmarked login URL
    // carrying the secret on every later visit, and left the loopback operator
    // never stripped at all. POST is excluded because a redirected POST loses
    // its body. (The proxy's own access log still records the original request
    // line; `src/auth/CLAUDE.md` says so.)
    const safeMethod = c.req.method === "GET" || c.req.method === "HEAD";
    if (safeMethod && c.req.query(TOKEN_QUERY_PARAM)) {
      if (mint) writeSessionCookie(c, config, identity.userId);
      return c.redirect(tokenStrippedTarget(c), 302);
    }

    return grant(c, next, identity, mint, via);
  };
}

declare module "hono" {
  interface ContextVariableMap {
    /**
     * Set by `createAuthMiddleware` in any authenticating mode — and ABSENT
     * with auth off, where no middleware is mounted at all.
     *
     * Optional deliberately. Declared as `Identity` these read as always-present
     * to every route file in `src/` (the augmentation is repo-global), so a PR
     * C/D guard written as `c.get("identity").userId` would compile green and
     * throw on every request under today's DEFAULT configuration.
     */
    identity?: Identity;
    role?: AuthRole;
  }
}
