/**
 * The `MUNINN_AUTH` switch, and every boot refusal that hangs off it.
 *
 * Three modes: `off` (today's muninn, byte for byte — no middleware is even
 * mounted), `local` (one pinned identity behind a shared secret) and `entra`
 * (the NAV path: a Texas token introspection per credential, a `users` row
 * provisioned from the claims — see `AUTH_ZONES_IMPLEMENTED`, now `true`).
 *
 * Everything here is a pure function of an env-like record so the refusals are
 * unit-testable without a process. `src/index.ts` calls `resolveAuthConfig()`
 * once, before anything else is initialised, and lets the throw kill the boot.
 */
import { adminIdentsFromEnv, allowedOriginsFromEnv } from "../config.ts";
import { getLog } from "../logging.ts";
import type { AuthRole } from "./role.ts";
import { HEALTH_LIVE_PATH, HEALTH_READY_PATH } from "./zones.ts";

const log = getLog("auth", "mode");

export const AUTH_ENV = "MUNINN_AUTH";
export const AUTH_MODES = ["off", "local", "entra"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

/**
 * The `entra` gate. **Flipped to `true` here** — the zone model
 * (`src/auth/zones.ts`) landed first, and this PR is the one that makes `entra`
 * answerable: `createEntraIntrospector` (`introspect.ts`) and the
 * `user_identities` linking table (migration 073) are what it was waiting for.
 *
 * Why it existed at all: `entra` authenticates a NAV colleague but the zone
 * model is what decides which routes their `user` role may call — without it
 * every authenticated colleague reached the whole operator surface (traces,
 * prompt snapshots, `/api/users`, every CRUD route). "Entra is unsupported
 * until zones land" was enforced here rather than left as a README note,
 * because a half-built auth mode in a public repo invites someone to enable it
 * and trust it.
 *
 * It is KEPT rather than deleted, and kept as a CONSTANT: it is the one line a
 * future change to the identity half can flip back to close the mode without
 * touching a route, and an env override would let exactly the deploy that must
 * not happen happen anyway.
 */
// Annotated `: boolean`, not left as the literal type `true` — otherwise every
// `!AUTH_ZONES_IMPLEMENTED` site changes TYPE-meaning rather than value-meaning
// on the next flip, and the test pinning it becomes a tautology the compiler
// quietly rewrites.
export const AUTH_ZONES_IMPLEMENTED: boolean = true;

/**
 * Paths the middleware lets through with no credential — and which the ZONE
 * middleware skips for the same reason.
 *
 * Deliberately a constant rather than an env list, and deliberately just the
 * two health endpoints. Exclusion and zone were once described as the same
 * axis, which was true only while there were no zones: an entry here now means
 * "the open zone, reached with no credential at all", which is exactly what a
 * platform's liveness and readiness probes need and what nothing else should
 * get. `/api/live` is dependency-free; `/api/ready` pings the database. Both
 * are instance-wide and unauthenticated, so neither may carry per-user data.
 */
export const AUTH_EXCLUDED_PATHS: readonly string[] = [HEALTH_LIVE_PATH, HEALTH_READY_PATH];

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

export interface EntraAuthConfig {
  /** `NAIS_TOKEN_INTROSPECTION_ENDPOINT` — the Texas sidecar's introspection
   *  URL. Every credential on an `entra` instance is validated by POSTing to it;
   *  muninn never verifies a JWT signature itself. */
  readonly introspectionEndpoint: string;
  /**
   * `MUNINN_TENANT`, and it is **provenance bookkeeping, not a check**.
   *
   * It is written into `user_identities.tenant` so a row says which directory
   * an `oid` came from — an `oid` is unique only within a tenant, so the linking
   * table's key needs it. It is deliberately NEVER compared against the token's
   * own `tid`: Texas is the authority on which tenant it introspects against,
   * and a second comparison here would be a config value silently overruling it.
   */
  readonly tenant: string;
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
  /** Present exactly when `mode === "entra"`. */
  readonly entra: EntraAuthConfig | null;
  /**
   * The role the pinned `local` identity resolves to (`MUNINN_LOCAL_ROLE`),
   * default `user`. Honoured ONLY in `local` mode and only for an identity
   * established from a credential channel — see `resolveGrantedRole`.
   *
   * It exists because default-deny plus the three shipped facts —
   * `resolveRole` answers `user` for a local identity unconditionally,
   * `MUNINN_ADMIN_IDENTS` is inert in `local` mode, and (before the Entra
   * identity PR) `entra` could not boot — would otherwise make the operator's
   * own dashboard permanently unreachable on every `MUNINN_AUTH=local`
   * instance. It stays necessary there: on a `local` instance the allowlist is
   * still inert, whatever `entra` can now do. Default `user` so nothing changes
   * without an opt-in: PRs C–D's guard tests run against a `user`-role local
   * identity, and `requireOwnUser`'s admin passthrough would make every one of
   * them a no-op.
   */
  readonly localRole: AuthRole;
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
      `${AUTH_ENV}="entra" is not supported yet. The zone model that decides which routes a ` +
      `non-admin role may call HAS landed (src/auth/zones.ts), but the Entra half of the deploy — ` +
      `the token introspector, the profile, the wonderwall sidecar — has not, and flipping ` +
      `AUTH_ZONES_IMPLEMENTED is that PR's job. Booting now would authenticate colleagues against a ` +
      `deploy that cannot yet introspect their tokens. Refusing to start.`,
    );
  }

  if (!isAuthenticatingMode(mode)) {
    // Parsed only when a mode reads them. Running the parsers unconditionally
    // made an auth-OFF instance log `MUNINN_ALLOWED_ORIGINS contains "*"` at
    // every boot from a stale `.env` line — a warning about a variable nothing
    // in that mode consults, i.e. exactly the "nothing changes" claim breaking.
    return { mode, adminIdents: [], allowedOrigins: [], local: null, entra: null, localRole: "user" };
  }

  const adminIdents = adminIdentsFromEnv(env);
  const allowedOrigins = allowedOriginsFromEnv(env);

  // (3) An authenticating mode missing its own required config.
  if (adminIdents.length === 0) {
    // The NB is per MODE. One message carrying the `local` note in both said
    // the opposite of the truth in `entra`, where this list IS the role source:
    // an operator would set it to get past the boot and expect it to grant
    // nothing.
    throw new AuthConfigError(
      `${AUTH_ENV}="${mode}" requires a non-empty MUNINN_ADMIN_IDENTS. Refusing to start. ` +
      (mode === "entra"
        ? `In "entra" it is the ROLE SOURCE: it is matched case-insensitively against each token's own ` +
          `NAVident and oid, so an empty list means no colleague can ever resolve to admin. ` +
          `Prefer oid entries over NAVidents — a NAVident is re-issued when someone leaves, and the ` +
          `newcomer would inherit admin from the list.`
        : `NB in "local" mode this variable is INERT: the pinned identity's role comes from ` +
          `MUNINN_LOCAL_ROLE (src/auth/role.ts), so setting this does not grant anyone admin. It is ` +
          `required in every authenticating mode because in "entra" it IS the role source.`),
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
    // LIVE since AUTH_ZONES_IMPLEMENTED flipped: these two are what the Texas
    // path needs, and an instance missing either would boot into a mode that
    // can authenticate nobody. They were written (and asserted) behind refusal
    // (2) before the mode was reachable, which is why they are unchanged here —
    // turning `entra` on must not also be the moment its config contract moves.
    for (const name of ["NAIS_TOKEN_INTROSPECTION_ENDPOINT", "MUNINN_TENANT"]) {
      if (trimmed(env, name) === "") {
        throw new AuthConfigError(`${AUTH_ENV}="entra" requires ${name}. Refusing to start.`);
      }
    }
    // The endpoint has to PARSE, not merely be non-empty. A typo'd value
    // (`texas.test/introspect`, a bare path) boots a pod that looks perfectly
    // healthy and in which every single request 401s: the introspection POST
    // throws at `fetch`, which is "unavailable", which is a refusal — and
    // nothing anywhere says the string was never a URL. This is the only moment
    // anyone is looking.
    const endpoint = trimmed(env, "NAIS_TOKEN_INTROSPECTION_ENDPOINT");
    let parsedEndpoint: URL | null = null;
    try {
      parsedEndpoint = new URL(endpoint);
    } catch {
      parsedEndpoint = null;
    }
    // Parsing is not enough, and the gap is not theoretical: `new URL` accepts
    // any scheme, so `mailto:texas`, `file:///etc/passwd` and `texas.nais:8080`
    // — a host:port spelling with the scheme left off, which parses as scheme
    // `texas.nais:` — all BOOTED. The introspection call is a `fetch` POST,
    // which supports http(s) and nothing else, so every one of those is a pod
    // that looks healthy and 401s every single request: the exact failure the
    // parse check was written for, one typo to its left.
    //
    // NB a SLASH after the host (`texas.nais/introspect`) is NOT this case —
    // measured: `new URL` refuses it outright, so the parse check above already
    // had it. It is the COLON form that gets through.
    if (!parsedEndpoint || (parsedEndpoint.protocol !== "http:" && parsedEndpoint.protocol !== "https:")) {
      throw new AuthConfigError(
        `NAIS_TOKEN_INTROSPECTION_ENDPOINT="${endpoint}" is not an http(s) URL (expected e.g. ` +
        `"http://texas.nais/api/v1/introspect"). Refusing to start: every request would 401 ` +
        `against an endpoint that cannot be reached, with nothing to say why.`,
      );
    }
    return {
      mode,
      adminIdents,
      allowedOrigins,
      local: null,
      entra: {
        introspectionEndpoint: trimmed(env, "NAIS_TOKEN_INTROSPECTION_ENDPOINT"),
        tenant: trimmed(env, "MUNINN_TENANT"),
      },
      // `MUNINN_LOCAL_ROLE` is a `local`-mode escape hatch and is not parsed
      // here at all: in `entra` the role source is `MUNINN_ADMIN_IDENTS`, matched
      // against the token's own claims by `resolveRole`.
      localRole: "user",
    };
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

  // WARN, not a refusal. `MUNINN_LOCAL_USER` is a legitimate `users.id` for
  // everything in the DB, but PR C substitutes it into a FILE path on
  // `/chat/reports/*` and `/chat/specs/*`, where the pre-existing
  // `VALID_USER_ID` (`/^[a-zA-Z0-9_-]+$/`) then rejects it — so a pinned id
  // containing `.`, `@` or `:` (an email, a Slack- or Telegram-derived id)
  // makes every report/spec route 400 while the boot and the rest of the app
  // look perfectly healthy. The chat client reads that 400 as "no saved
  // report" and quietly disables the downstream buttons, so nothing surfaces
  // it. Refusing the boot would be wrong — the id is valid everywhere else —
  // but the operator should hear it once, at the only moment anyone is looking.
  if (!/^[a-zA-Z0-9_-]+$/.test(userId)) {
    log.warn(
      "MUNINN_LOCAL_USER {userId} contains characters the report/spec routes reject " +
      "(they allow only letters, digits, _ and -, because the id becomes a path segment). " +
      "Saved research reports and domain specs will 400 for this identity; everything else works.",
      { userId },
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
    entra: null,
    localRole: parseLocalRole(env),
  };
}

export const LOCAL_ROLE_ENV = "MUNINN_LOCAL_ROLE";

/**
 * `MUNINN_LOCAL_ROLE`, the `local`-mode escape hatch for the zone model.
 *
 * Unset ⇒ `user`, with a loud WARN, because the default is a working instance
 * whose operator surface is closed to its own operator and there is exactly one
 * moment anyone is looking. An unrecognised value throws — the same inverted
 * direction as `MUNINN_AUTH` itself: this variable only ever GRANTS, so a typo
 * degrading to `user` would be a silent lockout while `…=admin` sits in the
 * `.env` looking correct.
 *
 * ⚠️ Setting it to `admin` does NOT make the loopback bypass admin. The grant
 * is conditioned on the identity having come from a credential channel
 * (`resolveGrantedRole`), because the bypass hands out the pinned identity with
 * no credential at all and is blind to an L4 forward.
 */
function parseLocalRole(env: Record<string, string | undefined>): AuthRole {
  const raw = trimmed(env, LOCAL_ROLE_ENV).toLowerCase();
  if (raw === "") {
    log.warn(
      `${AUTH_ENV}="local" without ${LOCAL_ROLE_ENV}: the pinned identity resolves to role "user", ` +
      `so the zone model closes the whole operator surface to it — /traces, /models, /plans, /agents, ` +
      `/logs and the unfiltered collection reads all answer 403, and GET / redirects to /chat. ` +
      `${LOCAL_ROLE_ENV}=admin grants admin ONLY to a request whose identity came from a credential ` +
      `channel. A BROWSER on this host cannot reach the operator surface even with it set: the ` +
      `login redirect strips the token, so the browser's cookie-only request takes the loopback ` +
      `bypass (identity filled before the cookie is read) and stays "user". Reach it by fronting ` +
      `muninn with an HTTP proxy that stamps x-forwarded-* (so the bypass is removed and the cookie ` +
      `is honoured), or with curl -H "x-muninn-token: <secret>" from the host.`,
    );
    return "user";
  }
  if (raw === "user" || raw === "admin") return raw;
  throw new AuthConfigError(
    `${LOCAL_ROLE_ENV}="${raw}" is not a role (expected "user" or "admin"). Refusing to start: ` +
    `a typo degrading to "user" would lock the operator out of their own dashboard while the ` +
    `variable sits in .env looking correct.`,
  );
}
