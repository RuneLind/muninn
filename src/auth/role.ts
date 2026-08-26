/**
 * Role resolution, as one function, so the source can change from an env
 * allowlist to an Entra `groups` claim without touching a call site.
 */
import type { Identity } from "./introspect.ts";

export type AuthRole = "user" | "admin";

/**
 * v1 reads `MUNINN_ADMIN_IDENTS` — already trimmed/lowercased/de-duplicated by
 * `adminIdentsFromEnv` — and compares it case-insensitively against BOTH the
 * `NAVident` and the `oid`. Both, because §3 allows NAVident to be absent, and
 * a misconfigured claim set would otherwise leave *nobody* resolving to admin
 * and the dashboard — the stated reason for deploying at all — unreachable
 * until a redeploy.
 *
 * Two answers are given without consulting the list at all:
 *
 *  - **A `null` identity ⇒ `admin`**, i.e. "auth off". NB nothing calls this
 *    with `null` today: with auth off no middleware is mounted, so `c.get(
 *    "identity")` is `undefined` rather than null and `resolveRole` is never
 *    reached at all. The branch is here for PRs C–D's guards, which run in both
 *    modes and must keep today's operator surface working — they are what will
 *    pass the `null`. Do not read this line as something enforced now.
 *  - **A `local` provider identity ⇒ `localRole`, default `user`.** The default
 *    is load-bearing, not a shrug: `requireOwnUser`'s admin passthrough (PRs
 *    C–D) makes every claimed-id guard a no-op for an admin, so a pinned
 *    identity that resolved to `admin` by default would make the central
 *    acceptance of that pass pass without the diff. The cost — NULL-owner
 *    resources being admin-only — is paid instead by allowing a NULL owner in
 *    local mode, where there is one human and the distinction has no meaning
 *    yet.
 *
 *    The zone model is what made an override necessary at all: with
 *    default-deny, `MUNINN_ADMIN_IDENTS` inert in `local` mode and `entra`
 *    unbootable, no admin identity was reachable on any bootable instance and
 *    the operator's own dashboard was permanently 403. `MUNINN_LOCAL_ROLE` is
 *    that opt-in — an explicit third argument rather than a `process.env` read,
 *    so this function stays pure and both call sites are visible.
 *
 *    ⚠️ **Callers must not pass `"admin"` for an identity the loopback bypass
 *    granted.** `resolveGrantedRole` (`middleware.ts`) is the one place that
 *    decides, and both call sites go through it.
 */
export function resolveRole(
  identity: Identity | null,
  adminIdents: readonly string[],
  localRole: AuthRole = "user",
): AuthRole {
  if (identity === null) return "admin";
  if (identity.provider === "local") return localRole;

  const candidates = [identity.navIdent, identity.oid]
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .map((v) => v.trim().toLowerCase());

  return candidates.some((c) => adminIdents.includes(c)) ? "admin" : "user";
}
