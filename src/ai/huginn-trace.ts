import { getLog } from "../logging.ts";

const log = getLog("ai", "huginn-trace");

/**
 * Huginn's MCP adapters embed a per-search trace in their tool results when
 * `HUGINN_TRACE_DEFAULT=1` is set in the spawned env. This module peels that
 * trace off so the inspector can show it while keeping it out of LLM-visible
 * tool output. Schema is documented in huginn/docs/search-tracing-plan.md.
 *
 * Two formats:
 *
 *   1. HTTP-wrapper (knowledge_api_mcp_adapter.py) — text result ending with
 *      a fenced block:
 *
 *          ```huginn-trace
 *          {"query": {...}, "collections": [...], "totalMs": 71, "schemaVersion": 1}
 *          ```
 *
 *   2. In-process (multi_collection_search_mcp_adapter.py) — JSON tool result
 *      with a top-level `trace` key alongside `results`.
 */

export interface HuginnTraceExtraction {
  /** Tool output with the trace block stripped. Same type as input. */
  text: string;
  /** Parsed trace, or null if no trace was found / parsing failed. */
  trace: unknown | null;
}

const FENCE_PATTERN = /\n*```huginn-trace\n([\s\S]+?)\n```\s*$/;

/**
 * Extract a Huginn search trace from a tool output string.
 *
 * - Tries text-mode (trailing ```huginn-trace fence) first.
 * - Falls back to JSON-mode (top-level `trace` key) if the input is JSON.
 * - Never throws — on any parse error the original text is returned with
 *   `trace: null` so the caller can pass it through unchanged.
 */
export function parseHuginnTrace(output: string): HuginnTraceExtraction {
  if (typeof output !== "string" || output.length === 0) {
    return { text: output, trace: null };
  }

  // Text-mode: trailing fenced block
  const match = output.match(FENCE_PATTERN);
  if (match && match[1] !== undefined) {
    try {
      const trace = JSON.parse(match[1]);
      const text = output.slice(0, match.index).replace(/\s+$/, "");
      return { text, trace };
    } catch (e) {
      log.warn("Failed to parse huginn-trace fence body: {error}", {
        error: e instanceof Error ? e.message : String(e),
      });
      return { text: output, trace: null };
    }
  }

  // JSON-mode: top-level `trace` key
  const trimmed = output.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(output);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "trace" in parsed) {
        const { trace, ...rest } = parsed as Record<string, unknown>;
        return { text: JSON.stringify(rest), trace };
      }
    } catch {
      // Not JSON — fall through. Plenty of tool outputs start with `{` but
      // are e.g. truncated JSON or text containing braces, so this is normal.
    }
  }

  return { text: output, trace: null };
}

/**
 * Walk a structured MCP tool result and pull out the human-readable text.
 *
 * MCP results vary by SDK and adapter:
 *   - plain string
 *   - `{ content: "..." }`                         (SDK flattened)
 *   - `{ content: [{ type: "text", text: "..." }, ...] }` (MCP standard)
 *   - `{ content: "{\"result\":\"...\"}" }`        (Huginn HTTP wrapper, double-encoded)
 *   - `{ result: "..." }` / `{ text: "..." }`      (other adapters)
 *
 * Returns the longest text fragment found (which is where Huginn's trace fence
 * lives), or null if nothing text-like is present.
 */
export function extractMcpResultText(result: unknown): string | null {
  if (result == null) return null;
  if (typeof result === "string") {
    // Some adapters double-encode: a JSON-stringified object inside the text.
    // Try one level of un-nesting if it looks like JSON.
    const trimmed = result.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const inner = JSON.parse(result);
        const innerText = extractMcpResultText(inner);
        if (innerText) return innerText;
      } catch {
        // Not JSON — fall through and return the string as-is.
      }
    }
    return result;
  }
  if (typeof result !== "object") return null;
  const r = result as Record<string, unknown>;

  if (typeof r.content === "string") {
    return extractMcpResultText(r.content);
  }
  if (Array.isArray(r.content)) {
    const parts: string[] = [];
    for (const block of r.content) {
      if (typeof block === "string") parts.push(block);
      else if (block && typeof block === "object") {
        const b = block as { type?: string; text?: string };
        if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }
  if (typeof r.text === "string") return r.text;
  if (typeof r.result === "string") return extractMcpResultText(r.result);
  if (typeof r.detailedContent === "string") return r.detailedContent;

  return null;
}
