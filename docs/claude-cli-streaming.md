# Claude CLI Streaming & Tool Monitoring

How Muninn spawns Claude CLI in headless mode, parses the NDJSON stream, and tracks MCP tool usage with per-tool timing — all without an API key.

## Overview

Muninn runs Claude CLI as a subprocess in print mode (`-p`) with `--output-format stream-json`. This gives structured NDJSON output that the stream parser processes line-by-line, extracting the response text, token usage, and every MCP tool call with timing. Tool calls become child spans in the tracing system and show up as orange bars in the dashboard waterfall.

```
User message
  → executor.ts         Spawns `claude -p <prompt> --output-format stream-json --verbose`
    → stdout             NDJSON lines: system, assistant, user, result
    → readLinesWithTimestamps()   Reads lines with performance.now() timestamps
    → StreamParser       Stateful parser: extracts text, usage, tool calls + timing
  ← ClaudeResult         { result, tokens, toolCalls[] }
  → message-processor.ts  Creates child spans for each tool call
  → traces DB            Stored as parent-child span hierarchy
  → /traces dashboard    Waterfall with orange tool bars
```

## Why Streaming

The CLI's `--output-format stream-json` mode emits NDJSON events as Claude works, rather than a single JSON blob at the end. This enables:

1. **Per-tool timing** — timestamps on each line let us measure individual MCP tool durations
2. **Tool call tracking** — tool names, inputs, and durations are captured automatically
3. **Structured parsing** — typed events vs free-text parsing
4. **Error detection** — `is_error` in the result event surfaces CLI-level failures immediately

The `--verbose` flag is **required** when using `-p` (print mode) with `--output-format stream-json` — without it, the CLI exits with code 1.

## NDJSON Event Flow

Each line is a JSON object with a `type` field:

```
{"type":"system",    "subtype":"init", "session_id":"...", "tools":[...]}
{"type":"assistant", "message":{"content":[{"type":"text","text":"Let me check..."}]}}
{"type":"assistant", "message":{"content":[{"type":"tool_use","id":"toolu_01...","name":"mcp__gmail__search_emails","input":{...}}]}}
{"type":"user",      "message":{"content":[{"type":"tool_result","tool_use_id":"toolu_01...","content":"..."}]}}
{"type":"assistant", "message":{"content":[{"type":"text","text":"You have 3 new emails..."}]}}
{"type":"result",    "subtype":"success", "duration_ms":5000, "usage":{"input_tokens":500,"output_tokens":200}, ...}
```

| Event | Meaning |
|---|---|
| `system` | Session init — lists available tools |
| `assistant` | Claude's output — contains `text` and/or `tool_use` blocks |
| `user` | Tool results returned to Claude (injected by CLI) |
| `result` | Final summary — usage, cost, duration, turn count |

## Executor (`src/ai/executor.ts`)

The executor spawns Claude CLI as a Bun subprocess with per-bot isolation:

```typescript
const proc = Bun.spawn(
  ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose", "--model", model],
  { cwd: botConfig.dir, stdout: "pipe", stderr: "pipe", stdin: "ignore" }
);
```

Key design choices:

- **`cwd: botConfig.dir`** — each bot's folder has its own `.mcp.json`, `CLAUDE.md`, and `.claude/settings.json`, so the CLI auto-discovers MCP tools and persona per bot
- **`stdout: "pipe"`** — stdout is consumed line-by-line with `readLinesWithTimestamps()`
- **Timeout** — `Promise.race` with a configurable timeout (default 120s); kills the process on timeout
- **No API key needed** — uses Claude CLI's own authentication (Max subscription)

### Timestamped Line Reading

stdout is read as a stream, not buffered until process exit. Each complete line gets a `performance.now()` timestamp the moment it arrives:

```typescript
async function readLinesWithTimestamps(stdout: ReadableStream<Uint8Array>): Promise<TimestampedLine[]> {
  const reader = stdout.getReader();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      lines.push({ line: buffer.slice(0, newlineIdx), timestamp: performance.now() });
      buffer = buffer.slice(newlineIdx + 1);
    }
  }
}
```

These timestamps are the foundation of per-tool timing — the stream parser uses them to compute how long each tool call took.

## Stream Parser (`src/ai/stream-parser.ts`)

Stateful parser that processes timestamped NDJSON lines and extracts:

- **Result text** — last `text` block from the final `assistant` message
- **Usage** — input/output tokens (including cache tokens) from the `result` event
- **Tool calls** — name, display name, duration, start offset, abbreviated input

### Tool Timing Algorithm

Tool call timing relies on the NDJSON event sequence:

```
assistant message with tool_use  ← tool starts (record timestamp)
    ... CLI executes the MCP tool ...
user message with tool_result    ← tool ends (record timestamp)
```

The parser tracks pending tool calls:

1. **`assistant` event with `tool_use` blocks** — each tool_use is pushed to `pendingTools[]` with its arrival timestamp
2. **`user` event with `tool_result` blocks** — all pending tools are resolved: `duration = user_timestamp - assistant_timestamp`
3. **Next `assistant` event** — also resolves any pending tools (Claude responding means tools finished)

Each resolved tool becomes a `ToolCall`:

```typescript
interface ToolCall {
  id: string;          // "toolu_01T1x..."
  name: string;        // "mcp__gmail__search_emails"
  displayName: string; // "search_emails (gmail)"
  durationMs: number;  // wall-clock duration
  startOffsetMs: number; // offset from CLI spawn for waterfall positioning
  input?: string;      // abbreviated JSON (max 500 chars)
}
```

### MCP Tool Name Formatting

MCP tools follow the naming convention `mcp__<server>__<tool>`. The parser formats these for display:

```
mcp__gmail__search_emails           → search_emails (gmail)
mcp__claude_ai_Context7__query-docs → query-docs (claude_ai_Context7)
Read                                → Read (non-MCP tools unchanged)
```

The parser splits on the first and last `__` to handle server names that contain underscores.

## Fallback: Legacy JSON Parser

The CLI has a known bug ([#1920](https://github.com/anthropics/claude-code/issues/1920)) where the `result` event is occasionally not emitted, causing the stream parser to report incomplete. When this happens, the executor falls back to the legacy `parseClaudeOutput()` which concatenates all lines and tries to find a JSON blob. Tool calls are not tracked in fallback mode, but the response still works.

## Tracing Integration

After the executor returns a `ClaudeResult`, the message processor creates child spans for each tool call:

```typescript
// In message-processor.ts
t.start("claude");
const result = await executeClaudePrompt(prompt, config, botConfig, systemPrompt);
t.end("claude", { model, inputTokens, outputTokens, toolCount });

if (result.toolCalls) {
  for (const tool of result.toolCalls) {
    t.addChildSpan("claude", tool.displayName, tool.durationMs, {
      toolId: tool.id,
      toolName: tool.name,
      input: tool.input,
    }, tool.startOffsetMs);
  }
}
```

`addChildSpan()` creates a pre-completed span positioned at the correct time within the parent `claude` span using `startOffsetMs`. This produces an accurate waterfall even though the tools already finished by the time spans are written.

### Span Hierarchy in the Database

```
traces table:
  telegram_message (root, kind=root)
  ├── db_save_user (kind=span)
  ├── prompt_build (kind=span)
  ├── claude (kind=span, attributes: {model, tokens, toolCount})
  │   ├── search_emails (gmail) (kind=span, attributes: {toolName, toolId, input})
  │   └── get_events (calendar) (kind=span, attributes: {toolName, toolId, input})
  ├── db_save_response (kind=span)
  └── send (kind=span)
```

## Dashboard Waterfall

The `/traces` page renders tool spans with visual distinctions:

| Element | Tool spans | Regular spans |
|---|---|---|
| Bar color | Orange (`#f59e0b`) | Cyan (`#22d3ee`) |
| Indentation | Nested under `claude` parent | Top-level under root |
| List badge | Amber tool count badge in "Tools" column | — |
| Click detail | Shows `toolName`, `toolId`, `input` attributes | Shows generic attributes |

## Key Files

| File | Purpose |
|---|---|
| `src/ai/executor.ts` | Spawns CLI, reads timestamped lines, timeout, fallback |
| `src/ai/stream-parser.ts` | NDJSON parser, tool call extraction + timing |
| `src/ai/stream-parser.test.ts` | 14 tests for parser edge cases |
| `src/ai/result-parser.ts` | Legacy JSON parser (fallback) |
| `src/core/message-processor.ts` | Creates tool child spans via `t.addChildSpan()` |
| `src/tracing/tracer.ts` | Span creation, `addChildSpan()` for pre-computed durations |
| `src/db/traces.ts` | Trace queries, lateral join for toolCount |
| `src/dashboard/views/traces-page.ts` | Waterfall with orange tool bars, tool count badge |
| `src/types.ts` | `ToolCall` and `ClaudeResult` interfaces |
