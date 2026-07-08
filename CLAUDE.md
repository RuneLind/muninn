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

Muninn's web UI (chat + dashboard) is **server-rendered** via `Bun.serve()` + Hono — not React/vite. If a client bundle is ever needed, use Bun HTML imports (`Bun.serve({ routes: { "/": index } })`), never webpack/vite.

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

---

## Muninn Project

Personal AI assistant — multi-bot Telegram platform with pluggable AI connectors (Claude CLI, Copilot SDK, OpenAI-compat, or Claude SDK), a live Hono dashboard, semantic memory, goal tracking, scheduled tasks, proactive watchers, and voice support.

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

Each bot selects its AI connector via `config.json` (`"connector"`: `"claude-cli"`, `"copilot-sdk"`, `"openai-compat"`, or `"claude-sdk"`). Claude CLI is spawned with `cwd: bots/<name>/` so it auto-discovers all config and stores conversation history separately. See "Switching chat connector" below for what each connector does and when to pick it; the Conventions section covers their internal mechanics.

A bot is active if its folder has a `CLAUDE.md` and a matching `TELEGRAM_BOT_TOKEN_<NAME>` env var.

### Key Modules

| Module | Path | Purpose |
|---|---|---|
| Bot Discovery | `src/bots/config.ts` | Auto-discovers bot folders, loads persona + config |
| Bot | `src/bot/` | Grammy Telegram handlers (text + voice), auth middleware |
| Core | `src/core/` | Central message pipeline — `message-processor.ts` (shared by Telegram/Slack/web), metadata extraction, progress callbacks |
| AI | `src/ai/` | Connector abstraction (`connector.ts`), Claude CLI + Copilot SDK + OpenAI-compat + Claude SDK connectors, prompt builder, embeddings |
| Memory | `src/memory/extractor.ts` | Async Claude Haiku call to extract memories (personal or shared scope) |
| Goals | `src/goals/detector.ts` | Goal detector (async Claude Haiku) |
| Profile | `src/profile/` | Interest profile — weekly Haiku distillation of goals+memories (`generator.ts`), augment-only injection into watcher gate prompts (`inject.ts`); keyed by `bot_default_user` |
| Scheduler | `src/scheduler/` | Unified scheduler (scheduled tasks + goal reminders + watchers), task detector, shared Haiku executor |
| Watchers | `src/watchers/` | Proactive outreach — email watcher (Haiku + Gmail MCP), quiet hours, runner |
| Gardener | `src/gardener/` | Wiki gardener — weekly `wiki-gardener` watcher clusters recent summaries (Haiku + interest profile) and drafts wiki-page proposals into `wiki_proposals`; human review gate at `/wiki/gardener` (approve/reject, CAS); approve writes the page into the bot's `wikiDir`, inserts a `log.md` entry, and fires the matching huginn reindex (`wiki`/`wiki-life`). Requires `wikiDir`; per-bot `gardener` config block; seed via `scripts/setup-wiki-gardener.ts`. See `src/watchers/CLAUDE.md` for pipeline details |
| Threads | `src/db/threads.ts`, `src/bot/topic-commands.ts` | Per-user+bot conversation threads for isolated chat history |
| DB | `src/db/` | Postgres CRUD — messages, memories, activity, goals, scheduled tasks, watchers, threads, user settings |
| Tracing | `src/tracing/` | Request tracing with span hierarchy, tool call child spans |
| Dashboard | `src/dashboard/` | Hono server with SSE activity feed, traces waterfall + REST APIs |
| Chat | `src/chat/` | Web chat state, WebSocket, processor, server-rendered UI |
| Web format | `src/web/web-format.ts` | Markdown → HTML for web chat (server side; client mirror in `src/chat/views/components/web-format-client.ts`) |
| Serena | `src/serena/` | Serena MCP instance manager + multi-instance tool proxy (port 9120) |
| Voice | `src/voice/` | STT (whisper-cli) + TTS (macOS say + ffmpeg) |
| YouTube | `src/youtube/` | Transcript fetch + summarization (backs `youtube-routes.ts` + Chrome extension) |
| X article | `src/x-article/` | X/Twitter article summarization (backs `x-article-routes.ts` + Chrome extension) |
| TikTok | `src/tiktok/` | TikTok video summarization *including visual content* — `media.ts` (yt-dlp download + whisper transcript + ffmpeg keyframes) → `summarizer.ts` (Claude reads frame JPEGs via `--add-dir`) → `tiktok-summaries` collection (backs `tiktok-routes.ts`). **Requires `yt-dlp` on PATH** (`brew install yt-dlp`); `SUMMARIZER_BOT` must be a `claude-cli` bot — frames are Read via `executeOneShot`'s `extraDirs` → CLI `--add-dir`, a capability only the CLI connector wires today (the route pre-flights `connectorCapabilities(...).supportsExtraDirs` and 503s otherwise, before the expensive download/whisper work; the claude-sdk exposes `additionalDirectories`, so wiring it there is a cheap follow-up if ever needed). Optional `TIKTOK_WHISPER_MODEL_PATH` overrides the shared whisper model. |
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
| `connector` | string | `"claude-cli"` | AI backend: `"claude-cli"`, `"copilot-sdk"`, `"openai-compat"`, or `"claude-sdk"` |
| `haikuBackend` | string | derived from `connector` | Per-bot Haiku backend for the `research_knowledge` decomposer and memory/goal/schedule extractors. One of `"cli"`, `"anthropic"`, `"copilot"`. Default is `copilot` for `copilot-sdk` bots, `cli` otherwise. See "Switching Haiku backend" below. |
| `model` | string | `CLAUDE_MODEL` env | Model name (e.g. "claude-sonnet-4-6", "qwen3.5:35b") |
| `thinkingMaxTokens` | number | CLI default | Max thinking tokens (0 = disable thinking). For openai-compat: used as max_tokens. |
| `timeoutMs` | number | `CLAUDE_TIMEOUT_MS` env | Response timeout in ms |
| `baseUrl` | string | — | Base URL for OpenAI-compatible API (e.g. `"http://localhost:11434/v1"`) |
| `showWaterfall` | boolean | `true` | Show request progress waterfall overlay in web chat |
| `contextWindow` | number | — | Context window size in tokens (e.g. `32768`). Shown as usage in web chat and percentage in Telegram footer |
| `wikiDir` | string | — | Path to the bot's knowledge wiki (relative to `bots/<name>/`, same semantics as `.mcp.json` paths; resolved to absolute at discovery). Registers the bot as a browsable wiki at `/wiki?wiki=<name>` (legacy `?bot=<name>` still accepted as an alias). Unset ⇒ the bot has no browsable wiki. Standalone wikis owned by no bot are added via the `WIKI_EXTRA` env var. Bare `/wiki` still defaults to jarvis (or the `WIKI_DIR` env override). |
| `prompts` | — | — | **Not a config.json field.** Research-flow prompts live in `bots/<name>/prompts/<key>.md` — one markdown file per key. Supported keys: `jiraAnalysis` (Jira research seed; Jira content appended automatically), `investigateCode` (Investigate Code button), `deepAnalysis` (Deep Analysis button), `specGeneration` (Generate Test Spec button — only renders when its file exists), `specDomain` (Generate Spec button after Jira analysis — drafts the domain layer early from the issue, not the code; opens a fagperson review gate where the user approves or saves the spec, which persists to `/chat/specs` and flips the `dev_run` status `spec_draft → spec_approved`; only renders when its file exists). Multi-variant prompt: `jiraAnalysis` also supports named variants via `prompts/jiraAnalysis.<id>.md` (e.g. `jiraAnalysis.coder.md`); first line may be `<!-- label: Human label -->` for the dropdown, otherwise the id is title-cased. The Chrome Jira extension reads variants from `GET /api/research/variants?bot=<name>` and sends `promptVariant` in its POST. Unknown filenames are warned about at discovery; a leftover `"prompts"` block in config.json triggers an "unknown keys" warning with a migration hint. |
| `correctiveRetrieval` | object | off | Prompt-level corrective retrieval (Path C, dormant fallback) — `{ enabled?: boolean }`. Leave **off** when the bot's huginn has Path D (the primary in-huginn rescue, always on). Only turn on for bots pointed at older huginn deploys that lack Path D. See "Corrective Retrieval" below. |

Discovery validates each field at load time: unknown enum values (`connector`, `haikuBackend`) and scalar fields with the wrong JSON type (e.g. `"timeoutMs": "180000"` as a string, `showWaterfall` as a string) are **warned about and dropped**, so the bot falls back to the field's default rather than carrying a mistyped value downstream. Falsy-but-valid values (`thinkingMaxTokens: 0`, `showWaterfall: false`) are kept. Validation never aborts discovery — a bad field degrades to its default, it doesn't take the bot offline.

### Database

PostgreSQL + pgvector via Docker (single container).

- URL: `postgresql://muninn:muninn@127.0.0.1:5435/muninn`
- Schema: `db/init.sql` (full consolidated schema, applied by Docker on first start)
- Migrations: `db/migrations/` (numbered `.sql` and `.ts` files, tracked in `schema_migrations` table)
- Start: `bun run db:up` / Stop: `bun run db:down`
- Migrate: `bun run db:migrate` / Status: `bun run db:migrate:status` / Baseline: `bun run db:migrate:baseline`
- Test DB: `bun run db:setup:test` (creates `muninn_test`, applies schema + baseline)
- Backup: `bun run db:backup` / Restore: `bun run db:restore`
- Tables: `users` (canonical user identity), `messages`, `activity_log`, `memories` (with vector embeddings + scope), `goals`, `scheduled_tasks`, `watchers`, `connectors` (named AI connector configurations), `threads` (per-user+bot conversation isolation, optional FK to connectors), `user_settings`, `haiku_usage`, `traces` (spans with parent-child hierarchy + JSONB attributes), `research_citations` + `search_signals` (durable retrieval signals — citations per research answer; hourly harvest of huginn quality attrs before trace cleanup), `message_feedback` (per-assistant-message 👍/👎 from Telegram reactions + web chat), `interest_profiles` (per user+bot Haiku-distilled interests, injected into watcher gate prompts)

### Configuration (.env)

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN_<NAME>` | Yes (per bot) | — | From @BotFather (e.g. `TELEGRAM_BOT_TOKEN_JARVIS`) |
| `TELEGRAM_ALLOWED_USER_IDS_<NAME>` | Yes (per bot) | — | Comma-separated Telegram user IDs (e.g. `TELEGRAM_ALLOWED_USER_IDS_JARVIS`) |
| `DATABASE_URL` | Yes | — | Postgres connection string |
| `DASHBOARD_PORT` | No | `3010` | Web dashboard port |
| `DASHBOARD_HOST` | No | `127.0.0.1` | Dashboard/chat bind address. Defaults to loopback (the dashboard has no auth and exposes MCP tools + logs + traces + full CRUD). Set `0.0.0.0` to expose on the LAN; docker-compose already sets it inside the container. |
| `CLAUDE_TIMEOUT_MS` | No | `120000` | Claude response timeout (ms) |
| `CLAUDE_MODEL` | No | `sonnet` | Claude model for main responses |
| `WHISPER_MODEL_PATH` | No | `./models/ggml-base.en.bin` | whisper-cpp model file |
| `SCHEDULER_INTERVAL_MS` | No | `60000` | Unified scheduler tick interval (ms, default 1min) |
| `SCHEDULER_ENABLED` | No | `true` | Enable/disable unified scheduler (tasks + goal reminders) |
| `TRACING_ENABLED` | No | `true` | Enable request tracing |
| `TRACING_RETENTION_DAYS` | No | `7` | Days to keep trace data |
| `PROMPT_SNAPSHOTS_RETENTION_DAYS` | No | `3` | Days to keep prompt snapshots |
| `HUGINN_TRACE_POINTER` | No | — | Set to `1` to enable Huginn out-of-band trace channel (recommended). Huginn's MCP adapter is `stdio`-spawned by muninn, so this var propagates to it from muninn's env. Adapter emits a `huginn-trace-url:` line; Muninn fetches the trace via HTTP. Avoids the divert that triggers when an inline trace pushes search results past Claude CLI's `MAX_MCP_OUTPUT_TOKENS`. Bun auto-loads `.env`, so editing it + restarting muninn is sufficient. **NB:** the adapter captures `TRACE_DEFAULT` at module-load, so a long-lived stale adapter (e.g. spawned by an orphaned benchmark run) won't pick up env changes. Run `bun run cleanup` after restarts if traces still look wrong — see `docs/stale-mcp-cleanup.md`. |
| `HUGINN_TRACE_DEFAULT` | No | `1` (forced) | Huginn inline-fence trace mode. Muninn forces this on for spawned MCP children so it is always active as a fallback. |
| `SLACK_BOT_TOKEN_<NAME>` | No | — | Slack bot token (per bot) |
| `SLACK_APP_TOKEN_<NAME>` | No | — | Slack app-level token (per bot) |
| `SLACK_ALLOWED_USER_IDS_<NAME>` | No | — | Comma-separated Slack user IDs |
| `LOG_DIR` | No | `./logs` | Log file directory (set `none` to disable file logging) |
| `SUMMARIZER_BOT` | No | first discovered bot | Bot whose config (connector + model + timeout) drives the dashboard YouTube / X-article / anthropic / TikTok summarization jobs. Matched by name (case-insensitive); falls back to the first discovered bot when unset or unmatched. Jobs route through `executeOneShot` (the connector abstraction), so **any** connector works — except TikTok, whose multi-turn frame-reading needs `--add-dir` and so requires a `claude-cli` bot (the route pre-flights the connector's `supportsExtraDirs` capability and 503s otherwise). Without this knob the model silently depends on bot-folder directory order. |
| `RESEARCH_BOT` | No | first fast (non-opus) bot | Bot that synthesizes `/research` (Claude Learning Center) answers — interactive Q&A, so the default favors speed over the slow summarizer default. Resolution (`resolveResearchBot`): `RESEARCH_BOT` (name, case-insensitive) → first discovered **non-opus** bot → `resolveSummarizerBot`. Synthesis routes through `executeOneShot`, so any connector (copilot-sdk / openai-compat / claude-sdk / claude-cli) can synthesize. The `?bot=` query param on `/api/research/ask` still overrides everything. |
| `X_AUTHOR_SCORES_PATH` | No | `../huginn/huginn-jarvis/data/x-feed-author-scores.json` | Huginn's daily-regenerated X author-ranking JSON, read by `src/summaries/author-scores.ts` (mtime-cached) for candidate author badges/filter on `/summaries` and `author_score` at X capture. Missing/unreadable file degrades to no-author (single warn, not per candidate). |
| `WIKI_DIR` | No | jarvis default (`../huginn/huginn-jarvis/data/wiki`) | Explicit override for the bare `/wiki` root. When set, the picker shows a disabled "env override" state and claims no named wiki. Per-bot `wikiDir` (config.json) and `?wiki=`/`?bot=` still take precedence. |
| `WIKI_EXTRA` | No | — | Comma-separated `name=path` pairs registering **standalone** wikis (owned by no bot) in the `/wiki` reader's picker alongside bot wikis — e.g. `mimir=../mimir,melosys-kode-wiki=/Users/rune/source/nav/melosys-kode-wiki`. Relative paths resolve against the muninn repo root (same base as `WIKI_DIR`'s default); whitespace is trimmed. Malformed pairs and names colliding with a bot-wiki name are warned and skipped. Names match case-insensitively, browsable at `/wiki?wiki=<name>`. Built in `src/wiki/registry.ts`. |
| `CORRECTIVE_RETRIEVAL_ENABLED` | No | `false` | Global default for prompt-level corrective retrieval (per-bot `correctiveRetrieval.enabled` overrides). |
| `CORRECTIVE_RETRIEVAL_DISABLED` | No | — | Set to `1` to hard-disable corrective retrieval everywhere, regardless of per-bot config. |
| `HAIKU_BACKEND` | No | — | Process-wide debug knob — forces all bots to one Haiku backend. Values: `cli` (Claude CLI subprocess), `anthropic` (`@anthropic-ai/sdk`), `copilot` (`@github/copilot-sdk`). Resolution order: explicit `opts.backend` > `HAIKU_BACKEND` > per-bot `haikuBackend` (config.json) > legacy `HAIKU_DIRECT_ENABLED=1` (alias for `anthropic`) > connector default (`copilot-sdk` → `copilot`, otherwise `cli`). Falls back to CLI on any error. Affects the `research_knowledge` decomposer plus the memory / goal / schedule extractors. Watchers (email, calendar) stay on the CLI because they need Gmail MCP. |
| `HAIKU_DIRECT_ENABLED` | No | `false` | **Deprecated** alias for `HAIKU_BACKEND=anthropic` — kept for backwards compatibility with PR #120. Prefer `HAIKU_BACKEND=anthropic`. Requires `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. |
| `ANTHROPIC_API_KEY` | No | — | Anthropic API key for the `anthropic` backend. Sent as `x-api-key` header. Use for production/shared deployments. |
| `CLAUDE_CODE_OAUTH_TOKEN` | No | — | Claude Code OAuth token (generate via `claude setup-token`) for the `anthropic` backend. Sent as `Authorization: Bearer`. Use for personal/Max-subscription dev. Anthropic SDK uses `apiKey` first, falls back to this. |
| `GOAL_CHECK_INTERVAL_MS` | No | — | Legacy alias for `SCHEDULER_INTERVAL_MS` |
| `GOAL_CHECK_ENABLED` | No | — | Legacy alias for `SCHEDULER_ENABLED` |

### Switching Haiku backend (Copilot vs Anthropic vs CLI)

The Haiku router (`src/ai/haiku-direct.ts`) powers the `research_knowledge` decomposer and the three async extractors (memory / goals / schedule). Default behaviour: a bot's `connector` decides — `copilot-sdk` → Copilot SDK, anything else → Claude CLI. Override per-bot in `bots/<name>/config.json` via `haikuBackend`, or process-wide via the `HAIKU_BACKEND` env (debug knob). Watchers (email, calendar) still use `spawnHaiku` directly because they need Gmail MCP, which the one-shot helpers don't expose.

| Goal | What to set | Auth |
|---|---|---|
| Bot uses Copilot for both chat + Haiku (e.g. melosys) | `bots/<name>/config.json` → `"connector": "copilot-sdk"` | `gh auth login` (Capra/NAV Copilot subscription) |
| Just one CLI bot on Anthropic SDK for Haiku (e.g. jarvis on faster decomposer, others unchanged) | `bots/jarvis/config.json` → `"haikuBackend": "anthropic"` | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) |
| All CLI bots on Anthropic SDK for Haiku | `HAIKU_BACKEND=anthropic` in `.env` (affects every bot in this process) | same as above |
| Bot stays fully on Claude CLI (no SDK) | leave `connector` unset or `"claude-cli"`, leave `haikuBackend` unset | none (uses existing CLI auth) |
| Force one backend everywhere (testing / debugging) | `HAIKU_BACKEND=cli` / `anthropic` / `copilot` — trumps per-bot config | auth for chosen backend |
| Reset to defaults | unset `HAIKU_BACKEND` *and* `HAIKU_DIRECT_ENABLED`, drop `haikuBackend` from config.json | n/a |

Diagnostics:
- The dashboard `haiku_usage` table shows the actual model each call used — `claude-haiku-4.5` (Copilot) vs `claude-haiku-4-5-20251001` (Anthropic / CLI). If a bot's `knowledge_decompose` span shows the wrong model, the resolution order is doing something unexpected.
- On any backend error the router falls back to CLI and logs `haiku-router <backend> failed, falling back to CLI` — check muninn logs if a bot regresses to CLI speeds.
- `bun scripts/smoke-haiku-copilot.ts` re-runs the Copilot path end-to-end and prints the model id Copilot actually used.

### Switching chat connector (CLI vs Copilot vs Claude SDK vs OpenAI-compat)

The chat connector handles the main bot turn — assembling the prompt, running tools, streaming the response. Separate from the Haiku router above (which only powers short async extraction calls). Set per-bot in `bots/<name>/config.json` via `connector`.

| Goal | What to set | Auth |
|---|---|---|
| Default — spawns the `claude` CLI per turn (~5–7s cold-start, full MCP surface) | leave `connector` unset, or `"connector": "claude-cli"` | existing CLI login |
| Bot on Capra/NAV Copilot subscription (e.g. melosys) | `"connector": "copilot-sdk"` | `gh auth login` |
| Direct Anthropic transport — no CLI subprocess, no Copilot subscription. Personal bots that want smoother streaming and like-for-like benchmarks vs Copilot. | `"connector": "claude-sdk"` | `ANTHROPIC_API_KEY` (production) or `CLAUDE_CODE_OAUTH_TOKEN` (personal Max via `claude setup-token`) |
| Local model via Ollama / LM Studio / vLLM | `"connector": "openai-compat"` + `"baseUrl": "http://localhost:11434/v1"` | none |

The `claude-sdk` connector uses `@anthropic-ai/claude-agent-sdk` with `bypassPermissions` and `settingSources: []` — muninn's prompt-builder delivers the full system prompt, the SDK doesn't auto-load CLAUDE.md or `~/.claude/settings.json`. MCP servers are converted from `.mcp.json` to the SDK shape (`src/ai/connectors/claude-sdk-mcp.ts`). Per-server `cwd` is dropped because the SDK doesn't expose it — none of the current bots use it, but if a new `.mcp.json` adds one, you'll see a warning in the logs.

### Adding a New Bot

1. Create `bots/<name>/CLAUDE.md` with the bot's persona
2. Optionally add `bots/<name>/config.json` (connector, model, thinking, timeout overrides)
3. Optionally add `bots/<name>/.mcp.json` and `bots/<name>/.claude/settings.json`
4. Add `TELEGRAM_BOT_TOKEN_<NAME>=...` and `TELEGRAM_ALLOWED_USER_IDS_<NAME>=...` to `.env`
5. Restart — the bot is auto-discovered

### Config Sync

Bot folders (except `jarvis`) are gitignored. The manifest at `bots.config.json` (repo root) maps each bot to its source-of-truth repo — either a local path (e.g. `~/source/private/muninn-config`) or a git URL (e.g. `git@github.com:capraconsulting/huginn-capra.git`). Git-URL repos are sparse-cloned into `~/.muninn/bot-repos/<name>/`.

`.env` is **per-developer** — each dev maintains their own with the tokens for the bots they actually run. It is not synced by this tool.

```bash
bun run config:sync                # push local bots/<name>/ → each repo
bun run config:sync -- --pull      # fetch latest from git remotes first
bun run config:sync -- --commit    # commit + push in every touched repo
bun run config:restore             # reverse: pull each repo subpath → bots/<name>/
```

Entries in the manifest whose `repo` path doesn't exist (or whose git clone fails) are skipped with a warning, so a contributor only needs access to the repos for the bots they care about. `--restore` skips entries whose source-of-truth doesn't have a `CLAUDE.md` yet (i.e. has never been populated).

Manifest entry shapes:
```json
{
  "jarvis":  { "inline": true },
  "capra":   { "repo": "https://github.com/capraconsulting/huginn-capra.git", "subpath": "bot" },
  "melosys": { "repo": "~/source/private/muninn-config", "subpath": "bots/melosys" }
}
```

Path conventions inside synced `.mcp.json`: paths are resolved relative to `cwd: bots/<name>/`. To reference a sibling project (e.g. `~/source/private/huginn` when muninn is at `~/source/private/muninn`), use `../../../huginn`. Paths in `env` blocks are read literally — for HOME-relative paths use shell expansion in a `bash -c` command instead.

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
| `src/ai/mcp-tool-caller.ts` | MCP Debug client — supports both stdio and HTTP servers |

## Corrective Retrieval (Path D primary, Path C dormant fallback)

Two layers rescue weak knowledge searches so the bot either answers from a rescued result or honestly says the knowledge base doesn't cover it.

- **Path D (primary, always on)** — the rescue runs inside huginn at the `apply_corrective_signal` seam: on a weak signal with a usable `broaderQuery`/`narrowerQuery` hint it re-queries, merges + dedupes by `(collection, doc_id)`, and returns one already-consolidated tool result — no model re-call. Every consumer (muninn bots, Claude Code, curl) auto-upgrades; no `.mcp.json` change. Per-call knob `corrective="auto"` (default) / `"off"` / `"force"`. The trace carries a `corrective` block and the dashboard waterfall shows a blue `rescue ⟲N` chip when it fired.
- **Path C (dormant, off by default)** — prompt-level loop in `src/ai/prompt-builder.ts` (`CORRECTIVE_RETRIEVAL_PROMPT`); the model re-calls the tool on a `*Weak match*` footer. Enable per-bot via `correctiveRetrieval.enabled`, globally via `CORRECTIVE_RETRIEVAL_ENABLED=true`, hard-disable via `CORRECTIVE_RETRIEVAL_DISABLED=1`. **Only turn on for a bot pointed at an older huginn that lacks Path D** — otherwise it just adds trace noise. Works for every connector.

Other waterfall chips (independent of either layer): red `0 hits` when a search returned nothing usable; yellow low-confidence palette flip on the `N/N` chip on a weak match.

Muninn-side files: `src/ai/corrective-config.ts`, `src/ai/prompt-builder.ts`, `src/dashboard/views/components/span-label.ts` (`searchResultSignal`, `searchRescueInfo`). Path D lives in huginn (`main/core/search_response_formatter.py` — `run_corrective_search`). Full rationale + history (retired PR #113 hook approach, the C→D upgrade): `mimir/plans/muninn-corrective-rag-rework.md` + `huginn-corrective-rag-in-adapter.md`.

## Slack Bot
When implementing Slack bot features, be aware of the different message contexts (DMs, threads, channels, Assistant API) — each has different API constraints and capabilities. Check Slack app configuration settings (like 'Agent or Assistant' toggle) as a potential root cause before writing code fixes.

### Testing

Always run `bun run test` after adding or changing a feature to verify nothing is broken. Tests are split into three sub-scripts (unit / db / handlers) to avoid `mock.module()` leakage between files:

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
- AI connectors: `resolveConnector(botConfig)` returns the appropriate executor (`claude-cli`, `copilot-sdk`, `openai-compat`, or `claude-sdk`). All callers use this instead of importing executors directly. Connectors conform to the `AiConnector` type signature.
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

## Working Principles
- **Think before coding** — state assumptions, ask rather than guess, stop when confused.
- **Simplicity first** — minimum code that solves the problem; no speculative abstractions for single-use code.
- **Surgical changes** — touch only what you must; don't refactor adjacent code; match existing style.
- **Goal-driven** — define success criteria, then loop until verified.
