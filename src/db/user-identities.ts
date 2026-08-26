/**
 * The Entra → `users.id` linking table.
 *
 * An `entra` session arrives as a set of CLAIMS, not as a muninn user id, so
 * something has to decide which `users` row a NAV colleague acts as — and it
 * has to give the same answer tomorrow, after a rename, and on the other
 * machine. That is this table: one row per (provider, tenant, oid) → `user_id`,
 * plus the mutable claims refreshed on every login so an operator reading the
 * database can tell who a `nav-…` id belongs to.
 *
 * ## The match key is `oid`, and only `oid`
 *
 * `oid` is the only claim immutable for a person within a tenant. A `NAVident`
 * is not: it is re-issued when someone leaves and a new hire takes the ident.
 * Keying on it would eventually resolve two different humans to one account.
 * `NAVident` therefore rides along as a mutable, refreshed COLUMN, and is used
 * only to MINT a readable id the first time.
 *
 * ## `tenant` is provenance, never a check
 *
 * It comes from `MUNINN_TENANT` and is written verbatim. It is deliberately not
 * compared against the token's own `tid`: Texas is the authority on which
 * directory it introspected against, and a config value quietly overruling that
 * would be a second, weaker check in front of the real one. Its job is to keep
 * the key honest — an `oid` is unique per tenant, not globally.
 *
 * ## The re-issued-NAVident branch
 *
 * A first login mints `nav-<navident>`. If a `users` row already holds that id
 * it belongs to SOMEBODY ELSE (this oid has no identity row — that is why we
 * are here), so adopting it would silently hand a newcomer the previous
 * holder's memories, goals, threads and traces. `ON CONFLICT (id) DO NOTHING`
 * on that insert is exactly the shape that does it, which is why the taken id
 * is detected and the row is minted as `nav-<navident>-<oid-prefix>` with a
 * warning instead.
 *
 * ## What provisioning does NOT do
 *
 * It does not create a default thread. `ensureDefaultThread` opens its own
 * connection and takes no `sql` handle, and at first-login time no bot has been
 * chosen anyway — the thread is created on the first turn, where the existing
 * upsert is already idempotent. Provisioning is `users` + `user_identities`,
 * in one transaction, and nothing else.
 */
import type { Sql } from "postgres";
import { getDb } from "./client.ts";
import { getLog } from "../logging.ts";

const log = getLog("db", "user-identities");

/** The only provider this table carries today. Stored rather than implied so a
 *  second IdP does not need a migration to coexist. */
export const ENTRA_PROVIDER = "entra";

export interface NavIdentityClaims {
  /** The Entra object id — the match key. Required: a claim set without one
   *  cannot be linked to a stable row and is refused upstream. */
  readonly oid: string;
  /** `NAVident`, when the token carries it. The manifest's `claims.extra`
   *  lives in another repo, so this half must work without it. */
  readonly navIdent: string | null;
  /** The `name` claim — cosmetic, refreshed on every login. */
  readonly displayName: string | null;
  /** `MUNINN_TENANT`. Provenance; see the header. */
  readonly tenant: string;
}

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION;
}

/**
 * The id-safe form of a claim value.
 *
 * A minted id becomes a PATH SEGMENT on `/chat/reports/*` and `/chat/specs/*`,
 * where the pre-existing `VALID_USER_ID` (`/^[a-zA-Z0-9_-]+$/`) rejects anything
 * else — the same trap `resolveAuthConfig` warns about for `MUNINN_LOCAL_USER`.
 * A real NAVident (`X123456`) and a real oid (a UUID) pass through untouched;
 * this only matters for a claim set that is not what the manifest promises.
 * Sanitising can in principle collide two values onto one id, which is fine:
 * the taken-id check below catches it and suffixes, exactly as it does for a
 * re-issued NAVident.
 */
export function slugifyIdPart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/**
 * The id a first login mints: `nav-<navident>`, or `nav-<oid>` when the token
 * carries no NAVident.
 *
 * The oid fallback is not a degraded mode — the NAVident claim depends on a
 * `claims.extra` entry in a manifest that lives in a different repository, so
 * PR 2 defends itself: a claim set without one still mints a usable id, and
 * `resolveRole` already matches `MUNINN_ADMIN_IDENTS` against the oid too.
 */
export function mintNavUserId(claims: NavIdentityClaims): string {
  const part = slugifyIdPart(claims.navIdent ?? "") || slugifyIdPart(claims.oid);
  return `nav-${part}`;
}

/** The collision form. Eight hex characters of the oid is plenty to separate two
 *  humans who held the same ident, and keeps the id readable. */
function collisionUserId(base: string, oid: string): string {
  return `${base}-${slugifyIdPart(oid).slice(0, 8)}`;
}

export interface NavUserRow {
  readonly userId: string;
  /** True when this call created the rows. Only used for logging + tests. */
  readonly provisioned: boolean;
}

/**
 * Resolve (and on first sight, provision) the `users.id` a set of Entra claims
 * acts as.
 *
 * On a HIT: refresh the mutable columns and return the stored id — a changed
 * `preferred_username`, display name or NAVident updates the row and provisions
 * nothing. On a MISS: mint an id and insert both rows in ONE transaction.
 *
 * The retry loop is for the concurrent-first-login race — two requests for one
 * oid both miss, one wins the insert and the other takes a unique violation.
 * The loser re-reads and returns the winner's id rather than failing a login.
 */
export async function resolveNavUser(claims: NavIdentityClaims): Promise<NavUserRow> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const hit = await refreshExisting(claims);
    if (hit) return { userId: hit, provisioned: false };
    try {
      return { userId: await provision(claims), provisioned: true };
    } catch (err) {
      // A concurrent provisioning of the same oid. The next pass reads the
      // winner's row; a second failure is a real error and propagates.
      if (isUniqueViolation(err) && attempt === 0) continue;
      throw err;
    }
  }
  throw new Error(`resolveNavUser: could not resolve oid ${claims.oid} after a provisioning race`);
}

/** The hit path: one indexed read, then a refresh of the mutable claims. */
async function refreshExisting(claims: NavIdentityClaims): Promise<string | null> {
  const sql = getDb();
  const rows = await sql`
    UPDATE user_identities
       SET nav_ident     = ${claims.navIdent},
           display_name  = ${claims.displayName},
           last_login_at = now()
     WHERE provider = ${ENTRA_PROVIDER}
       AND tenant   = ${claims.tenant}
       AND oid      = ${claims.oid}
    RETURNING user_id
  `;
  return rows.length > 0 ? (rows[0]!.user_id as string) : null;
}

/** The miss path. `users` + `user_identities`, one transaction, no thread. */
async function provision(claims: NavIdentityClaims): Promise<string> {
  const sql = getDb();
  const base = mintNavUserId(claims);
  const username = claims.navIdent ?? claims.oid;

  return await sql.begin(async (_tx) => {
    // `TransactionSql` loses the tagged-template call signature — the house cast
    // (`src/db/threads.ts`, `connectors.ts`).
    const tx = _tx as unknown as Sql;

    // Not `ON CONFLICT (id) DO NOTHING`: a taken id here belongs to a DIFFERENT
    // person (this oid has no identity row, or we would not be in this branch),
    // and swallowing the conflict provisions a newcomer onto their account.
    const taken = await tx`SELECT 1 FROM users WHERE id = ${base}`;
    let userId = base;
    if (taken.length > 0) {
      userId = collisionUserId(base, claims.oid);
      log.warn(
        "Minted user id {base} is already taken — provisioning {userId} instead. A NAVident that has " +
        "been re-issued is the expected cause; the existing account belongs to whoever held it before " +
        "and is deliberately NOT adopted.",
        { base, userId, oid: claims.oid },
      );
      const alsoTaken = await tx`SELECT 1 FROM users WHERE id = ${userId}`;
      if (alsoTaken.length > 0) {
        throw new Error(
          `Cannot provision an Entra identity: both "${base}" and the collision form "${userId}" are ` +
          `taken by other users.id rows. Resolve by hand — refusing to adopt an existing account.`,
        );
      }
    }

    await tx`
      INSERT INTO users (id, username, display_name, platform, last_seen_at)
      VALUES (${userId}, ${username}, ${claims.displayName}, ${ENTRA_PROVIDER}, now())
    `;
    await tx`
      INSERT INTO user_identities (provider, tenant, oid, user_id, nav_ident, display_name)
      VALUES (${ENTRA_PROVIDER}, ${claims.tenant}, ${claims.oid}, ${userId}, ${claims.navIdent}, ${claims.displayName})
    `;
    log.info("Provisioned an Entra identity as {userId}", { userId, oid: claims.oid });
    return userId;
  }) as string;
}
