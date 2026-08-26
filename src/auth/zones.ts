/**
 * The zone model: **which routes a role may call.**
 *
 * Until this file existed, `src/auth/CLAUDE.md`'s "what this does not close"
 * opened with the sentence "There is no zone middleware, so an authenticated
 * `user` still reaches /traces, /agents, /logs, /models and the rest of the
 * operator surface." That is what this file closes. It was the last thing
 * `MUNINN_AUTH=entra` waited on inside muninn. It is no longer waiting: the PR
 * after this one shipped the token introspector and the identity link and
 * flipped `AUTH_ZONES_IMPLEMENTED` to `true`, so every rule below is what an
 * authenticated NAV colleague is actually held to.
 *
 * ## Shape: a short deny list, two allowlists, and default-deny
 *
 * Evaluated in that order, and the order is the whole design:
 *
 *  1. **The deny list.** A handful of routes that sit UNDER a user-zone prefix
 *     and must not be admitted by it. Today it is exactly the
 *     `/chat/bot-preferences/:botName/default-user` trio (GET, PUT and its
 *     OPTIONS preflight), which lives inside `/chat/*` but sets BOT-GLOBAL state
 *     (`claimed-id-inventory.txt` calls it `admin-zone` for that reason).
 *  2. **The open zone.** Reachable with no credential at all — the two health
 *     endpoints — plus the two favicon paths, which need an identity but no
 *     role. Kept tiny on purpose: an entry here is a route nothing protects.
 *  3. **The user zone.** The routes the composed chat page actually calls,
 *     enumerated. `src/auth/chat-page-zone-inventory.txt` is the derived proof
 *     that the list covers the page and nothing more.
 *  4. **Everything else is admin.** Default-deny is what makes a route added
 *     next month arrive CLOSED rather than open — the inverse of the
 *     claimed-id inventory, which can only report a route it knows to look for.
 *
 * ## Two things this file deliberately is not
 *
 * It is **pure data plus one pure function**, so the decision is unit-testable
 * without a Hono context, a server or a database; `zone-middleware.ts` is the
 * only consumer that touches a request. And it decides **role**, never
 * authentication: `createAuthMiddleware` has already answered 401 for a request
 * with no credential by the time this runs, which is why a zone refusal is
 * always a 403.
 */
import type { AuthRole } from "./role.ts";

/** Liveness: dependency-free, answers whether the process is up. */
export const HEALTH_LIVE_PATH = "/api/live";
/** Readiness: pings the database, so it answers whether the process can serve. */
export const HEALTH_READY_PATH = "/api/ready";

/**
 * The wonderwall sidecar's login path, as ONE constant.
 *
 * It is written by `unauthenticatedBody` (`middleware.ts`) into every `entra`
 * 401 and READ by the chat page's HTTP expiry predicate
 * (`src/chat/views/components/authed-fetch.ts`): a 401 whose `loginUrl` is this
 * exact string is the evidence that reloading lands on a login page. Producer
 * and consumer sat in different files as hand-copied literals, plus a third and
 * fourth copy in their tests — four places for one string that a sidecar
 * upgrade could move. It lives here because this module is a leaf (one type
 * import), so the browser-script builder and a Playwright spec can both import
 * it without dragging the Hono middleware in.
 */
export const LOGIN_URL_HINT = "/oauth2/login";

export interface ZoneDenyEntry {
  /** Methods this row denies. `GET` implies `HEAD`: Hono dispatches `HEAD /x`
   *  to the `app.get("/x")` handler and RUNS its body (the measured rule in
   *  `origin.ts`'s HEAD callout), so a HEAD-shaped hole here would execute the
   *  same handler with the response discarded. */
  readonly methods: readonly string[];
  /** A path pattern. A `:name` segment matches exactly one non-empty segment. */
  readonly pattern: string;
  readonly note: string;
}

/**
 * Routes a role `user` is refused even though an allowlist below would admit
 * them. Checked FIRST, so a prefix can never widen its way past this.
 */
export const ADMIN_DENY_LIST: readonly ZoneDenyEntry[] = [
  {
    methods: ["GET", "HEAD"],
    pattern: "/chat/bot-preferences/:botName/default-user",
    note: "reads bot-global state; `claimed-id-inventory.txt` calls it admin-zone",
  },
  {
    methods: ["PUT"],
    pattern: "/chat/bot-preferences/:botName/default-user",
    note: "WRITES bot-global state — there is no 'own' version of it",
  },
  {
    methods: ["OPTIONS"],
    pattern: "/chat/bot-preferences/:botName/default-user",
    note:
      "reachable from a LOOPBACK request (the bypass supplies the pinned " +
      "identity with no credential, so auth does not 401 and zones DO run — " +
      "measured: OPTIONS from loopback answers 403 here, not 401). Through a " +
      "proxy a credential-less preflight is 401'd by auth first. Listed so the " +
      "row cannot be the one method left open either way.",
  },
];

/**
 * Reachable without an admin role. The two health paths are additionally in
 * `AUTH_EXCLUDED_PATHS`, i.e. reachable with no credential at all; the favicons
 * are not — they authenticate like everything else and merely need no role.
 */
export const OPEN_ZONE_PATHS: readonly string[] = [
  HEALTH_LIVE_PATH,
  HEALTH_READY_PATH,
  "/favicon.svg",
  "/favicon.ico",
];

/**
 * The user zone, as exact paths and prefixes (a trailing `/` makes an entry a
 * prefix). Derived over the COMPOSED chat page rather than remembered — see
 * `zone-inventory.ts` and the checked-in `chat-page-zone-inventory.txt`, which
 * fails when the page starts calling something this list does not carry.
 *
 * Three entries are worth stating rather than leaving to be inferred:
 *
 *  - **`/` is here** because `GET /` is role-aware in the HANDLER
 *    (`dashboard/routes.ts`): role `user` is redirected to `/chat`. Denying it
 *    in the middleware instead would 403 the address people type.
 *  - **The collection routes are absent by construction.** `/api/goals/` is a
 *    prefix and does not match `/api/goals`; the same holds for
 *    `/api/traces` and `/api/memories`. Those lists hand out the ids every
 *    resource guard then refuses, so they stay admin.
 *  - **`/api/users` is absent** although the chat page names it. PR C's client
 *    change skips `loadUsersForBot` entirely under a session, so the fetch does
 *    not happen in the mode where a zone exists.
 */
export const USER_ZONE_PATHS: readonly string[] = [
  // The chat surface itself, and the legacy alias `src/index.ts` 301s from.
  "/",
  "/chat",
  "/chat/",
  "/simulator",
  "/simulator/",
  // The dashboard routes the composed chat page fetches. All but the two
  // `/api/search/` reads are already owner-guarded, so this is enumeration
  // rather than new protection.
  "/api/dashboard-build-hash",
  "/api/goals/",
  "/api/memories/user/",
  "/api/scheduled-tasks/",
  "/api/traces/",
  "/api/search/collection/",
  "/api/search/document/",
  // The Jira draft card: templates, the one write, the thread-keyed listing and
  // the per-draft read/save. `/api/jira/archive` and the `/jira` page are NOT
  // here — the archive is an operator surface.
  "/api/jira/templates",
  "/api/jira/drafts",
  "/api/jira/draft/",
];

/**
 * The unfiltered collection reads: every row, for every user, from one call.
 *
 * They stay admin-only, and an admin reading one writes an `activity_log` row
 * (`audit.ts`). Exact paths, never prefixes — `/api/memories/by-user` is a
 * SEPARATE registration beside `/api/memories` and a prefix entry would also
 * swallow `/api/memories/user/:userId`, which is owner-guarded and in the user
 * zone.
 */
export const AUDITED_COLLECTION_PATHS: readonly string[] = [
  "/api/traces",
  "/api/tasks",
  "/api/watchers",
  "/api/goals",
  "/api/memories",
  "/api/memories/by-user",
  "/api/threads",
  "/api/users",
];

/** `:name` matches one non-empty segment; everything else is compared verbatim. */
export function matchPathPattern(pattern: string, path: string): boolean {
  const p = pattern.split("/");
  const q = path.split("/");
  if (p.length !== q.length) return false;
  return p.every((seg, i) => (seg.startsWith(":") ? q[i] !== "" : seg === q[i]));
}

/** Exact match, or prefix match for an entry that ends in `/`. */
export function inPathList(list: readonly string[], path: string): boolean {
  return list.some((entry) => (entry.endsWith("/") && entry !== "/" ? path.startsWith(entry) : entry === path));
}

/** True for a GET/HEAD of one of the unfiltered collection reads. */
export function isAuditedCollectionRead(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (m !== "GET" && m !== "HEAD") return false;
  return AUDITED_COLLECTION_PATHS.includes(path);
}

export type Zone = "open" | "user" | "admin";

export interface ZoneDecision {
  readonly allowed: boolean;
  readonly zone: Zone;
  /** Log-shaped, never echoed to the client: a refusal naming the rule that
   *  fired would tell a prober which allowlist to aim at. */
  readonly reason: string;
}

export interface ZoneDecisionInput {
  readonly method: string;
  readonly path: string;
  /** The resolved role, or `null` with auth off (no middleware is mounted). */
  readonly role: AuthRole | null | undefined;
}

export function decideZone(input: ZoneDecisionInput): ZoneDecision {
  const method = input.method.toUpperCase();
  // HEAD is dispatched to the GET handler, so it is judged as one.
  const effective = method === "HEAD" ? "GET" : method;

  const denied = ADMIN_DENY_LIST.find(
    (e) => e.methods.includes(effective) && matchPathPattern(e.pattern, input.path),
  );

  if (input.role == null) {
    // Auth off. No middleware is mounted at all, so this is unreachable in
    // production; answered rather than thrown so a unit test can state it.
    return { allowed: true, zone: "admin", reason: "auth off" };
  }

  // An admin reaches every zone, the deny list included — the deny list is what
  // sends those routes TO admin, not a refusal in its own right.
  if (input.role === "admin") return { allowed: true, zone: "admin", reason: "admin" };

  if (denied) return { allowed: false, zone: "admin", reason: `deny list: ${denied.pattern}` };
  if (inPathList(OPEN_ZONE_PATHS, input.path)) return { allowed: true, zone: "open", reason: "open zone" };
  if (inPathList(USER_ZONE_PATHS, input.path)) return { allowed: true, zone: "user", reason: "user zone" };
  return { allowed: false, zone: "admin", reason: "default deny" };
}
