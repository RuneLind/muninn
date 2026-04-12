import type { ClaudeResult, ToolCall } from "../types.ts";

/**
 * Parses NDJSON lines from Claude CLI `--output-format stream-json`.
 *
 * Extracts: final text result, usage/cost, model, tool calls with timing.
 *
 * Expected event flow (without --include-partial-messages):
 *   system    → session init
 *   assistant → content blocks (text + tool_use)
 *   user      → tool_result blocks
 *   assistant → next turn text
 *   result    → final summary
 *
 * Tool timing is computed from timestamps recorded when lines are parsed.
 * For accurate timing, feed lines as they arrive (not all at once after process exits).
 */

export type StreamProgressEvent =
  | { type: "tool_start"; name: string; displayName: string; input?: string }
  | { type: "tool_end"; name: string; displayName: string }
  | { type: "text" }
  | { type: "text_delta"; text: string }
  | { type: "intent"; text: string };

export type StreamProgressCallback = (event: StreamProgressEvent) => void;

interface TimestampedLine {
  line: string;
  timestamp: number; // performance.now()
}

interface PendingToolCall {
  id: string;
  name: string;
  input: unknown;
  /** Timestamp when the assistant message containing this tool_use was received */
  startTimestamp: number;
  /** Tool result, populated when the matching user → tool_result arrives */
  output?: string;
}

export class StreamParser {
  private resultText = "";
  private costUsd = 0;
  private durationMs = 0;
  private durationApiMs = 0;
  private numTurns = 1;
  private model = "unknown";
  private inputTokens = 0;
  private outputTokens = 0;
  private toolCalls: ToolCall[] = [];
  private pendingTools: PendingToolCall[] = [];
  private hasResult = false;
  /** Reference timestamp (performance.now()) for computing tool startOffsetMs */
  private refTimestamp: number;
  private onProgress?: StreamProgressCallback;

  /**
   * @param referenceTimestamp - performance.now() at CLI spawn time, used to compute tool startOffsetMs
   * @param onProgress - optional callback fired when tool events or text are detected
   */
  constructor(referenceTimestamp: number = performance.now(), onProgress?: StreamProgressCallback) {
    this.refTimestamp = referenceTimestamp;
    this.onProgress = onProgress;
  }

  /**
   * Parse a single NDJSON line with its arrival timestamp.
   * Lines that fail to parse are silently ignored.
   */
  parseLine(line: string, timestamp?: number): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return; // Malformed JSON — skip
    }

    const ts = timestamp ?? performance.now();
    const type = event.type;

    if (type === "assistant") {
      this.handleAssistant(event, ts);
    } else if (type === "user") {
      this.handleUser(event, ts);
    } else if (type === "result") {
      this.handleResult(event);
    } else if (type === "stream_event") {
      this.handleStreamEvent(event);
    }
    // "system" type is ignored
  }

  /** Parse all lines from completed stdout (no real-time timestamps). */
  parseAll(stdout: string): void {
    for (const line of stdout.split("\n")) {
      if (line.trim()) this.parseLine(line);
    }
  }

  private handleAssistant(event: any, timestamp: number): void {
    const content = event.message?.content;
    if (!Array.isArray(content)) return;

    // Extract model from assistant message
    if (event.message?.model) {
      this.model = event.message.model;
    }

    // Resolve any pending tool calls — the assistant responding means tools finished
    this.resolvePendingTools(timestamp);

    let hasToolUse = false;
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        // Accumulate text (last assistant text block is the final answer)
        this.resultText = block.text;
      } else if (block.type === "tool_use") {
        hasToolUse = true;
        const displayName = formatToolDisplayName(block.name);
        this.pendingTools.push({
          id: block.id,
          name: block.name,
          input: block.input,
          startTimestamp: timestamp,
        });
        this.onProgress?.({ type: "tool_start", name: block.name, displayName, input: abbreviateInput(block.input) });
      }
    }

    // Fire text event if assistant responded with text and no tool calls
    if (!hasToolUse && this.resultText && this.onProgress) {
      this.onProgress({ type: "text" });
    }
  }

  private handleUser(event: any, timestamp: number): void {
    // User message = tool results. Extract tool_result blocks matching pending tools by tool_use_id.
    const content = event.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== "tool_result") continue;
        const useId = block.tool_use_id;
        if (typeof useId !== "string") continue;
        const pending = this.pendingTools.find((p) => p.id === useId);
        if (pending) pending.output = truncateOutput(extractToolResultContent(block));
      }
    }
    // Resolve pending tools with this timestamp.
    this.resolvePendingTools(timestamp);
  }

  private resolvePendingTools(endTimestamp: number): void {
    for (const pending of this.pendingTools) {
      const durationMs = Math.max(0, Math.round(endTimestamp - pending.startTimestamp));
      const startOffsetMs = Math.max(0, Math.round(pending.startTimestamp - this.refTimestamp));
      const displayName = formatToolDisplayName(pending.name);
      this.toolCalls.push({
        id: pending.id,
        name: pending.name,
        displayName,
        durationMs,
        startOffsetMs,
        input: abbreviateInput(pending.input),
        output: pending.output,
      });
      this.onProgress?.({ type: "tool_end", name: pending.name, displayName });
    }
    this.pendingTools = [];
  }

  private handleResult(event: any): void {
    this.hasResult = true;

    if (typeof event.result === "string") {
      this.resultText = event.result;
    }
    if (event.is_error) {
      throw new Error(`Claude error: ${event.result ?? "unknown error"}`);
    }

    this.costUsd = event.total_cost_usd ?? event.cost_usd ?? 0;
    this.durationMs = event.duration_ms ?? 0;
    this.durationApiMs = event.duration_api_ms ?? 0;
    this.numTurns = event.num_turns ?? 1;

    if (event.usage) {
      this.inputTokens =
        (event.usage.input_tokens ?? 0) +
        (event.usage.cache_creation_input_tokens ?? 0) +
        (event.usage.cache_read_input_tokens ?? 0);
      this.outputTokens = event.usage.output_tokens ?? 0;
    }

    // Model from result if not already set
    if (event.model && this.model === "unknown") {
      this.model = event.model;
    }
  }

  private handleStreamEvent(event: any): void {
    const inner = event.event;
    if (!inner) return;
    // content_block_delta with text_delta = streaming text token
    if (inner.type === "content_block_delta" && inner.delta?.type === "text_delta" && typeof inner.delta.text === "string") {
      this.onProgress?.({ type: "text_delta", text: inner.delta.text });
    }
  }

  /** Get the parsed result. Throws if no result event was received. */
  getResult(): ClaudeResult {
    if (!this.hasResult) {
      throw new Error("No result event in stream-json output");
    }

    return {
      result: this.resultText,
      costUsd: this.costUsd,
      durationMs: this.durationMs,
      durationApiMs: this.durationApiMs,
      numTurns: this.numTurns,
      model: this.model,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      toolCalls: this.toolCalls.length > 0 ? this.toolCalls : undefined,
    };
  }

  /** Whether a result event has been received */
  get complete(): boolean {
    return this.hasResult;
  }
}

/**
 * Format MCP tool name into a readable display name.
 * "mcp__gmail__search_emails" → "search_emails (gmail)"
 * "mcp__claude_ai_Context7__query-docs" → "query-docs (claude_ai_Context7)"
 * "Read" → "Read"
 *
 * MCP tool names follow the pattern: mcp__<server>__<tool>
 * where server name can contain underscores (e.g. claude_ai_Context7).
 * We split on the FIRST and LAST double-underscore to get server and tool.
 */
export function formatToolDisplayName(name: string): string {
  if (!name.startsWith("mcp__")) return name;
  const withoutPrefix = name.slice(5); // remove "mcp__"
  const lastDoubleUnderscore = withoutPrefix.lastIndexOf("__");
  if (lastDoubleUnderscore === -1) return name;
  const server = withoutPrefix.slice(0, lastDoubleUnderscore);
  const tool = withoutPrefix.slice(lastDoubleUnderscore + 2);
  return `${tool} (${server})`;
}

/** Abbreviate tool input to max 500 chars */
function abbreviateInput(input: unknown): string | undefined {
  if (input == null) return undefined;
  const json = JSON.stringify(input);
  if (json.length <= 500) return json;
  return json.slice(0, 497) + "...";
}

/**
 * Normalize a Claude CLI `tool_result` block into a plain string for storage.
 *
 * The `content` field can be:
 *   - a string (the common case)
 *   - an array of content blocks: `[{type: "text", text: "..."}, ...]`
 *   - null / undefined when the tool produced nothing useful
 *
 * Non-text blocks (images, etc.) are represented by a short placeholder since
 * we only store textual results for benchmarking.
 */
function extractToolResultContent(block: { content?: unknown }): unknown {
  const raw = block.content;
  if (raw == null) return undefined;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const part of raw) {
      if (typeof part === "string") {
        parts.push(part);
      } else if (part && typeof part === "object") {
        const p = part as { type?: string; text?: string };
        if (p.type === "text" && typeof p.text === "string") {
          parts.push(p.text);
        } else if (p.type) {
          parts.push(`[${p.type}]`);
        }
      }
    }
    return parts.join("\n");
  }
  return raw; // fall through — will be JSON-stringified by truncateOutput
}

/** Maximum bytes (UTF-8) stored for a single tool call output. */
export const TOOL_OUTPUT_MAX_BYTES = 16 * 1024; // 16 KB

/**
 * Serialize and cap a tool output for storage on a trace span.
 *
 * - Strings are stored as-is (up to the cap)
 * - Other values are JSON-stringified
 * - Over-cap payloads are replaced with `{"_truncated": true, "_originalBytes": N, "head": "…first N bytes…"}`
 *   so downstream consumers can detect truncation without guessing
 */
export function truncateOutput(value: unknown): string | undefined {
  if (value == null) return undefined;
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= TOOL_OUTPUT_MAX_BYTES) return text;
  // Slice by bytes, not chars, then trim any partial UTF-8 sequence from the tail
  const head = Buffer.from(text, "utf8").subarray(0, TOOL_OUTPUT_MAX_BYTES).toString("utf8");
  return JSON.stringify({ _truncated: true, _originalBytes: bytes, head });
}
