/**
 * The instance-wide auth facts that a module OUTSIDE the request path needs.
 *
 * `requireOwnUser` and the origin middleware both read the resolved identity
 * off the Hono context, so they need nothing from here. Two readers cannot:
 *
 *  - `src/db/memories.ts`, whose `scope = 'shared'` branch is a CROSS-USER read
 *    and must be narrowed on an instance that has more than one identity. It is
 *    called from four places (the prompt builder, the briefing prompt, the wiki
 *    reader's saved-notes block and the retrieval benchmark), none of which
 *    carry a Hono context.
 *  - the route sites that answer `Access-Control-Allow-Origin`, which are spread
 *    over seven files and have no access to the `AuthConfig` `src/index.ts`
 *    resolved at boot.
 *
 * So the mode is published once, at boot, and read as a plain value. The
 * DEFAULT is `off` — a standalone `createDashboardRoutes(config)` in a unit test
 * has no boot path, and `off` is what such a test is entitled to assume.
 *
 * This is deliberately NOT how the guards work. A missed `setAuthPolicy` call
 * would silently widen CORS and shared-memory reads; a missed guard would not
 * exist at all. `src/auth/wiring.test.ts` pins the one call site.
 */
import type { AuthConfig, AuthMode } from "./mode.ts";
import { isAuthenticatingMode } from "./mode.ts";

interface Policy {
  readonly authenticating: boolean;
  readonly allowedOrigins: readonly string[];
  /** The single `users.id` a `local` instance acts as, else null. */
  readonly pinnedUserId: string | null;
  /** The resolved mode, for the one reader that needs the MODE rather than the
   *  authenticating/off split: `src/auth/audit.ts`, whose rows are gated to
   *  `entra` because on a `local` instance every one is self-audit. */
  readonly mode: AuthMode;
}

const OFF: Policy = { authenticating: false, allowedOrigins: [], pinnedUserId: null, mode: "off" };

let current: Policy = OFF;

/** Called once from `src/index.ts`, immediately after `resolveAuthConfig()`. */
export function setAuthPolicy(config: AuthConfig): void {
  current = {
    authenticating: isAuthenticatingMode(config.mode),
    allowedOrigins: config.allowedOrigins,
    pinnedUserId: config.local?.userId ?? null,
    mode: config.mode,
  };
}

/** The resolved `MUNINN_AUTH` mode, `off` until `setAuthPolicy` runs. */
export function authMode(): AuthMode {
  return current.mode;
}

/** Test-only reset to the `off` default (the `src/wiki/readonly.ts` idiom). */
export function __setAuthPolicyForTest(policy: Partial<Policy> | null): void {
  current = policy === null ? OFF : { ...OFF, ...policy };
}

/** True on an instance that resolves an identity per request. */
export function isAuthenticatingInstance(): boolean {
  return current.authenticating;
}

export function policyAllowedOrigins(): readonly string[] {
  return current.allowedOrigins;
}

/**
 * The single identity a `local` instance acts as, for the readers that ask
 * "which user is this bot's web chat" and have no request context.
 *
 * `bot_default_user` is written by exactly one thing: the chat page's user
 * dropdown. PR C hides that dropdown when the server owns the id, which retires
 * the field's only writer — and six readers degrade SILENTLY when it is unset:
 * `fetchSavedNotes` returns `[]` with no log line (the wiki reader's saved-notes
 * injection into Ask/Explain simply vanishes), `POST /api/wiki/remember`
 * refuses, `loadInterestProfileForBot` loses the gardener drain's fallback, and
 * three user-resolution chains fall through.
 *
 * The alternative was to keep the client writing it, which would mean an
 * authenticated page calling a route §4 puts in the ADMIN zone — the one thing
 * PR C's client change exists to stop. So the fallback is server-side.
 *
 * It is NOT a repurposing of the field (see the decision page about the last
 * time `bot_default_user` was asked a question it does not answer): on a
 * single-identity instance the pinned user IS the answer to "which persona is
 * the web chat acting as". Null in every other mode, where the stored value —
 * or its absence — still rules.
 */
export function pinnedLocalUserId(): string | null {
  return current.pinnedUserId;
}

/**
 * Whether a memory row with `scope = 'shared'` written by ANOTHER user may be
 * read into this user's prompt.
 *
 * `shared` means "visible to every user of this bot" and its rows go verbatim
 * into the system prompt under `Shared team knowledge:` — with the scope
 * assigned per turn by a fire-and-forget Haiku classifier, i.e. by a model, not
 * by the person. On a single-identity instance that is the feature. On an
 * instance that authenticates, it is one colleague's content entering another
 * colleague's model context, and neither a route guard nor a frame test can see
 * it: it is a WHERE clause.
 *
 * The narrowing keeps the reader's OWN shared rows (the filter becomes
 * `user_id = $1` across both scopes rather than `scope = 'personal' AND
 * user_id = $1`), so a single-operator `local` instance loses nothing it wrote
 * itself. Re-widening this to a trusted-writer set is a re-plan decision.
 */
export function sharedMemoryReadsAllowed(): boolean {
  return !current.authenticating;
}
