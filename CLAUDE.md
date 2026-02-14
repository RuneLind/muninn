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

## Debugging
When debugging issues, exhaust the most likely root cause hypothesis thoroughly before moving to the next. Avoid shotgun debugging — form a clear hypothesis, test it, and only move on when it's definitively ruled out. Especially for Slack bot issues, check app configuration and permissions before assuming code bugs.

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
bun run dev:simulator       # Simulator UI (no tokens needed)
```

### Dual-Instance Mode (Production + Simulator)

Production runs natively on macOS (voice, real bots). A second instance with the simulator UI can run alongside it on a different port and database — useful for development and testing.

```
┌──────────────────────────┐     ┌──────────────────────────┐
│  Production (port 3010)  │     │  Simulator (port 3011)   │
│  Real Telegram/Slack     │     │  Browser chat UI         │
│  Voice, scheduler        │     │  No tokens, no scheduler │
│  DATABASE_URL            │     │  SIMULATOR_DATABASE_URL   │
└──────────┬───────────────┘     └──────────┬───────────────┘
           │                                │
           └───────── Postgres ─────────────┘
                    (port 5434)
```

| Instance   | Port | Database           | Scheduler | Tokens  |
|------------|------|--------------------|-----------|---------|
| Production | 3010 | `javrvis`          | On        | Required|
| Simulator  | 3011 | `javrvis_simulator`| Off       | None    |
| Tests      | —    | `javrvis_test`     | —         | —       |

**Quick start (same checkout):**
```bash
bun run dev:simulator       # Uses env overrides, no .env changes needed
```

**Git worktree setup (isolated changes):**
```bash
# Create worktree from main
git worktree add ../javrvis-sim feature/simulator-dev

# In the worktree, create .env with simulator settings:
# SIMULATOR_ENABLED=true
# DASHBOARD_PORT=3011
# SCHEDULER_ENABLED=false
# DATABASE_URL=postgresql://javrvis:javrvis@127.0.0.1:5434/javrvis
# SIMULATOR_DATABASE_URL=postgresql://javrvis:javrvis@127.0.0.1:5434/javrvis_simulator

# Run from worktree
cd ../javrvis-sim && bun run dev

# Worktree management
git worktree list           # List all worktrees
git worktree remove ../javrvis-sim  # Clean up
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
- `config.json` — per-bot overrides (model, thinking tokens, timeout)
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
| Memory | `src/memory/extractor.ts` | Async Claude Haiku call to extract memories (personal or shared scope) |
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
│   ├── config.json              ← model, thinking, timeout overrides
│   ├── .mcp.json                ← Gmail, Calendar MCPs
│   └── .claude/
│       └── settings.local.json  ← tool permissions
├── capra/
│   ├── CLAUDE.md
│   ├── config.json
│   ├── .mcp.json
│   └── .claude/
│       └── settings.local.json
```

#### Per-bot config.json

All fields are optional — falls back to global `.env` values:

```json
{
  "model": "sonnet",
  "thinkingMaxTokens": 16000,
  "timeoutMs": 180000
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `model` | string | `CLAUDE_MODEL` env | Claude model (e.g. "opus", "sonnet") |
| `thinkingMaxTokens` | number | CLI default | Max thinking tokens (0 = disable thinking) |
| `timeoutMs` | number | `CLAUDE_TIMEOUT_MS` env | Response timeout in ms |

### Database

PostgreSQL + pgvector via Docker (single container).

- URL: `postgresql://javrvis:javrvis@127.0.0.1:5434/javrvis`
- Schema: `db/init.sql` (runs automatically on first `docker compose up`)
- Start: `bun run db:up` / Stop: `bun run db:down`
- Backup: `bun run db:backup` / Restore: `bun run db:restore`
- Tables: `messages`, `activity_log`, `memories` (with vector embeddings + scope), `goals`, `scheduled_tasks`, `watchers`, `user_settings`, `haiku_usage`

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
| `SIMULATOR_ENABLED` | No | `false` | Enable browser-based simulator UI |
| `SIMULATOR_DATABASE_URL` | No | `DATABASE_URL` + `_simulator` | Separate DB for simulator instance |
| `TRACING_ENABLED` | No | `true` | Enable request tracing |
| `TRACING_RETENTION_DAYS` | No | `7` | Days to keep trace data |
| `PROMPT_SNAPSHOTS_RETENTION_DAYS` | No | `3` | Days to keep prompt snapshots |
| `SLACK_BOT_TOKEN_<NAME>` | No | — | Slack bot token (per bot) |
| `SLACK_APP_TOKEN_<NAME>` | No | — | Slack app-level token (per bot) |
| `SLACK_ALLOWED_USER_IDS_<NAME>` | No | — | Comma-separated Slack user IDs |
| `GOAL_CHECK_INTERVAL_MS` | No | — | Legacy alias for `SCHEDULER_INTERVAL_MS` |
| `GOAL_CHECK_ENABLED` | No | — | Legacy alias for `SCHEDULER_ENABLED` |

### Adding a New Bot

1. Create `bots/<name>/CLAUDE.md` with the bot's persona
2. Optionally add `bots/<name>/config.json` (model, thinking, timeout overrides)
3. Optionally add `bots/<name>/.mcp.json` and `bots/<name>/.claude/settings.local.json`
4. Add `TELEGRAM_BOT_TOKEN_<NAME>=...` and `TELEGRAM_ALLOWED_USER_IDS_<NAME>=...` to `.env`
5. Restart — the bot is auto-discovered

## Slack Bot
When implementing Slack bot features, be aware of the different message contexts (DMs, threads, channels, Assistant API) — each has different API constraints and capabilities. Check Slack app configuration settings (like 'Agent or Assistant' toggle) as a potential root cause before writing code fixes.

### Testing

Always run `bun run test` after adding or changing a feature to verify nothing is broken. Tests are split into two groups to avoid `mock.module()` leakage between files:

```bash
bun run test              # All tests
bun run test:unit         # Unit tests only
bun run test:db           # DB integration tests
bun run test:handlers     # Handler tests (with mocks)
```

DB tests require the local Postgres container (`bun run db:up`) and use a separate `javrvis_test` database. Test files are co-located with source files (`*.test.ts`). Shared test infrastructure lives in `src/test/`.

### Conventions

- DB access: `postgres` npm package (not Supabase client, not Bun.sql)
- Memory/goal/schedule extraction: fire-and-forget async Claude Haiku calls
- Memory scope: `personal` (per-user) or `shared` (visible to all users of a bot) — Haiku auto-classifies during extraction
- Telegram formatting: HTML only (no Markdown) — see `telegram-format.ts`
- Prompt assembly: persona (from CLAUDE.md) + memories (personal + shared) + goals + scheduled tasks + conversation history
- Claude CLI isolation: each bot spawned with `cwd: bots/<name>/` — auto-discovers MCP, settings, stores history there
- Scheduled tasks: cron-style (hour/minute/days) or interval-style (every N ms), timezone-aware
- Watchers: interval-based background monitors (email, calendar, etc.) with dedup via `lastNotifiedIds`
- Watcher email checking: Haiku spawned with bot's cwd for Gmail MCP access
- Quiet hours: per-user, timezone-aware, overnight ranges supported (e.g. 22-08)
- All timestamps stored as `TIMESTAMPTZ` in DB, exposed as epoch ms in TypeScript

## Database & Migrations 
After creating database migrations, always remind the user to run them against the target database. When modifying data models, check if existing data needs to be backfilled or updated — don't assume only new records matter.

## Code Quality 
This project is primarily TypeScript. Always ensure code compiles cleanly (`tsc --noEmit` or equivalent) before committing. When fixing TypeScript errors, fix all of them — don't leave partial fixes.

