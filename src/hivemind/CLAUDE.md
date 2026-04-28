# Hivemind Module — Architecture & Rules

Phase 1 implementation of the integration plan in `docs/hivemind-integration-plan.md`.

## File Overview

| File | Role |
|---|---|
| `types.ts` | Subset of the claude-hivemind broker protocol (mirrored from `~/source/private/claude-hivemind/src/shared/types.ts`) |
| `config.ts` | Per-bot `hivemind` config block parser. Returns `null` unless `enabled: true` and at least one valid namespace is set. |
| `broker.ts` | `ensureBrokerRunning()` — health-checks `localhost:7899`, spawns `bun ~/source/private/claude-hivemind/src/broker.ts` if missing. Override path with `HIVEMIND_BROKER_SCRIPT`. |
| `client.ts` | `HivemindBotClient` — one WebSocket peer connection per bot. Handles register, set_summary, list_peers, send_message, heartbeat, reconnect with exponential backoff. |
| `mcp-server.ts` | `HivemindMcpServer` — single HTTP MCP server on port 9180 with per-bot URL paths (`/mcp/<botName>`). Exposes `list_peers`, `ask_peer`, `send_to_peer`. |
| `manager.ts` | `HivemindManager` singleton — boots one client per bot with `hivemind.enabled: true`, registers each with the MCP server. Started from `src/index.ts`. |

## Phase 1 scope

- Single namespace per bot — takes the **first** entry of `hivemind.namespaces`. Multi-namespace is Phase 4.
- Tools: `ask_peer` (blocking with timeout), `send_to_peer` (fire-and-forget), `list_peers`.
- Pending-ask resolution by FIFO queue per `from_id`. The first inbound message from peer X resolves the oldest pending `ask_peer(X, ...)`.
- No inbound threading. Messages arriving with no pending ask are logged and dispatched to `onIncomingMessage` callback (unwired in Phase 1; Phase 2 will route to a `peer:<name>` chat thread).
- No autonomous responses, no loop guards — those land in Phase 3 alongside autorespond.

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
4. **Tests use a stub broker.** `client.test.ts` spins up a mini WebSocket server on a random port and uses `brokerPort` injection. Don't accidentally run tests against the real broker.
