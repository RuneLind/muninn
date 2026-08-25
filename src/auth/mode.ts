/**
 * The `MUNINN_AUTH` switch, and every boot refusal that hangs off it.
 *
 * Three modes: `off` (today's muninn, byte for byte — no middleware is even
 * mounted), `local` (one pinned identity behind a shared secret) and `entra`
 * (the deferred NAV path, which currently REFUSES to boot — see
 * `AUTH_ZONES_IMPLEMENTED`).
 *
 * Everything here is a pure function of an env-like record so the refusals are
 * unit-testable without a process. `src/index.ts` calls `resolveAuthConfig()`
 * once, before anything else is initialised, and lets the throw kill the boot.
 */
import { adminIdentsFromEnv, allowedOriginsFromEnv } from "../config.ts";

export const AUTH_ENV = "MUNINN_AUTH";
export const AUTH_MODES = ["off", "local", "entra"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

/**
 * Flipped to `true` by the DEFERRED zone model PR, and by nothing else.
 *
 * `entra` authenticates a NAV colleague but the zone model is what decides
 * which routes their `user` role may call — without it every authenticated
 * colleague reaches the whole operator surface (traces, prompt snapshots,
 * `/api/users`, every CRUD route). "Entra is unsupported until zones land" is
 * therefore enforced here rather than left as a README note: a half-built auth
 * mode in a public repo invites someone to enable it and trust it.
 *
 * This is a CONSTANT on purpose. An env override would let the deploy that must
 * not happen happen anyway, which is the whole failure this guards.
 */
// Annotated `: boolean`, not left as the literal type `false` — otherwise the
// day this flips to `true` every `!AUTH_ZONES_IMPLEMENTED` site changes
// TYPE-meaning rather than value-meaning, and the test pinning it becomes a
// tautology the compiler quietly rewrites.
export const AUTH_ZONES_IMPLEMENTED: boolean = false;

/**
 * Paths the middleware lets through with no credential.
 *
 * EMPTY in this PR, and deliberately a constant rather than an env list:
 * exclusion and zone are the same axis, so an entry here would keep a route
 * reachable with no token whatever the deferred zone model later decides.
 */
export const AUTH_EXCLUDED_PATHS: readonly string[] = [];

/** The shortest `MUNINN_LOCAL_TOKEN` we will boot with. The mode exists to close
 *  a tailnet/LAN exposure; a four-character secret would close nothing, and a
 *  refusal at boot is the only moment anyone is looking. */
export const LOCAL_TOKEN_MIN_LENGTH = 16;

export interface LocalAuthConfig {
  /** The shared secret. Presented once (query/header), exchanged for a cookie. */
  readonly token: string;
  /** The single pinned `users.id` every local session resolves to. */
  readonly userId: string;
  /** Display name for the pinned identity — cosmetic. */
  readonly displayName: string;
}

export interface AuthConfig {
  readonly mode: AuthMode;
  /** Trimmed, lowercased, de-duplicated. Empty is a boot refusal in any
   *  authenticating mode while the env allowlist is the role source. */
  readonly adminIdents: readonly string[];
  /** Normalised origins for PR C's origin/CSRF check and PR D's WebSocket
   *  upgrade check. Parsed and boot-asserted HERE; NOT yet enforced anywhere —
   *  see the note in `allowedOriginsFromEnv`. */
  readonly allowedOrigins: readonly string[];
  /** Present exactly when `mode === "local"`. */
  readonly local: LocalAuthConfig | null;
}

/** Thrown by `resolveAuthConfig`. A distinct class so `src/index.ts` can print
 *  the refusal without a stack trace and tests can assert on the type. */
export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

export function isAuthenticatingMode(mode: AuthMode): boolean {
  return mode !== "off";
}

function trimmed(env: Record<string, string | undefined>, name: string): string {
  return (env[name] ?? "").trim();
}

/**
 * Parse `MUNINN_AUTH`. Unset/blank ⇒ `off`.
 *
 * An UNRECOGNISED value throws, which is the opposite of `optionalEnvFlag`'s
 * "a typo must not brick an instance" rule — deliberately, because here the
 * directions are inverted. A typo'd `MUNINN_WIKI_READONLY` degrades to "this
 * instance writes", a nuisance; a typo'd `MUNINN_AUTH=entraa` degrading to
 * `off` is an instance the operator believes is authenticated and which is
 * wide open. Fail closed means refusing to start, not picking a default.
 */
export function parseAuthMode(env: Record<string, string | undefined> = process.env): AuthMode {
  const raw = trimmed(env, AUTH_ENV).toLowerCase();
  if (raw === "") return "off";
  if ((AUTH_MODES as readonly string[]).includes(raw)) return raw as AuthMode;
  throw new AuthConfigError(
    `${AUTH_ENV}="${raw}" is not a known auth mode (expected one of: ${AUTH_MODES.join(", ")}). ` +
    `Refusing to start: an unrecognised value must not silently degrade to "off", which would ` +
    `leave this instance unauthenticated while its operator believes otherwise.`,
  );
}

/**
 * The whole boot contract, in the order the refusals fire.
 *
 * The order is load-bearing in one place: the `entra`-without-zones refusal
 * must come BEFORE the per-mode config checks, so a fully-configured `entra`
 * deployment still reports the zone model as the reason rather than being
 * waved through by having every other variable set.
 */
export function resolveAuthConfig(env: Record<string, string | undefined> = process.env): AuthConfig {
  const mode = parseAuthMode(env);

  // (1) Fail closed on nais. A misconfigured deploy must not come up open:
  //     muninn's whole surface assumes a trusted network and on nais there is
  //     none. Fires in the OPPOSITE direction from (2) and does not cover it.
  const naisCluster = trimmed(env, "NAIS_CLUSTER_NAME");
  if (naisCluster !== "" && !isAuthenticatingMode(mode)) {
    throw new AuthConfigError(
      `NAIS_CLUSTER_NAME="${naisCluster}" is set but ${AUTH_ENV}="${mode}" is not an authenticating mode. ` +
      `Refusing to start: on nais this process is reachable by every colleague in the tenant.`,
    );
  }

  // (2) The boundary this pass depends on.
  if (mode === "entra" && !AUTH_ZONES_IMPLEMENTED) {
    throw new AuthConfigError(
      `${AUTH_ENV}="entra" is not supported yet: the zone model that decides which routes a ` +
      `non-admin role may call has not landed (AUTH_ZONES_IMPLEMENTED is false in src/auth/mode.ts). ` +
      `Authenticating colleagues without it would admit every one of them to the full operator ` +
      `surface — traces, prompt snapshots, every CRUD route. Refusing to start.`,
    );
  }

  if (!isAuthenticatingMode(mode)) {
    // Parsed only when a mode reads them. Running the parsers unconditionally
    // made an auth-OFF instance log `MUNINN_ALLOWED_ORIGINS contains "*"` at
    // every boot from a stale `.env` line — a warning about a variable nothing
    // in that mode consults, i.e. exactly the "nothing changes" claim breaking.
    return { mode, adminIdents: [], allowedOrigins: [], local: null };
  }

  const adminIdents = adminIdentsFromEnv(env);
  const allowedOrigins = allowedOriginsFromEnv(env);

  // (3) An authenticating mode missing its own required config.
  if (adminIdents.length === 0) {
    throw new AuthConfigError(
      `${AUTH_ENV}="${mode}" requires a non-empty MUNINN_ADMIN_IDENTS. Refusing to start. ` +
      `NB in "local" mode this variable is currently INERT: the pinned identity always resolves to ` +
      `role "user" by design (src/auth/role.ts), so setting it does not grant anyone admin. It is ` +
      `required now so the deferred Entra mode — where it IS the role source — cannot ship without it.`,
    );
  }
  if (allowedOrigins.length === 0) {
    throw new AuthConfigError(
      `${AUTH_ENV}="${mode}" requires a non-empty MUNINN_ALLOWED_ORIGINS (e.g. ` +
      `"https://muninn-host.example-tailnet.ts.net,http://127.0.0.1:3010"). Refusing to start. ` +
      `NB "*" is rejected while parsing, so a wildcard reaches this refusal as "empty".`,
    );
  }

  if (mode === "entra") {
    // Unreachable while (2) stands. Kept because the seam is real and the
    // deferred PR that flips AUTH_ZONES_IMPLEMENTED must not also have to
    // rediscover which variables the Texas path needs.
    for (const name of ["NAIS_TOKEN_INTROSPECTION_ENDPOINT", "MUNINN_TENANT"]) {
      if (trimmed(env, name) === "") {
        throw new AuthConfigError(`${AUTH_ENV}="entra" requires ${name}. Refusing to start.`);
      }
    }
    return { mode, adminIdents, allowedOrigins, local: null };
  }

  const token = trimmed(env, "MUNINN_LOCAL_TOKEN");
  const userId = trimmed(env, "MUNINN_LOCAL_USER");
  if (token === "" || userId === "") {
    throw new AuthConfigError(
      `${AUTH_ENV}="local" requires MUNINN_LOCAL_TOKEN (the shared secret) and MUNINN_LOCAL_USER ` +
      `(the single pinned users.id every local session resolves to). Refusing to start.`,
    );
  }
  if (token.length < LOCAL_TOKEN_MIN_LENGTH) {
    throw new AuthConfigError(
      `MUNINN_LOCAL_TOKEN is ${token.length} characters; at least ${LOCAL_TOKEN_MIN_LENGTH} are required. ` +
      `Refusing to start: this mode exists to close a tailnet/LAN exposure, which a guessable secret ` +
      `does not close.`,
    );
  }

  return {
    mode,
    adminIdents,
    allowedOrigins,
    local: {
      token,
      userId,
      displayName: trimmed(env, "MUNINN_LOCAL_NAME") || userId,
    },
  };
}
