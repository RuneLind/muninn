import { getSimConversations, getSimMessages } from "../db/messages.ts";
import { formatWebHtml } from "../web/web-format.ts";
import type { McpServerStatus } from "../ai/mcp-status.ts";
import type { DevRun, DevRunHandoff, DevRunEvent } from "../db/dev-runs.ts";

export type ConversationType = "telegram_dm" | "slack_dm" | "slack_channel" | "slack_assistant" | "web";

export interface ChatConversation {
  id: string;
  type: ConversationType;
  botName: string;
  userId: string;
  username: string;
  channelName?: string;
  messages: ChatMessage[];
  status?: string;
}

export interface ChatMessage {
  id: string;
  timestamp: number;
  sender: "user" | "bot" | "peer";
  text: string;
  threadId?: string | null;
  /** Hivemind peer ID — only set for `sender: "peer"` messages. */
  fromPeerId?: string | null;
  /** Model that produced this turn — shown in the message header (bot messages). */
  model?: string | null;
}

export function roleToSender(role: string): ChatMessage["sender"] {
  if (role === "user") return "user";
  if (role === "peer") return "peer";
  return "bot";
}

export type ChatEvent =
  | { type: "message"; conversationId: string; message: ChatMessage }
  | { type: "status"; conversationId: string; status: string }
  | { type: "conversation_created"; conversation: ChatConversation }
  | { type: "text_delta"; conversationId: string; delta: string; threadId?: string | null }
  | { type: "stream_clear"; conversationId: string; threadId?: string | null }
  | { type: "intent"; conversationId: string; text: string; threadId?: string | null }
  | { type: "tool_status"; conversationId: string; text: string; threadId?: string | null; name?: string; displayName?: string }
  | { type: "tool_end"; conversationId: string; threadId?: string | null; name: string; displayName: string; tokensEstimate?: number }
  | { type: "usage_progress"; conversationId: string; threadId?: string | null; inputTokens: number; outputTokens: number; model?: string }
  | { type: "response_meta"; conversationId: string; threadId?: string | null; messageId?: string; clientMessageId?: string; inputTokens: number; outputTokens: number; contextTokens?: number; contextWindow?: number; cacheReadTokens?: number; cacheCreationTokens?: number; durationMs: number; costUsd: number; model: string; numTurns: number; toolCalls?: { name: string; displayName: string; durationMs: number; tokensEstimate?: number }[] }
  | { type: "mcp_status"; botName: string; servers: McpServerStatus[] }
  | { type: "dev_run"; conversationId: string; run: DevRun; handoffs: DevRunHandoff[] }
  | { type: "dev_run_event"; conversationId: string; runId: string; threadId?: string; event: DevRunEvent };

type EventSubscriber = (event: ChatEvent) => void;

/** Deterministic conversation ID from a composite key (e.g. "userId:botName:platform"). */
async function deterministicId(key: string): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(hashBuffer))
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * How many conversations keep their message history in memory.
 *
 * This used to be a cap on the conversation MAP, and eviction deleted the whole
 * shell. That was a permanent 404 for the owner and, worse, a silent write loss:
 * `addMessage` returns early on a missing shell, so a reply to an evicted
 * conversation vanished without an error anywhere. Nothing could rebuild it
 * either — `hydrateFromDb` runs once at boot and addresses conversations by a
 * deterministic id, which a `crypto.randomUUID()` shell can never match.
 *
 * So the cap now bounds the thing that actually costs memory — the message
 * arrays — and the shells stay. A shell is a handful of scalars next to a message
 * list that grows without bound; the map is bounded in practice by
 * users × bots × platforms, and `hydrateFromDb` has always inserted that many at
 * boot without consulting any cap, so this is not a new property.
 */
export const MAX_CONVERSATIONS = 50;

/**
 * In-memory state for chat conversations.
 * Publishes events to WebSocket subscribers.
 */
export class ChatState {
  private conversations = new Map<string, ChatConversation>();
  private subscribers = new Set<EventSubscriber>();

  subscribe(fn: EventSubscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private publish(event: ChatEvent): void {
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {
        // Ignore subscriber errors (e.g. closed WebSocket)
      }
    }
  }

  /**
   * Reclaim memory from the least-recently-used conversations, keeping at most
   * {@link MAX_CONVERSATIONS} of them hydrated with messages.
   *
   * Called from `addMessage` on the 0→1 message transition (the only event that
   * can breach a cap counted in message arrays) and once at the end of
   * `hydrateFromDb`. Map preserves insertion order and `touch()` re-inserts on
   * access, so the conversations still holding messages are in LRU order and the
   * front of that list is what gets trimmed. **The shell is never dropped** — see
   * {@link MAX_CONVERSATIONS} for why deleting it was the bug. A trimmed
   * conversation still resolves, still accepts messages, and its history is
   * still readable: `GET /chat/conversations/:id/messages` reads the DB, not
   * this array.
   */
  private trimHydratedMessages(): void {
    const hydrated: ChatConversation[] = [];
    for (const conv of this.conversations.values()) {
      if (conv.messages.length > 0) hydrated.push(conv);
    }
    const excess = hydrated.length - MAX_CONVERSATIONS;
    for (let i = 0; i < excess; i++) hydrated[i]!.messages = [];
  }

  /** Mark a conversation as most-recently-used by re-inserting it at the tail
   *  of the Map (LRU ordering). No-op if the id is unknown. */
  private touch(id: string): void {
    const conv = this.conversations.get(id);
    if (!conv) return;
    this.conversations.delete(id);
    this.conversations.set(id, conv);
  }

  /**
   * Create a conversation with a random id.
   *
   * **Not for `web`.** A web conversation must be addressable by
   * `deterministicId("<userId>:<botName>:web")` — that is the id `hydrateFromDb`
   * rebuilds it under after a restart and the id every off-band broadcaster
   * computes via {@link botConversationId}. Use
   * {@link findOrCreateBotConversation} for those; this stays for the platform
   * shells (telegram/slack DMs and channels), which are addressed only by the
   * live object.
   */
  createConversation(params: {
    type: ConversationType;
    botName: string;
    userId: string;
    username: string;
    channelName?: string;
  }): ChatConversation {
    const id = crypto.randomUUID();
    const conversation: ChatConversation = {
      id,
      type: params.type,
      botName: params.botName,
      userId: params.userId,
      username: params.username,
      channelName: params.channelName,
      messages: [],
    };
    this.conversations.set(id, conversation);
    this.publish({ type: "conversation_created", conversation });
    return conversation;
  }

  deleteConversation(id: string): boolean {
    return this.conversations.delete(id);
  }

  /** Clear all conversations and state */
  clear(): void {
    this.conversations.clear();
  }

  getConversation(id: string): ChatConversation | undefined {
    const conv = this.conversations.get(id);
    if (conv) this.touch(id);
    return conv;
  }

  getConversations(): ChatConversation[] {
    return Array.from(this.conversations.values());
  }

  addMessage(conversationId: string, message: ChatMessage): void {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    // The 0→1 transition is what puts a conversation UNDER the cap, and it is the
    // only moment worth re-checking: creating a shell cannot breach a cap counted
    // in message arrays (a new shell holds none), and web conversations stop being
    // created after a user's first turn with a bot — so trimming on creation left
    // the count growing unbounded on exactly the long-running instance the cap is
    // for. Measured before the fix: 70 conversations holding messages at a cap
    // of 50.
    const wasEmpty = conversation.messages.length === 0;
    conversation.messages.push(message);
    this.touch(conversationId); // most-recently-active → last to be trimmed
    if (wasEmpty) this.trimHydratedMessages();
    this.publish({ type: "message", conversationId, message });
  }

  /**
   * Append a bot-authored message to a conversation. Wraps `addMessage` to keep
   * the ChatMessage shape co-located so callers (chat processor, hivemind
   * autorespond) don't drift if the shape changes.
   *
   * **Returns the throwaway client id it minted.** The DB row id does not exist
   * yet when a live turn's bubble is rendered — it arrives later, on
   * `response_meta` — so this id is the only thing that names THAT bubble.
   * Handing it back is what lets `processChatMessage` echo it on the meta event,
   * so the client can resolve the node it actually created instead of guessing
   * "the last `.msg-bot`" (which is a different message the moment two turns
   * finish out of order — see `showResponseMeta`).
   */
  appendBotMessage(conversationId: string, text: string, threadId?: string | null): string {
    const id = crypto.randomUUID();
    this.addMessage(conversationId, {
      id,
      timestamp: Date.now(),
      sender: "bot",
      text,
      threadId: threadId ?? null,
    });
    return id;
  }

  setStatus(conversationId: string, status: string): void {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    conversation.status = status;
    this.publish({ type: "status", conversationId, status });
  }

  /** Broadcast a text delta to subscribers (ephemeral — no state mutation) */
  publishTextDelta(conversationId: string, delta: string, threadId?: string | null): void {
    this.publish({ type: "text_delta", conversationId, delta, threadId });
  }

  /** Signal subscribers to clear any streaming bubble (e.g. when tool calls start) */
  publishStreamClear(conversationId: string, threadId?: string | null): void {
    this.publish({ type: "stream_clear", conversationId, threadId });
  }

  /** Broadcast an intent update (what the AI plans to do) */
  publishIntent(conversationId: string, text: string, threadId?: string | null): void {
    this.publish({ type: "intent", conversationId, text, threadId });
  }

  /** Broadcast a tool status update (appended as separate lines in the UI). */
  publishToolStatus(
    conversationId: string,
    text: string,
    threadId?: string | null,
    name?: string,
    displayName?: string,
  ): void {
    this.publish({ type: "tool_status", conversationId, text, threadId, name, displayName });
  }

  /** Broadcast a tool completion with the result-size token estimate. */
  publishToolEnd(
    conversationId: string,
    info: { name: string; displayName: string; tokensEstimate?: number },
    threadId?: string | null,
  ): void {
    this.publish({
      type: "tool_end",
      conversationId,
      threadId,
      name: info.name,
      displayName: info.displayName,
      tokensEstimate: info.tokensEstimate,
    });
  }

  /** Broadcast per-turn token usage while a response is in flight */
  publishUsageProgress(
    conversationId: string,
    usage: { inputTokens: number; outputTokens: number; model?: string },
    threadId?: string | null,
  ): void {
    this.publish({
      type: "usage_progress",
      conversationId,
      threadId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      model: usage.model,
    });
  }

  /** Broadcast MCP server status for a bot (every open chat tab updates) */
  publishMcpStatus(botName: string, servers: McpServerStatus[]): void {
    this.publish({ type: "mcp_status", botName, servers });
  }

  /** Broadcast a dev_run roll-up (spec-driven dev loop, Phase 5) so the research
   *  card's live run state + per-handoff rows update without a page refresh. The
   *  client filters by conversationId + the run's threadId. */
  publishDevRun(conversationId: string, run: DevRun, handoffs: DevRunHandoff[]): void {
    this.publish({ type: "dev_run", conversationId, run, handoffs });
  }

  /** Broadcast a single non-terminal progress note (Phase B) so the inspector
   *  Agents tab's live discoveries timeline appends it without a refresh. Mirrors
   *  `publishDevRun`; the client filters by conversationId + the run's threadId,
   *  and keys the event into its per-run `devRunEvents` list by runId. */
  publishDevRunEvent(conversationId: string, runId: string, event: DevRunEvent, threadId?: string): void {
    this.publish({ type: "dev_run_event", conversationId, runId, threadId, event });
  }

  /** Broadcast response metadata (tokens, timing) after a response completes */
  publishResponseMeta(conversationId: string, meta: {
    threadId?: string | null;
    /** DB id of the persisted assistant message — anchors the web 👍/👎 control. */
    messageId?: string;
    /**
     * The THROWAWAY id of the bubble this turn rendered (`appendBotMessage`).
     *
     * The client stamps it on the node it creates, so `response_meta` can
     * resolve that exact node rather than "the last `.msg-bot` in the list".
     * Positional resolution is wrong whenever two turns are in flight in one
     * thread — an ordinary message sent while a 60–600 s Jira draft turn runs
     * produces two metas, and the later one stamped the earlier turn's draft id
     * onto an unrelated reply.
     */
    clientMessageId?: string;
    inputTokens: number;
    outputTokens: number;
    contextTokens?: number;
    contextWindow?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    durationMs: number;
    costUsd: number;
    model: string;
    numTurns: number;
    toolCalls?: { name: string; displayName: string; durationMs: number; tokensEstimate?: number }[];
  }): void {
    this.publish({
      type: "response_meta",
      conversationId,
      threadId: meta.threadId,
      messageId: meta.messageId,
      clientMessageId: meta.clientMessageId,
      inputTokens: meta.inputTokens,
      outputTokens: meta.outputTokens,
      contextTokens: meta.contextTokens,
      contextWindow: meta.contextWindow,
      cacheReadTokens: meta.cacheReadTokens,
      cacheCreationTokens: meta.cacheCreationTokens,
      durationMs: meta.durationMs,
      costUsd: meta.costUsd,
      model: meta.model,
      numTurns: meta.numTurns,
      toolCalls: meta.toolCalls,
    });
  }

  /**
   * Hydrate conversations from database on startup.
   * Creates deterministic conversation IDs from (userId, botName, platform)
   * so they're stable across restarts.
   */
  async hydrateFromDb(): Promise<number> {
    // `getSimConversations` is `ORDER BY created_at DESC`, i.e. NEWEST first —
    // the opposite of this Map's ordering contract, where `touch()` re-inserts at
    // the tail so the FRONT is the least-recently-used end. Inserting newest-first
    // would make the trim below reclaim the busiest conversations and keep the
    // stalest, and would hand every other order-sensitive reader the same
    // inversion. Reversed here, once, rather than special-cased downstream.
    const convRows = (await getSimConversations()).slice().reverse();
    let count = 0;

    for (const row of convRows) {
      // Deterministic ID from the conversation tuple
      const id = await deterministicId(`${row.userId}:${row.botName}:${row.platform}`);

      // Skip if already exists in memory (in-memory takes priority)
      if (this.conversations.has(id)) continue;

      // Map platform to ConversationType
      const type = platformToConversationType(row.platform);
      if (!type) continue;

      // Load messages
      const msgs = await getSimMessages(row.userId, row.botName, row.platform);

      const isWebPlatform = type === "web";
      const conversation: ChatConversation = {
        id,
        type,
        botName: row.botName,
        userId: row.userId,
        username: row.username ?? "chat-user",
        messages: msgs.map((m) => ({
          id: m.id,
          timestamp: m.createdAt,
          sender: roleToSender(m.role),
          text: isWebPlatform && m.role === "assistant" ? formatWebHtml(m.content) : m.content,
          threadId: m.threadId,
          fromPeerId: m.fromPeerId,
          model: m.model,
        })),
      };

      this.conversations.set(id, conversation);
      count++;
    }

    // Once, at the end rather than per row (which would be quadratic): boot is
    // the one path that can load far more history than the cap allows, and
    // without this the class invariant — at most MAX_CONVERSATIONS conversations
    // holding messages — would be false from the moment the process starts.
    this.trimHydratedMessages();

    return count;
  }

  /** Find or create a channel conversation for cross-channel posting */
  findOrCreateChannel(botName: string, channelName: string, userId: string, username: string): ChatConversation {
    // Look for an existing channel conversation with this name and bot
    for (const conv of this.conversations.values()) {
      if (conv.type === "slack_channel" && conv.botName === botName && conv.channelName === channelName) {
        return conv;
      }
    }
    // Create a new one
    return this.createConversation({
      type: "slack_channel",
      botName,
      userId,
      username,
      channelName,
    });
  }

  /** Deterministic web-conversation id for a (userId, botName) — the same id
   *  hydrateFromDb / findOrCreateBotConversation use, computed WITHOUT creating a
   *  conversation. Lets off-band broadcasters (dev_run roll-ups from the inbound
   *  hivemind router) address the right conversation even when no in-memory shell
   *  exists yet. */
  async botConversationId(userId: string, botName: string): Promise<string> {
    return deterministicId(`${userId}:${botName}:web`);
  }

  /** Same deterministic ID as hydrateFromDb so the conversation merges with hydrated state. */
  async findOrCreateBotConversation(params: {
    botName: string;
    userId: string;
    username?: string;
  }): Promise<ChatConversation> {
    const id = await this.botConversationId(params.userId, params.botName);
    const existing = this.conversations.get(id);
    if (existing) {
      // Refresh a stale/placeholder name once a real one is known (e.g. a peer
      // reply recreated the shell as "chat-user" before the user's row had a
      // name). Never downgrade a real name back to the placeholder.
      if (params.username && params.username !== "chat-user" && existing.username !== params.username) {
        existing.username = params.username;
      }
      this.touch(id); // active conversation → last to be evicted
      return existing;
    }

    const conversation: ChatConversation = {
      id,
      type: "web",
      botName: params.botName,
      userId: params.userId,
      username: params.username ?? "chat-user",
      messages: [],
    };
    this.conversations.set(id, conversation);
    this.publish({ type: "conversation_created", conversation });
    return conversation;
  }
}

/** Map DB platform string to ConversationType */
function platformToConversationType(platform: string): ConversationType | null {
  switch (platform) {
    case "telegram": return "telegram_dm";
    case "slack_dm": return "slack_dm";
    case "slack_channel": return "slack_channel";
    case "slack_assistant": return "slack_assistant";
    case "web": return "web";
    default: return null;
  }
}

/** Singleton chat state */
export const chatState = new ChatState();
