export type ConversationType = "telegram_dm" | "slack_dm" | "slack_channel" | "slack_assistant";

export interface SimConversation {
  id: string;
  type: ConversationType;
  botName: string;
  userId: string;
  username: string;
  channelName?: string;
  messages: SimMessage[];
  status?: string;
}

export interface SimMessage {
  id: string;
  timestamp: number;
  sender: "user" | "bot";
  text: string;
  threadId?: string;
}

export type SimEvent =
  | { type: "message"; conversationId: string; message: SimMessage }
  | { type: "status"; conversationId: string; status: string }
  | { type: "conversation_created"; conversation: SimConversation };

type EventSubscriber = (event: SimEvent) => void;

/**
 * In-memory state for simulated conversations.
 * Publishes events to WebSocket subscribers.
 */
export const MAX_CONVERSATIONS = 50;

export class SimulatorState {
  private conversations = new Map<string, SimConversation>();
  private subscribers = new Set<EventSubscriber>();

  subscribe(fn: EventSubscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private publish(event: SimEvent): void {
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {
        // Ignore subscriber errors (e.g. closed WebSocket)
      }
    }
  }

  createConversation(params: {
    type: ConversationType;
    botName: string;
    userId: string;
    username: string;
    channelName?: string;
  }): SimConversation {
    // Prune oldest conversations when limit exceeded
    while (this.conversations.size >= MAX_CONVERSATIONS) {
      const oldest = this.conversations.keys().next().value;
      if (oldest) this.conversations.delete(oldest);
    }

    const id = crypto.randomUUID();
    const conversation: SimConversation = {
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

  getConversation(id: string): SimConversation | undefined {
    return this.conversations.get(id);
  }

  getConversations(): SimConversation[] {
    return Array.from(this.conversations.values());
  }

  addMessage(conversationId: string, message: SimMessage): void {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    conversation.messages.push(message);
    this.publish({ type: "message", conversationId, message });
  }

  setStatus(conversationId: string, status: string): void {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    conversation.status = status;
    this.publish({ type: "status", conversationId, status });
  }

  /** Find or create a channel conversation for cross-channel posting */
  findOrCreateChannel(botName: string, channelName: string, userId: string, username: string): SimConversation {
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
}

/** Singleton simulator state */
export const simulatorState = new SimulatorState();
