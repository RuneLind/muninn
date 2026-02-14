import type { SimConversation, ConversationType } from "./state.ts";

/**
 * HTTP client for the simulator API — reusable in integration tests.
 *
 * Usage:
 *   const client = new SimulatorTestClient("http://localhost:3010");
 *   const convId = await client.createConversation("telegram_dm", "jarvis", "user-1", "tester");
 *   await client.sendMessage(convId, "Hello!");
 *   const response = await client.waitForResponse(convId);
 */
export class SimulatorTestClient {
  constructor(private baseUrl: string) {}

  async createConversation(
    type: ConversationType,
    botName: string,
    userId = "test-user-1",
    username = "tester",
    channelName?: string,
  ): Promise<string> {
    const res = await fetch(`${this.baseUrl}/simulator/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, botName, userId, username, channelName }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to create conversation: ${res.status} ${body}`);
    }
    const data = await res.json() as { conversation: SimConversation };
    return data.conversation.id;
  }

  async sendMessage(conversationId: string, text: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/simulator/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to send message: ${res.status} ${body}`);
    }
  }

  async getConversation(conversationId: string): Promise<SimConversation> {
    const res = await fetch(`${this.baseUrl}/simulator/conversations/${conversationId}`);
    if (!res.ok) {
      throw new Error(`Failed to get conversation: ${res.status}`);
    }
    const data = await res.json() as { conversation: SimConversation };
    return data.conversation;
  }

  /**
   * Polls until a bot response appears in the conversation.
   * Returns the text of the last bot message.
   */
  async waitForResponse(
    conversationId: string,
    timeoutMs = 60_000,
    pollIntervalMs = 500,
  ): Promise<string> {
    const start = Date.now();
    const initialConv = await this.getConversation(conversationId);
    const initialBotCount = initialConv.messages.filter((m) => m.sender === "bot").length;

    while (Date.now() - start < timeoutMs) {
      await Bun.sleep(pollIntervalMs);
      const conv = await this.getConversation(conversationId);
      const botMessages = conv.messages.filter((m) => m.sender === "bot");

      if (botMessages.length > initialBotCount) {
        return botMessages[botMessages.length - 1]!.text;
      }
    }

    throw new Error(`Timeout after ${timeoutMs}ms waiting for bot response`);
  }

  async listBots(): Promise<{ name: string; hasTelegram: boolean; hasSlack: boolean }[]> {
    const res = await fetch(`${this.baseUrl}/simulator/bots`);
    const data = await res.json() as { bots: any[] };
    return data.bots;
  }
}
