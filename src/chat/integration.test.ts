/**
 * Integration tests for the chat API.
 *
 * These tests call real Claude (slow, ~30-60s each).
 * Run separately from unit tests:
 *
 *   bun run dev &
 *   bun test src/chat/integration.test.ts
 *
 * Requires:
 * - The app running
 * - At least one bot configured (e.g. jarvis)
 * - Claude CLI authenticated
 */
import { test, expect, describe, beforeAll } from "bun:test";
import { ChatTestClient } from "./test-client.ts";

const BASE_URL = process.env.CHAT_BASE_URL ?? "http://localhost:3010";
const TIMEOUT_MS = 120_000; // Claude responses can take a while

const client = new ChatTestClient(BASE_URL);

let botName: string;

describe("Chat Integration", () => {
  beforeAll(async () => {
    // Discover available bots
    const bots = await client.listBots();
    if (bots.length === 0) {
      throw new Error("No bots available. Start the app with at least one bot configured.");
    }
    botName = bots[0]!.name;
    console.log(`Using bot: ${botName}`);
  });

  test("Telegram DM: send message and get response", async () => {
    const convId = await client.createConversation("telegram_dm", botName, "test-user-1", "integration-tester");
    await client.sendMessage(convId, "Say 'hello test' and nothing else.");
    const response = await client.waitForResponse(convId, TIMEOUT_MS);

    expect(response).toBeTruthy();
    expect(response.length).toBeGreaterThan(0);
    console.log(`Telegram DM response: ${response.slice(0, 100)}...`);
  }, TIMEOUT_MS + 5000);

  test("Slack DM: send message and get response", async () => {
    const convId = await client.createConversation("slack_dm", botName, "test-user-2", "slack-tester");
    await client.sendMessage(convId, "Say 'hello slack' and nothing else.");
    const response = await client.waitForResponse(convId, TIMEOUT_MS);

    expect(response).toBeTruthy();
    expect(response.length).toBeGreaterThan(0);
    console.log(`Slack DM response: ${response.slice(0, 100)}...`);
  }, TIMEOUT_MS + 5000);

  test("Slack channel @mention: send message and get response", async () => {
    const convId = await client.createConversation("slack_channel", botName, "test-user-3", "channel-tester", "#test-channel");
    await client.sendMessage(convId, `@${botName} Say 'hello channel' and nothing else.`);
    const response = await client.waitForResponse(convId, TIMEOUT_MS);

    expect(response).toBeTruthy();
    expect(response.length).toBeGreaterThan(0);
    console.log(`Slack channel response: ${response.slice(0, 100)}...`);
  }, TIMEOUT_MS + 5000);

  test("conversation CRUD works", async () => {
    // Create
    const convId = await client.createConversation("telegram_dm", botName);
    expect(convId).toBeTruthy();

    // Get
    const conv = await client.getConversation(convId);
    expect(conv.id).toBe(convId);
    expect(conv.type).toBe("telegram_dm");
    expect(conv.botName).toBe(botName);
    expect(conv.messages).toHaveLength(0);
  });
});
