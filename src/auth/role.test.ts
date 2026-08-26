import { describe, test, expect } from "bun:test";
import { resolveRole } from "./role.ts";
import type { Identity } from "./introspect.ts";

function entra(over: Partial<Identity> = {}): Identity {
  return {
    userId: "nav-a123456",
    displayName: "Example Operator",
    navIdent: "A123456",
    oid: "8b1c5d3e-0000-4000-8000-000000000000",
    provider: "entra",
    expiresAt: null,
    ...over,
  };
}

function local(): Identity {
  return { userId: "rune", displayName: "rune", navIdent: null, oid: null, provider: "local", expiresAt: null };
}

describe("resolveRole", () => {
  test("auth off (no identity) is admin — today's local muninn is untouched", () => {
    expect(resolveRole(null, [])).toBe("admin");
  });

  // Load-bearing: an admin pinned identity would make PRs C-D's claimed-id
  // guards a no-op through requireOwnUser's admin passthrough, and the central
  // acceptance of this pass would pass without the diff.
  test("the pinned LOCAL identity is user by DEFAULT, never admin", () => {
    expect(resolveRole(local(), ["rune"])).toBe("user");
    // Even if someone lists it, and even if it somehow carried claims.
    expect(resolveRole({ ...local(), navIdent: "A123456" }, ["a123456"])).toBe("user");
  });

  test("the third argument is the ONLY way a local identity becomes admin", () => {
    // MUNINN_LOCAL_ROLE, threaded from AuthConfig rather than read from
    // process.env here — the function stays pure and both call sites are
    // visible. `MUNINN_ADMIN_IDENTS` still grants nothing in local mode.
    expect(resolveRole(local(), [], "admin")).toBe("admin");
    expect(resolveRole(local(), [], "user")).toBe("user");
    expect(resolveRole(local(), ["rune"], "user")).toBe("user");
  });

  test("it does NOT reach an entra identity — that role comes from the allowlist", () => {
    expect(resolveRole(entra({ navIdent: "B999999", oid: "other" }), [], "admin")).toBe("user");
    expect(resolveRole(entra(), ["a123456"], "user")).toBe("admin");
  });

  test("matches the NAVident case-insensitively on trimmed values", () => {
    expect(resolveRole(entra(), ["a123456"])).toBe("admin");
    expect(resolveRole(entra({ navIdent: "  a123456  " }), ["a123456"])).toBe("admin");
  });

  test("matches the oid too, so an absent NAVident cannot lock everyone out", () => {
    const noIdent = entra({ navIdent: null });
    expect(resolveRole(noIdent, ["8b1c5d3e-0000-4000-8000-000000000000"])).toBe("admin");
    expect(resolveRole(noIdent, ["a123456"])).toBe("user");
  });

  test("an unlisted colleague is user", () => {
    expect(resolveRole(entra({ navIdent: "B999999", oid: "other" }), ["a123456"])).toBe("user");
  });

  test("an empty allowlist resolves nobody to admin", () => {
    expect(resolveRole(entra(), [])).toBe("user");
  });

  test("blank claims never match a blank-ish allowlist entry", () => {
    expect(resolveRole(entra({ navIdent: "   ", oid: null }), [""])).toBe("user");
  });
});
