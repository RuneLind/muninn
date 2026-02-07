# Jarvis

Personal AI assistant — Telegram bot backed by Claude, with a live web dashboard.

## Setup

1. Install dependencies:
   ```bash
   bun install
   ```

2. Configure environment:
   ```bash
   cp .env.example .env
   ```
   Fill in your values:
   - `TELEGRAM_BOT_TOKEN` — Get from [@BotFather](https://t.me/BotFather)
   - `TELEGRAM_ALLOWED_USER_IDS` — Comma-separated Telegram user IDs
   - `DASHBOARD_PORT` — Web dashboard port (default: 3000)
   - `CLAUDE_TIMEOUT_MS` — Claude response timeout (default: 120000)
   - `CLAUDE_MODEL` — Claude model to use (default: sonnet)

3. Ensure `claude` CLI is installed and authenticated.

## Run

```bash
bun run dev    # Development with file watching
bun run start  # Production
```

## Architecture

```
Telegram → grammy bot → claude CLI (Bun.spawn) → response → Telegram
                                                      ↓
                                            ActivityLog (in-memory)
                                                      ↓
                                            Hono dashboard (SSE)
```

Dashboard is available at `http://localhost:3000` (or your configured port).
