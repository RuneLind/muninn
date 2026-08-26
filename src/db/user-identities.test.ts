import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { getDb } from "./client.ts";
import {
  ENTRA_PROVIDER,
  mintNavUserId,
  resolveNavUser,
  slugifyIdPart,
  UnmintableClaimsError,
  VALID_USER_ID,
} from "./user-identities.ts";

/**
 * Provisioning, against a real Postgres.
 *
 * The rows are what make an `entra` session stable, so every assertion here
 * reads them back out of the DATABASE rather than trusting the return value —
 * the same discipline `src/db/auth-audit.test.ts` follows for the audit rows,
 * and for the same reason: a function can return the right id while writing the
 * wrong thing (or nothing).
 *
 * No NAV values: `example-tenant`, `X999999`, placeholder UUIDs. This repo is
 * public.
 */

setupTestDb();

const TENANT = "example-tenant";
const OID_A = "00000000-1111-2222-3333-aaaaaaaaaaaa";
const OID_B = "00000000-1111-2222-3333-bbbbbbbbbbbb";

const claims = (over: Partial<Parameters<typeof resolveNavUser>[0]> = {}) => ({
  oid: OID_A,
  navIdent: "X999999",
  displayName: "Test Person",
  tenant: TENANT,
  ...over,
});

async function usersRow(id: string) {
  const [row] = await getDb()`SELECT * FROM users WHERE id = ${id}`;
  return row ?? null;
}

async function identityRows() {
  return await getDb()`SELECT * FROM user_identities ORDER BY oid`;
}

describe("mintNavUserId", () => {
  test("nav-<navident>, lowercased", () => {
    expect(mintNavUserId(claims())).toBe("nav-x999999");
  });

  test("falls back to the oid when the token carries no NAVident", () => {
    // The `claims.extra: ["NAVident"]` entry lives in another repository, so a
    // claim set without one must still mint a usable id.
    expect(mintNavUserId(claims({ navIdent: null }))).toBe(`nav-${OID_A}`);
  });

  test("the minted id is always a legal path segment", () => {
    // It becomes one on /chat/reports/* and /chat/specs/*, where VALID_USER_ID
    // (`/^[a-zA-Z0-9_-]+$/`) rejects anything else — the trap resolveAuthConfig
    // warns about for MUNINN_LOCAL_USER.
    for (const navIdent of ["X999999", "a.b@example.test", "Æ Ø Å", "x/../etc"]) {
      expect(mintNavUserId(claims({ navIdent }))).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });

  test("slugifyIdPart collapses and trims rather than emitting empty segments", () => {
    expect(slugifyIdPart("  A..B  ")).toBe("a-b");
    expect(slugifyIdPart("---")).toBe("");
  });

  test("a claim set that slugifies to NOTHING is refused, not minted", () => {
    // Both parts empty means the id would be the bare prefix `nav-`, which
    // `VALID_USER_ID` happens to accept — so the SECOND such login mints
    // `nav--` (also legal), and once both are taken every later one throws from
    // deep inside the provisioning transaction. Refusing here says which claim
    // was unusable, at the one place that knows.
    expect(() => mintNavUserId(claims({ navIdent: "---", oid: "!!!" }))).toThrow(/oid/i);
    expect(() => mintNavUserId(claims({ navIdent: null, oid: "   " }))).toThrow(/oid/i);
    // A usable oid still saves an unusable NAVident — that is the fallback.
    expect(mintNavUserId(claims({ navIdent: "///" }))).toBe(`nav-${OID_A}`);
  });

  test("that refusal carries the STRUCTURAL marker the introspector classifies on", () => {
    // It is a permanent property of the token's claims, so
    // `createEntraIntrospector` must answer `denied` (30 s negative cache) and
    // not `unavailable` (503, retryable, cached for nothing). It reads
    // `unmintableClaims === true` off the thrown value rather than importing
    // this class — the auth module's only edge to `src/db/` is a lazy
    // `import()` — so the PROPERTY is the contract, not the class identity, and
    // renaming it silently turns every such login back into a retry storm.
    let thrown: unknown;
    try { mintNavUserId(claims({ navIdent: "---", oid: "!!!" })); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(UnmintableClaimsError);
    expect((thrown as { unmintableClaims?: unknown }).unmintableClaims).toBe(true);
    // A DB failure must not wear it — that is the half that stays `unavailable`.
    expect((new Error("the database is unreachable") as { unmintableClaims?: unknown }).unmintableClaims)
      .toBeUndefined();
  });

  test("the minted id is validated against the SHARED VALID_USER_ID", () => {
    // `slugifyIdPart` hard-codes that regex's charset. They were a local const
    // in `src/chat/routes.ts` and a hand-written character class here; one
    // export means a change to either is a compile-or-test failure rather than
    // a route that 400s for a whole class of colleague.
    expect(VALID_USER_ID.test(mintNavUserId(claims()))).toBe(true);
    expect(VALID_USER_ID.test("nav-")).toBe(true);
    expect(VALID_USER_ID.test("")).toBe(false);
  });
});

describe("acceptance 13 — one row pair on first login, nothing on the second", () => {
  test("a first login provisions exactly one users row and one identity row", async () => {
    const result = await resolveNavUser(claims());
    expect(result).toEqual({ userId: "nav-x999999", provisioned: true });

    const user = await usersRow("nav-x999999");
    expect(user).not.toBeNull();
    expect(user!.username).toBe("X999999");
    expect(user!.display_name).toBe("Test Person");
    expect(user!.platform).toBe(ENTRA_PROVIDER);

    const identities = await identityRows();
    expect(identities.length).toBe(1);
    expect(identities[0]).toMatchObject({
      provider: ENTRA_PROVIDER,
      tenant: TENANT,
      oid: OID_A,
      user_id: "nav-x999999",
      nav_ident: "X999999",
    });
  });

  test("a second login for the same oid provisions nothing and returns the same id", async () => {
    const first = await resolveNavUser(claims());
    const second = await resolveNavUser(claims());
    expect(second).toEqual({ userId: first.userId, provisioned: false });
    expect((await identityRows()).length).toBe(1);
    expect((await getDb()`SELECT count(*)::int AS n FROM users`)[0]!.n).toBe(1);
  });

  test("…including after the display name and NAVident change — the row is REFRESHED", async () => {
    await resolveNavUser(claims());
    const again = await resolveNavUser(claims({ displayName: "Renamed Person", navIdent: "X888888" }));
    expect(again.userId).toBe("nav-x999999");
    expect(again.provisioned).toBe(false);

    const [identity] = await identityRows();
    expect(identity!.display_name).toBe("Renamed Person");
    // The mutable half really is mutable — the id was minted from the OLD
    // ident and deliberately does not move, but the column tracks the token.
    expect(identity!.nav_ident).toBe("X888888");
    expect((await identityRows()).length).toBe(1);
  });
});

describe("a claim the token stopped carrying must not ERASE the stored one", () => {
  test("an absent NAVident or display name leaves the columns as they were", async () => {
    // One broken deploy of the manifest's `claims.extra` drops NAVident from
    // every token — and the hit path wrote that NULL over the column for every
    // active user, so the operator loses the only readable link between a
    // `nav-…` id and a colleague. COALESCE keeps the last value we saw.
    await resolveNavUser(claims());
    await resolveNavUser(claims({ navIdent: null, displayName: null }));

    const [identity] = await identityRows();
    expect(identity!.nav_ident).toBe("X999999");
    expect(identity!.display_name).toBe("Test Person");
  });

  test("a NEW value still overwrites — the columns are refreshed, not frozen", async () => {
    await resolveNavUser(claims());
    await resolveNavUser(claims({ navIdent: "X888888", displayName: "Renamed Person" }));
    const [identity] = await identityRows();
    expect(identity!.nav_ident).toBe("X888888");
    expect(identity!.display_name).toBe("Renamed Person");
  });

  test("users.display_name is refreshed on login too, and never nulled", async () => {
    // It was written ONCE, at provisioning, and then frozen: a colleague who
    // changed their name in Entra showed the old one in every dashboard
    // listing for as long as the row lived.
    const { userId } = await resolveNavUser(claims());
    await resolveNavUser(claims({ displayName: "Renamed Person" }));
    expect((await usersRow(userId))!.display_name).toBe("Renamed Person");
    await resolveNavUser(claims({ displayName: null }));
    expect((await usersRow(userId))!.display_name).toBe("Renamed Person");
  });
});

describe("acceptance 14 — a re-issued NAVident does NOT adopt the existing account", () => {
  test("the collision takes the suffix fallback", async () => {
    // Seeded, not reasoned about: someone else already holds `nav-x999999` —
    // the previous holder of the ident, or any pre-existing row with that id.
    await getDb()`
      INSERT INTO users (id, username, platform) VALUES ('nav-x999999', 'X999999', 'web')
    `;

    const result = await resolveNavUser(claims({ oid: OID_B }));
    expect(result.provisioned).toBe(true);
    expect(result.userId).not.toBe("nav-x999999");
    expect(result.userId).toBe(`nav-x999999-${OID_B.slice(0, 8)}`);

    // The pre-existing account is untouched: not renamed, not re-platformed,
    // and NOT linked to the newcomer's oid.
    const existing = await usersRow("nav-x999999");
    expect(existing!.platform).toBe("web");
    const identities = await identityRows();
    expect(identities.length).toBe(1);
    expect(identities[0]!.user_id).toBe(result.userId);
  });

  test("⚠️ both ids taken is a DENIAL, not an outage — it carries the marker too", async () => {
    // The sibling of the empty-slug refusal, and it was a plain Error: classified
    // `unavailable` by src/auth/introspect.ts, which is 503 + retryable + cached
    // for NOTHING, so every retry from every open tab spends another Texas
    // round-trip and another provisioning transaction, forever. Both ids are
    // derived from claims that never change, so this token can never be
    // provisioned and the answer must be the 30 s negative cache.
    await getDb()`INSERT INTO users (id, username, platform) VALUES ('nav-x999999', 'X999999', 'web')`;
    await getDb()`
      INSERT INTO users (id, username, platform)
      VALUES (${`nav-x999999-${OID_B.slice(0, 8)}`}, 'X999999', 'web')
    `;

    let thrown: unknown;
    try { await resolveNavUser(claims({ oid: OID_B })); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(UnmintableClaimsError);
    // The PROPERTY is the contract — introspect.ts reads it structurally rather
    // than importing this class, so an `instanceof`-only assertion would pass a
    // rename that silently restores the retry storm.
    expect((thrown as { unmintableClaims?: unknown }).unmintableClaims).toBe(true);
    expect((thrown as Error).message).toMatch(/refusing to adopt an existing account/i);

    // …and the refusal really rolled back: no third users row, no link.
    expect((await getDb()`SELECT count(*)::int AS n FROM users`)[0]!.n).toBe(2);
    expect((await identityRows()).length).toBe(0);
  });

  test("the two humans stay separate across later logins", async () => {
    await getDb()`INSERT INTO users (id, username, platform) VALUES ('nav-x999999', 'X999999', 'web')`;
    const newcomer = await resolveNavUser(claims({ oid: OID_B }));
    const again = await resolveNavUser(claims({ oid: OID_B }));
    expect(again.userId).toBe(newcomer.userId);
    expect(again.provisioned).toBe(false);
  });
});

describe("acceptance 15 — no NAVident at all", () => {
  test("a claim set without one mints from the oid and links normally", async () => {
    const result = await resolveNavUser(claims({ navIdent: null }));
    expect(result.userId).toBe(`nav-${OID_A}`);

    const user = await usersRow(result.userId);
    expect(user!.username).toBe(OID_A);
    const [identity] = await identityRows();
    expect(identity!.nav_ident).toBeNull();
    expect(identity!.user_id).toBe(result.userId);
  });
});

describe("acceptance 16 — stability", () => {
  test("the same oid resolves to the same users.id however the other claims move", async () => {
    // "Across a restart" is the same question as "across a fresh call with the
    // row already there": nothing is held in process memory.
    const first = await resolveNavUser(claims());
    for (const over of [
      { displayName: null },
      { navIdent: "X111111" },
      { displayName: "Third Spelling", navIdent: null },
    ]) {
      expect((await resolveNavUser(claims(over))).userId).toBe(first.userId);
    }
    expect((await identityRows()).length).toBe(1);
  });

  test("a different TENANT is a different identity, not the same person", async () => {
    // An oid is unique per directory, not globally — which is why tenant is in
    // the key even though it is never compared against the token's `tid`.
    const a = await resolveNavUser(claims());
    const b = await resolveNavUser(claims({ tenant: "other-tenant" }));
    expect(b.userId).not.toBe(a.userId);
    expect((await identityRows()).length).toBe(2);
  });
});

describe("concurrency", () => {
  test("two simultaneous first logins for one oid settle on ONE account", async () => {
    // The introspector single-flights, so this is belt and braces — but two
    // muninn processes against one database have no shared flight.
    const results = await Promise.all([
      resolveNavUser(claims()),
      resolveNavUser(claims()),
      resolveNavUser(claims()),
    ]);
    expect(new Set(results.map((r) => r.userId)).size).toBe(1);
    expect((await identityRows()).length).toBe(1);
    expect((await getDb()`SELECT count(*)::int AS n FROM users`)[0]!.n).toBe(1);
  });
});

describe("the cascade", () => {
  test("deleting the users row takes its identity links with it", async () => {
    // A link pointing at a missing account would resolve the next login to a
    // row that is not there.
    const { userId } = await resolveNavUser(claims());
    await getDb()`DELETE FROM users WHERE id = ${userId}`;
    expect((await identityRows()).length).toBe(0);
  });
});
