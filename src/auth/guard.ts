/**
 * PR C's half of the guard model: **the session identity wins over a claimed
 * one**.
 *
 * A *claimed* id is one the CLIENT names — `:userId` in a path, `body.userId`,
 * `?userId=`. `src/auth/CLAUDE.md`'s "What this does not close" lists them as
 * the thing PR B left open, and this module is what closes them. The other two
 * shapes are PR D's: `requireOwnedResource` for a route that resolves its owner
 * from the ROW (`/chat/conversations/:id`, `/chat/threads/:id`), and
 * `filterToOwner` for a collection route that has no id to check at all
 * (`GET /chat/conversations`).
 *
 * ## Why this returns a result instead of throwing
 *
 * Most call sites are inside a `try { … } catch { return
 * c.json(…, 500) }`. A thrown `HTTPException` would be swallowed by those
 * catches and answered as a 500 — a guard that denies with the wrong status is
 * a guard nobody notices is misfiring. So the caller writes three visible
 * lines and the denial cannot be caught by accident:
 *
 * ```ts
 * const own = requireOwnUser(c, c.req.param("userId"));
 * if (!own.ok) return own.response;
 * const userId = own.userId;
 * ```
 *
 * It is also what makes acceptance 12's fixture meaningful: `requireOwnUser(`
 * greps, and a route that reads a claimed id without one is visible.
 *
 * ## The three branches
 *
 * | mode | role | answer |
 * |---|---|---|
 * | `off` (no middleware, no identity) | — | the claim, VERBATIM |
 * | authenticating | `user` | the session id; **403** if a claim is present and differs |
 * | authenticating | `admin` | the claim, verbatim, plus an audit log line |
 *
 * The branch is on **authenticating vs off**, never on `entra`. Keying it to
 * `entra` is what made the first cut of this plan deliver nothing: every guard
 * was gated on a mode no LAN host can reach.
 *
 * `userId` is `string | undefined` rather than `string` on purpose. In `off`
 * mode an absent claim stays absent, so a call site keeps its own default
 * (`own.userId ?? "sim-user-1"`) and today's muninn is unchanged. In an
 * authenticating mode it is ALWAYS a string, which is precisely what makes
 * `"sim-user-1"` unreachable there — acceptance 9.
 *
 * A call site reading a PATH parameter writes `own.userId!`: Hono only matches
 * `:userId` against a non-empty segment, so with auth off the claim is a string
 * by construction and in an authenticating mode it is the session id. A site
 * reading a BODY or QUERY value keeps its own `if (!userId) return 400`, because
 * there the absence is real.
 */
import type { Context } from "hono";
import { getLog } from "../logging.ts";
import type { Identity } from "./introspect.ts";
import type { AuthRole } from "./role.ts";
import { auditAdminPassthrough } from "./audit.ts";
import { authMode } from "./policy.ts";

const log = getLog("auth", "guard");

export type OwnUserResult =
  | {
    readonly ok: true;
    /** The id the handler must use. `undefined` only in `off` mode with no claim. */
    readonly userId: string | undefined;
    /** The display name the handler must use, when the session dictates one.
     *  `undefined` in `off` mode and on the admin passthrough, where the
     *  client-supplied name is still the honest answer. */
    readonly username: string | undefined;
  }
  | { readonly ok: false; readonly response: Response };

/**
 * The identity the middleware resolved, or `null` with auth off.
 *
 * `c.get("identity")` is typed OPTIONAL for exactly this reason — with
 * `MUNINN_AUTH` unset no middleware is mounted, so a guard written as
 * `c.get("identity").userId` would compile and throw on the DEFAULT config.
 */
export function sessionIdentity(c: Context): Identity | null {
  return c.get("identity") ?? null;
}

/** The resolved role, or `null` with auth off. NB `resolveRole(null)` answers
 *  `"admin"`, but nothing calls it with null: with auth off there is no
 *  middleware and this returns `null`, which the guards read as "no identity". */
export function sessionRole(c: Context): AuthRole | null {
  return c.get("role") ?? null;
}

function forbidden(c: Context): Response {
  // A plain 403 with no echo of the claimed id: the id set is derivable
  // (`sha256("<userId>:<bot>:web")`), so an error message repeating what was
  // claimed would confirm ids back to a prober.
  return c.json(
    { error: "forbidden", reason: "userId does not match the authenticated session" },
    403,
  );
}

/**
 * @param claimedUserId the id the CLIENT named — a path param, a body field or
 *        a query value. Pass it even when it is `undefined`; the absence is
 *        part of what the guard decides.
 * @param claimedUsername the client-supplied display name, where the route has
 *        one. `username` is a second claimed identity: it never clobbers
 *        `users.username` (the web path passes `lockUsername`), but it DOES
 *        reach the prompt's speaker label, `traces.username`, the
 *        `activity_log` row and `AgentRun.username`, none of which are
 *        protected. Those four sinks are what acceptance 9 asserts on.
 */
export function requireOwnUser(
  c: Context,
  claimedUserId: string | undefined | null,
  claimedUsername?: string | undefined | null,
): OwnUserResult {
  const claimed = typeof claimedUserId === "string" && claimedUserId !== "" ? claimedUserId : undefined;
  const claimedName = typeof claimedUsername === "string" && claimedUsername !== "" ? claimedUsername : undefined;

  const identity = sessionIdentity(c);
  if (!identity) {
    // Auth off: no middleware ran, so there is nothing to compare against and
    // nothing to force. This is what "off is off" means for PR C.
    return { ok: true, userId: claimed, username: claimedName };
  }

  if (sessionRole(c) === "admin") {
    // §4: role beats the own-data guard, because an operator reaching another
    // user's rows is the reason the dashboard exists. Audited rather than
    // silent. In `local` mode this branch is inert at the DEFAULT
    // `MUNINN_LOCAL_ROLE=user` (the pinned identity resolves to `user`, so this
    // is never entered) — the default is deliberate, since an admin passthrough
    // by default would make acceptance 9 pass without the diff. But
    // `MUNINN_LOCAL_ROLE=admin` on a credential-channel request DOES make the
    // pinned identity admin, and then this branch runs and the audit below
    // fires. It is not unconditionally inert in `local` mode.
    if (claimed && claimed !== identity.userId) {
      log.info("Admin {admin} read a claimed userId {claimed} on {path}", {
        admin: identity.userId,
        claimed,
        path: c.req.path,
      });
      // …and on the operator's own feed, which is where a person would notice.
      // Gated to `entra` inside: on a `local` instance every row is self-audit.
      auditAdminPassthrough({
        mode: authMode(),
        reader: identity.userId,
        owner: claimed,
        path: c.req.path,
        kind: "claimed-id",
      });
    }
    return { ok: true, userId: claimed ?? identity.userId, username: claimedName };
  }

  if (claimed && claimed !== identity.userId) return { ok: false, response: forbidden(c) };

  return { ok: true, userId: identity.userId, username: identity.displayName };
}

/**
 * A HEAD-shaped denial. `GET|HEAD /chat/reports/:botName/:userId/:issueKey` is
 * a 200/404 **oracle** over whether a colleague has a saved report for a given
 * Jira key, and the chat client probes exactly that endpoint — so the HEAD
 * routes are guarded like their GET siblings, with a bodyless response because
 * a HEAD carries none.
 */
export function forbiddenHead(c: Context): Response {
  return c.body(null, 403);
}

/**
 * Whether memory / goal / schedule extraction must be forced OFF for this
 * session, whatever the client asked for.
 *
 * §8's ROS decision: extraction is off for `platform = 'entra'` users in v1.
 * Every turn a NAV colleague types would otherwise have *distilled facts about
 * them* written to `memories` and `goals` as a side effect of ordinary use,
 * which is a data class with no retention answer yet.
 *
 * The seam already existed — `ProcessMessageParams.skipExtractions`, threaded
 * end to end — but it is **client-supplied** (a checkbox in the inspector
 * panel), so the rule has to be a server-side force a client value cannot
 * clear: `body.skipExtractions || extractionsForcedOff(c)`.
 *
 * Answers `false` for a `local` identity and with auth off, so this is inert
 * today and stays inert until the deferred Entra half lands. It is here rather
 * than there because it is one line in a route file PR C is already rewriting,
 * and because "turn it on later" is then a decision with a named owner rather
 * than a default nobody chose.
 */
export function extractionsForcedOff(c: Context): boolean {
  return sessionIdentity(c)?.provider === "entra";
}
