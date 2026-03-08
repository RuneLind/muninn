# Multi-Bot Architecture

How Muninn runs multiple AI bots in a single process — each with its own persona, MCP tools, permissions, and conversation history — while sharing a database, dashboard, and scheduler.

## Overview

Every bot is a folder under `bots/<name>/`. The system auto-discovers bots at startup by scanning this directory for folders with a `CLAUDE.md` file and a matching platform token environment variable. Each bot gets its own Grammy/Slack instance, but they all share a single PostgreSQL database, dashboard, and scheduler.

```
                    ┌────────────────────────────────────┐
                    │       Single muninn process        │
                    │                                    │
Telegram user A ───►│  Grammy Bot 1 (Jarvis)             │
                    │    → Claude CLI (cwd: bots/jarvis) │
                    │                                    │
Telegram user B ───►│  Grammy Bot 2 (Your Bot)           │
                    │    → Claude CLI or Copilot SDK     │
                    │                                    │
Slack user C ──────►│  Slack Bot 1 (Your Bot)            │
                    │    → Claude CLI or Copilot SDK     │
                    │                                    │
                    │  Shared: DB, Dashboard, Scheduler  │
                    └────────────────────────────────────┘
```

## Bot Discovery

`discoverBots()` in `src/bots/config.ts` runs at startup:

1. Scans `bots/` directory for subdirectories
2. Checks each folder for a `CLAUDE.md` file (required — defines persona)
3. Matches folder name to environment variables: `TELEGRAM_BOT_TOKEN_<NAME>` or `SLACK_BOT_TOKEN_<NAME>`
4. Loads optional `config.json` for model/thinking/timeout overrides
5. Detects optional `.mcp.json` and `.claude/settings.json`
6. Returns a `BotConfig[]` array

A bot needs at least one platform token to be active. Bots without tokens still appear in the `/chat` UI for browser-based testing.

```typescript
interface BotConfig {
  name: string;                       // "jarvis", "mybot"
  dir: string;                        // Absolute path to bots/<name>/
  persona: string;                    // Contents of CLAUDE.md
  telegramBotToken?: string;
  telegramAllowedUserIds: string[];
  slackBotToken?: string;
  slackAppToken?: string;
  slackAllowedUserIds: string[];
  model?: string;                     // Override global CLAUDE_MODEL
  thinkingMaxTokens?: number;         // Extended thinking control
  timeoutMs?: number;                 // Override global CLAUDE_TIMEOUT_MS
  restrictedTools?: RestrictedTools;  // Per-tool-group user access control
  channelListening?: ChannelListeningConfig;
}
```

## Bot Folder Structure

```
bots/
├── jarvis/
│   ├── CLAUDE.md                    ← Persona (required, auto-loaded by Claude CLI)
│   ├── config.json                  ← Model, thinking, timeout overrides (optional)
│   ├── .mcp.json                    ← MCP servers: Gmail, Calendar (optional)
│   └── .claude/
│       └── settings.json            ← Tool permissions (optional)
├── your-bot/                        ← Add your own here
│   └── ...
```

## CLI Isolation via `cwd`

The key architectural insight: Claude CLI is spawned with `cwd: botConfig.dir`. This single parameter achieves complete isolation:

```typescript
// src/ai/executor.ts
const proc = Bun.spawn(["claude", "-p", prompt, ...args], {
  cwd: botConfig.dir,   // ← This is the isolation mechanism
  env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: `${botConfig.name}-bot` },
});
```

What `cwd` gives us for free (Claude CLI auto-discovers):
- **Persona:** `CLAUDE.md` is loaded as project instructions
- **MCP tools:** `.mcp.json` defines available servers (Gmail, Calendar, Knowledge, etc.)
- **Permissions:** `.claude/settings.json` controls which tools are auto-approved
- **History:** Claude CLI stores its conversation history in `.claude/` — separate per bot
- **Session isolation:** Each bot's CLI sessions are independent

## Per-Bot Configuration

`config.json` provides optional overrides. All fields fall back to global defaults:

```json
{
  "model": "sonnet",
  "thinkingMaxTokens": 16000,
  "timeoutMs": 180000,
  "restrictedTools": {
    "email": {
      "description": "Gmail — lesing og sending av e-post",
      "allowedUsers": ["123456789"]
    }
  },
  "channelListening": {
    "enabled": true,
    "cooldownMs": 120000,
    "topicHints": ["kotlin", "architecture"]
  }
}
```

Unknown keys trigger a warning at startup (catches typos like `thinkingMaxTokenz`).

## Tool Restrictions

Some bots have tools that should only be available to specific users (e.g., email access). This is configured per-bot in `config.json`:

```json
{
  "restrictedTools": {
    "email": {
      "description": "Gmail — reading and sending email",
      "allowedUsers": ["123456789"]
    },
    "calendar": {
      "description": "Google Calendar",
      "allowedUsers": ["123456789"]
    }
  }
}
```

Enforcement is prompt-based — the system prompt tells Claude which tools the current user cannot access:

```
## Tool Restrictions
This user does NOT have access to:
- email: Gmail — reading and sending email
- calendar: Google Calendar

Rules:
- NEVER use any of the tools listed above for this user
- If the user asks for something requiring a restricted tool, politely decline
```

This is soft enforcement (Claude honors the prompt instruction, not cryptographic blocking). It works reliably in practice because Claude follows system prompt instructions.

## Platform Tokens

Each bot needs platform tokens as environment variables:

```bash
# Telegram
TELEGRAM_BOT_TOKEN_JARVIS=123:ABC...
TELEGRAM_ALLOWED_USER_IDS_JARVIS=123456789,987654321

# Slack
SLACK_BOT_TOKEN_CAPRA=xoxb-...
SLACK_APP_TOKEN_CAPRA=xapp-...
SLACK_ALLOWED_USER_IDS_CAPRA=U12345,U67890
```

A bot can have both Telegram and Slack tokens — it will run on both platforms simultaneously.

## Shared Infrastructure

While each bot is isolated in its persona and tools, they share:

| Component | Sharing model |
|---|---|
| **PostgreSQL** | Single database, `bot_name` column on every table |
| **Dashboard** | Bot filter dropdown on all pages |
| **Scheduler** | Per-bot interval — each bot gets its own scheduler tick |
| **Activity log** | Shared in-memory ring buffer + DB, filterable by bot |
| **Tracing** | Shared traces table, `bot_name` attribute on root spans |

## Adding a New Bot

Zero code changes required:

1. Create `bots/<name>/CLAUDE.md` with the bot's persona
2. Optionally add `config.json`, `.mcp.json`, `.claude/settings.json`
3. Add `TELEGRAM_BOT_TOKEN_<NAME>=...` to `.env`
4. Add `TELEGRAM_ALLOWED_USER_IDS_<NAME>=...` to `.env`
5. Restart the process

The bot is auto-discovered and starts handling messages immediately.

## Key Files

| File | Purpose |
|---|---|
| `src/bots/config.ts` | `BotConfig` interface, `discoverActiveBots()`, `discoverAllBots()` |
| `src/index.ts` | Startup: discovers bots, starts Grammy/Slack + dashboard + scheduler per bot |
| `src/ai/executor.ts` | Spawns Claude CLI with `cwd: botConfig.dir` |
| `src/ai/tool-restrictions.ts` | Builds tool restriction prompt section |
| `bots/jarvis/CLAUDE.md` | Jarvis persona |
| `bots/jarvis/config.json` | Jarvis config overrides |
| `bots/jarvis/.mcp.json` | Jarvis MCP servers (Gmail, Calendar) |
