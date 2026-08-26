import { describe, test, expect } from "bun:test";
import {
  AUTH_ZONES_IMPLEMENTED,
  AUTH_EXCLUDED_PATHS,
  AuthConfigError,
  LOCAL_TOKEN_MIN_LENGTH,
  parseAuthMode,
  resolveAuthConfig,
} from "./mode.ts";

/** A fully-valid local-mode env, so each test can break exactly one thing. */
function localEnv(over: Record<string, string | undefined> = {}) {
  return {
    MUNINN_AUTH: "local",
    MUNINN_LOCAL_TOKEN: "a-sufficiently-long-secret",
    MUNINN_LOCAL_USER: "rune",
    MUNINN_ADMIN_IDENTS: "A123456",
    MUNINN_ALLOWED_ORIGINS: "https://muninn-host.example-tailnet.ts.net",
    ...over,
  };
}

/** The `entra` twin. No NAV values: the tenant and the ident are placeholders —
 *  muninn is a public repo (see the repo's brief), and the introspection
 *  endpoint here answers nothing. */
function entraEnv(over: Record<string, string | undefined> = {}) {
  return {
    MUNINN_AUTH: "entra",
    NAIS_TOKEN_INTROSPECTION_ENDPOINT: "http://texas.test/introspect",
    MUNINN_TENANT: "example-tenant",
    MUNINN_ADMIN_IDENTS: "A123456",
    MUNINN_ALLOWED_ORIGINS: "https://muninn.example.test",
    ...over,
  };
}

describe("parseAuthMode", () => {
  test("unset, blank and whitespace all mean off", () => {
    expect(parseAuthMode({})).toBe("off");
    expect(parseAuthMode({ MUNINN_AUTH: "" })).toBe("off");
    expect(parseAuthMode({ MUNINN_AUTH: "   " })).toBe("off");
  });

  test("the three modes parse, case-insensitively", () => {
    expect(parseAuthMode({ MUNINN_AUTH: "off" })).toBe("off");
    expect(parseAuthMode({ MUNINN_AUTH: "LOCAL" })).toBe("local");
    expect(parseAuthMode({ MUNINN_AUTH: " Entra " })).toBe("entra");
  });

  // The inverted-direction rule: a typo must NOT degrade to "off". This is the
  // assertion that fails if someone later "fixes" this to match optionalEnvFlag.
  test("an unrecognised value throws rather than degrading to off", () => {
    expect(() => parseAuthMode({ MUNINN_AUTH: "entraa" })).toThrow(AuthConfigError);
    expect(() => parseAuthMode({ MUNINN_AUTH: "on" })).toThrow(/not a known auth mode/);
    expect(() => parseAuthMode({ MUNINN_AUTH: "true" })).toThrow(AuthConfigError);
  });
});

describe("acceptance 5 — fail closed, both directions", () => {
  test("NAIS_CLUSTER_NAME set with a non-authenticating mode refuses to boot", () => {
    expect(() => resolveAuthConfig({ NAIS_CLUSTER_NAME: "dev-gcp" })).toThrow(AuthConfigError);
    expect(() => resolveAuthConfig({ NAIS_CLUSTER_NAME: "dev-gcp", MUNINN_AUTH: "off" }))
      .toThrow(/NAIS_CLUSTER_NAME.*is not an authenticating mode/s);
  });

  test("a blank NAIS_CLUSTER_NAME is not 'on nais'", () => {
    expect(resolveAuthConfig({ NAIS_CLUSTER_NAME: "  " }).mode).toBe("off");
  });

  test("NAIS_CLUSTER_NAME with an authenticating mode passes that refusal", () => {
    expect(resolveAuthConfig(localEnv({ NAIS_CLUSTER_NAME: "dev-gcp" })).mode).toBe("local");
  });

  // The boundary the previous pass depended on, now crossed. This PR is the one
  // that made `entra` answerable (the Texas introspector + migration 073), so
  // the constant is `true` and the refusal it drove is inert.
  test("AUTH_ZONES_IMPLEMENTED is true, and entra no longer refuses on it", () => {
    expect(AUTH_ZONES_IMPLEMENTED).toBe(true);
    expect(() => resolveAuthConfig(entraEnv())).not.toThrow();
  });

  test("entra boots with its full config, on nais included", () => {
    const config = resolveAuthConfig(entraEnv({ NAIS_CLUSTER_NAME: "prod-gcp" }));
    expect(config.mode).toBe("entra");
    expect(config.local).toBeNull();
    expect(config.entra).toEqual({
      introspectionEndpoint: "http://texas.test/introspect",
      tenant: "example-tenant",
    });
    // The role source in `entra` is MUNINN_ADMIN_IDENTS matched against the
    // token's claims; MUNINN_LOCAL_ROLE is a `local`-mode hatch and is not read.
    expect(config.localRole).toBe("user");
  });

  test("entra still refuses without MUNINN_TENANT or the introspection endpoint", () => {
    // These asserts were written behind the previously-unreachable branch. They
    // are LIVE now, and this is the regression pin: an instance missing either
    // would boot into a mode that can authenticate nobody.
    expect(() => resolveAuthConfig(entraEnv({ MUNINN_TENANT: undefined })))
      .toThrow(/MUNINN_TENANT/);
    expect(() => resolveAuthConfig(entraEnv({ NAIS_TOKEN_INTROSPECTION_ENDPOINT: undefined })))
      .toThrow(/NAIS_TOKEN_INTROSPECTION_ENDPOINT/);
  });

  test("entra shares the two authenticating-mode refusals", () => {
    expect(() => resolveAuthConfig(entraEnv({ MUNINN_ADMIN_IDENTS: undefined })))
      .toThrow(/MUNINN_ADMIN_IDENTS/);
    expect(() => resolveAuthConfig(entraEnv({ MUNINN_ALLOWED_ORIGINS: undefined })))
      .toThrow(/MUNINN_ALLOWED_ORIGINS/);
  });

  test("an authenticating mode with no MUNINN_ADMIN_IDENTS refuses", () => {
    expect(() => resolveAuthConfig(localEnv({ MUNINN_ADMIN_IDENTS: undefined })))
      .toThrow(/MUNINN_ADMIN_IDENTS/);
    expect(() => resolveAuthConfig(localEnv({ MUNINN_ADMIN_IDENTS: " , ," })))
      .toThrow(/MUNINN_ADMIN_IDENTS/);
  });

  test("an authenticating mode with no MUNINN_ALLOWED_ORIGINS refuses", () => {
    expect(() => resolveAuthConfig(localEnv({ MUNINN_ALLOWED_ORIGINS: undefined })))
      .toThrow(/MUNINN_ALLOWED_ORIGINS/);
  });

  test("a wildcard origin is not a configured origin — it reaches the refusal as empty", () => {
    expect(() => resolveAuthConfig(localEnv({ MUNINN_ALLOWED_ORIGINS: "*" })))
      .toThrow(/MUNINN_ALLOWED_ORIGINS/);
  });

  test("local mode without its secret or its pinned user refuses", () => {
    expect(() => resolveAuthConfig(localEnv({ MUNINN_LOCAL_TOKEN: undefined })))
      .toThrow(/MUNINN_LOCAL_TOKEN/);
    expect(() => resolveAuthConfig(localEnv({ MUNINN_LOCAL_USER: undefined })))
      .toThrow(/MUNINN_LOCAL_USER/);
  });

  test("a short shared secret refuses rather than booting a guessable instance", () => {
    expect(() => resolveAuthConfig(localEnv({ MUNINN_LOCAL_TOKEN: "hunter2" })))
      .toThrow(new RegExp(`at least ${LOCAL_TOKEN_MIN_LENGTH}`));
  });
});

describe("acceptance 6 — off is off", () => {
  test("a bare env resolves to off, with nothing else required", () => {
    const config = resolveAuthConfig({});
    expect(config.mode).toBe("off");
    expect(config.local).toBeNull();
  });

  test("off does not require the config an authenticating mode does", () => {
    // No MUNINN_ADMIN_IDENTS, no origins, no secret — and it still boots. This
    // is what keeps today's muninn byte for byte unchanged.
    expect(() => resolveAuthConfig({ MUNINN_AUTH: "off" })).not.toThrow();
  });
});

describe("the resolved local config", () => {
  test("carries the pinned identity and the normalised lists", () => {
    const config = resolveAuthConfig(
      localEnv({ MUNINN_ADMIN_IDENTS: " A123456 , a123456 ,B999999", MUNINN_LOCAL_NAME: "Rune" }),
    );
    expect(config.local).toEqual({
      token: "a-sufficiently-long-secret",
      userId: "rune",
      displayName: "Rune",
    });
    expect(config.adminIdents).toEqual(["a123456", "b999999"]);
    expect(config.allowedOrigins).toEqual(["https://muninn-host.example-tailnet.ts.net"]);
  });

  test("displayName falls back to the pinned userId", () => {
    expect(resolveAuthConfig(localEnv()).local?.displayName).toBe("rune");
  });
});

describe("MUNINN_LOCAL_ROLE", () => {
  test("defaults to `user` over a FULL local env with the variable absent", () => {
    // Over `localEnv()`, not `{}`: an empty env returns at mode `off` before
    // the local branch is reached, so the "default" it would prove is the
    // constant in the off branch rather than the parse.
    expect(resolveAuthConfig(localEnv()).localRole).toBe("user");
  });

  test("`admin` is honoured, case-insensitively and with whitespace", () => {
    expect(resolveAuthConfig(localEnv({ MUNINN_LOCAL_ROLE: "admin" })).localRole).toBe("admin");
    expect(resolveAuthConfig(localEnv({ MUNINN_LOCAL_ROLE: " ADMIN " })).localRole).toBe("admin");
    expect(resolveAuthConfig(localEnv({ MUNINN_LOCAL_ROLE: "user" })).localRole).toBe("user");
  });

  test("an unrecognised value throws — a typo must not degrade to a silent lockout", () => {
    expect(() => resolveAuthConfig(localEnv({ MUNINN_LOCAL_ROLE: "operator" }))).toThrow(AuthConfigError);
    expect(() => resolveAuthConfig(localEnv({ MUNINN_LOCAL_ROLE: "operator" }))).toThrow(/not a role/);
  });

  test("it is INERT outside `local` mode", () => {
    // Auth off: no identity is resolved at all, so a stale line in `.env`
    // grants nothing. (The `entra` branch cannot be reached while
    // AUTH_ZONES_IMPLEMENTED is false, and its role source is the allowlist.)
    expect(resolveAuthConfig({ MUNINN_LOCAL_ROLE: "admin" }).localRole).toBe("user");
    expect(resolveAuthConfig({ MUNINN_AUTH: "off", MUNINN_LOCAL_ROLE: "admin" }).localRole).toBe("user");
  });
});

test("the excluded-path list is the two health endpoints and nothing else", () => {
  // An entry here is a route reachable with NO credential on an authenticating
  // instance, so the list being short is the property. It was empty until the
  // zone model landed; `/api/live` and `/api/ready` are what a platform probe
  // needs and are the reason the open zone exists. Anything else added here
  // must be justified the same way — which is why this is a constant rather
  // than an env var, and why this test names the members rather than counting.
  expect([...AUTH_EXCLUDED_PATHS].sort()).toEqual(["/api/live", "/api/ready"]);
});

describe("MUNINN_LOCAL_USER and the report/spec path segment", () => {
  const base = {
    MUNINN_AUTH: "local",
    MUNINN_LOCAL_TOKEN: "a-sufficiently-long-secret",
    MUNINN_ADMIN_IDENTS: "A123456",
    MUNINN_ALLOWED_ORIGINS: "https://host.example",
  };

  test("a filesystem-hostile pinned id still BOOTS — it is valid everywhere else", () => {
    // A refusal would be wrong: `rune@example.com` is a perfectly good
    // `users.id`. Only `/chat/reports/*` and `/chat/specs/*` reject it, because
    // PR C substitutes the session id into a file path where the pre-existing
    // VALID_USER_ID then runs. The operator gets a warning, not a dead instance.
    const config = resolveAuthConfig({ ...base, MUNINN_LOCAL_USER: "rune@example.com" });
    expect(config.local?.userId).toBe("rune@example.com");
  });

  test("an ordinary pinned id is unaffected", () => {
    expect(resolveAuthConfig({ ...base, MUNINN_LOCAL_USER: "rune_lind-1" }).local?.userId).toBe("rune_lind-1");
  });
});
