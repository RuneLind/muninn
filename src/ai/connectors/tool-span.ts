import type { ToolCall } from "../../types.ts";
import type { StreamProgressEvent } from "../stream-parser.ts";
import { formatToolDisplayName } from "../stream-parser.ts";
import { truncateOutput } from "../truncate-output.ts";
import { processMcpToolResult } from "../huginn-trace-pointer.ts";
import { captureKnowledgeToolCitations } from "../../research/thread-citations.ts";
import type { ActiveTurnBinding } from "../../hivemind/active-turn.ts";

/**
 * Inputs for {@link recordToolSpan} — the completion tail shared by the three
 * streaming connectors (claude-sdk, copilot-sdk, openai-compat).
 *
 * Only the *completion* half is unified here. Each connector keeps its own
 * timing-start model (two event-driven pending maps, one synchronous inline
 * loop) because they legitimately differ; by the time we reach the tail all
 * three have the same handful of values.
 */
export interface RecordToolSpanArgs {
  /** Tool-call id (matches the id captured at tool_start). */
  id: string;
  /** Raw tool name, e.g. `mcp__gmail__search_emails`. */
  name: string;
  /**
   * Abbreviated tool input, captured at tool_start via `abbreviateInput`
   * (stream-parser.ts — the documented tool-timing seam). Already truncated;
   * stored verbatim on the span.
   */
  input: string | undefined;
  /**
   * Raw tool result payload (pre-processing). Connectors wrap errors into
   * `{ error: ... }` before passing it here — this helper runs the shared
   * `processMcpToolResult` → `truncateOutput` pipeline on it exactly once.
   */
  rawResult: unknown;
  /** `performance.now()` when the tool started. */
  startMs: number;
  /** `performance.now()` when the tool result arrived. */
  endMs: number;
  /** `performance.now()` at request start — for waterfall `startOffsetMs`. */
  wallStart: number;
  /**
   * The bot whose turn this tool call belongs to.
   *
   * Only used to file huginn `knowledge` search results into
   * `research_citations` against the thread in flight — a connector that omits
   * it still records a perfectly good span, it just leaves the Jira composer's
   * thread-sourced hit set blind to that connector.
   */
  botName?: string;
  /**
   * The turn this tool call belongs to, **captured at connector entry** — see
   * {@link captureKnowledgeToolCitations} for why it is passed rather than read.
   */
  turn: ActiveTurnBinding | null;
}

export interface RecordedToolSpan {
  /** The assembled trace-span entry to push onto the connector's `toolCalls`. */
  toolCall: ToolCall;
  /** The `tool_end` progress event to forward to `onProgress`. */
  toolEndEvent: Extract<StreamProgressEvent, { type: "tool_end" }>;
  /**
   * The unwrapped, *untruncated* tool text (the Huginn trace channel peeled
   * off). openai-compat feeds this back into the model's message history; the
   * other two ignore it. Exposed so the shared `processMcpToolResult` call runs
   * only once (it eagerly kicks off pointer-mode trace fetches).
   */
  cleanedText: string;
}

/**
 * Assemble a tool child span + its `tool_end` event from a completed tool call.
 *
 * Returns the pieces rather than mutating/emitting so it stays pure and unit
 * testable — callers push `toolCall` and forward `toolEndEvent` themselves.
 *
 * `outputSize` on the event is the **post-truncation** length (what the trace
 * actually stores), aligned across all three connectors.
 */
export function recordToolSpan(args: RecordToolSpanArgs): RecordedToolSpan {
  const displayName = formatToolDisplayName(args.name);
  const processed = processMcpToolResult(args.rawResult);
  const truncated = truncateOutput(processed.cleanedText);

  // Fire-and-forget, and deliberately BEFORE truncation: a large result set is
  // cut mid-block by `truncateOutput`, and the tail of it is exactly the hits a
  // refinement discussion tends to lean on. Total by construction — see
  // `research/thread-citations.ts`; it can neither throw nor delay the span.
  captureKnowledgeToolCitations(args.botName, args.name, processed.cleanedText, args.turn);

  const toolCall: ToolCall = {
    id: args.id,
    name: args.name,
    displayName,
    durationMs: Math.round(args.endMs - args.startMs),
    startOffsetMs: Math.round(args.startMs - args.wallStart),
    input: args.input,
    output: truncated,
    searchTrace: processed.searchTrace,
    searchTracePointer: processed.searchTracePointer,
    searchTraceFetch: processed.searchTraceFetch,
  };

  const toolEndEvent = {
    type: "tool_end" as const,
    id: args.id,
    name: args.name,
    displayName,
    outputSize: truncated ? truncated.length : undefined,
  };

  return { toolCall, toolEndEvent, cleanedText: processed.cleanedText };
}
