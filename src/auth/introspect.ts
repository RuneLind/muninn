/**
 * The seam: one interface, `token → identity | null`.
 *
 * Everything that differs between "a shared secret on a tailnet" and "a Texas
 * introspection call against Entra" lives behind this. The middleware knows
 * only that it holds a string and may get an `Identity` back — which is what
 * keeps the deferred NAV half to a claim-name mapping and a URL rather than a
 * second code path through the request pipeline.
 */
import { createHash } from "node:crypto";
import { getLog } from "../logging.ts";
import type { AuthConfig, LocalAuthConfig } from "./mode.ts";
import { secretMatches, verifySession } from "./session.ts";

const log = getLog("auth", "introspect");

export type IdentityProvider = "local" | "entra";

export interface Identity {
  /** The muninn `users.id` this session acts as. */
  readonly userId: string;
  readonly displayName: string;
  /** NAV ident, when the provider has one. `null` for local. */
  readonly navIdent: string | null;
  /** Entra object id, when the provider has one. `null` for local. */
  readonly oid: string | null;
  readonly provider: IdentityProvider;
  /** Epoch ms, or null for a credential that does not expire. PR D needs this
   *  to cap a WebSocket's lifetime, which is authenticated once at upgrade. */
  readonly expiresAt: number | null;
}

/**
 * Where the token arrived, which is a SECURITY input, not bookkeeping.
 *
 * `"session"` is the ambient cookie: only a value muninn itself minted may be
 * honoured there. `"credential"` is a token the client attached deliberately
 * (header or query), where the raw shared secret is the whole point.
 *
 * Without this distinction a hand-set `muninn_session=<MUNINN_LOCAL_TOKEN>`
 * cookie authenticates — putting the long-lived secret in every request's
 * cookie jar with no expiry, which is the property `session.ts` exists to
 * prevent. The seam carries it so the Entra introspector inherits the same
 * discipline rather than rediscovering it — and it does: `createEntraIntrospector`
 * refuses the `session` channel outright, with no Texas call at all.
 */
export type TokenChannel = "session" | "credential";

export interface Introspector {
  introspect(token: string, channel: TokenChannel): Promise<Identity | null>;
}

/**
 * The local introspector accepts a signed session value on either channel, and
 * the raw `MUNINN_LOCAL_TOKEN` on the `credential` channel only.
 */
function createLocalIntrospector(config: AuthConfig): Introspector {
  const local = config.local;
  if (!local) throw new Error("createLocalIntrospector called without a local config");
  return {
    async introspect(token: string, channel: TokenChannel): Promise<Identity | null> {
      if (token === "") return null;

      const session = verifySession(local.token, token);
      if (session) {
        // The session names a userId, but the pinned identity is the only one
        // this mode has. A session minted before MUNINN_LOCAL_USER changed must
        // NOT keep acting as the old id, so the config wins over the cookie.
        if (session.userId !== local.userId) return null;
        return identityFor(local.userId, local.displayName, session.expiresAt);
      }

      if (channel === "credential" && secretMatches(local.token, token)) {
        return identityFor(local.userId, local.displayName, null);
      }
      return null;
    },
  };
}

/** The pinned identity as a plain value, so the middleware can hoist it out of
 *  the per-request path instead of re-deriving it through `introspect`. */
export function localIdentity(local: LocalAuthConfig): Identity {
  return identityFor(local.userId, local.displayName, null);
}

function identityFor(userId: string, displayName: string, expiresAt: number | null): Identity {
  return {
    userId,
    displayName,
    // Both null, and that is what makes the pinned identity resolve to role
    // `user` through `resolveRole`'s ordinary path rather than a special case.
    // Both null because a local session has no such claims. NB this is NOT what
    // makes the identity resolve to role `user`: `resolveRole` short-circuits on
    // `provider === "local"` before it looks at any claim. That short-circuit is
    // load-bearing (see `role.ts`) — do not delete it believing these nulls
    // would still deliver `user`.
    navIdent: null,
    oid: null,
    provider: "local",
    expiresAt,
  };
}

// ── The Entra half: one Texas call per token, cached and single-flighted ──

/**
 * How long a POSITIVE introspection may be reused.
 *
 * The entry expires at `min(exp, now + cap)`. The `exp` half is correctness —
 * an expired token must stop working the moment it expires. The CAP is the
 * revocation bound: Texas is the only thing that knows a token was revoked, so
 * the cap is the longest a revoked credential keeps working here. Five minutes
 * against an ~1h access token means we ask Texas roughly a dozen times per user
 * per token lifetime rather than once per request.
 */
export const INTROSPECTION_CACHE_MAX_MS = 5 * 60_000;

/**
 * How long a DEFINITIVE `active: false` is remembered.
 *
 * Short, and deliberately not zero: an expired token in a background tab
 * retries on a timer, and each retry would otherwise be a Texas round-trip. It
 * is safe because a token string is immutable — `active: false` for these exact
 * bytes cannot become true by refresh, only by Texas having been wrong, which
 * this window bounds.
 *
 * ⚠️ A TRANSPORT failure (Texas unreachable, non-200, unparseable body) is NOT
 * cached at all. Caching an outage would turn a 30-second Texas blip into 30
 * seconds of refused logins per token even after it recovered.
 */
export const INTROSPECTION_NEGATIVE_TTL_MS = 30_000;

/** Beyond this many live entries the map is swept of expired ones before the
 *  next insert. A bound, not a policy: one entry per (user × token rotation). */
const CACHE_SWEEP_AT = 512;

interface CacheEntry {
  readonly identity: Identity | null;
  readonly expiresAt: number;
}

/**
 * One introspection attempt's answer, THREE-way rather than `Identity | null`.
 *
 * `denied` means Texas answered and the answer was no — a fact about immutable
 * bytes, safe to remember for a short window. `unavailable` means we could not
 * decide (Texas unreachable, non-200, unparseable body, database down): the
 * request is refused, but nothing is written to the cache, because remembering
 * an outage keeps refusing logins for a window after it has cleared.
 */
type FreshResult =
  | { readonly kind: "identity"; readonly identity: Identity }
  | { readonly kind: "denied" }
  | { readonly kind: "unavailable" };

const DENIED: FreshResult = { kind: "denied" };
const UNAVAILABLE: FreshResult = { kind: "unavailable" };

/** Texas's introspection response, as much of it as we read. Everything is
 *  `unknown`-guarded: this is a network payload, not a typed contract. */
interface IntrospectionResponse {
  active?: unknown;
  oid?: unknown;
  NAVident?: unknown;
  name?: unknown;
  exp?: unknown;
}

/** The claims a token yielded, before they become a `users.id`. */
export interface NavClaims {
  readonly oid: string;
  readonly navIdent: string | null;
  readonly displayName: string | null;
  readonly tenant: string;
  /** Epoch ms, or null when the token declared no `exp`. */
  readonly expiresAt: number | null;
}

export interface EntraIntrospectorDeps {
  /** The POST to Texas. Injectable so the cache and single-flight are testable
   *  without a network — and so a test can COUNT calls, which is the only way
   *  to assert "one Texas call for two credential paths". */
  readonly post?: (endpoint: string, token: string) => Promise<Response>;
  /** Claims → `users.id`. Defaults to the DB linking table, imported lazily so
   *  this module stays loadable (and unit-testable) with no database. */
  readonly resolveUser?: (claims: NavClaims) => Promise<string>;
  readonly now?: () => number;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** `exp` is seconds since epoch per RFC 7662. A non-numeric or absent value
 *  yields null, which the socket reads as "no cap" — acceptable because the
 *  next introspection is at most `INTROSPECTION_CACHE_MAX_MS` away. */
function expiryMs(value: unknown): number | null {
  const seconds = typeof value === "number" ? value : Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds * 1000) : null;
}

/** Parse an introspection body into claims, or null for every refusal —
 *  `active` anything but `true`, or no `oid` (the match key: without it there is
 *  no stable row to link, and minting per-login would give one person a new
 *  account every hour). */
export function claimsFromIntrospection(body: unknown, tenant: string): NavClaims | null {
  if (typeof body !== "object" || body === null) return null;
  const res = body as IntrospectionResponse;
  if (res.active !== true) return null;
  const oid = str(res.oid);
  if (!oid) return null;
  return {
    oid,
    navIdent: str(res.NAVident),
    displayName: str(res.name),
    tenant,
    expiresAt: expiryMs(res.exp),
  };
}

/** The cache key. A HASH, not the token: the map is process-memory a heap dump
 *  or a debugger reaches, and an access token in it is a credential at rest. */
function cacheKey(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/**
 * The Entra introspector: `token → identity | null` via a Texas introspection
 * POST, with a per-token cache and single-flight in front of it.
 *
 * ⚠️ **Build this ONCE per process and inject it.** The cache and the in-flight
 * map are instance state, and this introspector is also the DB-PROVISIONING
 * path — two instances mean the `/chat/ws` upgrade misses the HTTP cache
 * entirely (precisely the case the cache exists for: the chat page opens both
 * on one token within milliseconds) and two provisioning transactions race on
 * first login. `src/index.ts` builds it and hands it to both
 * `createAuthMiddleware` and `createWsUpgradeAuthorizer`.
 */
export function createEntraIntrospector(config: AuthConfig, deps: EntraIntrospectorDeps = {}): Introspector {
  const entra = config.entra;
  if (!entra) throw new Error("createEntraIntrospector called without an entra config");

  const now = deps.now ?? (() => Date.now());
  const post = deps.post ?? defaultPost;
  const resolveUser = deps.resolveUser ?? defaultResolveUser;

  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<Identity | null>>();

  const sweep = (at: number): void => {
    for (const [key, entry] of cache) if (entry.expiresAt <= at) cache.delete(key);
  };

  /**
   * One Texas round-trip, as a THREE-way answer.
   *
   * `denied` and `unavailable` both refuse the request, but they must not be
   * cached the same way: `denied` is a real answer about immutable bytes and is
   * remembered briefly, while `unavailable` is an outage and remembering it
   * would keep refusing logins for a window after Texas recovered. Collapsing
   * the two into `null` is exactly the bug the cache test caught.
   */
  const introspectFresh = async (token: string): Promise<FreshResult> => {
    let res: Response;
    try {
      res = await post(entra.introspectionEndpoint, token);
    } catch (err) {
      log.warn("Token introspection failed to reach {endpoint}: {error}", {
        endpoint: entra.introspectionEndpoint,
        error: err instanceof Error ? err.message : String(err),
      });
      return UNAVAILABLE;
    }
    if (!res.ok) {
      // A 5xx is plainly an outage; a 4xx from an introspection endpoint means
      // the REQUEST was wrong (a bad endpoint, a rejected provider), not that
      // this token is invalid — neither is a statement about the credential, so
      // neither is cached.
      log.warn("Token introspection answered {status} — refusing the credential", { status: res.status });
      return UNAVAILABLE;
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      log.warn("Token introspection returned a body that is not JSON — refusing the credential");
      return UNAVAILABLE;
    }

    const claims = claimsFromIntrospection(body, entra.tenant);
    // The DEFINITIVE refusal: Texas answered, and the answer was no.
    if (!claims) return DENIED;

    let userId: string;
    try {
      userId = await resolveUser(claims);
    } catch (err) {
      // The database is the provisioning path, so a DB outage refuses the login
      // rather than inventing an identity — and, like a transport failure, says
      // nothing about the token, so it is not cached.
      log.error("Could not resolve an Entra identity to a users.id: {error}", {
        error: err instanceof Error ? err.message : String(err),
        oid: claims.oid,
      });
      return UNAVAILABLE;
    }

    return {
      kind: "identity",
      identity: {
        userId,
        displayName: claims.displayName ?? claims.navIdent ?? claims.oid,
        navIdent: claims.navIdent,
        oid: claims.oid,
        provider: "entra",
        expiresAt: claims.expiresAt,
      },
    };
  };

  return {
    async introspect(token: string, channel: TokenChannel): Promise<Identity | null> {
      if (token === "") return null;
      // The cookie channel is refused OUTRIGHT. `writeSessionCookie` no-ops in
      // `entra` mode, so muninn mints no cookie there and a `muninn_session`
      // value can only be something a client made up — introspecting it would
      // spend a Texas round-trip per forged cookie, i.e. hand any browser a
      // request amplifier against the platform's auth service.
      if (channel === "session") return null;

      const key = cacheKey(token);
      const hit = cache.get(key);
      if (hit && hit.expiresAt > now()) return hit.identity;

      const pending = inFlight.get(key);
      // Single-flight: the chat page's first paint issues an HTTP request and a
      // `/chat/ws` upgrade on the same token within milliseconds, and both miss
      // the cache. Without this that is two Texas calls and two first-login
      // provisioning transactions racing.
      if (pending) return await pending;

      const run = introspectFresh(token)
        .then((result) => {
          const settledAt = now();
          if (result.kind !== "unavailable") {
            const identity = result.kind === "identity" ? result.identity : null;
            const ttl = identity
              ? Math.min(identity.expiresAt ?? Infinity, settledAt + INTROSPECTION_CACHE_MAX_MS)
              : settledAt + INTROSPECTION_NEGATIVE_TTL_MS;
            // A token already past its own `exp` is not cached at all: the entry
            // would be born expired and every request would re-ask Texas anyway.
            if (ttl > settledAt) {
              if (cache.size >= CACHE_SWEEP_AT) sweep(settledAt);
              cache.set(key, { identity, expiresAt: ttl });
            }
          }
          return result.kind === "identity" ? result.identity : null;
        })
        .finally(() => {
          inFlight.delete(key);
        });

      inFlight.set(key, run);
      return await run;
    },
  };
}

/** The Texas introspection call. `identity_provider: "azuread"` and the token
 *  in the body is the endpoint's contract; `active === true` is the only answer
 *  the parser above accepts. */
async function defaultPost(endpoint: string, token: string): Promise<Response> {
  return await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity_provider: "azuread", token }),
    signal: AbortSignal.timeout(10_000),
  });
}

/** Lazily imported so `src/auth/` stays loadable without a database — the unit
 *  tests for the cache and the single flight inject their own. */
async function defaultResolveUser(claims: NavClaims): Promise<string> {
  const { resolveNavUser } = await import("../db/user-identities.ts");
  const row = await resolveNavUser(claims);
  return row.userId;
}

/**
 * Null in `off` mode — there is nothing to introspect and no middleware to call
 * it. `local` gets the shared-secret introspector, `entra` the Texas one.
 *
 * ⚠️ Call this ONCE per process (`src/index.ts`) and inject the result. The
 * entra introspector holds the introspection cache AND is the DB-provisioning
 * path, so a second instance is a second cache the WebSocket upgrade would miss
 * and a second provisioning path racing the first.
 */
export function createIntrospector(config: AuthConfig, deps: EntraIntrospectorDeps = {}): Introspector | null {
  if (config.mode === "off") return null;
  if (config.mode === "local") return createLocalIntrospector(config);
  return createEntraIntrospector(config, deps);
}
