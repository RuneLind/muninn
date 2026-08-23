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
| `views/components/` | `chat-styles.ts` (CSS), `inspector-panel.ts` (inspector panel — pure helpers exported as TS + tested; DOM-touching functions returned as a JS string by `inspectorPanelScript()`), `inspector-panel-browser.ts` (browser entrypoint bundling the pure helpers onto `globalThis`), `inspector-panel-client.ts` (`makeBundledClientScript` wrapper, injected into the chat page before the CHAT_SCRIPT IIFE), `web-format-browser.ts` (browser entrypoint bundled into the chat page IIFE — exposes `formatWebHtml`/`renderSlackMrkdwn`/`sanitizeHtml` on `globalThis`), `web-format-client.ts` (`Bun.build` wrapper), `slack-mrkdwn.ts` (Slack mrkdwn renderer, shared by browser bundle and tests), `connector-selector.ts` (connector dropdown), `research-card.ts` (Jira research cards), `streaming-ui.ts` (streaming deltas, tool status, response meta), `thread-manager.ts` (thread CRUD, modal, sidebar), `knowledge-links.ts` (URL normalization, doc panel links), `jira-entry{,-pure,-browser,-client}.ts` (the «🧾 Lag Jira-sak» control on a finalized bot message → `POST /api/jira/draft/from-thread`; pure half bundled onto `globalThis`, DOM half injected into the CHAT_SCRIPT IIFE — rules in `src/dashboard/CLAUDE.md`'s Jira row), `jira-card{,-pure,-browser,-client}.ts` (the draft CARD the finished task lands in — see «The Jira draft card» below) |

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

## The Jira draft card

A Jira draft started with 🧾 runs as a real TURN in the thread, so its text
streams into the chat like any other reply. What the chat shows is the model's
RAW output, though, and the finalized task — fence stripped, `[n]` markers
repaired, `## Referanser` appended (`src/jira/finalize.ts`) — used to exist only
behind a hand-off to `/jira`. It is now delivered as a **card appended under the
bubble the draft came from** (`jira-card{,-pure,-browser,-client}.ts`, the
`jira-entry` quad pattern; CSS in `chat-styles.ts`). `/jira` stays reachable by
URL as the archive, and the 🧾 button no longer opens anything.

**`messages.text` is NEVER rewritten**, and that is the design, not a shortcut.
Patching the stored turn would mean the row stored in one encoding and displayed
in another, `## Referanser` polluting the model's own context on the next turn,
`seedThreadCitations`' cited-first signal reading the server's appended link list
as evidence the conversation used those sources, and a first write path that
mutates a stored turn. The card costs one extra read and none of that.

**The binding is one poller keyed on the DRAFT, never on "this tab clicked".** A
from-thread turn runs 60–600 s and broadcasts to every open tab, so reload,
second tab and switch-away-and-back are ordinary. On thread load, on thread
switch and on every `response_meta` for the active thread the client asks
`GET /api/jira/drafts?thread=<id>` (three fields per row: `{messageId, draftId,
status}`) and adopts what it finds. The clicking tab additionally SEEDS the loop
with the id its 200 returned — `from-thread` answers before the turn starts, and
the assistant message id does not exist until `response_meta` much later.

Three rules underneath it, each of which cost a defect:

1. **Every listed row is read ONCE via `GET /api/jira/draft/:id` on adopt.** The
   listing carries the binding and nothing else; `markdown`, `keyVerdicts`,
   `markdownFlags` and `savedAt` live on the view. Only the POLL LOOP is gated,
   on `generating`, or a null `messageId` on a row that is not `failed` (a failed
   run stamps no message and never will, so polling it was 13 minutes of reads
   answering the same thing) — gating the READ on in-flight-ness is what left a
   FINISHED draft with nothing to render after a reload. The skip on a later
   listing is keyed on `attached && status && messageId all unchanged`, not on
   the status alone: a row can go `ready` while its bubble is still arriving over
   the WebSocket, and a REGENERATE re-points `message_id` at the new turn while
   the status stays `ready` — a status-only skip stranded the first forever and
   left the second's card standing under the old bubble (the card left behind
   under the previous bubble is removed by draft id at attach time). A settled
   record whose bubble is simply offscreen is re-RENDERED rather than re-read,
   since every `response_meta` re-asks the listing.
2. **`attachJiraCard(messageId, draftId, view)` is its own idempotent function.**
   It cannot live inside `attachFeedbackControls`, which early-returns the moment
   a feedback row exists (`streaming-ui.ts`) — and the card arrives minutes after
   the row does. It resolves its host through `data-message-id`, which
   `attachFeedbackControls` stamps: the only messageId → DOM lookup in the page.
3. **`response_meta` resolves its bubble by id, never by position.** The server
   mints a throwaway client id for every bubble it renders
   (`ChatState.appendBotMessage`) and echoes the last one as
   `clientMessageId`; `appendMessage` stamps it as `data-client-id`. Picking "the
   last `.msg-bot`" is wrong whenever two turns are in flight in one thread —
   `sendMessage` has no in-flight guard and a reloaded tab cannot know a turn is
   running, so an ordinary message sent during a draft turn produced two metas
   that both resolved to whichever reply happened to be last, landing the draft's
   binding on an unrelated message. Replayed history stamps the DB ROW id into
   `data-client-id`, so a meta for such a turn is resolved by id too (a second
   lookup) — the positional fallback survives only for a meta whose bubble this
   tab never rendered, and it is refused outright when the last bubble already
   carries a DIFFERENT `data-message-id`. `attachFeedbackControls` likewise never
   overwrites one: the stamp used to run ahead of its own idempotency return.

The card renders the markdown with `sanitizeHtml(formatWebHtml(md), true)` — the
same pair every bot bubble and the `/jira` preview use, already in the page
bundle, so there is no second markdown pipeline and no server round-trip. The
second argument is not optional: the one-argument form selects the TELEGRAM tag
list and silently flattens every heading, list and table. **Kopier markdown
copies the RAW markdown**, byte for byte, because that is what the Jira editor
converts on paste. **Lagre** POSTs `{}` to `POST /api/jira/draft/:id/save`, which
stamps `saved_at` on a READY row (migration 072; an unfinished or failed row is a
409 — the gate rides the UPDATE, and the route re-reads to tell that apart from
an unknown id's 404) — that column is the only reason «Lagret»
survives a reload, and the card adopts the row the 200 returns rather than
drawing the state optimistically.

A **failed** card renders the row's reader-facing `error`, no Kopier, no Lagre,
and says the retry is another 🧾 click. Drafts no bubble can carry — no message
was ever recorded, or the message is outside the replayed history window — get
ONE thread-level notice linking `/jira?draft=<id>` rather than silence.

**Both card endpoints carry NO CORS headers**, unlike the CORS-open
`GET /api/jira/draft/:id` beside them: migration 070 accepts that a page could
read a draft id it GUESSES, and a thread-keyed listing hands over every id at
once. The save additionally **requires `application/json` (415 otherwise)** — a
body-less or `text/plain` POST is a CORS *simple* request that executes whatever
the response headers say, the same rule `from-thread` lives by.

## Common Pitfalls

1. **Snapshot-before-subscribe**: `ws.ts` sends snapshot BEFORE subscribing to avoid missed events during the gap.
2. **Status clearing**: Status is cleared in `processor.ts` finally block (not in the say callback) to avoid flickering during multi-chunk responses.
3. **Thread connector resolution**: Thread's connector overrides bot config — always check the full resolution chain when debugging unexpected model usage.
4. **Pending messages**: One-time consumption with 5min TTL — if the chat page doesn't poll in time, the message is lost.
