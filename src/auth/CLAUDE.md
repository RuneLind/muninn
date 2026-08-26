# `src/auth/` — the `MUNINN_AUTH` switch

This module answers **who is calling**, **which user id a route is allowed to
act on** (PR C), **whose row a route is allowed to touch** (PR D) and — since
the zone model landed — **which routes a role may call at all** (`zones.ts`).
Reading a closed boundary into the presence of this directory is still the
mistake to avoid: what remains open is listed under *What this does not close*
below, and it is now a shorter list about different things.

## The three modes

| `MUNINN_AUTH` | What happens |
|---|---|
| unset / `off` | **No middleware is mounted at all**: the user dropdown, `sim-user-1`, no tokens. One deliberate exception to "unchanged" — refusal (2) below means an instance with `NAIS_CLUSTER_NAME` set now refuses to boot where it previously started. |
| `local` | One **pinned identity** behind a **shared secret**. The shape for a single human's instance that is reachable beyond loopback. |
| `entra` | **Refuses to boot.** See `AUTH_ZONES_IMPLEMENTED` — the zone model has landed, but the Entra half of the deploy has not, and flipping that constant is its PR's job. |

An unrecognised value **throws** rather than degrading to `off`. That inverts
`optionalEnvFlag`'s "a typo must not brick an instance" rule on purpose: a typo'd
`MUNINN_WIKI_READONLY` degrades to a nuisance, whereas `MUNINN_AUTH=entraa`
degrading to `off` is an instance its operator believes is authenticated and
which is wide open.

## Boot refusals (`resolveAuthConfig`), in firing order

1. `MUNINN_AUTH` is not a known mode.
2. `NAIS_CLUSTER_NAME` is set and the mode is not authenticating.
3. **`entra` while `AUTH_ZONES_IMPLEMENTED` is `false`.** The order matters: this
   fires *before* the per-mode config checks, so a fully-configured deployment is
   still told the zone model is the reason rather than being waved through by
   having every other variable set.
4. An authenticating mode with an empty `MUNINN_ADMIN_IDENTS` or
   `MUNINN_ALLOWED_ORIGINS`.
5. `local` without `MUNINN_LOCAL_TOKEN` / `MUNINN_LOCAL_USER`, or with a secret
   shorter than `LOCAL_TOKEN_MIN_LENGTH`.
6. `MUNINN_LOCAL_ROLE` set to anything other than `user` / `admin`. The same
   inverted direction as `MUNINN_AUTH` itself: this variable only ever GRANTS,
   so a typo degrading to `user` would be a silent lockout while `…=admin` sits
   in the `.env` looking correct.

`AUTH_ZONES_IMPLEMENTED` is a **constant, not an env var**. An override would let
exactly the deploy that must not happen happen anyway.

## ⚠️ The loopback bypass — read this before changing it

A **direct** loopback request is granted the pinned identity with no credential,
and **no auth config can revoke it** — a wrong secret on an always-on instance
would otherwise be a lockout with no console.

The trap: **a reverse proxy on the same host makes every remote request look
loopback.** Measured 2026-08-25 against a live `tailscale serve` publishing
`127.0.0.1:3010` to a tailnet — a request from *another tailnet device* arrives
with peer address `127.0.0.1`, identical to a local `curl`. A loopback check on
the peer address alone therefore hands the bypass to every device on the tailnet,
which is the exact exposure this campaign exists to close.

What separates them is `PROXY_HEADER_PREFIXES` / `PROXY_HEADER_NAMES`: an HTTP
proxy stamps `x-forwarded-*`, `forwarded`, `via`, `tailscale-*`, `cf-*` and the
rest, and a direct `curl` sends none of them. Also measured: a tailnet client
that tries to strip or blank those headers **does not succeed** — the proxy
overwrites them.

**The direction is what makes this safe.** Header presence can only *remove* the
bypass, never grant it, so a forged header yields a request that must
authenticate normally rather than one that gets in. Any future edit here must
preserve that direction — which is also why the list is prefix-based rather than
nine literal names, and why it must never become env-configurable.

### 🚨 What the bypass CANNOT see, and what that voids

The test is on the socket's peer address, so **an L4 forward is invisible to
it**. Demonstrated in review with a byte-forwarding proxy: a request from a
non-loopback address returned `200` with the full pinned identity and no
credential. These configurations **void the mode's protection entirely**:

- `tailscale serve --tcp …` (as opposed to HTTP mode)
- an nginx `stream` block, or a bare `proxy_pass` with **no** `proxy_set_header`
- `ssh -L`, `socat`, `kubectl port-forward`

No header list can close this: at the socket layer a relayed connection and a
local one are identical. `src/index.ts` warns about it at boot. **If muninn is
fronted that way, `MUNINN_AUTH=local` is not protection** — the durable fix is to
stop deriving the escape hatch from the peer address (e.g. a token file only a
host user can read), which is a re-plan decision, not a patch.

Conversely, the bypass **does not exist** where the peer is never loopback —
notably this repo's own `docker-compose.yml`, which sets
`DASHBOARD_HOST=0.0.0.0`, so every request arrives from the docker gateway. A
forgotten `MUNINN_LOCAL_TOKEN` there IS a lockout.

A browser running **on the muninn host** is also inside the bypass: it reaches
`127.0.0.1` with no proxy headers and is authenticated before any cookie is
consulted. A malicious page in that browser can therefore issue authenticated
requests, and `SameSite` is irrelevant to it.

The bypass resolves to role **`user`**, not `admin` — see below.

`__setLoopbackBypassForTest` exists because every automated test runs over
loopback, so the 401 path would otherwise be unreachable. It is an in-process
seam (the `src/wiki/readonly.ts` idiom), not an env var, and is therefore not
"auth config" for the purposes of the rule above.

## The credential

`local` accepts the shared secret on `X-Muninn-Token`, `Authorization: Bearer`,
or `?muninn_token=`, and exchanges it for a **signed session cookie**
(`muninn_session`, `HttpOnly`, `SameSite=Lax`, 7 days). A GET or HEAD carrying
the secret on the query string is **redirected** to the same URL without it —
whenever the parameter is present, not only on the request that authenticated
with it, or a bookmarked login URL keeps the secret in the address bar forever.
Note the redirect does **not** remove the secret from the fronting proxy's own
access log, which records the original request line.

The cookie channel accepts **sessions only**. The introspector also recognises
the raw shared secret, but honouring that on the cookie would let a hand-set
`muninn_session=<MUNINN_LOCAL_TOKEN>` put the long-lived secret into every
request's jar with no expiry — precisely what `session.ts` exists to prevent.
The cookie is a signed `{userId, expiry}`, not the secret. Rotating
`MUNINN_LOCAL_TOKEN` invalidates every session.

**A note for PR C, with its scope stated honestly:** `SameSite=Lax` blocks the
cross-site *POST* half of the CSRF surface **for requests arriving through the
proxy** — so a CSRF test written against a proxied POST is green whether or not
PR C's origin check exists. Two halves it does not cover: the side-effecting
top-level **GET** (`GET /chat/pending/:threadId`, `GET /api/research/ask`), and
**anything at all from a browser on the muninn host**, which the loopback bypass
authenticates before the cookie is read. PR C's tests belong on those.

## Roles

`resolveRole(identity, adminIdents)` is the single seam, so the source can move
from the env allowlist to an Entra `groups` claim without touching a call site.
Two answers skip the list entirely:

- **a `null` identity ⇒ `admin`** — "auth off". Nothing passes `null` today:
  with auth off no middleware is mounted, so `c.get("identity")` is `undefined`
  and `resolveRole` is never called. The branch is for PRs C–D's guards, which
  run in both modes. Do not read it as something enforced now.
- **a `local` identity ⇒ `MUNINN_LOCAL_ROLE`, default `user`.** The default is
  load-bearing, not a shrug: `requireOwnUser`'s admin passthrough (PRs C–D)
  makes every claimed-id guard a no-op for an admin, so a pinned identity
  resolving to `admin` by default would make the central acceptance of that
  pass pass *without the diff*. The cost — NULL-owner resources being
  admin-only — is paid instead by allowing a NULL owner in local mode, where
  there is one human and the distinction has no meaning yet.

### `MUNINN_LOCAL_ROLE` — the operator escape hatch the zone model needed

Default-deny plus three shipped facts — `resolveRole` answers `user` for a local
identity, `MUNINN_ADMIN_IDENTS` is inert in `local` mode, and `entra` cannot boot
— means **no admin identity is reachable on any bootable instance**. The zone
model as first drafted therefore made the operator's own dashboard permanently
403 on every `MUNINN_AUTH=local` instance. `MUNINN_LOCAL_ROLE=admin` is the
explicit opt-in, and it is deliberately NOT a promotion of `MUNINN_ADMIN_IDENTS`.

⚠️ **It does not reach the loopback bypass, and that is the whole design.** The
bypass grants the pinned identity with **no credential at all** and is blind to
an L4 forward, so promoting it would hand full admin over every user's data to
anyone behind `ssh -L`, `socat`, `tailscale serve --tcp` or a bare `proxy_pass`.
The predicate is therefore **the channel that established the identity**, carried
as `IdentityVia` (`"session" | "credential" | "bypass"`) on `IdentityResolution`
and applied in exactly one place, `resolveGrantedRole`, which both the HTTP
middleware and the WebSocket upgrade call. Three near-misses, all rejected:

| spelling | why it is wrong |
|---|---|
| "a credential was **presented**" | `presentedToken` reads header/bearer/query and **never the cookie**, so the operator's next request after the login redirect drops to `user` permanently. |
| "did not take the bypass branch" | the bypass branch runs first and can itself carry a valid token, so `ssh` + `curl -H 'x-muninn-token: …'` would be refused admin. |
| `IdentityResolution.mint` | `mint` is `false` in the cookie branch — the first bug again. |

**The consequence, stated because it will be met:** a browser running ON the
muninn host resolves through the bypass (`resolveRequestIdentity` fills
`identity` there and reads the cookie only `if (!identity)`), so a cookie-only
request from localhost stays role `user` **regardless of the variable**. Through
a reverse proxy — which stamps `x-forwarded-*` and therefore removes the bypass —
the cookie branch runs and the operator gets `admin`. Reach the dashboard through
the proxy, or from the host with the token on the request. The bypass/cookie
ordering is shipped PR D behaviour and is deliberately not restructured.

`MUNINN_LOCAL_ROLE` is in `AUTH_FLAGS` (`src/test/ambient-env.ts`), so neither
`bun test` nor a Playwright-spawned muninn inherits it — a machine whose `.env`
sets it would otherwise spawn e2e servers at role `admin` while the other machine
spawns `user`, and the acceptance rows would flip by host.

`MUNINN_ADMIN_IDENTS` is matched case-insensitively on trimmed values against
**both** `NAVident` and `oid`, because a claim set missing one of them would
otherwise leave *nobody* resolving to admin.

## `AUTH_EXCLUDED_PATHS` is the two health endpoints, and nothing else

`/api/live` (dependency-free) and `/api/ready` (a cached `SELECT 1`) are the only
paths an authenticating instance answers with **no credential at all**. Both are
registered inline in `createDashboardRoutes` and both are in the open zone, so
the zone middleware cannot re-close them.

This list was empty until the zone model landed, described as "exclusion and zone
are the same axis" — true only while there were no zones. An entry here now means
"the open zone, reached with no credential", which is exactly what a platform's
liveness and readiness probes need and what nothing else should get. So: neither
may carry a byte of per-user data, neither may become a lever (the readiness
verdict is cached ~2 s precisely because it is unauthenticated and instance-wide),
and the list stays a constant rather than an env list. The login flow still needs
no exclusion, because the *middleware itself* is what accepts the secret.

## PR C — the session id wins over a claimed one

Five new modules (`guard`, `origin`, `cors`, `policy`, `inventory`), plus the
`scope = 'shared'` narrowing in `src/db/memories.ts` and the client half in
`src/chat/views/page.ts`.

### `guard.ts` — `requireOwnUser(c, claimedUserId, claimedUsername?)`

A *claimed* id is one the client names: `:userId` in a path, `body.userId`,
`?userId=`. The guard answers the **claim verbatim** with auth off, the
**session id** in any authenticating mode (403 when a claim is present and
differs), and the **claim plus an audit line** for role `admin`. The branch is
on *authenticating vs off*, never on `entra` — keying it to `entra` is what made
the first cut of this plan deliver nothing.

It returns a **result object rather than throwing**. Most call sites sit inside
a `try { … } catch { return c.json(…, 500) }`, and a thrown `HTTPException`
would be swallowed by those catches and answered as a 500 — a guard that denies
with the wrong status is one nobody notices is misfiring.

`userId` is `string | undefined`: absent stays absent with auth off, so
`own.userId ?? "sim-user-1"` still works there, and is *never* undefined in an
authenticating mode, which is exactly what makes `sim-user-1` unreachable.

`username` is the **second claimed identity** and the `:userId` greps miss it.
It never clobbers `users.username` (the web path passes `lockUsername`), but it
does reach the prompt's speaker label, `traces.username`, the `activity_log` row
and `AgentRun.username`. It is forced from the session at the same seam.

⚠️ On `/chat/reports/*` and `/chat/specs/*` the id becomes a **path segment**
(`resolve(bot.dir, "reports", userId, …)`). `VALID_USER_ID` is therefore tested
**after** the substitution — guarding the claim and then writing an unchecked
session id would move the traversal surface onto `MUNINN_LOCAL_USER`.

### `origin.ts` — the CSRF check

Global, mounted **after** the auth middleware in an authenticating mode only, so
a request with no credential is answered 401 by identity rather than 403 by
origin.

Scoped to **side effects, not to methods**. `SIDE_EFFECTING_GETS` is the
enumerated exception list: `GET /chat/pending/:threadId` is a one-time *consume*
(a cross-site `<img>` destroys the victim's pending message without reading a
response) and `GET /api/research/ask` spends a retrieval + synthesis turn.

The decision order is **Origin, then `Sec-Fetch-Site`**, and it is load-bearing
in both directions:

- An `<img>` cross-site GET sends **no `Origin` at all**, so an Origin-only
  check is structurally blind to the case the list exists for. `Sec-Fetch-Site`
  is what catches it.
- An allowlisted `chrome-extension://…` fetch can arrive with
  `Sec-Fetch-Site: cross-site`, so the allowlist has to be consulted first or
  the Chrome extensions break.
- Neither header ⇒ **allowed**. A non-browser client sends neither; refusing
  there would break every script to close nothing.

**The accepted set is CONFIGURED, never derived from the request.** An earlier
cut compared `Origin` against the request's own `Host` header — which asks "does
this request agree with itself", not "is this my origin" — and review
demonstrated the consequence on a live server: `Host: evil.example:3013` with
`Origin: http://evil.example:3013` created a real conversation. That is exactly
the DNS-rebinding shape an origin check exists to stop, since the loopback
bypass then supplies the pinned identity. So: `MUNINN_ALLOWED_ORIGINS` plus the
loopback literals at the configured `DASHBOARD_PORT`, and nothing else. A
consequence worth stating — every origin muninn is REACHED at (the tailnet name
`tailscale serve` publishes, a LAN address, an extension) must be listed,
spelled as the browser sends it, **scheme included**: the proxy terminates TLS,
so the browser sends `https://<tailnet-name>` while muninn itself is plain HTTP.

⚠️ **HEAD is not safe.** Hono routes `HEAD /x` to the `app.get("/x")` handler and
RUNS its body, so exempting HEAD skips the same side effect with the response
discarded — measured: `GET /chat/pending/x` cross-site answered 403 and consumed
nothing, `HEAD` on the same path answered 200 and consumed the message. HEAD
falls through to the GET rule; only `OPTIONS` is exempt.

**Why the tests are where they are.** `SameSite=Lax` already blocks the
cross-site POST half *for requests arriving through the proxy*, so a
proxied-POST test is green whether or not this middleware exists. The suite
therefore drives **raw sockets from loopback** — i.e. from inside the bypass,
the "browser on the muninn host" case — plus the side-effecting GETs. `fetch` is
not used: it normalises the target and will not let a caller set `Origin`
freely.

### `GET /chat/me` — and a name collision worth knowing about

⚠️ **`mode: "local"` from `/chat/me` means "auth is OFF", which is the OPPOSITE
of `MUNINN_AUTH=local`.** The wire value is the plan's, and the deferred Entra
half expects it, so it is kept — but read it as "this page picks its own user",
never as "the local auth mode". An authenticating instance, `local` included,
answers `mode: "session"`.

### `cors.ts` + `policy.ts` — the per-site CORS disposition

The wildcard `Access-Control-Allow-Origin` literals — **13 of them across 7
files**, counted on `main` — became one helper. (`article-routes.ts` is an
eighth file that only NAMES the header in a comment; it never set one.) With auth **off** the header stays `*`, byte for byte — the
four Chrome extensions in `extensions/` call these routes against
`http://localhost:3010` and a blanket drop is the change most likely to break
them. In an authenticating mode the request's own `Origin` is **echoed** when it
is on `MUNINN_ALLOWED_ORIGINS`, and otherwise no header is sent. An extension
keeps working by being named:
`MUNINN_ALLOWED_ORIGINS=…,chrome-extension://<id>`.

`normalizeOrigin` (in `src/config.ts`) exists because `new URL(…).origin`
answers the opaque string `"null"` for those schemes, so an extension origin
could not be allowlisted at all. Both the allowlist parser and the request-time
check go through it, so a configured origin can never be normalised two
different ways.

`policy.ts` publishes the mode once at boot, because the two readers that need
it — `src/db/memories.ts` and the CORS sites — have no Hono context. The default
is `off`, and `wiring.test.ts` pins the single `setAuthPolicy(auth)` call site,
since a missed call would fail **open**.

### `scope = 'shared'` memory reads

`sharedMemoryReadsAllowed()` narrows the memory filter to `user_id = $1` on an
authenticating instance — the reader keeps their own `shared` rows and stops
seeing anyone else's. Applied at **both** call sites (`searchMemoriesHybrid`
*and* the `searchMemories` fallback it delegates to when there is no embedding),
because a fix applied to one is inert on exactly the path that happens to be
taken.

### The inventory is a command, not a number

`inventory.ts` re-derives §2's two claimed-id greps (in their widened form,
which is what catches the two `app.on("HEAD", …)` routes) plus the CORS grep,
and `inventory.test.ts` compares the result against
`claimed-id-inventory.txt`. Every row carries a **disposition**; a row with none
fails. A route added next month therefore lands as unassigned work rather than
as a silently unguarded surface.

Two dispositions are deliberately *not* guards. `GET /api/messages/:userId`,
`GET /api/users/:userId/overview` and `POST /api/users` are **`admin-zone`**: an
"own" version is meaningless (minting a user row has none, and a guard there
would only make the route un-callable), so what protects them is the ZONE — role
`user` cannot call them at all. The same is true of
**`PUT /chat/bot-preferences/:botName/default-user`**, which additionally needs
a deny-list entry because it sits under the `/chat/*` user-zone prefix; the GET
beside it reads no claimed id, it *returns* one, and is denied for the same
reason.

That value REPLACED `admin-zone-deferred` when the zone model landed — replaced,
not added, so a row still carrying the old spelling fails the fixture loudly
instead of quietly reading as covered.

## PR D — the row's owner, and the two channels

Two new modules (`resource-guard`, `ws-upgrade`), plus the socket's own filter in
`src/chat/ws.ts` and the replacement event stream in `src/chat/routes.ts`.

### `resource-guard.ts` — `requireOwnedResource(c, kind, id)`

The shape `requireOwnUser` structurally cannot reach: a route addressed by the
RESOURCE's id, carrying no claimed user at all. Seven kinds — `conversation`
(resolved from `chatState`), `thread`, `message`, `trace`, `jiraDraft`,
`scheduledTask` and `watcher`.

The last two are **not** in §4's list, and the review round is why they are
here: the empirical pass demonstrated an authenticated non-admin renaming and
DISABLING another user's email watcher and morning-briefing task, and
force-queueing their Gmail-MCP watcher to run now. They are exactly this
guard's shape, so leaving them to the zone model would have shipped a cross-user
WRITE behind a PR whose subject is resource ownership.

**It answers 404, never 403**, because a web conversation id is
`sha256("<userId>:<botName>:web")[0:16]` and therefore derivable: a 403 would
confirm "this exists and is someone else's". That only works if the denial is
byte-identical to the route's own miss, which is why the guard returns a
**verdict, not a Response** — the call site answers with the expression it
already had. Two call sites do not answer 404 at all, and that is the same rule:
`GET /chat/pending/:threadId` answers `{ text: null }` and `GET
/api/traces/:traceId` answers `{ spans: [] }`, because that is what each already
says for an id it does not know.

Every call is placed **BEFORE the side effect**. `GET /chat/pending/:threadId`
is the sharpest case — it DESTROYS what it reads — and `POST
/api/jira/draft/:id/save` and `DELETE /chat/conversations/:id` are the same
class. HEAD needs no special handling on the body: measured on Bun 1.3.14, a
`c.json(…, 404)` returned from a HEAD is emitted with `content-length: 0`.

**A NULL owner is admin-only, relaxed in `local` mode.** A watcher or gardener
trace has no user. §4 makes those admin-only — but `resolveRole` answers `user`
for a local identity unconditionally (deliberately: see *Roles* above), so the
rule as written would lock the operator out of their own instance. The cost is
paid the other way instead: `pinnedLocalUserId() !== null` allows it.

⚠️ **The operator consequence, stated because it will be met:** on
`MUNINN_AUTH=local` the session is ONE `users.id`, so a trace, thread or
conversation belonging to a DIFFERENT `users.id` — a Telegram bot's user row,
say — answers 404/empty to the operator's own `/traces` page. That is the
resource model working as specified, and it is NOT lifted by
`MUNINN_LOCAL_ROLE=admin`: `requireOwnedResource` keys on the row's owner id for
a row that HAS one, and role only decides the passthrough for a DIFFERENT
identity — which on a single-pinned-identity instance there is not.

**No `jira_drafts.user_id` migration**, though §4 assigns PR D one. Re-grepped at
PR D time, as §4 itself instructs: the Jira composer's PR 4 deleted every
`source = 'notes'` writer, `createJiraDraft`'s one remaining caller passes a
`threadId`, and `getJiraDraft` already joins `threads.user_id`. A column whose
only justification has been deleted is one more thing to keep in step with the
join. Residual, stated rather than hidden: `jira_drafts.thread_id` has no FK, so
a DELETED thread orphans its drafts into the NULL-owner class.

**A route that already read the row uses the verdict, not the guard.**
`decideResourceAccess` over an owner in hand (`ownsJiraDraft`, `ownsResourceRow`)
is the same decision without a second query — `POST /api/tasks/:id/trigger`,
`POST /chat/feedback` and the Jira draft routes all take that shape.

`filterToOwner(c, rows, ownerOf)` is the third shape, for a COLLECTION route
that cannot be gated at all. `GET /chat/conversations` is the one that matters:
it publishes `id`, `userId` and `username` for every conversation in memory —
the derivable id set every guard above is protecting. Gating the per-id routes
behind an ungated index protects nothing — which is also why `GET
/api/jira/archive` and the `/jira` page's list are scoped. That one cannot be a
`.filter()` on the result: it is paginated and its `capped` flag is a fact from
the read, so the constraint reaches the SQL through `ownerScope(c)`, the same
decision in a second shape.

### `ws-upgrade.ts` — the one surface no middleware can see

`src/index.ts` handles `/chat/ws` and `/simulator/ws` inside `Bun.serve`'s
`fetch`, before `app.fetch`. Until PR D an authenticating instance answered 401
to every REST call and then streamed every conversation in the process to
anyone who opened a socket.

**Both decisions are borrowed, not rewritten.** Identity is
`resolveRequestIdentity` — the same function `createAuthMiddleware` calls, moved
out of it for exactly this — so the upgrade grants precisely what HTTP grants,
loopback bypass included. Origin is `decideOrigin` with the same CONFIGURED
accepted set, and `/chat/ws` + `/simulator/ws` are entries in
`SIDE_EFFECTING_GETS` so that rule evaluates them. ⚠️ **Do not write a second
origin check here.** PR C's first cut compared `Origin` to the request's own
`Host` and review demonstrated `Host: evil.example` with a matching Origin
creating a real conversation.

Identity is checked first (401), then origin (403) — the same order as HTTP,
where the auth middleware is mounted before the origin middleware.

What a browser actually sends on a handshake: `Origin`, always. `Sec-Fetch-*`,
never — they are excluded from WebSocket handshakes — so the Origin branch is
the whole browser story and the `Sec-Fetch-Site` branch is unreachable from one.
A non-browser client sends neither and is allowed through to the credential
check, the same trade `decideOrigin` documents for HTTP.

**Measured, not assumed:** `server.upgrade` still returns `true` after an
`await` inside `fetch` (Bun 1.3.14, `ws-upgrade.test.ts`) — asserted before the
async introspection path was built on it, because the bundled Bun docs and types
show only the synchronous form. That is acceptance item 13.

### The socket's own filter, and its lifetime

`src/chat/ws.ts` filters the opening snapshot AND every event by owner
(`eventVisibleTo`). `mcp_status` is delivered to everyone: it carries no
`conversationId` and no user data, the inspector panel consumes it, and dropping
it silently is the "passes every security test while breaking the product"
failure §4 warns about. An event for an unknown conversation is DROPPED.

`wsDataFor` builds `ws.data` rather than `src/index.ts` writing a literal — a
literal spelling `userId: null` typechecks, upgrades fine and delivers an
unfiltered socket.

The upgrade authenticates ONCE, so a socket is capped at the introspected
`expiresAt` and closed with **4401** (application range; the client turns it
into a reload-to-login rather than the ordinary 2 s reconnect). `expiresAt` is
null for the raw shared secret and with auth off, where there is nothing to cap.

### `GET /api/events` is denied to role `user`

Directly, via `resolveRole` — not a zone entry, because the zone model is
deferred and "moves to the admin zone" would leave the route wide open to any
authenticated caller. The `?viewer=` guard PR C added scopes only two of its
four channels; the other two are the leak — `activity` replays 50 events
carrying the full message text of every turn, and `agent_runs` is
`snapshotAll()` process-wide. `EventSource` delivers every event over the wire
regardless of which the page reads.

The chat page consumes **`GET /chat/events`** instead: the same `?viewer=` guard,
`agent_status` and `request_progress` and nothing else.

⚠️ **The operator consequence:** a `local` identity is role `user`, so on an
authenticating instance this route is denied to EVERYONE, and the dashboard's
activity feed, the `/agents` live zone and the connection indicator stop
updating and show Disconnected — measured: a 403 fails an `EventSource`
permanently (`readyState` 2, one request in nine seconds), so those pages
freeze rather than retry.
That is now the zone model's ordinary shape rather than a preview of it, and
`MUNINN_LOCAL_ROLE=admin` is what lifts it: an admin identity passes both this
per-route check and the zone. With auth off — today's default and the only mode
the operator dashboard runs in — nothing changes.

### What the wonderwall sidecar actually does (measured)

`scripts/wonderwall-ws-harness.sh` stands up wonderwall + mock-oauth2-server
locally and answers the question §6 refused to assume. Measured 2026-08-26
against wonderwall `2026-08-21-123251-1e1066a`: a WebSocket **upgrade** through
the sidecar reaches the upstream carrying `Authorization: Bearer <access_token>`
and the 101 is proxied back; the session cookie is sent as **`SameSite=Lax`**
(read off the real `Set-Cookie`, not the config dump — which is what the CSRF
reasoning above leans on); and with `--auto-login` an unauthenticated upgrade is
refused 401 by the sidecar and never reaches the app. None of it is exercised
today — `MUNINN_AUTH=entra` cannot boot — but the deferred half now inherits a
measurement instead of a guess.

## Operator notes for a `local` instance (config traps PR C created)

None of these refuse the boot, and all three are silent until someone uses the
feature — which is why they are written down here rather than left to be found.

- **`MUNINN_LOCAL_USER` should be one of the bot's chat-config users.** With auth
  off, `POST /api/research/chat` and `POST /api/wiki/ask/chat` fall through to
  `botUsers[0]` when no id is named. Under a session the id is ALWAYS supplied,
  so if the pinned identity is not a member of `bots/<name>/`'s users, every one
  of those requests is a permanent `needsUser` 400. Nothing cross-checks this at
  boot.
- **`MUNINN_LOCAL_USER` should match `/^[a-zA-Z0-9_-]+$/`.** It becomes a path
  segment on `/chat/reports/*` and `/chat/specs/*`. An id with `.`, `@` or `:`
  makes those six routes 400, and the chat client reads that as "no saved
  report" and disables the buttons. `resolveAuthConfig` warns once at boot.
- **The four Chrome extensions in `extensions/` need their
  `chrome-extension://<id>` origin in `MUNINN_ALLOWED_ORIGINS`,** or every
  capture and research POST is refused as cross-origin. Allowlisting fixes the
  CORS header AND the origin check — but not `requireOwnUser`: the Jira
  extension's own user picker sends a claimed `userId`, and any value other than
  the pinned identity is a 403 no allowlist can lift.

## The zone model — which routes a role may call

`zones.ts` is **pure data plus one pure function**; `zone-middleware.ts` is its
only request-facing consumer, mounted THIRD on the top-level app in
`src/index.ts` (after auth, after origin, before both `app.route()` calls).
Mounting it inside `createDashboardRoutes` would miss the `/chat` sub-app, which
is the one surface the user zone is written around.

**Order: a short deny list, then two allowlists, then default-deny.**

1. **The deny list** — routes that sit UNDER a user-zone prefix and must not be
   admitted by it. Today exactly the `/chat/bot-preferences/:botName/default-user`
   trio (GET, PUT, and its OPTIONS preflight, which is annotated unreachable —
   a credential-less preflight is 401'd by the auth middleware first). They set
   BOT-GLOBAL state, so there is no "own" version. `GET` implies `HEAD`, because
   Hono dispatches `HEAD /x` to the `app.get("/x")` handler and RUNS its body.
2. **The open zone** — `/api/live`, `/api/ready`, `/favicon.svg`, `/favicon.ico`.
   The first two are additionally in `AUTH_EXCLUDED_PATHS`; the favicons
   authenticate like everything else and merely need no role.
3. **The user zone** — `/chat` and `/chat/*`, the `/simulator` compat redirects,
   `/` (role-aware in the HANDLER: a `user` is 302'd to `/chat`), and the
   dashboard routes the composed chat page fetches. All but the two
   `/api/search/` reads were already owner-guarded, so this is enumeration
   rather than new protection.
4. **Everything else is admin**, and default-deny is the point: a route added
   next month arrives CLOSED. That is the inverse of the claimed-id inventory,
   which can only report what it knows to look for.

**Entries are exact paths or `/`-suffixed prefixes, and the distinction carries
the design.** `/api/goals/` admits `/api/goals/<user>` and does NOT admit
`/api/goals` — so every unfiltered collection read stays admin while its
owner-guarded sibling is reachable. `/api/memories/by-user` is a separate
registration beside `/api/memories`, which is why the audited-path list carries
both.

**The user zone is derived, not remembered.** `zone-inventory.ts` extracts every
same-origin URL from `renderChatPage()`'s output — bundles included, and by
taking every path-shaped literal rather than grepping `fetch(`, which misses
`<link rel="icon">`, `EventSource`, `new WebSocket` and every non-literal call
site — and `chat-page-zone-inventory.txt` gives each a disposition that is then
CHECKED against `decideZone`. A fetch added to the chat client lands as an
unassigned row rather than as a panel that quietly stops filling. The cost is
that path FRAGMENTS (`'/chat/threads/' + id + '/auto-respond'` yields both
halves) appear too; they are dispositioned rather than filtered, because a filter
is where a real route would hide.

**`GET /api/events` is not in the user zone**, and its own `resolveRole` denial
stays: the zone is the second lock, not a replacement.

**The socket carries no zone decision.** `/chat/ws` and `/simulator/ws` are
handled inside `Bun.serve`'s `fetch` before `app.fetch`; they are `/chat/*`
surfaces, already identity-authenticated and owner-scoped. `createWsUpgradeAuthorizer`
still resolves a ROLE (it rides `ws.data`), through the same `resolveGrantedRole`
the HTTP path uses — threading `MUNINN_LOCAL_ROLE` through only one call site
would leave HTTP `admin` and the socket `user` for one credential.

### The admin audit trail

`audit.ts` writes an `activity_log` row for the two ways an admin reaches
somebody else's data, alongside the LogTape lines that already existed:

- **Passthrough** — an id-addressed guard let an admin through
  (`requireOwnUser`, `requireOwnedResource`). The row names reader AND owner.
  Not deduped: every cross-user read of a row is its own fact.
- **Collection read** — one of the seven unfiltered lists. The row names reader
  and ROUTE, and is deduped per (reader, route) per 5 minutes, because
  `/api/traces` is polled every 15 s by every open `/traces` tab. Hooked in ONE
  place — a path list in the zone middleware, the `SIDE_EFFECTING_GETS` idiom —
  and written BEFORE the handler runs, so an attempted read that 404s still rows.

Two properties that are easy to get wrong: the row type is **`system`**, because
`activity_log.type` carries a DB CHECK and `ActivityLog.push` persists
fire-and-forget with a swallowed `.catch`, so a TS-only `"audit"` value would
compile, render on the live feed and never reach the table (`src/db/auth-audit.test.ts`
reads the rows back OUT of the database for exactly that reason); and the whole
thing is **gated to `entra`**, since on a `local` instance every row would be the
operator auditing themselves on their own feed.

## What this does not close

- **The READ collections still return everyone's rows** — `GET /api/traces` (the
  list), `GET /api/tasks`, `/api/watchers`, `/api/goals`, `/api/memories`,
  `/api/threads`, `/api/users`. They are admin-only now and audited, but they are
  not FILTERED: an admin still gets every user's rows from one call, and
  `GET /api/tasks` returns another user's task `prompt` verbatim. That is the
  admin zone working as specified, not a leak — but the day there is more than
  one operator it becomes one.
- **The four claimed-`userId` routes are admin-zone, not guarded.**
  `GET /api/messages/:userId`, `GET /api/users/:userId/overview`,
  `POST /api/users` and `PUT /chat/bot-preferences/:botName/default-user` still
  take a client-named id; what changed is that role `user` can no longer call
  them. An "own" version of each is meaningless, so the zone IS the answer.
- **The `/traces` page lists traces it cannot open.** `GET /api/traces` is
  unfiltered while `/api/traces/:traceId` is owner-guarded, so on a `local`
  instance an admin sees rows whose spans answer empty. The waterfall SAYS so;
  filtering the list is a separate change.
- **A `user` still sees the operator nav.** The nav is rendered on every page
  including `/chat`, so a role `user` can click `/traces` and get a 403 rather
  than not seeing the link. Hiding it needs the role at render time on the chat
  page and is deliberately out of this pass — a 403 is honest, an invisible link
  is a second place for the boundary to be spelled.
- **A resource guard's owner is a `users.id`, and `local` mode pins ONE.** So on
  an authenticating instance the operator's own Telegram-owned traces and
  threads answer 404 to their own web session, even at role `admin` — the guard
  keys on the id, not the role, for a row that HAS an owner. See the PR D
  section above.
- **`MUNINN_ADMIN_IDENTS` is still inert in `local` mode.** The pinned identity's
  role comes from `MUNINN_LOCAL_ROLE`, never from the allowlist. It is a boot
  requirement so the deferred Entra mode — where it IS the role source — cannot
  ship without it.
- **The loopback bypass is unchanged, and so are its limits.** It grants role
  `user` and nothing promotes it; an L4 forward still makes every client look
  local, which now means every client gets a `user`-role session rather than an
  admin one. That is a smaller blast radius, not a fix.
- **Credential guessing is not rate-limited**, and `LOCAL_TOKEN_MIN_LENGTH` is a
  length check only: a 16-character passphrase boots. Use `openssl rand -hex 24`.
- **An unauthenticated browser gets raw 401 JSON, not a login page.** There is
  still no login route — `AUTH_EXCLUDED_PATHS` carries only the two health
  endpoints, and the middleware itself is what accepts the secret.

`src/index.ts` logs all of this at boot in an authenticating mode rather than
letting the mode's presence imply a boundary it does not have.

## Wiring

Three middlewares, in this order, inside the `isAuthenticatingMode` branch on the
TOP-LEVEL app and before both `app.route()` calls:
`createAuthMiddleware` → `createOriginMiddleware` → `createZoneMiddleware`. Each
answers a different refusal — 401 "you are not logged in", 403 "this side effect
did not come from a page of mine", 403 "you are not an operator" — and the order
is what keeps them distinguishable: zones LAST because a request with no identity
has no role. `src/auth/wiring.test.ts` pins all three by reading the file, since
every one of them fails silently and in the fail-OPEN direction.

`src/index.ts` must call `app.fetch(req, server)` — `hono/bun`'s `getConnInfo`
reads the peer address off that second argument, and without it the loopback
bypass is **inert**, which turns a wrong secret into a lockout. The middleware
logs an error once if it ever cannot resolve a peer. `src/auth/middleware.test.ts`
drives a real `Bun.serve` for exactly this reason: a hand-built `app.request()`
cannot exercise that wiring at all.
