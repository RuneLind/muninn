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

## Muninn Project

Personal AI assistant — multi-bot Telegram platform with pluggable AI connectors (Claude CLI or Copilot SDK), a live Hono dashboard, semantic memory, goal tracking, scheduled tasks, proactive watchers, and voice support.

### Running

```bash
bun run db:up               # Start Postgres (requires Docker)
bun run db:migrate:baseline # Mark existing migrations as applied (first time only)
bun run db:migrate          # Apply pending migrations
bun run dev                 # Dev with --watch
bun run start               # Production
bun run dev:chat            # Chat-only (no scheduler, port 3011)
```

### Multi-Bot Architecture

```
                    ┌────────────────────────────────────┐
                    │       Single muninn process        │
                    │                                    │
Telegram user A ───►│  Grammy Bot 1 (Jarvis)             │
                    │    → AI connector (claude-cli)     │
                    │                                    │
Telegram user B ───►│  Grammy Bot 2 (Your Bot)           │
                    │    → AI connector (copilot-sdk)    │
                    │                                    │
                    │  Shared: DB, Dashboard, Scheduler  │
                    └────────────────────────────────────┘
```

Each bot lives in `bots/<name>/` with its own:
- `CLAUDE.md` — persona (auto-loaded by Claude CLI as project instructions)
- `config.json` — per-bot overrides (connector, model, thinking tokens, timeout, baseUrl)
- `.mcp.json` — MCP tools (Gmail, Calendar, etc.)
- `.claude/settings.json` — tool permissions

Each bot selects its AI connector via `config.json` (`"connector": "claude-cli"`, `"copilot-sdk"`, or `"openai-compat"`). Claude CLI is spawned with `cwd: bots/<name>/` so it auto-discovers all config and stores conversation history separately. The Copilot SDK connector uses a shared JSON-RPC client with per-request sessions. The OpenAI-compat connector calls any OpenAI-compatible API (Ollama, LM Studio, vLLM) with MCP tool execution and streaming.

A bot is active if its folder has a `CLAUDE.md` and a matching `TELEGRAM_BOT_TOKEN_<NAME>` env var.

### Key Modules

| Module | Path | Purpose |
|---|---|---|
| Bot Discovery | `src/bots/config.ts` | Auto-discovers bot folders, loads persona + config |
| Bot | `src/bot/` | Grammy Telegram handlers (text + voice), auth middleware |
| AI | `src/ai/` | Connector abstraction (`connector.ts`), Claude CLI + Copilot SDK + OpenAI-compat connectors, prompt builder, embeddings |
| Memory | `src/memory/extractor.ts` | Async Claude Haiku call to extract memories (personal or shared scope) |
| Goals | `src/goals/detector.ts` | Goal detector (async Claude Haiku) |
| Scheduler | `src/scheduler/` | Unified scheduler (scheduled tasks + goal reminders + watchers), task detector, shared Haiku executor |
| Watchers | `src/watchers/` | Proactive outreach — email watcher (Haiku + Gmail MCP), quiet hours, runner |
| Threads | `src/db/threads.ts`, `src/bot/topic-commands.ts` | Per-user+bot conversation threads for isolated chat history |
| DB | `src/db/` | Postgres CRUD — messages, memories, activity, goals, scheduled tasks, watchers, threads, user settings |
| Tracing | `src/tracing/` | Request tracing with span hierarchy, tool call child spans |
| Dashboard | `src/dashboard/` | Hono server with SSE activity feed, traces waterfall + REST APIs |
| Voice | `src/voice/` | STT (whisper-cli) + TTS (macOS say + ffmpeg) |
| Extensions | `extensions/` | Chrome extensions (Jira research, YouTube summarizer) — each subfolder is a standalone extension |

### Bot Folder Structure

```
bots/
├── jarvis/                      ← example bot (included)
│   ├── CLAUDE.md                ← persona + rules
│   ├── config.json              ← connector, model, thinking, timeout overrides
│   ├── .mcp.json                ← Gmail, Calendar MCPs
│   └── .claude/
│       └── settings.json  ← tool permissions
├── your-bot/                    ← add your own here
│   └── ...
```

#### Per-bot config.json

All fields are optional — falls back to global `.env` values:

```json
{
  "connector": "copilot-sdk",
  "model": "claude-sonnet-4-6",
  "thinkingMaxTokens": 16000,
  "timeoutMs": 180000
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `connector` | string | `"claude-cli"` | AI backend: `"claude-cli"`, `"copilot-sdk"`, or `"openai-compat"` |
| `model` | string | `CLAUDE_MODEL` env | Model name (e.g. "claude-sonnet-4-6", "qwen3.5:35b") |
| `thinkingMaxTokens` | number | CLI default | Max thinking tokens (0 = disable thinking). For openai-compat: used as max_tokens. |
| `timeoutMs` | number | `CLAUDE_TIMEOUT_MS` env | Response timeout in ms |
| `baseUrl` | string | — | Base URL for OpenAI-compatible API (e.g. `"http://localhost:11434/v1"`) |
| `showWaterfall` | boolean | `true` | Show request progress waterfall overlay in web chat |
| `contextWindow` | number | — | Context window size in tokens (e.g. `32768`). Shown as usage in web chat and percentage in Telegram footer |
| `prompts` | object | — | Configurable prompts: `jiraAnalysis` (Jira research instruction, content appended automatically), `investigateCode` (follow-up code investigation prompt) |

### Database

PostgreSQL + pgvector via Docker (single container).

- URL: `postgresql://muninn:muninn@127.0.0.1:5435/muninn`
- Schema: `db/init.sql` (full consolidated schema, applied by Docker on first start)
- Migrations: `db/migrations/` (numbered `.sql` and `.ts` files, tracked in `schema_migrations` table)
- Start: `bun run db:up` / Stop: `bun run db:down`
- Migrate: `bun run db:migrate` / Status: `bun run db:migrate:status` / Baseline: `bun run db:migrate:baseline`
- Test DB: `bun run db:setup:test` (creates `muninn_test`, applies schema + baseline)
- Backup: `bun run db:backup` / Restore: `bun run db:restore`
- Tables: `users` (canonical user identity), `messages`, `activity_log`, `memories` (with vector embeddings + scope), `goals`, `scheduled_tasks`, `watchers`, `connectors` (named AI connector configurations), `threads` (per-user+bot conversation isolation, optional FK to connectors), `user_settings`, `haiku_usage`, `traces` (spans with parent-child hierarchy + JSONB attributes)

### Configuration (.env)

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN_<NAME>` | Yes (per bot) | — | From @BotFather (e.g. `TELEGRAM_BOT_TOKEN_JARVIS`) |
| `TELEGRAM_ALLOWED_USER_IDS_<NAME>` | Yes (per bot) | — | Comma-separated Telegram user IDs (e.g. `TELEGRAM_ALLOWED_USER_IDS_JARVIS`) |
| `DATABASE_URL` | Yes | — | Postgres connection string |
| `DASHBOARD_PORT` | No | `3010` | Web dashboard port |
| `CLAUDE_TIMEOUT_MS` | No | `120000` | Claude response timeout (ms) |
| `CLAUDE_MODEL` | No | `sonnet` | Claude model for main responses |
| `WHISPER_MODEL_PATH` | No | `./models/ggml-base.en.bin` | whisper-cpp model file |
| `SCHEDULER_INTERVAL_MS` | No | `60000` | Unified scheduler tick interval (ms, default 1min) |
| `SCHEDULER_ENABLED` | No | `true` | Enable/disable unified scheduler (tasks + goal reminders) |
| `TRACING_ENABLED` | No | `true` | Enable request tracing |
| `TRACING_RETENTION_DAYS` | No | `7` | Days to keep trace data |
| `PROMPT_SNAPSHOTS_RETENTION_DAYS` | No | `3` | Days to keep prompt snapshots |
| `SLACK_BOT_TOKEN_<NAME>` | No | — | Slack bot token (per bot) |
| `SLACK_APP_TOKEN_<NAME>` | No | — | Slack app-level token (per bot) |
| `SLACK_ALLOWED_USER_IDS_<NAME>` | No | — | Comma-separated Slack user IDs |
| `LOG_DIR` | No | `./logs` | Log file directory (set `none` to disable file logging) |
| `GOAL_CHECK_INTERVAL_MS` | No | — | Legacy alias for `SCHEDULER_INTERVAL_MS` |
| `GOAL_CHECK_ENABLED` | No | — | Legacy alias for `SCHEDULER_ENABLED` |

### Adding a New Bot

1. Create `bots/<name>/CLAUDE.md` with the bot's persona
2. Optionally add `bots/<name>/config.json` (connector, model, thinking, timeout overrides)
3. Optionally add `bots/<name>/.mcp.json` and `bots/<name>/.claude/settings.json`
4. Add `TELEGRAM_BOT_TOKEN_<NAME>=...` and `TELEGRAM_ALLOWED_USER_IDS_<NAME>=...` to `.env`
5. Restart — the bot is auto-discovered

### Config Sync

Bot folders (except jarvis) and `.env` are gitignored and tracked in a separate private repo (`~/source/private/muninn-config`). After changing any bot config, persona, or MCP settings, sync with:

```bash
bun run config:sync -- --commit
```

## Serena Code Analysis (MCP Proxy)

Serena provides code search and analysis tools (find_symbol, search_for_pattern, etc.) for large codebases. Instead of spawning Serena per chat session, instances run as persistent HTTP servers managed from the dashboard.

### How it works

1. Open the **Serena** page in the dashboard (`/serena`)
2. Click **Start** on the instances you need (or **Start All**)
3. Each instance spawns Serena with `--transport streamable-http` on a dedicated port
4. The bot's `.mcp.json` has `type: "http"` entries pointing directly to these ports
5. The copilot-sdk connects to Serena over HTTP — no proxy, no per-session spawning
6. Click **Stop** when done to free resources

### Configuration

Serena instances are defined in the bot's `config.json` under a `serena` key:

```json
{
  "serena": [
    { "name": "serena-api", "displayName": "Backend API", "projectPath": "/path/to/project", "port": 9121 }
  ]
}
```

The matching `.mcp.json` entry points to the instance's HTTP endpoint:

```json
{
  "serena-api": { "type": "http", "url": "http://127.0.0.1:9121/mcp" }
}
```

### Manual usage

To start a Serena instance manually (outside muninn):

```bash
uvx --from "git+https://github.com/oraios/serena" serena start-mcp-server \
  --transport streamable-http \
  --port 9121 \
  --host 127.0.0.1 \
  --context claude-code \
  --project /path/to/project \
  --open-web-dashboard False
```

To pre-index a project (faster startup):

```bash
uvx --from "git+https://github.com/oraios/serena" serena project index /path/to/project --timeout 300
```

### Key files

| File | Purpose |
|---|---|
| `src/serena/manager.ts` | SerenaManager singleton — start/stop/index lifecycle |
| `src/serena/config.ts` | Config types + discovery from bot config.json |
| `src/dashboard/views/serena-page.ts` | Dashboard UI for managing instances |
| `src/dashboard/mcp-client.ts` | MCP Debug client — supports both stdio and HTTP servers |

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

DB tests require the local Postgres container (`bun run db:up`) and a test database (`bun run db:setup:test`). Test files are co-located with source files (`*.test.ts`). Shared test infrastructure lives in `src/test/`.

### Conventions

- DB access: `postgres` npm package (not Supabase client, not Bun.sql)
- Memory/goal/schedule extraction: fire-and-forget async Claude Haiku calls
- Memory scope: `personal` (per-user) or `shared` (visible to all users of a bot) — Haiku auto-classifies during extraction
- AI output: standard markdown — per-platform formatters convert at send time (`telegram-format.ts`, `web-format.ts`, `slack-format.ts`)
- Conversation threads: per-user+bot named threads for chat isolation; memories/goals/tasks shared across threads. Commands: `/topic`, `/topics`, `/deltopic`. Pre-migration messages (NULL thread_id) visible only in `main` thread.
- Prompt assembly: persona (from CLAUDE.md) + memories (personal + shared) + goals + scheduled tasks + thread-scoped conversation history
- AI connectors: `resolveConnector(botConfig)` returns the appropriate executor (`claude-cli`, `copilot-sdk`, or `openai-compat`). All callers use this instead of importing executors directly. Connectors conform to the `AiConnector` type signature.
- Claude CLI connector: spawned with `cwd: bots/<name>/` — auto-discovers MCP, settings, stores history there. Output: `--output-format stream-json --verbose` (NDJSON events with tool_use blocks); `--verbose` is required with `-p` flag. Falls back to legacy JSON parser if stream result event is missing (known CLI bug)
- Copilot SDK connector: shared `CopilotClient` singleton (lazy-loaded), per-request sessions. Reads `.mcp.json` and converts to SDK format. Emits `assistant.intent` events shown as inline chat bubbles.
- OpenAI-compat connector: calls any OpenAI-compatible API (Ollama, LM Studio, vLLM). Agent loop with MCP tool execution — loads tools from `.mcp.json`, sends as OpenAI `tools` parameter, executes tool_calls against MCP servers in a multi-turn loop. Handles Qwen3/Ollama thinking tokens (`reasoning` field + `<think>` tag stripping). Retries on empty responses (3x with 2s delay).
- MCP tool tracking: tool calls extracted from stream events (stream-json for CLI, session events for SDK), per-tool timing, displayed as child spans in traces waterfall
- Scheduled tasks: cron-style (hour/minute/days) or interval-style (every N ms), timezone-aware
- Watchers: interval-based background monitors (email, calendar, etc.) with dedup via `lastNotifiedIds`
- Watcher email checking: Haiku spawned with bot's cwd for Gmail MCP access
- Quiet hours: per-user, timezone-aware, overnight ranges supported (e.g. 22-08)
- All timestamps stored as `TIMESTAMPTZ` in DB, exposed as epoch ms in TypeScript

## Logging

Uses [LogTape](https://github.com/dahlia/logtape) for structured logging. **Never use `console.log/warn/error` in `src/` files** — use the logger instead.

```typescript
import { getLog } from "../logging.ts";
const log = getLog("subsystem", "subpath"); // → category ["muninn", "subsystem", "subpath"]
```

**Levels:**
- `log.info(...)` — lifecycle events, request timing, successful operations
- `log.warn(...)` — recoverable issues, fallbacks, deprecations
- `log.error(...)` — failures, exceptions, crashes
- `log.debug(...)` — verbose traces (dedup, user resolution) — only visible when level lowered

**Structured properties** (second argument):
```typescript
log.info("Message from {username}: {preview}", { botName, username, preview: text.slice(0, 80) });
```
- `botName` is special: the console formatter prepends it as `[jarvis]`
- Properties become searchable fields in the JSONL file sink

**Sinks:**
- Console: colored `LEVEL [subsystem/path] message` format
- File: daily-rotating JSONL in `logs/` dir (7-day retention, configurable via `LOG_DIR` env var, set `LOG_DIR=none` to disable)

**Tests:** Unconfigured loggers are silent no-ops — tests never call `setupLogging()`, so all logs are discarded. No mocking needed.

## Database & Migrations
After creating database migrations, always remind the user to run them against the target database. When modifying data models, check if existing data needs to be backfilled or updated — don't assume only new records matter.

## Code Quality
This project is primarily TypeScript. Always ensure code compiles cleanly (`tsc --noEmit` or equivalent) before committing. When fixing TypeScript errors, fix all of them — don't leave partial fixes.

