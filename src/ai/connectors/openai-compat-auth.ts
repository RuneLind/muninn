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
      // 401 only, and one retry only. Vertex answers 401 UNAUTHENTICATED for an
      // expired or invalid token and 403 PERMISSION_DENIED for a credential that
      // is valid but not entitled (measured) — retrying the latter would turn a
      // clear "this identity may not call this model" into a slower one.
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
