---
name: slack-channel-listening
description: >
  Relevance-based passive channel listening for Javrvis Slack bots. Covers the full
  pipeline: channel activation via @mention, heuristic pre-filters, rate limiting,
  Haiku relevance classification with conversation context, auth-bypass for channel
  listeners, and thread tracking with origin inheritance.
  Use when: (1) Modifying how the bot decides whether to respond in a channel,
  (2) Debugging why a channel message was ignored or answered,
  (3) Changing relevance thresholds, cooldowns, or rate limits,
  (4) Adding new heuristic filters or changing the Haiku prompt,
  (5) Working with the channel listening config in config.json,
  (6) Debugging thread follow-ups from channel-listen responses,
  (7) Understanding auth-bypass for passive listening.
  Triggers: "channel listening", "relevance filter", "passive listening",
  "kanallytting", "relevans", "why didn't the bot respond", "channel activation".
---

# Slack Channel Listening

## Activation Model

Bots only listen in channels where they have been **@mentioned** (`app_mention` event).
After @mention, the channel is "active" for 7 days (in-memory, resets on restart).
Messages in inactive channels are silently ignored.

Activation in `src/slack/index.ts` inside `app.event("app_mention")`:
```
relevanceFilter.activateChannel(event.channel)
```

## Message Flow

```
Channel message (app.message, else branch)
  ├─ channelListening.enabled? NO → ignore
  ├─ isChannelActive(channel)? NO → ignore
  ├─ Heuristic pre-filters (< 10 chars, only URLs, only emoji) → skip
  ├─ Rate limit (per-channel cooldown, global hourly limit) → skip
  ├─ Fetch last ~10 messages (conversations.history)
  ├─ Haiku relevance classification → NOT relevant → ignore
  ├─ handleMessage() with platform "slack_channel_listen"
  │    auth-bypass + CHANNEL_LISTEN_CONTEXT in system prompt
  └─ Reply in thread, trackThread(origin: "channel_listen")
```

## Key Files

| File | Role |
|------|------|
| `src/slack/relevance-filter.ts` | RelevanceFilter class — activation, heuristics, rate limiting, Haiku call |
| `src/slack/index.ts` | Wiring — activates on @mention, gates standalone messages, fetchRecentMessages() |
| `src/slack/handler.ts` | Auth-bypass for `slack_channel_listen`, proactive context in system prompt |
| `src/bots/config.ts` | `ChannelListeningConfig` interface, parsed from config.json |
| `bots/<name>/config.json` | Per-bot channelListening config |

## Config (config.json)

```json
{
  "channelListening": {
    "enabled": true,
    "cooldownMs": 120000,
    "maxResponsesPerHour": 10,
    "relevanceThreshold": "medium",
    "contextMessages": 10,
    "topicHints": ["software", "AWS", "Kotlin"]
  }
}
```

All fields except `enabled` are optional with sensible defaults.

- `relevanceThreshold`: "low" = generous, "medium" = balanced, "high" = strict
- `topicHints`: domain keywords injected into the Haiku relevance prompt

## Thread Tracking

Threads track an `origin` field: `"mention"` or `"channel_listen"`.
Follow-ups inherit the origin's platform:
- `channel_listen` → `platform: "slack_channel_listen"` → auth-bypass
- `mention` → `platform: "slack_channel"` → normal auth

Anyone can continue a thread the bot started via channel listening.

## Auth Bypass

In `src/slack/handler.ts`, auth skips when `platform === "slack_channel_listen"`:
```typescript
if (platform !== "slack_channel_listen" &&
    botConfig.slackAllowedUserIds.length > 0 &&
    !botConfig.slackAllowedUserIds.includes(userId)) {
```

## System Prompt Addition

When `platform === "slack_channel_listen"`, `CHANNEL_LISTEN_CONTEXT` is appended telling the bot it was NOT directly asked and to keep responses concise.

## Haiku Relevance Prompt

Includes: bot name, persona summary (first 500 chars), topic hints, threshold instruction, recent channel messages ("username: text"), and the latest message.
Response: `{"relevant": false}` or `{"relevant": true, "confidence": "high", "reason": "..."}`.
Fail-closed: any error returns `relevant: false`.
Tracked in `haiku_usage` with `source: "relevance"`.

## Debugging

Log patterns:
- `Channel X activated for passive listening` — @mention activated channel
- `Channel X not active (bot needs to be @mentioned first), ignoring` — not activated
- `Channel listening disabled, ignoring channel message` — config not enabled
- `Skipped (too short|only URLs|only emoji|cooldown|rate limit|not relevant)` — filtered out
- `Relevant (high): "..." — reason` — passed filter, responding
- `Thread follow-up ... (origin: channel_listen)` — thread reply with auth-bypass
