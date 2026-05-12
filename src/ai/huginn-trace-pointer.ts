import { loadConfig } from "../config.ts";
import { getLog } from "../logging.ts";
import { extractMcpResultText, parseHuginnTrace } from "./huginn-trace.ts";
import { parseYggdrasilTracePointer } from "./yggdrasil-trace-pointer.ts";

const log = getLog("ai", "huginn-trace-pointer");

/**
 * Phase 2 trace channel: instead of embedding a ~14–200 KB trace fence in
 * the tool result text, Huginn writes the trace to its own in-memory store
 * and returns only a tiny pointer line in the tool result. Muninn parses the
 * pointer, strips it from the text the model sees, and fetches the trace
 * from Huginn after the call to attach to the span.
 *
 * This is the design that replaces the old fence-based path
 * ({@link parseHuginnTrace} + the divert-file rewrite). Motivation: a real
 * 188 KB trace was pushing search results past Claude CLI's
 * MAX_MCP_OUTPUT_TOKENS divert threshold, so the model received only a
 * "saved to file" placeholder instead of the actual hits.
 *
 * Wire format (one line, end of tool result):
 *
 *     huginn-trace-id: a3f8b21c4e9d0a55
 *
 * Or, when Huginn wants to be explicit about the fetch URL (preferred —
 * lets Muninn fetch without per-server URL config):
 *
 *     huginn-trace-url: http://localhost:8321/api/trace/a3f8b21c4e9d0a55
 *
 * Both forms are 16-hex (8 random bytes — uniqueness within the TTL
 * window is the only requirement).
 *
 * Fail-soft: any parse / fetch / network error yields a span without
 * `searchTrace`. The model's tool result is unaffected — Phase 2 is pure
 * observability.
 */

/**
 * Match either a bare id or a full URL pointer line. The URL form is locked to
 * the `/api/trace/<16hex>` path shape so a malformed or attacker-shaped URL in
 * a search-hit body never reaches {@link fetchHuginnTrace} (belt-and-suspenders
 * with the host allow-list below).
 */
const POINTER_RE =
  /\n+(?:huginn-trace-id: ([0-9a-f]{16})|huginn-trace-url: (https?:\/\/\S+?\/api\/trace\/[0-9a-f]{16}))\s*$/;

export interface PointerExtraction {
  /** Tool output with the pointer line stripped. Same string when no pointer. */
  text: string;
  /** Resolved fetch URL, or null if no pointer was present / parse failed. */
  fetchUrl: string | null;
}

export function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Origins Muninn is willing to issue trace fetches against. Defaults to the
 * `KNOWLEDGE_API_URL` origin (the same env Huginn-side uses) so a planted
 * `huginn-trace-url:` line in a search hit can't trick Muninn into hitting
 * an arbitrary host. Read at call time so tests can override the env.
 */
function getDefaultAllowedOrigins(): string[] {
  const origin = safeOrigin(loadConfig().knowledgeApiUrl);
  return origin === null ? [] : [origin];
}

export function isUrlOriginAllowed(url: string, allowedOrigins: string[]): boolean {
  const origin = safeOrigin(url);
  return origin !== null && allowedOrigins.includes(origin);
}

/**
 * Find a trace pointer at the end of a tool output and split the text from
 * the pointer. Caller is expected to call {@link fetchHuginnTrace} on the
 * returned URL after the tool call completes.
 *
 * Anchors at end-of-string (with trailing whitespace tolerance) so a literal
 * "huginn-trace-id:" inside a search hit's text body never produces a false
 * positive. Recent Claude CLI versions wrap MCP tool results in a
 * `{"result":"<inner>"}` envelope; we delegate that unwrap to
 * {@link extractMcpResultText} so the regex always sees the inner text.
 */
export function parseHuginnTracePointer(
  output: string,
  defaultBaseUrl?: string,
  allowedOrigins: string[] = getDefaultAllowedOrigins(),
): PointerExtraction {
  if (output.length === 0) return { text: output, fetchUrl: null };

  const direct = matchPointer(output, defaultBaseUrl, allowedOrigins);
  if (direct !== null) return direct;

  const inner = extractMcpResultText(output);
  if (inner !== null && inner !== output) {
    const wrapped = matchPointer(inner, defaultBaseUrl, allowedOrigins);
    if (wrapped !== null) return wrapped;
  }

  return { text: output, fetchUrl: null };
}

/**
 * Split a tool-result string into its body and its trailing Huginn trace
 * marker (pointer line or inline `huginn-trace` fence), reconstructing the
 * marker as a re-appendable string.
 *
 * Used by connectors that rewrite a knowledge-search tool result (e.g. the
 * corrective-retrieval pass in copilot-sdk) before handing it to the model:
 * peel the marker, splice new content into the body, then re-append `remainder`
 * at the very end so the downstream {@link processMcpToolResult} call still
 * finds and extracts the trace. Does not perform any network fetch.
 *
 * `remainder` is `""` when no marker was present (or a pointer-id form whose
 * URL couldn't be resolved — in which case it wouldn't have been fetched
 * anyway, so dropping it is harmless). Otherwise it includes the leading
 * `\n\n` separator.
 */
export function peelTraceMarkerForRewrite(text: string): { body: string; remainder: string } {
  const ptr = parseHuginnTracePointer(text);
  if (ptr.text !== text) {
    // A pointer line was stripped. Reconstruct the URL form when we have one.
    return { body: ptr.text, remainder: ptr.fetchUrl ? `\n\nhuginn-trace-url: ${ptr.fetchUrl}` : "" };
  }
  const fence = parseHuginnTrace(text);
  if (fence.trace !== null) {
    return { body: fence.text, remainder: `\n\n\`\`\`huginn-trace\n${JSON.stringify(fence.trace)}\n\`\`\`` };
  }
  return { body: text, remainder: "" };
}

interface HuginnTraceChannel {
  /** Tool output with the trace marker stripped, ready to store / forward. */
  text: string;
  /** Inline-fence trace, if Huginn ran in `HUGINN_TRACE_DEFAULT` (legacy) mode. */
  trace?: unknown;
  /** Phase 2 fetch URL, if Huginn ran in `HUGINN_TRACE_POINTER` mode. */
  pointer?: string;
}

/**
 * Try the pointer channel first, then fall back to the inline-fence channel.
 * Both modes coexist during rollout, and the precedence rule is the same in
 * every caller — keep it private to {@link processMcpToolResult} so connectors
 * always go through the full unwrap → peel → fetch pipeline.
 *
 * Returns `text` unchanged when neither channel matched.
 */
function peelHuginnTraceChannel(
  text: string,
  allowedOrigins?: string[],
): HuginnTraceChannel {
  const ptr = parseHuginnTracePointer(text, undefined, allowedOrigins);
  if (ptr.fetchUrl !== null) {
    return { text: ptr.text, pointer: ptr.fetchUrl };
  }
  // Disjoint allow-list per producer — yggdrasil reads its own env.
  const ygg = parseYggdrasilTracePointer(text);
  if (ygg.fetchUrl !== null) {
    return { text: ygg.text, pointer: ygg.fetchUrl };
  }
  const parsed = parseHuginnTrace(text);
  return {
    text: parsed.text,
    trace: parsed.trace ?? undefined,
  };
}

/** Try the pointer regex against `output`. Returns split + URL on hit, null on miss. */
function matchPointer(
  output: string,
  defaultBaseUrl: string | undefined,
  allowedOrigins: string[],
): PointerExtraction | null {
  const match = output.match(POINTER_RE);
  if (!match) return null;

  const id = match[1];
  const url = match[2];
  const text = output.slice(0, match.index!).replace(/\s+$/, "");

  let fetchUrl: string | null = null;
  if (url) {
    if (isUrlOriginAllowed(url, allowedOrigins)) {
      fetchUrl = url;
    } else {
      log.warn(
        "Pointer URL {url} origin not in allow-list {allowed}; trace will not be fetched",
        { url, allowed: allowedOrigins.join(",") },
      );
    }
  } else if (id) {
    if (!defaultBaseUrl) {
      log.warn("Pointer id {id} found but no defaultBaseUrl; trace will not be fetched", { id });
    } else {
      fetchUrl = `${defaultBaseUrl.replace(/\/+$/, "")}/api/trace/${id}`;
    }
  }

  return { text, fetchUrl };
}

export interface McpToolResultProcessing {
  /** Inner tool output with trace fence/pointer stripped. Untruncated — the
   *  caller decides whether to {@link truncateOutput} for storage or feed it
   *  back into a model conversation as-is. */
  cleanedText: string;
  /** Inline-fence trace, if Huginn ran in legacy `HUGINN_TRACE_DEFAULT` mode. */
  searchTrace?: unknown;
  /** Phase 2 fetch URL, if Huginn/Yggdrasil ran in pointer mode. */
  searchTracePointer?: string;
  /** In-flight fetch for the pointer trace. Awaited downstream by the trace
   *  attachment code; `null` resolution means the fetch failed (logged). */
  searchTraceFetch?: Promise<unknown | null>;
}

/**
 * Process a raw MCP tool result for trace storage and model re-injection:
 *
 *   1. Unwrap the MCP envelope via {@link extractMcpResultText}.
 *   2. Peel any Huginn/Yggdrasil trace channel via {@link peelHuginnTraceChannel}.
 *   3. Kick off a pointer-mode fetch via {@link fetchHuginnTrace} when present.
 *
 * Returns the inner text rather than the raw `{content: [{type:"text", text:...}]}`
 * envelope so (a) the inspector shows readable content instead of a double-encoded
 * blob and (b) connectors that loop the result back into a chat-completion
 * request don't waste context on the wrapper. Falls back to string serialization
 * for non-envelope inputs (e.g. `{error: ...}`) so callers always get a string.
 */
export function processMcpToolResult(rawResult: unknown): McpToolResultProcessing {
  const innerText = extractMcpResultText(rawResult);
  if (innerText !== null) {
    const channel = peelHuginnTraceChannel(innerText);
    const out: McpToolResultProcessing = {
      cleanedText: channel.text,
      searchTrace: channel.trace,
      searchTracePointer: channel.pointer,
    };
    if (channel.pointer !== undefined) {
      out.searchTraceFetch = fetchHuginnTrace(channel.pointer);
    }
    return out;
  }
  return {
    cleanedText: typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult),
  };
}

/**
 * Fetch a trace by URL. Returns the parsed JSON body on 2xx, null otherwise
 * (404 expired, 5xx, network error). Never throws — Phase 2 traces are
 * observability and must never break the request.
 *
 * `timeoutMs` defaults to 2 seconds. Huginn's store is local and the trace
 * is bounded; if a fetch takes longer than that, we'd rather drop the trace
 * than block the response pipeline.
 */
export async function fetchHuginnTrace(
  url: string,
  timeoutMs = 2000,
): Promise<unknown | null> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) {
      log.warn("Trace fetch returned {status} for {url}", { status: resp.status, url });
      return null;
    }
    return await resp.json();
  } catch (e) {
    log.warn("Trace fetch failed for {url}: {error}", {
      url,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
