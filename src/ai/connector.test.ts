import { test, expect, describe } from "bun:test";
import { resolveConnector } from "./connector.ts";
import type { BotConfig } from "../bots/config.ts";

const baseBotConfig: BotConfig = {
  name: "test",
  dir: "/tmp/test-bot",
  persona: "Test persona",
  telegramBotToken: "tok",
  telegramAllowedUserIds: [],
  slackAllowedUserIds: [],
};

describe("resolveConnector", () => {
  test("defaults to claude-cli when no connector specified", () => {
    const connector = resolveConnector(baseBotConfig);
    expect(typeof connector).toBe("function");
  });

  test("returns claude-cli connector explicitly", () => {
    const connector = resolveConnector({ ...baseBotConfig, connector: "claude-cli" });
    expect(typeof connector).toBe("function");
  });

  test("returns a lazy wrapper for copilot-sdk", () => {
    const connector = resolveConnector({ ...baseBotConfig, connector: "copilot-sdk" });
    expect(typeof connector).toBe("function");
  });

  test("throws for unknown connector type", () => {
    expect(() => resolveConnector({ ...baseBotConfig, connector: "unknown" as any })).toThrow(
      "Unknown connector type: unknown",
    );
  });

  test("returns same instance for repeated claude-cli calls", () => {
    const a = resolveConnector({ ...baseBotConfig, connector: "claude-cli" });
    const b = resolveConnector({ ...baseBotConfig, connector: "claude-cli" });
    expect(a).toBe(b);
  });
});
