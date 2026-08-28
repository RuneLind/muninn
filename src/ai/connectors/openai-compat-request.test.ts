import { afterAll, beforeAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executePrompt } from "./openai-compat.ts";
import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";

/**
 * The WIRING, driven end to end: a real `executePrompt` against a real HTTP
 * server, over a real socket.
 *
 * `openai-compat-auth.test.ts` proves the authorizer in isolation, and that is
 * not the same claim. A review measured the gap: mutating the connector so it
 * never retries a 401 — the exact regression this feature exists to prevent —
 * left every other test in the repo green. Nothing called `executePrompt` on an
 * endpoint that answers 401, so the retry could have been deleted outright.
 *
 * The server binds port 0 and the URL is read back off it, so this file can
 * never collide with a parallel spec or the developer's own dev server.
 */

/** Everything `executePrompt` reads off `Config`; it takes no DB. */
const config = { claudeModel: "fallback-model", claudeTimeoutMs: 30_000 } as Config;

/** A directory with no `.mcp.json`, so the bot loads zero tools and the model
 *  cannot ask for any — this file is about the request path, not the tool loop. */
let botDir: string;
let server: ReturnType<typeof Bun.serve>;
let base: string;

/** Per-request script the current case wants the fake endpoint to follow. */
type Mode = "ok" | "unauthorized-once" | "unauthorized-always" | "forbidden" | "empty-then-ok";
let mode: Mode = "ok";
/** Every request the server saw, in order. */
let seen: { authorization: string | null; contentType: string | null }[] = [];

function sse(...chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

const answer = (text: string) => sse({
  model: "served-model",
  choices: [{ delta: { content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 7, completion_tokens: 3 },
});

beforeAll(() => {
  botDir = mkdtempSync(join(tmpdir(), "muninn-oc-test-"));
  server = Bun.serve({
    port: 0,
    fetch(req) {
      seen.push({
        authorization: req.headers.get("authorization"),
        contentType: req.headers.get("content-type"),
      });
      const n = seen.length;
      switch (mode) {
        case "unauthorized-once":
          return n === 1 ? new Response("UNAUTHENTICATED", { status: 401 }) : answer("after refresh");
        case "unauthorized-always":
          return new Response("UNAUTHENTICATED", { status: 401 });
        case "forbidden":
          return new Response("PERMISSION_DENIED", { status: 403 });
        case "empty-then-ok":
          return n === 1 ? sse({ model: "served-model", choices: [{ delta: {} }] }) : answer("second try");
        default:
          return answer("hello world");
      }
    },
  });
  base = `http://127.0.0.1:${server.port}/v1`;
});

afterAll(() => server.stop(true));
afterEach(() => { seen = []; });

/** A distinct bot NAME per case: `loadToolsForBot` caches on it. */
let botCounter = 0;
function bot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    name: `oc-test-${++botCounter}`,
    dir: botDir,
    persona: "",
    telegramAllowedUserIds: [],
    slackAllowedUserIds: [],
    connector: "openai-compat",
    model: "requested-model",
    baseUrl: base,
    timeoutMs: 30_000,
    ...overrides,
  };
}

async function run(b: BotConfig) {
  const deltas: string[] = [];
  const result = await executePrompt("hei", config, b, "du er en assistent", (e) => {
    if (e.type === "text_delta") deltas.push(e.text);
  });
  return { result, deltas };
}

describe("executePrompt over a real socket — static key path", () => {
  const previousKey = process.env.OPENAI_API_KEY;
  afterEach(() => {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  });

  test("sends the key, answers, and makes exactly one request", async () => {
    mode = "ok";
    process.env.OPENAI_API_KEY = "sk-local";
    const { result, deltas } = await run(bot());
    expect(result.result).toBe("hello world");
    expect(deltas).toEqual(["hello world"]);
    expect(seen).toEqual([{ authorization: "Bearer sk-local", contentType: "application/json" }]);
  });

  test("with no key set, sends no Authorization at all — and still answers", async () => {
    mode = "ok";
    delete process.env.OPENAI_API_KEY;
    const { result } = await run(bot());
    expect(result.result).toBe("hello world");
    expect(seen).toEqual([{ authorization: null, contentType: "application/json" }]);
  });

  test("a 401 on the static path is NOT retried — a wrong key is a wrong key", async () => {
    mode = "unauthorized-once";
    process.env.OPENAI_API_KEY = "sk-wrong";
    await expect(run(bot())).rejects.toThrow(/401/);
    expect(seen).toHaveLength(1);
  });

  test("the empty-response retry loop still works (the LM Studio path)", async () => {
    mode = "empty-then-ok";
    delete process.env.OPENAI_API_KEY;
    const { result } = await run(bot());
    expect(result.result).toBe("second try");
    expect(seen).toHaveLength(2);
  });
});

describe("executePrompt over a real socket — Vertex credential path", () => {
  /**
   * The connector picks its credential from the baseUrl HOST, so the test server
   * has to be addressed as a Vertex one. `Bun.serve` cannot own that hostname,
   * so two addresses are redirected at the last moment and everything else — the
   * connector, the authorizer, the token provider, `fetchFromMetadataServer` —
   * is the real code.
   *
   * The METADATA server is answered rather than refused, deliberately: left to
   * fall through, the provider shells out to `gcloud`, which passed on the
   * developer's laptop and would have failed on a CI runner that has neither
   * gcloud nor a metadata server. Each answer carries a new token, which is also
   * what makes "the retry used a fresh credential" checkable.
   */
  function withVertexHost<T>(body: () => Promise<T>): Promise<T> {
    const realFetch = globalThis.fetch;
    const vertexBase =
      "https://europe-north1-aiplatform.googleapis.com/v1/projects/p/locations/europe-north1/endpoints/openapi";
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("metadata.google.internal")) {
        return Promise.resolve(Response.json({ access_token: `metadata-token-${++minted}`, expires_in: 3600 }));
      }
      if (url.startsWith("https://europe-north1-aiplatform.googleapis.com")) {
        return realFetch(url.replace(vertexBase, base), init);
      }
      return realFetch(input as RequestInfo, init);
    }) as typeof fetch;
    return body().finally(() => { globalThis.fetch = realFetch; });
  }
  let minted = 0;

  const vertexBot = () => bot({
    baseUrl: "https://europe-north1-aiplatform.googleapis.com/v1/projects/p/locations/europe-north1/endpoints/openapi",
    model: "google/gemini-2.5-flash",
  });

  test("a 401 is retried once with a FRESH token, and the answer streams exactly once", async () => {
    mode = "unauthorized-once";
    const { result, deltas } = await withVertexHost(() => run(vertexBot()));
    expect(result.result).toBe("after refresh");
    // The refused request emitted nothing — no replay of the first attempt.
    expect(deltas).toEqual(["after refresh"]);
    expect(seen).toHaveLength(2);
    // The retry must carry a DIFFERENT credential, or the retry is pointless —
    // and both must be the ones the credential source actually minted.
    expect(seen[0]!.authorization).toMatch(/^Bearer metadata-token-\d+$/);
    expect(seen[1]!.authorization).toMatch(/^Bearer metadata-token-\d+$/);
    expect(seen[1]!.authorization).not.toBe(seen[0]!.authorization);
  });

  test("a persistent 401 stops at two requests — it does not loop", async () => {
    mode = "unauthorized-always";
    await expect(withVertexHost(() => run(vertexBot()))).rejects.toThrow(/401/);
    expect(seen).toHaveLength(2);
  });

  test("a 403 is not retried", async () => {
    mode = "forbidden";
    await expect(withVertexHost(() => run(vertexBot()))).rejects.toThrow(/403/);
    expect(seen).toHaveLength(1);
  });

  test("a `global` Vertex baseUrl fails the turn before a single request is made", async () => {
    mode = "ok";
    await expect(withVertexHost(() => run(bot({
      baseUrl: "https://europe-north1-aiplatform.googleapis.com/v1/projects/p/locations/global/endpoints/openapi",
    })))).rejects.toThrow(/global/);
    expect(seen).toHaveLength(0);
  });
});
