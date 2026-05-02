import { getLog } from "../logging.ts";

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

/** Match either a bare id or a full URL pointer line. */
const POINTER_RE =
  /\n+(?:huginn-trace-id: ([0-9a-f]{16})|huginn-trace-url: (https?:\/\/[^\s]+))\s*$/;

export interface PointerExtraction {
  /** Tool output with the pointer line stripped. Same string when no pointer. */
  text: string;
  /** Resolved fetch URL, or null if no pointer was present / parse failed. */
  fetchUrl: string | null;
}

/**
 * Find a trace pointer at the end of a tool output and split the text from
 * the pointer. Caller is expected to call {@link fetchHuginnTrace} on the
 * returned URL after the tool call completes.
 *
 * Anchors at end-of-string (with trailing whitespace tolerance) so a literal
 * "huginn-trace-id:" inside a search hit's text body never produces a false
 * positive.
 *
 * Also unwraps the `{"result":"<inner>"}` envelope that recent Claude CLI
 * versions wrap MCP tool results in. When unwrapping succeeds the inner text
 * is returned (no envelope) so the model sees just the search results.
 */
export function parseHuginnTracePointer(
  output: string,
  defaultBaseUrl?: string,
): PointerExtraction {
  if (output.length === 0) return { text: output, fetchUrl: null };

  // Direct case — pointer at the end of a plain text result.
  const direct = matchPointer(output, defaultBaseUrl);
  if (direct !== null) return direct;

  // Wrapped case — Claude CLI inlines large MCP results as
  // `{"result":"<inner>"}` strings. The pointer lives inside `<inner>`,
  // not at the end of the wrapper. Unwrap once and retry; on success
  // return the inner text (envelope discarded — model gets clean text).
  const trimmed = output.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(output) as { result?: unknown };
      if (parsed && typeof parsed.result === "string") {
        const innerMatch = matchPointer(parsed.result, defaultBaseUrl);
        if (innerMatch !== null) return innerMatch;
      }
    } catch {
      // Not a clean JSON wrapper — fall through, no pointer.
    }
  }

  return { text: output, fetchUrl: null };
}

/** Try the pointer regex against `output`. Returns split + URL on hit, null on miss. */
function matchPointer(output: string, defaultBaseUrl?: string): PointerExtraction | null {
  const match = output.match(POINTER_RE);
  if (!match) return null;

  const id = match[1];
  const url = match[2];
  let fetchUrl: string | null = null;
  if (url) {
    fetchUrl = url;
  } else if (id) {
    if (!defaultBaseUrl) {
      log.warn("Pointer id {id} found but no defaultBaseUrl; trace will not be fetched", { id });
      return { text: output.slice(0, match.index!).replace(/\s+$/, ""), fetchUrl: null };
    }
    fetchUrl = `${defaultBaseUrl.replace(/\/+$/, "")}/api/trace/${id}`;
  }

  const text = output.slice(0, match.index!).replace(/\s+$/, "");
  return { text, fetchUrl };
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
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
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
  } finally {
    clearTimeout(timer);
  }
}
