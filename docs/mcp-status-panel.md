# MCP Status Panel — Work Document

## Problem

When a bot's MCP server is unavailable, two things go wrong in the web chat:

1. **Noisy / wrong-channel warning**: `copilot-sdk` emits a transient intent bubble (`⚠️ MCP-server "X" er ikke tilgjengelig`) for every HTTP MCP that fails a TCP probe. For Serena this is a false alarm — the agent works fine via Yggdrasil — yet it pollutes every conversation.
2. **Silent showstopper**: when the *knowledge* MCP (Yggdrasil / `knowledge`) is down, the agent has no way to do retrieval. It compensates by reading disk or scraping, wasting tokens and producing wrong answers. Today there is no signal in the UI.

Reachability is also probed only by `copilot-sdk` and only with a TCP/HTTP `fetch`. `claude-cli` and `openai-compat` get no probing at all, even though they hit the same MCPs.

## Goal

- One persistent, per-bot status panel surface that always shows which MCP servers are up.
- Critical-down MCPs are flagged loudly *and* warned about before the request runs (so the user knows the answer may be unreliable).
- Non-critical-down MCPs are visible in the panel but do not interrupt the chat stream.
- Probing strategy is configurable per bot — not every send pays the latency cost.
- Works uniformly for all three connectors (`claude-cli`, `copilot-sdk`, `openai-compat`).

## Design

### 1. `src/ai/mcp-status.ts` (new)

Single source of truth for MCP availability. Wraps `src/dashboard/mcp-client.ts` for transient probes (connect → `listTools` → disconnect). Real handshake — catches "spawned but crashed during init", which the current TCP probe misses.

```ts
export type McpServerStatus = {
  name: string;
  displayName: string;
  status: "ok" | "down" | "unknown";
  toolCount?: number;
  errorMessage?: string;
  lastCheckedMs: number;
  critical: boolean;
};

// Cached per bot, keyed by bot name. TTL from bot config (default 60s).
export async function getMcpStatus(botConfig: BotConfig, opts?: { force?: boolean }): Promise<McpServerStatus[]>;
export function invalidateMcpStatus(botName: string): void;
export function getCachedMcpStatus(botName: string): McpServerStatus[] | null;
```

Probe runs in parallel across servers, with a per-server timeout. `connectServer` is borrowed from `src/dashboard/mcp-client.ts` — it already supports stdio + HTTP + SSE.

### 2. Bot config

`bots/<name>/config.json` gains an optional `mcpStatus` block:

```json
{
  "mcpStatus": {
    "probeOnSend": false,
    "cacheTtlMs": 60000,
    "critical": ["yggdrasil", "knowledge"]
  }
}
```

Defaults if omitted: `probeOnSend: false`, `cacheTtlMs: 60000`, `critical: []`. Servers not listed in `critical` are non-critical (down → silent in chat, visible in panel).

### 3. Connector behavior

All three connectors (`claude-cli`, `copilot-sdk`, `openai-compat`):

- Before executing, call `getMcpStatus(botConfig)` (uses cache if fresh).
- If `probeOnSend` is true, force-refresh first.
- If any *critical* server is down → prepend one short message to the response stream (e.g. `⚠️ Yggdrasil er nede — svar kan være ufullstendig`) and set `mcpDown: ["yggdrasil"]` on response meta.
- Non-critical down → no chat-stream output. Status remains in the panel.

The current intent-bubble emission in `copilot-sdk.ts:89` is removed.

### 4. Chat endpoints (`src/chat/routes.ts`)

```
GET  /chat/mcp-status/:bot          → cached status (probes if cache miss)
POST /chat/mcp-status/:bot/refresh  → invalidate + re-probe, returns fresh status
```

Both return `{ servers: McpServerStatus[] }`.

### 5. WebSocket event

New `ChatEvent` variant:

```ts
{ type: "mcp_status", bot: string, servers: McpServerStatus[] }
```

Broadcast from `mcp-status.ts` after every probe completes. Open chat tabs update without re-fetching.

### 6. Inspector panel UI

In `src/chat/views/components/inspector-panel.ts`, between Status and Context:

```
MCP servers                         [↻]
  ● Yggdrasil    ok · 12 tools
  ● Serena       ok · 41 tools
  ● Gmail        down · timeout         ← critical → red row
```

- Green dot for ok, red for down, grey for unknown.
- Critical-down rows use the existing warning color from context-bar.
- Refresh button calls `POST /chat/mcp-status/:bot/refresh`. While probing, the dot is replaced by a spinner.

## Probing strategy summary

| Trigger | When | Notes |
|---|---|---|
| Chat page open / bot switch | Once per bot per page session | Populates panel before user types |
| Refresh button | Manual | Invalidates cache |
| Stale cache | Cache age > `cacheTtlMs` | Lazy-refreshed by next request |
| `probeOnSend: true` | Every request | Opt-in for paranoid setups |

## Tradeoffs

- A real handshake is slower than TCP probe (300ms–2s/server). Cache + manual refresh button keep UX fast.
- Stdio MCPs have to be spawned to probe them — same cost as the agent would pay anyway, just front-loaded.
- Per-bot `critical` list adds config surface but is the only way to avoid hardcoding "yggdrasil is special".

## Files touched

| File | Change |
|---|---|
| `src/ai/mcp-status.ts` | New — probe + cache + classification |
| `src/ai/mcp-status.test.ts` | New — unit tests |
| `src/bots/config.ts` | Add optional `mcpStatus` field to BotConfig |
| `src/ai/connectors/copilot-sdk.ts` | Remove intent-bubble emission, call getMcpStatus + critical-warn |
| `src/ai/connectors/claude-cli.ts` | Add getMcpStatus + critical-warn (no existing probe) |
| `src/ai/connectors/openai-compat.ts` | Add getMcpStatus + critical-warn |
| `src/chat/state.ts` | Add `mcp_status` ChatEvent variant |
| `src/chat/routes.ts` | New endpoints |
| `src/chat/views/components/inspector-panel.ts` | New panel section |
| `src/chat/views/components/chat-styles.ts` | Styles for new section |

## Open questions / future

- Should chat-page-open probe be debounced when many tabs open simultaneously? (Current cache makes this a non-issue in practice.)
- Should we persist `lastCheckedMs` so a fresh page load shows last-known status before the first probe completes? Probably not needed — first probe completes in <2s.
- Future: surface this same status on the Telegram/Slack side via `set_summary` style? Out of scope for this work.
