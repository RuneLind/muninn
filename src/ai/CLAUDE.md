# AI Module — Architecture & Rules

## File Overview

| File | Role |
|---|---|
| `connector.ts` | `AiConnector` type + `resolveConnector()` — selects the right AI backend for a bot |
| `one-shot.ts` | `executeOneShot()` — one-shot (batch/background) prompt→text seam that routes through `resolveConnector`, so summarizers + research synthesis honor the bot's connector (not a raw CLI spawn). Plus `connectorCapabilities()` — `supportsExtraDirs` (`claude-cli` via `--add-dir` **and** `claude-sdk` via `additionalDirectories`, used by the TikTok frame-reading pre-flight; delivered per-connector — CLI folds `extraDirs` into `--add-dir` spawnArgs, SDK reads them off `botConfig.extraDirs`), `supportsThinkingBudget`, and `supportsWebTools` (`claude-cli`/`claude-sdk` only — both surface WebFetch; used by the wiki Fact check route's pre-flight to `app_error` cleanly on a Copilot/OpenAI-compat bot). |
| `executor.ts` | Claude CLI executor — spawns `claude` process, reads NDJSON stdout, handles timeout |
| `prompt-builder.ts` | Assembles system + user prompts from persona, memories, goals, tasks, history |
| `stream-parser.ts` | `StreamParser` class — parses NDJSON stream events, extracts tool calls with timing |
| `tool-status.ts` | Maps MCP tool names to human-friendly status text for real-time UI |
| `tool-restrictions.ts` | Per-user tool allow/deny lists, builds restriction prompts |
| `embeddings.ts` | Semantic embeddings via HuggingFace `all-MiniLM-L6-v2` (384-dim, quantized) |
| `result-parser.ts` | Legacy JSON parser — fallback when stream parser misses the result event |
| `json-extract.ts` | Extract JSON objects from mixed text output |
| `mcp-tool-caller.ts` | MCP debug client — connect to MCP servers (stdio or HTTP), list/call tools, connection pool keyed by `bot:server`. Consumed by the `openai-compat` connector (tool execution) plus the dashboard MCP debug page and Serena. Moved here from `dashboard/` in the 2026-06 layering cleanup so `ai/` no longer imports up from `dashboard/`. |
| `knowledge-api-client.ts` | Knowledge API fetch helper (`fetchKnowledgeApi` + `knowledgeApiHandler` Hono wrapper, `KnowledgeApiError`) with AbortController timeout. Consumed by `research-knowledge.ts` and several dashboard routes. Also moved out of `dashboard/routes/` in the 2026-06 layering cleanup. |
| `haiku-extraction.ts` | Shared async-extraction wrapper (memory, goal, schedule). Routes through `callHaikuWithFallback` so each call picks the backend from the bot's connector (copilot-sdk → Copilot, else CLI) with the CLI as final fallback — on `MUNINN_PROFILE=nais` that last step throws `HaikuCliUnavailableError` instead (see below). |
| `haiku-direct.ts` | Haiku router with three backends — `cli` (Claude CLI subprocess), `anthropic` (`@anthropic-ai/sdk`), and `copilot` (`@github/copilot-sdk`, reuses the shared CopilotClient singleton). `callHaikuWithFallback` picks the backend via `resolveBackend()` (explicit `opts.backend` → `HAIKU_BACKEND` env → legacy `HAIKU_DIRECT_ENABLED=1` alias for anthropic → per-bot default from `opts.connector` → `cli` floor), then falls back to the CLI on any error — **except on `MUNINN_PROFILE=nais`, where there is no CLI**: the refusal lives in `spawnHaiku` (`haiku-cli-unavailable.ts`, one door, so the watchers that call it directly are covered too) and the router only hands down which backend it tried and why, so the thrown `HaikuCliUnavailableError` names the missing credential. Used by `knowledge-decomposer.ts` (research_knowledge hot path) and `haiku-extraction.ts` (memory / goal / schedule extractors). ~6× speedup vs CLI on the decomposer prompt. |
| `haiku-cli-unavailable.ts` | `HaikuCliUnavailableError` + `assertHaikuCliAvailable(botName, fallback?)` — the `nais` profile's refusal to spawn a Claude CLI the image does not ship. Called from `spawnHaiku` before the spawn; its own module because `src/scheduler/executor.ts` throws it and `haiku-direct.ts` re-exports it, and importing one from the other would be a cycle. |
| `vertex-access.ts` | Reaching **Vertex AI** over plain HTTP, for the connectors that speak HTTP themselves (the Agent SDK reads its own env names — see `resolveVertexConfig`). Three things: `isVertexEndpoint` (host-based, so a Vertex `baseUrl` needs no new config field — a static `OPENAI_API_KEY` against a Vertex host is a guaranteed 401, measured, so nothing else could have been meant), `assertVertexEndpointAllowed` (refuses the `global` region through BOTH doors the OpenAI-compatible URL offers — the host prefix and `/locations/global/` in the resource path, which Vertex takes as authoritative however European the hostname reads) and `VertexTokenProvider` (a cached, single-flighted ADC access token: metadata server first with a 700 ms budget, `gcloud auth application-default print-access-token` second at ~700 ms a call). gcloud's reported expiry is deliberately NOT parsed — `--format=json`, the obvious way to ask, prints the OAuth client secret and the refresh token — so a gcloud token is trusted for a conservative 30 min and the 401 retry below covers a wrong guess at the cost of one round trip. |
| `huginn-trace.ts` | Inline-fence Huginn trace handling (legacy mode) — `parseHuginnTrace`, `extractMcpResultText`, oversized-CLI-divert recovery |
| `huginn-trace-pointer.ts` | Phase 2 out-of-band trace channel — parses `huginn-trace-url:` line and fetches the trace from Huginn's `/api/trace/<id>` endpoint. Preferred when `HUGINN_TRACE_POINTER=1` is set on Huginn. Also exports `processMcpToolResult()` — the unwrap → peel → fetch pipeline connectors run on every tool result |
| `connectors/` | Four connector implementations (see below) |

## Connector Abstraction

```
AiConnector = (prompt, config, botConfig, systemPrompt?, onProgress?) => Promise<ClaudeExecResult>
```

`resolveConnector(botConfig)` returns the appropriate executor. Connectors are lazy-loaded (copilot-sdk, openai-compat, claude-sdk) to avoid importing heavy deps at startup.

### Connector Implementations

| File | Type | How it works |
|---|---|---|
| `connectors/claude-cli.ts` | `claude-cli` | Spawns `claude` CLI with `--output-format stream-json --verbose`. Reads NDJSON. CWD = bot dir for MCP/settings discovery. |
| `connectors/copilot-sdk.ts` | `copilot-sdk` | Shared CopilotClient singleton, per-request sessions. Reads `.mcp.json` and converts to SDK format. Emits intent events. |
| `connectors/openai-compat.ts` | `openai-compat` | Calls any OpenAI-compatible API. Agent loop with MCP tool execution. Handles Qwen3 thinking tokens. |
| `connectors/claude-sdk.ts` | `claude-sdk` | Anthropic's `@anthropic-ai/claude-agent-sdk` `query()` iterable. Per-request lifecycle, `bypassPermissions` (trusts MCP servers), `settingSources: []` (full prompt comes from prompt-builder). Auth from `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` — same env surface as `haiku-direct.ts`. Maps `thinkingMaxTokens`→`thinking` (`resolveThinking`: `0`⇒`{type:"disabled"}`, else `{type:"enabled",budgetTokens}`), `extraDirs`→`additionalDirectories` (TikTok frame-reading — see `connectorCapabilities`), `allowedTools`→the SDK `tools` option (built-in base set — the SDK's own `allowedTools` only suppresses prompts and restricts nothing under `bypassPermissions`), `excludedTools`→`disallowedTools` (fences MCP tools too). Use for bots that want a direct Anthropic chat transport without the Claude CLI subprocess or a Copilot subscription. |

**claude-sdk permission surface:** because it runs `bypassPermissions`, the SDK grants every tool unless narrowed via the `tools`/`disallowedTools` mappings above. On this machine that faithfully mirrors the *effective* CLI surface: the spawned `claude -p` resolves `~/.claude/settings.json` (`defaultMode: auto`, `Bash` allowed) on top of `bots/<name>/.claude/settings.json`. ⚠️ **Corrected 2026-08-12:** this used to read "the per-bot allow-list is dead config", concluded from a probe that ran Bash + Write from `bots/jarvis/` with zero `permission_denials`. That probe could not tell the scopes apart — user-scope already allows both. For `mcp__*` tools, which NO user-scope rule covers, the per-bot file is decisive: moving a spawn's cwd out of the bot folder without passing `--settings` turns `mcp__gmail__search_emails` into *"Gmail search permission not granted"* (measured, and the reason `spawnHaiku` now passes `--settings` alongside `--mcp-config`). To fence a claude-sdk bot below the CLI's permissive surface, set `allowedTools` (built-in base set → SDK `tools`) and/or `excludedTools` (works for MCP tools too → `disallowedTools`) in its config — both plumbed but empty for jarvis to preserve parity at flip time.

**Rollback claude-sdk → claude-cli** (jarvis flipped from cli): do BOTH steps if the SDK/OAuth path is what broke — (1) set `"connector": "claude-cli"` (or delete the field) in `bots/jarvis/config.json` + restart; (2) **only if the OAuth token itself is blocked/rate-limited**, unset `CLAUDE_CODE_OAUTH_TOKEN` in `.env` + restart — the CLI executor inherits the full process env (`executor.ts:67`) and the Claude CLI *prefers* that env token over its stored keychain login, so after a bare flip the CLI would still ride the blocked token. Side effect of unsetting: the `anthropic` Haiku backend (enabled via `HAIKU_DIRECT_ENABLED=1`) uses the same token, so every bot's extractors + the `research_knowledge` decomposer degrade to per-call CLI fallback (still works, slower + warn-noisy). Skip step 2 for a routine connector-preference change. Confirm on `/models`.

**openai-compat auth (`connectors/openai-compat-auth.ts`):** the credential is resolved ONCE per turn from the bot's `baseUrl` — which is where a `global` Vertex endpoint is refused, before the first request — and then consulted before EVERY HTTP request. That per-request part is the change: the connector used to build one `Authorization: Bearer ${OPENAI_API_KEY}` header before the agent loop and reuse it for every turn, which is right for a static key and wrong for a Vertex token that expires inside the thread. Two shapes: the static-key one (today's behaviour, key re-read per request so a rotation lands on the next turn, never asks for a retry) and the Vertex one (ADC bearer token; `x-goog-user-project` deliberately NOT sent — the project-scoped `…/endpoints/openapi` URL does not need it, measured on user ADC, which is the weakest credential shape this runs under). `doStreamRequest` throws a typed `OpenAiCompatHttpError` carrying the status so the retry predicate reads a number rather than matching a status out of a formatted English sentence: **401 → drop the cached token and retry once, 403 → do not** (a valid credential that is not entitled). The retry is safe to re-send because the connector throws on a non-2xx BEFORE reading the body, so a refused request has emitted no `text_delta` to replay.

Supporting files: `copilot-mcp.ts` (MCP config → Copilot shape), `claude-sdk-mcp.ts` (MCP config → Agent SDK shape — strips per-server `cwd` since the SDK has no field for it), `openai-compat-tools.ts` (MCP tool execution), `openai-compat-stream.ts` (streaming response handling), `tool-span.ts` (`recordToolSpan` — the shared tool-completion tail).

### Shared tool-completion tail (`connectors/tool-span.ts`)

All three streaming connectors converge on the same completion work once a tool result arrives: run `processMcpToolResult` → `truncateOutput`, assemble the ~10-field `ToolCall`, and emit a `tool_end` progress event. `recordToolSpan(args)` owns that tail and returns `{ toolCall, toolEndEvent, cleanedText }` — the connector pushes the span, forwards the event, and (openai-compat only) feeds `cleanedText` back into the model's message history. `processMcpToolResult` runs exactly **once** here (it eagerly kicks off pointer-mode trace fetches — calling it twice would double-fetch), so consumers must not call it again on the same payload. `outputSize` is the **post-truncation** length across all three. Both it and `StreamParser` carry one side effect on the way past: the untruncated tool text is handed to `captureKnowledgeToolCitations` (`research/thread-citations.ts`) so huginn `search_knowledge` hits reach `research_citations` — exactly once per tool result, and on the claude-cli path from the RECOVERED body when the CLI diverted an oversized result to disk, since the text the parser was handed is then only a pointer stub. Only the *tail* is shared — the three timing-start models legitimately differ (two event-driven pending maps, one synchronous inline loop) and stay per-connector. Tool **input** is abbreviated at start via `stream-parser.ts`'s `abbreviateInput` (the documented seam) in all three; openai-compat's arguments arrive as a JSON string, so it `safeParseArgs` first to match the object form the SDKs pass. The claude-cli path keeps its own `StreamParser.pushResolved` builder (different start model + trace-peeling), unaffected by this helper.

## Stream Parser (stream-parser.ts)

Parses Claude CLI NDJSON output line-by-line for real-time progress:

- `StreamProgressEvent`: `tool_start`, `tool_end`, `text`, `text_delta`, `intent`. The two tool variants carry a **required `id`** — the connector's own tool-call id (`tool_use.id` / `toolCallId` / `tool_call.id`), the same value that lands on `ToolCall.id`. It is what pairs a start with its end for a consumer that only sees the progress channel (the fact-check claim fan-out rebuilds tool child spans from these when a claim times out); pairing by `displayName` mis-attributes durations whenever two same-named tools are in flight, routine for parallel WebFetch. A new connector must forward it.
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
| `vertex-access.test.ts` | Vertex endpoint detection, the two `global` refusal doors, token cache/refresh-margin/single-flight |
| `connectors/openai-compat-auth.test.ts` | Static vs Vertex credential shape, 401-refresh vs 403-no-retry, refusal at construction |

## Common Pitfalls

1. **Stream parser timing**: Tool durations are only accurate if lines are fed in real-time (not buffered).
2. **Lazy connector loading**: First call to copilot-sdk/openai-compat incurs import overhead — the wrapper handles this transparently.
3. **CLI --verbose flag**: Required with `-p` flag for stream-json output — omitting it produces incomplete output.
4. **MCP config path**: the CLI discovers `.mcp.json` from its **cwd** (verified 2026-08-12 on CLI 2.1.228 — `claude mcp list` in `bots/jarvis/` lists that bot's servers, and muninn's repo root has no `.mcp.json` at all; the older "from git root" note here was wrong). A spawn that does NOT run in the bot folder must pass `--mcp-config` explicitly — and, because relative `args` paths in an stdio entry resolve against the CLI's cwd rather than the config file, must pass a **rewritten** config (`buildInlineMcpConfig` in `mcp-config-utils.ts`), not the file path. `--settings` for the matching permissions is required with it (see the claude-sdk note above).
5. **Fallback parser**: If stream parser fails, raw lines are joined and parsed by `result-parser.ts` — both code paths must be maintained.
