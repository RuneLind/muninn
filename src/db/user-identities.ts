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
import type { NavClaims } from "../auth/introspect.ts";

const log = getLog("db", "user-identities");

/** The only provider this table carries today. Stored rather than implied so a
 *  second IdP does not need a migration to coexist. */
export const ENTRA_PROVIDER = "entra";

/**
 * The claims this table is keyed and refreshed from.
 *
 * A `type` re-export, not a second declaration: the introspector produced
 * `NavClaims` and this file declared an identical `NavClaims` beside
 * it, so the two doc comments had already drifted apart while the fields still
 * matched. `import type` erases at compile time, so this adds no runtime edge
 * from `src/db/` to `src/auth/` (the reverse edge is the lazy import in
 * `defaultResolveUser`, which exists so `src/auth/` stays loadable with no
 * database).
 */
export type { NavClaims };

/**
 * The charset a `users.id` may use, as ONE exported regex.
 *
 * It is the pre-existing `VALID_USER_ID` from `src/chat/routes.ts`, which
 * rejects anything else on `/chat/reports/*` and `/chat/specs/*` where the id
 * becomes a PATH SEGMENT. `slugifyIdPart` below hard-codes exactly this
 * charset; they lived as a local const in the route file and a hand-written
 * character class here, so a change to either would have shipped as a whole
 * class of colleague whose report routes 400. Exported from the module that
 * MINTS ids, and validated against in `mintNavUserId`'s own test.
 */
export const VALID_USER_ID = /^[a-zA-Z0-9_-]+$/;

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
 * A claim set no `users.id` can be minted from — or, in `provision`'s sibling
 * branch, one whose minted id AND its collision form are both already taken by
 * other people. Two throw sites, one class, because they are the same fact: the
 * claims are immutable, so this token can never be provisioned, however many
 * times it comes back.
 *
 * ## Why this is a TYPE and not just an Error
 *
 * `createEntraIntrospector` wraps `resolveUser` in one catch that answers
 * `unavailable` — "the database is the provisioning path, so a DB outage
 * refuses the login rather than inventing an identity". `unavailable` is
 * **503, retryable, and cached for nothing**, which is exactly right for an
 * outage and exactly wrong here: this condition is a property of the token's
 * own claims and is permanent for that token, so every retry from every open
 * tab spent another Texas round-trip, another transaction and another log line,
 * forever. Classified `denied` it takes the 30 s negative cache like any other
 * refusal about immutable bytes.
 *
 * ## The marker is a PROPERTY, checked structurally
 *
 * `src/auth/introspect.ts` recognises this by `unmintableClaims === true`
 * rather than by `instanceof`, so it needs no import: the introspector's only
 * edge to `src/db/` is the lazy `import()` inside `defaultResolveUser`, which is
 * what keeps `src/auth/` loadable (and unit-testable) with no database. A
 * top-level import of this class would turn that into a hard edge, and an
 * `instanceof` across two module instances is a false negative anyway. The
 * property name is the contract; `introspect.test.ts` pins it by constructing a
 * real one of these and asserting the verdict.
 */
export class UnmintableClaimsError extends Error {
  /** The structural marker `src/auth/introspect.ts` reads. */
  readonly unmintableClaims = true as const;
  /**
   * Which refusal this is — `introspect.ts` keys its warn-once on it, so the
   * two conditions log independently: a process that has already warned about
   * an empty-slug claim set must still warn the first time the
   * operator-actionable both-ids-taken collision fires. A closed set, per the
   * `warnedReasons` discipline.
   */
  readonly unmintableKind: "mint" | "collision";
  constructor(message: string, kind: "mint" | "collision" = "mint") {
    super(message);
    this.name = "UnmintableClaimsError";
    this.unmintableKind = kind;
  }
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
export function mintNavUserId(claims: NavClaims): string {
  const part = slugifyIdPart(claims.navIdent ?? "") || slugifyIdPart(claims.oid);
  if (part === "") {
    // Both parts slugified to nothing. Minting `nav-` here is not a cosmetic
    // slip: the id is legal, so the FIRST such login takes it, the second takes
    // the collision form `nav--`, and every later one throws from deep inside
    // the provisioning transaction with a message about two ids being taken.
    // Refusing at the one place that knows which claim was unusable is the
    // whole difference between a five-second and a five-hour diagnosis.
    throw new UnmintableClaimsError(
      `Cannot mint a users.id from these claims: neither the NAVident (${JSON.stringify(claims.navIdent)}) ` +
      `nor the oid (${JSON.stringify(claims.oid)}) contains a character a users.id may use ` +
      `(${VALID_USER_ID.source}). Refusing the login rather than minting a shared placeholder id.`,
    );
  }
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
export async function resolveNavUser(claims: NavClaims): Promise<NavUserRow> {
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

/**
 * The hit path: ONE `UPDATE … RETURNING` against the (provider, tenant, oid)
 * key — the read and the refresh are the same statement — plus a second
 * statement refreshing the `users` row's own display name.
 *
 * ⚠️ **Every refreshed column is COALESCEd.** A claim the token stopped
 * carrying must not ERASE the stored one: one broken deploy of the manifest's
 * `claims.extra` drops `NAVident` from every token, and writing that NULL over
 * the column for every active user destroys the only readable link between a
 * `nav-…` id and a colleague — irrecoverably, since the claim is gone. A NEW
 * value still overwrites, which is what makes this a refresh rather than a
 * freeze. The `::text` casts are needed because a bare NULL parameter inside
 * `COALESCE` gives Postgres no type to infer from.
 */
async function refreshExisting(claims: NavClaims): Promise<string | null> {
  const sql = getDb();
  const rows = await sql`
    UPDATE user_identities
       SET nav_ident     = COALESCE(${claims.navIdent}::text, nav_ident),
           display_name  = COALESCE(${claims.displayName}::text, display_name),
           last_login_at = now()
     WHERE provider = ${ENTRA_PROVIDER}
       AND tenant   = ${claims.tenant}
       AND oid      = ${claims.oid}
    RETURNING user_id
  `;
  if (rows.length === 0) return null;
  const userId = rows[0]!.user_id as string;
  // `users.display_name` was written once, at provisioning, and then frozen —
  // so a colleague who changed their name in Entra kept the old one in every
  // dashboard listing for as long as the row lived. Same COALESCE rule.
  await sql`
    UPDATE users
       SET display_name = COALESCE(${claims.displayName}::text, display_name)
     WHERE id = ${userId}
  `;
  return userId;
}

/** The miss path. `users` + `user_identities`, one transaction, no thread. */
async function provision(claims: NavClaims): Promise<string> {
  const sql = getDb();
  const base = mintNavUserId(claims);
  const username = claims.navIdent ?? claims.oid;

  const result = await sql.begin(async (_tx) => {
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
      const alsoTaken = await tx`SELECT 1 FROM users WHERE id = ${userId}`;
      if (alsoTaken.length > 0) {
        // `UnmintableClaimsError`, not a plain one, and for the same reason the
        // empty-slug refusal wears it: both ids are derived from claims that do
        // not change, so this token can NEVER be provisioned. A plain Error is
        // classified `unavailable` by `src/auth/introspect.ts` — 503, retryable,
        // cached for nothing — i.e. every retry from every open tab spends
        // another Texas round-trip and another transaction, forever. That is
        // exactly the loop the `mintNavUserId` half of this closed, one branch
        // to its right.
        throw new UnmintableClaimsError(
          `Cannot provision an Entra identity: both "${base}" and the collision form "${userId}" are ` +
          `taken by other users.id rows. Resolve by hand — refusing to adopt an existing account.`,
          "collision",
        );
      }
    }

    // The column list mirrors `ensureUser` in `src/db/users.ts` — the other
    // writer of this table — minus the platform-specific ids it fills. A column
    // added there with a NOT NULL default has to be considered here too.
    await tx`
      INSERT INTO users (id, username, display_name, platform, last_seen_at)
      VALUES (${userId}, ${username}, ${claims.displayName}, ${ENTRA_PROVIDER}, now())
    `;
    await tx`
      INSERT INTO user_identities (provider, tenant, oid, user_id, nav_ident, display_name)
      VALUES (${ENTRA_PROVIDER}, ${claims.tenant}, ${claims.oid}, ${userId}, ${claims.navIdent}, ${claims.displayName})
    `;
    // NB the announcement lives in `defaultResolveUser` (`src/auth/introspect.ts`),
    // which reads the `provisioned` flag — logging from in here fired BEFORE
    // the transaction committed.
    return userId;
  }) as string;

  // AFTER commit, same reason as the announcement note above: an in-transaction
  // warn once claimed "provisioning <id> instead" for an attempt the very next
  // statement rolled back.
  if (result !== base) {
    // No `oid` property: the log lines land in a JSONL file sink, and the oid
    // is a directory-wide personal identifier that adds nothing an operator
    // acting on this line can use — the two minted ids are what identifies
    // the rows, and the database holds the link. (A NAVident still rides
    // INSIDE the id, which is what an operator has to be able to grep.)
    log.warn(
      "Minted user id {base} is already taken — provisioned {userId} instead. A NAVident that has " +
      "been re-issued is the expected cause; the existing account belongs to whoever held it before " +
      "and is deliberately NOT adopted.",
      { base, userId: result },
    );
  }
  return result;
}
