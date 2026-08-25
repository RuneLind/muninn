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
 *  - the ~12 route sites that answer `Access-Control-Allow-Origin: *`, which are
 *    spread over eight files and have no access to the `AuthConfig`
 *    `src/index.ts` resolved at boot.
 *
 * So the mode is published once, at boot, and read as a plain value. The
 * DEFAULT is `off` — a standalone `createDashboardRoutes(config)` in a unit test
 * has no boot path, and `off` is what such a test is entitled to assume.
 *
 * This is deliberately NOT how the guards work. A missed `setAuthPolicy` call
 * would silently widen CORS and shared-memory reads; a missed guard would not
 * exist at all. `src/auth/wiring.test.ts` pins the one call site.
 */
import type { AuthConfig } from "./mode.ts";
import { isAuthenticatingMode } from "./mode.ts";

interface Policy {
  readonly authenticating: boolean;
  readonly allowedOrigins: readonly string[];
}

const OFF: Policy = { authenticating: false, allowedOrigins: [] };

let current: Policy = OFF;

/** Called once from `src/index.ts`, immediately after `resolveAuthConfig()`. */
export function setAuthPolicy(config: AuthConfig): void {
  current = {
    authenticating: isAuthenticatingMode(config.mode),
    allowedOrigins: config.allowedOrigins,
  };
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
