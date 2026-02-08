# Jarvis

Multi-bot Telegram platform backed by Claude CLI — each bot gets its own persona, MCP tools, and permissions, all running in a single process with shared DB, dashboard, and scheduler.

## Features

- **Multi-Bot Architecture** — Multiple Telegram bots in one process, each with isolated persona, MCP tools, and Claude CLI history
- **Claude AI** — Responses powered by Claude Code headless mode (`claude -p`) with per-bot `cwd` isolation
- **Semantic Memory** — Automatically extracts and recalls facts from conversations using local embeddings (Transformers.js) and hybrid search (FTS + pgvector)
- **Goal Tracking** — Detects goals/commitments/deadlines from conversations, injects them into prompt context, and proactively sends reminders and check-ins
- **Scheduled Tasks** — Cron-style or interval-based recurring tasks detected from conversation ("remind me every morning at 8") — supports reminders, AI-generated briefings, and custom prompts
- **Proactive Watchers** — Background monitors (email via Gmail MCP) with quiet hours and dedup
- **Voice** — Speech-to-text (whisper-cli) and text-to-speech (macOS say + ffmpeg) with mirror mode (voice in → voice + text out)
- **Live Dashboard** — Hono web server with SSE real-time activity feed, stats, goals, tasks, and memories panels
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

2. Start local database:
   ```bash
   bun run db:up
   ```

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
                    │        Single javrvis process    │
                    │                                  │
Telegram user A ───►│  Grammy Bot 1 (Jarvis)           │
                    │    → Claude CLI (cwd: bots/jarvis)│
                    │                                  │
Telegram user B ───►│  Grammy Bot 2 (Capra)            │
                    │    → Claude CLI (cwd: bots/capra) │
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
├── capra/                        ← future bot
│   ├── CLAUDE.md
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
| `src/ai/` | Claude executor (cwd-based isolation), prompt builder, local embeddings |
| `src/memory/` | Async memory extraction from conversations |
| `src/goals/` | Goal detection (async Claude Haiku) |
| `src/scheduler/` | Unified scheduler (scheduled tasks + goal reminders + watchers), shared Haiku executor |
| `src/watchers/` | Proactive outreach — email watcher (Haiku + Gmail MCP), quiet hours |
| `src/db/` | Postgres CRUD — messages, memories, goals, scheduled tasks, activity, watchers |
| `src/dashboard/` | Hono web server with SSE + REST APIs |
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

## Dashboard API

- `GET /` — Live activity dashboard (HTML)
- `GET /api/activity` — Recent activity events + stats
- `GET /api/messages/:userId` — Conversation history for a user
- `GET /api/goals/:userId` — Active goals for a user
- `GET /api/scheduled-tasks/:userId` — Scheduled tasks for a user
- `GET /api/events` — SSE stream for real-time activity updates

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

## Security

- No public ports — local Telegram relay only
- Per-bot Telegram user ID whitelist enforcement
- All API keys via environment variables
- Database runs locally via Docker
- Embeddings computed locally via Transformers.js
- Bot sessions isolated from dev sessions via separate `cwd`
