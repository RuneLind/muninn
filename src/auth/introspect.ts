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

/**
 * One introspection's answer, THREE-way rather than `Identity | null`.
 *
 * `denied` means the authority answered and the answer was no — a fact about
 * immutable bytes, safe to remember for a short window and correct to refuse
 * with a login url. `unavailable` means we could not decide (Texas unreachable,
 * non-200, unparseable body, database down): nothing is cached, and the EDGE
 * must answer differently. Collapsing the two into `null` sent every client in
 * the building to /oauth2/login during a Texas outage — a reload storm into the
 * service that was already struggling — and it is why this type reaches the
 * middleware rather than stopping inside the entra introspector.
 */
export type IntrospectionOutcome =
  | { readonly kind: "identity"; readonly identity: Identity }
  | { readonly kind: "denied" }
  | { readonly kind: "unavailable" };

export const DENIED: IntrospectionOutcome = { kind: "denied" };
export const UNAVAILABLE: IntrospectionOutcome = { kind: "unavailable" };

/** The identity an outcome carries, or null. For call sites that genuinely do
 *  not care WHY — and for tests. */
export function identityOf(outcome: IntrospectionOutcome): Identity | null {
  return outcome.kind === "identity" ? outcome.identity : null;
}

export interface Introspector {
  introspect(token: string, channel: TokenChannel): Promise<IntrospectionOutcome>;
}

/**
 * The local introspector accepts a signed session value on either channel, and
 * the raw `MUNINN_LOCAL_TOKEN` on the `credential` channel only.
 */
function createLocalIntrospector(config: AuthConfig): Introspector {
  const local = config.local;
  if (!local) throw new Error("createLocalIntrospector called without a local config");
  return {
    async introspect(token: string, channel: TokenChannel): Promise<IntrospectionOutcome> {
      // Never `unavailable`: this mode compares a string against a config
      // value, so there is no third party that can be down.
      if (token === "") return DENIED;

      const session = verifySession(local.token, token);
      if (session) {
        // The session names a userId, but the pinned identity is the only one
        // this mode has. A session minted before MUNINN_LOCAL_USER changed must
        // NOT keep acting as the old id, so the config wins over the cookie.
        if (session.userId !== local.userId) return DENIED;
        return { kind: "identity", identity: identityFor(local.userId, local.displayName, session.expiresAt) };
      }

      if (channel === "credential" && secretMatches(local.token, token)) {
        return { kind: "identity", identity: identityFor(local.userId, local.displayName, null) };
      }
      return DENIED;
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

/**
 * The HARD ceiling on live cache entries.
 *
 * The sweep below only ever evicts EXPIRED rows, and a denial is live for its
 * whole 30-second window — so before this cap the map's size was an input an
 * unauthenticated client controlled: measured, 5000 distinct forged tokens ⇒
 * 5000 live entries, growing for as long as the flood lasts. The tokens need
 * not be valid, only distinct.
 *
 * 4096 is roughly two orders of magnitude above the real population (one entry
 * per user × token rotation, and a token rotates hourly), so a legitimate
 * instance never reaches it.
 */
export const INTROSPECTION_CACHE_MAX_ENTRIES = 4096;

/** After an eviction the map is left this size, so the next `makeRoom` is ~400
 *  inserts away rather than one — the sort must not run per insert. */
const CACHE_EVICT_TO = Math.floor(INTROSPECTION_CACHE_MAX_ENTRIES * 0.9);

/** Above this many entries the map is swept of expired rows, at most once per
 *  `CACHE_SWEEP_INTERVAL_MS`. Cheap housekeeping; the cap above is the bound. */
const CACHE_SWEEP_AT = 512;
const CACHE_SWEEP_INTERVAL_MS = 30_000;

interface CacheEntry {
  readonly identity: Identity | null;
  readonly expiresAt: number;
}

/** Texas's introspection response, as much of it as we read. Everything is
 *  `unknown`-guarded: this is a network payload, not a typed contract. */
interface IntrospectionResponse {
  active?: unknown;
  oid?: unknown;
  NAVident?: unknown;
  name?: unknown;
  exp?: unknown;
  /** Entra's identity type. `"app"` for a client-credentials token — a MACHINE,
   *  not a colleague. Absent on plenty of ordinary tokens, so only a present
   *  non-`user` value is a refusal. */
  idtyp?: unknown;
}

/** The claims a token yielded, before they become a `users.id`. */
export interface NavClaims {
  /** The Entra object id — the match key. It is the only claim immutable for a
   *  person within a tenant. */
  readonly oid: string;
  /** `NAVident`, when the token carries it. The manifest's `claims.extra` lives
   *  in another repo, so every consumer must work without it. */
  readonly navIdent: string | null;
  /** The `name` claim — cosmetic, refreshed on every login. */
  readonly displayName: string | null;
  /** `MUNINN_TENANT`. Provenance, never a check — see `db/user-identities.ts`. */
  readonly tenant: string;
}

/** The claims PLUS the token's own expiry. Only the introspector needs the
 *  second half; the linking table takes {@link NavClaims}, which is why the two
 *  are one type with an extension rather than two hand-kept copies (they were,
 *  and `NavIdentityClaims` drifted a doc comment apart from this one). */
export interface NavTokenClaims extends NavClaims {
  /** Epoch ms, or null when the token declared no usable `exp`. */
  readonly expiresAt: number | null;
}

/**
 * The entra introspector, plus the ONE thing a test needs that the interface
 * does not carry: how many entries the cache holds. The size cap is invisible
 * from the outside — an unbounded map answers every request correctly and just
 * grows — so without an observable it could only be asserted by reasoning.
 */
export interface EntraIntrospector extends Introspector {
  readonly cacheSize: () => number;
}

export interface EntraIntrospectorDeps {
  /** The POST to Texas. Injectable so the cache and single-flight are testable
   *  without a network — and so a test can COUNT calls, which is the only way
   *  to assert "one Texas call for two credential paths". */
  readonly post?: (endpoint: string, token: string) => Promise<Response>;
  /** Claims → `users.id`. Defaults to the DB linking table, imported lazily so
   *  this module stays loadable (and unit-testable) with no database. */
  readonly resolveUser?: (claims: NavTokenClaims) => Promise<string>;
  readonly now?: () => number;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** `exp` is seconds since epoch per RFC 7662. A non-numeric or absent value
 *  yields null — which is a claim about the BODY, not a cap: the entra path
 *  never lets that null reach `Identity.expiresAt` (it defaults it to
 *  `settledAt + INTROSPECTION_CACHE_MAX_MS`, see the identity return below),
 *  precisely because `src/chat/ws.ts` reads a null there as "no cap" and the
 *  socket then outlived its own credential. */
function expiryMs(value: unknown): number | null {
  const seconds = typeof value === "number" ? value : Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds * 1000) : null;
}

/** Parse an introspection body into claims, or null for every refusal —
 *  `active` anything but `true`, or no `oid` (the match key: without it there is
 *  no stable row to link, and minting per-login would give one person a new
 *  account every hour). */
export function claimsFromIntrospection(body: unknown, tenant: string): NavTokenClaims | null {
  if (typeof body !== "object" || body === null) return null;
  const res = body as IntrospectionResponse;
  if (res.active !== true) return null;
  // An APP token introspects as active WITH an oid, so without this gate a
  // client-credentials caller was provisioned a `users` row and held a role,
  // memories and threads like a person. Absent ⇒ allowed: Texas need not send
  // the claim, and refusing on its absence would refuse every human token.
  const idtyp = str(res.idtyp);
  if (idtyp && idtyp.toLowerCase() !== "user") return null;
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

/**
 * The KINDS of shape mismatch {@link denialReason} can report.
 *
 * A closed set on purpose: it is the warn-once KEY, and the key must not carry
 * anything a caller controls — see the note on `warnedReasons` below.
 */
export type DenialReasonKind = "idtyp-not-user" | "no-oid";

/** One reported refusal: a bounded `kind` to key a warn-once on, and the prose
 *  an operator reads. */
export interface DenialReasonReport {
  readonly kind: DenialReasonKind;
  readonly message: string;
}

/**
 * WHY a body that claimed `active: true` was nonetheless refused, or null when
 * there is nothing to report (an ordinary `active: false`, or a body that
 * parsed fine).
 *
 * It exists because the refusal is otherwise SILENT: an `active: true` body
 * whose `oid` claim is missing or misspelled is cached as a denial with no log
 * line, so every colleague 401s while the sidecar, the pod and Texas all look
 * healthy. One line naming the claim turns that into a five-minute diagnosis.
 * Pure, so the shapes are testable without a network.
 *
 * ⚠️ It returns a `kind` BESIDE the message because the message interpolates
 * `idtyp` — a value that arrives in a response body — and the message was what
 * keyed the warn-once set. That made the set's size an input a caller could
 * grow: a distinct `idtyp` per token is a distinct key, a distinct entry and a
 * distinct log line, so the "one line per distinct reason" discipline was
 * unbounded in exactly the state it exists to bound. The `kind` is one of two
 * literals.
 */
export function denialReason(body: unknown): DenialReasonReport | null {
  if (typeof body !== "object" || body === null) return null;
  const res = body as IntrospectionResponse;
  if (res.active !== true) return null;   // Texas answering the question, not a shape mismatch.
  const idtyp = str(res.idtyp);
  if (idtyp && idtyp.toLowerCase() !== "user") {
    return {
      kind: "idtyp-not-user",
      message: `the token's idtyp is "${idtyp}", not "user" — a client-credentials (app) token is not a person`,
    };
  }
  if (!str(res.oid)) {
    return {
      kind: "no-oid",
      message: "the body carries no usable `oid` claim, which is the match key for a users row",
    };
  }
  return null;
}

/**
 * One line per distinct reason KIND, not per request and not per message. A
 * body-shape mismatch is the same for every token in flight, and a probed
 * instance would otherwise write one line per attempt — the `middleware.ts` /
 * `ws-upgrade.ts` discipline.
 *
 * ⚠️ Every key here must come from a CLOSED set (`DenialReasonKind`, or a
 * literal at the call site). This is an unbounded `Set` that never sweeps, so a
 * key carrying a response-body value is a memory growth path an unauthenticated
 * caller drives.
 */
const warnedReasons = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warnedReasons.has(key)) return;
  warnedReasons.add(key);
  log.warn(message);
}

/**
 * Is this the permanent "no `users.id` can be minted from these claims"
 * refusal? See `UnmintableClaimsError` in `src/db/user-identities.ts` for why
 * the check is STRUCTURAL rather than an `instanceof` — this module's only edge
 * to `src/db/` is a lazy `import()`, and it stays that way.
 */
function isUnmintableClaims(err: unknown): boolean {
  return typeof err === "object" && err !== null &&
    (err as { unmintableClaims?: unknown }).unmintableClaims === true;
}

/**
 * The warn-once key for an unmintable-claims refusal. The error's
 * `unmintableKind` ("mint" | "collision") joins the key so the two conditions
 * log independently — the collision message is the operator-actionable one
 * ("resolve by hand", naming both ids), and under a shared key it was silenced
 * for the process lifetime by any earlier empty-slug refusal. Still a closed
 * set: the kind has two literals and the fallback is one more.
 */
function unmintableWarnKey(err: unknown): string {
  const kind = (err as { unmintableKind?: unknown }).unmintableKind;
  return `unmintable-claims:${kind === "collision" ? "collision" : "mint"}`;
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
export function createEntraIntrospector(config: AuthConfig, deps: EntraIntrospectorDeps = {}): EntraIntrospector {
  const entra = config.entra;
  if (!entra) throw new Error("createEntraIntrospector called without an entra config");

  const now = deps.now ?? (() => Date.now());
  const post = deps.post ?? defaultPost;
  const resolveUser = deps.resolveUser ?? defaultResolveUser;

  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<IntrospectionOutcome>>();
  let lastSweepAt = 0;

  const sweep = (at: number): void => {
    lastSweepAt = at;
    for (const [key, entry] of cache) if (entry.expiresAt <= at) cache.delete(key);
  };

  /**
   * Make room for one insert. Two stages, and the second is the actual bound.
   *
   * Sweeping only removes EXPIRED rows, which a flood of live denials has none
   * of — so when the map is still at the ceiling afterwards, the SOONEST-to-
   * expire entries are evicted. Soonest-first is what keeps the working
   * sessions: a denial lives 30 s, a real identity up to five minutes, so a
   * flood evicts itself before it evicts a colleague. Eviction leaves the map
   * at 90% of the cap so the sort runs about once per 400 inserts rather than
   * once per insert.
   */
  const makeRoom = (at: number): void => {
    if (cache.size >= CACHE_SWEEP_AT && at - lastSweepAt >= CACHE_SWEEP_INTERVAL_MS) sweep(at);
    if (cache.size < INTROSPECTION_CACHE_MAX_ENTRIES) return;
    sweep(at);
    if (cache.size < INTROSPECTION_CACHE_MAX_ENTRIES) return;
    const byExpiry = [...cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (let i = 0; i < byExpiry.length - CACHE_EVICT_TO; i++) cache.delete(byExpiry[i]![0]);
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
  const introspectFresh = async (token: string): Promise<IntrospectionOutcome> => {
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
    if (!claims) {
      // …but say WHY when the body claimed to be active. A shape mismatch
      // (a missing `oid`, an app token) is otherwise a silent 401 for every
      // colleague with three healthy-looking services behind it.
      const reason = denialReason(body);
      if (reason) {
        warnOnce(reason.kind, `Token introspection answered active but was refused: ${reason.message}`);
      }
      return DENIED;
    }

    // Texas can answer `active: true` for a token whose own `exp` has passed —
    // measured against the stub, such a token got a 200 AND provisioned a user.
    // The cache clamped its TTL to `exp` so it was never REUSED, which is why
    // it looked handled: every request simply asked again and was let in again.
    if (claims.expiresAt !== null && claims.expiresAt <= now()) return DENIED;

    let userId: string;
    try {
      userId = await resolveUser(claims);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A claim set no id can be minted from is a PERMANENT property of this
      // token, not an outage — so it is a denial, and takes the 30 s negative
      // cache. Answered `unavailable` it was 503 + retryable + uncached, i.e.
      // every retry from every open tab spent another Texas round-trip, another
      // provisioning transaction and another log line, forever.
      if (isUnmintableClaims(err)) {
        warnOnce(unmintableWarnKey(err), `Refusing an Entra login: ${message}`);
        return DENIED;
      }
      // Everything else here IS an outage: the database is the provisioning
      // path, so a DB failure refuses the login rather than inventing an
      // identity — and, like a transport failure, says nothing about the token,
      // so it is not cached.
      // No `oid` property: these lines land in a JSONL file sink, and an oid
      // is a directory-wide personal identifier that adds nothing an operator
      // acting on this line can use. The message says WHAT failed; the DB says
      // who. Same rule in `src/db/user-identities.ts`.
      log.error("Could not resolve an Entra identity to a users.id: {error}", { error: message });
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
        // NEVER null on this path. `expiresAt: null` reads as "no cap" at the
        // WebSocket (`src/chat/ws.ts`), so a token with a missing, zero or
        // garbage `exp` produced a socket that outlived its own credential —
        // measured, still streaming eight seconds past it. The introspection
        // cap is the honest bound: it is the longest this process goes without
        // re-asking Texas anyway, so nothing is claimed that is not checked.
        expiresAt: claims.expiresAt ?? now() + INTROSPECTION_CACHE_MAX_MS,
      },
    };
  };

  return {
    cacheSize: () => cache.size,

    async introspect(token: string, channel: TokenChannel): Promise<IntrospectionOutcome> {
      if (token === "") return DENIED;
      // The cookie channel is refused OUTRIGHT. `writeSessionCookie` no-ops in
      // `entra` mode, so muninn mints no cookie there and a `muninn_session`
      // value can only be something a client made up — introspecting it would
      // spend a Texas round-trip per forged cookie, i.e. hand any browser a
      // request amplifier against the platform's auth service.
      if (channel === "session") return DENIED;

      const key = cacheKey(token);
      const hit = cache.get(key);
      if (hit && hit.expiresAt > now()) {
        return hit.identity ? { kind: "identity", identity: hit.identity } : DENIED;
      }

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
              makeRoom(settledAt);
              cache.set(key, { identity, expiresAt: ttl });
            }
          }
          return result;
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
async function defaultResolveUser(claims: NavTokenClaims): Promise<string> {
  const { resolveNavUser } = await import("../db/user-identities.ts");
  const row = await resolveNavUser(claims);
  // The one place a first login is announced. It used to be logged from inside
  // `provision()`'s TRANSACTION — i.e. before the commit — and the returned
  // `provisioned` flag was read by nothing but a test.
  if (row.provisioned) log.info("Provisioned a new Entra identity as {userId}", { userId: row.userId });
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
