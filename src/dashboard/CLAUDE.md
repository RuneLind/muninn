# Dashboard Module — Architecture & Rules

## File Overview

| File | Role |
|---|---|
| `routes.ts` | Creates Hono sub-router, registers all route modules |
| `openapi-spec.ts` | OpenAPI 3.1.0 spec covering all JSON API endpoints |
| `index.ts` | Barrel export: `createDashboardRoutes` |

> **Moved out (2026-06, layering cleanup):** the `activity-log` and `agent-status` singletons now live in `src/observability/` (they are imported by core/scheduler/watchers, not just the dashboard — see `src/observability/CLAUDE.md`). The MCP debug client moved to `src/ai/mcp-tool-caller.ts` (the openai-compat connector consumes it, so it belongs in the lower `ai/` layer). The dashboard still consumes all three; only the source-of-truth directory changed.

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
| `graph-routes.ts` | Knowledge graph page + wikilink edge extraction across knowledge collections |
| `logs-routes.ts` | Log file viewer (JSONL files from LogTape) |
| `tools-routes.ts` | MCP tool debug: connect, list, call, disconnect |
| `summaries-routes.ts` | Unified `/summaries` page + `/api/summaries/documents` (merged, source-tagged archive across every summary source — see `src/summaries/sources.ts`) |
| `youtube-routes.ts` | YouTube transcript fetch + summarization API. `/youtube` now 301-redirects to `/summaries?source=youtube`; the page lives in the merged view |
| `x-article-routes.ts` | X/Twitter article summarization API (Chrome extension backend). `/x-articles` now 301-redirects to `/summaries?source=x-article` |
| `anthropic-routes.ts` | Claude Learning Center **Curate** layer (Candidates → Summaries). The candidate inbox (`GET /api/anthropic/candidates`, `POST …/:id/{summarize,dismiss}`) + the summarizer vertical (`/api/anthropic/{stream,jobs,document,similar}`, mirroring youtube-routes against the `anthropic-summaries` collection). Summarizes a watcher-captured candidate by pulling its content from Huginn `anthropic-knowledge`; renders on `/summaries` badged "Claude". See `src/anthropic/{state,summarizer}.ts` + `src/watchers/anthropic.ts` (capture + ≥0.9 auto-promote). |
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

`page.ts` (main dashboard), `traces-page.ts`, `search-page.ts`, `search-document-page.ts`, `research-page.ts`, `logs-page.ts`, `mcp-debug-page.ts`, `serena-page.ts`, `summaries-page.ts` (unified YouTube + X-article summaries; composes the `sum-*` components, injects the `SOURCES` registry).

## Real-Time Updates

### SSE Endpoints (sse-routes.ts)

- `/events` — activity feed events (message_in, message_out, memory, error, etc.)
- `/agent-status` — phase changes (idle, calling_claude, transcribing, etc.)
- `/request-progress` — full waterfall data (tools with timing, tokens, model)

### Agent Status (`src/observability/agent-status.ts`)

Tracks in-flight requests in a `Map<requestId, RequestProgress>` (concurrent requests no longer clobber a shared slot). The read side still surfaces a single primary request, so the SSE `/request-progress` contract and the waterfall UI are unchanged. See `src/observability/CLAUDE.md` for the full method list and the request-scoped-mutator rule.

1. `startRequest()` — creates RequestProgress keyed by a fresh requestId
2. `toolStart(requestId, …)`/`toolEnd(requestId, …)` — records tool calls with timing
3. `completeRequest(requestId, …)` — marks done, auto-clears that request after 30s
4. Phases: `idle`, `receiving`, `transcribing`, `building_prompt`, `calling_claude`, `saving_response`, `sending_telegram`, `sending_slack`, `synthesizing_voice`, `running_task`, `checking_goals`, `running_watcher`

### Activity Log (`src/observability/activity-log.ts`)

- In-memory ring buffer (max 500 events) + fire-and-forget DB persistence
- `loadFromDb()` called after DB init to hydrate on startup
- `stats` getter: messages today, avg response time, total cost

## MCP Debug Client (`src/ai/mcp-tool-caller.ts`)

- Supports both stdio (spawn process) and HTTP (StreamableHTTP) transports
- Connection pool keyed by `bot:server` — reuses existing connections
- Timeouts: 30s connect, 120s tool call
- Used by the MCP debug page (`tools-routes.ts`), Serena management, and the `openai-compat` connector

## Common Pitfalls

1. **SSE format**: Events must be `data: JSON\n\n` — missing double newline breaks the stream.
2. **Agent status waterfall is single-pane**: the data layer tracks all concurrent requests (per-`requestId` Map), but `/request-progress` emits only the primary (most-recently-started) request, so the overlay shows one at a time.
3. **Component pattern**: Always export all three (*Styles, *Html, *Script) even if empty — pages expect them.
4. **MCP connection cleanup**: Always call `disconnectServer()` or `disconnectAll()` — leaked stdio processes stay alive.
