# Chat Module — Architecture & Rules

## File Overview

| File | Role |
|---|---|
| `routes.ts` | Hono sub-router mounted at `/chat` — REST endpoints for conversations, threads, messages, reports, preferences |
| `state.ts` | `ChatState` singleton — in-memory conversation store with pub/sub event broadcasting |
| `processor.ts` | Bridges chat state to `message-processor` — builds callbacks (say, setStatus, onTextDelta) that write to state |
| `ws.ts` | Bun WebSocket handler — subscribes to ChatState events, sends JSON to connected clients |
| `chat-config.ts` | Chat user management via DB (ensureUser + ensureDefaultThread), config file migration |
| `pending-messages.ts` | Temporary in-memory store for research messages from Chrome extension (5min TTL, consumed once) |
| `views/page.ts` | Server-side HTML page generation for the chat UI |
| `views/components/` | `chat-styles.ts` (CSS), `inspector-panel.ts` (inspector panel — pure helpers exported as TS + tested; DOM-touching functions returned as a JS string by `inspectorPanelScript()`), `inspector-panel-browser.ts` (browser entrypoint bundling the pure helpers onto `globalThis`), `inspector-panel-client.ts` (`makeBundledClientScript` wrapper, injected into the chat page before the CHAT_SCRIPT IIFE), `web-format-browser.ts` (browser entrypoint bundled into the chat page IIFE — exposes `formatWebHtml`/`renderSlackMrkdwn`/`sanitizeHtml` on `globalThis`), `web-format-client.ts` (`Bun.build` wrapper), `slack-mrkdwn.ts` (Slack mrkdwn renderer, shared by browser bundle and tests), `connector-selector.ts` (connector dropdown), `research-card.ts` (Jira research cards), `streaming-ui.ts` (streaming deltas, tool status, response meta), `thread-manager.ts` (thread CRUD, modal, sidebar), `knowledge-links.ts` (URL normalization, doc panel links) |

## Architecture

### Two Event Channels

1. **WebSocket** (`ws.ts`): Chat messages, streaming text deltas, status updates, response metadata. Client connects once and receives a `snapshot` of all conversations, then live `ChatEvent` updates.
2. **SSE** (from dashboard): Waterfall/agent-status progress events for the request timeline overlay.

### Chat State (state.ts)

- `ChatState` class: conversations keyed by UUID, Map-based pub/sub to WebSocket subscribers.
- `ChatEvent` union type: `message`, `status`, `text_delta`, `stream_clear`, `intent`, `tool_status`, `response_meta`, `conversation_created`.
- Ephemeral events (`text_delta`, `intent`, `tool_status`) are broadcast-only — no state mutation.
- `hydrateFromDb()` loads persisted conversations on startup with deterministic IDs from (userId, botName, platform).
- Max 50 conversations in memory (`MAX_CONVERSATIONS`), auto-prunes oldest.

### Message Processing (processor.ts)

- `processChatMessage()` is the bridge between chat and the core AI pipeline.
- Creates `say`, `setStatus`, `onTextDelta`, `onIntent`, `onToolStatus` callbacks that write to ChatState.
- Connector resolution priority: thread connector > inline override > bot config.json.
- All web chat messages are stored with platform `"web"` regardless of original conversation type.
- For Slack conversations, gathers last 15 messages as channel context and provides `postToChannel` callback.

## Web Format

Bot responses are formatted via `formatWebHtml()` from `src/web/web-format.ts` (server-side). The chat page also calls `formatWebHtml()` for streaming text deltas — but it imports the SAME function via `views/components/web-format-browser.ts`, which is bundled by `Bun.build()` (see `web-format-client.ts`) and injected into the page's inline `<script>` as a self-contained IIFE that attaches `formatWebHtml`, `renderSlackMrkdwn`, and `sanitizeHtml` to `globalThis`. There is no manual port to keep in sync.

## ConversationType

Five types: `telegram_dm`, `slack_dm`, `slack_channel`, `slack_assistant`, `web`. Mapped to DB platform strings via `conversationTypeToPlatform()`.

## Testing

| File | Type | What it tests |
|---|---|---|
| `state.test.ts` | Unit | ChatState pub/sub, conversation CRUD, max limit pruning |
| `chat-config.test.ts` | Unit | User loading, config file migration |
| `pending-messages.test.ts` | Unit | Set/consume/expire pending messages |
| `integration.test.ts` | Integration | Full round-trip with real Claude (slow, requires API key) |

## Common Pitfalls

1. **Snapshot-before-subscribe**: `ws.ts` sends snapshot BEFORE subscribing to avoid missed events during the gap.
2. **Status clearing**: Status is cleared in `processor.ts` finally block (not in the say callback) to avoid flickering during multi-chunk responses.
3. **Thread connector resolution**: Thread's connector overrides bot config — always check the full resolution chain when debugging unexpected model usage.
4. **Pending messages**: One-time consumption with 5min TTL — if the chat page doesn't poll in time, the message is lost.
