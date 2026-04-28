# Hivemind Module — Architecture & Rules

Phases 1, 2, and 3 of the integration plan in `docs/hivemind-integration-plan.md`.

## File Overview

| File | Role |
|---|---|
| `types.ts` | Subset of the claude-hivemind broker protocol (mirrored from `~/source/private/claude-hivemind/src/shared/types.ts`) |
| `config.ts` | Per-bot `hivemind` config block parser. Returns `null` unless `enabled: true` and at least one valid namespace is set. Knows `autoRespondPeers` + `maxAutoTurnsPerHour` (default 20). |
| `broker.ts` | `ensureBrokerRunning()` — health-checks `localhost:7899`, spawns `bun ~/source/private/claude-hivemind/src/broker.ts` if missing. Override path with `HIVEMIND_BROKER_SCRIPT`. |
| `client.ts` | `HivemindBotClient` — one WebSocket peer connection per bot. Handles register, set_summary, list_peers, send_message, heartbeat, reconnect with exponential backoff. |
| `mcp-server.ts` | `HivemindMcpServer` — single HTTP MCP server on port 9180 with per-bot URL paths (`/mcp/<botName>`). Exposes `list_peers`, `ask_peer`, `send_to_peer`. |
| `router.ts` | `HivemindRouter` — routes unsolicited inbound peer messages into `peer:<cwd-basename>` threads under the bot's default user. Phase 3: kicks off an autonomous bot turn for peers on the `autoRespondPeers` allowlist, gated by the loop guard, and relays the bot's reply back via `client.sendMessage`. |
| `loop-guard.ts` | `checkAutoRespond()` — hourly turn cap + already-paused check. Returns `{ allowed, reason?, capHit? }`; the router writes `auto_respond_paused=true` on cap hit. |
| `manager.ts` | `HivemindManager` singleton — boots one client per bot with `hivemind.enabled: true`, registers each with the MCP server, and wires `client.onIncomingMessage` into the router. Started from `src/index.ts` (passes the global `Config` through so the router can run a full bot turn). |

## Phase 1 scope

- Single namespace per bot — takes the **first** entry of `hivemind.namespaces`. Multi-namespace is Phase 4.
- Tools: `ask_peer` (blocking with timeout), `send_to_peer` (fire-and-forget), `list_peers`.
- Pending-ask resolution by FIFO queue per `from_id`. The first inbound message from peer X resolves the oldest pending `ask_peer(X, ...)`.
- No autonomous responses, no loop guards — those land in Phase 3 alongside autorespond.

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

## Bot setup

1. Add `hivemind` block to `bots/<name>/config.json`:
   ```json
   {
     "hivemind": {
       "enabled": true,
       "namespaces": ["private"],
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
