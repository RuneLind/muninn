# Scheduler & Proactive Outreach

How Javrvis runs background automation — scheduled tasks, goal reminders, email/news watchers, and daily briefings — all from a single unified scheduler tick per bot.

## Overview

Each bot has a single `setInterval` tick (default 60 seconds) that checks for and executes four types of background work. This unified design avoids multiple independent timers and simplifies resource management.

```
Every 60 seconds (per bot):
  ┌──────────────────────────────────────────────┐
  │  1. Scheduled tasks     Due now? → Execute   │
  │  2. Goal reminders      Deadline <24h? → Msg │
  │  3. Goal check-ins      Stale >3 days? → Msg │
  │  4. Watchers            Due now? → Check     │
  │  5. Retention cleanup   Hourly → Purge old   │
  └──────────────────────────────────────────────┘
```

## Scheduler Runner

### Tick Safety

Each tick is protected against several failure modes:

- **Concurrency guard:** If the previous tick is still running, the new tick is skipped with a warning
- **Timeout:** Each tick has a 5-minute hard timeout — if exceeded, the tick is killed
- **Error isolation:** Individual task/watcher failures are caught and logged without killing the tick
- **Retry storm prevention:** Failed tasks still advance their `lastRunAt` to prevent infinite retries

```typescript
// Simplified tick lifecycle
if (tickRunning.get(botName)) return; // Skip if previous tick still running
tickRunning.set(botName, true);

Promise.race([
  runSchedulerTick(api, config, botConfig),
  timeout(5 * 60 * 1000),  // 5-minute hard limit
]).finally(() => tickRunning.set(botName, false));
```

### Selective Tracing

A trace is only created when there's actual work to do (tasks due, goals to remind about). Idle ticks don't pollute the traces table.

## Scheduled Tasks

Three task types, all detected automatically from conversation via Haiku:

### Reminder
Simple recurring messages. Haiku generates a natural Telegram message from the reminder title.

```
User: "Remind me to stretch every 2 hours"
→ { task_type: "reminder", title: "Stretch reminder", interval_ms: 7200000, hour: 9, minute: 0 }
```

### Briefing
Rich daily/weekly summaries. Uses a full Claude call (not just Haiku) with the user's memories, goals, tasks, and recent alerts assembled by `buildBriefingPrompt()`.

```
User: "Give me a morning briefing every weekday at 8am"
→ { task_type: "briefing", title: "Morning briefing", hour: 8, minute: 0, days: [1,2,3,4,5] }
```

Briefing generation includes:
- Task-specific memory search (searches for memories related to the briefing title)
- Active goals with deadlines
- Other scheduled tasks
- Recent watcher alerts from the last 24 hours
- Time-of-day greeting

### Custom
AI-processed recurring tasks with a custom prompt.

```
User: "Every Friday, summarize my week"
→ { task_type: "custom", title: "Weekly summary", prompt: "Summarize the user's week...", hour: 17, minute: 0, days: [5] }
```

### Scheduling Formats

| Format | Example | Fields |
|---|---|---|
| Cron-style | Weekdays at 8:00 | `hour: 8, minute: 0, days: [1,2,3,4,5]` |
| Daily | Every day at 22:00 | `hour: 22, minute: 0` (no days = every day) |
| Interval | Every 2 hours | `interval_ms: 7200000, hour: 9, minute: 0` |

The `hour`/`minute` for interval tasks sets the first run time. All times are timezone-aware (default `Europe/Oslo`).

### Duplicate Detection

When a schedule is detected that matches an existing task (same user, bot, title, and type), the detector updates the prompt if changed or skips entirely if identical. This prevents "remind me to stretch every 2 hours" from creating duplicates if mentioned again.

## Goal Reminders & Check-ins

### Deadline Reminders
When a goal's deadline is within 24 hours and no reminder has been sent yet, Haiku generates a motivating reminder message and sends it via Telegram.

```
⏰ Deadline approaching: Ship authentication feature
Due: Friday, February 20, 8:00 AM
```

### Stale Goal Check-ins
When a goal has had no activity for 3+ days, a check-in message is sent (max 1 per tick to avoid spam). Haiku generates a supportive, non-nagging message:

```
📋 Goal check-in: Write blog post about Javrvis
How's this going?
```

## Watchers (Proactive Outreach)

Watchers are interval-based background monitors that proactively reach out when something noteworthy happens. Currently two types:

### Email Watcher
Spawns Claude Haiku with the bot's `cwd` so it has Gmail MCP access:

1. Build a Gmail query: `is:unread [filter] after:YYYY/MM/DD`
2. Haiku calls the Gmail MCP tool to search for matching emails
3. For each email, Haiku evaluates if it's worth notifying the user
4. Returns structured JSON with sender, subject, summary, and urgency

```typescript
const { result } = await spawnHaiku(prompt, "watcher-email", "jarvis-watcher", botConfig.dir);
```

### News Watcher
Polls Google News RSS feed for keyword matches:

1. Fetch RSS from `https://news.google.com/rss/search?q=<keywords>`
2. Parse XML items (title, link, pubDate, source name)
3. Filter to articles published after last run
4. Return as structured alerts (max 10 per check)

No AI needed — just RSS parsing and date filtering.

### Content Dedup

Watchers use a dual dedup strategy to prevent sending the same alert twice:

**1. ID-based:** Each alert has a unique ID (Gmail message ID, news URL). Already-notified IDs are stored in a rolling window.

**2. Content hash:** A fingerprint extracted from the alert summary itself, designed to survive Haiku's translation/rephrasing between runs:

```typescript
function contentHash(alert: WatcherAlert): string | null {
  // Extract sender from "Fra/From: Name —" pattern
  const sender = text.match(/(?:Fra|From)[:\s]*(.+?)\s*[—–-]/i)?.[1];
  // Extract proper nouns (ALL-CAPS, mid-sentence capitals, long numbers)
  const nouns = extractProperNouns(afterDash);
  return `h:${Bun.hash(`${sender}|${nouns.join(",")}`)}`;
}
```

Why content hashing? Haiku may summarize the same email differently on each run ("Meeting rescheduled" vs "Your meeting was moved"). The fingerprint captures stable elements (sender name + proper nouns) that survive rephrasing.

The rolling window holds up to 400 entries (both IDs and content hashes share the array), pruning oldest entries first.

### Alert Formatting

Alerts are formatted with type-specific icons and urgency indicators:

```
📨 Important emails
🔴 Fra: GitHub — Critical security update for your repository
🟡 Fra: HR — Annual review deadline approaching
```

### Alert Persistence

Watcher alerts are saved as assistant messages in the DB with `source: "watcher:email"` or `source: "watcher:news"`. This means:
- Claude sees recent alerts in the conversation history and can reference them
- Alerts appear in the prompt builder as "Recent watcher alerts" for the next 24 hours
- The user can ask follow-up questions about alerts

## Quiet Hours

Per-user quiet hours prevent notifications during off-hours:

```
/quiet 22-08    → No notifications between 22:00 and 08:00
```

Key features:
- **Timezone-aware:** Uses `Intl.DateTimeFormat` with the user's configured timezone
- **Overnight ranges:** `22-08` correctly spans midnight (special case: `start > end`)
- **Non-blocking:** During quiet hours, watchers still run and mark themselves as run (preventing retry storms), but skip sending the notification

```typescript
// Overnight range: 22:00 to 08:00
if (quietStart > quietEnd) {
  return now >= quietStart || now < quietEnd;  // 22,23,0,1,...,7 are quiet
}
return now >= quietStart && now < quietEnd;    // Normal range
```

## Retention Cleanup

Once per hour (tracked by timestamp, not tied to any specific tick), the scheduler purges old data:

- **Traces:** Older than `TRACING_RETENTION_DAYS` (default 7)
- **Prompt snapshots:** Older than `PROMPT_SNAPSHOTS_RETENTION_DAYS` (default 3)

## Key Files

| File | Purpose |
|---|---|
| `src/scheduler/runner.ts` | Unified tick, task execution, goal reminders/check-ins |
| `src/scheduler/detector.ts` | Schedule detection from conversation (Haiku) |
| `src/scheduler/executor.ts` | `spawnHaiku()` and `callHaiku()` subprocess helpers |
| `src/scheduler/briefing-prompt.ts` | Context assembly for briefing generation |
| `src/watchers/runner.ts` | Watcher execution, dedup, alert formatting |
| `src/watchers/email.ts` | Gmail MCP checker via Haiku |
| `src/watchers/news.ts` | Google News RSS checker |
| `src/watchers/quiet-hours.ts` | Timezone-aware quiet hours check |
| `src/db/scheduled-tasks.ts` | Task CRUD + due-now queries |
| `src/db/watchers.ts` | Watcher CRUD + due-now queries |
| `src/db/goals.ts` | Goal reminder/check-in queries |
| `src/db/user-settings.ts` | User timezone + quiet hours settings |
