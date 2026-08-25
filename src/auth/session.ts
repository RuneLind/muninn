/**
 * The local-mode session credential: a signed, self-describing cookie value.
 *
 * Why not just put `MUNINN_LOCAL_TOKEN` in the cookie? Because then the cookie
 * IS the shared secret — every place a cookie can leak (a proxy log, a shared
 * browser profile, a screenshot of devtools) leaks the credential that also
 * arrives on the query string. A signed session instead carries only an
 * identity and an expiry, is bounded in time without any server-side store, and
 * is revoked wholesale by rotating the secret.
 *
 * Format: `v1.<payload>.<mac>`, both base64url. `payload` is JSON
 * `{u: userId, e: expiryEpochMs}`; `mac` is HMAC-SHA256 over the literal
 * `v1.<payload>` string, keyed by the shared secret under a domain-separating
 * prefix so a future signer keyed on the same secret cannot produce a value
 * this verifier accepts.
 */
import { createHmac, timingSafeEqual, createHash } from "node:crypto";

export const SESSION_COOKIE = "muninn_session";
const VERSION = "v1";
const DOMAIN = "muninn.auth.local.session.v1";

/** Seven days. Long on purpose: the operator this mode exists for is away from
 *  the machine, and a short expiry turns "my session lapsed" into the same
 *  lockout the loopback bypass exists to prevent. `HttpOnly` + `SameSite=Lax`
 *  are what bound the risk, not the clock. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface SessionPayload {
  u: string;
  e: number;
}

function b64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function sign(secret: string, signed: string): string {
  return createHmac("sha256", `${DOMAIN}:${secret}`).update(signed).digest("base64url");
}

/** Mint a session value for the pinned identity. `now` is injectable so the
 *  expiry tests do not have to sleep. */
export function mintSession(secret: string, userId: string, now: number = Date.now()): string {
  const payload: SessionPayload = { u: userId, e: now + SESSION_TTL_MS };
  const encoded = b64url(JSON.stringify(payload));
  const signed = `${VERSION}.${encoded}`;
  return `${signed}.${sign(secret, signed)}`;
}

/**
 * Verify a session value. Returns the payload, or null for ANY defect —
 * wrong version, malformed base64, bad JSON, wrong shape, bad MAC, expired.
 * One null for every failure on purpose: a caller that could tell "expired"
 * from "forged" would leak that distinction to whoever sent the value.
 */
export function verifySession(
  secret: string,
  value: string,
  now: number = Date.now(),
): { userId: string; expiresAt: number } | null {
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [version, encoded, mac] = parts as [string, string, string];
  if (version !== VERSION) return null;

  const expected = sign(secret, `${version}.${encoded}`);
  // Hash both sides before comparing: timingSafeEqual throws on a length
  // mismatch, and the throw itself would be the timing signal it exists to
  // remove. Equal-length digests make the comparison total.
  const a = createHash("sha256").update(mac).digest();
  const b = createHash("sha256").update(expected).digest();
  if (!timingSafeEqual(a, b)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const { u, e } = payload as Partial<SessionPayload>;
  if (typeof u !== "string" || u === "" || typeof e !== "number" || !Number.isFinite(e)) return null;
  if (e <= now) return null;
  return { userId: u, expiresAt: e };
}

/**
 * Constant-time equality for the shared secret itself, over sha256 digests so
 * the comparison is total regardless of the presented length.
 */
export function secretMatches(secret: string, presented: string): boolean {
  if (presented === "") return false;
  const a = createHash("sha256").update(secret).digest();
  const b = createHash("sha256").update(presented).digest();
  return timingSafeEqual(a, b);
}
