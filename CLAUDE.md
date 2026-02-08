---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

---

## Jarvis Project

Personal AI assistant — multi-bot Telegram platform backed by Claude CLI, with a live Hono dashboard, semantic memory, goal tracking, scheduled tasks, proactive watchers, and voice support.

### Running

```bash
bun run db:up               # Start Postgres (requires Docker)
bun run dev                 # Dev with --watch
bun run start               # Production
```

### Multi-Bot Architecture

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

Each bot lives in `bots/<name>/` with its own:
- `CLAUDE.md` — persona (auto-loaded by Claude CLI as project instructions)
- `.mcp.json` — MCP tools (Gmail, Calendar, etc.)
- `.claude/settings.local.json` — tool permissions

Claude CLI is spawned with `cwd: bots/<name>/` so it auto-discovers all config and stores conversation history separately from the dev project root.

A bot is active if its folder has a `CLAUDE.md` and a matching `TELEGRAM_BOT_TOKEN_<NAME>` env var.

### Key Modules

| Module | Path | Purpose |
|---|---|---|
| Bot Discovery | `src/bots/config.ts` | Auto-discovers bot folders, loads persona + config |
| Bot | `src/bot/` | Grammy Telegram handlers (text + voice), auth middleware |
| AI | `src/ai/` | Claude executor (cwd-based isolation), prompt builder, embeddings |
| Memory | `src/memory/extractor.ts` | Async Claude Haiku call to extract memories from conversations |
| Goals | `src/goals/detector.ts` | Goal detector (async Claude Haiku) |
| Scheduler | `src/scheduler/` | Unified scheduler (scheduled tasks + goal reminders + watchers), task detector, shared Haiku executor |
| Watchers | `src/watchers/` | Proactive outreach — email watcher (Haiku + Gmail MCP), quiet hours, runner |
| DB | `src/db/` | Postgres CRUD — messages, memories, activity, goals, scheduled tasks, watchers, user settings |
| Dashboard | `src/dashboard/` | Hono server with SSE activity feed + REST APIs |
| Voice | `src/voice/` | STT (whisper-cli) + TTS (macOS say + ffmpeg) |

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

### Database

PostgreSQL + pgvector via Docker (single container).

- URL: `postgresql://javrvis:javrvis@127.0.0.1:5434/javrvis`
- Schema: `db/init.sql` (runs automatically on first `docker compose up`)
- Start: `bun run db:up` / Stop: `bun run db:down`
- Backup: `bun run db:backup` / Restore: `bun run db:restore`
- Tables: `messages`, `activity_log`, `memories` (with vector embeddings), `goals`, `scheduled_tasks`, `watchers`, `user_settings`, `haiku_usage`

### Configuration (.env)

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN_<NAME>` | Yes (per bot) | — | From @BotFather (e.g. `TELEGRAM_BOT_TOKEN_JARVIS`) |
| `TELEGRAM_ALLOWED_USER_IDS_<NAME>` | Yes (per bot) | — | Comma-separated Telegram user IDs (e.g. `TELEGRAM_ALLOWED_USER_IDS_JARVIS`) |
| `DATABASE_URL` | Yes | — | Postgres connection string |
| `DASHBOARD_PORT` | No | `3000` | Web dashboard port |
| `CLAUDE_TIMEOUT_MS` | No | `120000` | Claude response timeout (ms) |
| `CLAUDE_MODEL` | No | `sonnet` | Claude model for main responses |
| `WHISPER_MODEL_PATH` | No | `./models/ggml-base.en.bin` | whisper-cpp model file |
| `SCHEDULER_INTERVAL_MS` | No | `60000` | Unified scheduler tick interval (ms, default 1min) |
| `SCHEDULER_ENABLED` | No | `true` | Enable/disable unified scheduler (tasks + goal reminders) |
| `GOAL_CHECK_INTERVAL_MS` | No | — | Legacy alias for `SCHEDULER_INTERVAL_MS` |
| `GOAL_CHECK_ENABLED` | No | — | Legacy alias for `SCHEDULER_ENABLED` |

### Adding a New Bot

1. Create `bots/<name>/CLAUDE.md` with the bot's persona
2. Optionally add `bots/<name>/.mcp.json` and `bots/<name>/.claude/settings.local.json`
3. Add `TELEGRAM_BOT_TOKEN_<NAME>=...` and `TELEGRAM_ALLOWED_USER_IDS_<NAME>=...` to `.env`
4. Restart — the bot is auto-discovered

### Conventions

- DB access: `postgres` npm package (not Supabase client, not Bun.sql)
- Memory/goal/schedule extraction: fire-and-forget async Claude Haiku calls
- Telegram formatting: HTML only (no Markdown) — see `telegram-format.ts`
- Prompt assembly: persona (from CLAUDE.md) + memories + goals + scheduled tasks + conversation history
- Claude CLI isolation: each bot spawned with `cwd: bots/<name>/` — auto-discovers MCP, settings, stores history there
- Scheduled tasks: cron-style (hour/minute/days) or interval-style (every N ms), timezone-aware
- Watchers: interval-based background monitors (email, calendar, etc.) with dedup via `lastNotifiedIds`
- Watcher email checking: Haiku spawned with bot's cwd for Gmail MCP access
- Quiet hours: per-user, timezone-aware, overnight ranges supported (e.g. 22-08)
- All timestamps stored as `TIMESTAMPTZ` in DB, exposed as epoch ms in TypeScript
