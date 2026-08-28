import { getLog } from "../logging.ts";
import { HAIKU_DEFAULT_MAX_TOKENS, HAIKU_TIMEOUT_MS, trackUsage, type HaikuResult, type SpawnHaikuOptions } from "../scheduler/executor.ts";
import { createAuthorizer, requestWithRefresh } from "./connectors/openai-compat-auth.ts";
import { OpenAiCompatHttpError } from "./connectors/openai-compat-stream.ts";
import { VERTEX_GLOBAL_HOST } from "../config.ts";
import type { VertexTokenProvider } from "./vertex-access.ts";

/**
 * The Haiku router's Vertex AI backend — the short async calls (the
 * `research_knowledge` decomposer, the memory/goal/schedule extractors, the
 * prose reminders) sent to the SAME endpoint the chat turn goes to.
 *
 * Why this exists at all: every `research_knowledge` call decomposes through a
 * Haiku call FIRST, with the user's question in the prompt. A deployment that
 * moves its chat turn onto an approved endpoint and leaves the router on its
 * default is compliant on the answer and not on the lookup right before it. The
 * three extractors can be force-disabled (`extractionsForcedOff`); the
 * decomposer cannot — it is how the knowledge tool works.
 *
 * Shape: the same OpenAI-compatible Vertex endpoint `openai-compat` uses for the
 * chat turn, so the credential handling is REUSED rather than reimplemented —
 * `createAuthorizer` picks the Google-token path off the host and refuses the
 * `global` region, and `requestWithRefresh` is the one implementation of the
 * expired-token retry. This module owns only the one-shot request itself, which
 * is non-streaming (like `callHaikuDirect`) because nothing here has a reader.
 *
 * Anthropic-on-Vertex (`@anthropic-ai/vertex-sdk`) would be the other shape and
 * is deliberately NOT built: measured 2026-08-28, no Anthropic model is callable
 * in the region this targets, so it would be a backend with nothing to call.
 *
 * One consequence to know, since compliance is the reason this exists: a FAILURE
 * here — including a benign `max_tokens` truncation, which throws below — sends
 * the router to its CLI floor, which re-sends the same prompt (carrying the
 * user's question) to a different provider. That is the right trade for an
 * instance that has a CLI, and it does not arise on the profile that must not
 * leak: `MUNINN_PROFILE=nais` ships no CLI and `spawnHaiku` refuses instead.
 */

const log = getLog("ai", "haiku-vertex");

/**
 * The model these calls run on, overridable with `HAIKU_VERTEX_MODEL`.
 *
 * The `<publisher>/<model>` prefix is REQUIRED by the OpenAI-compatible endpoint
 * — without it Vertex answers 400 — so an override needs it too.
 *
 * Flash-LITE, and the reason is latency, which is the entire point of this tier:
 * the decomposer sits in front of every knowledge lookup and the extractors run
 * beside a live turn. Measured 2026-08-28 through `--probe=haiku` (two runs
 * each, same prompts): flash-lite answered the decomposer in ~0.53 s and flash
 * in ~2.2–2.4 s, both inside the prompt's contract (flash fanned out to 3
 * sub-questions, flash-lite to 4 — each of which costs a downstream retrieval,
 * so the cheaper model is not the cheaper END-TO-END call on every question).
 * Point `HAIKU_VERTEX_MODEL` at flash where that trade goes the other way.
 */
export const DEFAULT_VERTEX_HAIKU_MODEL = "google/gemini-2.5-flash-lite";

/** Fields a Vertex Haiku call needs, resolved from the environment. */
export interface VertexHaikuTarget {
  project: string;
  region: string;
  model: string;
  /** The OpenAI-compatible endpoint, WITHOUT the `/chat/completions` suffix. */
  baseUrl: string;
}

/**
 * The OpenAI-compatible endpoint for a project + location.
 *
 * Two host shapes, because a Vertex location is not always a region. A REGION
 * (`europe-north1`) is a prefix on the ordinary host; a MULTI-REGION (`eu`) has
 * its own `aiplatform.<mr>.rep.googleapis.com` host and no prefix form at all —
 * measured 2026-08-28, `…/locations/eu/endpoints/openapi/chat/completions` on
 * the multi-region host reaches Vertex and is answered by the MODEL layer (a 404
 * naming the publisher model, not a DNS or routing failure), while `eu-` on the
 * ordinary host is not a name. A location containing a `-` is the regional form;
 * anything else is a multi-region name. `global` never reaches this — it is
 * refused by `resolveVertexConfig` at boot and again by `assertVertexEndpointAllowed`
 * on the URL this builds.
 */
export function vertexOpenAiBaseUrl(project: string, location: string): string {
  const host = location.includes("-")
    ? `${location}-${VERTEX_GLOBAL_HOST}`
    : `aiplatform.${location}.rep.googleapis.com`;
  return `https://${host}/v1/projects/${project}/locations/${location}/endpoints/openapi`;
}

export type VertexHaikuTargetResult =
  | { ok: true; target: VertexHaikuTarget }
  /**
   * `reason` is a COMPLETE phrase, not a variable name. It used to be the name
   * alone, with both call sites appending "is not set" — which told an operator
   * whose region was set-but-malformed to go looking for a variable sitting
   * right there in their `.env`.
   */
  | { ok: false; reason: string };

/**
 * Where a Vertex Haiku call would go, or WHY it cannot go anywhere.
 *
 * Reads the same two names `resolveVertexConfig` does, in the same order, so an
 * instance states its project and region ONCE. It deliberately does NOT consult
 * `CLAUDE_CODE_USE_VERTEX`: that switch is the Agent SDK's, and this backend is
 * selected by its own lever (`haikuBackend: "vertex"`, `HAIKU_BACKEND=vertex`,
 * or the `/models` override) — requiring both would mean a router that silently
 * ignores the backend it was asked for.
 *
 * Returning a REASON rather than throwing is what lets the router skip the
 * attempt and say why, the way it already does for a missing Anthropic key. It
 * is a complete phrase, not a variable name — both call sites render it as-is,
 * because appending a fixed "is not set" told an operator whose region was
 * set-but-malformed to go looking for a variable sitting in their `.env`.
 */
export function resolveVertexHaikuTarget(
  env: Record<string, string | undefined> = process.env,
): VertexHaikuTargetResult {
  const read = (name: string): string => (env[name] ?? "").trim();
  const project = read("ANTHROPIC_VERTEX_PROJECT_ID") || read("VERTEX_PROJECT_ID");
  // LOWERCASED, not case-refused. A mixed-case region works on this path today
  // (`URL.hostname` lowercases an https host, so `isVertexEndpoint` matches and
  // the Google-token path is taken), and `resolveVertexConfig` — reading the
  // same `CLOUD_ML_REGION` for the Agent SDK — applies no case rule at all.
  // Refusing it here would mean one `.env` line puts `claude-sdk` on Vertex
  // while the Haiku router quietly falls back to the CLI.
  const regionRaw = read("CLOUD_ML_REGION") || read("VERTEX_REGION");
  const region = regionRaw.toLowerCase();
  if (!project) return { ok: false, reason: "ANTHROPIC_VERTEX_PROJECT_ID / VERTEX_PROJECT_ID is not set" };
  if (!region) return { ok: false, reason: "CLOUD_ML_REGION / VERTEX_REGION is not set" };
  // A region becomes a HOSTNAME LABEL below, so it has to be one. The failure a
  // dot buys is not a bad URL: `aiplatform.eu.west.rep.googleapis.com` does not
  // match `isVertexEndpoint`, so `createAuthorizer` falls through to the
  // STATIC-KEY path and sends `Authorization: Bearer $OPENAI_API_KEY` to
  // Google — and `assertVertexEndpointAllowed` never runs either, since it
  // early-returns on a host it does not recognise as Vertex. Refused here,
  // where the operator can be told which variable to fix.
  if (!/^[a-z0-9-]+$/.test(region)) {
    // The RAW value, not the normalized one: quoting `europe_north1` back at an
    // operator who wrote `Europe_North1` is the same misdirection as telling
    // them a set variable is unset.
    return { ok: false, reason: `CLOUD_ML_REGION / VERTEX_REGION is "${regionRaw}", which is not a region name` };
  }
  const model = read("HAIKU_VERTEX_MODEL") || DEFAULT_VERTEX_HAIKU_MODEL;
  return { ok: true, target: { project, region, model, baseUrl: vertexOpenAiBaseUrl(project, region) } };
}

interface ChatCompletion {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** Gemini's thinking tokens, reported here and NOT in `completion_tokens`. */
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  model?: string;
}

/**
 * The two process-wide things this call reads, injectable so a test can drive
 * the real code path without a real credential. Both default to production:
 * `process.env`, and the shared token provider (process-wide because the
 * credential is the process's, not a bot's).
 */
export interface VertexHaikuDeps {
  env?: Record<string, string | undefined>;
  provider?: VertexTokenProvider;
}

/**
 * One tool-less Haiku-tier call against Vertex.
 *
 * `OpenAiCompatHttpError` is the error type on a non-2xx, and that is
 * load-bearing rather than tidy: the authorizer's stale-credential test matches
 * on the TYPE and its `status`, so throwing a plain `Error` here would leave the
 * 401 retry inert — passing its own unit tests, because a test that stubs the
 * fetch never sees a real expiry.
 */
export async function callHaikuViaVertex(
  prompt: string,
  opts: SpawnHaikuOptions,
  deps: VertexHaikuDeps = {},
): Promise<HaikuResult> {
  const { source, botName, timeoutMs = HAIKU_TIMEOUT_MS, model, maxTokens } = opts;
  const resolved = resolveVertexHaikuTarget(deps.env);
  if (!resolved.ok) {
    throw new Error(`Vertex Haiku backend is not configured: ${resolved.reason}`);
  }
  const target = resolved.target;
  // An explicit per-call model wins, as on every other backend. The env default
  // is what a deployment sets once.
  const effectiveModel = model || target.model;
  const effectiveMaxTokens = maxTokens && maxTokens > 0 ? maxTokens : HAIKU_DEFAULT_MAX_TOKENS;

  // Resolved per call (this is a one-shot, so per call IS per turn): it can
  // refuse the endpoint outright, and it holds the generation the 401 retry
  // reports as refused.
  const authorizer = createAuthorizer(target.baseUrl, botName ?? "haiku", deps.provider);
  const url = `${target.baseUrl}/chat/completions`;

  const body = {
    model: effectiveModel,
    messages: [
      // Persona/system prompt for the prose paths (goal + task reminders), same
      // contract as the other two backends: absent for the extraction/JSON
      // callers, where persona is irrelevant.
      ...(opts.system ? [{ role: "system", content: opts.system }] : []),
      { role: "user", content: prompt },
    ],
    max_tokens: effectiveMaxTokens,
  };

  const completion = await requestWithRefresh(authorizer, async (headers) => {
    let res: Response;
    try {
      // Per REQUEST, which is not the same as per call and is known: acquiring
      // the ADC token sits outside it (a cold `gcloud` path is ~700 ms), and a
      // 401 runs the whole sequence a second time, so the worst case exceeds
      // `timeoutMs`. Accepted, and shared with the `openai-compat` connector,
      // which bounds its own requests the same way — a whole-operation budget
      // belongs at that seam, for both, not as a second spelling here.
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // `AbortSignal.timeout` rejects with a DOMException whose message names
      // neither the budget nor the backend — say both, since this is the shape
      // an operator sees when Vertex is slow or unreachable.
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Vertex Haiku request failed after ${timeoutMs}ms: ${message}`);
    }
    if (!res.ok) {
      throw new OpenAiCompatHttpError(res.status, (await res.text()).slice(0, 500));
    }
    return (await res.json()) as ChatCompletion;
  });

  const choice = completion.choices?.[0];
  const resultText = choice?.message?.content ?? "";
  const inputTokens = completion.usage?.prompt_tokens ?? 0;
  // Reasoning tokens are BILLED OUTPUT and are not included in
  // `completion_tokens` — measured against the live endpoint 2026-08-28, a
  // flash answer reported `total_tokens` 105 = prompt 19 + completion 1 +
  // reasoning 85. Reading only `completion_tokens` under-reports a thinking
  // model's spend by an order of magnitude on a short answer. The same reason
  // the other two backends fold their cache-token fields into usage.
  const outputTokens = (completion.usage?.completion_tokens ?? 0)
    + (completion.usage?.completion_tokens_details?.reasoning_tokens ?? 0);
  const reportedModel = completion.model || effectiveModel;

  // `length` is the OpenAI-compat spelling of the truncation `callHaikuDirect`
  // warns about, and it bites harder here: on a thinking model the reasoning
  // tokens come out of the SAME budget, so a truncated response carries no text
  // at all rather than half a JSON blob (measured on flash with a small cap —
  // `finish_reason: "length"`, 3 completion tokens, 53 reasoning tokens, empty
  // content).
  //
  // An answer with no text is a FAILED call and is thrown, not returned. A
  // returned empty string is worse than an error twice over: the router only
  // falls back on a throw, and `callHaikuMessageWithFallback` only substitutes
  // its fallback text on one — so the two prose callers would send an empty
  // message (Telegram answers 400, and the goal runner then never stamps
  // `reminder_sent_at`, re-firing the same reminder every tick).
  if (!resultText.trim()) {
    // Usage is still recorded: the tokens were spent whether or not text came
    // back, and a truncation that burns the whole budget is exactly the row an
    // operator needs to see.
    trackUsage(source, reportedModel, inputTokens, outputTokens, botName, opts.tracer?.traceId);
    throw new Error(
      `Vertex returned no text (finish_reason: ${choice?.finish_reason ?? "none"}, model: ${reportedModel}, ` +
      `max_tokens: ${effectiveMaxTokens}). On a thinking model the reasoning tokens come out of the same ` +
      `budget — raise maxTokens or set HAIKU_VERTEX_MODEL to a model that does not think.`,
    );
  }

  // Truncated WITH text is the other half, and it stays a warning rather than a
  // throw: half a JSON blob fails the caller's parse (which every JSON caller
  // handles), and half a paragraph is still a usable reminder.
  if (choice?.finish_reason === "length") {
    log.warn(
      "haiku-router vertex response truncated at max_tokens ({maxTokens}) — JSON parse may fail",
      { botName: botName ?? "haiku", maxTokens: effectiveMaxTokens },
    );
  }

  // Same join as the other backends: the tracer's trace id ties the haiku_usage
  // row back to the request trace (NULL without one).
  trackUsage(source, reportedModel, inputTokens, outputTokens, botName, opts.tracer?.traceId);

  return { result: resultText, inputTokens, outputTokens, model: reportedModel, backend: "vertex" };
}
