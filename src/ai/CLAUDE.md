# AI Module — Architecture & Rules

## File Overview

| File | Role |
|---|---|
| `connector.ts` | `AiConnector` type + `resolveConnector()` — selects the right AI backend for a bot |
| `executor.ts` | Claude CLI executor — spawns `claude` process, reads NDJSON stdout, handles timeout |
| `prompt-builder.ts` | Assembles system + user prompts from persona, memories, goals, tasks, history |
| `stream-parser.ts` | `StreamParser` class — parses NDJSON stream events, extracts tool calls with timing |
| `tool-status.ts` | Maps MCP tool names to human-friendly status text for real-time UI |
| `tool-restrictions.ts` | Per-user tool allow/deny lists, builds restriction prompts |
| `embeddings.ts` | Semantic embeddings via HuggingFace `all-MiniLM-L6-v2` (384-dim, quantized) |
| `result-parser.ts` | Legacy JSON parser — fallback when stream parser misses the result event |
| `json-extract.ts` | Extract JSON objects from mixed text output |
| `haiku-extraction.ts` | Shared Haiku executor for async extraction tasks (memories, goals, tasks) |
| `huginn-trace.ts` | Inline-fence Huginn trace handling (legacy mode) — `parseHuginnTrace`, `extractMcpResultText`, oversized-CLI-divert recovery |
| `huginn-trace-pointer.ts` | Phase 2 out-of-band trace channel — parses `huginn-trace-url:` line and fetches the trace from Huginn's `/api/trace/<id>` endpoint. Preferred when `HUGINN_TRACE_POINTER=1` is set on Huginn. Also exports `processMcpToolResult()` — the unwrap → peel → fetch pipeline connectors run on every tool result |
| `connectors/` | Three connector implementations (see below) |

## Connector Abstraction

```
AiConnector = (prompt, config, botConfig, systemPrompt?, onProgress?) => Promise<ClaudeExecResult>
```

`resolveConnector(botConfig)` returns the appropriate executor. Connectors are lazy-loaded (copilot-sdk, openai-compat) to avoid importing heavy deps at startup.

### Connector Implementations

| File | Type | How it works |
|---|---|---|
| `connectors/claude-cli.ts` | `claude-cli` | Spawns `claude` CLI with `--output-format stream-json --verbose`. Reads NDJSON. CWD = bot dir for MCP/settings discovery. |
| `connectors/copilot-sdk.ts` | `copilot-sdk` | Shared CopilotClient singleton, per-request sessions. Reads `.mcp.json` and converts to SDK format. Emits intent events. |
| `connectors/openai-compat.ts` | `openai-compat` | Calls any OpenAI-compatible API. Agent loop with MCP tool execution. Handles Qwen3 thinking tokens. |

Supporting files: `copilot-mcp.ts` (MCP config conversion for SDK), `openai-compat-tools.ts` (MCP tool execution), `openai-compat-stream.ts` (streaming response handling).

## Stream Parser (stream-parser.ts)

Parses Claude CLI NDJSON output line-by-line for real-time progress:

- `StreamProgressEvent`: `tool_start`, `tool_end`, `text`, `text_delta`, `intent`
- Tool timing: computed from line arrival timestamps (feed lines as they arrive, not all at once)
- `formatToolDisplayName()`: converts `mcp__server__tool` to `tool (server)`
- Falls back to `result-parser.ts` if no result event received (known CLI bug)

## Prompt Builder (prompt-builder.ts)

Assembles prompts from multiple sources in parallel:

1. **System prompt**: persona (CLAUDE.md) + user identity + tool restrictions + memories + goals + scheduled tasks + recent alerts
2. **User prompt**: conversation history (in `<conversation_history>` tags) + current message

Parallel fetches: recent messages, embedding generation, active goals, scheduled tasks, recent alerts, then hybrid memory search.

## Tool Status (tool-status.ts)

Normalizes tool names across connector formats to `{server}/{tool}`:
- Claude CLI: `mcp__server__tool`
- Copilot SDK: `server-tool` (dash-separated, greedy server matching)

Maps to human-friendly labels (e.g. "Searching email", "Checking calendar") with optional detail extraction from tool input JSON.

## Tool Restrictions (tool-restrictions.ts)

Per-bot config defines tool groups with allowed user lists. `buildToolRestrictionPrompt()` generates system prompt instructions telling Claude to deny access. Prompt is in Norwegian (matching bot persona).

## Embeddings (embeddings.ts)

- Model: `Xenova/all-MiniLM-L6-v2` (quantized q8) via `@huggingface/transformers`
- Lazy-loaded singleton with `warmupEmbeddings()` for pre-loading at startup
- Returns `number[] | null` (null on failure — graceful degradation)
- Used by prompt builder for hybrid memory search

## Testing

| File | What it tests |
|---|---|
| `connector.test.ts` | Connector resolution, lazy loading |
| `executor.test.ts` | Claude CLI spawning, timeout, output parsing |
| `stream-parser.test.ts` | NDJSON parsing, tool timing, edge cases |
| `prompt-builder.test.ts` | Prompt assembly, memory/goal formatting |
| `tool-status.test.ts` | Tool name parsing, status text generation |
| `tool-restrictions.test.ts` | Allow/deny logic, prompt generation |
| `result-parser.test.ts` | Legacy JSON parsing fallback |
| `json-extract.test.ts` | JSON extraction from mixed text |

## Common Pitfalls

1. **Stream parser timing**: Tool durations are only accurate if lines are fed in real-time (not buffered).
2. **Lazy connector loading**: First call to copilot-sdk/openai-compat incurs import overhead — the wrapper handles this transparently.
3. **CLI --verbose flag**: Required with `-p` flag for stream-json output — omitting it produces incomplete output.
4. **MCP config path**: CLI discovers `.mcp.json` from git root, not CWD. Bot dirs must pass `--mcp-config` explicitly.
5. **Fallback parser**: If stream parser fails, raw lines are joined and parsed by `result-parser.ts` — both code paths must be maintained.
