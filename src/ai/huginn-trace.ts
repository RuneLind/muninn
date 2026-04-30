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
 *
 * Spread {@link HUGINN_TRACE_ENV} into MCP server spawn envs to opt them in.
 * Non-Huginn servers ignore the unknown var, so it's safe to set unconditionally.
 */

/** Env var that opts a Huginn MCP adapter into emitting trace blobs. */
export const HUGINN_TRACE_ENV = { HUGINN_TRACE_DEFAULT: "1" } as const;

export interface HuginnTraceExtraction {
  /** Tool output with the trace block stripped. Same type as input. */
  text: string;
  /** Parsed trace, or null if no trace was found / parsing failed. */
  trace: unknown | null;
}

const FENCE_OPEN = "```huginn-trace\n";
const FENCE_CLOSE = "\n```";

/**
 * Extract a Huginn search trace from a tool output string.
 *
 * - Tries text-mode (trailing ```huginn-trace fence) first.
 * - Falls back to JSON-mode (top-level `trace` key) if the input is JSON.
 * - Never throws — on any parse error the original text is returned with
 *   `trace: null` so the caller can pass it through unchanged.
 */
export function parseHuginnTrace(output: string): HuginnTraceExtraction {
  if (output.length === 0) return { text: output, trace: null };

  // Anchor on the closing fence at end-of-string (allowing trailing whitespace),
  // then walk back to the opener. This handles arbitrarily large trace bodies —
  // a real-world melosys query produces ~14 KB of trace JSON, more than fits in
  // a fixed-size tail window.
  const trimmedEnd = output.replace(/\s+$/, "");
  if (trimmedEnd.endsWith("```")) {
    const closeIdx = trimmedEnd.lastIndexOf(FENCE_CLOSE);
    if (closeIdx !== -1 && closeIdx === trimmedEnd.length - FENCE_CLOSE.length) {
      const openIdx = trimmedEnd.lastIndexOf(FENCE_OPEN, closeIdx);
      if (openIdx !== -1) {
        const body = trimmedEnd.slice(openIdx + FENCE_OPEN.length, closeIdx);
        try {
          const trace = JSON.parse(body);
          const text = output.slice(0, openIdx).replace(/\s+$/, "");
          return { text, trace };
        } catch (e) {
          log.warn("Failed to parse huginn-trace fence body: {error}", {
            error: e instanceof Error ? e.message : String(e),
          });
          return { text: output, trace: null };
        }
      }
    }
  }

  if (output.trimStart().startsWith("{")) {
    try {
      const parsed = JSON.parse(output);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "trace" in parsed) {
        const { trace, ...rest } = parsed as Record<string, unknown>;
        return { text: JSON.stringify(rest), trace };
      }
    } catch {
      // Genuine non-JSON text starting with `{` is common — fall through.
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
 *   - `{ content: "<placeholder>", contents: [{type:"text", text:"<full>"}], detailedContent: "<truncated>" }`
 *     (copilot-sdk oversized-tool divert — see {@link OVERSIZED_PLACEHOLDER_RE})
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

  // copilot-sdk oversized-tool envelope: when the SDK diverts a >~32 KB tool
  // result to a tempfile, it sets `content` to a short placeholder string and
  // stashes the *full* payload under `contents[]` (MCP-standard
  // `[{type:"text", text:...}]`). `detailedContent` is also present but is
  // itself truncated to ~10 KB, so we never read from it.
  if (
    typeof r.content === "string" &&
    OVERSIZED_PLACEHOLDER_RE.test(r.content) &&
    Array.isArray(r.contents)
  ) {
    const fromContents = extractTextBlocks(r.contents);
    if (fromContents !== null) return extractMcpResultText(fromContents);
  }

  if (typeof r.content === "string") {
    return extractMcpResultText(r.content);
  }
  if (Array.isArray(r.content)) {
    const text = extractTextBlocks(r.content);
    if (text !== null) return text;
  }
  if (typeof r.text === "string") return r.text;
  if (typeof r.result === "string") return extractMcpResultText(r.result);
  if (typeof r.detailedContent === "string") return r.detailedContent;

  return null;
}

const OVERSIZED_PLACEHOLDER_RE = /^Output too large to read at once \(/;

function extractTextBlocks(blocks: unknown[]): string | null {
  const parts: string[] = [];
  for (const block of blocks) {
    if (typeof block === "string") parts.push(block);
    else if (block && typeof block === "object") {
      const b = block as { type?: string; text?: string };
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}
