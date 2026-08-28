import { afterEach, describe, expect, mock, test } from "bun:test";

// The scheduler executor: `trackUsage` must not reach for Postgres, and
// `spawnHaiku` must not spawn a Claude CLI when a fallback case exercises the
// router's floor. This is why the file needs its OWN `bun test` link —
// `mock.module` invalidates the target for the whole process graph, and a
// module already loaded through another importer keeps its original binding
// (measured: the dispatch cases below, written in `haiku-direct.test.ts`, ran
// the REAL backend inside that file's chunk and passed or failed by luck).
const spawnCalls: Array<{ prompt: string; opts: any }> = [];
const usageCalls: Array<{ source: string; model: string; inputTokens: number; outputTokens: number; botName?: string; traceId?: string }> = [];
mock.module("../scheduler/executor.ts", () => ({
  HAIKU_TIMEOUT_MS: 60_000,
  HAIKU_DEFAULT_MAX_TOKENS: 4096,
  DEFAULT_MODEL: "claude-haiku-4-5-20251001",
  trackUsage: (source: string, model: string, inputTokens: number, outputTokens: number, botName?: string, traceId?: string) => {
    usageCalls.push({ source, model, inputTokens, outputTokens, botName, traceId });
  },
  spawnHaiku: async (prompt: string, opts: unknown) => {
    spawnCalls.push({ prompt, opts });
    return { result: "cli-fallback", inputTokens: 1, outputTokens: 2, model: "claude-haiku-4-5-20251001", backend: "cli" };
  },
}));

const { callHaikuViaVertex, resolveVertexHaikuTarget, vertexOpenAiBaseUrl, DEFAULT_VERTEX_HAIKU_MODEL } =
  await import("./haiku-vertex.ts");
const { OpenAiCompatHttpError } = await import("./connectors/openai-compat-stream.ts");
const { callHaikuWithFallback } = await import("./haiku-direct.ts");
const { VertexTokenProvider } = await import("./vertex-access.ts");
type VertexAccessToken = import("./vertex-access.ts").VertexAccessToken;

const ENV = { VERTEX_PROJECT_ID: "proj", VERTEX_REGION: "europe-north1" };

/** A provider whose token CHANGES on every fetch, so "did the retry carry a new
 *  credential?" is answerable from the request headers. */
function countingProvider() {
  let issued = 0;
  return new VertexTokenProvider(async (): Promise<VertexAccessToken> => {
    issued++;
    return { token: `t${issued}`, expiresAtMs: Date.now() + 3_600_000, source: "gcloud-adc" };
  });
}

interface Captured { url: string; headers: Record<string, string>; body: any }

/** Swap `globalThis.fetch` for a scripted sequence of responses and record what
 *  was sent. Restored in `afterEach`. */
function stubFetch(responses: Array<{ status: number; body: unknown }>): Captured[] {
  const sent: Captured[] = [];
  let i = 0;
  globalThis.fetch = (async (url: string, init: any) => {
    // The metadata server, answered rather than recorded. The router path has no
    // seam to inject a token provider through — it uses the process-wide one —
    // and letting that fall through to `gcloud` would make a unit test spawn a
    // subprocess and depend on a developer's login.
    if (String(url).includes("metadata.google.internal")) {
      return new Response(JSON.stringify({ access_token: "metadata-token", expires_in: 3600 }), { status: 200 });
    }
    sent.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return sent;
}

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; spawnCalls.length = 0; usageCalls.length = 0; });

const VERTEX_ENV_NAMES = ["VERTEX_PROJECT_ID", "VERTEX_REGION", "HAIKU_BACKEND"] as const;
const savedEnv = new Map<string, string | undefined>();
function setEnv(values: Record<string, string | undefined>): void {
  for (const name of VERTEX_ENV_NAMES) {
    if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
    const v = values[name];
    if (v === undefined) delete process.env[name];
    else process.env[name] = v;
  }
}
afterEach(() => {
  for (const [name, v] of savedEnv) { if (v === undefined) delete process.env[name]; else process.env[name] = v; }
  savedEnv.clear();
});

function completion(text: string, extra: Record<string, unknown> = {}) {
  return {
    choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
    model: "google/gemini-2.5-flash-lite",
    ...extra,
  };
}

describe("vertexOpenAiBaseUrl", () => {
  test("a REGION is a host prefix on the ordinary host", () => {
    expect(vertexOpenAiBaseUrl("proj", "europe-north1")).toBe(
      "https://europe-north1-aiplatform.googleapis.com/v1/projects/proj/locations/europe-north1/endpoints/openapi",
    );
  });

  // Measured 2026-08-28: `eu-aiplatform.googleapis.com` is not a name, while the
  // rep host reaches Vertex and is answered by the MODEL layer. Deriving the
  // prefix form for every location would build a URL that resolves nowhere.
  test("a MULTI-REGION has its own host and no prefix form", () => {
    expect(vertexOpenAiBaseUrl("proj", "eu")).toBe(
      "https://aiplatform.eu.rep.googleapis.com/v1/projects/proj/locations/eu/endpoints/openapi",
    );
  });
});

describe("resolveVertexHaikuTarget", () => {
  test("reads the same two names as the Agent SDK seam, SDK name first", () => {
    const r = resolveVertexHaikuTarget({
      ANTHROPIC_VERTEX_PROJECT_ID: "sdk-proj", VERTEX_PROJECT_ID: "muninn-proj",
      CLOUD_ML_REGION: "europe-north1", VERTEX_REGION: "europe-west4",
    });
    expect(r).toMatchObject({ ok: true, target: { project: "sdk-proj", region: "europe-north1" } });
  });

  test("falls back to muninn's own names", () => {
    const r = resolveVertexHaikuTarget(ENV);
    expect(r).toMatchObject({ ok: true, target: { project: "proj", region: "europe-north1" } });
  });

  // A complete phrase, not a bare variable name: the two call sites render it
  // into a sentence, and a name plus a hardcoded "is not set" told an operator
  // whose region was SET-but-malformed to go look for a variable that is right
  // there in their `.env`.
  test("says what is wrong, in a phrase both call sites can render", () => {
    expect(resolveVertexHaikuTarget({ VERTEX_REGION: "europe-north1" }))
      .toEqual({ ok: false, reason: "ANTHROPIC_VERTEX_PROJECT_ID / VERTEX_PROJECT_ID is not set" });
    expect(resolveVertexHaikuTarget({ VERTEX_PROJECT_ID: "proj" }))
      .toEqual({ ok: false, reason: "CLOUD_ML_REGION / VERTEX_REGION is not set" });
  });

  // A blank line in `.env` is "unset", not "set to nothing": without the trim a
  // whitespace value builds `…/projects/ /locations/…`, which 404s per request
  // instead of being refused once with the variable's name.
  test("a whitespace-only value is unset", () => {
    expect(resolveVertexHaikuTarget({ VERTEX_PROJECT_ID: "  ", VERTEX_REGION: "europe-north1" }))
      .toEqual({ ok: false, reason: "ANTHROPIC_VERTEX_PROJECT_ID / VERTEX_PROJECT_ID is not set" });
  });

  // A region is interpolated straight into a HOSTNAME. A value carrying a dot
  // builds `aiplatform.eu.west.rep.googleapis.com`, which `isVertexEndpoint`
  // does NOT match — so `createAuthorizer` would hand the request to the
  // static-key path and send `Authorization: Bearer $OPENAI_API_KEY` to Google,
  // with the `global` refusal never reached either (it early-returns on a
  // non-Vertex host). Refuse the value here instead, where the operator is
  // named the variable.
  test("a region that is not a plain label is refused, not interpolated", () => {
    for (const region of ["eu.west", "europe north1", "eu/west", "EU_WEST", "eu@west"]) {
      const r = resolveVertexHaikuTarget({ VERTEX_PROJECT_ID: "proj", VERTEX_REGION: region });
      expect(r.ok).toBe(false);
      // The refusal names the variable AND says the value is the problem — the
      // operator whose region is set-but-wrong must not be told it is unset.
      expect(r.ok === false && r.reason).toMatch(/VERTEX_REGION/);
      expect(r.ok === false && r.reason).not.toMatch(/is not set/);
      // The RAW value, not the normalized one: quoting `europe_north1` back at
      // an operator who wrote `Europe_North1` is the same class of misdirection
      // as telling them a set variable is unset.
      expect(r.ok === false && r.reason).toContain(`"${region}"`);
    }
    expect(resolveVertexHaikuTarget({ VERTEX_PROJECT_ID: "proj", VERTEX_REGION: "europe-north1" }).ok).toBe(true);
    expect(resolveVertexHaikuTarget({ VERTEX_PROJECT_ID: "proj", VERTEX_REGION: "eu" }).ok).toBe(true);
  });

  // `URL.hostname` lowercases an https host, so a mixed-case region WORKS on
  // this path today — and `resolveVertexConfig`, reading the same
  // `CLOUD_ML_REGION` for the Agent SDK, applies no case rule at all. Refusing
  // it here would mean one `.env` line puts claude-sdk on Vertex while the Haiku
  // router silently falls back to the CLI. Normalize instead of refusing.
  test("a mixed-case region is normalized, not refused", () => {
    const r = resolveVertexHaikuTarget({ VERTEX_PROJECT_ID: "proj", VERTEX_REGION: "EUROPE-NORTH1" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.target.region).toBe("europe-north1");
    expect(r.ok && r.target.baseUrl).toBe(
      "https://europe-north1-aiplatform.googleapis.com/v1/projects/proj/locations/europe-north1/endpoints/openapi",
    );
  });

  test("HAIKU_VERTEX_MODEL overrides the default model", () => {
    const r = resolveVertexHaikuTarget(ENV);
    expect(r.ok && r.target.model).toBe(DEFAULT_VERTEX_HAIKU_MODEL);
    const o = resolveVertexHaikuTarget({ ...ENV, HAIKU_VERTEX_MODEL: "google/gemini-2.5-flash" });
    expect(o.ok && o.target.model).toBe("google/gemini-2.5-flash");
  });

  // The publisher prefix is REQUIRED by the endpoint (400 without it), so the
  // shipped default must carry one — a default that cannot be called is worse
  // than none.
  test("the default model carries a publisher prefix", () => {
    expect(DEFAULT_VERTEX_HAIKU_MODEL).toMatch(/^[a-z0-9-]+\/.+/);
  });
});

describe("callHaikuViaVertex", () => {
  test("posts an OpenAI-shaped body to the region's openapi endpoint with an ADC token", async () => {
    const sent = stubFetch([{ status: 200, body: completion("hello") }]);
    const result = await callHaikuViaVertex("q", { source: "test", botName: "bot" },
      { env: ENV, provider: countingProvider() });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(
      "https://europe-north1-aiplatform.googleapis.com/v1/projects/proj/locations/europe-north1/endpoints/openapi/chat/completions",
    );
    expect(sent[0]!.headers.Authorization).toBe("Bearer t1");
    expect(sent[0]!.body).toMatchObject({
      model: DEFAULT_VERTEX_HAIKU_MODEL,
      messages: [{ role: "user", content: "q" }],
      max_tokens: 4096,
    });
    expect(result).toEqual({
      result: "hello", inputTokens: 11, outputTokens: 7,
      model: "google/gemini-2.5-flash-lite", backend: "vertex",
    });
  });

  test("a system prompt becomes a system message; without one there is no system message", async () => {
    const sent = stubFetch([{ status: 200, body: completion("ok") }]);
    await callHaikuViaVertex("q", { source: "test", system: "du er en bot" },
      { env: ENV, provider: countingProvider() });
    expect(sent[0]!.body.messages).toEqual([
      { role: "system", content: "du er en bot" },
      { role: "user", content: "q" },
    ]);
  });

  test("an explicit per-call model and maxTokens win over the env default", async () => {
    const sent = stubFetch([{ status: 200, body: completion("ok") }]);
    await callHaikuViaVertex("q", { source: "test", model: "google/gemini-2.5-flash", maxTokens: 64 },
      { env: { ...ENV, HAIKU_VERTEX_MODEL: "google/gemini-2.5-flash-lite" }, provider: countingProvider() });
    expect(sent[0]!.body).toMatchObject({ model: "google/gemini-2.5-flash", max_tokens: 64 });
  });

  // The trap this pins: the authorizer's stale-credential test matches on the
  // ERROR TYPE and its status. A plain `Error` here would leave the 401 retry
  // inert while every stubbed-fetch test still passed.
  test("a 401 is retried ONCE with a fresh token", async () => {
    const sent = stubFetch([
      { status: 401, body: { error: { message: "UNAUTHENTICATED" } } },
      { status: 200, body: completion("second time") },
    ]);
    const result = await callHaikuViaVertex("q", { source: "test" },
      { env: ENV, provider: countingProvider() });
    expect(sent.map((s) => s.headers.Authorization)).toEqual(["Bearer t1", "Bearer t2"]);
    expect(result.result).toBe("second time");
  });

  test("a 403 is NOT retried, and surfaces as a typed HTTP error", async () => {
    const sent = stubFetch([{ status: 403, body: { error: { message: "PERMISSION_DENIED" } } }]);
    const err = await callHaikuViaVertex("q", { source: "test" },
      { env: ENV, provider: countingProvider() }).catch((e) => e);
    expect(err).toBeInstanceOf(OpenAiCompatHttpError);
    expect((err as InstanceType<typeof OpenAiCompatHttpError>).status).toBe(403);
    expect(sent).toHaveLength(1);
  });

  test("refuses a `global` endpoint before any request", async () => {
    const sent = stubFetch([{ status: 200, body: completion("ok") }]);
    const err = await callHaikuViaVertex("q", { source: "test", botName: "bot" },
      { env: { VERTEX_PROJECT_ID: "proj", VERTEX_REGION: "global" }, provider: countingProvider() })
      .catch((e) => e);
    expect(String(err)).toMatch(/global/);
    expect(sent).toHaveLength(0);
  });

  test("an unconfigured target throws naming the variable, and sends nothing", async () => {
    const sent = stubFetch([{ status: 200, body: completion("ok") }]);
    const err = await callHaikuViaVertex("q", { source: "test" }, { env: {}, provider: countingProvider() })
      .catch((e) => e);
    expect(String(err)).toMatch(/VERTEX_PROJECT_ID/);
    expect(sent).toHaveLength(0);
  });

  // Gemini spends reasoning tokens from the SAME max_tokens budget, so a
  // truncated answer can carry no text at all — measured against the live
  // endpoint on flash with a small cap: finish_reason "length", 3 completion
  // tokens, 53 reasoning tokens, empty content. Returning that as a SUCCESS
  // defeats both fallbacks: the router only falls back on a throw, and
  // `callHaikuMessageWithFallback` only substitutes its fallback text on one
  // too — so a goal reminder would send an empty message to Telegram (400) and
  // never stamp `reminder_sent_at`, re-firing every tick.
  test("a text-less response THROWS, so the router falls back instead of answering nothing", async () => {
    stubFetch([{ status: 200, body: {
      choices: [{ message: { role: "assistant" }, finish_reason: "length" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 53 } },
      model: "google/gemini-2.5-flash",
    } }]);
    const err = await callHaikuViaVertex("q", { source: "test" },
      { env: ENV, provider: countingProvider() }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toMatch(/no text/i);
    // The diagnosis, not just the symptom: `length` says the budget ran out.
    expect(String(err)).toMatch(/length/);
  });

  // The tokens were spent whether or not text came back — a truncation that
  // burns the whole budget is exactly the row an operator needs to see, and it
  // is the one behavioural decision in the throw path that nothing else pins.
  test("the throw path still records the usage the call spent", async () => {
    stubFetch([{ status: 200, body: {
      choices: [{ message: { role: "assistant" }, finish_reason: "length" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 53 } },
      model: "google/gemini-2.5-flash",
    } }]);
    // The tracer too: without it the row is written with a NULL trace_id and
    // the truncation cannot be joined back to the request that caused it.
    await callHaikuViaVertex("q", { source: "test", botName: "bot", tracer: { traceId: "trace-1" } as never },
      { env: ENV, provider: countingProvider() }).catch(() => {});
    expect(usageCalls).toEqual([
      { source: "test", model: "google/gemini-2.5-flash", inputTokens: 5, outputTokens: 56, botName: "bot", traceId: "trace-1" },
    ]);
  });

  test("whitespace-only content counts as no text", async () => {
    stubFetch([{ status: 200, body: completion("   \n  ") }]);
    const err = await callHaikuViaVertex("q", { source: "test" },
      { env: ENV, provider: countingProvider() }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
  });

  // Measured against the live endpoint 2026-08-28: `total_tokens` 105 =
  // prompt 19 + completion 1 + reasoning 85, so `completion_tokens` EXCLUDES
  // reasoning and reasoning is billed output. Dropping it under-reports a
  // thinking model's spend by ~18× on a short answer — the same reason the
  // other two backends sum their cache-token fields into usage.
  test("reasoning tokens are billed output and are summed in", async () => {
    stubFetch([{ status: 200, body: {
      choices: [{ message: { content: "Blue" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 19, completion_tokens: 1, completion_tokens_details: { reasoning_tokens: 85 } },
      model: "google/gemini-2.5-flash",
    } }]);
    const result = await callHaikuViaVertex("q", { source: "test" },
      { env: ENV, provider: countingProvider() });
    expect(result).toMatchObject({ inputTokens: 19, outputTokens: 86 });
  });
});

// The ROUTER path, end to end: `callHaikuWithFallback` → the vertex backend →
// the shared authorizer → an HTTP request. Deliberately NOT mocking
// `./haiku-vertex.ts` — a stubbed dispatch would pass whether or not the router
// reaches this backend at all, which is the one thing these cases exist to say.
describe("callHaikuWithFallback → vertex", () => {
  test("dispatches to Vertex and reports the backend that actually ran", async () => {
    setEnv({ VERTEX_PROJECT_ID: "proj", VERTEX_REGION: "europe-north1", HAIKU_BACKEND: undefined });
    const sent = stubFetch([{ status: 200, body: completion("decomposed") }]);

    const result = await callHaikuWithFallback("decompose this", {
      source: "knowledge-decompose", botName: "bot", backend: "vertex",
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toContain("europe-north1-aiplatform.googleapis.com");
    expect(sent[0]!.headers.Authorization).toBe("Bearer metadata-token");
    expect(spawnCalls).toHaveLength(0);
    expect(result).toMatchObject({ result: "decomposed", backend: "vertex" });
  });

  // The pre-flight, mirroring the anthropic no-auth skip: an unconfigured
  // backend must not spend a failing call first, and the reason handed to the
  // CLI floor has to name the VARIABLE — on `MUNINN_PROFILE=nais` that reason is
  // the whole content of the refusal an operator reads.
  test("an unconfigured target skips the request and hands the CLI the missing variable", async () => {
    setEnv({ VERTEX_PROJECT_ID: "proj", VERTEX_REGION: undefined, HAIKU_BACKEND: undefined });
    const sent = stubFetch([{ status: 200, body: completion("never sent") }]);

    const result = await callHaikuWithFallback("q", { source: "test", botName: "bot", backend: "vertex" });

    expect(sent).toHaveLength(0);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.opts.cliFallback).toEqual({
      backend: "vertex", reason: "no Vertex target: CLOUD_ML_REGION / VERTEX_REGION is not set",
    });
    expect(result.backend).toBe("cli");
  });

  test("a refused request falls back to the CLI carrying the failure as the reason", async () => {
    setEnv({ VERTEX_PROJECT_ID: "proj", VERTEX_REGION: "europe-north1", HAIKU_BACKEND: undefined });
    const sent = stubFetch([{ status: 403, body: { error: { message: "PERMISSION_DENIED" } } }]);

    const result = await callHaikuWithFallback("q", { source: "test", botName: "bot", backend: "vertex" });

    expect(sent).toHaveLength(1); // 403 is not retried
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.opts.cliFallback.backend).toBe("vertex");
    expect(spawnCalls[0]!.opts.cliFallback.reason).toContain("403");
    expect(result.backend).toBe("cli");
  });

  // The user-visible half of the text-less case: the router must reach its
  // floor, not hand an empty string to a caller that will send it.
  test("a text-less Vertex answer falls back to the CLI", async () => {
    setEnv({ VERTEX_PROJECT_ID: "proj", VERTEX_REGION: "europe-north1", HAIKU_BACKEND: undefined });
    stubFetch([{ status: 200, body: {
      choices: [{ message: { role: "assistant" }, finish_reason: "length" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 53 } },
      model: "google/gemini-2.5-flash",
    } }]);

    const result = await callHaikuWithFallback("q", { source: "test", botName: "bot", backend: "vertex" });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.opts.cliFallback.backend).toBe("vertex");
    expect(result).toMatchObject({ result: "cli-fallback", backend: "cli" });
  });

  test("HAIKU_BACKEND=vertex selects it with no per-call backend", async () => {
    setEnv({ VERTEX_PROJECT_ID: "proj", VERTEX_REGION: "europe-north1", HAIKU_BACKEND: "vertex" });
    const sent = stubFetch([{ status: 200, body: completion("env-selected") }]);

    const result = await callHaikuWithFallback("q", { source: "test", botName: "bot" });

    expect(sent).toHaveLength(1);
    expect(result).toMatchObject({ result: "env-selected", backend: "vertex" });
  });
});
