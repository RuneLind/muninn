import type { Tracer } from "../tracing/index.ts";
import type { ToolCall } from "../types.ts";
import { getToolStatus } from "../ai/tool-status.ts";
import { parseHuginnTrace } from "../ai/huginn-trace.ts";
import { emitSearchTraceSpans } from "./search-trace-spans.ts";

/**
 * Trace-marker-emitting MCP tools whose spans benefit from an env snapshot.
 * Pairs both connector formats (claude-cli's `mcp__server__tool` and
 * copilot-sdk's `server-tool`) so dispatch is independent of toolName shape.
 */
const TRACE_EMITTING_PREFIXES = [
  "mcp__knowledge__",
  "knowledge-",
  "mcp__yggdrasil__",
  "yggdrasil-",
] as const;

export interface McpEnvIntended {
  huginnTracePointer: string | null;
  huginnTraceDefault: string | null;
}

/**
 * Capture the trace env muninn currently passes to MCP children, on tool spans
 * that depend on it. Stable across calls within one process; diagnostic value
 * is in pairing with the startup adapter audit — if the audit shows a stale
 * adapter and a span shows the current intended env, the discrepancy explains
 * a missing searchTrace.
 *
 * Returns null for tool spans that don't go through a trace-emitting MCP, so
 * non-search tools don't get a noise attribute.
 */
export function mcpEnvSnapshotForTool(toolName: string): McpEnvIntended | null {
  if (!TRACE_EMITTING_PREFIXES.some((p) => toolName.startsWith(p))) return null;
  return {
    huginnTracePointer: process.env.HUGINN_TRACE_POINTER ?? null,
    huginnTraceDefault: process.env.HUGINN_TRACE_DEFAULT ?? null,
  };
}

/**
 * Resolve any Phase-2 trace pointers in the connector result, then create
 * child spans (and synthesized stage sub-spans for v1 search traces) under
 * the `claude` parent span.
 *
 * Phase-2 pointers were started eagerly by the connector the moment they were
 * peeled (see {@link ToolCall.searchTraceFetch}) — we just await the in-flight
 * promises here. The eager start is essential: huginn's trace store has a
 * short TTL, and a multi-tool claude session can run for many minutes, which
 * used to 404 every pointer emitted at the start of the session. Fail-soft:
 * a null fetch leaves the span without `searchTrace`, never breaks the
 * user-visible response.
 */
export async function attachToolSpans(
  tracer: Tracer,
  toolCalls: ToolCall[] | undefined,
  captureOutputs: boolean,
  /** Label of the parent span the tool child spans hang under. Defaults to the
   *  hard-wired `"claude"` span (the single model call). The fact-check claim
   *  fan-out passes an indexed label (`claude:claim-<i>`) because it runs N
   *  concurrent verify calls, each its own label-keyed span. */
  parentLabel = "claude",
): Promise<void> {
  if (!toolCalls || toolCalls.length === 0) return;

  const pointerTools = toolCalls.filter(
    (tc) => tc.searchTraceFetch && tc.searchTrace === undefined,
  );
  if (pointerTools.length > 0) {
    const fetched = await Promise.allSettled(pointerTools.map((tc) => tc.searchTraceFetch!));
    for (let i = 0; i < pointerTools.length; i++) {
      const r = fetched[i]!;
      if (r.status === "fulfilled" && r.value !== null) {
        pointerTools[i]!.searchTrace = r.value;
      }
    }
  }

  for (const tool of toolCalls) {
    const attrs: Record<string, unknown> = {
      toolId: tool.id,
      toolName: tool.name,
      input: tool.input,
      statusText: getToolStatus(tool.name, tool.input),
    };
    // Snapshot the trace env muninn intends MCP children to inherit, so a
    // missing searchTrace can be diagnosed against the current process'
    // configuration rather than guessed at. The actual adapter env may
    // diverge if the adapter is a stale orphan from a previous run — see
    // the startup adapter audit and `bun run cleanup:kill`.
    const mcpEnv = mcpEnvSnapshotForTool(tool.name);
    if (mcpEnv !== null) attrs.mcpEnvIntended = mcpEnv;
    // Huginn search adapters embed a per-search trace blob in their output
    // when HUGINN_TRACE_DEFAULT=1 is set. Connectors that can intercept the
    // structured tool result (copilot-sdk) extract the trace themselves and
    // pass it through `tool.searchTrace`. For connectors that surface the
    // result as a plain text blob (claude-cli stream parser), fall back to
    // running the parser on the string here. Parser is a no-op otherwise.
    // Phase-2 pointer-mode tools were already resolved above; their
    // `searchTrace` is populated when the fetch succeeded.
    let toolOutput = tool.output;
    if (tool.searchTrace !== undefined) {
      attrs.searchTrace = tool.searchTrace;
    } else if (typeof toolOutput === "string") {
      const { text, trace } = parseHuginnTrace(toolOutput);
      if (trace !== null) {
        attrs.searchTrace = trace;
        toolOutput = text;
      }
    }
    if (captureOutputs && toolOutput !== undefined) {
      attrs.output = toolOutput;
    }
    const toolSpanId = tracer.addChildSpan(parentLabel, tool.displayName, tool.durationMs, attrs, tool.startOffsetMs);

    // If the tool call carries a v1 Huginn search trace, synthesize per-stage
    // child spans so the waterfall shows where the time went without the
    // operator having to expand the trace JSON.
    if (attrs.searchTrace !== undefined) {
      const claudeStart = tracer.spanStartedAt(parentLabel);
      if (claudeStart) {
        const toolStart = new Date(claudeStart.getTime() + (tool.startOffsetMs ?? 0));
        emitSearchTraceSpans({
          tracer,
          toolSpanId,
          toolStartedAt: toolStart,
          searchTrace: attrs.searchTrace,
        });
      }
    }
  }
}
