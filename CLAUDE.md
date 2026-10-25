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
- Postgres goes through the `postgres` npm package (see Conventions), not `Bun.sql` or `pg`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Debugging
When debugging issues, exhaust the most likely root cause hypothesis thoroughly before moving to the next. Avoid shotgun debugging — form a clear hypothesis, test it, and only move on when it's definitively ruled out. Especially for Slack bot issues, check app configuration and permissions before assuming code bugs.

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
bun run preview:role fag --wiki <name>=<root>  # A wiki as one answer group sees it on the pod (port 3013)
```

### Multi-Bot Architecture

One muninn process runs every bot: each gets its own Grammy Telegram bot and AI connector, and they share the DB, dashboard and scheduler.

Each bot lives in `bots/<name>/` with its own:
- `CLAUDE.md` — persona (auto-loaded by Claude CLI as project instructions)
- `config.json` — per-bot overrides (connector, model, thinking tokens, timeout, baseUrl)
- `.mcp.json` — MCP tools (Gmail, Calendar, etc.)
- `.claude/settings.json` — tool permissions

Each bot selects its AI connector via `config.json` (`"connector"`: `"claude-cli"`, `"copilot-sdk"`, `"openai-compat"`, or `"claude-sdk"`). Claude CLI is spawned with `cwd: bots/<name>/` so it auto-discovers all config and stores conversation history separately. See "Switching chat connector" below for what each connector does and when to pick it; the Conventions section covers their internal mechanics.

A bot is active if its folder has a `CLAUDE.md` and at least one platform token: `TELEGRAM_BOT_TOKEN_<NAME>`, or `SLACK_BOT_TOKEN_<NAME>` plus `SLACK_APP_TOKEN_<NAME>`.

### Key Modules

| Module | Path | Purpose |
|---|---|---|
| Core | `src/core/` | Central message pipeline — `message-processor.ts` (shared by Telegram/Slack/web), metadata extraction, progress callbacks |
| AI | `src/ai/` | Connector abstraction (`connector.ts`), Claude CLI + Copilot SDK + OpenAI-compat + Claude SDK connectors, prompt builder, embeddings |
| Memory | `src/memory/extractor.ts` | Async Claude Haiku call to extract memories (personal or shared scope) |
| Profile | `src/profile/` | Interest profile — weekly Haiku distillation of goals+memories (`generator.ts`), augment-only injection into watcher gate prompts (`inject.ts`). Keyed **per watcher owner** (`watcher.userId`), not `bot_default_user`; the user-less gardener drain falls back to `loadInterestProfileForBot`. Loader swallows all errors to `null` (⇒ unchanged prompt), so keying bugs degrade silently — verify via prompt snapshots |
| Scheduler | `src/scheduler/` | Unified scheduler (scheduled tasks + goal reminders + watchers), task detector, shared Haiku executor |
| Watchers | `src/watchers/` | Proactive outreach — email watcher (Haiku + Gmail MCP), quiet hours, runner; plus the `wiki-committer` daily sweeper and the `consolidation-gardener` weekly watcher (see Gardener row + `src/watchers/CLAUDE.md`) |
| Gardener | `src/gardener/` | Wiki gardener — three drafting pipelines (weekly `wiki-gardener` clusters summaries into wiki-page proposals; weekly `consolidation-gardener` drafts synthesis pages across a wiki's own pages; per-capture `source-drafter`) feeding the human review gate at `/wiki/gardener`, plus the model-free `lint` kind (`lint-proposals.ts` — the wiki linter's check-8 series findings, one row per touched page under a shared `group_key`, applied as ONE card with one Accept). Anything writing to a wiki must join the shared per-wiki write queue (`src/wiki/queue.ts`) with the section spanning read→CAS→write→log.md and the commit tail OUTSIDE it. Full pipeline detail + the drafter tool-fence trap: `src/gardener/CLAUDE.md`; scheduling: `src/watchers/CLAUDE.md` |
| DB | `src/db/` | Postgres CRUD — messages, memories, activity, goals, scheduled tasks, watchers, threads, user settings |
| Web format | `src/web/web-format.ts` | Markdown → HTML for web chat (server side; client mirror in `src/chat/views/components/web-format-client.ts`). Full detail, rules and traps: `src/web/CLAUDE.md`. |
| Share | `src/share/` | One source document to a pasteable post (`POST /api/wiki/share`). Full detail, rules and traps: `src/share/CLAUDE.md`. |
| Jira composer | `src/jira/` | A chat thread → a pasteable Jira task. Full detail, rules and traps: `src/dashboard/CLAUDE.md`. |
| Repo sync | `src/sync/` | The two-machine repo-sync loop behind `SYNC_REPOS` + `POST /api/sync/run` + the `/models` **Repo sync** card. `config.ts` (pure parse: modes, same-repo dedup, the plain-over-a-wiki warning), `decide.ts` (pure: quiet period, deletion-hold, rename pairs, card state/tone/reason) and `run.ts` (the per-repo state machine + the in-memory ledger). It joins BOTH existing wiki queues in a pinned order and holds neither across network I/O — **read `src/sync/CLAUDE.md` before touching the locking, the deferral states or the staging rules**. |
| Plans | `src/plans/` | The `/plans` board over mimir's `plans/` directory, priced from the claude-usage ledger. Full detail, rules and traps: `src/plans/CLAUDE.md`. |
| GCP access token | `src/gcp/` | `access-token.ts`: an Application Default Credentials token (metadata server first, `gcloud auth application-default print-access-token` second), cached and single-flighted by `GcpTokenProvider`, with one process-wide instance, `adcTokens`, shared by the Vertex connectors (`vertexTokens` is that instance) and the wiki bucket mirror. |
| Auth | `src/auth/` | The `MUNINN_AUTH` switch, PR C's claimed-id guard and PR D's resource guard. Full detail, rules and traps: `src/auth/CLAUDE.md`. |
| Capture jobs | `src/summaries/summarizer-shared.ts` | Shared seam for the seven capture verticals (four video, three text). A stored document can be summarized again from its own `## Transcript` (`POST /api/summaries/rerun`). Full detail, rules and traps: `src/summaries/CLAUDE.md`. |
| YouTube | `src/youtube/` | Transcript fetch + summarization (backs `youtube-routes.ts` + Chrome extension). Every capture runs ONE yt-dlp metadata probe (`probe.ts`, description included): frames-on inside the frames queue, frames-off OUTSIDE it with a 10 s bound, so the description's source links land in a `## Links` section. Full detail, rules and traps: `src/youtube/CLAUDE.md`. |
| X article | `src/x-article/` | X/Twitter summarization, for pasted text and X video posts. Full detail, rules and traps: `src/x-article/CLAUDE.md`. |
| Video media | `src/video/` | Shared yt-dlp, whisper and ffmpeg engine, plus the one short-video job behind TikTok and X-video. A caller URL reaches yt-dlp only through the route gate (`src/dashboard/routes/url-gate.ts`). Full detail, rules and traps: `src/video/CLAUDE.md`. |
| TikTok | `src/tiktok/` | TikTok summarization including visual content. Requires `yt-dlp` on PATH and a `SUMMARIZER_BOT` connector with `supportsExtraDirs`. Full detail, rules and traps: `src/tiktok/CLAUDE.md`. |
| Vimeo | `src/vimeo/` | Conference-talk capture — a Vimeo URL to a summarized, indexed, citable talk, into the `vimeo-summaries` collection. Full detail, rules and traps: `src/vimeo/CLAUDE.md`. |

#### Per-bot config.json

Every field is optional and falls back to the global `.env` value. The field table (`connector`, `haikuBackend`, `model`, `effort`, `timeoutMs`, `baseUrl`, the wiki fields, the `prompts/` files, `wikiAutoCommit`) and discovery's validation rules are in `src/bots/CLAUDE.md`. On adaptive-thinking models (Opus/Sonnet 4.6 and later, every 5.5 model) set `effort`; `thinkingMaxTokens` is ignored there.

### Database

PostgreSQL + pgvector via Docker (single container).

- URL: `postgresql://muninn:muninn@127.0.0.1:5435/muninn`
- Schema: `db/init.sql` (full consolidated schema, applied by Docker on first start). Provisioning anywhere Docker does not apply it — a nais pod — is `bun db/provision.ts --yes`; the five schema states it distinguishes and why the predicate is the whole table set are in `src/db/CLAUDE.md`.
- Migrations: `db/migrations/` (numbered `.sql` and `.ts` files, tracked in `schema_migrations` table)
- Key tables (the complete set is `db/init.sql`): `users` (canonical user identity), `messages`, `activity_log`, `memories` (with vector embeddings + scope), `goals`, `scheduled_tasks`, `watchers` (incl. `last_success_at` — "the checker last covered its window up to here", NOT moved by quiet-hours skips or failures the way `last_run_at` is; the email checker bounds its Gmail query on it, see `src/watchers/CLAUDE.md`), `connectors` (named AI connector configurations), `threads` (per-user+bot conversation isolation, optional FK to connectors), `user_settings`, `haiku_usage`, `traces` (spans with parent-child hierarchy + JSONB attributes), `research_citations` + `search_signals` (durable retrieval signals — citations per research answer; hourly harvest of huginn quality attrs before trace cleanup), `message_feedback` (per-assistant-message 👍/👎 from Telegram reactions + web chat), `interest_profiles` (per user+bot Haiku-distilled interests, injected into watcher gate prompts), `user_identities` (the `entra` link: `(provider, tenant, oid) → users.id` + `nav_ident`/`display_name` refreshed on every login — migration 073; the key is `oid` because a NAVident is re-issued, and provisioning is `users` + this row in ONE transaction, never a default thread), `role_overrides` (DB-backed hot overrides for `SUMMARIZER_BOT`/`RESEARCH_BOT`/`HAIKU_BACKEND`, edited from `/models`; beat env at resolution time), `x_link_amplifiers` (cross-run X pointer votes per destination URL; shipped flag-gated OFF — see `captureAmplifyMin` in `src/watchers/CLAUDE.md`)

### Configuration (.env)

The full variable table — default, parse rule and trap for each — is the `muninn-env` skill (`.claude/skills/muninn-env/SKILL.md`). Load it before adding, renaming or reading an env var. These rules hold everywhere:

- `DATABASE_URL` is required. Construct every Postgres client through `openPostgres` (`db/postgres-connection.ts`); a test pins it. A nais `DB_URL` carries `ssl*` query parameters that postgres.js would otherwise send in the startup packet.
- `DASHBOARD_HOST` defaults to `127.0.0.1` because the dashboard has no auth and exposes MCP tools, logs, traces and full CRUD.
- `MUNINN_PROFILE` and `MUNINN_AUTH` parse fail-closed: an unknown value throws at boot instead of serving the full surface.
- Vertex region `global` is refused at boot in every name (`VERTEX_REGION`, `CLOUD_ML_REGION`, any `VERTEX_REGION_CLAUDE_*`), whether or not Vertex is on.
- A new instance-profile variable joins `AMBIENT_INSTANCE_ENV` (`src/test/ambient-env.ts`), so no suite inherits a developer's `.env`.

### Switching Haiku backend and chat connector

Which backend a bot's chat turn and its Haiku-tier calls (the `research_knowledge` decomposer, the memory/goal/schedule extractors) run on is set per bot in `bots/<name>/config.json` via `connector` and `haikuBackend`, or process-wide via `HAIKU_BACKEND`. The goal→setting→auth tables for every combination (Copilot, Anthropic SDK, Vertex AI, local OpenAI-compatible, Claude CLI), the Vertex per-request token rules and the diagnostics that prove which backend actually ran are in `src/ai/CLAUDE.md`; the `muninn-ai-connectors` skill has the cross-cutting walkthrough. The **/models** dashboard page shows the active connector per bot — use it to confirm any flip or rollback landed.

### Adding a New Bot / Config Sync / Serena

Adding a bot: `bots/CLAUDE.md`. Syncing gitignored bot folders to their source-of-truth repos (`bots.config.json`, `bun run config:sync`): the `muninn-config-sync` skill. Serena MCP code-analysis instances (`src/serena/`, the `/serena` dashboard page): the `muninn-serena` skill.

## Corrective Retrieval (Path D, in huginn)

The rescue for weak knowledge searches runs inside huginn (`main/core/search_response_formatter.py` — `run_corrective_search`): on a weak signal with a usable broader/narrower-query hint it re-queries, merges + dedupes, and returns one consolidated tool result — no model re-call, no `.mcp.json` change. Per-call knob `corrective="auto"/"off"/"force"`. The dashboard waterfall shows a blue `rescue ⟲N` chip when it fired (muninn side: `src/dashboard/views/components/span-label.ts`); other chips: red `0 hits`, yellow low-confidence flip. History (incl. the removed muninn-side Path C): `mimir/plans/muninn-corrective-rag-rework.md` + siblings.

## Testing

Always run `bun run test` after adding or changing a feature to verify nothing is broken. Tests are split into three sub-scripts (`test:unit` / `test:db` / `test:handlers`) to avoid `mock.module()` leakage between files. `test` does not call them: it inlines its own copy of their links, so a link added to a sub-script also has to be added to `test`, or CI never runs it.

`bun run test:count` reports how many tests the repo has, grouped unit / integration / e2e. It groups by the `test*` chains rather than by directory, since a chain is where the repo decides what a test needs to run: `db/postgres-connection.test.ts` runs in `test:unit` and `db/provision.test.ts` beside it in `test:db`. A chain that needs Postgres or a live server is integration, so `test:hivemind` counts as integration. By default it counts declarations, which reads low, because a test declared in a loop or a `.each` table counts once. `-- --run` measures instead: it runs the bun chains once each, takes back out any file two chains of one group both run (unless a chain that runs it failed), and lists the e2e specs with `playwright test --list` without running them. It skips `test:integration`, which needs `bun run dev` on 3010 and makes real Claude calls, and exits non-zero when a chain fails. `-- --files` gives the per-file list and `-- --json` a machine-readable version. It also reports where the chains have drifted apart: test files no chain runs, files only `test` runs, and grouped files `test` skips, so CI never runs them.

DB tests require the local Postgres container (`bun run db:up`) and a test database (`bun run db:setup:test`). `MUNINN_TEST_DATABASE_URL` points every suite (and `db:setup:test`) at another database, so two runs can work in parallel; it must name a database ending in `_test` or the suite refuses to start (`src/test/test-db-url.ts`). An isolated e2e run sets BOTH `MUNINN_TEST_DATABASE_URL` and `DATABASE_URL` to that same `_test` database: `bun run db:seed:e2e` and the shared Playwright server on 3011 read `DATABASE_URL`, so the seeded rows land where that server looks. **`db/provision.test.ts` needs more than that** — it connects to the `muninn` database as an admin and runs `CREATE DATABASE`/`DROP DATABASE`/`CREATE ROLE` against its own scratch database and a purpose-made non-superuser role (the privilege wall a managed instance puts in front of `CREATE EXTENSION` is not provable as superuser). `db:up` and CI both satisfy that; a hand-built container without a `muninn` database, or a role without `CREATEDB`/`CREATEROLE`, fails there rather than at the documented setup step. Test files are co-located with source files (`*.test.ts`). Shared test infrastructure lives in `src/test/`.

**`mock.module` needs its own process, not just its own file.** It invalidates the target module for the whole `bun test` process graph, so any OTHER file already loaded in that chunk which transitively imports the mocked module fails export resolution — e.g. mocking `db/goals.ts` inside `test:unit`'s first chunk breaks `src/profile/generator.ts` with `SyntaxError: Export named 'refreshInterestProfile' not found`. Spreading the real module into the mock (`{...real, override}`) fixes only the mocking file's OWN imports and does not prevent this. A mock.module test therefore gets its own `&& bun test <file>` link in the chain (see `src/profile/`, `task-executor.test.ts`, `data-routes-bot-scope.test.ts`), and says so in its header — the placement is load-bearing and invisible from the file alone. **And the leak is order-dependent in a way no developer machine shows:** `bun test` runs files in an order of its own — not argv order, not alphabetical — that depends on the SET of files in the run: on the same GitHub runner, main run #508 loaded `src/chat/chat-config.test.ts` before `src/ai/haiku-direct.test.ts` (green) and #509, which added one test file and touched no chain, loaded them the other way round (red: `getDb().unsafe is not a function` from the `db/client.ts` mock — 19 red `test` jobs 2026-09-03 → 09-05 with that one green between them), while the mini ordered the same set as #508 every time. So a mock in a shared process is green or red per (machine, file set) and flips on any commit that adds a test file; "passes locally" and "CI was green last week" are both non-evidence. Once that file was isolated, `src/watchers/anthropic.test.ts`'s partial `db/summary-candidates.ts` mock inside the one-argument `bun test src/watchers/` link reached `runner.test.ts` → `x.ts` on the runner's order (`Export named 'upsertDestinationCandidate' not found`) — and failed to link its OWN import graph the moment it ran alone, masked until then by `x.test.ts`'s fuller mock loading first. `src/test/mock-isolation.test.ts` pins the rule mechanically: every test file that calls `mock.module` is the only FILE its `bun test` link expands to — a directory argument is one argument and many files, no path argument is every file — in every `test*` chain except `test:coverage` (exempted by name: bun's whole-repo single-process run, mock-contaminated by construction), is run by some chain at all, and every explicit file argument is on disk (a missing one is a silent name filter). The guard is the evidence a mock file has that placement.

### Browser checks

Anything verified in a browser goes through Playwright: an `e2e/` spec by default, `playwright-cli` for exploration. The rules for spawned servers (`e2eEnv()`), ports (`e2e/ports.ts`), throwaway bots (`MUNINN_BOTS_DIR`) and seeding (`db:seed:e2e`) are in `e2e/CLAUDE.md`.

Two traps regardless of how the page is driven:
- **`bun --watch` never rebuilds the `/wiki` client bundle.** Restart the dev server before any client-side acceptance run, or the previous build is what gets tested.
- Driving `bun run dev` (port **3010**) by hand runs against the developer's real `.env` — live bots, live wikis. Read-only checks only; anything that writes belongs on the 3011 spec server.

### CI

`.github/workflows/ci.yml` runs typecheck, audit, test, four e2e shards with a fan-in, and docker-build on every push to `main` and every PR. Load the `muninn-ci` skill before diagnosing a red job or editing the workflow, the shard plan or `e2e/ci-expected-skips.txt`. Two rules hold always: a runner has no `.env`, and e2e runs with `workers: 1` and `retries: 0` — never add retries, which turn a contention bug into a silent pass. A red `audit` is a dependency finding to fix or to suppress by GHSA id, never a flake to re-run.

## Conventions

- DB access: `postgres` npm package (not Supabase client, not Bun.sql)
- Memory/goal/schedule extraction: fire-and-forget async Claude Haiku calls
- Memory scope: `personal` (per-user) or `shared` (visible to all users of a bot) — Haiku auto-classifies during extraction. **On an authenticating instance (`MUNINN_AUTH` ≠ `off`) the READ side narrows to the reader's own rows at both search call sites** (`sharedMemoryReadsAllowed`, `src/auth/policy.ts`): `shared` rows go verbatim into the prompt's `<context>` block under `Shared team knowledge:` with the scope assigned by a fire-and-forget classifier, which is a feature on one instance and one colleague's content entering another's model context on a shared one
- AI output: standard markdown — per-platform formatters convert at send time (`telegram-format.ts`, `web-format.ts`, `slack-format.ts`)
- Conversation threads: per-user+bot named threads for chat isolation; memories/goals/tasks shared across threads. Commands: `/topic`, `/topics`, `/deltopic`. Pre-migration messages (NULL thread_id) visible only in `main` thread.
- Prompt assembly: the system prompt holds what stays stable across turns (persona from CLAUDE.md, identity, tool restrictions, standing rules) so it caches; the user turn holds the thread-scoped conversation history, then a `<context>` block with this turn's memories (personal + shared), goals, scheduled tasks and alerts, then the message. Proactive rows (`messages.source` prefixes `watcher:`/`task:`/`goal:`, the complete set — see exported `PROACTIVE_SOURCE_PREFIXES` in `src/db/messages.ts`) are excluded from history via `getRecentMessages`'s opt-in `excludeProactive` flag and reach the prompt only through the bounded alerts block ("Recent proactive messages sent to user", ~300 chars/alert). The dashboard messages endpoint deliberately passes no flag. Real conversation rows always have `source = NULL`.
- AI connectors: `resolveConnector(botConfig)` returns the appropriate executor (`claude-cli`, `copilot-sdk`, `openai-compat`, or `claude-sdk`). All callers use this instead of importing executors directly. Connectors conform to the `AiConnector` type signature.
- Claude CLI connector: spawned with `cwd: bots/<name>/` — auto-discovers MCP, settings, stores history there. Output: `--output-format stream-json --verbose` (NDJSON events with tool_use blocks); `--verbose` is required with `-p` flag. Falls back to legacy JSON parser if stream result event is missing (known CLI bug)
- Copilot SDK connector: shared `CopilotClient` singleton (lazy-loaded), per-request sessions. Reads `.mcp.json` and converts to SDK format. Emits `assistant.intent` events shown as inline chat bubbles.
- OpenAI-compat connector: calls any OpenAI-compatible API (Ollama, LM Studio, vLLM). Agent loop with MCP tool execution — loads tools from `.mcp.json`, sends as OpenAI `tools` parameter, executes tool_calls against MCP servers in a multi-turn loop. Handles Qwen3/Ollama thinking tokens (`reasoning` field + `<think>` tag stripping). Retries on empty responses (3x with 2s delay).
- MCP tool tracking: tool calls extracted from stream events (stream-json for CLI, session events for SDK), per-tool timing, displayed as child spans in traces waterfall
- Scheduled tasks: cron-style (hour/minute/days) or interval-style (every N ms), timezone-aware
- Watchers: interval-based background monitors (email, calendar, etc.) with dedup via `lastNotifiedIds`
- Watcher email checking: Haiku spawned in muninn's agent home on the `gmail-read` tool surface — the bot's Gmail server only, the three Gmail reads allowed, `dontAsk`, the known write tools disallowed; every other `spawnHaiku` is tool-less — see the `MUNINN_AGENT_CWD` row
- Quiet hours: per-user, timezone-aware, overnight ranges supported (e.g. 22-08)
- All timestamps stored as `TIMESTAMPTZ` in DB, exposed as epoch ms in TypeScript

## Logging

Uses [LogTape](https://github.com/dahlia/logtape) for structured logging. **Never use `console.log/warn/error` in `src/` files** — use the logger instead.

`getLog("subsystem", "subpath")` from `../logging.ts` returns a logger on the category `["muninn", subsystem, subpath]`. Pass structured properties as the second argument — they become searchable fields in the JSONL sink, and `botName` is special: the console formatter prepends it as `[jarvis]`.

**Sinks:**
- Console: colored `LEVEL [subsystem/path] message` format
- File: daily-rotating JSONL in `logs/` dir (7-day retention, configurable via `LOG_DIR` env var, set `LOG_DIR=none` to disable)

**Tests:** Unconfigured loggers are silent no-ops — tests never call `setupLogging()`, so all logs are discarded. No mocking needed.

## Database & Migrations
After creating database migrations, always remind the user to run them against the target database. When modifying data models, check if existing data needs to be backfilled or updated — don't assume only new records matter.

## Code Quality
When fixing TypeScript errors, fix **all** of them — never leave partial fixes.
