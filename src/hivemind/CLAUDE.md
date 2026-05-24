# Hivemind Module — Architecture & Rules

Phases 1, 2, 3, and 4 of the integration plan in `docs/hivemind-integration-plan.md`.

## File Overview

| File | Role |
|---|---|
| `types.ts` | Subset of the claude-hivemind broker protocol (mirrored from `~/source/private/claude-hivemind/src/shared/types.ts`) |
| `config.ts` | Per-bot `hivemind` config block parser. Returns `null` unless `enabled: true` and at least one valid namespace is set. Knows `autoRespondPeers` + `maxAutoTurnsPerHour` (default 20). |
| `broker.ts` | `ensureBrokerRunning()` — health-checks `localhost:7899`, spawns `bun ~/source/private/claude-hivemind/src/broker.ts` if missing. Override path with `HIVEMIND_BROKER_SCRIPT`. |
| `client.ts` | `HivemindBotClient` — one WebSocket peer connection per (bot, namespace). Handles register, set_summary, list_peers, send_message, heartbeat, reconnect with exponential backoff. Inbound messages carry the client's `namespace`. |
| `mcp-server.ts` | `HivemindMcpServer` — single HTTP MCP server on port 9180 with per-bot URL paths (`/mcp/<botName>`). `BotClientRegistry` holds one `HivemindBotClient` per joined namespace plus `peer_id → namespace` and `peer_id → {cwd,summary}` caches, both populated from every `list_peers` response. Exposes `list_peers` (cross-namespace), `ask_peer`, `send_to_peer`, and `delegate_task` (spec-driven dev loop — see below). `registry.peerNameFor(peerId)` derives the stable `peer_name` from the cwd cache via the shared `peer-name.ts`. |
| `peer-name.ts` | `peerNameFor({fromCwd, fromSummary, fromId})` — the single derivation of a peer's stable name (cwd-basename → summary-slug → `peer-<id8>`). Shared by the router (inbound thread naming + autorespond allowlist) and `delegate_task` (handoff recording) so both sides of the `(run_id, peer_name)` join agree. `router.ts` re-exports it for back-compat. |
| `router.ts` | `HivemindRouter` — routes unsolicited inbound peer messages. Resolves peer-reply correlation **token-first** (echoed `correlation_id` → `correlation-tokens.ts`), then the `(botName, peerId)` fallback (`correlation.ts`), and routes the reply to the originating thread **regardless of which user owns it** (the destination user is derived from that thread, not the bot default user). Only uncorrelated inbound falls back to `peer:<namespace>/<cwd-basename>` threads under the bot's default user. Stale correlations (deleted/other-bot thread) are lazily cleared on both paths. Autorespond echoes the inbound `correlation_id` verbatim and looks up `getClient(botName, namespace)` so the outbound relay goes through the same WS the inbound came in on. **After persist/broadcast** it also fires the Phase-4 handoff interpreter fire-and-forget (`pendingHandoffInterpret`, the same test-only seam as `pendingAutorespond`). `parsePeerThreadName` and `peerThreadNameFor` helpers expose the format. |
| `handoff-interpreter.ts` | **Phase 4 inbound interpreter** — `interpretHandoffReply` turns a peer's `<!-- status/e2e: … run:<id> -->` reply into dev_run state, OFF the delivery path. `parseHandoffMarker` (last marker wins) → `resolveRun` (8-hex prefix, with the >1-collision fallbacks) → `updateHandoffStatus` on `(run_id, peer_name)` → recompute + persist `dev_run.status`. On a green orchestrate verdict it CI-confirms before flipping the spec (`setFrontmatterStatus`/`flipSpecToVerified`). See "Spec-driven dev loop — Phase 4" below. |
| `ci-conclusion.ts` | `fetchCiConclusion(url)` via the `gh` CLI (`gh run view <id> --repo <o/r> --json conclusion,status`) + `parseGithubRunUrl` + `isConfirmedGreen` (completed ∧ success). The green gate's "verify, don't trust" step. Injectable `GhRunner` for tests; every failure mode returns null → gate stays closed. |
| `loop-guard.ts` | `checkAutoRespond()` — hourly turn cap + already-paused check. Returns `{ allowed, reason?, capHit? }`; the router writes `auto_respond_paused=true` on cap hit. |
| `active-turn.ts` | Per-bot LIFO stack of in-flight chat turns. `processMessage` pushes the originating `threadId` before the connector runs and pops in `finally`. MCP tool handlers `peek` it to find the originating thread for outbound `ask_peer`/`send_to_peer`. Concurrent turns on one bot race (last push wins) — acceptable for the typical single-user-per-bot case. |
| `correlation.ts` | DB-backed `(botName, peerId) → threadId` map (`peer_thread_correlation` table, migration 039) with `PEER_CORRELATION_TTL_MS` TTL (7 days, `config.ts`). Async API. Set on every outbound (MCP tools, chat `>`, autorespond reply); read by `router.route()` so inbound peer replies route back to the originating thread instead of the default `peer:<ns>/<name>` bucket. **Now the un-echoed fallback** under the precise token path (`correlation-tokens.ts`). Last-write-wins per peer. Persisted — survives muninn restarts (frequent under `--watch`) and peers that take a long time to reply. DB errors degrade gracefully to the default thread. No FK on `thread_id`; the router validates the thread and lazily clears stale rows. |
| `correlation-tokens.ts` | **Precise** peer-reply correlation via opaque minted tokens (`peer_correlation_tokens` table, migration 040, same TTL). An *initiating* outbound mints a random `correlation_id`, stores `token → originating thread`, and puts it on the wire; the peer's reply echoes it and `router.route()` resolves the exact thread — so two concurrent outbounds to the same peer don't collide (the last-write-wins flaw of `correlation.ts`). One row per outbound, so `setCorrelationToken` sweeps expired rows opportunistically on insert. Effective only once the broker round-trips `correlation_id` (rollout: broker ships first); until then every reply has no token → falls back to `correlation.ts` = today's behavior. Set-vs-echo rule: **initiating → mint+store** (`mcp-server.ts`, chat `>`); **replying → echo verbatim** (autorespond, `router.ts`). |
| `manager.ts` | `HivemindManager` singleton — boots one `HivemindBotClient` per `(bot, namespace)` pair. `getClient(botName, namespace)` returns the namespace-specific client (or null); `getAnyClient(botName)` is the explicit fallback for paths that don't know the namespace (only used by chat `>` outbound for legacy unmigrated peer threads). Started from `src/index.ts`. |

## Phase 1 scope

- Single namespace per bot — takes the **first** entry of `hivemind.namespaces`. Multi-namespace lands in Phase 4.
- Tools: `ask_peer` (blocking with timeout), `send_to_peer` (fire-and-forget), `list_peers`.
- Pending-ask resolution by FIFO queue per `from_id`. The first inbound message from peer X resolves the oldest pending `ask_peer(X, ...)`.
- No autonomous responses, no loop guards — those land in Phase 3 alongside autorespond.

## Phase 4 scope

- **Multi-namespace per bot.** Manager iterates `hivemind.namespaces` and opens one
  `HivemindBotClient` per `(bot, namespace)` pair.
- **Namespace plumbed end-to-end.** `client.onIncomingMessage` carries the
  client's `namespace`; the router uses it to (a) compute the thread name
  `peer:<namespace>/<cwd-basename>` and (b) pick the right outbound client for
  autorespond replies.
- **`peer_id → namespace` cache.** Lives on `BotClientRegistry` in
  `mcp-server.ts`; populated from every `list_peers` response. `ask_peer` /
  `send_to_peer` look the cache up and pick the matching client; cache miss
  falls back to the first registered client + warn.
- **`list_peers(namespace?)`.** Default lists peers across all of the bot's
  joined namespaces; explicit `namespace` filters to one.
- **Manual outbound from chat.** `>...` text-prefix in a `peer:<ns>/<name>`
  thread parses the namespace via `parsePeerThreadName` and calls
  `getClient(botName, ns)` so the reply goes through the inbound WS.
- **Migration 037.** Backfills existing `peer:<name>` thread rows to
  `peer:private/<name>` (Phase 1+2+3 traffic was all on `private`).

## Phase 2 scope (this revision)

- **Inbound peer threading.** Unsolicited messages (or async replies that arrive
  after `ask_peer` has timed out) are routed to a `peer:<cwd-basename>` thread
  under the bot's default user (`bot_default_user` table). Persisted in
  `messages` with `role='peer'` and `from_peer_id` set to the broker's
  per-session UUID.
- **Stable thread naming.** Thread name uses the peer's `from_cwd` basename so
  the same long-running conversation lands in the same thread when the peer
  reconnects (the `from_id` UUID rotates per session). Falls back to a slug of
  `from_summary`, then to a prefix of `from_id`.
- **Chat UI surfacing.** Peer threads appear in the existing thread sidebar with
  a 📡 icon. Messages render with a `[from <peer-name>]` prefix and a distinct
  accent-tinted bubble.
- **Manual outbound from chat.** In a `peer:<name>` thread, a chat message that
  starts with `>` is sent directly to the peer via the bot's
  `HivemindBotClient.sendMessage()` instead of the connector. The recipient is
  the most recent peer that spoke in that thread (looked up via
  `getMostRecentPeerIdForThread`). The leading `>` and an optional next token
  are stripped before send.
- **No autorespond yet.** Peer messages surface in the UI but the bot does not
  auto-reply. Phase 3 adds `autoRespondPeers` + loop guards.

## Phase 3 scope

- **Allowlist autorespond.** Bot config grows an `autoRespondPeers: string[]`
  (peer names matching `peerNameFor()` output — typically `from_cwd`'s
  basename). Inbound messages from listed peers run the bot's normal
  prompt-builder + connector pipeline (`processMessage` from
  `core/message-processor.ts` with `skipUserSave: true` so the inbound peer
  message is the only persisted copy of the trigger). The bot's response is
  saved as `role='assistant'` in the same `peer:<name>` thread *and* relayed
  back to the originating peer via `HivemindBotClient.sendMessage`.
- **Loop guards.** `loop-guard.ts` enforces a rolling-hour cap on assistant
  turns per peer thread (`maxAutoTurnsPerHour`, default 20). When the cap is
  hit the router persists `auto_respond_paused=true` + `pause_reason` on the
  thread row (migration 036) and skips further autorespond until manually
  unpaused. We deliberately did **not** add a token budget — per-turn cost is
  already bounded by the connector's `contextWindow` and `thinkingMaxTokens`,
  and the hourly cap caps cumulative cost to a known ceiling. Add a token
  budget later if real-world traffic needs one.
- **Trace emission.** Each autorespond cycle creates a new `Tracer` rooted at
  `hivemind_autorespond` with point-in-time `peer_inbound` and `peer_outbound`
  events, so the waterfall view shows the full agent-to-agent chain. The
  tracer is passed to `processMessage` so the connector + DB spans nest under
  the same trace.
- **Kill switch.** `PATCH /chat/threads/:id/auto-respond { paused, reason? }`
  flips `auto_respond_paused`; manual unpause (`paused: false`) clears
  `pause_reason`. The chat header renders an "Auto-respond: ON / PAUSED"
  pill on peer threads (click to toggle); paused peer threads in the
  sidebar render with a ⏸ icon and muted styling.

## Spec-driven dev loop — `delegate_task` (Phase 2)

`delegate_task` is `send_to_peer` plus structured run tracking. Used to hand a
workplan/spec/e2e to a build/test/orchestrate peer and record the handoff against
the originating research thread's `dev_run` (see `src/db/dev-runs.ts`,
`mimir/plans/muninn-spec-driven-dev-loop.md`).

- **Signature:** `{ to, message, role, issueKey? }`. `role ∈ build|test|orchestrate|review`.
- **Run resolution is by ORIGIN THREAD, never the LLM-supplied `issueKey`.** It
  reads `peekActiveTurn(botName)` (the same thread `bindOutboundToOriginThread`
  peeks) and `getDevRunByThreadId`. Chat-started research has a synthetic
  `research-<8hex>` issue_key the model can't reproduce, so joining on `issueKey`
  would fork a second run. `issueKey` is a non-authoritative display stamp; `role`
  is persisted on the handoff.
- **In-marker `run:<id>` is the authoritative join, not the broker token.**
  `runMarkerInstruction` appends an instruction telling the peer to end its reply
  with `<!-- status: done|failed run:<id> -->` (build/test/review) or
  `<!-- e2e: green|red run:<id> -->` (orchestrate). The id is the **first 8 hex**
  of the run uuid (`shortRunId`) — autonomous peers truncate long uuids
  (Phase 1.5), so keep it short; **Phase 4's inbound parser resolves it back to a
  `dev_run` by prefix match**, then `(run_id, peer_name)` picks the role's handoff.
  This rides in the message body the agent controls, so it survives even when the
  broker correlation token isn't echoed (raw peers, multi-in-flight). **Phase 4
  caveat:** 8 hex is 32 bits, so the prefix is NOT collision-proof — the inbound
  resolver must handle >1 matching `dev_run` (fall back to the correlation token,
  or pick the most-recently-updated open run), not assume a unique match. Don't
  lengthen the id without re-checking peers still echo it verbatim.
- **`peer_name` = cwd-basename via the shared `peer-name.ts`.** Derived from the
  `list_peers` cwd cache, identical to the router's inbound naming, so the handoff
  row and the peer's reply agree on the name.
- **Still mints the correlation token + writes the `(bot,peer)` fallback** (same
  as `send_to_peer`) so the legacy reply path keeps working alongside the marker.
- **No dev_run for the thread → sends plain, records nothing** (delegating outside
  a research run is allowed, just untracked). A handoff-insert failure does not
  fail the send. Core logic is the exported `runDelegateTask` (DB-tested).

## Spec-driven dev loop — inbound interpreter + green gate (Phase 4)

`handoff-interpreter.ts` closes the loop `delegate_task` opens: when a build/test/
orchestrate peer replies with its marker, the run rolls up. It runs in
`router.route()` **off the delivery path** (`pendingHandoffInterpret`, fire-and-
forget after persist/broadcast) so a parse error can never block inbound delivery.

- **Marker parse (`parseHandoffMarker`).** Matches `<!-- status: done|failed run:<id> -->`
  (build/test/review) and `<!-- e2e: green|red run:<id> -->` (orchestrate),
  tolerant of whitespace/case and an id 4–32 hex long. **Last marker wins** (a peer
  may quote an earlier one). No marker → `{matched:false}`, the common case for
  ordinary chatter, and the interpreter no-ops.
- **Run resolution (`resolveRun`) — the 8-hex prefix is NOT unique.** `run:<id>` is
  the first 8 hex of the run uuid (`shortRunId`), only 32 bits, so a prefix can
  match >1 `dev_run` (`getDevRunsByIdPrefix`). Disambiguation, in order: (1) exactly
  one match → use it; (2) several → prefer the match whose `thread_id` is the
  **routed thread** (the router already resolved it token-first, then `(bot,peer)`,
  so it encodes the right conversation), else the **most-recently-updated open run**,
  else the newest overall; (3) no prefix / no prefix match → fall back to the routed
  thread's run (`getDevRunByThreadId`). The routed thread IS the correlation-token
  fallback — the interpreter doesn't re-resolve tokens.
- **Handoff update — the `(run_id, peer_name)` join.** `verdictToHandoffStatus`
  maps `done`/`green`→`done`, `failed`/`red`→`failed`; `updateHandoffStatus` updates
  the role's row where `peer_name` = the inbound `peerNameFor(msg)`. A **0-row update**
  means the join missed (the cwd-cache-cold `peer_name` drift `delegate_task` warns
  about) → logged, run won't roll up. Then `computeRunStatus` is recomputed and
  **persisted** onto `dev_run.status` (Phase 5 / the next chat turn renders off it).
- **Dependency gate parks (v1).** build ∧ test done → `computeRunStatus` returns
  `ready_to_verify`; the interpreter persists that and **stops** — the gate is hit in
  the inbound router where there's no active turn, so the orchestrate confirm renders
  off `dev_run.status` on the user's next chat turn. Auto-firing orchestrate is v2
  (the `maybeAutorespond` code-triggered turn).
- **Green gate — verify, don't trust (`ci-conclusion.ts`).** `status: verified` is the
  one assertion humans take at face value, so a green orchestrate verdict is NOT
  enough: pull the GitHub run URL from the reply (`parseGithubRunUrl`), fetch the
  conclusion via the **`gh` CLI** (`fetchCiConclusion` → `gh run view`), and flip the
  spec to `verified` (`flipSpecToVerified`, rewrites the leading-frontmatter
  `status:`) + set `dev_run.status = green` only when `isConfirmedGreen` (completed ∧
  success). No CI URL, in-progress, or non-success → `dev_run.status = verifying`,
  spec untouched. Every CI-fetch failure mode returns null → gate stays closed.
- **Stale-handoff detection.** `listStaleHandoffs(thresholdMs)` (`src/db/dev-runs.ts`,
  default `STALE_HANDOFF_THRESHOLD_MS` = 6h) finds pending (`sent`/`working`) handoffs
  past the threshold on non-terminal runs — a peer that accepted then died parks the
  run forever (the 7-day TTL is on correlation tokens, not handoffs). The detection
  primitive lands here; the periodic sweep + manual re-send affordance are Phase 5 UI.
- **Tests run under `bun run test:hivemind`** (`handoff-interpreter.test.ts`,
  `ci-conclusion.test.ts`, router wiring in `router.test.ts`); the dev-runs DB helpers
  are in the main `bun run test` (`src/db/dev-runs.test.ts`). `gh` and file I/O are
  injectable, so no live CLI / real spec files in tests.

## Spec-driven dev loop — auto-advance (Phase 6, v2)

Turns v1's "park and wait for the user" into an autonomous loop. Both behaviors
trip in `router.route()`'s interpret `.then` (no active turn there) and fire a
**code-triggered bot turn** on the research thread — the bot's own `delegate_task`
does the outbound, so all of v1's handoff machinery (insert row, `run:<id>` marker,
correlation, green gate, terminal guard) is reused unchanged. Both are **per-bot
opt-in, default off** (`hivemind.devLoop`); off ⇒ v1 (park + confirm) stands. The
prompts live server-side in `devloop-prompts.ts` (the interpreter has no browser).
The slow turn runs as `pendingAdvanceRun` (test-only seam, await it after
`pendingHandoffInterpret`).

- **6a — auto-fire orchestrate** (`autoOrchestrate`). On `ready_to_verify`,
  `claimAutoOrchestrate` does an atomic CAS (`claimForVerify`: `ready_to_verify →
  verifying`) **before the broadcast** — the claim is the once-per-run guard AND
  closes the manual/auto double-delegate race (an open tab never sees the confirm
  button for a run we're about to advance). `runAutoOrchestrate` then fires the
  orchestrate turn (compensating revert recomputes status on a thrown turn so the
  run isn't wedged at `verifying`). The interpreter persists status through
  `persistRunStatus` (no-downgrade guard: a duplicate/late build|test marker can't
  re-open a claimed `verifying`/terminal run and re-fire). No hourly loop-guard —
  the CAS bounds it to once per run.
- **6b — re-engage build on red** (`autoReengageOnRed`). On `red`,
  `claimAutoReengage`: (1) **scope gate — RED E2E ONLY.** Fires only when a
  `failed` orchestrate handoff exists (the cross-repo e2e ran and failed). A
  build-/test-phase red (a `failed` build/test row, no orchestrate) PARKS for the
  user — the build-first cut can't safely target it (clearing orchestrate wouldn't
  remove the failed row, so `computeRunStatus` would stay red and the run would
  burn the cap for nothing; a test failure isn't build's to fix anyway). (2)
  **hourly backstop** (`checkAutoRespond` on the research thread — defence in
  depth; a manual pause or the cap skips, leaving the run red — note: the default
  20/hr won't block normal research, and a skip leaves the run plainly `red`). (3)
  **atomic claim + cap** (`claimForReengage`: CAS-increments `reengage_count` and
  re-opens `red → building` only while `status='red' AND reengage_count <
  MAX_REENGAGE_ATTEMPTS` — the `status='red'` guard makes a flapping red
  idempotent, the count is the loop terminator). (4) **reset** — capture the
  failure context (CI URL + the e2e agent's reply) from the orchestrate handoff
  BEFORE clearing it, then `clearOrchestrateHandoffs` so the run rolls back to
  `ready_to_verify` once the re-fixed build reports done (a fresh e2e re-runs).
  `buildReengageContext` names the MOST RECENT build peer (handoffs are created_at
  ASC; a re-engaged run accumulates build rows). `runAutoReengage` fires a build
  re-engage turn (`buildReengagePrompt`, always build — the Haiku build-vs-test
  classifier is the follow-up); compensating recompute on a thrown turn.
  **Re-opening to `building` is load-bearing** — the interpreter's terminal guard
  ignores replies on a `red` run, so the loop can only continue off terminal. At
  the cap the claim returns null, the run stays `red`, and the run card surfaces an
  "auto-re-engage exhausted — needs you" note (`reengageCount >=
  MAX_REENGAGE_ATTEMPTS`, mirrored client-side in `research-card.ts`). The two
  flags compose: a re-engaged build that lands done → `ready_to_verify` → 6a (if
  on) re-fires the e2e. **Migration 042** adds `dev_runs.reengage_count` (default
  0 — no backfill).
  - **Known bounded limitations (first cut):** (a) a duplicate/late build|test
    `done` marker arriving in the brief window between the claim (status `building`,
    build∧test still done, orchestrate cleared) and the re-engage turn's
    `delegate_task` can recompute `ready_to_verify` and, with 6a on, re-fire the
    e2e against not-yet-re-fixed code — wasteful but self-correcting (it reds again
    → re-engage, bounded by the cap). (b) Re-delegating the fix to a DIFFERENT
    build peer (original offline) leaves the original build row in place; the
    same-peer path (the prompt's preference) rolls up cleanly via the
    `(run_id, peer_name)` join. (c) Like 6a, if the bot's turn succeeds but it
    never calls `delegate_task`, no handoff is inserted and the run sits at
    `building` with no reply to roll it up (the shared "trust the turn to delegate"
    risk of the code-triggered pattern).

## Bot setup

1. Add `hivemind` block to `bots/<name>/config.json`. Use a single namespace
   for project-local peers, or multiple to bridge into another namespace
   (e.g. `nav`):
   ```json
   {
     "hivemind": {
       "enabled": true,
       "namespaces": ["private", "nav"],
       "summary": "Melosys — analyzes Jira, asks peers for help"
     }
   }
   ```
2. Add MCP entry to `bots/<name>/.mcp.json`:
   ```json
   {
     "mcpServers": {
       "hivemind": { "type": "http", "url": "http://127.0.0.1:9180/mcp/<botName>" }
     }
   }
   ```
3. Restart Muninn. The manager auto-starts the broker if not running.

## Common pitfalls

1. **Broker script path.** The auto-start assumes `~/source/private/claude-hivemind/src/broker.ts`. Set `HIVEMIND_BROKER_SCRIPT` if your install lives elsewhere.
2. **Port collisions.** MCP server uses 9180. Serena tool-proxy uses 9120, instances 9121+. Don't drop hivemind below that range.
3. **FIFO ask matching.** Two concurrent `ask_peer` calls to the same peer match replies in send order — there's no correlation ID in the broker protocol. Don't rely on content matching.
4. **Tests use a stub broker.** `client.test.ts` spins up a mini WebSocket server on a random port and uses `brokerPort` injection. Don't accidentally run tests against the real broker. `router.test.ts` uses the real test DB — run `bun run db:setup:test` after schema changes.
5. **Bot needs a default user for inbound routing.** The router drops inbound peer messages when `bot_default_user.user_id` is unset for that bot — there's no thread to attach the message to. Set one via the chat page or `PUT /chat/bot-preferences/<bot>/default-user`.
6. **Peer thread name is cwd-derived, not id-derived.** Phase 2 uses `peer:<cwd-basename>` rather than `peer:<from_id>` because broker peer IDs rotate per session. Don't switch to `from_id` without designing for thread fragmentation across reconnects.
7. **Autorespond is fire-and-forget.** `HivemindRouter.route` returns once the inbound message is persisted; the bot turn runs in the background. Tests can await `router.pendingAutorespond` to settle the in-flight promise. Don't await it from production callers — it's a test-only seam.
8. **`processMessage` injection in tests.** `AutorespondDeps.processMessage` is an optional override so router tests can stub the AI pipeline. Production wires `defaultProcessMessage`. If you change `ProcessMessageParams`, check both call sites.
9. **Cap hit auto-pauses.** Once `maxAutoTurnsPerHour` trips, `auto_respond_paused` stays true until the user manually unpauses via the chat-header pill. The cap reset is implicit (older assistant turns roll out of the hour), so a paused thread won't auto-resume.
10. **Peer thread name encodes namespace.** Thread names are `peer:<namespace>/<cwd-basename>` post-Phase-4. Don't grep for literal `peer:huginn` — use `parsePeerThreadName` to split. Migration 037 backfilled all pre-Phase-4 rows to `peer:private/<name>`.
11. **`peer_id → namespace` cache is warmed by `list_peers`.** `ask_peer`/`send_to_peer` rely on the bot calling `list_peers` first. Cache miss falls back to the first registered client + a warn — recoverable but not free, so keep `list_peers` in the persona's prescribed flow.
12. **Sidebar UI hides the `<ns>/` prefix when the bot has only one configured namespace.** That decision is driven by `bots[].hivemindNamespaceCount` in the `/chat/bots` response — don't change the field name without updating `thread-manager.ts`/`page.ts`.
13. **Peer-reply correlation: precise token path + `(bot,peer)` fallback.** Each outbound now mints an opaque `correlation_id` bound to the originating thread (`correlation-tokens.ts`); when the peer's reply echoes it, `router.route()` resolves the *exact* thread, so two concurrent outbounds to the same peer no longer collide. This is **gated on the broker round-tripping `correlation_id`** (rollout: broker ships first) and on the reply side echoing it — guaranteed muninn↔muninn (autorespond echoes verbatim), best-effort for raw peers (the broker/`server.ts` auto-echo is single-in-flight). When a reply carries **no** token (raw peer that didn't echo, or pre-broker-rollout), it falls back to the `(botName, peerId)` table (`correlation.ts`), which is still last-write-wins: two concurrent turns on the *same* bot share one `active-turn` stack (last `peek` wins). Rare in practice (typically one user per bot). The `active-turn` LIFO race is orthogonal and unchanged; `?turn=<token>` per MCP session remains the optional polish for the outbound-recording side. See `mimir/plans/claude-hivemind-reply-correlation.md` for the full design.
