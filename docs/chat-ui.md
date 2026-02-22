# Chat UI

Browser-based chat interface for developing and testing bots without real Telegram/Slack tokens.

## Overview

The `/chat` page provides a browser-based chat interface that mimics Telegram and Slack conversations. It's always available at `/chat` on the dashboard — no special mode or configuration needed. Bots without platform tokens still appear in the chat UI as long as they have a `CLAUDE.md`.

## Quick Start

```bash
bun run db:up           # Start PostgreSQL
bun run dev             # Full app — chat UI at http://localhost:3010/chat
bun run dev:chat        # Chat-focused — scheduler off, port 3011
```

## State Management

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
- **Persistence:** Messages saved to DB; in-memory state hydrated on startup
- **Pub/sub:** Events (new message, status change, conversation created) are broadcast to WebSocket subscribers

## Conversation Types

| Type | Simulates | Features |
|---|---|---|
| `telegram_dm` | Telegram direct message | HTML formatting, message splitting |
| `slack_dm` | Slack direct message | mrkdwn formatting |
| `slack_channel` | Slack channel thread | Channel context, cross-channel posting |
| `slack_assistant` | Slack Assistant API | Native thread model |

## Message Processing

Chat messages go through the exact same `processMessage()` pipeline as real platform messages. The only difference is the `say`, `setStatus`, and `postToChannel` callbacks:

```typescript
// Instead of Telegram/Slack API calls:
const say = async (message: string) => {
  simulatorState.addMessage(conversationId, { sender: "bot", text: message });
};

const setStatus = async (status: string) => {
  simulatorState.setStatus(conversationId, status);
};
```

This means chat conversations get:
- Full prompt assembly (memories, goals, tasks, knowledge)
- MCP tool access (if configured in bot's `.mcp.json`)
- Memory/goal/schedule extraction (fire-and-forget)
- Tracing (visible in the dashboard)
- Platform-appropriate formatting (HTML for Telegram, mrkdwn for Slack)

## WebSocket Communication

The browser UI connects via WebSocket for real-time updates:

```typescript
type SimEvent =
  | { type: "message"; conversationId: string; message: SimMessage }
  | { type: "status"; conversationId: string; status: string }
  | { type: "conversation_created"; conversation: SimConversation };
```

When Claude is thinking, status events update the UI in real-time ("Building prompt...", "Thinking...", "Sending...").

## Cross-Channel Posting

Slack `<slack-post channel="#name">` directives work in the chat UI. When Claude posts to a channel, `findOrCreateChannel()` either finds the existing channel conversation or creates a new one, and the message appears there.

## REST API

| Endpoint | Method | Purpose |
|---|---|---|
| `/chat/bots` | GET | List discovered bots |
| `/chat/conversations` | GET | List all conversations |
| `/chat/conversations` | POST | Create a new conversation |
| `/chat/conversations/:id` | DELETE | Delete a conversation |
| `/chat/conversations/:id/messages` | POST | Send a message |

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
