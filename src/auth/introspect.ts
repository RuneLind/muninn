/**
 * The seam: one interface, `token → identity | null`.
 *
 * Everything that differs between "a shared secret on a tailnet" and "a Texas
 * introspection call against Entra" lives behind this. The middleware knows
 * only that it holds a string and may get an `Identity` back — which is what
 * keeps the deferred NAV half to a claim-name mapping and a URL rather than a
 * second code path through the request pipeline.
 */
import type { AuthConfig, LocalAuthConfig } from "./mode.ts";
import { secretMatches, verifySession } from "./session.ts";

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
 * prevent. The seam carries it so the deferred Entra introspector inherits the
 * same discipline rather than rediscovering it.
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

/** Null in `off` mode — there is nothing to introspect and no middleware to
 *  call it. Throws for `entra`, which cannot boot (see `AUTH_ZONES_IMPLEMENTED`);
 *  reaching this line at all would mean the boot refusal was bypassed. */
export function createIntrospector(config: AuthConfig): Introspector | null {
  if (config.mode === "off") return null;
  if (config.mode === "local") return createLocalIntrospector(config);
  throw new Error(
    `No introspector for MUNINN_AUTH="${config.mode}". The Entra/Texas introspector is deferred ` +
    `with the zone model; resolveAuthConfig() should have refused this boot.`,
  );
}
