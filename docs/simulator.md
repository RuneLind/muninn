# Simulator

How to develop and test Javrvis without real Telegram/Slack tokens — a browser-based chat UI that runs alongside production on a separate port and database.

## Overview

The simulator provides a browser-based chat interface that mimics Telegram and Slack conversations. It runs as a second instance of Javrvis with its own database, allowing development and testing without affecting production data or requiring bot tokens.

```
┌──────────────────────────┐     ┌──────────────────────────┐
│  Production (port 3010)  │     │  Simulator (port 3011)   │
│  Real Telegram/Slack     │     │  Browser chat UI         │
│  Voice, scheduler        │     │  No tokens, no scheduler │
│  DATABASE_URL            │     │  SIMULATOR_DATABASE_URL   │
└──────────┬───────────────┘     └──────────┬───────────────┘
           │                                │
           └───────── PostgreSQL ────────────┘
                    (port 5434)
```

## Quick Start

```bash
bun run db:up           # Start PostgreSQL (shared)
bun run dev:simulator   # Starts on port 3011 with simulator DB
```

No `.env` changes needed — `dev:simulator` uses env overrides automatically.

## Architecture

### Dual-Instance Design

| | Production | Simulator |
|---|---|---|
| Port | 3010 | 3011 |
| Database | `javrvis` | `javrvis_simulator` |
| Scheduler | Enabled | Disabled |
| Voice | Enabled | Disabled |
| Bot tokens | Required | Not needed |
| Bot discovery | `discoverActiveBots()` — requires tokens | `discoverAllBots()` — only needs CLAUDE.md |

The simulator discovers bots using `discoverAllBots()`, which only requires a `CLAUDE.md` file (no platform tokens). This means any bot folder with a persona can be tested in the simulator.

### State Management

Conversations are managed in-memory by `SimulatorState`:

```typescript
class SimulatorState {
  private conversations = new Map<string, SimConversation>();
  private subscribers = new Set<EventSubscriber>();

  createConversation(params): SimConversation;
  addMessage(conversationId, message): void;
  setStatus(conversationId, status): void;
  findOrCreateChannel(botName, channel, userId, username): SimConversation;
}
```

- **Max conversations:** 50 (oldest pruned when exceeded)
- **Persistence:** In-memory only (conversations lost on restart, but messages are saved to the simulator DB)
- **Pub/sub:** Events (new message, status change, conversation created) are broadcast to WebSocket subscribers

### Conversation Types

The simulator supports all platform conversation types:

| Type | Simulates | Features |
|---|---|---|
| `telegram_dm` | Telegram direct message | HTML formatting, message splitting |
| `slack_dm` | Slack direct message | mrkdwn formatting |
| `slack_channel` | Slack channel thread | Channel context, cross-channel posting |
| `slack_assistant` | Slack Assistant API | Native thread model |

### Message Processing

Simulator messages go through the exact same `processMessage()` pipeline as real platform messages. The only difference is the `say`, `setStatus`, and `postToChannel` callbacks:

```typescript
// Instead of Telegram/Slack API calls:
const say = async (message: string) => {
  simulatorState.addMessage(conversationId, { sender: "bot", text: message });
};

const setStatus = async (status: string) => {
  simulatorState.setStatus(conversationId, status);
};
```

This means simulator conversations get:
- Full prompt assembly (memories, goals, tasks, knowledge)
- MCP tool access (if configured in bot's `.mcp.json`)
- Memory/goal/schedule extraction (fire-and-forget)
- Tracing (visible in the dashboard at port 3011)
- Platform-appropriate formatting (HTML for Telegram, mrkdwn for Slack)

### WebSocket Communication

The browser UI connects via WebSocket for real-time updates:

```typescript
type SimEvent =
  | { type: "message"; conversationId: string; message: SimMessage }
  | { type: "status"; conversationId: string; status: string }
  | { type: "conversation_created"; conversation: SimConversation };
```

When Claude is thinking, status events update the UI in real-time ("Building prompt...", "Thinking...", "Sending...").

### Cross-Channel Posting

Slack `<slack-post channel="#name">` directives work in the simulator. When Claude posts to a channel, `findOrCreateChannel()` either finds the existing channel conversation or creates a new one, and the message appears there.

## Database Isolation

The simulator uses a separate database (`javrvis_simulator` by default) to prevent test data from mixing with production. The database is auto-created and initialized on startup if it doesn't exist.

Both instances connect to the same PostgreSQL container (port 5434) but use different databases.

## REST API

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/simulator/bots` | GET | List discovered bots |
| `/api/simulator/conversations` | GET | List all conversations |
| `/api/simulator/conversations` | POST | Create a new conversation |
| `/api/simulator/conversations/:id` | DELETE | Delete a conversation |
| `/api/simulator/conversations/:id/messages` | POST | Send a message |

## Key Files

| File | Purpose |
|---|---|
| `src/simulator/index.ts` | Module exports |
| `src/simulator/state.ts` | `SimulatorState` — in-memory conversations + pub/sub |
| `src/simulator/processor.ts` | Bridges simulator state to `processMessage()` |
| `src/simulator/routes.ts` | Hono REST API routes |
| `src/simulator/ws.ts` | WebSocket handler for real-time updates |
| `src/simulator/views/` | Browser UI HTML |
| `src/bots/config.ts` | `discoverAllBots()` — token-free discovery |
