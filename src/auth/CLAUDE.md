# `src/auth/` — the `MUNINN_AUTH` switch

This module answers **who is calling**. It answers nothing about **what they may
do**: no route is denied by role, no resource is owned, no id is derived from the
session. Those are PRs C and D of the NAV-login plan. Reading a closed boundary
into the presence of this directory is the mistake to avoid — see *What this does
not close* below.

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

## What this does not close

- **The `/chat/ws` and `/simulator/ws` upgrade.** It runs inside `Bun.serve`'s
  `fetch`, before `app.fetch`, so no Hono middleware can see it. **PR D.**
- **Claimed ids.** Every route still trusts a `userId` from a param, body or
  query. **PR C.**
- **Resource ownership.** Any authenticated caller still reaches any
  conversation, thread or draft by id. **PR D.**
- **`MUNINN_ALLOWED_ORIGINS` is parsed and boot-asserted here but enforced
  nowhere.** PR C's origin check and PR D's upgrade check read it. Do not read
  its presence as "origins are being checked".
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
