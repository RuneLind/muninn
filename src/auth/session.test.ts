import { describe, test, expect } from "bun:test";
import { mintSession, verifySession, secretMatches, SESSION_TTL_MS } from "./session.ts";

const SECRET = "a-sufficiently-long-secret";

describe("the signed local session", () => {
  test("round-trips the pinned identity and an expiry", () => {
    const now = 1_700_000_000_000;
    const value = mintSession(SECRET, "rune", now);
    expect(verifySession(SECRET, value, now)).toEqual({ userId: "rune", expiresAt: now + SESSION_TTL_MS });
  });

  test("the cookie value does not contain the shared secret", () => {
    // The whole reason this module exists rather than putting the token in a
    // cookie. A leaked cookie must not be a leaked credential-for-everything.
    expect(mintSession(SECRET, "rune")).not.toContain(SECRET);
  });

  test("a session signed with a different secret is refused", () => {
    const value = mintSession("some-other-long-secret", "rune");
    expect(verifySession(SECRET, value)).toBeNull();
  });

  test("a tampered payload is refused even though it is well-formed", () => {
    const value = mintSession(SECRET, "rune");
    const [version, , mac] = value.split(".");
    const forged = Buffer.from(JSON.stringify({ u: "someone-else", e: Date.now() + 1000 })).toString("base64url");
    expect(verifySession(SECRET, `${version}.${forged}.${mac}`)).toBeNull();
  });

  test("an expired session is refused", () => {
    const now = 1_700_000_000_000;
    const value = mintSession(SECRET, "rune", now);
    expect(verifySession(SECRET, value, now + SESSION_TTL_MS)).toBeNull();
    expect(verifySession(SECRET, value, now + SESSION_TTL_MS - 1)).not.toBeNull();
  });

  test("malformed values of every shape are refused, not thrown on", () => {
    for (const bad of ["", "x", "v1.x", "v1.x.y.z", "v2.a.b", "v1..", "v1.!!!.!!!"]) {
      expect(verifySession(SECRET, bad)).toBeNull();
    }
  });

  test("a valid signature over a non-session payload is still refused", () => {
    // Guards the shape check: a signed `{}` must not authenticate as anyone.
    const encoded = Buffer.from(JSON.stringify({ hello: "world" })).toString("base64url");
    const signed = `v1.${encoded}`;
    const mac = require("node:crypto")
      .createHmac("sha256", `muninn.auth.local.session.v1:${SECRET}`)
      .update(signed)
      .digest("base64url");
    expect(verifySession(SECRET, `${signed}.${mac}`)).toBeNull();
  });
});

describe("secretMatches", () => {
  test("matches the exact secret and nothing else", () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true);
    expect(secretMatches(SECRET, `${SECRET}x`)).toBe(false);
    expect(secretMatches(SECRET, SECRET.toUpperCase())).toBe(false);
  });

  test("an empty presented value never matches, including against an empty secret", () => {
    expect(secretMatches(SECRET, "")).toBe(false);
    expect(secretMatches("", "")).toBe(false);
  });

  test("a presented value of a different length is refused, not thrown on", () => {
    // timingSafeEqual throws on unequal lengths; hashing first makes it total.
    expect(() => secretMatches(SECRET, "s")).not.toThrow();
    expect(secretMatches(SECRET, "s")).toBe(false);
  });
});
