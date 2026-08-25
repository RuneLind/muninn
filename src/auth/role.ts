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
 *  - **Auth off ⇒ `admin`.** Today's local muninn is untouched; there is no
 *    identity to compare and every operator surface must keep working.
 *  - **A `local` provider identity ⇒ `user`, always.** This is load-bearing,
 *    not a default. `requireOwnUser`'s admin passthrough (PRs C–D) makes every
 *    claimed-id guard a no-op for an admin, so a pinned identity that resolved
 *    to `admin` would make the central acceptance of this whole pass pass
 *    without the diff. The cost — NULL-owner resources being admin-only — is
 *    paid instead by allowing a NULL owner in local mode, where there is one
 *    human and the distinction has no meaning yet.
 */
export function resolveRole(identity: Identity | null, adminIdents: readonly string[]): AuthRole {
  if (identity === null) return "admin";
  if (identity.provider === "local") return "user";

  const candidates = [identity.navIdent, identity.oid]
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .map((v) => v.trim().toLowerCase());

  return candidates.some((c) => adminIdents.includes(c)) ? "admin" : "user";
}
