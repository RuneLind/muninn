# Chat Module — Architecture & Rules

## File Overview

| File | Role |
|---|---|
| `routes.ts` | Hono sub-router mounted at `/chat` — REST endpoints for conversations, threads, messages, reports, preferences. **`GET /chat/events`** is PR D's replacement for the operator stream: `agent_status` + `request_progress`, scoped by the same `?viewer=` guard, and NOTHING else — `/api/events` also replays 50 activity events with the full message text of every turn plus a process-wide `agent_runs` snapshot, and is now denied to role `user`. The conversation- and thread-addressed routes carry `requireOwnedResource` (`src/auth/resource-guard.ts`) BEFORE their side effect, answering the route's own "not found" expression so a denial and a miss are byte-identical; `GET /chat/conversations` carries `filterToOwner`. **`GET /chat/me`** answers `{mode, userId, displayName, navIdent, provider, role}` and is what the page branches on: `mode: "session"` means the server derives the id, `mode: "local"` means it does not. ⚠️ **That `"local"` is NOT `MUNINN_AUTH=local`** — it is the OPPOSITE, the auth-off case where the page still picks a user; `MUNINN_AUTH=local` is an authenticating mode and answers `"session"`. Every claimed-id route here is guarded by `requireOwnUser` (`src/auth/guard.ts`); the exceptions and the reasons are in `src/auth/claimed-id-inventory.txt`. `POST /conversations` branches on the type: a **`web`** conversation goes through `findOrCreateBotConversation` for the DETERMINISTIC id (`sha256("<userId>:<botName>:web")[0:16]`) — the id `hydrateFromDb` rebuilds it under and every off-band broadcaster computes — so a repeat POST returns the existing one; every other type still gets a random shell from `createConversation` |
| `state.ts` | `ChatState` singleton — in-memory conversation store with pub/sub event broadcasting |
| `processor.ts` | Bridges chat state to `message-processor` — builds callbacks (say, setStatus, onTextDelta) that write to state |
| `ws.ts` | Bun WebSocket handler — subscribes to ChatState events, sends JSON to connected clients. **Owner-scoped since PR D**: the opening snapshot and every event are filtered by `ws.data.userId` (`eventVisibleTo`), the identity resolved at the handshake by `src/auth/ws-upgrade.ts` and carried in by `wsDataFor`. `mcp_status` is delivered to everyone — no `conversationId`, no user data, and the inspector panel consumes it. `null` viewer = auth off = unfiltered, exactly as before. The socket is capped at the credential's `expiresAt` and closed with **4401** (the upgrade authenticates once, so without a cap a revoked session streams until the tab closes). The client's 4401 handling is MODE-CONDITIONAL since the entra PR — a reload on `entra` (the sidecar signs the reader back in), the historical static banner otherwise, since `local` has no login page. A REFUSED upgrade never reaches 4401 (the browser reports it as 1006), so the page probes `/chat/me` before retrying a socket that never opened. The expiry timer is clamped to `2**31-1` ms: over that, `setTimeout` fires immediately and every socket closes 4401 the moment it opens. |
| `chat-config.ts` | Chat user management via DB (ensureUser + ensureDefaultThread), config file migration |
| `pending-messages.ts` | Temporary in-memory store for research messages from Chrome extension (5min TTL, consumed once) |
| `views/page.ts` | Server-side HTML page generation for the chat UI  **Identity:** `loadSessionUser()` fetches `/chat/me` before anything else at init (one retry, then FAIL CLOSED — a failed fetch must not land in the same branch as auth-off, or one flaky request makes the page pick a user and call two admin-zone routes). With a session identity `loadUsersForBot` is skipped ENTIRELY — not just its `/api/users` fetch: it also issues `/chat/bot-preferences/:botName/default-user` and is what assigns `selectedUserId`/`selectedUsername` — the picker is hidden and `syncDefaultUser` writes nothing (the `bot_default_user` readers are answered by `pinnedLocalUserId()` server-side instead). `e2e/chat-session-identity.spec.ts` is the acceptance. |
| `views/components/` | `authed-fetch.ts` (the session-expiry seam: `window.authedFetch`, which EVERY fetch under `src/chat/views/` goes through — a unit test refuses a bare `fetch(` — plus the WebSocket and `EventSource` rules and the ONE breaker all three share. Three channels, three predicates: HTTP reloads on a 401 body whose `loginUrl` is the exported `LOGIN_URL_HINT`, the socket and SSE on the cached `provider === "entra"`, because neither can read a body — and a `null` provider (auth off, or `/chat/me` not yet answered) is IGNORED there rather than banner'd. At most one reload per 60 s, from a TIMESTAMP kept in `sessionStorage` **and** in memory (a storage that throws made the breaker inert), whose successful-`/chat/me` clear releases the per-channel LATCHES but is window-guarded for the stamp so it can never shorten the breaker. A channel that has spent a verdict is latched: the SSE reconnect used to re-enter the rule every 3 s and re-arm the breaker every 60 s. The banner is a fixed page-level bar, since `#chatMessages` is wiped on every thread switch), `chat-styles.ts` (CSS), `inspector-panel.ts` (inspector panel — pure helpers exported as TS + tested; DOM-touching functions returned as a JS string by `inspectorPanelScript()`), `inspector-panel-browser.ts` (browser entrypoint bundling the pure helpers onto `globalThis`), `inspector-panel-client.ts` (`makeBundledClientScript` wrapper, injected into the chat page before the CHAT_SCRIPT IIFE), `web-format-browser.ts` (browser entrypoint bundled into the chat page IIFE — exposes `formatWebHtml`/`renderSlackMrkdwn`/`sanitizeHtml` on `globalThis`), `web-format-client.ts` (`Bun.build` wrapper), `slack-mrkdwn.ts` (Slack mrkdwn renderer, shared by browser bundle and tests), `connector-selector.ts` (connector dropdown), `research-card.ts` (Jira research cards), `streaming-ui.ts` (streaming deltas, tool status, response meta), `thread-manager.ts` (thread CRUD, modal, sidebar), `knowledge-links.ts` (URL normalization, doc panel links), `jira-entry{,-pure,-browser,-client}.ts` (the «🧾 Lag Jira-sak» control on a finalized bot message → `POST /api/jira/draft/from-thread`; pure half bundled onto `globalThis`, DOM half injected into the CHAT_SCRIPT IIFE — rules in `src/dashboard/CLAUDE.md`'s Jira row), `jira-card{,-pure,-browser,-client}.ts` (the draft CARD the finished task lands in — see «The Jira draft card» below) |

## Architecture

### Two Event Channels

1. **WebSocket** (`ws.ts`): Chat messages, streaming text deltas, status updates, response metadata. Client connects once and receives a `snapshot` of all conversations, then live `ChatEvent` updates.
2. **SSE** (from dashboard): Waterfall/agent-status progress events for the request timeline overlay.

### Chat State (state.ts)

- `ChatState` class: conversations keyed by UUID, Map-based pub/sub to WebSocket subscribers.
- `ChatEvent` union type: `message`, `status`, `text_delta`, `stream_clear`, `intent`, `tool_status`, `response_meta`, `conversation_created`.
- Ephemeral events (`text_delta`, `intent`, `tool_status`) are broadcast-only — no state mutation.
- `hydrateFromDb()` loads persisted conversations on startup with deterministic IDs from (userId, botName, platform).
- `MAX_CONVERSATIONS` (50) caps how many conversations keep their MESSAGE HISTORY in memory — **shells are never evicted**. The cap used to delete the LRU shell, which was a permanent 404 for its owner and a silent write loss (`addMessage` returns early on a missing shell, and nothing can reconstruct a `crypto.randomUUID()` id). `trimHydratedMessages` now empties the LRU `messages` arrays instead; a trimmed conversation still resolves, still accepts writes, and reads its history from the DB.

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
| `state.test.ts` | Unit | ChatState pub/sub, conversation CRUD, LRU message trimming (shells survive the cap) |
| `ws.test.ts` | Unit | The socket's owner filter — acceptance 8's channel half. A `bun test` rather than an e2e spec ON PURPOSE: `MUNINN_AUTH=local` pins ONE identity per process, so a live server cannot be made to produce a second user's turn and the assertion would be vacuous there. Also `wsDataFor` (the upgrade → socket wiring) and the expiry cap |
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
   the WebSocket, so a status-only skip stranded it forever. A re-run mints its OWN
   row (this draft's `message_id` is stamped once and never moves), so the
   remaining message-id comparison — and the stray-card removal by draft id at
   attach time — are cheap defence rather than a live case. A settled
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

1. **Snapshot-before-subscribe**: `ws.ts` sends snapshot BEFORE subscribing to avoid missed events during the gap. Both halves are owner-filtered — filtering the live fan-out while shipping an unfiltered snapshot would close nothing, since the snapshot is the larger disclosure of the two.
2. **Status clearing**: Status is cleared in `processor.ts` finally block (not in the say callback) to avoid flickering during multi-chunk responses.
3. **Thread connector resolution**: Thread's connector overrides bot config — always check the full resolution chain when debugging unexpected model usage.
4. **Pending messages**: One-time consumption with 5min TTL — if the chat page doesn't poll in time, the message is lost.
