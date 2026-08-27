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
  "VERTEX_REGION_CLAUDE_4_5_SONNET",
  "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN",
];

describe("resolveVertexConfig", () => {
  test("unset ⇒ nothing declared, nothing refused", () => {
    const v = resolveVertexConfig({});
    expect(v).toEqual({
      enabled: false, projectId: null, projectIdSource: null,
      region: null, regionSource: null, baseUrl: null, perModelRegions: [],
    });
  });

  test("muninn's own names are read while Vertex is OFF, and named as the source", () => {
    const v = resolveVertexConfig({ VERTEX_PROJECT_ID: "p-1", VERTEX_REGION: "europe-north1" });
    expect(v.projectId).toBe("p-1");
    expect(v.projectIdSource).toBe("VERTEX_PROJECT_ID");
    expect(v.region).toBe("europe-north1");
    expect(v.regionSource).toBe("VERTEX_REGION");
    // Declaring them does NOT move a bot onto Vertex.
    expect(v.enabled).toBe(false);
  });

  test("the SDK's names are the source when both are set and AGREE", () => {
    const v = resolveVertexConfig({
      VERTEX_PROJECT_ID: "same-p", ANTHROPIC_VERTEX_PROJECT_ID: "same-p",
      VERTEX_REGION: "europe-west1", CLOUD_ML_REGION: "europe-west1",
    });
    expect(v.projectIdSource).toBe("ANTHROPIC_VERTEX_PROJECT_ID");
    expect(v.regionSource).toBe("CLOUD_ML_REGION");
  });

  test("the two names DISAGREEING refuses, rather than silently picking one", () => {
    // The old rule let the SDK's name win quietly, which made the other name
    // dead config that still looked configured on /models.
    expect(() => resolveVertexConfig({ VERTEX_PROJECT_ID: "a", ANTHROPIC_VERTEX_PROJECT_ID: "b" }))
      .toThrow(/disagree.*dead config/s);
    expect(() => resolveVertexConfig({ VERTEX_REGION: "europe-north1", CLOUD_ML_REGION: "europe-west1" }))
      .toThrow(/disagree.*dead config/s);
  });

  test("`enabled` uses the SDK's OWN ALLOWLIST, so the two can never disagree", () => {
    const complete = { ANTHROPIC_VERTEX_PROJECT_ID: "p", CLOUD_ML_REGION: "europe-north1" };
    // The four spellings the bundled binary accepts:
    //   ["1","true","yes","on"].includes(value.toLowerCase())
    for (const on of ["1", "true", "yes", "on", "TRUE", " On "]) {
      expect(resolveVertexConfig({ ...complete, CLAUDE_CODE_USE_VERTEX: on }).enabled).toBe(true);
    }
    // ⚠️ The regression this pins. An inverted DENYLIST ("anything not 0/false/
    // no/off is on") called these ON while the SDK called them OFF and took the
    // FIRST-PARTY path — so `assertHaveAuth()` waived the Anthropic credential
    // for a turn that then needed one.
    for (const off of ["y", "2", "enabled", "vertex", "0", "false", "no", "off", "", "  "]) {
      expect(resolveVertexConfig({ ...complete, CLAUDE_CODE_USE_VERTEX: off }).enabled).toBe(false);
    }
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

    test("`global` is refused in a PER-MODEL region override — the door that made the guard inert", () => {
      // ⚠️ The critical one. The SDK resolves a region by finding the first
      // entry of its model→env map whose key prefixes the model id and reading
      // THAT variable, falling back to CLOUD_ML_REGION only when none matches.
      // So this beats a perfectly good CLOUD_ML_REGION, and the resulting host
      // is the global endpoint — while /models reported europe-north1.
      expect(() => resolveVertexConfig({
        CLOUD_ML_REGION: "europe-north1",
        VERTEX_REGION_CLAUDE_4_5_SONNET: "global",
      })).toThrow(/VERTEX_REGION_CLAUDE_4_5_SONNET="global" is refused/);
    });

    test("the per-model prefix is matched by PREFIX, so a model added next year is covered", () => {
      // Not a hard-coded list of the twelve the installed binary carries: that
      // list grows, and a stale copy would be short by exactly the new one.
      for (const name of ["VERTEX_REGION_CLAUDE_9_9_SONNET", "VERTEX_REGION_CLAUDE_FUTURE"]) {
        expect(() => resolveVertexConfig({ [name]: "global" })).toThrow(new RegExp(`${name}="global"`));
      }
    });

    test("a NON-global per-model override is kept and REPORTED, not silently dropped", () => {
      const v = resolveVertexConfig({
        CLOUD_ML_REGION: "europe-north1",
        VERTEX_REGION_CLAUDE_4_5_SONNET: "europe-west1",
      });
      // It beats CLOUD_ML_REGION for that model, so a card showing only the
      // region would be telling the operator something untrue.
      expect(v.perModelRegions).toEqual([{ name: "VERTEX_REGION_CLAUDE_4_5_SONNET", region: "europe-west1" }]);
    });

    test("the GLOBAL HOST is refused through the base-URL door", () => {
      // The door the region check cannot see: ANTHROPIC_VERTEX_BASE_URL steers
      // the SDK past CLOUD_ML_REGION entirely, so a guard on the region NAME
      // alone would be inert here.
      expect(() => resolveVertexConfig({ ANTHROPIC_VERTEX_BASE_URL: "https://aiplatform.googleapis.com" }))
        .toThrow(/GLOBAL Vertex endpoint/);
      expect(() => resolveVertexConfig({ ANTHROPIC_VERTEX_BASE_URL: "https://AIPLATFORM.googleapis.com/v1" }))
        .toThrow(/GLOBAL Vertex endpoint/);
      // A trailing dot is the same DNS name; a bare string compare let it past.
      expect(() => resolveVertexConfig({ ANTHROPIC_VERTEX_BASE_URL: "https://aiplatform.googleapis.com./v1" }))
        .toThrow(/GLOBAL Vertex endpoint/);
      expect(() => resolveVertexConfig({ ANTHROPIC_VERTEX_BASE_URL: "https://aiplatform.googleapis.com:443" }))
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

    test("enabled demands the SDK's OWN names — muninn's do not satisfy them", () => {
      expect(() => resolveVertexConfig({ CLAUDE_CODE_USE_VERTEX: "1" }))
        .toThrow(/ANTHROPIC_VERTEX_PROJECT_ID is not set/);
      // ⚠️ The regression this pins: VERTEX_PROJECT_ID used to satisfy it, and
      // the SDK — which never reads that name — then fell back to whatever
      // project ADC resolves to. A different project, silently, with no signal.
      expect(() => resolveVertexConfig({ CLAUDE_CODE_USE_VERTEX: "1", VERTEX_PROJECT_ID: "p" }))
        .toThrow(/ANTHROPIC_VERTEX_PROJECT_ID is not set/);
      expect(() => resolveVertexConfig({ CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_VERTEX_PROJECT_ID: "p" }))
        .toThrow(/CLOUD_ML_REGION is not set/);
      expect(() => resolveVertexConfig({
        CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_VERTEX_PROJECT_ID: "p", VERTEX_REGION: "eu",
      })).toThrow(/CLOUD_ML_REGION is not set/);
    });

    test("a base URL does NOT satisfy the region requirement — the SDK's default is us-east5", () => {
      // ⚠️ The other regression. Accepting a base URL alone certified an
      // EU-multi-region config whose every request said `locations/us-east5`,
      // because the SDK builds the resource path from the region regardless.
      expect(() => resolveVertexConfig({
        CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_VERTEX_PROJECT_ID: "p",
        ANTHROPIC_VERTEX_BASE_URL: "https://aiplatform.eu.rep.googleapis.com",
      })).toThrow(/us-east5/);
    });

    test("the EU multi-region endpoint, configured correctly, passes", () => {
      const v = resolveVertexConfig({
        CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_VERTEX_PROJECT_ID: "p",
        CLOUD_ML_REGION: "eu", ANTHROPIC_VERTEX_BASE_URL: "https://aiplatform.eu.rep.googleapis.com",
      });
      expect(v.enabled).toBe(true);
      expect(v.region).toBe("eu");
      expect(v.baseUrl).toBe("https://aiplatform.eu.rep.googleapis.com");
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

  test("muninn's own names do NOT satisfy it — the SDK never reads them", () => {
    process.env.CLAUDE_CODE_USE_VERTEX = "1";
    process.env.VERTEX_PROJECT_ID = "some-project";
    process.env.VERTEX_REGION = "europe-north1";
    expect(() => assertHaveAuth()).toThrow(/ANTHROPIC_VERTEX_PROJECT_ID is not set/);
  });

  test("a spelling the SDK reads as OFF is OFF here too, so the waiver cannot outrun it", () => {
    process.env.CLAUDE_CODE_USE_VERTEX = "y";
    process.env.ANTHROPIC_VERTEX_PROJECT_ID = "some-project";
    process.env.CLOUD_ML_REGION = "europe-north1";
    expect(() => assertHaveAuth()).toThrow(/no credential/);
  });

  test("a `global` PER-MODEL override refuses even on an otherwise valid Vertex config", () => {
    process.env.CLAUDE_CODE_USE_VERTEX = "1";
    process.env.ANTHROPIC_VERTEX_PROJECT_ID = "some-project";
    process.env.CLOUD_ML_REGION = "europe-north1";
    process.env.VERTEX_REGION_CLAUDE_4_5_SONNET = "global";
    expect(() => assertHaveAuth()).toThrow(/VERTEX_REGION_CLAUDE_4_5_SONNET="global" is refused/);
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
    expect(() => assertHaveAuth()).toThrow(/ANTHROPIC_VERTEX_PROJECT_ID is not set/);
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
