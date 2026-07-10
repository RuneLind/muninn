# Dashboard Module — Architecture & Rules

## File Overview

| File | Role |
|---|---|
| `routes.ts` | Creates Hono sub-router, registers all route modules |
| `openapi-spec.ts` | OpenAPI 3.1.0 spec covering all JSON API endpoints |
| `index.ts` | Barrel export: `createDashboardRoutes` |

> **Moved out (2026-06, layering cleanup):** the `activity-log` and `agent-status` singletons now live in `src/observability/` (they are imported by core/scheduler/watchers, not just the dashboard — see `src/observability/CLAUDE.md`). The MCP debug client moved to `src/ai/mcp-tool-caller.ts` (the openai-compat connector consumes it, so it belongs in the lower `ai/` layer). The dashboard still consumes all three; only the source-of-truth directory changed.

## Route Organization

Routes are split by domain in `routes/`:

| File | Endpoints |
|---|---|
| `data-routes.ts` | Main CRUD: messages, memories, goals, tasks, watchers, users, threads, connectors |
| `sse-routes.ts` | SSE streams: `/events` (activity), `/agent-status` (phase), `/request-progress` (waterfall) |
| `traces-routes.ts` | Trace spans: list, detail, waterfall data, cleanup |
| `search-routes.ts` | Knowledge base document search and management |
| `research-routes.ts` | `/research` page: cited Q&A over the shelf corpus (`GET /api/research/ask` SSE — retrieve via `researchKnowledge`, synthesize one cited answer; see `src/research/{corpus,answer,ask}.ts`) + the browse `/api/research/*` endpoints. Also the Jira research flow (`/api/research/chat`: trigger analysis, post to chat). |
| `memsearch-routes.ts` | Memory semantic search (hybrid FTS + vector) |
| `graph-routes.ts` | Knowledge graph page + wikilink edge extraction across knowledge collections |
| `wiki-routes.ts` | `/wiki` reader page + `/api/wiki/{pages,page,html,ask,digest}` (per-bot knowledge-wiki browser). `/api/wiki/html` serves standalone `.html` explainers (type `explainer`, indexed by the store) as raw `text/html` for the reader's iframe — resolved strictly via the index entry's stored path, verified under the wiki root. `/api/wiki/ask` (SSE) is the reader's **Ask** tab: research-style cited Q&A scoped to the selected wiki's `collections` (bot `wikiCollections` / `WIKI_EXTRA` 3rd segment), delegating to `streamResearchAnswer` and enriching citations with matched wiki page names (`src/wiki/citation-links.ts`) so they open in-reader; a collection-less/unknown wiki emits a clean `app_error`. **Owner-routing:** the synthesis bot is `resolveWikiSynthesisBot(entry, discoverAllBots())` — an explicit per-wiki pin (`wikiSynthesisBot` config field / `WIKI_EXTRA` 4th segment) wins first (bypassing the opus fast-gate); else the owning bot answers its own wiki (jarvis wiki → jarvis, nav → melosys); standalone or opus-owned wikis fall back to the research bot. The `/wiki` page resolves the same bot at render time and shows an "Answered by <bot> (connector · model) — owner/fallback" line under the Ask tab's hint (`askBot` option on `renderWikiPage`). The Ask route also passes a per-wiki `systemPrompt` (`buildSynthesisSystemPrompt(...)` framed to the wiki name) through the shared `research-sse.ts` helper; `/research` leaves it unset (byte-identical LC prompt). Switching the synthesis bot also switches the retrieval identity (decomposer backend + `research_citations`/`search_signals` attribution). The right-column Ask tab holds only the controls (question box · status line · clickable session-history list); the **answer renders in the main article pane** as a formatted article. After the terminal `done`, the route emits a trailing `answer_html` event — the final answer markdown rendered through the shared wiki pipeline (`renderAskAnswerHtml` in `src/wiki/ask-render.ts` → `formatWebHtml`) with in-range `[n]` markers linkified to their matched pages. The client renders the streaming buffer progressively through the same `formatWebHtml` markdown pipeline (throttled to one animation frame per burst; the import-safe helper lives in `views/components/wiki-ask-render.ts` and is unit-tested), so headings/lists/code grow formatted during the stream, then swaps in the final rendered HTML on `answer_html` (falls back to the progressively-formatted text if it never arrives). The final-render hook is opt-in on the shared `research-sse.ts` helper (`renderAnswerHtml`); only the wiki route enables it (`/research` renders client-side). `/api/wiki/digest` is the start view's **What's new** card: `generateWikiDigest` (`src/wiki/digest.ts`) reads the wiki's `log.md`, summarizes the recent window (≤14 days / ≤30 entries / ≤15 KB) via one `executeOneShot` call on the wiki's synthesis bot (owner-routed via `resolveWikiSynthesisBot`, same as Ask), and marks resolvable page mentions as `[[wikilinks]]`. Cached per wiki in an in-memory Map keyed by name (mtime-validated via `digestCacheDecision`; `?refresh=1` bypasses); a wiki with no `log.md` returns `{ digest: null }`. Stored bullets stay plain markdown — the route renders them to reader HTML at response time. The `/wiki` page also annotates each picker option with the wiki's freshness date (`log.md` mtime date, fallback newest page date). |
| `wiki-gardener-routes.ts` | `/wiki/gardener` review gate + `/api/wiki/proposals` list & `:id/{approve,reject}` — approve runs the apply step (writes the page into the wiki, updates log.md, reindexes). Also `GET /api/wiki/linter-findings` — report-only wiki hygiene findings (`src/wiki/lint.ts`), recomputed on demand (no DB table); backs the **Lint findings** section on `/wiki/gardener`. Also `GET /api/wiki/ingest-backlog?bot=` — report-only "queued up" counter: per summary collection, how many all-time summary docs have never been ingested into the wiki (URL-referenced-wins / consumed-wins credit rules; pure partition in `src/wiki/ingest-backlog.ts`). Fetches the four `SUMMARY_SOURCES` collections sequentially + sweeps every wiki `.md` for URLs; per-bot in-process cache (5-min TTL, single-flight, `?refresh=1`), degrades to 200 + `errors[]`. Backs the backlog strip on `/wiki/gardener` and the "all-time backlog" line in the `/summaries` Stats tab. Same bot resolution + never-5xx contract as the linter route. Missing/unreadable wiki ⇒ 200 with an `error` field. **Backlog drain (PR 2):** the extended GET adds live fields (`running`/`offered`/`remaining`/`lastBacklogRun`/`watcherSeeded`/`progress` + the batch constants `batchSize`/`maxProposals`, echoed from `src/gardener/backlog.ts` so the client's confirm panel never hardcodes them) merged OUTSIDE the cache (`mergeBacklogLiveFields` — never mutates the cached object; strips the server-only `queuedKeys`). `progress` is the live drain projection (`getBacklogProgress`: `{stage, draftsDone, draftsTotal, currentTopic?, startedAt, cancelRequested}`) — null when idle OR when a weekly run holds the mutex (that path passes no `onProgress`, so its `Running…` state is deliberately non-cancellable). `POST /api/wiki/gardener/backlog-run` kicks a DETACHED gardener run over a bounded batch of never-ingested docs through the SAME pipeline (`startBacklogRun`/`assembleBacklog` in `src/gardener/backlog.ts` + `buildGardenerSeams` from `src/watchers/wiki-gardener.ts`); responds `{state: started\|running\|…}` immediately, no Telegram alert. The run's work fn owns the progress-map writes + the `cancelRequested` read and threads them into `runGardener` as hooks (`onProgress`/`shouldAbort`/`onAborted`); the route's closure only forwards them. `POST /api/wiki/gardener/backlog-cancel` soft-cancels the in-flight drain (`requestBacklogCancel` flips the run's cancel flag; the runner stops after ≤1 more draft, keeps every persisted proposal, returns the undrafted clusters' docs to the offered set); no run in flight ⇒ no-op 200 `{cancelled:false}` (same resolution/watcher-seeded guards as reset). `POST /api/wiki/gardener/backlog-reset` clears the offered-memory snapshot. See `src/gardener/apply.ts` + the "Wiki Gardener" and "Wiki Linter" sections of `src/watchers/CLAUDE.md`. |
| `logs-routes.ts` | Log file viewer (JSONL files from LogTape) |
| `tools-routes.ts` | MCP tool debug: connect, list, call, disconnect |
| `summaries-routes.ts` | Unified `/summaries` page + `/api/summaries/documents` (merged, source-tagged archive across every summary source — see `src/summaries/sources.ts`) + `/api/summaries/stats` — the **Stats** tab: per-source new-summary counts per calendar month (last 8 months) + 30-day wiki-gardener coverage (consumed / pending / never-clustered vs `wiki_proposals`). Fetches each collection sequentially, parses dates via the gardener's `docDateMs`, aggregates in the pure `src/summaries/stats.ts`; per-bot in-process cache (5-min TTL, single-flight, `?refresh=1` bypass); degrades to a 200 + `errors[]` when huginn/DB is unreachable. |
| `youtube-routes.ts` | YouTube transcript fetch + summarization API. `/youtube` now 301-redirects to `/summaries?source=youtube`; the page lives in the merged view |
| `x-article-routes.ts` | X/Twitter article summarization API (Chrome extension backend). `/x-articles` now 301-redirects to `/summaries?source=x-article` |
| `anthropic-routes.ts` | Claude Learning Center **Curate** layer (Candidates → Summaries). The candidate inbox (`GET /api/anthropic/candidates`, `POST …/:id/{summarize,dismiss}`) + the summarizer vertical (`/api/anthropic/{stream,jobs,document,similar}`, mirroring youtube-routes against the `anthropic-summaries` collection). Summarizes a watcher-captured candidate by pulling its content from Huginn `anthropic-knowledge`; renders on `/summaries` badged "Claude". Also `GET /api/anthropic/candidates/stats` — read-only gate-outcome calibration (per-kind + per-score-band acceptance + suggested `candidateMinScoreByKind`) backing the `/summaries` **Calibration** tab; never writes watcher config. See `src/anthropic/{state,summarizer}.ts` + `src/watchers/anthropic.ts` (capture + ≥0.9 auto-promote) + `candidateOutcomeStats` in `src/db/summary-candidates.ts`. |
| `models-routes.ts` | `/models` page + `GET /api/models/overview` (JSON) — the effective model / connector / Haiku backend for every AI job after all defaults, next to the models actually used in the last 7 days. Assembly is the pure, DB-injectable `src/dashboard/models-overview.ts` (`assembleModelsOverview` over `resolveBackendWithReason` + `resolveSummarizerBot`/`resolveResearchBot`/`resolveWikiSynthesisBot` + `connectorCapabilities` + the `watchers` table + the shared wiki-registry memo + `haiku_usage`/`traces`). A read-only **Wiki synthesis** group (`wikiSynthesis`) lists one row per registered wiki with its resolved synthesis bot + connector/model + a `pinned`/`owner`/`fallback` origin chip (see `resolveWikiSynthesisBot`: explicit `synthesisBot` pin beats owner-gate + fallback); a pin naming no discovered bot is ignored and rendered as a red "pin '<name>' matches no bot — ignored" note (`ignoredPin`). The wiki registry is an injectable dep (`getWikiRegistry`, fabricated in tests). The hard-coded "What's-new wiki digest" role row no longer names a single bot (it routes per-wiki) — it points at the Wiki synthesis group. Diagnostic — surfaces the #191 silent-fallback class. Assembled fresh per request (no cache); degraded sources land in `errors[]`, never a 5xx. **Editing (PR 5):** `POST /api/models/bot-config` `{bot,field,value}` writes one per-bot config.json field (connector/model/thinkingMaxTokens/haikuBackend) IN PLACE via `writeBotConfigField` (`src/bots/config-edit.ts`) — the git-synced source of truth, so it **applies on restart**; validated with `validateBotConfigField` (discovery-aligned enum lists via shared constants; deliberately stricter than discovery on scalars — rejects empty model and negative/non-integer thinking; bad value → 400); the `bot` must name a discovered bot; `value:null` clears the field. `POST /api/models/role` `{role,value}` sets/clears a HOT DB-backed override for `SUMMARIZER_BOT`/`RESEARCH_BOT`/`HAIKU_BACKEND` (`src/db/role-overrides.ts`) — beats the env var at the next resolution with **no restart** (the sync resolvers read an in-memory snapshot refreshed on every write; primed at startup in `src/index.ts` via `loadRoleOverrides`); empty value clears; bot-roles must name a discovered bot (else 400). Summarizer reassignment onto a connector lacking `supportsExtraDirs` returns a non-blocking TikTok `warning`. Every edit is activity-logged (`source: "models-page"`). An active override renders an `override` origin chip in the overview. |
| `route-utils.ts` | Shared helpers: UUID validation, pagination parsing |

## View System

All pages are server-side rendered HTML via template literals. No build step, no framework.

### Component Pattern

Each component in `views/components/` exports up to three functions:

- `*Styles()` — returns a CSS string (injected into `<style>`)
- `*Html()` — returns an HTML string (injected into `<body>`)
- `*Script()` — returns a JavaScript string (injected into `<script>`)

Pages (`views/*.ts`) compose components by calling all three and concatenating into a full HTML document.

### Shared Infrastructure

- `views/shared-styles.ts` — CSS variables (colors, spacing), base reset, header, nav. Imported by all pages.
- `views/components/helpers.ts` — Inline JS utilities: `esc()` (HTML escaping), `extractToolInputLabel()`, formatting helpers.

### Pages

`page.ts` (main dashboard), `traces-page.ts`, `search-page.ts`, `search-document-page.ts`, `research-page.ts`, `logs-page.ts`, `mcp-debug-page.ts`, `serena-page.ts`, `summaries-page.ts` (unified YouTube + X-article summaries; composes the `sum-*` components, injects the `SOURCES` registry), `models-page.ts` (models overview — three grouped tables: Bots · Role assignments · Pipeline jobs; client-fetches `/api/models/overview`, bot selector re-scopes only the per-bot Pipeline rows).

## Real-Time Updates

### SSE Endpoints (sse-routes.ts)

- `/events` — activity feed events (message_in, message_out, memory, error, etc.)
- `/agent-status` — phase changes (idle, calling_claude, transcribing, etc.)
- `/request-progress` — full waterfall data (tools with timing, tokens, model)

### Agent Status (`src/observability/agent-status.ts`)

Tracks in-flight requests in a `Map<requestId, RequestProgress>` (concurrent requests no longer clobber a shared slot). The read side still surfaces a single primary request, so the SSE `/request-progress` contract and the waterfall UI are unchanged. See `src/observability/CLAUDE.md` for the full method list and the request-scoped-mutator rule.

1. `startRequest()` — creates RequestProgress keyed by a fresh requestId
2. `toolStart(requestId, …)`/`toolEnd(requestId, …)` — records tool calls with timing
3. `completeRequest(requestId, …)` — marks done, auto-clears that request after 30s
4. Phases: `idle`, `receiving`, `transcribing`, `building_prompt`, `calling_claude`, `saving_response`, `sending_telegram`, `sending_slack`, `synthesizing_voice`, `running_task`, `checking_goals`, `running_watcher`

### Activity Log (`src/observability/activity-log.ts`)

- In-memory ring buffer (max 500 events) + fire-and-forget DB persistence
- `loadFromDb()` called after DB init to hydrate on startup
- `stats` getter: messages today, avg response time, total cost

## MCP Debug Client (`src/ai/mcp-tool-caller.ts`)

- Supports both stdio (spawn process) and HTTP (StreamableHTTP) transports
- Connection pool keyed by `bot:server` — reuses existing connections
- Timeouts: 30s connect, 120s tool call
- Used by the MCP debug page (`tools-routes.ts`), Serena management, and the `openai-compat` connector

## Common Pitfalls

1. **SSE format**: Events must be `data: JSON\n\n` — missing double newline breaks the stream.
2. **Agent status waterfall is single-pane**: the data layer tracks all concurrent requests (per-`requestId` Map), but `/request-progress` emits only the primary (most-recently-started) request, so the overlay shows one at a time.
3. **Component pattern**: Always export all three (*Styles, *Html, *Script) even if empty — pages expect them.
4. **MCP connection cleanup**: Always call `disconnectServer()` or `disconnectAll()` — leaked stdio processes stay alive.
