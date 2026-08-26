import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { getDb } from "./client.ts";
import { ENTRA_PROVIDER, mintNavUserId, resolveNavUser, slugifyIdPart } from "./user-identities.ts";

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
