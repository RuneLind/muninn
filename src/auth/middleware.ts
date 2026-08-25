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
 * see it. PR D authenticates it in the upgrade handler. Until then an
 * authenticating mode is NOT a closed boundary, and `src/index.ts` says so at
 * boot rather than letting the mode's presence imply otherwise.
 */
import { getCookie, setCookie } from "hono/cookie";
import { getConnInfo } from "hono/bun";
import type { Context, MiddlewareHandler, Next } from "hono";
import { getLog } from "../logging.ts";
import { AUTH_EXCLUDED_PATHS, type AuthConfig } from "./mode.ts";
import { createIntrospector, localIdentity, type Identity } from "./introspect.ts";
import { resolveRole, type AuthRole } from "./role.ts";
import { mintSession, SESSION_COOKIE, SESSION_TTL_MS } from "./session.ts";

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
 *  one that ends up in browser history. */
function presentedToken(c: Context): string | null {
  const header = c.req.header(TOKEN_HEADER);
  if (header && header.trim() !== "") return header.trim();

  const bearer = c.req.header("authorization")?.match(/^bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) return bearer;

  const query = c.req.query(TOKEN_QUERY_PARAM);
  if (query && query.trim() !== "") return query.trim();

  return null;
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

function unauthenticated(c: Context, config: AuthConfig): Response {
  // JSON, always — a client must be able to tell "session expired" from
  // "server broke" without a browser.
  return c.json(
    {
      error: "unauthenticated",
      mode: config.mode,
      loginUrl:
        config.mode === "local"
          ? `/?${TOKEN_QUERY_PARAM}=${LOGIN_TOKEN_PLACEHOLDER}`
          : "/oauth2/login",
    },
    401,
  );
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

export function createAuthMiddleware(config: AuthConfig): MiddlewareHandler {
  const introspector = createIntrospector(config);
  if (!introspector) {
    throw new Error(`createAuthMiddleware called for MUNINN_AUTH="${config.mode}" — nothing to mount.`);
  }
  // Hoisted: the pinned identity is a constant of the config, so re-deriving it
  // per bypassed request (two sha256 digests and an allocation) bought nothing.
  const pinned = config.local ? localIdentity(config.local) : null;
  const hasExclusions = AUTH_EXCLUDED_PATHS.length > 0;

  const grant = async (c: Context, next: Next, identity: Identity, mint: boolean) => {
    const role: AuthRole = resolveRole(identity, config.adminIdents);
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

    const presented = presentedToken(c);
    let identity: Identity | null = null;
    let mint = false;

    const bypassAllowed = loopbackBypassOverride ?? true;
    if (bypassAllowed && pinned && isDirectLoopback(peerAddress(c), c.req.raw.headers)) {
      // The escape hatch. `ssh` + `curl 127.0.0.1:3010` must work whatever the
      // auth config says, and it resolves to the SAME pinned identity at the
      // same role `user` — not to admin, or every guard PRs C–D add would be a
      // no-op for the loopback tests that are supposed to prove them.
      identity = pinned;
      // A login link followed on the host itself should still leave a session
      // behind, so the same URL behaves the same way everywhere.
      if (presented && (await introspector.introspect(presented, "credential"))) mint = true;
    }

    if (!identity) {
      // Cookie: sessions ONLY. The local introspector also accepts the raw
      // shared secret, and honouring that here would mean a hand-set
      // `muninn_session=<MUNINN_LOCAL_TOKEN>` cookie puts the long-lived secret
      // into every request's cookie jar with no expiry — which is exactly the
      // property `src/auth/session.ts` exists to prevent.
      const cookie = getCookie(c, SESSION_COOKIE);
      if (cookie) identity = await introspector.introspect(cookie, "session");
    }

    if (!identity && presented) {
      identity = await introspector.introspect(presented, "credential");
      if (identity) mint = true;
      if (!identity && !warnedRejectedPaths.has(c.req.path)) {
        warnedRejectedPaths.add(c.req.path);
        log.warn("Rejected a request presenting an invalid credential for {path}", { path: c.req.path });
      }
    }

    if (!identity) return unauthenticated(c, config);

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

    return grant(c, next, identity, mint);
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
