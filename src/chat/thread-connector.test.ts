import { test, expect, describe } from "bun:test";
import type { BotConfig } from "../bots/config.ts";
import type { Connector } from "../db/connectors.ts";
import { applyThreadConnector } from "./thread-connector.ts";

const BOT: BotConfig = {
  name: "jarvis",
  dir: "/tmp/jarvis",
  persona: "p",
  telegramAllowedUserIds: [],
  slackAllowedUserIds: [],
  connector: "claude-cli",
  model: "claude-opus-5-5",
  effort: "high",
  thinkingMaxTokens: 16000,
  timeoutMs: 600000,
};

function connector(over: Partial<Connector> = {}): Connector {
  return { id: "c1", name: "fast", connectorType: "claude-cli", createdAt: 0, updatedAt: 0, ...over };
}

describe("applyThreadConnector", () => {
  test("a thread connector's effort replaces the bot's", () => {
    const merged = applyThreadConnector(BOT, connector({ model: "claude-sonnet-5-5", effort: "low" }));
    expect(merged.effort).toBe("low");
    expect(merged.model).toBe("claude-sonnet-5-5");
  });

  test("a connector with no effort keeps the bot's", () => {
    expect(applyThreadConnector(BOT, connector()).effort).toBe("high");
  });

  test("the other fields merge as before", () => {
    const merged = applyThreadConnector(
      BOT,
      connector({ connectorType: "openai-compat", baseUrl: "http://x/v1", thinkingMaxTokens: 0, timeoutMs: 5 }),
    );
    expect(merged).toMatchObject({
      connector: "openai-compat",
      model: "claude-opus-5-5",
      baseUrl: "http://x/v1",
      thinkingMaxTokens: 0,
      timeoutMs: 5,
    });
  });
});
