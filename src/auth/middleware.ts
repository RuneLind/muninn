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
import { getConnInfo } from "hono/bun";
import type { Context, MiddlewareHandler, Next } from "hono";
import { getLog } from "../logging.ts";
import { AUTH_EXCLUDED_PATHS, type AuthConfig } from "./mode.ts";
import { createIntrospector, type Identity } from "./introspect.ts";
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
 * Headers whose PRESENCE proves the request came through a reverse proxy, and
 * therefore did NOT originate on this machine.
 *
 * Measured 2026-08-25 against a live `tailscale serve` publishing
 * `127.0.0.1:3010` to a tailnet (hostnames below are illustrative):
 * a request from another tailnet device arrives with peer address
 * **`127.0.0.1`** — identical to a local `curl`. A loopback check on the peer
 * address ALONE therefore hands the bypass below to every device on the
 * tailnet, which is precisely the exposure this whole campaign exists to close.
 *
 * What separates them is that the proxy stamps `x-forwarded-for`,
 * `x-forwarded-host`, `x-forwarded-proto`, `tailscale-headers-info` and the
 * `tailscale-user-*` set, while a direct `curl 127.0.0.1:3010` sends only
 * `host`, `accept` and `user-agent`. Also measured: a tailnet client that tries
 * to strip or blank those headers does not succeed — the proxy overwrites them.
 *
 * The direction is what makes this safe. Header presence can only REMOVE the
 * bypass, never grant it, so a forged header is a request that authenticates
 * normally rather than one that gets in.
 */
const PROXY_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "forwarded",
  "tailscale-headers-info",
  // The whole `tailscale-user-*` family, not just the one the identity check
  // would read: which subset the proxy sends is tailscale's choice, not ours,
  // and every added name can only make the bypass HARDER to reach.
  "tailscale-user-login",
  "tailscale-user-name",
  "tailscale-user-profile-pic",
] as const;

/**
 * Test-only override for the loopback bypass.
 *
 * Not an env var, and that is the point: §8 requires a bypass "no auth config
 * can revoke", because a wrong secret on an always-on instance is a lockout
 * from the road with no console. An in-process seam is not auth config and is
 * unreachable over HTTP — the same shape `src/wiki/readonly.ts` uses. It exists
 * because every automated test runs over loopback, so without it the 401 path
 * could not be exercised at all.
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

/** True when the request came from this machine directly — no proxy in front. */
export function isDirectLoopback(address: string | undefined, headers: Headers): boolean {
  if (!isLoopbackAddress(address)) return false;
  return !PROXY_HEADERS.some((h) => headers.has(h));
}

/** Warn-once: losing the peer address means losing the escape hatch, and a
 *  per-request warn on a page that polls would bury it. */
let warnedNoPeer = false;

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

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** The credential a client presented explicitly, as opposed to the ambient
 *  cookie. Checked in a fixed order; the query form is last because it is the
 *  one that ends up in browser history. */
function presentedToken(c: Context): string | null {
  const header = c.req.header(TOKEN_HEADER);
  if (header && header.trim() !== "") return header.trim();

  const authorization = c.req.header("authorization");
  if (authorization && /^bearer\s+/i.test(authorization)) {
    const value = authorization.replace(/^bearer\s+/i, "").trim();
    if (value !== "") return value;
  }

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

function sessionCookie(value: string, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    // Lax, not None. Lax is the secure default and blocks the cross-site POST
    // half of the CSRF surface on its own — which PR C should know about, since
    // a CSRF test written against a POST will be green here whether or not its
    // origin check exists. The half Lax does NOT cover is the side-effecting
    // top-level GET (`GET /chat/pending/:threadId`, `GET /api/research/ask`),
    // which is where PR C's check earns its keep and where its test belongs.
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
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

export function createAuthMiddleware(config: AuthConfig): MiddlewareHandler {
  const introspector = createIntrospector(config);
  if (!introspector) {
    throw new Error(`createAuthMiddleware called for MUNINN_AUTH="${config.mode}" — nothing to mount.`);
  }

  const grant = async (c: Context, next: Next, identity: Identity, setCookie: string | null) => {
    const role: AuthRole = resolveRole(identity, config.adminIdents);
    c.set("identity", identity);
    c.set("role", role);
    await next();
    if (setCookie) c.res.headers.append("set-cookie", setCookie);
  };

  return async (c, next) => {
    if (AUTH_EXCLUDED_PATHS.includes(c.req.path)) return next();

    const bypassAllowed = loopbackBypassOverride ?? true;
    if (bypassAllowed && isDirectLoopback(peerAddress(c), c.req.raw.headers)) {
      // The escape hatch. `ssh` + `curl 127.0.0.1:3010` must work whatever the
      // auth config says, and it resolves to the SAME pinned identity at the
      // same role `user` — not to admin, or every guard PRs C–D add would be a
      // no-op for the loopback tests that are supposed to prove them.
      const identity = await introspector.introspect(config.local?.token ?? "");
      if (identity) return grant(c, next, identity, null);
    }

    const cookie = readCookie(c.req.header("cookie"), SESSION_COOKIE);
    if (cookie) {
      const identity = await introspector.introspect(cookie);
      if (identity) return grant(c, next, identity, null);
    }

    const presented = presentedToken(c);
    if (presented) {
      const identity = await introspector.introspect(presented);
      if (identity) {
        const setCookie =
          config.local ? sessionCookie(mintSession(config.local.token, identity.userId), isSecureRequest(c)) : null;

        // A secret on the query string lands in history, in the address bar and
        // in any Referer the page later sends. Exchange it for the cookie and
        // redirect to the same URL without it — only for a GET, since a
        // redirected POST would lose its body.
        if (setCookie && c.req.method === "GET" && c.req.query(TOKEN_QUERY_PARAM)) {
          const url = new URL(c.req.url);
          url.searchParams.delete(TOKEN_QUERY_PARAM);
          return new Response(null, {
            status: 302,
            headers: { location: `${url.pathname}${url.search}${url.hash}`, "set-cookie": setCookie },
          });
        }
        return grant(c, next, identity, setCookie);
      }
      log.warn("Rejected a request presenting an invalid credential for {path}", { path: c.req.path });
    }

    return unauthenticated(c, config);
  };
}

declare module "hono" {
  interface ContextVariableMap {
    /** Set by `createAuthMiddleware` in any authenticating mode. Absent with
     *  auth off, where no middleware is mounted at all. */
    identity: Identity;
    role: AuthRole;
  }
}
