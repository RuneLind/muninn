# Dashboard Module — Architecture & Rules

## File Overview

| File | Role |
|---|---|
| `routes.ts` | Creates Hono sub-router, registers all route modules |
| `activity-log.ts` | `ActivityLog` singleton — in-memory event buffer with DB write-through and pub/sub |
| `agent-status.ts` | `AgentStatusTracker` singleton — tracks active request progress (phase, tools, tokens) |
| `mcp-client.ts` | MCP debug client — connect to MCP servers (stdio or HTTP), list tools, call tools |
| `openapi-spec.ts` | OpenAPI 3.1.0 spec covering all JSON API endpoints |
| `index.ts` | Barrel export: `createDashboardRoutes`, `activityLog` |

## Route Organization

Routes are split by domain in `routes/`:

| File | Endpoints |
|---|---|
| `data-routes.ts` | Main CRUD: messages, memories, goals, tasks, watchers, users, threads, connectors |
| `sse-routes.ts` | SSE streams: `/events` (activity), `/agent-status` (phase), `/request-progress` (waterfall) |
| `traces-routes.ts` | Trace spans: list, detail, waterfall data, cleanup |
| `search-routes.ts` | Knowledge base document search and management |
| `research-routes.ts` | Jira research: trigger analysis, post to chat |
| `memsearch-routes.ts` | Memory semantic search (hybrid FTS + vector) |
| `logs-routes.ts` | Log file viewer (JSONL files from LogTape) |
| `tools-routes.ts` | MCP tool debug: connect, list, call, disconnect |
| `youtube-routes.ts` | YouTube transcript fetch and summarization |
| `route-utils.ts` | Shared helpers: UUID validation, pagination parsing |

## View System

All pages are server-side rendered HTML via template literals. No build step, no framework.

### Component Pattern

Each component in `views/components/` exports up to three functions:

- `*Styles()` — returns a CSS string (injected into `<style>`)
- `*Html()` — returns an HTML string (injected into `<body>`)
- `*Script()` — returns a JavaScript string (injected into `<script>`)

Pages (`views/*.ts`) compose components by calling all three and concatenating into a full HTML document.

### Shared Infrastructure

- `views/shared-styles.ts` — CSS variables (colors, spacing), base reset, header, nav. Imported by all pages.
- `views/components/helpers.ts` — Inline JS utilities: `esc()` (HTML escaping), `extractToolInputLabel()`, formatting helpers.

### Pages

`page.ts` (main dashboard), `traces-page.ts`, `search-page.ts`, `search-document-page.ts`, `research-page.ts`, `memsearch-page.ts`, `logs-page.ts`, `mcp-debug-page.ts`, `serena-page.ts`, `youtube-page.ts`.

## Real-Time Updates

### SSE Endpoints (sse-routes.ts)

- `/events` — activity feed events (message_in, message_out, memory, error, etc.)
- `/agent-status` — phase changes (idle, calling_claude, transcribing, etc.)
- `/request-progress` — full waterfall data (tools with timing, tokens, model)

### Agent Status (agent-status.ts)

Tracks the lifecycle of a single active request:

1. `startRequest()` — creates RequestProgress with requestId
2. `toolStart()`/`toolEnd()` — records tool calls with timing
3. `completeRequest()` — marks done, auto-clears after 30s
4. Phases: `idle`, `receiving`, `transcribing`, `building_prompt`, `calling_claude`, `saving_response`, `sending_telegram`, `sending_slack`, `synthesizing_voice`, `running_task`, `checking_goals`, `running_watcher`

### Activity Log (activity-log.ts)

- In-memory ring buffer (max 500 events) + fire-and-forget DB persistence
- `loadFromDb()` called after DB init to hydrate on startup
- `stats` getter: messages today, avg response time, total cost

## MCP Debug Client (mcp-client.ts)

- Supports both stdio (spawn process) and HTTP (StreamableHTTP) transports
- Connection pool keyed by `bot:server` — reuses existing connections
- Timeouts: 30s connect, 120s tool call
- Used by both the MCP debug page and Serena management

## Common Pitfalls

1. **SSE format**: Events must be `data: JSON\n\n` — missing double newline breaks the stream.
2. **Agent status is global**: Only one active request tracked at a time — concurrent requests overwrite.
3. **Component pattern**: Always export all three (*Styles, *Html, *Script) even if empty — pages expect them.
4. **MCP connection cleanup**: Always call `disconnectServer()` or `disconnectAll()` — leaked stdio processes stay alive.
