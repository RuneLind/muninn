# Observability Module — Architecture & Rules

Cross-cutting runtime observability singletons. These are imported by **core, scheduler, watchers, bot, slack, and dashboard** alike, so they live in their own neutral module rather than under `dashboard/` (where they used to sit before the 2026-06 layering cleanup — having lower layers import *up* from `dashboard/` was the smell being fixed).

## File Overview

| File | Role |
|---|---|
| `activity-log.ts` | `activityLog` singleton — in-memory event ring buffer with DB write-through and pub/sub |
| `agent-status.ts` | `agentStatus` singleton — tracks the active request's progress (phase, tools, tokens) + connector label helpers |

## Activity Log (`activity-log.ts`)

- In-memory ring buffer (max 500 events) + fire-and-forget DB persistence (`saveActivity`)
- `loadFromDb()` called once after DB init (`src/index.ts`) to hydrate on startup
- `push(type, message, …)` appends + notifies subscribers; dashboard SSE `/events` subscribes
- `stats` getter / `computeStats()`: messages today, avg response time, total cost
- Producers span every platform: `core/message-processor.ts`, `core/response-handler.ts`, `core/process-error.ts`, `scheduler/*`, `watchers/runner.ts`, `bot/*`, `slack/handler.ts`

## Agent Status (`agent-status.ts`)

Tracks the lifecycle of in-flight requests (the waterfall/progress overlay source). Requests are stored in a `Map<requestId, RequestProgress>`, so concurrent work (multiple users on one bot, parallel watchers) accumulates each request's tools/phase independently instead of clobbering a shared slot.

1. `startRequest()` — creates `RequestProgress` keyed by a fresh `requestId` (returned to the caller)
2. `updatePhase(requestId, …)` / `toolStart(requestId, …)` / `toolEnd(requestId, …)` / `setConnectorLabel(requestId, …)` / `setModel(requestId, …)` — **every mutator takes the `requestId`**; an unknown id is a silent no-op (defensive against callbacks arriving after auto-clear)
3. `completeRequest(requestId, …)` — marks done, auto-clears *that request* after 30s (per-request timer). **Exception:** `kind: "extractor"` runs auto-clear after **5s** — extractors fire on nearly every turn, so a 30s dwell piles up dozens of just-finished rows. Extractor Recent still comes from `haiku_usage` (durable), so the ring is not the source for that kind.
4. `clearRequest(requestId?)` — clears one request, or (no arg) every tracked request (reset / no-active-request error path)
5. Phases: `idle`, `receiving`, `transcribing`, `building_prompt`, `calling_claude`, `saving_response`, `sending_telegram`, `sending_slack`, `synthesizing_voice`, `running_task`, `checking_goals`, `running_watcher`, plus the **additive** research phases `searching`/`synthesizing` and the gardener-drain stages `assembling`/`harvesting`/`clustering`/`resolving`/`drafting` (mirror `BacklogProgress.stage` so the `/agents` card can render "Drain: <stage>"). No consumer switches exhaustively on `AgentPhase` — the client `phaseLabels` maps fall back to the raw value, so extending the union is safe. Mirror any addition into the two client `phaseLabels` maps (`agents-page.ts`, `agent-status-ui.ts`).
6. `setConnectorInfo(requestId, …)` / `getConnectorLabel()` — connector display label (mirrored verbatim by `dashboard/views/components/traces-list.ts`)
7. `createProgressCallback(requestId, …)` — adapts a `StreamProgressCallback` into status updates for that request (used by core + scheduler)

**Single-pane read side (unchanged):** `getProgress()` / `subscribeProgress()` still surface a single `RequestProgress | null` — the *primary* (most-recently-started) live request — because the chat waterfall is a single-pane view. This keeps the `request_progress` SSE contract (`sse-routes.ts`) and the waterfall UI untouched. **Primary is kind-filtered** (`WATERFALL_KINDS` = chat/scheduled_task/watcher — exactly the pre-registry producers): background kinds (extractor/research/gardener_drain/capture/profile) never become primary, so the post-turn extractors can't hijack a completed chat card's auto-dismiss. They surface only via `getAll()`/`subscribeAll()`.

**AgentRun registry read side (multi-run, `/agents` dashboard).** `RequestProgress` is now `AgentRun` (alias kept for compat) with additive optional fields — `kind` (`chat`/`scheduled_task`/`watcher`/`gardener_drain`/`capture`/`research`/`extractor`/`profile`, defaulted to `"chat"` at `startRequest`), `name`, `progress {done,total,currentItem?}`, `expectedDurationMs` (the field exists on the run, but the `/agents` ETA is computed off-run in `assembleAgentsOverview` via `src/dashboard/agent-eta.ts` and delivered as the overview's `estimates` map — see `dashboard/CLAUDE.md`; producers don't set it), `sourcePage`, `cancelRequested`. New read side:
- `getAll()` — every tracked run (live + completed-but-not-yet-cleared); the `/agents` overview filters non-completed for its `running[]`.
- `getRecentCompleted()` — the **completed-runs ring** (last ~50 `AgentRun` clones, populated in `completeRequest`, surviving the 30s auto-clear). Feeds Recent for kinds with no durable trace/usage row (gardener_drain/capture/research/per-task).
- `subscribeAll(fn)` — full-snapshot updates, **throttled to ~1/s in the tracker** (not in subscribers — the SSE route fans each snapshot to every dashboard page); the snapshot caps tools per run at 20. The route sends the initial snapshot via `getAll()` on connect. Emits the `agent_runs` SSE event.
- `startRequest(bot, phase, username?, { kind?, name? })` — 4th arg is additive; existing 3-arg callers get `kind: "chat"`. `updateProgress`/`setExpectedDuration`/`setSourcePage`/`setCancelRequested` are request-scoped mutators like the rest.

`clearRequest()` (no id) is a full reset: it also drops the ring + throttle state (tests only — no production caller passes no id). New fields are shape-additive: the `request_progress` payload keeps all existing keys.

**Registry producers (the four blind-spot adapters).** Beyond the chat/scheduled-task/watcher runs registered in `core`/`scheduler`/`watchers`, four background pipelines register their own runs so `/agents` covers them:
- **`gardener_drain`** — `src/gardener/backlog.ts` `startBacklogRun` (manual/route-driven drain ONLY; the weekly watcher path calls `runGardener` directly and already has a `kind:"watcher"` run, so no double card). Mirrors the drain's `onProgress`/`shouldAbort` seams into the run (stage→phase, drafts n/m→`progress`, `cancelRequested`), `sourcePage="/wiki/gardener"`, completed in a `finally` covering success/cancel/throw. Additive to the existing 3s-poll strip.
- **`capture`** — `src/summaries/job-store.ts` `createJobStore` (ONE factory hook covers all four verticals: youtube / x-article / tiktok / anthropic). `createJob`→`startRequest` (name `"<label>: <title-or-url>"`, empty botName), `completeJob`/`failJob`/TTL-sweep→`completeRequest`.
- **`research`** — `src/research/ask.ts` `streamResearchAnswer` (covers both `/research` and wiki Ask). Phases mirror searching→synthesizing; completed in a `finally` (done + error/abort).
- **`extractor`** — `src/ai/haiku-extraction.ts` `doExtract` (the shared seam for memory/goals/schedule). Registered on entry, completed in a `finally` around the whole body — load-bearing because `doExtract` has a JSON-parse-failure early return that neither calls `onResult` nor throws (would otherwise leak). Do NOT register in `runExtractionPipelines`.

The dashboard renders this via SSE `/agent-status` (phase) and `/request-progress` (full waterfall); the UI component itself stays in `dashboard/views/components/agent-status-ui.ts`.

## Common Pitfalls

1. **Mutators are request-scoped**: `updatePhase`/`toolStart`/`toolEnd`/`setConnectorLabel`/`setModel`/`completeRequest`/`clearRequest` all take the `requestId` from `startRequest()` — passing the wrong id (or one already auto-cleared) is a silent no-op, so progress updates just vanish. Thread the id through; don't reach for a "current request".
2. **The phase-only singleton (`set`/`get`/`subscribe`) is still global**: it's a coarse "what is the bot doing right now" indicator, not per-request waterfall data, so concurrent requests *do* overwrite the phase text. That's intentional — the per-request `Map` carries the real progress.
3. **The waterfall UI is single-pane**: `getProgress()`/`subscribeProgress()` emit only the primary (most-recently-started) request. The data layer tracks all concurrent requests correctly, but the dashboard/chat overlay shows one at a time. A true multi-pane UI is a future, additive change — the data is already there.
4. **Keep these layer-neutral**: depend only on `db/`, `types.ts`, `logging.ts`, and `ai/` types — never import from `dashboard/`, `core/`, or platform handlers, or the upward-import smell returns.
