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
| Profile | `src/profile/` | Interest profile — weekly Haiku distillation of goals+memories (`generator.ts`), augment-only injection into watcher gate prompts (`inject.ts`). Keyed **per watcher owner** (`watcher.userId`), not `bot_default_user`; the user-less gardener drain falls back to `loadInterestProfileForBot`. Loader swallows all errors to `null` (⇒ unchanged prompt), so keying bugs degrade silently — verify via prompt snapshots |
| Scheduler | `src/scheduler/` | Unified scheduler (scheduled tasks + goal reminders + watchers), task detector, shared Haiku executor |
| Watchers | `src/watchers/` | Proactive outreach — email watcher (Haiku + Gmail MCP), quiet hours, runner; plus the `wiki-committer` daily sweeper and the `consolidation-gardener` weekly watcher (see Gardener row + `src/watchers/CLAUDE.md`) |
| Gardener | `src/gardener/` | Wiki gardener — three drafting pipelines (weekly `wiki-gardener` clusters summaries into wiki-page proposals; weekly `consolidation-gardener` drafts synthesis pages across a wiki's own pages; per-capture `source-drafter`) feeding the human review gate at `/wiki/gardener`. Anything writing to a wiki must join the shared per-wiki write queue (`src/wiki/queue.ts`) with the section spanning read→CAS→write→log.md and the commit tail OUTSIDE it. Full pipeline detail + the drafter tool-fence trap: `src/gardener/CLAUDE.md`; scheduling: `src/watchers/CLAUDE.md` |
| Threads | `src/db/threads.ts`, `src/bot/topic-commands.ts` | Per-user+bot conversation threads for isolated chat history |
| DB | `src/db/` | Postgres CRUD — messages, memories, activity, goals, scheduled tasks, watchers, threads, user settings |
| Tracing | `src/tracing/` | Request tracing with span hierarchy, tool call child spans |
| Dashboard | `src/dashboard/` | Hono server with SSE activity feed, traces waterfall + REST APIs |
| Chat | `src/chat/` | Web chat state, WebSocket, processor, server-rendered UI |
| Web format | `src/web/web-format.ts` | Markdown → HTML for web chat (server side; client mirror in `src/chat/views/components/web-format-client.ts`). Also owns the **fact-check annotation pair** (`<Fact>` inline marks + `<FactCheck>` appendix) — the render/write/reader pipeline has several load-bearing traps; **read `src/web/CLAUDE.md` before touching any fact-check rendering, `markdown-ast.ts` strip/count helpers, or `wiki-factcheck-reader.ts`**. |
| Share | `src/share/` | Turning one source document into a pasteable post. `presets.ts` (shipped preset set + per-bot `prompts/share*.md` merge; `findSharePreset` returns **undefined** on an unknown id so the route can 400 rather than generate with the wrong instruction), `body-prep.ts` (on-disk → prose, one preparer per kind, `SHARE_BODY_MAX` 24k), `prompt.ts` (instruction → **language rider** → extra → fenced source; `SHARE_EXCLUDED_TOOLS` = the WebSearch/WebFetch half of the fence) and `wire.ts` (langs, the two text caps, `SLACK_PASTE_MAX`, the `done` payload type — dependency-free, so the browser dialog can import it). Consumed by `POST /api/wiki/share` (`routes/share-sse.ts` + the dialog in `views/components/share-dialog.ts`); see the share section of `src/wiki/CLAUDE.md`. |
| Serena | `src/serena/` | Serena MCP instance manager + multi-instance tool proxy (port 9120) |
| Voice | `src/voice/` | STT (whisper-cli) + TTS (macOS say + ffmpeg) |
| Capture jobs | `src/summaries/summarizer-shared.ts` | Shared seam for the capture verticals (youtube / x-article / tiktok / anthropic / article — `article` is pasted text, ingested into `article-summaries`). `runCaptureOneShot` wraps the model call in a `capture:<source>` trace, late-binds bot/model/trace/tokens onto the job's `/agents` run, and caps thinking at `CAPTURE_THINKING_MAX_TOKENS` (8k) for TTFT (TikTok opts out — real visual reasoning). Summarizers must go through this, never `executeOneShot` bare, or the job goes invisible on `/traces` + `/agents`. |
| YouTube | `src/youtube/` | Transcript fetch + summarization (backs `youtube-routes.ts` + Chrome extension). Transcript comes from **huginn** (`GET {knowledgeApiUrl}/api/youtube/transcript/<id>`) and the finished summary is ingested back into a huginn collection — but the summarization itself runs **in muninn**, on `SUMMARIZER_BOT`'s connector. |
| X article | `src/x-article/` | X/Twitter summarization (backs `x-article-routes.ts` + Chrome extension). Two paths into the same job store + `x-articles` collection: `summarizer.ts` (pasted text) and `video.ts` (X video posts — the TikTok media pipeline pointed at an X status URL, traced `capture:x-video`; 3-hour cap, duration-scaled timeouts, ingest + dedup keyed on the bare status URL via `canonicalXStatusUrl`/`extractXStatusId` so media-slot/query variants can't double-capture). Same `supportsExtraDirs` pre-flight + yt-dlp requirement as TikTok. |
| Video media | `src/video/media.ts` | Shared source-agnostic video engine (moved from `src/tiktok/`) — yt-dlp download (parameterizable duration cap), whisper transcription, ffmpeg keyframe extraction, plus the per-host URL helpers (`extractTikTokVideoId` — now host-gated so X's `/video/1` media-slot suffix can't misfire — `extractXStatusId`, `canonicalXStatusUrl`). Used by the TikTok and X-video verticals. |
| TikTok | `src/tiktok/` | TikTok video summarization *including visual content* — `src/video/media.ts` → `summarizer.ts` (Claude reads frame JPEGs via `extraDirs` → `--add-dir`) → `tiktok-summaries` collection. **Requires `yt-dlp` on PATH**; `SUMMARIZER_BOT` needs a connector with `supportsExtraDirs` (route pre-flights and 503s before the expensive download/whisper work). Optional `TIKTOK_WHISPER_MODEL_PATH` overrides the shared whisper model. |
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
| `componentAnswers` | boolean | `false` | Opt in to the presentational block-component vocabulary (Callout/Verdict/Pill/Figure/FileRef/ComparisonTable, shared with `/research` via `COMPONENT_VOCABULARY_RULES`) in the chat system prompt. Web chat renders components; Telegram/Slack get plain-text fallbacks. v1 rollout: jarvis only. |
| `contextWindow` | number | — | Context window size in tokens (e.g. `32768`). Shown as usage in web chat and percentage in Telegram footer |
| `wikiDir` | string | — | Path to the bot's knowledge wiki (relative to `bots/<name>/`; resolved to absolute at discovery). Registers the bot as a browsable wiki at `/wiki?wiki=<name>`. Optional `.wiki-reader.json` at the wiki root gives a custom page-type ontology. Full registry/reader semantics: `src/wiki/CLAUDE.md`. |
| `wikiCollections` | string[] | — | Huginn search collections backing this wiki's `/wiki` **Ask** tab and Similar-articles section, e.g. `["wiki", "wiki-life"]`. Unset/empty ⇒ Ask returns a clean "no collection" error. Details: `src/wiki/CLAUDE.md`. |
| `wikiSynthesisBot` | string | — | Explicit synthesis-bot pin for this bot's OWN wiki — beats the owner fast-gate and research-bot fallback in `resolveWikiSynthesisBot` (deliberately bypasses the opus fast-gate). Details: `src/wiki/CLAUDE.md`. |
| `prompts` | — | — | **Not a config.json field.** Research-flow prompts live in `bots/<name>/prompts/<key>.md` — one file per key: `jiraAnalysis` (Jira research seed; supports named variants via `jiraAnalysis.<id>.md`, first line `<!-- label: … -->` for the dropdown; the Chrome Jira extension reads variants from `GET /api/research/variants?bot=<name>`), `investigateCode`, `deepAnalysis`, `specGeneration` and `specDomain` (buttons render only when their file exists; specDomain opens a fagperson review gate persisting to `/chat/specs`, flipping `dev_run` `spec_draft → spec_approved`), and `share` (share-summary preset; **also** supports named variants via `share.<id>.md`, same `<!-- label: … -->` first line). Unknown filenames warn at discovery; an EMPTY prompt file (or a variant carrying only its label line) warns and is treated as absent, so the shipped default still applies; a leftover `"prompts"` block in config.json triggers a migration-hint warning. **Share is the one key whose defaults SHIP IN-REPO** (`src/share/presets.ts`) — a bare `share.md` replaces the shipped default preset, a `share.<id>.md` overrides a shipped preset of the same id or appends a new one, and that merge lives in the share service, not the loader. |
| `wikiAutoCommit` | object | push on | Auto-commit for the bot's programmatic wiki writes — `{ push?: boolean, catalogKinds?: string[] }`. Commits exactly the touched files on the wiki repo's **default branch only**, then pushes to upstream (`push` defaults on; failures non-fatal; never runs clean/checkout/restore/reset). `catalogKinds` = which page kinds get an index.md catalog line (default `["concept"]`; entities never). Details: `src/wiki/CLAUDE.md`. |

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
- Tables: `users` (canonical user identity), `messages`, `activity_log`, `memories` (with vector embeddings + scope), `goals`, `scheduled_tasks`, `watchers`, `connectors` (named AI connector configurations), `threads` (per-user+bot conversation isolation, optional FK to connectors), `user_settings`, `haiku_usage`, `traces` (spans with parent-child hierarchy + JSONB attributes), `research_citations` + `search_signals` (durable retrieval signals — citations per research answer; hourly harvest of huginn quality attrs before trace cleanup), `message_feedback` (per-assistant-message 👍/👎 from Telegram reactions + web chat), `interest_profiles` (per user+bot Haiku-distilled interests, injected into watcher gate prompts), `role_overrides` (DB-backed hot overrides for `SUMMARIZER_BOT`/`RESEARCH_BOT`/`HAIKU_BACKEND`, edited from `/models`; beat env at resolution time), `x_link_amplifiers` (cross-run X pointer votes per destination URL; shipped flag-gated OFF — see `captureAmplifyMin` in `src/watchers/CLAUDE.md`)

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
| `HUGINN_TRACE_POINTER` | No | — | Set to `1` (recommended) for Huginn's out-of-band trace channel — adapter emits a `huginn-trace-url:` line, muninn fetches the trace via HTTP, avoiding the oversized-inline-trace divert. **NB:** stale long-lived adapters won't pick up env changes — run `bun run cleanup` after restarts if traces look wrong (`docs/stale-mcp-cleanup.md`). |
| `HUGINN_TRACE_DEFAULT` | No | `1` (forced) | Huginn inline-fence trace mode. Muninn forces this on for spawned MCP children so it is always active as a fallback. |
| `SLACK_BOT_TOKEN_<NAME>` | No | — | Slack bot token (per bot) |
| `SLACK_APP_TOKEN_<NAME>` | No | — | Slack app-level token (per bot) |
| `SLACK_ALLOWED_USER_IDS_<NAME>` | No | — | Comma-separated Slack user IDs |
| `LOG_DIR` | No | `./logs` | Log file directory (set `none` to disable file logging) |
| `MUNINN_AGENT_CWD` | No | `~/.muninn/agent-cwd` | Root for the cwds muninn's own `claude -p` spawns use (`src/ai/agent-cwd.ts`, one subdir per caller). A cwd inside the repo makes the CLI load muninn's CLAUDE.md + `.claude/` surface into the call (~18k prompt tokens, measured) and file the transcript into the developer's own `~/.claude/projects/-…-muninn/` folder. Covers **`spawnHaiku` calls with no explicit cwd** (x/anthropic watchers, gardener cluster/map, interest-profile distillation) **plus the benchmark judge unconditionally** (`src/benchmarks/judge.ts`, bucket `benchmark-judge` — a caller label, not a bot). `spawnHaiku` callers that pass `bots/<name>/` on purpose (email watcher → Gmail MCP, memory/goal/schedule extractors + prose reminders → persona) are unchanged and, since bot dirs sit inside the repo, still pay the CLAUDE.md load — cutting that needs `--mcp-config` + `--system-prompt` (what `src/ai/executor.ts` does for chat), not a cwd change. Overrides are refused (with a warning, once per value) when non-absolute or resolving inside the checkout — symlinks and filesystem case included, since the kernel resolves both at `chdir` time. |
| `SUMMARIZER_BOT` | No | first discovered bot | Bot whose config drives the dashboard capture summarization jobs. Matched by name (case-insensitive). Jobs route through `executeOneShot`, so any connector works — except TikTok/X-video, which need `supportsExtraDirs` (route pre-flights and 503s otherwise). |
| `RESEARCH_BOT` | No | first fast (non-opus) bot | Bot that synthesizes `/research` answers. Resolution (`resolveResearchBot`): env name → first non-opus bot → `resolveSummarizerBot`. Any connector can synthesize; `?bot=` on `/api/research/ask` overrides everything. |
| `X_AUTHOR_SCORES_PATH` | No | `../huginn/huginn-jarvis/data/x-feed-author-scores.json` | Huginn's daily-regenerated X author-ranking JSON, read by `src/summaries/author-scores.ts` (mtime-cached) for candidate author badges/filter on `/summaries` and `author_score` at X capture. Missing/unreadable file degrades to no-author (single warn, not per candidate). |
| `WIKI_DIR` | No | jarvis default (`../huginn/huginn-jarvis/data/wiki`) | Explicit override for the bare `/wiki` root. Per-bot `wikiDir` and `?wiki=`/`?bot=` still take precedence. |
| `WIKI_EXTRA` | No | — | Comma-separated `name=path[=coll1+coll2][=botpin]` pairs registering **standalone** wikis (owned by no bot) in the `/wiki` picker — e.g. `notes=/abs/path,team-wiki=../team-wiki=team-wiki`. Full segment semantics: `src/wiki/CLAUDE.md`. |
| `HAIKU_BACKEND` | No | — | Process-wide debug knob — forces all bots to one Haiku backend (`cli` / `anthropic` / `copilot`). Resolution order + fallback behavior: `src/ai/CLAUDE.md` (`haiku-direct.ts`). Watchers stay on the CLI (they use `spawnHaiku`, never the router). |
| `HAIKU_DIRECT_ENABLED` | No | `false` | **Deprecated** alias for `HAIKU_BACKEND=anthropic` — kept for backwards compatibility with PR #120. Prefer `HAIKU_BACKEND=anthropic`. Requires `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. |
| `ANTHROPIC_API_KEY` | No | — | Anthropic API key for the `anthropic` backend. Sent as `x-api-key` header. Use for production/shared deployments. |
| `CLAUDE_CODE_OAUTH_TOKEN` | No | — | Claude Code OAuth token (generate via `claude setup-token`) for the `anthropic` backend. Sent as `Authorization: Bearer`. Use for personal/Max-subscription dev. Anthropic SDK uses `apiKey` first, falls back to this. |
| `GOAL_CHECK_INTERVAL_MS` | No | — | Legacy alias for `SCHEDULER_INTERVAL_MS` |
| `GOAL_CHECK_ENABLED` | No | — | Legacy alias for `SCHEDULER_ENABLED` |

### Switching Haiku backend (Copilot vs Anthropic vs CLI)

The Haiku router (`src/ai/haiku-direct.ts`) powers the `research_knowledge` decomposer and the three async extractors (memory / goals / schedule). Default behaviour: a bot's `connector` decides — `copilot-sdk` → Copilot SDK, anything else → Claude CLI. Override per-bot in `bots/<name>/config.json` via `haikuBackend`, or process-wide via the `HAIKU_BACKEND` env (debug knob). Watchers (email/x/anthropic) still use `spawnHaiku` directly, which unconditionally spawns the CLI. Only the email watcher truly requires it (Gmail MCP via bot-cwd `.mcp.json` discovery, which the one-shot helpers don't expose); the x/anthropic gate/digest calls run no MCP tools and stay on the CLI only because they share the executor — accepted, since nothing waits on their latency.

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

The `claude-sdk` connector uses `@anthropic-ai/claude-agent-sdk` with `bypassPermissions` and `settingSources: []` — muninn's prompt-builder delivers the full system prompt. It honors `thinkingMaxTokens`, `extraDirs` (TikTok frame-reading works here too), and `allowedTools`/`excludedTools`. Permission-surface details, the dead per-bot settings.json finding, and the **claude-sdk → claude-cli rollback procedure** (jarvis flipped; do both connector + OAuth-token steps if the token is blocked): `src/ai/CLAUDE.md`.

The **/models** dashboard page shows the active connector per bot — use it to confirm any flip or rollback landed.

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

Start an instance outside muninn: `uvx --from "git+https://github.com/oraios/serena" serena start-mcp-server --transport streamable-http --port 9121 --host 127.0.0.1 --context claude-code --project /path/to/project --open-web-dashboard False`. Pre-index for faster startup: `… serena project index /path/to/project --timeout 300`.

### Key files

| File | Purpose |
|---|---|
| `src/serena/manager.ts` | SerenaManager singleton — start/stop/index lifecycle |
| `src/serena/config.ts` | Config types + discovery from bot config.json |
| `src/dashboard/views/serena-page.ts` | Dashboard UI for managing instances |
| `src/ai/mcp-tool-caller.ts` | MCP Debug client — supports both stdio and HTTP servers |

## Corrective Retrieval (Path D, in huginn)

The rescue for weak knowledge searches runs inside huginn (`main/core/search_response_formatter.py` — `run_corrective_search`): on a weak signal with a usable broader/narrower-query hint it re-queries, merges + dedupes, and returns one consolidated tool result — no model re-call, no `.mcp.json` change. Per-call knob `corrective="auto"/"off"/"force"`. The dashboard waterfall shows a blue `rescue ⟲N` chip when it fired (muninn side: `src/dashboard/views/components/span-label.ts`); other chips: red `0 hits`, yellow low-confidence flip. History (incl. the removed muninn-side Path C): `mimir/plans/muninn-corrective-rag-rework.md` + siblings.

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

**`mock.module` needs its own process, not just its own file.** It invalidates the target module for the whole `bun test` process graph, so any OTHER file already loaded in that chunk which transitively imports the mocked module fails export resolution — e.g. mocking `db/goals.ts` inside `test:unit`'s first chunk breaks `src/profile/generator.ts` with `SyntaxError: Export named 'refreshInterestProfile' not found`. Spreading the real module into the mock (`{...real, override}`) fixes only the mocking file's OWN imports and does not prevent this. A mock.module test therefore gets its own `&& bun test <file>` link in the chain (see `src/profile/`, `task-executor.test.ts`, `data-routes-bot-scope.test.ts`), and says so in its header — the placement is load-bearing and invisible from the file alone.

### Conventions

- DB access: `postgres` npm package (not Supabase client, not Bun.sql)
- Memory/goal/schedule extraction: fire-and-forget async Claude Haiku calls
- Memory scope: `personal` (per-user) or `shared` (visible to all users of a bot) — Haiku auto-classifies during extraction
- AI output: standard markdown — per-platform formatters convert at send time (`telegram-format.ts`, `web-format.ts`, `slack-format.ts`)
- Conversation threads: per-user+bot named threads for chat isolation; memories/goals/tasks shared across threads. Commands: `/topic`, `/topics`, `/deltopic`. Pre-migration messages (NULL thread_id) visible only in `main` thread.
- Prompt assembly: persona (from CLAUDE.md) + memories (personal + shared) + goals + scheduled tasks + thread-scoped conversation history. Proactive rows (`messages.source` prefixes `watcher:`/`task:`/`goal:`, the complete set — see exported `PROACTIVE_SOURCE_PREFIXES` in `src/db/messages.ts`) are excluded from history via `getRecentMessages`'s opt-in `excludeProactive` flag and reach the prompt only through the bounded alerts block ("Recent proactive messages sent to user", ~300 chars/alert). The dashboard messages endpoint deliberately passes no flag. Real conversation rows always have `source = NULL`.
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
