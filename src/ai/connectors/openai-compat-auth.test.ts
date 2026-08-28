import { afterEach, describe, expect, test } from "bun:test";
import { createAuthorizer } from "./openai-compat-auth.ts";
import { OpenAiCompatHttpError } from "./openai-compat-stream.ts";
import { VertexTokenProvider, type VertexAccessToken } from "../vertex-access.ts";

const VERTEX_URL = "https://europe-north1-aiplatform.googleapis.com/v1/projects/p/locations/europe-north1/endpoints/openapi";
const LOCAL_URL = "http://localhost:11434/v1";

const previousKey = process.env.OPENAI_API_KEY;
afterEach(() => {
  if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousKey;
});

/** A provider whose token CHANGES on every fetch, so "did the retry use a new
 *  credential?" is answerable from the headers rather than from a spy count. */
function countingProvider() {
  let issued = 0;
  const provider = new VertexTokenProvider(async (): Promise<VertexAccessToken> => {
    issued++;
    return { token: `t${issued}`, expiresAtMs: Date.now() + 3_600_000, source: "gcloud-adc" };
  });
  return { provider, issued: () => issued };
}

describe("static-key authorizer", () => {
  test("sends OPENAI_API_KEY when set, and nothing when not", async () => {
    process.env.OPENAI_API_KEY = "sk-local";
    expect((await createAuthorizer(LOCAL_URL, "bot").headers()).Authorization).toBe("Bearer sk-local");
    delete process.env.OPENAI_API_KEY;
    expect((await createAuthorizer(LOCAL_URL, "bot").headers()).Authorization).toBeUndefined();
  });

  test("reads the key per request, so a rotation lands on the next turn", async () => {
    const auth = createAuthorizer(LOCAL_URL, "bot");
    process.env.OPENAI_API_KEY = "sk-first";
    expect((await auth.headers()).Authorization).toBe("Bearer sk-first");
    process.env.OPENAI_API_KEY = "sk-second";
    expect((await auth.headers()).Authorization).toBe("Bearer sk-second");
  });

  test("never asks for a retry — a 401 from a static key is a wrong key", () => {
    const auth = createAuthorizer(LOCAL_URL, "bot");
    expect(auth.refreshAfterFailure(new OpenAiCompatHttpError(401, "nope"))).toBe(false);
  });
});

describe("vertex authorizer", () => {
  test("carries an ADC bearer token, cached across requests", async () => {
    const { provider, issued } = countingProvider();
    const auth = createAuthorizer(VERTEX_URL, "bot", provider);
    expect((await auth.headers()).Authorization).toBe("Bearer t1");
    expect((await auth.headers()).Authorization).toBe("Bearer t1");
    expect(issued()).toBe(1);
  });

  test("does NOT send x-goog-user-project (measured: the project-scoped endpoint does not need it)", async () => {
    const { provider } = countingProvider();
    expect(await createAuthorizer(VERTEX_URL, "bot", provider).headers())
      .toEqual({ "Content-Type": "application/json", Authorization: "Bearer t1" });
  });

  test("a 401 drops the cached token, so the retry carries a FRESH one", async () => {
    const { provider, issued } = countingProvider();
    const auth = createAuthorizer(VERTEX_URL, "bot", provider);
    expect((await auth.headers()).Authorization).toBe("Bearer t1");
    expect(auth.refreshAfterFailure(new OpenAiCompatHttpError(401, "UNAUTHENTICATED"))).toBe(true);
    expect((await auth.headers()).Authorization).toBe("Bearer t2");
    expect(issued()).toBe(2);
  });

  test("a 403 is NOT retried and keeps the token — the credential is valid, the identity is not entitled", async () => {
    const { provider, issued } = countingProvider();
    const auth = createAuthorizer(VERTEX_URL, "bot", provider);
    await auth.headers();
    expect(auth.refreshAfterFailure(new OpenAiCompatHttpError(403, "PERMISSION_DENIED"))).toBe(false);
    expect((await auth.headers()).Authorization).toBe("Bearer t1");
    expect(issued()).toBe(1);
  });

  test("non-HTTP failures (timeouts, transport) are not credential failures", async () => {
    const { provider } = countingProvider();
    const auth = createAuthorizer(VERTEX_URL, "bot", provider);
    expect(auth.refreshAfterFailure(new Error("request timed out after 120000ms"))).toBe(false);
    expect(auth.refreshAfterFailure(new OpenAiCompatHttpError(500, "backend error"))).toBe(false);
  });

  test("ignores OPENAI_API_KEY entirely — a static key against Vertex is a guaranteed 401", async () => {
    process.env.OPENAI_API_KEY = "sk-would-be-wrong";
    const { provider } = countingProvider();
    expect((await createAuthorizer(VERTEX_URL, "bot", provider).headers()).Authorization).toBe("Bearer t1");
  });

  test("refuses a `global` endpoint at construction, before any request", () => {
    const { provider, issued } = countingProvider();
    expect(() => createAuthorizer(
      "https://europe-north1-aiplatform.googleapis.com/v1/projects/p/locations/global/endpoints/openapi",
      "bot", provider,
    )).toThrow(/global/);
    expect(issued()).toBe(0);
  });
});
