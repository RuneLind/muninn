/**
 * PR D's half of the guard model: **whose ROW is this**.
 *
 * `requireOwnUser` (PR C) closes the routes where the client NAMES an id —
 * `:userId`, `body.userId`, `?viewer=`. It structurally cannot reach the other
 * shape: a route addressed by the RESOURCE's own id, which carries no claimed
 * user at all and resolves its owner from the row. `POST
 * /chat/conversations/:id/messages` is the one that matters — it spends a model
 * turn as another person and writes into their thread — and before this module
 * any authenticated caller reached it with nothing but an id.
 *
 * ## It answers 404, never 403
 *
 * A web conversation id is `sha256("<userId>:<botName>:web")[0:16]`, so it is
 * DERIVABLE by anyone who knows a colleague's `users.id`. A 403 would confirm
 * "this id exists and is someone else's"; a 404 confirms nothing. That only
 * works if the denial is byte-identical to the route's own miss, which is why
 * this returns a **verdict, not a Response**: the call site answers with the
 * expression it already had.
 *
 * ```ts
 * const owned = await requireOwnedResource(c, "thread", id);
 * if (!owned.ok) return c.json({ error: "Thread not found" }, 404);
 * ```
 *
 * Two call sites do NOT answer 404, and that is the same rule rather than an
 * exception: `GET /chat/pending/:threadId` answers `{ text: null }` and `GET
 * /api/traces/:traceId` answers `{ spans: [] }`, because that is what each
 * already answers for an id it does not know.
 *
 * ⚠️ **HEAD is not a bodyless read.** Hono dispatches `HEAD /x` to the
 * `app.get("/x")` handler and runs its body, so a guard placed after a side
 * effect is no guard on HEAD. Every call below is BEFORE the effect. The
 * response body needs no special handling: measured on Bun 1.3.14, a
 * `c.json(…, 404)` returned from a HEAD is emitted with `content-length: 0` and
 * no body, so the 404 expression above is already HEAD-correct.
 *
 * ## The recompute fallback the plan specified is not needed, and here is why
 *
 * §4 asks for "owner-first, recompute-second": read the resident shell, and
 * only if it is absent recompute `botConversationId` across every bot and
 * platform. Re-grepped at PR D time: every conversation-addressed route already
 * answers 404 for a non-resident id on its own (`chatState.getConversation`
 * returns undefined, `deleteConversation` returns false), so the recompute
 * branch could only ever run on a request that was going to 404 regardless. It
 * is omitted rather than written as unreachable code — and PR A's change is
 * what makes that safe: a trimmed conversation keeps its SHELL, so "not
 * resident" now means "never existed" rather than "evicted".
 */
import type { Context } from "hono";
import { getLog } from "../logging.ts";
import { sessionIdentity, sessionRole } from "./guard.ts";
import { pinnedLocalUserId } from "./policy.ts";
import type { AuthRole } from "./role.ts";

const log = getLog("auth", "resource");

export type ResourceKind = "conversation" | "thread" | "message" | "trace" | "jiraDraft";

/**
 * What the lookup found. The three-way distinction is load-bearing: "no row" and
 * "a row owned by nobody" are different answers, and collapsing them would
 * either hand every watcher trace to every caller or hide the operator's own.
 */
export type ResourceOwner =
  | { readonly found: false }
  | { readonly found: true; readonly userId: string | null };

export type OwnedResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "missing" | "not-owned" | "no-owner" };

const ALLOWED: OwnedResult = { ok: true };

export interface ResourceAccessInput {
  /** The session's `users.id`, or `null` with auth off. */
  readonly sessionUserId: string | null;
  /** `null` with auth off — no middleware ran, so there is no role. */
  readonly role: AuthRole | null;
  readonly owner: ResourceOwner;
  /**
   * Whether a row with NO owner may be read.
   *
   * §4 makes a NULL owner admin-only — a watcher or gardener trace is an
   * operator artefact. `resolveRole` answers `user` for a `local` identity
   * unconditionally (deliberately: an admin passthrough there would make this
   * whole campaign's acceptance pass without the diff), so on a single-operator
   * instance that rule would lock the operator out of their own watcher traces.
   * §4 pays the cost the other way instead: a NULL owner is allowed in `local`
   * mode, where there is one human and the distinction has no meaning yet.
   */
  readonly nullOwnerAllowed: boolean;
}

/**
 * The whole decision, over primitives — no Hono, no DB, no module state, so a
 * test can drive all eight combinations rather than the two a route happens to
 * reach.
 */
export function decideResourceAccess(input: ResourceAccessInput): OwnedResult {
  // Auth off: no middleware ran, there is nothing to compare against, and
  // today's muninn is unchanged. This is what "off is off" means for PR D.
  if (input.sessionUserId === null) return ALLOWED;

  if (!input.owner.found) return { ok: false, reason: "missing" };

  // §4: role beats the own-data guard. Inert in `local` mode — see
  // `nullOwnerAllowed` above for why that is deliberate rather than an oversight.
  if (input.role === "admin") return ALLOWED;

  if (input.owner.userId === null) {
    return input.nullOwnerAllowed ? ALLOWED : { ok: false, reason: "no-owner" };
  }

  return input.owner.userId === input.sessionUserId ? ALLOWED : { ok: false, reason: "not-owned" };
}

/** Injected in tests; the default reaches the DB and `chatState`. */
export type OwnerLookup = (kind: ResourceKind, id: string) => Promise<ResourceOwner>;

let lookupOverride: OwnerLookup | null = null;
/** Test-only seam (the `src/wiki/readonly.ts` idiom — not an env var, not
 *  reachable over HTTP). Pass `null` to restore the real lookup. */
export function __setOwnerLookupForTest(lookup: OwnerLookup | null): void {
  lookupOverride = lookup;
}

/**
 * Resolve a resource's owner.
 *
 * `trace` reads any span of the trace rather than joining to a root: PR A
 * stamps `user_id` on EVERY span, so the cheapest row answers. `jiraDraft`
 * resolves through `jira_drafts.thread_id → threads.user_id` — see
 * `requireOwnedResource` for why no `user_id` column was added.
 */
async function lookupOwner(kind: ResourceKind, id: string): Promise<ResourceOwner> {
  if (lookupOverride) return lookupOverride(kind, id);
  switch (kind) {
    case "conversation": {
      const { chatState } = await import("../chat/state.ts");
      const userId = chatState.conversationOwner(id);
      return userId === undefined ? { found: false } : { found: true, userId };
    }
    case "thread": {
      const { getThreadById } = await import("../db/threads.ts");
      const thread = await getThreadById(id);
      return thread ? { found: true, userId: thread.userId } : { found: false };
    }
    case "message": {
      const { getMessageById } = await import("../db/messages.ts");
      const message = await getMessageById(id);
      return message ? { found: true, userId: message.userId } : { found: false };
    }
    case "trace": {
      const { getTraceOwner } = await import("../db/traces.ts");
      return getTraceOwner(id);
    }
    case "jiraDraft": {
      const { getJiraDraft } = await import("../db/jira-drafts.ts");
      const draft = await getJiraDraft(id);
      return draft ? { found: true, userId: draft.threadUserId } : { found: false };
    }
  }
}

/**
 * The guard. Call it BEFORE the side effect, and answer the call site's own
 * "not found" expression when it says no.
 *
 * **No `jira_drafts.user_id` migration, and the reason is a re-grep rather than
 * a shortcut.** §4 assigns PR D a migration adding an owner column, because a
 * `source = 'notes'` draft had no owner anywhere in the schema. That path is
 * gone: the Jira composer's PR 4 deleted every notes writer, `createJiraDraft`'s
 * one remaining caller passes `source: 'thread'` with a `threadId`, and
 * `getJiraDraft` already joins `threads.user_id` for the archive's deep link.
 * A column whose only justification has been deleted is one more thing to keep
 * in step with the join. Historical `notes` rows carry `thread_id = NULL` and so
 * resolve to a NULL owner — readable on a `local` instance, admin-only
 * otherwise, which is the same rule every other owner-less row follows. The
 * residual, stated rather than hidden: `jira_drafts.thread_id` has no FK, so a
 * DELETED thread orphans its drafts into that same NULL-owner class.
 */
export async function requireOwnedResource(
  c: Context,
  kind: ResourceKind,
  id: string | undefined | null,
): Promise<OwnedResult> {
  const identity = sessionIdentity(c);
  if (!identity) return ALLOWED; // auth off — nothing to compare against

  if (typeof id !== "string" || id === "") return { ok: false, reason: "missing" };

  const owner = await lookupOwner(kind, id);
  const role = sessionRole(c);
  const verdict = decideResourceAccess({
    sessionUserId: identity.userId,
    role,
    owner,
    nullOwnerAllowed: pinnedLocalUserId() !== null,
  });

  if (verdict.ok && role === "admin" && owner.found && owner.userId !== identity.userId) {
    // The same audit line `requireOwnUser` writes, for the same reason: an
    // operator reading a colleague's row is the point of the dashboard, and the
    // difference between an audited role and an unaudited one is this line.
    log.info("Admin {admin} read {kind} {id} owned by {owner} on {path}", {
      admin: identity.userId, kind, id, owner: owner.userId, path: c.req.path,
    });
  }
  return verdict;
}

/**
 * The third shape: a COLLECTION route, which has neither a claimed id nor a
 * single resource and so cannot be gated at all — it must return less.
 *
 * `GET /chat/conversations` is the one that matters. It publishes `id`, `userId`
 * and `username` for every conversation in memory, which hands out exactly the
 * derivable id set `requireOwnedResource` exists to protect — a gate on the
 * per-id routes with an ungated index in front of it protects nothing.
 */
export function filterToOwner<T>(
  c: Context,
  rows: readonly T[],
  ownerOf: (row: T) => string | null | undefined,
): T[] {
  const identity = sessionIdentity(c);
  if (!identity) return [...rows];
  if (sessionRole(c) === "admin") return [...rows];
  const nullOwnerAllowed = pinnedLocalUserId() !== null;
  return rows.filter((row) => {
    const owner = ownerOf(row);
    if (owner === null || owner === undefined) return nullOwnerAllowed;
    return owner === identity.userId;
  });
}
