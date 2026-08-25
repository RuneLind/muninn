# `src/auth/` — the `MUNINN_AUTH` switch

This module answers **who is calling**, and — since PR C — **which user id a
route is allowed to act on**. It still answers nothing about *which routes a
role may call* or *who owns a given row*: no route is denied by role, and no
resource is owned. Those are the deferred zone model and PR D. Reading a closed
boundary into the presence of this directory is the mistake to avoid — see
*What this does not close* below.

## The three modes

| `MUNINN_AUTH` | What happens |
|---|---|
| unset / `off` | **No middleware is mounted at all**: the user dropdown, `sim-user-1`, no tokens. One deliberate exception to "unchanged" — refusal (2) below means an instance with `NAIS_CLUSTER_NAME` set now refuses to boot where it previously started. |
| `local` | One **pinned identity** behind a **shared secret**. The shape for a single human's instance that is reachable beyond loopback. |
| `entra` | **Refuses to boot.** See `AUTH_ZONES_IMPLEMENTED`. |

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
- **a `local` identity ⇒ `user`, always.** Load-bearing, not a default:
  `requireOwnUser`'s admin passthrough (PRs C–D) makes every claimed-id guard a
  no-op for an admin, so a pinned identity resolving to `admin` would make the
  central acceptance of this whole pass pass *without the diff*. The cost —
  NULL-owner resources being admin-only — is paid instead by allowing a NULL
  owner in local mode, where there is one human and the distinction has no
  meaning yet.

`MUNINN_ADMIN_IDENTS` is matched case-insensitively on trimmed values against
**both** `NAVident` and `oid`, because a claim set missing one of them would
otherwise leave *nobody* resolving to admin.

## `AUTH_EXCLUDED_PATHS` is empty, deliberately

Exclusion and zone are the same axis, so an entry here would keep a route
reachable with no token whatever the deferred zone model later decides. It is a
constant rather than an env list for the same reason. The login flow needs no
exclusion because the *middleware itself* is what accepts the secret.

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
`GET /api/users/:userId/overview` and `POST /api/users` are
`admin-zone-deferred`: §4 assigns them to the admin zone, where an "own" version
is meaningless (minting a user row has none, and a guard there would only make
the route un-callable). Nothing denies them until the zone model lands, and the
fixture says so rather than letting the absence read as an oversight. The same
is true of **`PUT /chat/bot-preferences/:botName/default-user`** — the GET
beside it reads no claimed id, it *returns* one.

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

## What this does not close

- **Four routes still accept a claimed `userId`, and nothing denies them.**
  `GET /api/messages/:userId`, `GET /api/users/:userId/overview`,
  `POST /api/users` and `PUT /chat/bot-preferences/:botName/default-user` are
  `admin-zone-deferred` in `claimed-id-inventory.txt`: §4 assigns them to the
  admin zone, where an "own" version is meaningless. The zone model is
  deferred, so in `local` mode — where `resolveRole` answers `user` for
  everyone — they are open to any authenticated caller. Verified live:
  `GET /api/messages/<anyone>` answers 200.
- **The `/chat/ws` and `/simulator/ws` upgrade.** It runs inside `Bun.serve`'s
  `fetch`, before `app.fetch`, so no Hono middleware can see it. **PR D.**
- **Resource ownership.** Any authenticated caller still reaches any
  conversation, thread or draft by **id** — `GET|POST /chat/conversations/:id/messages`,
  `PATCH|DELETE /chat/threads/:id`, `GET /chat/pending/:threadId`, the
  `/api/jira/draft*` routes. Those carry no claimed `:userId`, so PR C's guard
  structurally cannot reach them. **PR D.**
- **Collection routes still return everyone's rows.** `GET /chat/conversations`
  publishes `id`, `userId` and `username` for every conversation in memory.
  They need a FILTER, not a gate. **PR D.**
- **Which routes a role may call.** Nothing is denied by role. `resolveRole`
  answers, and `requireOwnUser`'s admin passthrough uses it, but there is no
  zone middleware — so an authenticated `user` still reaches `/traces`,
  `/api/prompts/:traceId` and `/api/events`. **Deferred zone model**, and the
  reason `MUNINN_AUTH=entra` refuses to boot.
- **`MUNINN_ALLOWED_ORIGINS` is now enforced** by the origin middleware and the
  CORS disposition — but **not** on the `/chat/ws` upgrade, which no Hono
  middleware can see. A cross-origin `wss://` handshake is still accepted.
  **PR D.**
- **`MUNINN_ADMIN_IDENTS` is inert in `local` mode.** The pinned identity always
  resolves to `user`, so the allowlist grants nobody anything today. It is a
  boot requirement so the deferred Entra mode — where it IS the role source —
  cannot ship without it.
- **Credential guessing is not rate-limited**, and `LOCAL_TOKEN_MIN_LENGTH` is a
  length check only: a 16-character passphrase boots. Use `openssl rand -hex 24`.
- **An unauthenticated browser gets raw 401 JSON, not a login page.** There is no
  login route (`AUTH_EXCLUDED_PATHS` is empty), by design.

`src/index.ts` logs all of this at boot in an authenticating mode rather than
letting the mode's presence imply a boundary it does not yet have.

## Wiring

`src/index.ts` must call `app.fetch(req, server)` — `hono/bun`'s `getConnInfo`
reads the peer address off that second argument, and without it the loopback
bypass is **inert**, which turns a wrong secret into a lockout. The middleware
logs an error once if it ever cannot resolve a peer. `src/auth/middleware.test.ts`
drives a real `Bun.serve` for exactly this reason: a hand-built `app.request()`
cannot exercise that wiring at all.
