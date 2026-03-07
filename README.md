# Muninn

Multi-bot Telegram platform backed by Claude CLI — each bot gets its own persona, MCP tools, and permissions, all running in a single process with shared DB, dashboard, and scheduler.

## Features

- **Multi-Bot Architecture** — Multiple Telegram bots in one process, each with isolated persona, MCP tools, and Claude CLI history
- **Claude AI** — Responses powered by Claude Code headless mode (`claude -p`) with per-bot `cwd` isolation
- **Semantic Memory** — Automatically extracts and recalls facts from conversations using local embeddings (Transformers.js) and hybrid search (FTS + pgvector)
- **Goal Tracking** — Detects goals/commitments/deadlines from conversations, injects them into prompt context, and proactively sends reminders and check-ins
- **Scheduled Tasks** — Cron-style or interval-based recurring tasks detected from conversation ("remind me every morning at 8") — supports reminders, AI-generated briefings, and custom prompts
- **Proactive Watchers** — Background monitors (email via Gmail MCP) with quiet hours and dedup
- **Voice** — Speech-to-text (whisper-cli) and text-to-speech (macOS say + ffmpeg) with mirror mode (voice in → voice + text out)
- **Request Tracing** — Full request lifecycle tracing with MCP tool call tracking (which tools, how long each took), waterfall visualization in the dashboard
- **Live Dashboard** — Hono web server with SSE real-time activity feed, stats, goals, tasks, memories, and traces panels
- **Local-first** — All data stays on your machine (PostgreSQL via Docker, local embeddings, no cloud dependencies beyond Telegram and Claude API)

## Prerequisites

- [Bun](https://bun.sh) runtime
- [Docker](https://docker.com) (for PostgreSQL)
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
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

### Shared (.env)

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | Postgres connection string |
| `DASHBOARD_PORT` | No | `3000` | Web dashboard port |
| `CLAUDE_TIMEOUT_MS` | No | `120000` | Claude response timeout in ms |
| `CLAUDE_MODEL` | No | `sonnet` | Claude model for main responses |
| `WHISPER_MODEL_PATH` | No | `./models/ggml-base.en.bin` | Path to whisper-cpp model file |
| `SCHEDULER_INTERVAL_MS` | No | `60000` | Unified scheduler tick interval in ms |
| `SCHEDULER_ENABLED` | No | `true` | Enable/disable unified scheduler |

### Per-Bot (.env)

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN_<NAME>` | Yes | Bot token from @BotFather (e.g. `TELEGRAM_BOT_TOKEN_JARVIS`) |
| `TELEGRAM_ALLOWED_USER_IDS_<NAME>` | Yes | Comma-separated Telegram user IDs (e.g. `TELEGRAM_ALLOWED_USER_IDS_JARVIS`) |

## Architecture

### Multi-Bot Process

```
                    ┌─────────────────────────────────┐
                    │        Single muninn process    │
                    │                                  │
Telegram user A ───►│  Grammy Bot 1 (Jarvis)           │
                    │    → Claude CLI (cwd: bots/jarvis)│
                    │                                  │
Telegram user B ───►│  Grammy Bot 2 (Jira Assistant)   │
                    │    → Copilot SDK                  │
                    │                                  │
                    │  Shared: DB, Dashboard, Scheduler │
                    └─────────────────────────────────┘
```

### Bot Isolation via `cwd`

Each bot folder is set as `cwd` when spawning Claude CLI. This means Claude CLI automatically:
- Reads `CLAUDE.md` as project instructions (persona)
- Discovers `.mcp.json` (MCP tool servers)
- Discovers `.claude/settings.local.json` (tool permissions)
- Stores conversation history in `.claude/` within the bot folder

This keeps bot sessions completely isolated from each other and from interactive dev sessions in the project root.

### Bot Folder Structure

```
bots/
├── jarvis/
│   ├── CLAUDE.md                ← persona + rules
│   ├── .mcp.json                ← Gmail, Calendar MCPs
│   └── .claude/
│       └── settings.local.json  ← tool permissions
├── jira-assistant/                ← example team bot
│   ├── CLAUDE.md
│   ├── config.json
│   ├── .mcp.json
│   └── .claude/
│       └── settings.local.json
```

### Key Paths

| Path | Purpose |
|---|---|
| `bots/<name>/` | Per-bot config: persona, MCP, permissions, CLI history |
| `src/bots/config.ts` | Bot auto-discovery from `bots/` directory |
| `src/index.ts` | Entrypoint — inits DB, discovers bots, starts all + dashboard + scheduler |
| `src/bot/` | Telegram handlers (text, voice), auth middleware, HTML formatting |
| `src/ai/` | Claude executor (stream-json + tool tracking), prompt builder, local embeddings |
| `src/memory/` | Async memory extraction from conversations |
| `src/goals/` | Goal detection (async Claude Haiku) |
| `src/scheduler/` | Unified scheduler (scheduled tasks + goal reminders + watchers), shared Haiku executor |
| `src/watchers/` | Proactive outreach — email watcher (Haiku + Gmail MCP), quiet hours |
| `src/db/` | Postgres CRUD — messages, memories, goals, scheduled tasks, activity, watchers, traces |
| `src/tracing/` | Request tracing with span hierarchy and MCP tool call child spans |
| `src/dashboard/` | Hono web server with SSE activity feed, traces waterfall + REST APIs |
| `src/voice/` | STT (whisper-cli) + TTS (macOS say + ffmpeg) |

## Adding a New Bot

1. Create the bot folder:
   ```bash
   mkdir -p bots/mybot/.claude
   ```

2. Write the persona in `bots/mybot/CLAUDE.md`

3. Optionally add MCP tools in `bots/mybot/.mcp.json` and permissions in `bots/mybot/.claude/settings.local.json`

4. Add env vars to `.env`:
   ```env
   TELEGRAM_BOT_TOKEN_MYBOT=<token from @BotFather>
   TELEGRAM_ALLOWED_USER_IDS_MYBOT=123456
   ```

5. Restart — the bot is auto-discovered and connects to Telegram

## Telegram Commands

| Command | Description |
|---|---|
| `/start` | Confirms the bot is online |
| `/watchers` | List all active watchers with status, interval, last run, and filter |
| `/watch <type> [filter]` | Create a new watcher. Types: `email`, `calendar`, `github`, `news`, `goal`. Example: `/watch email from:github.com` |
| `/unwatch <name\|id>` | Remove a watcher by name or short ID |
| `/quiet [start-end\|off]` | View, set, or disable quiet hours (e.g. `/quiet 22-08`) |
| `/topic [name]` | Show current topic, or switch to (and create) a named topic. Example: `/topic work` |
| `/topics` | List all topics with message counts and last activity |
| `/deltopic <name>` | Delete a topic (cannot delete `main`). Messages are preserved. |

Any other text or voice message is forwarded to Claude for a conversational response.

### Conversation Threads

Each user+bot pair can have multiple named conversation threads (topics). Only chat history is isolated per thread — memories, goals, and scheduled tasks are shared across all threads.

- First message auto-creates a `main` thread (backward compatible with existing conversations)
- `/topic work` switches to the "work" thread, creating it if needed
- `/topic` with no argument shows the current thread and lists all threads
- `/deltopic work` deletes a thread and switches back to `main`
- Thread names are case-insensitive, max 50 characters
- Pre-migration messages (before threads existed) are visible only in the `main` thread

## Dashboard API

- `GET /` — Live activity dashboard (HTML)
- `GET /api/activity` — Recent activity events + stats
- `GET /api/messages/:userId` — Conversation history for a user
- `GET /api/goals/:userId` — Active goals for a user
- `GET /api/scheduled-tasks/:userId` — Scheduled tasks for a user
- `GET /api/events` — SSE stream for real-time activity updates
- `GET /traces` — Traces dashboard with waterfall view (HTML)
- `GET /api/traces` — Recent traces (supports `?bot=`, `?name=`, `?limit=`, `?offset=`)
- `GET /api/traces/:traceId` — Span tree for a single trace
- `GET /api/trace-stats` — Trace statistics (24h counts, avg duration, errors)
- `GET /api/trace-filters` — Available filter options (bot names, trace types)
- `GET /api/prompts/:traceId` — Prompt snapshot for a trace

## Chat UI

Browser-based chat interface for testing bots without Telegram/Slack tokens. Always available at `/chat` — no special mode needed. Any bot with a `CLAUDE.md` appears in the chat UI, even without platform tokens.

```bash
bun run dev          # Full app — chat at http://localhost:3010/chat
bun run dev:chat     # Chat-focused — scheduler off, port 3011
```

### Web UI

Open `/chat` on the dashboard (e.g. `http://localhost:3010/chat`). The UI has a three-panel layout:
- **Left** — Conversation list and creation controls
- **Center** — Chat view with message history
- **Right** — Conversation details and status

Real-time updates are delivered via WebSocket.

### REST API

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/chat/bots` | List available bots |
| `POST` | `/chat/conversations` | Create a conversation (`{ type, botName, userId?, username?, channelName? }`) |
| `GET` | `/chat/conversations` | List all conversations |
| `GET` | `/chat/conversations/:id` | Get conversation with messages |
| `DELETE` | `/chat/conversations/:id` | Delete a conversation |
| `POST` | `/chat/conversations/:id/messages` | Send a message (`{ text }`) — response arrives via WebSocket |

Supported conversation types: `telegram_dm`, `slack_dm`, `slack_channel`, `slack_assistant`.

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

## How It Works

### Memory
After each conversation exchange, the bot asynchronously asks Claude Haiku whether the exchange contains facts worth remembering (preferences, decisions, project details). If so, it stores a summary with tags and a vector embedding for later semantic retrieval.

### Goals
Similarly, goals, commitments, and deadlines are detected from conversations. Active goals are injected into the prompt context. A unified background scheduler sends:
- **Deadline reminders** — 24 hours before a deadline (max once per 12h)
- **Check-ins** — When a goal hasn't been discussed in 3+ days (max 1 per scheduler tick)

### Scheduled Tasks
Recurring task requests are detected from conversation (e.g. "remind me every morning at 8 to review my goals"). Three task types:
- **reminder** — Simple recurring messages
- **briefing** — AI-generated summaries with goals and context
- **custom** — Arbitrary prompts run through Claude Haiku

### Watchers
Background monitors that check external services at intervals:
- **Email** — Spawns Haiku with the bot's Gmail MCP to search and evaluate unread emails
- Quiet hours support (per-user, timezone-aware)
- Dedup via rolling window of notified IDs

### Voice
Send a voice message and the bot will transcribe it (whisper-cli), process it through Claude, and reply with both text and a voice message (mirror mode).

### Tracing & Tool Tracking
Every request creates a trace — a tree of timed spans (prompt build, Claude execution, DB saves, send). The Claude executor uses `--output-format stream-json --verbose` to capture MCP tool calls (Gmail, Calendar, etc.) from the NDJSON event stream. Each tool call becomes a child span with its own timing, visible in the traces dashboard waterfall as orange bars. See [`docs/tracing-and-tool-tracking.md`](docs/tracing-and-tool-tracking.md) for details.

## Database

PostgreSQL with pgvector, running in Docker.

### Schema

`db/init.sql` is the full consolidated schema — it creates all tables, indexes, triggers, and extensions. Docker applies it automatically on first container creation via `docker-entrypoint-initdb.d`.

Incremental changes go in `db/migrations/` as numbered files (e.g. `021-add-feature.sql`). Both `.sql` and `.ts` migrations are supported. TS migrations must export a `migrate(sql: postgres.Sql): Promise<void>` function.

### Migration runner

A Flyway-style migration runner tracks applied migrations in a `schema_migrations` table:

```bash
bun run db:migrate            # Apply pending migrations
bun run db:migrate:status     # Show which migrations are applied/pending
bun run db:migrate:baseline   # Mark all migrations as applied (for fresh DBs from init.sql)
```

### Creating a new migration

1. Create a numbered file in `db/migrations/`:
   ```bash
   # SQL migration (schema changes)
   touch db/migrations/021-my-change.sql

   # TS migration (data transforms)
   touch db/migrations/021-my-change.ts
   ```

2. For SQL: write your DDL/DML statements directly.

3. For TypeScript: export a `migrate` function:
   ```ts
   import type postgres from "postgres";

   export async function migrate(db: postgres.Sql) {
     await db`UPDATE ...`;
   }
   ```

4. Run it:
   ```bash
   bun run db:migrate
   ```

5. Update `db/init.sql` to include the change (so fresh installs get the full schema).

### Backup & Restore

```bash
bun run db:backup    # Saves to backups/muninn_backup_<timestamp>.sql
bun run db:restore   # Restores from latest backup in backups/
```

Backups are full `pg_dump` exports stored in the `backups/` directory.

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
```

Tests are split into two `bun` invocations because `bun:test` runs all files in the same process, and `mock.module()` calls leak between files. Group 1 (unit + DB) runs first, then group 2 (mock-based handler tests).

If the schema changes, re-run `bun run db:setup:test` to rebuild the test database.

### Test structure

- `src/test/setup-db.ts` — Shared DB setup (connects to `muninn_test`, truncates tables between tests)
- `src/test/fixtures.ts` — Test data factories (`makeMessage()`, `makeMemory()`, `makeGoal()`, etc.)
- `src/test/mock-grammy.ts` — Grammy test helpers (fake bot with API transformer, fake updates)
- `*.test.ts` — Test files co-located with their source files

## Gmail MCP Re-Authentication

The Gmail MCP server (`@gongrzhe/server-gmail-autoauth-mcp`) uses OAuth tokens that expire periodically. When you see `invalid_grant` errors, re-authenticate:

```bash
GOOGLE_OAUTH_CREDENTIALS=/path/to/gcp-oauth.keys.json \
  npx -y @gongrzhe/server-gmail-autoauth-mcp auth
```

This opens a browser for Google OAuth login. **Requires port 3000 to be free** (used for the OAuth callback).

After re-auth, restart Claude Code so the MCP server picks up the new token.

## Security

- No public ports — local Telegram relay only
- Per-bot Telegram user ID whitelist enforcement
- All API keys via environment variables
- Database runs locally via Docker
- Embeddings computed locally via Transformers.js
- Bot sessions isolated from dev sessions via separate `cwd`
