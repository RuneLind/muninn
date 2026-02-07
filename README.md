# Jarvis

Personal AI assistant — Telegram bot backed by Claude CLI, with semantic memory, goal tracking, scheduled tasks, voice support, and a live web dashboard.

## Features

- **Telegram Bot** — Text and voice message handling via Grammy
- **Claude AI** — Responses powered by Claude Code headless mode (`claude -p`)
- **Semantic Memory** — Automatically extracts and recalls facts from conversations using local embeddings (Transformers.js) and hybrid search (FTS + pgvector)
- **Goal Tracking** — Detects goals/commitments/deadlines from conversations, injects them into prompt context, and proactively sends reminders and check-ins
- **Scheduled Tasks** — Cron-style or interval-based recurring tasks detected from conversation ("remind me every morning at 8") — supports reminders, AI-generated briefings, and custom prompts
- **Voice** — Speech-to-text (whisper-cli) and text-to-speech (macOS say + ffmpeg) with mirror mode (voice in → voice + text out)
- **Live Dashboard** — Hono web server with SSE real-time activity feed
- **Local-first** — All data stays on your machine (Supabase local, local embeddings, no cloud dependencies beyond Telegram and Claude API)

## Prerequisites

- [Bun](https://bun.sh) runtime
- [Docker](https://docker.com) (for local Supabase/PostgreSQL)
- [Supabase CLI](https://supabase.com/docs/guides/cli) (`brew install supabase/tap/supabase`)
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
   supabase start
   ```

3. Configure environment:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` with your values (see [Configuration](#configuration) below).

4. Apply database migrations:
   ```bash
   bunx supabase migration up --local
   ```

5. Start Jarvis:
   ```bash
   bun run dev    # Development with file watching
   bun run start  # Production
   ```

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Bot token from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_ALLOWED_USER_IDS` | Yes | — | Comma-separated Telegram user IDs allowed to use the bot |
| `DATABASE_URL` | Yes | — | Postgres connection string (default local: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`) |
| `DASHBOARD_PORT` | No | `3000` | Web dashboard port |
| `CLAUDE_TIMEOUT_MS` | No | `120000` | Claude response timeout in ms |
| `CLAUDE_MODEL` | No | `sonnet` | Claude model for main responses |
| `WHISPER_MODEL_PATH` | No | `./models/ggml-base.en.bin` | Path to whisper-cpp model file |
| `SCHEDULER_INTERVAL_MS` | No | `60000` | Unified scheduler tick interval in ms (default 1min) |
| `SCHEDULER_ENABLED` | No | `true` | Enable/disable unified scheduler (tasks + goal reminders) |
| `GOAL_CHECK_INTERVAL_MS` | No | — | Legacy alias for `SCHEDULER_INTERVAL_MS` |
| `GOAL_CHECK_ENABLED` | No | — | Legacy alias for `SCHEDULER_ENABLED` |

## Architecture

```
Telegram → Grammy bot → Claude CLI (Bun.spawn) → Response → Telegram
                ↓                                      ↓
          Save to DB                Extract memories + goals + schedules (async Haiku)
                ↓                                      ↓
      Hono dashboard (SSE)          Unified scheduler (tasks + goal reminders)
```

### Key paths

| Path | Purpose |
|---|---|
| `src/index.ts` | Entrypoint — inits DB, starts bot + dashboard + scheduler |
| `src/bot/` | Telegram handlers (text, voice), auth middleware, HTML formatting |
| `src/ai/` | Claude executor, prompt builder, local embeddings |
| `src/memory/` | Async memory extraction from conversations |
| `src/goals/` | Goal detection (async Claude Haiku) |
| `src/scheduler/` | Unified scheduler (scheduled tasks + goal reminders), task detector, shared Haiku executor |
| `src/db/` | Postgres CRUD — messages, memories, goals, scheduled tasks, activity |
| `src/dashboard/` | Hono web server with SSE + REST APIs |
| `src/voice/` | STT (whisper-cli) + TTS (macOS say + ffmpeg) |
| `supabase/migrations/` | Database schema migrations |

## Dashboard API

- `GET /` — Live activity dashboard (HTML)
- `GET /api/activity` — Recent activity events + stats
- `GET /api/messages/:userId` — Conversation history for a user
- `GET /api/goals/:userId` — Active goals for a user
- `GET /api/scheduled-tasks/:userId` — Scheduled tasks for a user
- `GET /api/events` — SSE stream for real-time activity updates

## How It Works

### Memory
After each conversation exchange, Jarvis asynchronously asks Claude Haiku whether the exchange contains facts worth remembering (preferences, decisions, project details). If so, it stores a summary with tags and a vector embedding for later semantic retrieval.

### Goals
Similarly, Jarvis detects goals, commitments, and deadlines from conversations. Active goals are injected into the prompt context so Jarvis is always aware of what you're working toward. A unified background scheduler sends:
- **Deadline reminders** — 24 hours before a deadline (max once per 12h)
- **Check-ins** — When a goal hasn't been discussed in 3+ days (max 1 per scheduler tick)

### Scheduled Tasks
Jarvis detects recurring task requests from conversation (e.g. "remind me every morning at 8 to review my goals"). Three task types:
- **reminder** — Simple recurring messages ("stretch every 2 hours")
- **briefing** — AI-generated summaries with goals and context ("morning briefing at 8am")
- **custom** — Arbitrary prompts run through Claude Haiku ("every Friday summarize my week")

Tasks support two scheduling modes:
- **Cron-style** — Specific hour/minute + optional day-of-week filter (e.g. weekdays at 08:00)
- **Interval-style** — Repeat every N milliseconds (e.g. every 2 hours)

All schedules are timezone-aware (default: Europe/Oslo). The unified scheduler ticks every 60 seconds and handles both scheduled tasks and goal reminders.

### Voice
Send a voice message and Jarvis will transcribe it (whisper-cli), process it through Claude, and reply with both text and a voice message (mirror mode).

## Security

- No public ports — local Telegram relay only
- Telegram user ID whitelist enforcement
- All API keys via environment variables
- Database runs locally via Docker
- Embeddings computed locally via Transformers.js
