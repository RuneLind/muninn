# Slack Integration — Architecture & Message Flow

## Overview

The Slack integration uses `@slack/bolt` in Socket Mode. A single Bolt app handles five distinct message paths, all funneled through one central handler that calls Claude and manages side effects.

## High-Level Architecture

```mermaid
graph TB
    subgraph "Slack"
        A[Assistant DM]
        B["@mention in channel"]
        C[Thread follow-up]
        D[Direct Message]
        E[Channel message]
    end

    subgraph "index.ts — Event Routing"
        A --> H1[assistant.userMessage]
        B --> H2[app_mention]
        C --> H3["app.message (tracked thread)"]
        D --> H4["app.message (DM)"]
        E --> H5["app.message (channel listen)"]
    end

    subgraph "Filtering"
        H5 --> RF{RelevanceFilter}
        RF -->|irrelevant| DROP[Dropped]
        RF -->|relevant| HM
    end

    H1 --> HM[handleMessage]
    H2 --> HM
    H3 --> HM
    H4 --> HM

    subgraph "handler.ts — Processing Pipeline"
        HM --> AUTH{Auth check}
        AUTH -->|unauthorized| DENY[Unauthorized]
        AUTH -->|ok| PROMPT[Build prompt]
        PROMPT --> CLAUDE[Call Claude CLI]
        CLAUDE --> EXTRACT[Extract slack-post tags]
        EXTRACT --> FORMAT[Format mrkdwn]
        FORMAT --> SEND[Send response]
    end

    EXTRACT -->|"postToChannel()"| CHANNEL[Post to #channel]
    SEND --> SLACK_REPLY[Reply in conversation]
```

## Complete Message Flow

```mermaid
sequenceDiagram
    participant U as Slack User
    participant S as Slack API
    participant I as index.ts
    participant H as handler.ts
    participant DB as PostgreSQL
    participant C as Claude CLI
    participant CH as Target Channel

    U->>S: Sends message
    S->>I: Event (mention/DM/message)

    Note over I: Route to correct handler<br/>Resolve username (cached)<br/>Set up say/setStatus/postToChannel

    I->>I: Set thinking indicator
    I->>H: handleMessage(params)

    Note over H: Normalize text:<br/><#C0AD|name> → #name

    H->>H: Auth check (skip for channel_listen)
    H->>DB: Save user message
    H->>H: Build prompt (persona + memories + goals + tasks)

    Note over H: Append SLACK_POST_CAPABILITY<br/>if postToChannel provided

    H->>C: executeClaudePrompt()
    Note over C: Spawned with cwd: bots/jira-assistant/<br/>Auto-discovers .mcp.json,<br/>settings, history
    C-->>H: Response (JSON)

    H->>DB: Save assistant response

    par Async extraction (non-blocking)
        H-)H: extractMemoryAsync()
        H-)H: extractGoalAsync()
        H-)H: extractScheduleAsync()
    end

    alt Response contains <slack-post> tags
        H->>H: extractChannelPosts() (two-pass regex)
        loop Each post
            H->>I: postToChannel(channel, message)
            I->>I: resolveChannelId (cached)
            I->>S: chat.postMessage to #channel
            S->>CH: Message appears in channel
        end
        H->>H: Strip tags from response
    end

    H->>H: formatSlackMrkdwn()
    H->>I: say(formatted response)
    I->>S: Post reply
    S->>U: Response appears
```

## The Five Handler Paths

```mermaid
flowchart TD
    MSG[Incoming Slack Event] --> TYPE{Event type?}

    TYPE -->|assistant.userMessage| ASST["**1. Assistant DM**<br/>platform: slack_assistant<br/>client: app.client"]
    TYPE -->|app_mention| MENTION["**2. @mention**<br/>platform: slack_channel<br/>client: from event context"]
    TYPE -->|app.message| MSGCHECK{Message type?}

    MSGCHECK -->|tracked thread| THREAD["**3. Thread follow-up**<br/>platform: inherited from origin<br/>client: from event context"]
    MSGCHECK -->|DM channel| DM["**4. Direct Message**<br/>platform: slack_dm<br/>client: from event context"]
    MSGCHECK -->|channel msg| CHANLISTEN["**5. Channel listen**<br/>platform: slack_channel_listen<br/>client: from event context"]

    MENTION -->|side effect| ACTIVATE[Activate channel<br/>for passive listening]
    MENTION -->|side effect| TRACK1[Track thread<br/>origin: mention]
    CHANLISTEN -->|side effect| TRACK2[Track thread<br/>origin: channel_listen]

    ASST --> HANDLE[handleMessage]
    MENTION --> HANDLE
    THREAD --> HANDLE
    DM --> HANDLE
    CHANLISTEN -->|after relevance check| HANDLE

    style ASST fill:#e1f5fe
    style MENTION fill:#fff3e0
    style THREAD fill:#f3e5f5
    style DM fill:#e8f5e9
    style CHANLISTEN fill:#fce4ec
```

## Channel Listening Pipeline

When the bot is @mentioned in a channel, that channel becomes "active" for passive listening. Subsequent messages go through a 3-stage filter:

```mermaid
flowchart TD
    MSG[New message in active channel] --> S1{Stage 1:<br/>Heuristic filters}

    S1 -->|"< 10 chars"| DROP1[Dropped: too short]
    S1 -->|URL only| DROP2[Dropped: just a link]
    S1 -->|emoji only| DROP3[Dropped: just emoji]
    S1 -->|passes| S2{Stage 2:<br/>Rate limiting}

    S2 -->|"cooldown active<br/>(default 2min per channel)"| DROP4[Dropped: cooldown]
    S2 -->|"hourly cap hit<br/>(default 10/hr global)"| DROP5[Dropped: rate limit]
    S2 -->|passes| S3{Stage 3:<br/>Haiku relevance}

    S3 -->|"API call to Claude Haiku<br/>with conversation context<br/>(default 10 recent messages)"| RESULT{Relevant?}

    RESULT -->|"no"| DROP6[Dropped: not relevant]
    RESULT -->|"yes + confidence"| RESPOND[Process message]
    RESULT -->|"error"| DROP7["Dropped: fail-closed"]

    RESPOND --> HANDLE[handleMessage<br/>platform=slack_channel_listen<br/>auth bypassed]

    style DROP1 fill:#ffcdd2
    style DROP2 fill:#ffcdd2
    style DROP3 fill:#ffcdd2
    style DROP4 fill:#ffcdd2
    style DROP5 fill:#ffcdd2
    style DROP6 fill:#ffcdd2
    style DROP7 fill:#ffcdd2
    style RESPOND fill:#c8e6c9
```

### Channel Activation Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Inactive: Bot added to channel

    Inactive --> Active: Bot is @mentioned
    Active --> Active: Another @mention (refreshes TTL)
    Active --> Inactive: 7 days without @mention

    state Active {
        [*] --> Listening
        Listening --> Filtering: New message
        Filtering --> Responding: Passes 3-stage filter
        Filtering --> Listening: Filtered out
        Responding --> Cooldown: Response sent
        Cooldown --> Listening: Cooldown expires (2min)
    }
```

## postToChannel Flow

This is how Claude posts messages to specific Slack channels from any conversation:

```mermaid
sequenceDiagram
    participant C as Claude CLI
    participant H as handler.ts
    participant I as index.ts
    participant S as Slack API

    Note over C: Claude includes in response:<br/><slack-post channel="#testing"><br/>Hello world!<br/></slack-post>

    C->>H: Response with <slack-post> tags

    H->>H: extractChannelPosts() — pass 1:<br/>Complete tags (opening + closing)
    H->>H: extractChannelPosts() — pass 2:<br/>Incomplete tags (no closing tag)

    Note over H: Result: posts[] + cleanText<br/>(tags stripped from DM response)

    loop Each extracted post
        H->>H: formatSlackMrkdwn(post.message)
        H->>I: postToChannel("#testing", formatted)
        I->>I: resolveChannelId("#testing")<br/>→ paginate conversations.list<br/>→ cache result
        I->>S: chat.postMessage(channelId, text)

        alt Success
            H->>H: Log to activity feed
        else Failure
            H->>H: Append error to DM response
        end
    end

    H->>H: formatSlackMrkdwn(cleanText)
    H->>I: say(formatted cleanText)
    Note over I: User sees clean DM<br/>(without <slack-post> tags)<br/>+ any error messages
```

## Thread Tracking

```mermaid
flowchart LR
    subgraph "Thread Creation"
        MENTION["@mention in channel"] -->|"trackThread(ch, ts, 'mention')"| MAP
        LISTEN["Channel listen response"] -->|"trackThread(ch, ts, 'channel_listen')"| MAP
    end

    MAP["activeThreads Map<br/>key: channel:threadTs<br/>value: { ts, origin }"]

    subgraph "Thread Follow-up"
        REPLY[Reply in thread] -->|"getTrackedThread(ch, ts)"| CHECK{Found?}
        CHECK -->|yes| HANDLE["handleMessage()<br/>platform = inherited<br/>No @mention needed"]
        CHECK -->|no| SKIP[Ignored<br/>not our thread]
    end

    MAP --> CHECK

    subgraph "Cleanup"
        TTL["24-hour TTL"] -.->|expired| MAP
        CAP["Max 500 threads"] -.->|prune oldest| MAP
        RESTART["Process restart"] -.->|all lost| MAP
    end

    style MAP fill:#fff9c4
    style RESTART fill:#ffcdd2
```

## Thinking Indicators by Path

| Path | Method | Visual |
|---|---|---|
| Assistant DM | `setStatus("Thinking...")` | Native Slack thinking bubble |
| @mention | `assistant.threads.setStatus({status: "tenker..."})` | Native thinking bubble in thread |
| Thread follow-up | `assistant.threads.setStatus({status: "tenker..."})` | Same as @mention |
| DM (app.message) | Post `_Tenker..._` → replace with `chat.update()` | Italic text, then replaced |
| Channel listen | `assistant.threads.setStatus({status: "tenker..."})` | Native thinking bubble |

> `assistant.threads.setStatus()` requires the Slack app to have "Agent or Assistant" enabled. Always wrapped in try-catch — fails silently if not available.

## Handler Parameters Comparison

Every handler path calls `handleMessage()` with these parameters:

| Parameter | Assistant DM | @mention | Thread follow-up | DM | Channel listen |
|---|---|---|---|---|---|
| `platform` | `slack_assistant` | `slack_channel` | inherited | `slack_dm` | `slack_channel_listen` |
| `postToChannel` | `app.client` | `client` | `client` | `client` | `client` |
| `channelContext` | - | `#channel-name` | `#channel-name` | - | `#channel-name` |
| `setStatus` | Bolt's Assistant API | `assistant.threads.setStatus` | `assistant.threads.setStatus` | no-op | `assistant.threads.setStatus` |
| Auth | checked | checked | checked | checked | **bypassed** |

## Formatting Pipeline

```mermaid
flowchart LR
    CLAUDE["Claude response<br/>(markdown)"] --> EXTRACT["extractChannelPosts()<br/>Remove <slack-post> tags"]
    EXTRACT --> FORMAT["formatSlackMrkdwn()<br/>**bold** → *bold*<br/>## h2 → *h2*<br/>[t](u) → <u|t>"]
    FORMAT --> SEND["say()<br/>→ Slack API"]

    EXTRACT -->|"posts[]"| POST["postToChannel()<br/>formatSlackMrkdwn()"]
    POST --> CHANNEL["chat.postMessage()"]

    style EXTRACT fill:#fff9c4
    style FORMAT fill:#e1f5fe
```

## Configuration

Per-bot config in `bots/<name>/config.json`:

```json
{
  "model": "sonnet",
  "thinkingMaxTokens": 16000,
  "channelListening": {
    "enabled": true,
    "cooldownMs": 120000,
    "maxResponsesPerHour": 10,
    "relevanceThreshold": "medium",
    "contextMessages": 10,
    "topicHints": ["software", "IT", "AWS", "Kotlin", "React"]
  }
}
```

Environment variables (in `.env`):
```
SLACK_BOT_TOKEN_CAPRA=xoxb-...
SLACK_APP_TOKEN_CAPRA=xapp-...
SLACK_ALLOWED_USER_IDS_CAPRA=UH8RUJQLD,U12345
```
