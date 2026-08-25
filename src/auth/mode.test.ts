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

  // The boundary this whole pass depends on.
  test("entra refuses to boot while AUTH_ZONES_IMPLEMENTED is false", () => {
    expect(AUTH_ZONES_IMPLEMENTED).toBe(false);
    expect(() => resolveAuthConfig({ MUNINN_AUTH: "entra" })).toThrow(/zone model/);
  });

  test("the entra refusal fires even when every other variable is set", () => {
    // The ordering assertion. A fully-configured deployment must still be told
    // the zone model is the reason — not be waved through by completeness.
    expect(() =>
      resolveAuthConfig({
        MUNINN_AUTH: "entra",
        NAIS_CLUSTER_NAME: "prod-gcp",
        NAIS_TOKEN_INTROSPECTION_ENDPOINT: "http://texas/introspect",
        MUNINN_TENANT: "nav.no",
        MUNINN_ADMIN_IDENTS: "A123456",
        MUNINN_ALLOWED_ORIGINS: "https://muninn.intern.nav.no",
      }),
    ).toThrow(/zone model/);
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

test("the excluded-path list is empty in this PR", () => {
  // Exclusion and zone are the same axis; an entry here would keep a route
  // reachable with no token whatever the deferred zone model decides.
  expect(AUTH_EXCLUDED_PATHS).toEqual([]);
});
