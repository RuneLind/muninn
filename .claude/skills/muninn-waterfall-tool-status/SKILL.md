---
description: "How the web chat waterfall, tool status, and request progress system works in Muninn. Use when: (1) Debugging why the waterfall shows or doesn't show for a bot, (2) Modifying how tool calls are displayed inline or in the waterfall, (3) Working with the showWaterfall config flag or window._suppressWaterfall, (4) Adding new tool status mappings in tool-status.ts, (5) Debugging why tool use disappears on page refresh, (6) Understanding SSE vs WebSocket event flow in the chat page, (7) Working with request progress tracking (agentStatus), (8) Modifying how traces link to messages for persistent tool history, (9) Understanding the intermediate element lifecycle (intent bubbles, tool status lines, streaming bubbles). Triggers: 'waterfall', 'showWaterfall', 'tool status', 'request progress', 'agentStatus', 'SSE events', 'tool_status event', 'intent bubble', 'removeIntermediates', 'msg-intermediate', 'msg-tool-status', 'trace_id', 'loadToolCallsFromTrace', '_suppressWaterfall', 'request_progress', 'tool calls disappear', 'waterfall panel'."
---

# Muninn Waterfall & Tool Status System

This skill covers the request progress tracking pipeline — from AI connector output through to browser rendering. The system has two parallel display paths (waterfall panel via SSE, inline tool status via WebSocket) and a persistence layer (traces) for surviving page refresh.

## 1. Two Event Channels: SSE vs WebSocket

The chat page uses two separate event channels for different purposes. Confusing them causes bugs.

```
Server                          Browser (chat page)
  │
  ├── SSE (/api/events) ──────► Waterfall panel (request_progress)
  │     Global, all clients      Agent status bar (agent_status)
  │     Sends initial state       ← Used for progress visualization
  │     on connect
  │
  └── WebSocket (/chat/ws) ───► Chat messages (message, text_delta)
        Per-conversation          Intent bubbles (intent)
        No initial replay         Tool status lines (tool_status)
                                  ← Used for inline chat display
```

### Why two channels matter

- **SSE** sends cached state on connect — on page refresh you get the last `request_progress`. This powers the waterfall.
- **WebSocket** is ephemeral — events are only received while connected. On refresh, all intent/tool_status events are lost.
- This is why tool use lines disappear on refresh: they came via WebSocket and were never stored. The `trace_id` persistence layer (section 5) addresses this.

## 2. Request Progress Data Flow

The full pipeline from AI connector to browser:

```
AI Connector (claude-cli, copilot-sdk, openai-compat)
    │
    │  StreamProgressEvent: tool_start, tool_end, text_delta, intent
    │
    ▼
message-processor.ts: progressCallback
    │
    ├──► onTextDelta(text)  ─── WS ──► streaming bubble in chat
    ├──► onIntent(text)     ─── WS ──► intent bubble in chat
    ├──► onToolStatus(text) ─── WS ──► tool status line in chat
    │       (via getToolStatus() — human-friendly text)
    │
    └──► baseProgress(event) ──► agentStatus singleton
              │
              ├── toolStart(name, displayName, input)
              ├── toolEnd(name, displayName)
              └── notifyProgress() ──► SSE subscribers
                                          │
                                          ▼
                                  Browser: updateRequestProgress()
                                      ├── Waterfall panel (if enabled)
                                      └── Agent status bar (always)
```

### Key files

| File | Purpose |
|---|---|
| `src/ai/stream-parser.ts` | Parses connector output into `StreamProgressEvent` (tool_start, tool_end, text_delta, intent) |
| `src/ai/tool-status.ts` | `getToolStatus()` — maps tool names to human-friendly text (e.g., "Code analysis: find symbol MaksimalAvgift") |
| `src/core/message-processor.ts` | Routes stream events to both WS callbacks (chat display) and agentStatus (waterfall) |
| `src/dashboard/agent-status.ts` | `agentStatus` singleton — tracks `RequestProgress` with tool timing, notifies SSE subscribers |
| `src/dashboard/routes/sse-routes.ts` | `/api/events` endpoint — sends initial state + live `request_progress` updates |
| `src/chat/state.ts` | `publishIntent()`, `publishToolStatus()`, `publishTextDelta()` — WS event emitters |
| `src/chat/views/page.ts` | Browser-side: waterfall rendering, WS event handlers, inline tool display |

## 3. Waterfall Panel

The waterfall is a horizontal bar chart showing tool call timing relative to the request start. It's rendered in a fixed panel above the chat messages.

### How it renders

`updateRequestProgress(progress)` in `request-progress-ui.ts` receives the full `RequestProgress` object:

```typescript
interface RequestProgress {
  requestId: string;
  botName: string;
  username?: string;
  phase: AgentPhase;
  connectorLabel?: string;      // e.g., "Copilot SDK"
  model?: string;               // e.g., "claude-opus-4-6"
  startedAt: number;            // epoch ms
  tools: ToolProgress[];        // tool timing bars
  completed?: boolean;
  completedAt?: number;
  traceId?: string;             // set on completion
  inputTokens?: number;
  outputTokens?: number;
}

interface ToolProgress {
  name: string;                 // raw tool name
  displayName: string;          // human-friendly name
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  input?: string;               // abbreviated input (max 500 chars)
}
```

Each tool gets a bar positioned as:
```
leftPct  = (tool.startedAt - request.startedAt) / totalDuration * 100
widthPct = (tool.endedAt - tool.startedAt) / totalDuration * 100
```

Active tools pulse (CSS animation), completed tools are solid. The panel updates at ~20fps via `requestAnimationFrame` with a 50ms throttle.

### Auto-clear behavior

- On completion: `agentStatus.completeRequest()` schedules `clearRequest()` after 30s
- SSE auto-dismiss: `CHAT_SSE_SCRIPT` adds an 8s timer after receiving completed progress
- Manual dismiss: user clicks the × button, or `dismissRequestProgress()` is called when text streaming starts

## 4. showWaterfall Suppression

Per-bot config `showWaterfall: false` suppresses the waterfall panel and shows inline tool status instead. This uses a global flag checked inside `updateRequestProgress()` itself — not an IIFE override, which had scope issues.

### How it works

```
requestProgressScript() defines updateRequestProgress():
    ┌──────────────────────────────────────────────┐
    │ if (window._suppressWaterfall) {             │
    │   updateAgentStatusFromProgress(progress);   │ ← status bar still updates
    │   return;                                    │ ← waterfall panel skipped
    │ }                                            │
    │ // ... render waterfall panel                │
    └──────────────────────────────────────────────┘

selectBot() in CHAT_SCRIPT:
    window._suppressWaterfall = bot.showWaterfall === false;
    if (window._suppressWaterfall) dismissRequestProgress();

Initial state:
    window._suppressWaterfall = true;  ← suppress until bot is selected
```

### Why a global flag (not a function override)

The chat page has three script sections in one `<script>` block:
1. `requestProgressScript()` — defines `updateRequestProgress()` as a function declaration
2. `CHAT_SSE_SCRIPT` — IIFE that calls `connectSSE()`, subscribes to SSE events
3. `CHAT_SCRIPT` — IIFE with the main chat logic

An earlier approach tried overriding `updateRequestProgress` from CHAT_SCRIPT's IIFE, but the function declaration in requestProgressScript wasn't reliably overridden across IIFE scope boundaries. The global flag avoids all scope chain issues.

### Dashboard unaffected

The dashboard page also uses `requestProgressScript()` but never sets `window._suppressWaterfall`, so it's `undefined` (falsy) and the waterfall renders normally.

## 5. Tool Activity Container

Tool progress is displayed in a collapsible `tool-activity` container that sits between the user's query and the bot's response. This container is used for both live display (WS events) and persisted display (trace data).

### DOM structure

```html
<div class="msg msg-user">User query<div class="msg-time">10:45</div></div>
<div class="tool-activity [collapsed]">
  <div class="tool-activity-header">          ← click to expand/collapse
    <span class="tool-activity-label">Used 12 tools · 80.8s</span>
    <span class="tool-activity-toggle">▶</span>
  </div>
  <div class="tool-activity-body">
    <div class="msg-intent">Investigating codebase</div>
    <div class="msg-tool-status">Code analysis: find symbol X</div>
  </div>
</div>
<div class="msg msg-bot">Response...<div class="msg-time">10:46</div></div>
```

### Live display (during request)

WebSocket events append into `activeToolContainer` (lazily created by `getOrCreateToolContainer()`):

| Event | Handler | Target | Behavior |
|---|---|---|---|
| `intent` | `showIntentBubble(text)` | `.tool-activity-body` | **Replaced** on each new intent |
| `tool_status` | `appendToolStatus(text)` | `.tool-activity-body` | **Appended** — each tool gets its own line |
| `text_delta` | `appendStreamingDelta()` | `chatMessages` root | Streaming bubble (still uses `msg-intermediate`) |

The header updates with a running tool count ("Using 5 tools...").

### Collapse on completion

When the bot response arrives or status clears, `collapseToolActivity()`:
1. Adds `collapsed` class → hides `.tool-activity-body` via CSS
2. Updates header label to summary ("Used 12 tools")
3. Clears `activeToolContainer` ref

The container is **not removed** — it persists in the DOM, expandable by clicking the header.

### Intermediates cleanup

`removeIntermediates()` still removes elements with `msg-intermediate` class (streaming bubbles), but tool_status and intent lines inside the tool-activity container no longer have this class — they're managed by the container's collapse/expand instead.

### Tool status text format

`getToolStatus()` in `src/ai/tool-status.ts` converts raw tool names to human-friendly text:

```
"mcp__code__call_tool" with input containing "find_symbol"
    → "Code analysis: find symbol MaksimalAvgift"

"mcp__gmail__search_emails" with query "from:boss"
    → "Searching email: from:boss"

"report_intent"
    → undefined (skipped — generates its own intent events)
```

Tool names are parsed differently per connector:
- Claude CLI: `mcp__server__tool` → split on `__`
- Copilot SDK: `server-tool` → split on first `-`
- Serena proxy: `code-call_tool` → split at dash before first underscore

### Styled rendering

Tool status lines use `createToolStatusLine()` which splits on `: ` for visual distinction:
```html
<div class="msg-tool-status">
  <span class="tool-label">Code analysis: </span>
  <span class="tool-detail">find symbol MaksimalAvgift</span>
</div>
```

Both `appendToolStatus()` (live) and `loadToolCallsFromTrace()` (persisted) use this shared function.

## 6. Persistent Tool History (Traces)

The persistence layer links assistant messages to their traces via `trace_id`, so tool calls survive page refresh and thread switching.

### How it works

```
                     Saving                          Loading
                     ─────                           ───────
Tracer created       t.traceId ──► saveMessage()     getSimMessages() returns traceId
  at request start                 (trace_id col)          │
                                                           ▼
Tool calls saved     ──► traces table              appendMessage() checks:
  as child spans         (with statusText attr)      if (msg.traceId && showWaterfall===false)
  in Tracer                                            loadToolCallsFromTrace(botMsgDom, traceId)
                                                           │
                                                           ▼
                                                   fetch('/api/traces/' + traceId)
                                                     → filter spans with parentId + toolName
                                                     → create collapsed tool-activity container
                                                     → insert before bot message in DOM
```

### Key details

- `trace_id UUID` column on `messages` table (migration 026)
- Only assistant messages get `trace_id` (set in `message-processor.ts`)
- `statusText` attribute saved on trace child spans — the human-friendly `getToolStatus()` output (e.g., "Searching knowledge base: query"). Old spans without `statusText` fall back to raw span name.
- `loadToolCallsFromTrace()` creates a **collapsed tool-activity container** (same structure as live) and inserts it **before the bot message** in the DOM — between user query and bot response
- Traces have 7-day retention (`TRACING_RETENTION_DAYS`) — older messages lose tool history gracefully (empty response, no rendering)
- Only triggered for bots with `showWaterfall === false`

### Inspector sidebar: per-thread stats

The inspector panel's tool usage and context stats are scoped per thread:
- `getToolUsageStats(userId, botName, threadId?)` — joins traces through `messages.trace_id` to filter by thread
- `getLastResponseMeta(userId, botName, threadId?)` — finds the last assistant message in the thread
- Both reload on every thread switch (not cached by user+bot key)
- New/empty threads show no stats

### CSS classes

| Class | Where | Lifecycle |
|---|---|---|
| `tool-activity` | Container between user msg and bot response | Permanent — persists after completion, collapsed |
| `tool-activity collapsed` | Collapsed state | Body hidden via CSS, header shows summary, click to expand |
| `msg-intent` | Intent bubble inside tool-activity-body | Replaced on new intent |
| `msg-tool-status` | Tool status line inside tool-activity-body | Appended per tool call |
| `msg-intermediate` | Streaming bubble only | Removed when response completes or status clears |
| `msg-streaming` | Streaming text bubble | Promoted to permanent on `stream_clear`, removed on `message` |
| `request-progress` | Waterfall panel | Fixed position, toggled via `visible`/`completed` classes |

## 7. Debugging Checklist

**Waterfall shows when it shouldn't:**
- Check `showWaterfall` in bot's `config.json` — must be `false`
- Check `window._suppressWaterfall` in browser console — should be `true`
- Check `selectBot()` is called before SSE events arrive — the flag is set there
- Check that `updateRequestProgress()` in request-progress-ui.ts has the `_suppressWaterfall` check

**Tool use disappears on refresh:**
- Check `trace_id` on the message: `SELECT trace_id FROM messages WHERE id = '...'`
- If NULL: message was saved before trace_id support (backfill possible via timestamp matching with traces)
- Check traces exist: `GET /api/traces/:traceId` — may have expired (7-day retention)
- Check `loadToolCallsFromTrace()` runs — only for `showWaterfall === false` bots
- Check `statusText` in trace attributes — if missing, raw span names are shown instead of friendly text

**Tool status lines not showing during live request:**
- Check WS connection is open (browser DevTools → Network → WS)
- Check `activeToolContainer` is created — `getOrCreateToolContainer()` is called on first tool_status/intent event
- Check `onToolStatus` callback is set in `processMessage()` — only for web chat, not Telegram
- Check `getToolStatus()` returns a value (some tools like `report_intent` return `undefined`)

**Inspector shows same stats for all threads:**
- Check that `loadToolUsageStats()` and `loadContextUsage()` pass `activeThreadId` as query parameter
- Check that `getToolUsageStats` and `getLastResponseMeta` filter by `threadId`
- Check that messages have `trace_id` set — the thread filter joins through this column

**Waterfall bars not updating:**
- Check `rpAnimFrame` is set (RAF loop running)
- Check `rpLastProgress` is being updated via SSE
- Check panel has `visible` class
