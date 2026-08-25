# `src/auth/` — the `MUNINN_AUTH` switch

This module answers **who is calling**. It answers nothing about **what they may
do**: no route is denied by role, no resource is owned, no id is derived from the
session. Those are PRs C and D of the NAV-login plan. Reading a closed boundary
into the presence of this directory is the mistake to avoid — see *What this does
not close* below.

## The three modes

| `MUNINN_AUTH` | What happens |
|---|---|
| unset / `off` | **No middleware is mounted at all.** Today's muninn, byte for byte: the user dropdown, `sim-user-1`, no tokens. |
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

## ⚠️ The loopback bypass, and the trap under it

A **direct** loopback request is granted the pinned identity with no credential,
and **no auth config can revoke it** — a wrong secret on an always-on instance
would otherwise be a lockout with no console. `ssh` + `curl 127.0.0.1:3010`
always works.

The trap: **a reverse proxy on the same host makes every remote request look
loopback.** Measured 2026-08-25 against a live `tailscale serve` publishing
`127.0.0.1:3010` to a tailnet — a request from *another tailnet device* arrives
with peer address `127.0.0.1`, identical to a local `curl`. A loopback check on
the peer address alone therefore hands the bypass to every device on the tailnet,
which is the exact exposure this campaign exists to close.

What separates them is `PROXY_HEADERS`: the proxy stamps `x-forwarded-*` and the
`tailscale-*` family, and a direct `curl` sends none of them. Also measured: a
tailnet client that tries to strip or blank those headers **does not succeed** —
the proxy overwrites them.

**The direction is what makes this safe.** Header presence can only *remove* the
bypass, never grant it, so a forged header yields a request that must
authenticate normally rather than one that gets in. Any future edit here must
preserve that direction.

The bypass resolves to role **`user`**, not `admin` — see below.

`__setLoopbackBypassForTest` exists because every automated test runs over
loopback, so the 401 path would otherwise be unreachable. It is an in-process
seam (the `src/wiki/readonly.ts` idiom), not an env var, and is therefore not
"auth config" for the purposes of the rule above.

## The credential

`local` accepts the shared secret on `X-Muninn-Token`, `Authorization: Bearer`,
or `?muninn_token=`, and exchanges it for a **signed session cookie**
(`muninn_session`, `HttpOnly`, `SameSite=Lax`, 7 days). A GET presenting the
secret on the query string is **redirected** to the same URL without it, so the
secret does not linger in history, the address bar or a `Referer`.

The cookie is a signed `{userId, expiry}`, not the secret itself — a leaked
cookie must not be a leaked credential-for-everything. Rotating
`MUNINN_LOCAL_TOKEN` invalidates every session.

**A note for PR C:** `SameSite=Lax` already blocks the cross-site *POST* half of
the CSRF surface. A CSRF test written against a POST will therefore be green
whether or not PR C's origin check exists. The half Lax does **not** cover is the
side-effecting top-level **GET** (`GET /chat/pending/:threadId`,
`GET /api/research/ask`) — that is where the origin check earns its keep and
where its test belongs.

## Roles

`resolveRole(identity, adminIdents)` is the single seam, so the source can move
from the env allowlist to an Entra `groups` claim without touching a call site.
Two answers skip the list entirely:

- **auth off ⇒ `admin`** — today's local muninn is untouched.
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

`src/index.ts` logs all of this at boot in an authenticating mode rather than
letting the mode's presence imply a boundary it does not yet have.

## Wiring

`src/index.ts` must call `app.fetch(req, server)` — `hono/bun`'s `getConnInfo`
reads the peer address off that second argument, and without it the loopback
bypass is **inert**, which turns a wrong secret into a lockout. The middleware
logs an error once if it ever cannot resolve a peer. `src/auth/middleware.test.ts`
drives a real `Bun.serve` for exactly this reason: a hand-built `app.request()`
cannot exercise that wiring at all.
