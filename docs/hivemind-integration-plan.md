# Plan: Connecting Muninn chat to claude-hivemind

**Status:** Proposal · **Author:** drafted with Claude · **Date:** 2026-04-28

## Goal

Let Muninn bots talk to other Claude Code / OpenCode instances on the same
machine through [claude-hivemind](https://github.com/.../claude-hivemind), so
that:

1. The **melosys** bot can ask **huginn** (and later **yggdrasil**) to improve
   the search index, fix retrieval bugs, or run code investigations on its
   behalf — autonomously, while the bot is analyzing a Jira ticket.
2. The bot can also reach peers in **other namespaces** (e.g. an `nav` peer
   running review/implementation agents), not just its own.
3. Conversations can be long-running and bidirectional — peers may take
   minutes to reply, and replies should land in the chat thread, not get
   dropped.

## Why not "just add the MCP entry"?

The off-the-shelf integration would be: drop `claude-hivemind` into
`bots/melosys/.mcp.json` and spawn the CLI with `CLAUDE_HIVEMIND=1`. That
falls short of the goal for three reasons:

- **Single-namespace lock-in.** Hivemind derives the namespace from the
  spawning process's CWD. The melosys bot runs in
  `~/source/private/muninn/bots/melosys` → namespace `private`. We'd never
  see `nav` peers.
- **No reply path.** The `notifications/claude/channel` push is a
  Claude-Code-only feature, gated behind
  `--dangerously-load-development-channels`. Our `copilot-sdk` and
  `openai-compat` connectors can't receive it. Peer replies that arrive
  after the bot's turn ends would be lost.
- **No persistence.** Hivemind keeps message history in its own SQLite, but
  we want messages threaded into the bot's conversation history, with
  embeddings, traces, and the full Muninn audit trail.

The plan below treats Muninn itself as the hivemind peer, with bots
multiplexed on top.

## High-level architecture

```mermaid
graph TB
    subgraph "Muninn process"
        Bot[Melosys bot<br/>copilot-sdk]
        Hive[hivemind/client.ts<br/>multi-namespace]
        Chat[Chat state<br/>+ threads]
        Tools[Hivemind MCP shim<br/>ask_peer / send_to_peer]
    end

    subgraph "Hivemind broker (localhost:7899)"
        Broker[Broker daemon]
    end

    subgraph "namespace: private"
        Huginn[huginn<br/>Claude Code]
    end

    subgraph "namespace: nav"
        NavRev[nav-review<br/>Claude Code]
        Yggdra[yggdrasil dev<br/>Claude Code]
    end

    Bot -->|tool call| Tools
    Tools -->|enqueue| Hive
    Hive <-->|WS peer: private| Broker
    Hive <-->|WS peer: nav| Broker
    Broker <--> Huginn
    Broker <--> NavRev
    Broker <--> Yggdra

    Hive -->|inbound msg| Chat
    Chat -->|reactivate bot| Bot

    style Hive fill:#1f2937,stroke:#58a6ff,color:#e6edf3
    style Broker fill:#1f2937,stroke:#58a6ff,color:#e6edf3
```

Key idea: **one Muninn process opens N WebSocket connections to the broker —
one per namespace it wants to participate in**. Each WebSocket is its own
peer with its own peer ID. From hivemind's perspective, Muninn looks like
several normal peers; from Muninn's perspective, it's one client with a
namespace-aware routing table.

## Multi-namespace registration

The broker doesn't validate that a registered namespace matches the
client's CWD — it just trusts the `namespace` field in the `register`
message (`shared/types.ts:49-63`). So we can register under any name.

```mermaid
sequenceDiagram
    participant M as Muninn (boot)
    participant B as Broker

    M->>M: read bots/melosys/config.json<br/>hivemind.namespaces = ["private", "nav"]
    M->>B: WS connect /ws/peer?namespace=private
    B-->>M: registered (peer_id = ABC, ns = private)
    M->>B: WS connect /ws/peer?namespace=nav
    B-->>M: registered (peer_id = XYZ, ns = nav)
    M->>B: set_summary("Melosys bot — Jira analysis", on ABC)
    M->>B: set_summary("Melosys bot — cross-team review", on XYZ)
```

Per-bot config in `bots/<name>/config.json`:

```json
{
  "hivemind": {
    "enabled": true,
    "namespaces": ["private", "nav"],
    "summary": "Melosys assistant — analyzes Jira, asks peers for help",
    "autoRespondPeers": ["huginn", "yggdrasil"]
  }
}
```

| Field | Purpose |
|---|---|
| `enabled` | Master switch. Default off — opt-in per bot. |
| `namespaces` | List of namespaces to join. One WS per entry. |
| `summary` | Initial `set_summary` value. Visible to peers. |
| `autoRespondPeers` | Peer-name allowlist for autonomous replies. Messages from peers **not** in this list arrive but require manual user reply (safety). |

## Outbound: bot calls a peer

The bot gets two new MCP tools (provided by an in-process MCP shim, **not**
the standalone `claude-hivemind` MCP). They live in
`src/hivemind/mcp-tools.ts` and are wired into the bot's existing
`.mcp.json` synthesis path:

| Tool | Behavior |
|---|---|
| `ask_peer(to, message, wait_seconds=120)` | **Blocks within the turn.** Sends `message`, waits up to `wait_seconds` for a reply, returns the reply as the tool result. Use for "is the index up to date?" — quick Q&A while the peer is online. |
| `send_to_peer(to, message)` | **Fire-and-forget.** Returns immediately. Reply (if any) arrives asynchronously and triggers a new bot turn. Use for "please regenerate the embeddings for the Melosys collection" — long task, bot continues without waiting. |
| `list_peers(namespace?)` | Returns peers across all joined namespaces (or a specific one). |

```mermaid
sequenceDiagram
    participant B as Melosys bot
    participant T as Hivemind MCP shim
    participant H as hivemind/client.ts
    participant Br as Broker
    participant P as huginn peer

    B->>T: ask_peer(to=huginn, msg="re-index now?", wait=120)
    T->>H: enqueueAsk(...)
    H->>Br: send_message
    Br->>P: deliver (channel notification)
    P->>P: Claude responds
    P->>Br: send_message (reply)
    Br->>H: deliver to Muninn peer
    H->>T: resolve pending ask
    T-->>B: tool result: "yes, started, ETA 3 min"
    B->>B: continue analysis with that info
```

For `ask_peer`, the shim keeps an in-memory map of `{peer_id → resolver}`
and resolves it when an inbound message from that peer arrives. Timeout
returns a tool result of `"no reply within 120s — try send_to_peer"` so
the bot can decide what to do.

## Inbound: peer message arrives

This is the critical bit for long-running back-and-forth. Two cases:

**Case 1 — reply to a pending `ask_peer`.** Resolved silently inside the
shim (above sequence). Bot sees it as the tool result.

**Case 2 — unsolicited message, or async reply to `send_to_peer`.** No
pending tool call. The message becomes a new turn in a dedicated thread.

```mermaid
sequenceDiagram
    participant P as huginn peer
    participant Br as Broker
    participant H as hivemind/client.ts
    participant TM as ThreadManager
    participant Proc as message-processor
    participant B as Melosys bot

    P->>Br: send_message(to=Muninn-peer-ABC, "index rebuilt, +12% recall")
    Br->>H: deliver
    H->>H: lookup pending ask_peer(huginn) — none
    H->>TM: get/create thread "peer:huginn"
    TM->>TM: persist as inbound message<br/>(sender = "peer:huginn")
    H->>Proc: if huginn ∈ autoRespondPeers → process as user message
    Proc->>B: build prompt + run connector
    B->>Proc: response
    Proc->>H: outbound via send_to_peer if needed
    Note over TM: chat UI shows the exchange<br/>in the "peer:huginn" thread
```

Each peer gets its own thread (`peer:<peer-name>`) per bot, separate from
human chat threads. The chat page renders these like any other thread —
you can read the conversation, jump in, take over, mute the auto-respond.

## Blocking vs async — recommendation

You asked about this. I recommend **both, with `ask_peer` as the default
for in-turn questions and `send_to_peer` for long tasks**. Three reasons:

1. **Bot ergonomics.** Most "talk to peer" cases during Jira analysis are
   short Q&A: *"is the index for collection X up to date?"*. Blocking with a
   2-minute timeout matches what the bot expects from any other tool.
2. **Async is essential for the huginn use case.** "Please fix the indexer
   bug and rerun" takes minutes-to-hours. The bot's turn must end so the
   user sees the analysis-so-far, and huginn's reply lands as a new
   message later.
3. **Failure mode is graceful.** `ask_peer` timing out doesn't break the
   turn — the tool returns a hint to switch to `send_to_peer`. The bot can
   recover.

### Loop-prevention guardrails

Auto-respond is the dangerous knob. To stop runaway exchanges:

- Hard cap: **max 20 auto-respond turns per peer thread per hour**, then
  the thread requires manual unmute.
- Cost cap: per-thread token budget (reuse `haiku_usage` table pattern).
- Kill switch: chat UI button "Pause auto-respond" per thread.
- Audit: every inbound and outbound peer message gets a `traces` entry so
  you can see the full chain in the waterfall view.

## Per-bot config schema (full)

```json
{
  "hivemind": {
    "enabled": true,
    "namespaces": ["private", "nav"],
    "summary": "Melosys — Jira analysis, asks peers for help",
    "autoRespondPeers": ["huginn", "yggdrasil"],
    "maxAutoTurnsPerHour": 20,
    "askPeerDefaultTimeoutSec": 120,
    "exposeToTools": true
  }
}
```

`exposeToTools: true` adds `ask_peer` / `send_to_peer` / `list_peers` to
the bot's tool list. Set to `false` if you want Muninn-as-peer for
inbound-only (you talk to peers from the chat UI, but the bot can't
initiate outbound).

## Module plan

New files:

| Path | Role |
|---|---|
| `src/hivemind/client.ts` | Multi-namespace WS client. One connection per namespace. Reconnect with backoff (mirror `server.ts:178-198`). Heartbeat every 30s. |
| `src/hivemind/types.ts` | Re-export of `claude-hivemind/src/shared/types.ts` (or thin copy if we don't want a workspace dep). |
| `src/hivemind/router.ts` | Inbound message router: dispatch to pending `ask_peer` resolvers, else create/append to peer thread. |
| `src/hivemind/mcp-tools.ts` | In-process MCP server exposing `ask_peer` / `send_to_peer` / `list_peers`. Wired into bot startup so each bot has its own instance with the right namespace scope. |
| `src/hivemind/config.ts` | Schema + parser for `bots/<name>/config.json` `hivemind` block. |
| `src/hivemind/loop-guard.ts` | Per-thread turn counter + token budget enforcement. |
| `src/hivemind/client.test.ts` | WS reconnect, multi-namespace registration, heartbeat. |
| `src/hivemind/router.test.ts` | Pending ask resolution, thread routing, autorespond gating. |

Modified files:

| Path | Change |
|---|---|
| `src/index.ts` | Boot `HivemindClient` after DB init; wire to chat state. |
| `src/bots/config.ts` | Parse `hivemind` block from `config.json`. |
| `src/chat/state.ts` | Add `peer:` thread namespace; mark inbound peer messages with `sender: "peer"`. |
| `src/chat/views/components/thread-manager.ts` | Render peer threads with a robot icon + "Pause auto-respond" toggle. |
| `src/dashboard/views/page.ts` | Add hivemind status panel: connected namespaces, peer count, recent peer activity. |
| `src/ai/connectors/copilot-mcp.ts` | If `hivemind.exposeToTools`, append the in-process MCP shim to the SDK's tool list. (claude-cli connector picks it up automatically via `.mcp.json` synthesis.) |

DB:

| Table | Change |
|---|---|
| `threads` | New row type — name pattern `peer:<peer-name>`, no FK to `users` (peer thread is bot-owned). |
| `messages` | New `sender` value `"peer"` with `from_peer_id` column (nullable, only set for peer messages). |
| Migration | `db/migrations/NNN_hivemind_peer_messages.sql` — add `from_peer_id TEXT NULL` to `messages`. |

## Phased rollout

```mermaid
graph LR
    P1[Phase 1<br/>Outbound only<br/>melosys → huginn] --> P2[Phase 2<br/>Inbound + threading<br/>peer thread UI]
    P2 --> P3[Phase 3<br/>Auto-respond<br/>+ guardrails]
    P3 --> P4[Phase 4<br/>Cross-namespace<br/>melosys ↔ nav]
    P4 --> P5[Phase 5<br/>yggdrasil + others]
```

**Phase 1 (1–2 days).** WS client, single namespace (`private`), `ask_peer`
+ `send_to_peer` + `list_peers` tools. No inbound handling beyond
resolving pending `ask_peer`. Manual test: melosys bot asks huginn a
question during Jira analysis.

**Phase 2 (1 day).** Inbound router + peer threads in chat UI. No
auto-respond yet — peer messages just appear in the thread, you reply
manually.

**Phase 3 (1 day).** `autoRespondPeers` allowlist + loop guards + traces
integration. Now huginn can autonomously fix things on melosys's request.

**Phase 4 (½ day).** Add second namespace registration to melosys config
(`["private", "nav"]`). Verify cross-namespace `list_peers` and routing
works.

**Phase 5 (when ready).** Onboard yggdrasil. Mostly a config change unless
yggdrasil has its own quirks.

## Risks & open questions

1. **Multiple Muninn peers in the same namespace.** If you run two Muninn
   instances (dev + prod), both register peers with the same `cwd`/git
   root but different PIDs. Hivemind's dashboard handles this — we just
   need to make sure our peer summary disambiguates ("muninn-dev" vs
   "muninn-prod"). Solution: append `process.pid` to the summary.

2. **Broker not running when Muninn boots.** Hivemind auto-starts the
   broker when an MCP server detects it's gone (`server.ts:112-132`). We
   should mirror this: if connect fails, spawn `bun
   ~/source/private/claude-hivemind/src/broker.ts` ourselves, then retry.
   Path is configurable via env (`HIVEMIND_BROKER_SCRIPT`).

3. **`ask_peer` blocking the connector.** The Claude CLI tool call is
   synchronous from Claude's perspective — it'll wait happily for 2
   minutes. The copilot-sdk and openai-compat connectors also support
   long tool calls. Verified safe.

4. **Cost.** Auto-respond + huginn doing real work = real LLM cost on the
   peer side. The token budget guard helps, but worth monitoring with the
   existing `haiku_usage` dashboard.

5. **Trust boundary.** A peer in the `nav` namespace can send arbitrary
   text to melosys's bot. If `autoRespondPeers` includes that peer, that
   text becomes a prompt. Threat model is "peer is friendly but might
   misbehave" — same as any tool output. The persona's system prompt
   should not blindly trust peer messages with elevated authority. Worth
   adding a paragraph to bot personas that mentions peer messages.

6. **Channel push compatibility.** Pure Muninn-as-peer doesn't need the
   `claude/channel` extension, so we're not blocked on Claude Code 2.1.80
   or the dangerously-load flag. The peers we talk to (huginn, yggdrasil)
   need that flag for *them* to receive our messages — that's their setup,
   not ours.

## Confirmed decisions (2026-04-28)

- **Namespaces for melosys:** `["private", "nav"]`.
- **Autorespond default:** off — allowlist-only via `autoRespondPeers`.
- **Hivemind install path:** `~/source/private/claude-hivemind`. The
  broker auto-start path will use `bun
  ~/source/private/claude-hivemind/src/broker.ts`, overridable via
  `HIVEMIND_BROKER_SCRIPT` env var.
- **Phase 1 greenlit.**
