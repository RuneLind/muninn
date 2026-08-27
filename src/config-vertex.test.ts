/**
 * The Vertex credential seam — `resolveVertexConfig` and the one consumer whose
 * behaviour it CHANGES, `assertHaveAuth`.
 *
 * `assertHaveAuth` is tested against the real function, not a mock of it. That
 * is the point: the defect this seam fixes was a guard that read the wrong
 * variable, and a test that stubbed the resolver would have passed over exactly
 * that. The env is mutated on `process.env` here for the same reason —
 * `assertHaveAuth()` takes no arguments, so a test that passed a record would be
 * testing a signature the connector does not call.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { resolveVertexConfig } from "./config.ts";
import { assertHaveAuth } from "./ai/connectors/claude-sdk.ts";

const OWNED = [
  "CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_VERTEX_PROJECT_ID", "ANTHROPIC_VERTEX_BASE_URL",
  "CLOUD_ML_REGION", "VERTEX_PROJECT_ID", "VERTEX_REGION",
  "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN",
];

describe("resolveVertexConfig", () => {
  test("unset ⇒ nothing declared, nothing refused", () => {
    const v = resolveVertexConfig({});
    expect(v).toEqual({
      enabled: false, projectId: null, projectIdSource: null,
      region: null, regionSource: null, baseUrl: null,
    });
  });

  test("muninn's own names are read, and named as the source", () => {
    const v = resolveVertexConfig({ VERTEX_PROJECT_ID: "p-1", VERTEX_REGION: "europe-north1" });
    expect(v.projectId).toBe("p-1");
    expect(v.projectIdSource).toBe("VERTEX_PROJECT_ID");
    expect(v.region).toBe("europe-north1");
    expect(v.regionSource).toBe("VERTEX_REGION");
    // Declaring them does NOT move a bot onto Vertex.
    expect(v.enabled).toBe(false);
  });

  test("the SDK's names WIN over muninn's, because the SDK is what reads them", () => {
    const v = resolveVertexConfig({
      VERTEX_PROJECT_ID: "muninn-name", VERTEX_REGION: "europe-north1",
      ANTHROPIC_VERTEX_PROJECT_ID: "sdk-name", CLOUD_ML_REGION: "europe-west1",
    });
    expect(v.projectId).toBe("sdk-name");
    expect(v.projectIdSource).toBe("ANTHROPIC_VERTEX_PROJECT_ID");
    expect(v.region).toBe("europe-west1");
    expect(v.regionSource).toBe("CLOUD_ML_REGION");
  });

  test("`enabled` keys on CLAUDE_CODE_USE_VERTEX and nothing else", () => {
    const complete = { VERTEX_PROJECT_ID: "p", VERTEX_REGION: "europe-north1" };
    expect(resolveVertexConfig({ ...complete, CLAUDE_CODE_USE_VERTEX: "1" }).enabled).toBe(true);
    expect(resolveVertexConfig({ ...complete, CLAUDE_CODE_USE_VERTEX: "true" }).enabled).toBe(true);
    // Any other non-empty spelling is ON too: erring toward "the SDK took the
    // Vertex path" keeps the missing-project/region refusals reachable, and both
    // directions of a wrong guess here are LOUD — this one throws at boot, the
    // other lets the SDK report its own credential error.
    expect(resolveVertexConfig({ ...complete, CLAUDE_CODE_USE_VERTEX: "yes" }).enabled).toBe(true);
    for (const off of ["0", "false", "no", "off", "", "  "]) {
      expect(resolveVertexConfig({ ...complete, CLAUDE_CODE_USE_VERTEX: off }).enabled).toBe(false);
    }
    // And the switch alone, with a complete declaration absent, is not enough to
    // call it configured — it refuses instead.
    expect(() => resolveVertexConfig({ CLAUDE_CODE_USE_VERTEX: "1" })).toThrow();
  });

  describe("refusals", () => {
    test("`global` is refused in EITHER region name, even with Vertex off", () => {
      // Off, because a forbidden value waiting in `.env` for someone to flip the
      // switch is the misconfiguration that arrives with no signal at all.
      expect(() => resolveVertexConfig({ VERTEX_REGION: "global" })).toThrow(/VERTEX_REGION="global" is refused/);
      expect(() => resolveVertexConfig({ CLOUD_ML_REGION: "global" })).toThrow(/CLOUD_ML_REGION="global" is refused/);
      expect(() => resolveVertexConfig({ CLOUD_ML_REGION: " GLOBAL " })).toThrow(/is refused/);
    });

    test("the refusal cites the føring, so the message survives without the plan", () => {
      expect(() => resolveVertexConfig({ VERTEX_REGION: "global" }))
        .toThrow(/ikke innsikt i hvor data blir prosessert/);
    });

    test("an EU region — including the multi-region `eu` — is NOT refused", () => {
      for (const region of ["europe-north1", "europe-west1", "europe-west4", "eu"]) {
        expect(resolveVertexConfig({ VERTEX_REGION: region }).region).toBe(region);
      }
    });

    test("the GLOBAL HOST is refused through the base-URL door", () => {
      // The door the region check cannot see: ANTHROPIC_VERTEX_BASE_URL steers
      // the SDK past CLOUD_ML_REGION entirely, so a guard on the region NAME
      // alone would be inert here.
      expect(() => resolveVertexConfig({ ANTHROPIC_VERTEX_BASE_URL: "https://aiplatform.googleapis.com" }))
        .toThrow(/GLOBAL Vertex endpoint/);
      expect(() => resolveVertexConfig({ ANTHROPIC_VERTEX_BASE_URL: "https://AIPLATFORM.googleapis.com/v1" }))
        .toThrow(/GLOBAL Vertex endpoint/);
    });

    test("regional and EU multi-region hosts pass the base-URL check", () => {
      for (const url of [
        "https://europe-north1-aiplatform.googleapis.com",
        "https://aiplatform.eu.rep.googleapis.com",
      ]) {
        expect(resolveVertexConfig({ ANTHROPIC_VERTEX_BASE_URL: url }).baseUrl).toBe(url);
      }
    });

    test("a non-URL base URL is refused rather than silently ignored", () => {
      expect(() => resolveVertexConfig({ ANTHROPIC_VERTEX_BASE_URL: "europe-north1-aiplatform.googleapis.com" }))
        .toThrow(/is not a URL/);
    });

    test("enabled with no project, and enabled with no region, refuse — naming the SDK's variable", () => {
      expect(() => resolveVertexConfig({ CLAUDE_CODE_USE_VERTEX: "1" }))
        .toThrow(/no Vertex project is: set ANTHROPIC_VERTEX_PROJECT_ID/);
      expect(() => resolveVertexConfig({ CLAUDE_CODE_USE_VERTEX: "1", VERTEX_PROJECT_ID: "p" }))
        .toThrow(/no Vertex region is: set CLOUD_ML_REGION/);
    });

    test("a base URL satisfies the region requirement — a multi-region endpoint has no region name", () => {
      const v = resolveVertexConfig({
        CLAUDE_CODE_USE_VERTEX: "1", VERTEX_PROJECT_ID: "p",
        ANTHROPIC_VERTEX_BASE_URL: "https://aiplatform.eu.rep.googleapis.com",
      });
      expect(v.enabled).toBe(true);
      expect(v.region).toBeNull();
    });

    test("those two refuse ONLY when enabled — an incomplete declaration is not yet wrong", () => {
      expect(() => resolveVertexConfig({ VERTEX_REGION: "europe-north1" })).not.toThrow();
      expect(() => resolveVertexConfig({ VERTEX_PROJECT_ID: "p" })).not.toThrow();
    });
  });
});

describe("assertHaveAuth — the real function, over the real env", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const name of OWNED) { saved[name] = process.env[name]; delete process.env[name]; }
  });
  afterEach(() => {
    for (const name of OWNED) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name]!;
    }
  });

  test("no credential at all still throws, and the message now names all three", () => {
    expect(() => assertHaveAuth()).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => assertHaveAuth()).toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
    expect(() => assertHaveAuth()).toThrow(/CLAUDE_CODE_USE_VERTEX/);
  });

  test("an Anthropic credential passes, as before", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(() => assertHaveAuth()).not.toThrow();
  });

  test("VERTEX PASSES WITH NO ANTHROPIC CREDENTIAL — the defect this fixes", () => {
    // Measured in scripts/smoke-vertex.ts probe C: the SDK reports
    // `apiKeySource: "none"` here and reaches Vertex on ADC. The old assert
    // threw before it ever got there.
    process.env.CLAUDE_CODE_USE_VERTEX = "1";
    process.env.ANTHROPIC_VERTEX_PROJECT_ID = "some-project";
    process.env.CLOUD_ML_REGION = "europe-north1";
    expect(() => assertHaveAuth()).not.toThrow();
  });

  test("muninn's own VERTEX_PROJECT_ID/REGION satisfy it too", () => {
    process.env.CLAUDE_CODE_USE_VERTEX = "1";
    process.env.VERTEX_PROJECT_ID = "some-project";
    process.env.VERTEX_REGION = "europe-north1";
    expect(() => assertHaveAuth()).not.toThrow();
  });

  test("the waiver is NOT granted by declaring a project — only the SDK's switch grants it", () => {
    // Otherwise a bot with a Vertex project declared but the switch off would
    // skip the credential check and fail inside the SDK instead.
    process.env.VERTEX_PROJECT_ID = "some-project";
    process.env.VERTEX_REGION = "europe-north1";
    expect(() => assertHaveAuth()).toThrow(/no credential/);
  });

  test("a HALF-configured Vertex fails here, with the missing name, not later in the SDK", () => {
    process.env.CLAUDE_CODE_USE_VERTEX = "1";
    expect(() => assertHaveAuth()).toThrow(/no Vertex project is/);
  });

  test("a `global` region is refused even when an Anthropic key would have passed", () => {
    // ⚠️ It is NOT: `hasHaikuDirectAuth()` returns first. The refusal that
    // matters lives at BOOT (`loadConfig` → `resolveVertexConfig`), and this
    // case pins that assertHaveAuth is not a second, weaker gate pretending to
    // be one.
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.VERTEX_REGION = "global";
    expect(() => assertHaveAuth()).not.toThrow();
    expect(() => resolveVertexConfig()).toThrow(/is refused/);
  });
});
