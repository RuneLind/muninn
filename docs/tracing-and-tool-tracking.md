# Tracing & MCP Tool Tracking

How request tracing works, including MCP tool call tracking in the traces dashboard.

## Overview

Every message processed by a bot creates a **trace** — a tree of timed spans stored in the `traces` table. The traces dashboard (`/traces`) shows a waterfall view of each request's lifecycle.

```
telegram_message (root)
├── db_save_user
├── prompt_build
├── claude                    ← Claude CLI execution
│   ├── search_emails (gmail) ← MCP tool call (orange)
│   └── get_events (calendar) ← MCP tool call (orange)
├── db_save_response
└── send
```

## Architecture

```
User message
  → message-processor.ts    Creates root trace, starts spans
    → executor.ts           Spawns Claude CLI with --output-format stream-json --verbose
      → stream-parser.ts    Parses NDJSON lines, extracts tool calls with timing
    ← ClaudeResult          Includes toolCalls[] array
  → tracer.ts               Creates child spans for each tool call
  → traces DB               Spans stored with parent-child hierarchy
  → traces-page.ts          Waterfall visualization with orange tool bars
```

## Claude CLI Output Format

The executor uses `--output-format stream-json --verbose` (both flags required with `-p`).

NDJSON event flow:
```
{"type":"system","subtype":"init","session_id":"...","tools":[...]}
{"type":"assistant","message":{"content":[{"type":"text","text":"..."},{"type":"tool_use","id":"toolu_01...","name":"mcp__gmail__search_emails","input":{...}}]}}
{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_01...","content":"..."}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"Final answer"}]}}
{"type":"result","subtype":"success","num_turns":2,"duration_ms":5000,"usage":{"input_tokens":500,"output_tokens":200},...}
```

## Tool Call Timing

Stdout is read line-by-line with `performance.now()` timestamps (not buffered). This gives real per-tool duration:

1. `assistant` message with `tool_use` blocks → record tool name + start timestamp
2. `user` message with `tool_result` blocks → record end timestamp
3. Duration = end - start for that turn's tools

Multiple tools in one turn get the same duration (they execute in the CLI process between the two messages).

## Stream Parser (`src/ai/stream-parser.ts`)

Stateful parser that processes NDJSON lines:
- Extracts tool calls from `assistant` message `content` blocks
- Computes per-tool duration from timestamped lines
- Extracts final text, usage, cost from the `result` event
- Formats MCP tool names: `mcp__gmail__search_emails` → `search_emails (gmail)`

## Fallback

If the stream parser can't find a `result` event (known CLI bug #1920 — occasionally missing), the executor falls back to the legacy `parseClaudeOutput()` which expects a single JSON blob. Tool calls won't be tracked in this case, but the response still works.

## Key Files

| File | Purpose |
|---|---|
| `src/ai/stream-parser.ts` | NDJSON parser, tool call extraction |
| `src/ai/stream-parser.test.ts` | 14 tests for parser |
| `src/ai/executor.ts` | Spawns CLI, reads timestamped lines, fallback |
| `src/ai/result-parser.ts` | Legacy JSON parser (fallback) |
| `src/core/message-processor.ts` | Creates tool child spans via `t.addChildSpan()` |
| `src/tracing/tracer.ts` | Span creation, `addChildSpan()` for pre-computed durations |
| `src/db/traces.ts` | DB queries, lateral join for toolCount |
| `src/dashboard/views/traces-page.ts` | Waterfall with orange tool bars, tool count badge |
| `scripts/test-stream-json.ts` | Discovery script for verifying CLI format |

## Types

```typescript
// src/types.ts
interface ToolCall {
  id: string;          // "toolu_01T1x..."
  name: string;        // "mcp__gmail__search_emails"
  displayName: string; // "search_emails (gmail)"
  durationMs: number;
  input?: string;      // abbreviated JSON, max 500 chars
}

interface ClaudeResult {
  // ... existing fields ...
  toolCalls?: ToolCall[];  // present when MCP tools were used
}
```

## Dashboard

Tool spans appear automatically in the waterfall (they're regular `traces` rows with `attributes.toolName`).

Visual differences:
- **Color**: Orange bars (`#f59e0b`) vs cyan for regular spans
- **Indentation**: Nested under the claude span (depth-based)
- **Trace list**: Tool count badge in the "Tools" column (amber, shows count)
- **Span details**: Click a tool bar to see `toolName`, `toolId`, and `input` in the attributes panel
