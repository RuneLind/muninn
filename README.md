# Muninn

Personal AI assistant platform — multi-bot system supporting Telegram, Slack, and web chat, with pluggable AI connectors, semantic memory, goal tracking, scheduled tasks, and a full-featured web dashboard.

```mermaid
graph LR
    Platforms["Telegram · Slack · Web Chat<br/>Chrome Extensions"] --> Bots["Multi-Bot Engine<br/>(Claude CLI / Copilot SDK / Ollama)"]
    Bots --> Intelligence["Memory · Goals<br/>Scheduler · Watchers"]
    Bots --> DB[(PostgreSQL<br/>+ pgvector)]
    Intelligence --> DB
    Dashboard["Web Dashboard<br/>10+ pages"] --> DB
```

## Features

- **Multi-Bot Architecture** — Multiple bots in one process, each with isolated persona, MCP tools, and conversation history
- **Multi-Platform** — Telegram (Grammy), Slack (Bolt, Socket Mode), and browser-based web chat — all sharing the same core message pipeline
- **Multiple AI Connectors** — Claude CLI, GitHub Copilot SDK, or any OpenAI-compatible API (Ollama, LM Studio, vLLM) — configurable per bot and switchable per conversation thread
- **Semantic Memory** — Automatically extracts and recalls facts from conversations using local embeddings (Transformers.js) and hybrid search (FTS + pgvector)
- **Goal Tracking** — Detects goals/commitments/deadlines from conversations, injects them into prompt context, and proactively sends reminders and check-ins
- **Scheduled Tasks** — Cron-style or interval-based recurring tasks detected from conversation ("remind me every morning at 8") — supports reminders, AI-generated briefings, and custom prompts
- **Proactive Watchers** — Background monitors (email via Gmail MCP, X/Twitter timeline digest, etc.) with quiet hours, dedup, and configurable prompts
- **Voice** — Speech-to-text (whisper-cli) and text-to-speech (macOS say + ffmpeg) with mirror mode (voice in → voice + text out)
- **Request Tracing** — Full request lifecycle tracing with MCP tool call tracking (which tools, how long each took), waterfall visualization in the dashboard
- **Web Dashboard** — Hono server with 10+ pages: real-time activity feed, traces waterfall, memory search, MCP debugger, log viewer, YouTube summarizer, knowledge search, Serena code analysis, and more
- **Chrome Extensions** — Jira issue research (extract issue → AI analysis → chat thread) and YouTube video summarizer (transcript → Claude summary → knowledge base)
- **Serena Code Analysis** — Managed MCP proxy for Serena code search instances with unified tool catalog
- **API Documentation** — Auto-generated OpenAPI 3.1.0 spec with Scalar UI at `/docs`
- **Local-first** — All data stays on your machine (PostgreSQL via Docker, local embeddings, no cloud dependencies beyond Telegram/Slack and the AI provider)

## Prerequisites

- [Bun](https://bun.sh) runtime
- [Docker](https://docker.com) (for PostgreSQL + pgvector)
- At least one AI backend:
  - [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated, or
  - GitHub Copilot SDK access, or
  - An OpenAI-compatible API (Ollama, LM Studio, vLLM)
- [Huginn](https://github.com/RuneLind/huginn) (optional but recommended — companion project for knowledge search and X/Twitter):
  - Knowledge base MCP tool — bots use huginn's MCP adapter to search indexed documents (Confluence, Jira, Notion, YouTube transcripts)
  - X/Twitter fetcher — the X watcher shells out to huginn's `scripts/x/` to fetch the timeline via cookie-based GraphQL
  - Dashboard search page queries huginn's knowledge API
- [whisper-cpp](https://github.com/ggerganov/whisper.cpp) (optional, for voice: `brew install whisper-cpp`)
- [ffmpeg](https://ffmpeg.org) (optional, for voice: `brew install ffmpeg`)

## Setup

1. Install dependencies:
   ```bash
   bun install
   ```

2. Start the database and apply schema:
   ```bash
   bun run db:up              # Start Postgres via Docker
   bun run db:migrate:baseline # Mark existing migrations as applied
   ```
   On first start, Docker automatically applies `db/init.sql` (the full consolidated schema). The baseline command records all migrations as applied so future migrations run cleanly.

3. Configure environment:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` with your values (see [Configuration](#configuration) below).

4. Set up your first bot:
   ```bash
   mkdir -p bots/jarvis/.claude
   ```
   - Create `bots/jarvis/CLAUDE.md` with the bot's persona
   - Optionally add `bots/jarvis/.mcp.json` (MCP tools) and `bots/jarvis/.claude/settings.local.json` (permissions)

5. Start:
   ```bash
   bun run dev    # Development with file watching
   bun run start  # Production
   ```

## Configuration

### Environment Variables (.env)

#### Global

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | Postgres connection string |
| `DASHBOARD_PORT` | No | `3010` | Web dashboard port |
| `CLAUDE_TIMEOUT_MS` | No | `120000` | Claude response timeout in ms |
| `CLAUDE_MODEL` | No | `sonnet` | Claude model for main responses |
| `WHISPER_MODEL_PATH` | No | `./models/ggml-base.en.bin` | Path to whisper-cpp model file |
| `SCHEDULER_INTERVAL_MS` | No | `60000` | Unified scheduler tick interval in ms |
| `SCHEDULER_ENABLED` | No | `true` | Enable/disable unified scheduler |
| `TRACING_ENABLED` | No | `true` | Enable request tracing |
| `TRACING_RETENTION_DAYS` | No | `7` | Days to keep trace data |
| `PROMPT_SNAPSHOTS_RETENTION_DAYS` | No | `3` | Days to keep prompt snapshots |
| `HUGINN_TRACE_POINTER` | No | — | `1` enables Huginn's out-of-band trace channel (recommended). The Huginn MCP adapter is `stdio`-spawned by muninn, so this var propagates to it from muninn's env. Adapter emits a `huginn-trace-url:` line; Muninn fetches the trace via HTTP and attaches it as `searchTracePointer`. |
| `HUGINN_TRACE_DEFAULT` | No | `1` (forced) | Legacy inline-fence Huginn trace mode. Muninn forces this on for spawned MCP children regardless of `.env`, so it is always active as a fallback when pointer mode does not engage. |
| `LOG_DIR` | No | `./logs` | Log file directory (set `none` to disable) |

Trace env vars must be in `process.env` *before* muninn starts — Bun auto-loads `.env`, but if you edit `.env` after launch you must restart for the new values to reach spawned MCP adapters. On startup, both connectors log a single line like `Trace env: HUGINN_TRACE_POINTER=1 HUGINN_TRACE_DEFAULT=1 YGGDRASIL_TRACE_POINTER=unset YGGDRASIL_TRACE_DEFAULT=unset` so you can confirm what the running process actually sees.

`YGGDRASIL_TRACE_POINTER` / `YGGDRASIL_TRACE_DEFAULT` are not in this table because yggdrasil runs as an `http`-mode MCP started separately from muninn — those flags belong in the yggdrasil server's own startup environment, not in muninn's `.env`. Same applies to any other `type: "http"` entry in a bot's `.mcp.json` (e.g. the Serena tool proxy). The startup log line still reports their values from muninn's process env so you can spot-check whether the parent shell is exporting them when you spawn yggdrasil from there.

#### Per-Bot — Telegram

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN_<NAME>` | Yes (for Telegram) | Token from @BotFather (e.g. `TELEGRAM_BOT_TOKEN_JARVIS`) |
| `TELEGRAM_ALLOWED_USER_IDS_<NAME>` | Yes (for Telegram) | Comma-separated Telegram user IDs |

#### Per-Bot — Slack

| Variable | Required | Description |
|---|---|---|
| `SLACK_BOT_TOKEN_<NAME>` | Yes (for Slack) | Slack bot token (e.g. `SLACK_BOT_TOKEN_JARVIS`) |
| `SLACK_APP_TOKEN_<NAME>` | Yes (for Slack) | Slack app-level token for Socket Mode |
| `SLACK_ALLOWED_USER_IDS_<NAME>` | No | Comma-separated Slack user IDs (empty = all allowed) |

A bot can have both Telegram and Slack tokens — it will connect to both platforms simultaneously.

### Per-Bot config.json

All fields are optional — falls back to global `.env` values:

```json
{
  "connector": "claude-cli",
  "model": "claude-sonnet-4-6",
  "thinkingMaxTokens": 16000,
  "timeoutMs": 180000,
  "baseUrl": "http://localhost:11434/v1",
  "contextWindow": 200000,
  "showWaterfall": true
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `connector` | string | `"claude-cli"` | AI backend: `"claude-cli"`, `"copilot-sdk"`, `"openai-compat"`, or `"claude-sdk"` |
| `model` | string | `CLAUDE_MODEL` env | Model name (e.g. `"claude-sonnet-4-6"`, `"qwen3:32b"`) |
| `thinkingMaxTokens` | number | CLI default | Max thinking tokens (0 = disable). For openai-compat: used as `max_tokens` |
| `timeoutMs` | number | `CLAUDE_TIMEOUT_MS` env | Response timeout in ms |
| `baseUrl` | string | — | Base URL for OpenAI-compatible API (required for `openai-compat`) |
| `contextWindow` | number | — | Context window size in tokens. Shown as usage bar in web chat |
| `showWaterfall` | boolean | `true` | Show request progress waterfall overlay in web chat |
| `prompts` | object | — | Custom prompts: `jiraAnalysis`, `investigateCode` |

## Architecture

### Multi-Bot Process

```mermaid
graph LR
    subgraph Clients
        TA[Telegram User A]
        TB[Slack User B]
        TC[Web Browser C]
    end

    subgraph "Single Muninn Process"
        B1["Bot 1 (Jarvis)<br/>→ Claude CLI"]
        B2["Bot 2 (Assistant)<br/>→ Copilot SDK"]
        B3["Bot 3 (Local)<br/>→ Ollama"]
        SHARED["Shared: DB, Dashboard,<br/>Scheduler, Watchers"]
    end

    TA --> B1
    TB --> B2
    TC --> B3
    B1 --- SHARED
    B2 --- SHARED
    B3 --- SHARED
```

A bot is active when its folder has a `CLAUDE.md` and at least one platform token (`TELEGRAM_BOT_TOKEN_<NAME>` or `SLACK_BOT_TOKEN_<NAME>`). Bots without any platform token still appear in the web chat UI.

### Bot Folder Structure

```
bots/
├── jarvis/                      ← example bot
│   ├── CLAUDE.md                ← persona + rules
│   ├── config.json              ← connector, model, timeout overrides
│   ├── .mcp.json                ← Gmail, Calendar MCPs
│   └── .claude/
│       └── settings.local.json  ← tool permissions
├── your-bot/                    ← add your own
│   └── ...
```

### Bot Isolation via `cwd`

Each bot folder is set as `cwd` when spawning Claude CLI. This means Claude CLI automatically:
- Reads `CLAUDE.md` as project instructions (persona)
- Discovers `.mcp.json` (MCP tool servers)
- Discovers `.claude/settings.local.json` (tool permissions)
- Stores conversation history in `.claude/` within the bot folder

This keeps bot sessions completely isolated from each other and from interactive dev sessions in the project root.

### Core Message Pipeline

All platforms (Telegram, Slack, Web) converge on the same core message processor:

```mermaid
sequenceDiagram
    participant P as Platform<br/>(Telegram/Slack/Web)
    participant C as Core Processor
    participant AI as AI Connector
    participant DB as PostgreSQL
    participant E as Extractors

    P->>C: processMessage(text, callbacks)
    C->>DB: Load history, memories, goals
    C->>AI: Build prompt → Execute
    AI-->>P: Stream deltas (text, intent, tool status)
    AI->>C: Final response
    C->>DB: Save message + trace
    C->>P: formatAndSend()
    C-->>E: Fire-and-forget: memory, goals, schedules
```

## AI Connectors

Each bot selects its AI backend via `connector` in `bots/<name>/config.json`. Four connectors are available:

| Connector | Value | Description |
|---|---|---|
| Claude CLI | `"claude-cli"` | Spawns `claude -p` as subprocess (default) |
| Copilot SDK | `"copilot-sdk"` | GitHub Copilot SDK with shared JSON-RPC client |
| OpenAI-compat | `"openai-compat"` | Any OpenAI-compatible API (Ollama, LM Studio, vLLM) |
| Claude SDK | `"claude-sdk"` | Anthropic's `@anthropic-ai/claude-agent-sdk` — direct API transport, no CLI subprocess |

### Claude CLI (default)

Spawns Claude Code in headless mode with `--output-format stream-json --verbose`. Each bot's folder is used as `cwd`, so Claude auto-discovers persona, MCP tools, and settings.

```json
{
  "model": "claude-opus-4-6",
  "thinkingMaxTokens": 40000,
  "timeoutMs": 300000
}
```

No `connector` field needed — defaults to `"claude-cli"`.

### Copilot SDK

Uses GitHub Copilot SDK with a shared singleton client. MCP tools from `.mcp.json` are converted to SDK format.

```json
{
  "connector": "copilot-sdk",
  "model": "claude-sonnet-4-6",
  "thinkingMaxTokens": 16000,
  "timeoutMs": 180000
}
```

### Claude SDK

Uses Anthropic's `@anthropic-ai/claude-agent-sdk` `query()` iterable as a direct chat transport — no `claude` CLI subprocess, no Copilot subscription. Useful for personal bots that want smoother streaming and like-for-like benchmarks vs `copilot-sdk`.

```json
{
  "connector": "claude-sdk",
  "model": "claude-sonnet-4-6",
  "thinkingMaxTokens": 16000,
  "timeoutMs": 180000
}
```

Auth comes from either `ANTHROPIC_API_KEY` (sent as `x-api-key`, use for production / shared deployments) or `CLAUDE_CODE_OAUTH_TOKEN` (sent as `Authorization: Bearer`, generate via `claude setup-token` for personal Max-subscription dev). Same env surface as the Haiku router.

MCP servers from `.mcp.json` are converted to the Agent SDK shape (`src/ai/connectors/claude-sdk-mcp.ts`). Permission prompts are bypassed (`permissionMode: 'bypassPermissions'`, same trust model as the Copilot connector's `approveAll`) and `settingSources: []` keeps the SDK from auto-loading the user's global `~/.claude/settings.json` — muninn's `prompt-builder` delivers the full system prompt.

### OpenAI-compatible (Ollama, LM Studio, vLLM)

Calls any OpenAI-compatible API endpoint. Includes a built-in agent loop with MCP tool execution — loads tools from `.mcp.json`, sends them as OpenAI `tools` parameter, and executes tool calls against MCP servers in a multi-turn loop.

Supports thinking/reasoning tokens from Qwen3 and other models (both `reasoning` field and `<think>` tag stripping).

#### Ollama example

1. Start Ollama with a model:
   ```bash
   ollama pull qwen3:32b
   ollama serve  # default port 11434
   ```

2. Create `bots/local/config.json`:
   ```json
   {
     "connector": "openai-compat",
     "model": "qwen3:32b",
     "baseUrl": "http://localhost:11434/v1",
     "thinkingMaxTokens": 8192,
     "timeoutMs": 300000
   }
   ```

3. Create `bots/local/CLAUDE.md` with the bot persona.

4. Add env vars:
   ```env
   TELEGRAM_BOT_TOKEN_LOCAL=<token>
   TELEGRAM_ALLOWED_USER_IDS_LOCAL=123456
   ```

5. Restart — the bot auto-discovers and connects via Ollama.

#### Notes

- `baseUrl` is required for `openai-compat` — the connector has no default endpoint
- MCP tools from `.mcp.json` are automatically loaded and sent as OpenAI-format tools
- Agent loop supports up to 10 tool-call turns per request
- Empty responses are retried up to 3 times (handles LM Studio cold starts)
- Set `OPENAI_API_KEY` env var if the endpoint requires authentication

### Connector Switching

Connectors can be switched per conversation thread from the web chat UI. The dropdown in the inspector panel persists the preference to the database. Thread-level connector overrides take priority:

1. Thread's stored connector (if set)
2. Bot `config.json`
3. Global `.env` defaults

## Platforms

### Telegram

Grammy-based Telegram bot with text, voice, and command support.

#### Commands

| Command | Description |
|---|---|
| `/start` | Confirms the bot is online |
| `/watchers` | List all active watchers with status, interval, last run, and filter |
| `/watch <type> [filter]` | Create a new watcher (types: `email`, `calendar`, `github`, `news`, `goal`, `x`) |
| `/unwatch <name\|id>` | Remove a watcher by name or short ID |
| `/quiet [start-end\|off]` | View, set, or disable quiet hours (e.g. `/quiet 22-08`) |
| `/topic [name]` | Show current topic, or switch to a named topic |
| `/topics` | List all topics with message counts and last activity |
| `/deltopic <name>` | Delete a topic (cannot delete `main`) |

Any other text or voice message is forwarded to the AI for a conversational response.

### Slack

Slack Bolt app running in Socket Mode. Supports four message contexts:

| Context | Trigger | Thinking Indicator |
|---|---|---|
| **Assistant sidebar** | Slack's built-in Assistant UI | Native `setStatus("Thinking...")` |
| **@mention in channels** | `@BotName` mention | Native thread status bubble |
| **Thread follow-ups** | Reply in a tracked thread (no @mention needed) | Native thread status bubble |
| **Direct messages** | DM to the bot | Temporary "_Thinking..._" message |

**Features:**
- Automatic thread tracking — once the bot replies in a channel thread, it responds to follow-ups without @mention (in-memory, 24h TTL)
- Channel context — fetches recent messages for context-aware responses
- Channel posting — Claude can post to channels via `<slack-post channel="#name">content</slack-post>` directives
- Slack formatting — markdown automatically converted to mrkdwn (bold, links, code, tables → bullet lists)
- Topic commands — `/topic`, `/topics`, `/deltopic` work in Slack DMs and Assistant threads

**Setup:** Add `SLACK_BOT_TOKEN_<NAME>` and `SLACK_APP_TOKEN_<NAME>` to `.env`. The bot auto-discovers and connects via Socket Mode.

### Web Chat

Browser-based chat interface at `/chat`. Any bot with a `CLAUDE.md` appears here, even without platform tokens.

```bash
bun run dev          # Full app — chat at http://localhost:3010/chat
bun run dev:chat     # Chat-focused — scheduler off, port 3011
```

**Three-panel layout:**
- **Left** — Thread list with creation controls, message counts, and connector info
- **Center** — Chat view with real-time streaming (text deltas, tool activity widget, intent bubbles)
- **Right** — Inspector panel (context window usage, token stats, aggregated tool calls, connector selector)

**Real-time features:**
- WebSocket for messages, streaming text, tool status, and response metadata
- SSE overlay for request progress waterfall (from dashboard)
- Streaming text rendered with `requestAnimationFrame` batching for performance

**Conversation types:** `telegram_dm`, `slack_dm`, `slack_channel`, `slack_assistant`, `web`

#### Chat REST API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/chat/bots` | List available bots |
| `POST` | `/chat/conversations` | Create a conversation |
| `GET` | `/chat/conversations` | List all conversations |
| `GET` | `/chat/conversations/:id` | Get conversation with messages |
| `DELETE` | `/chat/conversations/:id` | Delete a conversation |
| `POST` | `/chat/conversations/:id/messages` | Send a message (response arrives via WebSocket) |
| `POST` | `/chat/threads` | Create a new thread within a conversation |
| `GET` | `/chat/threads` | List threads for a conversation |
| `DELETE` | `/chat/threads/:id` | Delete a thread |

### Conversation Threads

Each user+bot pair can have multiple named conversation threads. Only chat history is isolated per thread — memories, goals, and scheduled tasks are shared across all threads.

- First message auto-creates a `main` thread
- Threads support per-thread connector overrides (switch AI model per conversation)
- Thread names are case-insensitive, max 50 characters
- Works on all platforms (Telegram commands, Slack DMs, web UI)

## Dashboard

The web dashboard (default port 3010) provides real-time monitoring and management across 10+ pages:

```mermaid
graph TB
    subgraph "Dashboard Pages"
        HOME["/ — Activity Feed<br/>Stats, goals, tasks, watchers"]
        TRACES["/traces — Request Traces<br/>Waterfall visualization"]
        CHAT["/chat — Web Chat<br/>Multi-bot conversations"]
        MEM["/memsearch — Memory Search<br/>Semantic + FTS hybrid"]
        MCP["/mcp-debug — MCP Debugger<br/>Test tool connections"]
        SERENA["/serena — Code Analysis<br/>Manage Serena instances"]
        YT["/youtube — YouTube<br/>Summarize & index videos"]
        RESEARCH["/research — Knowledge<br/>Browse document collections"]
        SEARCH["/search — Search<br/>Cross-collection search"]
        LOGS["/logs — Log Viewer<br/>Browse JSONL logs by date"]
        DOCS["/docs — API Docs<br/>Scalar OpenAPI UI"]
    end
```

### Dashboard Pages

| Page | Path | Description |
|---|---|---|
| Activity Feed | `/` | Real-time SSE activity feed, stats, goals, tasks, watchers, connectors, Slack analytics |
| Traces | `/traces` | Request tracing with waterfall visualization, span tree, prompt snapshots |
| Web Chat | `/chat` | Multi-bot chat interface with streaming and inspector panel |
| Memory Search | `/memsearch` | Semantic + full-text hybrid search over bot memories by scope |
| MCP Debugger | `/mcp-debug` | Connect to MCP servers, list tools, call tools with arguments |
| Serena | `/serena` | Manage Serena code analysis instances, start/stop/index, proxy status |
| YouTube | `/youtube` | Submit videos for summarization, track live progress, browse article library |
| Research | `/research` | Browse knowledge collections by category, view documents |
| Search | `/search` | Full-text search across all knowledge collections |
| Logs | `/logs` | Browse daily JSONL log files with filtering |
| API Docs | `/docs` | Scalar UI rendering the auto-generated OpenAPI spec |

### Dashboard API

**Core data:**
- `GET /api/stats` — Dashboard statistics
- `GET /api/activity` — Recent activity events
- `GET /api/events` — SSE stream (activity, agent status, request progress)
- `GET /api/bots/config` — Bot connector configurations

**Per-user data:**
- `GET /api/messages/:userId` — Conversation history
- `GET /api/goals/:userId` — Active goals
- `GET /api/scheduled-tasks/:userId` — Scheduled tasks
- `GET /api/memories` — Recent memories (with bot filter)

**Traces:**
- `GET /api/traces` — Recent traces (`?bot=`, `?name=`, `?limit=`, `?offset=`)
- `GET /api/traces/:traceId` — Span tree for a single trace
- `GET /api/trace-stats` — 24h counts, avg duration, errors
- `GET /api/prompts/:traceId` — Prompt snapshot

**Connectors (CRUD):**
- `GET /api/connectors` — List named connectors
- `POST /api/connectors` — Create connector
- `PUT /api/connectors/:id` — Update connector
- `DELETE /api/connectors/:id` — Delete connector

**MCP / Serena:**
- `POST /api/mcp/connect` — Connect to MCP server
- `POST /api/mcp/call` — Call a tool
- `GET /api/serena/instances` — Serena + proxy status

**YouTube:**
- `POST /api/youtube/summarize` — Submit video (returns `job_id`)
- `GET /api/youtube/stream/:jobId` — SSE stream of summarization progress
- `GET /api/youtube/documents` — Browse summarized articles

**Search / Research:**
- `GET /api/search/collections` — List knowledge collections
- `GET /api/search/search` — Cross-collection search
- `POST /api/research/chat` — Create research thread from Jira issue

**Full spec:** `GET /api/openapi.json` or browse at `/docs`

## Chrome Extensions

Two Chrome extensions integrate external tools with Muninn:

### Jira Research Extension (`extensions/jira/`)

Extracts Jira issue data from the DOM and sends it to Muninn for AI-powered analysis.

```mermaid
sequenceDiagram
    participant J as Jira Page
    participant E as Extension Popup
    participant M as Muninn API
    participant C as Chat Page

    J->>E: Extract issue (DOM scraping)
    E->>M: POST /api/research/chat
    M->>M: Create thread, queue message
    M->>E: Return chatUrl
    E->>C: Open chat page
    C->>C: Multi-phase analysis<br/>(analysis → investigation → deep analysis)
```

**Features:**
- Extracts: key, summary, status, type, priority, assignee, description, comments
- User and connector/model selection synced with web chat preferences
- Thread collision detection ("Reuse existing thread?" dialog)
- Multi-phase research: initial analysis → code investigation → deep analysis

### YouTube Summarizer Extension (`extensions/youtube/`)

Detects YouTube video navigation and sends videos to Muninn for summarization and knowledge indexing.

**Flow:** Detect video → popup with "Summarize" button → `POST /api/youtube/summarize` → opens dashboard YouTube page with live SSE progress → transcript fetch → Claude summary → knowledge base ingest

**Dashboard YouTube page shows:** live streaming summary, status badges, category tagging, similar articles from knowledge base, and a browsable article library.

## Serena Code Analysis

Serena provides code search and analysis tools (find_symbol, search_for_pattern, etc.) for large codebases. Instances run as persistent HTTP servers managed from the dashboard.

### Tool Proxy

The Serena tool proxy (`src/serena/tool-proxy.ts`) sits in front of all running Serena instances and reduces ~40 tool schemas down to 2 — a ~95% context savings:

- **`search_tools`** — Discover available tools by keyword across all connected servers
- **`call_tool`** — Execute a specific tool on a specified server

```mermaid
graph LR
    BOT[Bot / AI Connector] -->|2 tools| PROXY["Tool Proxy<br/>:9120"]
    PROXY -->|~20 tools| S1["Serena Instance 1<br/>:9121"]
    PROXY -->|~20 tools| S2["Serena Instance 2<br/>:9122"]
```

The proxy auto-starts when the first Serena instance starts and auto-stops when all instances are stopped. Tool catalogs refresh automatically.

### Configuration

Serena instances are defined in the bot's `config.json`:

```json
{
  "serena": [
    { "name": "serena-api", "displayName": "Backend API", "projectPath": "/path/to/project", "port": 9121 }
  ]
}
```

The bot's `.mcp.json` points to the proxy (not individual instances):

```json
{
  "serena-proxy": { "type": "http", "url": "http://127.0.0.1:9120/mcp" }
}
```

### Usage

1. Open the **Serena** page in the dashboard (`/serena`)
2. Click **Start** on the instances you need (or **Start All**)
3. The proxy auto-starts and builds a unified tool catalog
4. Click **Stop** when done to free resources

## Adding a New Bot

1. Create the bot folder:
   ```bash
   mkdir -p bots/mybot/.claude
   ```

2. Write the persona in `bots/mybot/CLAUDE.md`

3. Optionally add `bots/mybot/config.json`, `bots/mybot/.mcp.json`, and `bots/mybot/.claude/settings.local.json`

4. Add platform tokens to `.env`:
   ```env
   # Telegram (optional)
   TELEGRAM_BOT_TOKEN_MYBOT=<token from @BotFather>
   TELEGRAM_ALLOWED_USER_IDS_MYBOT=123456

   # Slack (optional)
   SLACK_BOT_TOKEN_MYBOT=xoxb-...
   SLACK_APP_TOKEN_MYBOT=xapp-...
   ```

5. Restart — the bot is auto-discovered and connects to configured platforms. It also appears in web chat immediately.

> See [`docs/examples/jira-assistant/`](docs/examples/jira-assistant/) for a complete team bot example with Serena code search and Copilot SDK connector.

## Sharing bot configs across machines / contributors

Bot folders (everything except the bundled `bots/jarvis/`) are gitignored, but they're often the most valuable part of a deployment — personas, MCP wiring, tool permissions. Muninn syncs them to/from external "source-of-truth" repos via a manifest at `bots.config.json` (repo root). Each entry maps a bot name to either a local path (e.g. a personal config repo) or a git URL (typically a private team repo).

```json
{
  "schemaVersion": 1,
  "bots": {
    "jarvis":  { "inline": true },
    "capra":   { "repo": "https://github.com/capraconsulting/huginn-capra.git", "subpath": "bot" },
    "melosys": { "repo": "~/source/private/muninn-config", "subpath": "bots/melosys" }
  }
}
```

`inline: true` means the bot is checked into muninn directly (the case for `jarvis`). Git-URL repos are sparse-cloned into `~/.muninn/bot-repos/<name>/`. Manifest entries you can't reach (path missing, clone fails) are skipped with a warning, so each contributor only needs access to the repos for the bots they actually run.

```bash
bun run config:sync                # push local bots/<name>/ → each repo
bun run config:sync -- --pull      # fetch latest from git remotes first
bun run config:sync -- --commit    # commit + push in every touched repo
bun run config:restore             # reverse: pull each repo subpath → bots/<name>/
```

`.env` is **per-developer** — each contributor maintains their own with the tokens for the bots they actually run. It is not synced by this tool.

**Onboarding a new contributor for a single bot** (e.g. someone joining a Capra-only team):

```bash
git clone https://github.com/RuneLind/muninn.git
cd muninn && bun install
bun run config:restore             # pulls bots/capra/ from huginn-capra (the only repo they have access to)
cp .env.example .env               # add their own SLACK_BOT_TOKEN_CAPRA etc.
bun run db:up && bun run db:migrate
bun run dev
```

They never touch a personal config repo and never see other teams' bots.

**Path conventions inside synced `.mcp.json`:** paths resolve relative to `cwd: bots/<name>/`. To reference a sibling project (e.g. `~/source/private/huginn` when muninn lives at `~/source/private/muninn`), use `../../../huginn`. Values inside `env` blocks are read literally — for HOME-relative paths use shell expansion in a `bash -c` command instead.

## How It Works

### Memory

After each conversation exchange, the bot asynchronously asks Claude Haiku whether the exchange contains facts worth remembering (preferences, decisions, project details). If so, it stores a summary with tags and a vector embedding for later semantic retrieval. Memories are scoped as `personal` (per-user) or `shared` (visible to all users of a bot) — Haiku auto-classifies during extraction.

### Goals

Goals, commitments, and deadlines are detected from conversations. Active goals are injected into the prompt context. A unified background scheduler sends:
- **Deadline reminders** — 24 hours before a deadline (max once per 12h)
- **Check-ins** — When a goal hasn't been discussed in 3+ days (max 1 per scheduler tick)

### Scheduled Tasks

Recurring task requests are detected from conversation (e.g. "remind me every morning at 8 to review my goals"). Three task types:
- **reminder** — Simple recurring messages
- **briefing** — AI-generated summaries with goals and context
- **custom** — Arbitrary prompts run through Claude Haiku

Supports cron-style (hour/minute/days) and interval-style (every N ms) scheduling, timezone-aware.

### Watchers

Background monitors that check external services at intervals:
- **Email** — Spawns Haiku with the bot's Gmail MCP to search and evaluate unread emails
- **X/Twitter** — Fetches home timeline via [huginn](https://github.com/RuneLind/huginn)'s cookie-based GraphQL fetcher, Haiku summarizes into a morning digest. Tweet-level dedup via `trackingIds`.
- Quiet hours support (per-user, timezone-aware, overnight ranges like 22-08)
- Dedup via rolling window of notified IDs + content hashes
- Configurable prompts per watcher (custom or sensible defaults), time-of-day scheduling (hour/minute in config)

### Voice

Send a voice message and the bot will transcribe it (whisper-cli), process it through Claude, and reply with both text and a voice message (mirror mode).

### Tracing & Tool Tracking

Every request creates a trace — a tree of timed spans (prompt build, Claude execution, DB saves, send). MCP tool calls (Gmail, Calendar, etc.) are captured from the stream events. Each tool call becomes a child span with its own timing, visible in the traces dashboard waterfall. See [`docs/tracing-and-tool-tracking.md`](docs/tracing-and-tool-tracking.md) for details.

### Prompt Assembly

Each request assembles a prompt from multiple sources:

```mermaid
graph TB
    PERSONA[Persona — CLAUDE.md] --> PROMPT
    MEMORIES[Relevant Memories — hybrid search] --> PROMPT
    GOALS[Active Goals] --> PROMPT
    TASKS[Scheduled Tasks] --> PROMPT
    HISTORY[Thread-scoped Chat History] --> PROMPT
    PROMPT[Assembled Prompt] --> AI[AI Connector]
```

## Database

PostgreSQL with pgvector, running in Docker.

### Schema

`db/init.sql` is the full consolidated schema — it creates all tables, indexes, triggers, and extensions. Docker applies it automatically on first container creation.

**Tables:** `users`, `messages`, `activity_log`, `memories` (with vector embeddings + scope), `goals`, `scheduled_tasks`, `watchers`, `connectors` (named AI connector configurations), `threads` (per-user+bot with optional connector FK), `user_settings`, `haiku_usage`, `traces` (spans with parent-child hierarchy + JSONB attributes)

Incremental changes go in `db/migrations/` as numbered files. Both `.sql` and `.ts` migrations are supported.

### Migration runner

A Flyway-style migration runner tracks applied migrations in a `schema_migrations` table:

```bash
bun run db:migrate            # Apply pending migrations
bun run db:migrate:status     # Show which migrations are applied/pending
bun run db:migrate:baseline   # Mark all migrations as applied (for fresh DBs)
```

### Creating a new migration

1. Create a numbered file in `db/migrations/`:
   ```bash
   touch db/migrations/021-my-change.sql   # SQL (schema changes)
   touch db/migrations/021-my-change.ts    # TypeScript (data transforms)
   ```

2. For TypeScript, export a `migrate` function:
   ```ts
   import type postgres from "postgres";
   export async function migrate(db: postgres.Sql) {
     await db`UPDATE ...`;
   }
   ```

3. Run it: `bun run db:migrate`

4. Update `db/init.sql` to include the change (so fresh installs get the full schema).

### Backup & Restore

```bash
bun run db:backup    # Saves to backups/muninn_backup_<timestamp>.sql
bun run db:restore   # Restores from latest backup in backups/
```

## Testing

Tests require the local Postgres container (`bun run db:up`). A separate `muninn_test` database is used for isolation.

### First-time test setup

```bash
bun run db:up            # Start Postgres (if not already running)
bun run db:setup:test    # Create muninn_test DB and apply schema
```

### Running tests

```bash
bun run test              # All tests
bun run test:unit         # Unit tests only (pure functions, no DB)
bun run test:db           # DB integration tests only
bun run test:handlers     # Handler/integration tests (with mocks)
bun run test:coverage     # Run with coverage report
bun run test:e2e          # Playwright end-to-end tests
bun run test:e2e:ui       # Playwright with interactive UI
```

Tests are split into multiple `bun` invocations because `bun:test` runs all files in the same process, and `mock.module()` calls leak between files.

If the schema changes, re-run `bun run db:setup:test` to rebuild the test database.

### Test structure

- `src/test/setup-db.ts` — Shared DB setup (connects to `muninn_test`, truncates tables between tests)
- `src/test/fixtures.ts` — Test data factories (`makeMessage()`, `makeMemory()`, `makeGoal()`, etc.)
- `src/test/mock-grammy.ts` — Grammy test helpers (fake bot with API transformer, fake updates)
- `*.test.ts` — Test files co-located with their source files

## Docker Production

The `prod` profile in `docker-compose.yml` runs the full stack (Postgres + app) in Docker.

### Starting

```bash
docker compose --profile prod up -d
```

This starts:
- **postgres** — pgvector/pg17 with the schema from `db/init.sql`
- **app** — Bun + ffmpeg + Claude CLI, running as non-root `muninn` user

### Volume Mounts

| Mount | Container Path | Description |
|---|---|---|
| `~/.claude` | `/home/muninn/.claude` (read-only) | Claude CLI authentication credentials |
| `./bots` | `/app/bots` (read-only) | Bot persona, MCP config, and permissions |

Bot configuration is mounted (not baked in) so you can change personas and MCP tools without rebuilding the image.

### Environment

The app container reads `.env` via `env_file`, with `DATABASE_URL` overridden to point at the Postgres container:

```
DATABASE_URL=postgresql://muninn:muninn@postgres:5432/muninn
```

The dashboard port maps `DASHBOARD_PORT` (default 3010) on the host to port 3000 inside the container.

### Health Check

The app container has a health check that polls `GET /api/stats` every 30 seconds. Use `docker compose ps` to verify the app is healthy.

### Limitations

- **TTS on Linux**: macOS `say` is not available — TTS gracefully degrades (text replies only, no voice output)
- **whisper-cli**: Not installed in the Docker image — voice input requires adding whisper-cpp to the Dockerfile

## Key Paths

| Path | Purpose |
|---|---|
| `bots/<name>/` | Per-bot config: persona, MCP, permissions, CLI history |
| `src/index.ts` | Entrypoint — inits DB, discovers bots, starts all + dashboard + scheduler |
| `src/bots/config.ts` | Bot auto-discovery from `bots/` directory |
| `src/core/` | Unified message processor, response handler, metadata extraction |
| `src/bot/` | Telegram handlers (text, voice), auth middleware, HTML formatting |
| `src/slack/` | Slack Bolt app, handler pipeline, thread tracking, mrkdwn formatting |
| `src/chat/` | Web chat — routes, WebSocket, conversation state, inspector panel, streaming UI |
| `src/ai/` | Connector abstraction, Claude CLI + Copilot SDK + OpenAI-compat, prompt builder, embeddings |
| `src/memory/` | Async memory extraction (personal + shared scope) |
| `src/goals/` | Goal detection (async Claude Haiku) |
| `src/scheduler/` | Unified scheduler (tasks + goal reminders + watchers), shared Haiku executor |
| `src/watchers/` | Proactive outreach — email watcher (Haiku + Gmail MCP), X/Twitter digest, quiet hours |
| `src/db/` | Postgres CRUD — messages, memories, goals, tasks, activity, watchers, threads, traces, connectors |
| `src/tracing/` | Request tracing with span hierarchy and MCP tool call child spans |
| `src/dashboard/` | Hono web server — 10+ pages, REST APIs, SSE, OpenAPI spec |
| `src/serena/` | Serena instance manager + MCP tool proxy |
| `src/youtube/` | YouTube video summarizer (transcript → Claude → knowledge base) |
| `src/voice/` | STT (whisper-cli) + TTS (macOS say + ffmpeg) |
| `src/web/` | Web HTML formatting (markdown → HTML) |
| `extensions/` | Chrome extensions (Jira research, YouTube summarizer) |
| `docs/` | Architecture documentation, examples |

## Gmail MCP Re-Authentication

The Gmail MCP server (`@gongrzhe/server-gmail-autoauth-mcp`) uses OAuth tokens that expire periodically. When you see `invalid_grant` errors, re-authenticate:

```bash
GOOGLE_OAUTH_CREDENTIALS=/path/to/gcp-oauth.keys.json \
  npx -y @gongrzhe/server-gmail-autoauth-mcp auth
```

This opens a browser for Google OAuth login. **Requires port 3000 to be free** (used for the OAuth callback).

After re-auth, restart Claude Code so the MCP server picks up the new token.

## Security

- No public ports — local platform relay only (Telegram long-polling, Slack Socket Mode)
- Per-bot user ID whitelist enforcement (Telegram required, Slack optional)
- All API keys via environment variables
- Database runs locally via Docker
- Embeddings computed locally via Transformers.js
- Bot sessions isolated from dev sessions via separate `cwd`
- Web chat dashboard on localhost only
