/**
 * Authentication for the `/chat/ws` (and `/simulator/ws`) upgrade — the one
 * surface no Hono middleware can reach.
 *
 * `src/index.ts` handles the upgrade inside `Bun.serve`'s `fetch`, BEFORE
 * `app.fetch` runs, so `createAuthMiddleware` and `createOriginMiddleware` both
 * see nothing. Until this module existed, an authenticating instance answered
 * 401 to every REST call and then streamed every conversation in the process to
 * anyone who opened a socket — which is the LAN/tailnet exposure §8 says PRs C
 * and D exist to close, arriving through the back door.
 *
 * ## Two decisions, both borrowed rather than rewritten
 *
 * 1. **Identity** — `resolveRequestIdentity` from `middleware.ts`, the same
 *    function the HTTP path calls. The upgrade must grant exactly what the
 *    middleware grants; a second reading of the loopback bypass, the session
 *    cookie and the presented credential would be three more places to get the
 *    bypass direction wrong.
 * 2. **Origin** — `decideOrigin` from `origin.ts`, with the same CONFIGURED
 *    accepted set. §6's first instruction for this PR is not to write a second
 *    origin check: PR C's first cut compared `Origin` to the request's own
 *    `Host`, and review demonstrated `Host: evil.example` with a matching
 *    `Origin` creating a real conversation. `decideOrigin` takes no `host` input
 *    at all, and `/chat/ws` + `/simulator/ws` are entries in
 *    `SIDE_EFFECTING_GETS` so the shared rule evaluates them.
 *
 * ## Why identity is checked first
 *
 * The same order as HTTP, where the auth middleware is mounted before the origin
 * middleware: a caller with no credential must be able to tell "you are not
 * logged in" (401) from "your origin is refused" (403). Acceptance 10's
 * cross-origin handshake carries a valid session, so it reaches the origin check
 * and gets its 403.
 *
 * ## What a browser actually sends on a handshake
 *
 * `Origin`: always, for a `new WebSocket(...)` from a page. `Sec-Fetch-*`: not
 * on WebSocket handshakes — they are excluded from the fetch metadata set — so
 * the Origin branch is the whole browser story here and the `Sec-Fetch-Site`
 * branch below is unreachable from a browser. A non-browser client (a script,
 * the e2e harness) sends neither and is allowed through to the credential check,
 * which is the same trade `decideOrigin` documents for HTTP: refusing there
 * would break every script to close nothing, because a script that can set
 * headers can set `Origin` too.
 *
 * ## Bun facts this rests on, measured rather than assumed
 *
 * `server.upgrade(req, …)` still returns `true` when called AFTER an `await`
 * inside `fetch` — asserted on Bun 1.3.14 (`ws-upgrade.test.ts`) before the
 * async introspection path was built on it, because the bundled Bun docs and
 * types show only the synchronous form and say nothing either way. That is
 * acceptance item 13.
 */
import { getLog } from "../logging.ts";
import type { AuthConfig } from "./mode.ts";
import { isAuthenticatingMode } from "./mode.ts";
import { localIdentity, type Identity, type Introspector } from "./introspect.ts";
import { resolveGrantedRole, resolveRequestIdentity, unauthenticatedBody } from "./middleware.ts";
import { decideOrigin, loopbackOrigins } from "./origin.ts";
import { normalizeOrigin } from "../config.ts";
import type { AuthRole } from "./role.ts";

const log = getLog("auth", "ws");

export type WsUpgradeDecision =
  | {
    readonly ok: true;
    /** `null` with auth off — no middleware exists there, and the socket is
     *  unfiltered exactly as it is today. */
    readonly identity: Identity | null;
    readonly role: AuthRole | null;
  }
  | { readonly ok: false; readonly response: Response };

/** Refusals are JSON for the same reason the middleware's are: a client must be
 *  able to tell an expired session from a broken server without a browser. */
function refuse(body: unknown, status: 401 | 403): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Warn-once per reason: a probed instance would otherwise write one line per
 *  handshake attempt (the `middleware.ts` / `origin.ts` discipline). */
const warnedReasons = new Set<string>();
export function __resetWsWarningsForTest(): void {
  warnedReasons.clear();
}

/**
 * Build the upgrade authorizer once, at boot.
 *
 * With auth **off** it is a constant `ok` — no middleware is mounted on the HTTP
 * side either, and "off is off" is the rule this whole campaign is written to.
 * The returned function is still called, so the wiring is exercised on every
 * instance rather than only on the one that authenticates.
 *
 * ⚠️ `introspector` is the SAME INSTANCE the HTTP middleware holds, built once
 * in `src/index.ts`. Building a second one here is not a duplicate object, it is
 * a duplicate CACHE: the chat page opens an HTTP request and this upgrade on one
 * token within milliseconds, so a per-instance cache misses on exactly the pair
 * it exists for — and in `entra` mode the introspector is also the
 * DB-provisioning path, so two instances mean two first-login transactions
 * racing. `e2e/entra-identity.spec.ts` asserts ONE Texas call for the pair.
 */
export function createWsUpgradeAuthorizer(
  auth: AuthConfig,
  dashboardPort: number,
  introspector: Introspector | null,
): (req: Request, peer: string | undefined) => Promise<WsUpgradeDecision> {
  if (!isAuthenticatingMode(auth.mode)) {
    const open: WsUpgradeDecision = { ok: true, identity: null, role: null };
    return async () => open;
  }

  if (!introspector) {
    throw new Error(`createWsUpgradeAuthorizer called for MUNINN_AUTH="${auth.mode}" — nothing to mount.`);
  }
  const pinned = auth.local ? localIdentity(auth.local) : null;
  // Computed once, exactly as `createOriginMiddleware` does it: the accepted set
  // is a property of the CONFIGURATION, never of the request.
  const accepted = [
    ...auth.allowedOrigins,
    ...loopbackOrigins(dashboardPort).map((o) => normalizeOrigin(o)).filter((o): o is string => o !== null),
  ];

  return async (req, peer) => {
    // `via` as well as `identity`: the role this grants must equal the role
    // HTTP grants for the same credential, and `MUNINN_LOCAL_ROLE` is applied
    // from the channel that established the identity. Destructuring only
    // `{ identity }` here is what would leave HTTP admin and the socket `user`.
    const { identity, via } = await resolveRequestIdentity(req.headers, req.url, peer, { introspector, pinned });
    if (!identity) {
      warnOnce("unauthenticated", "Refused an unauthenticated WebSocket upgrade");
      return { ok: false, response: refuse(unauthenticatedBody(auth), 401) };
    }

    let path = "/chat/ws";
    try {
      path = new URL(req.url).pathname;
    } catch {
      // A target Bun accepted at the socket layer but `URL` will not parse.
      // Fall through with the guarded default rather than throwing: the two
      // paths this handler serves are both in `SIDE_EFFECTING_GETS`, so the
      // default is the fail-CLOSED one.
    }

    const decision = decideOrigin({
      method: "GET",
      path,
      origin: req.headers.get("origin") ?? undefined,
      secFetchSite: req.headers.get("sec-fetch-site") ?? undefined,
      allowedOrigins: accepted,
    });
    if (!decision.allowed) {
      warnOnce(decision.reason, `Refused a cross-origin WebSocket upgrade (${decision.reason})`);
      return { ok: false, response: refuse({ error: "forbidden", reason: "cross-origin request" }, 403) };
    }

    // No ZONE decision is made here, deliberately: `/chat/ws` and
    // `/simulator/ws` are `/chat/*` surfaces, i.e. inside the user zone, and
    // they are already identity-authenticated and owner-scoped (`wsDataFor` +
    // `eventVisibleTo`). A role is still resolved because `ws.data` carries it.
    return { ok: true, identity, role: resolveGrantedRole(identity, via, auth) };
  };
}

function warnOnce(key: string, message: string): void {
  if (warnedReasons.has(key)) return;
  warnedReasons.add(key);
  log.warn(message);
}
