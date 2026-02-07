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

Personal AI assistant — Telegram bot backed by Claude CLI, with a live Hono dashboard, semantic memory, goal tracking, scheduled tasks, and voice support.

### Running

```bash
supabase start              # Start local Postgres (requires Docker)
bun run dev                 # Dev with --watch
bun run start               # Production
```

### Architecture

```
Telegram → grammy bot → claude CLI (Bun.spawn) → response → Telegram
                ↓                                      ↓
          Save to DB                  Extract memories + goals + schedules (async)
                ↓                                      ↓
        Hono dashboard (SSE)          Unified scheduler (tasks + goal reminders)
```

### Key Modules

| Module | Path | Purpose |
|---|---|---|
| Bot | `src/bot/` | Grammy Telegram handlers (text + voice), auth middleware |
| AI | `src/ai/` | Claude executor, prompt builder (memories + goals + tasks + history), embeddings |
| Memory | `src/memory/extractor.ts` | Async Claude Haiku call to extract memories from conversations |
| Goals | `src/goals/detector.ts` | Goal detector (async Claude Haiku) |
| Scheduler | `src/scheduler/` | Unified scheduler (scheduled tasks + goal reminders), task detector, shared Haiku executor |
| DB | `src/db/` | Postgres CRUD — messages, memories, activity, goals, scheduled tasks |
| Dashboard | `src/dashboard/` | Hono server with SSE activity feed + REST APIs |
| Voice | `src/voice/` | STT (whisper-cli) + TTS (macOS say + ffmpeg) |

### Database

Local Supabase (PostgreSQL + pgvector) via Docker.

- URL: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`
- Migrations: `supabase/migrations/`
- Apply: `bunx supabase db reset` or `bunx supabase migration up --local`
- Tables: `messages`, `activity_log`, `memories` (with vector embeddings), `goals`, `scheduled_tasks`

### Configuration (.env)

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | — | From @BotFather |
| `TELEGRAM_ALLOWED_USER_IDS` | Yes | — | Comma-separated Telegram user IDs |
| `DATABASE_URL` | Yes | — | Postgres connection string |
| `DASHBOARD_PORT` | No | `3000` | Web dashboard port |
| `CLAUDE_TIMEOUT_MS` | No | `120000` | Claude response timeout (ms) |
| `CLAUDE_MODEL` | No | `sonnet` | Claude model for main responses |
| `WHISPER_MODEL_PATH` | No | `./models/ggml-base.en.bin` | whisper-cpp model file |
| `SCHEDULER_INTERVAL_MS` | No | `60000` | Unified scheduler tick interval (ms, default 1min) |
| `SCHEDULER_ENABLED` | No | `true` | Enable/disable unified scheduler (tasks + goal reminders) |
| `GOAL_CHECK_INTERVAL_MS` | No | — | Legacy alias for `SCHEDULER_INTERVAL_MS` |
| `GOAL_CHECK_ENABLED` | No | — | Legacy alias for `SCHEDULER_ENABLED` |

### Conventions

- DB access: `postgres` npm package (not Supabase client, not Bun.sql)
- Memory/goal/schedule extraction: fire-and-forget async Claude Haiku calls
- Telegram formatting: HTML only (no Markdown) — see `telegram-format.ts`
- Prompt assembly: system prompt + memories + goals + scheduled tasks + conversation history
- Scheduled tasks: cron-style (hour/minute/days) or interval-style (every N ms), timezone-aware
- All timestamps stored as `TIMESTAMPTZ` in DB, exposed as epoch ms in TypeScript
