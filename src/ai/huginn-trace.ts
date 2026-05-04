import { readFileSync, writeFileSync } from "node:fs";
import { getLog } from "../logging.ts";
import { parseHuginnTracePointer } from "./huginn-trace-pointer.ts";

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

/** Logs trace env-var state once per process so devs can confirm what spawned MCP children will inherit. */
let traceFlagsLogged = false;
export function logTraceFlagsOnce(): void {
  if (traceFlagsLogged) return;
  traceFlagsLogged = true;
  log.info(
    "Trace env: HUGINN_TRACE_POINTER={huginnPointer} HUGINN_TRACE_DEFAULT={huginnDefault} YGGDRASIL_TRACE_POINTER={yggPointer} YGGDRASIL_TRACE_DEFAULT={yggDefault}",
    {
      huginnPointer: process.env.HUGINN_TRACE_POINTER ?? "unset",
      huginnDefault: process.env.HUGINN_TRACE_DEFAULT ?? "unset",
      yggPointer: process.env.YGGDRASIL_TRACE_POINTER ?? "unset",
      yggDefault: process.env.YGGDRASIL_TRACE_DEFAULT ?? "unset",
    },
  );
}

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

/**
 * Claude CLI's placeholder when it diverts an oversized MCP tool result to disk.
 * Capture group 1 is the saved file path. The CLI also writes "Format: JSON
 * with schema: {result: string}" so the file is `{"result":"<text>"}`.
 */
// Anchor on `.\s` (sentence-closing period followed by newline/whitespace) so
// internal periods inside the path (".claude", ".txt", …) don't terminate the
// match early.
const CLAUDE_CLI_OVERSIZED_RE =
  /^Error: result \(\d[\d,]*\s*characters\) exceeds maximum allowed tokens\.\s*Output has been saved to (.+?)\.\s/;

export interface OversizedRecovery {
  /** Path to the saved tool-result file. */
  filePath: string;
  /** Parsed Huginn trace (null if no fence in the file, or pointer-mode). */
  trace: unknown | null;
  /** Phase 2 trace fetch URL — populated when the diverted file ended with a
   *  `huginn-trace-url:` line instead of an inline fence. Mutually exclusive
   *  with `trace` (server is in either fence-mode or pointer-mode, not both). */
  tracePointer: string | null;
  /** True if the file was rewritten with the trace fence/pointer stripped —
   *  only happens when `stripTraceFromFile` is set and a trace marker was
   *  actually found. */
  rewritten: boolean;
}

/**
 * Recover the Huginn trace (and optionally strip the fence) when Claude CLI
 * diverted a tool result to disk because it exceeded MAX_MCP_OUTPUT_TOKENS.
 *
 * The CLI hands the model a placeholder pointing at a file on disk. Without
 * this, neither Muninn nor any downstream parser ever sees the trace, and
 * when the model later reads the file it pulls the ~14 KB fence right back
 * into context. By rewriting the file with the fence removed, the model
 * reads a smaller, fence-free result on its next Read call.
 *
 * Returns null when the input is not the divert placeholder. Best-effort:
 * file IO failures yield `{trace: null, rewritten: false}` rather than
 * throwing, so the caller can degrade gracefully.
 */
export function recoverOversizedClaudeCliToolResult(
  placeholderText: string,
  opts: { stripTraceFromFile?: boolean } = {},
): OversizedRecovery | null {
  const match = placeholderText.match(CLAUDE_CLI_OVERSIZED_RE);
  if (!match) return null;
  const filePath = match[1]!;

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (e) {
    log.warn("Could not read CLI-diverted tool result at {path}: {error}", {
      path: filePath,
      error: e instanceof Error ? e.message : String(e),
    });
    return { filePath, trace: null, tracePointer: null, rewritten: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { filePath, trace: null, tracePointer: null, rewritten: false };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { filePath, trace: null, tracePointer: null, rewritten: false };
  }
  const obj = parsed as { result?: unknown };
  if (typeof obj.result !== "string") {
    return { filePath, trace: null, tracePointer: null, rewritten: false };
  }

  // Try Phase 2 pointer first — Huginn in pointer-mode appends a single
  // `huginn-trace-url:` line at the end of the result. Fence-mode is the
  // legacy fallback for unflipped Huginn instances.
  const pointer = parseHuginnTracePointer(obj.result);
  if (pointer.fetchUrl !== null) {
    let rewritten = false;
    if (opts.stripTraceFromFile !== false) {
      try {
        writeFileSync(filePath, JSON.stringify({ ...obj, result: pointer.text }), "utf8");
        rewritten = true;
      } catch (e) {
        log.warn("Could not strip pointer line from {path}: {error}", {
          path: filePath,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return { filePath, trace: null, tracePointer: pointer.fetchUrl, rewritten };
  }

  const { text: cleanedText, trace } = parseHuginnTrace(obj.result);

  let rewritten = false;
  if (trace !== null && opts.stripTraceFromFile !== false) {
    try {
      writeFileSync(filePath, JSON.stringify({ ...obj, result: cleanedText }), "utf8");
      rewritten = true;
    } catch (e) {
      log.warn("Could not strip trace from {path}: {error}", {
        path: filePath,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { filePath, trace, tracePointer: null, rewritten };
}

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
