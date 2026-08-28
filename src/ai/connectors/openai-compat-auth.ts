import { isVertexEndpoint, assertVertexEndpointAllowed, VertexTokenProvider, vertexTokens } from "../vertex-access.ts";
import { OpenAiCompatHttpError } from "./openai-compat-stream.ts";
import { getLog } from "../../logging.ts";

const log = getLog("ai", "openai-compat");

/**
 * How an `openai-compat` request is authenticated — resolved ONCE per turn from
 * the bot's `baseUrl`, then consulted before EVERY HTTP request.
 *
 * The per-request part is the whole point. Until now the connector built one
 * `Authorization: Bearer ${OPENAI_API_KEY}` header before the agent loop and
 * reused it for every turn, which is correct for a static API key and wrong for
 * Vertex AI, whose Google access token expires in about an hour. A tool loop can
 * run longer than that, and a chat thread certainly does.
 */
export interface RequestAuthorizer {
  /** Headers for one request. Called per request, not per turn. */
  headers(): Promise<Record<string, string>>;
  /**
   * Called when a request failed. Returns true if the failure looks like a
   * stale credential AND a fresh one might fix it — having already dropped the
   * cached credential, so the retry's `headers()` fetches a new one.
   */
  refreshAfterFailure(err: unknown): boolean;
}

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

/**
 * The static path: today's behaviour, unchanged. `OPENAI_API_KEY` is read per
 * request rather than captured, which costs nothing and means a key rotated in
 * the environment takes effect on the next turn instead of the next restart.
 *
 * Never asks for a retry: a 401 from a static key is a wrong key, and retrying
 * it just doubles the wait before the operator sees the same message.
 */
function staticKeyAuthorizer(): RequestAuthorizer {
  return {
    headers: async () => ({
      ...JSON_HEADERS,
      ...(process.env.OPENAI_API_KEY ? { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } : {}),
    }),
    refreshAfterFailure: () => false,
  };
}

/**
 * The Vertex path: a Google OAuth access token from Application Default
 * Credentials, fetched fresh whenever the cached one is near expiry.
 *
 * `x-goog-user-project` is deliberately NOT sent. The publisher LISTING needs it
 * (user ADC has no quota project of its own); the project-scoped `…/endpoints/openapi`
 * URL does not — measured against a real project on user ADC, which is the
 * weakest credential shape this runs under.
 */
function vertexAuthorizer(provider: VertexTokenProvider): RequestAuthorizer {
  return {
    headers: async () => ({ ...JSON_HEADERS, Authorization: `Bearer ${await provider.get()}` }),
    refreshAfterFailure: (err) => {
      // 401 only, and one retry only. Measured against the live endpoint: an
      // invalid or expired token answers 401 UNAUTHENTICATED, while 403
      // PERMISSION_DENIED is Google refusing the CALLER or the endpoint — an org
      // policy restricting which Vertex endpoints a project may use answers it,
      // for instance. A fresh token cannot change either, so retrying a 403 would
      // turn a clear refusal into a slower one. (A model the project may not call
      // is a third answer again, 404, and is likewise not a credential problem.)
      if (!(err instanceof OpenAiCompatHttpError) || err.status !== 401) return false;
      log.warn("Vertex returned 401 — discarding the cached access token and retrying once");
      provider.invalidate();
      return true;
    },
  };
}

/**
 * Pick the credential shape for a bot's `baseUrl`, and refuse the endpoints that
 * must not be dialled at all. Throws for a `global`-region Vertex URL, before
 * the first request rather than after it.
 */
export function createAuthorizer(
  baseUrl: string,
  botName: string,
  provider: VertexTokenProvider = vertexTokens,
): RequestAuthorizer {
  if (!isVertexEndpoint(baseUrl)) return staticKeyAuthorizer();
  assertVertexEndpointAllowed(baseUrl, botName);
  return vertexAuthorizer(provider);
}


/**
 * One request, plus ONE retry if the failure was a stale credential.
 *
 * Lives here rather than inside the connector so there is exactly ONE
 * implementation of the sequence: the connector calls it, and so does the
 * `--probe=refresh` measurement in `scripts/smoke-vertex.ts`. A probe that
 * re-implemented the sequence would keep reporting success after the shipped one
 * regressed — which is the single thing that probe exists to rule out.
 *
 * `send` is called at most twice and is handed fresh headers each time.
 */
export async function requestWithRefresh<T>(
  authorizer: RequestAuthorizer,
  send: (headers: Record<string, string>) => Promise<T>,
): Promise<T> {
  try {
    return await send(await authorizer.headers());
  } catch (err) {
    if (!authorizer.refreshAfterFailure(err)) throw err;
    return await send(await authorizer.headers());
  }
}
