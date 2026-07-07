import { test, expect, beforeEach, mock } from "bun:test";
import type { Config } from "../config.ts";
import type { BotConfig, ConnectorType } from "../bots/config.ts";

// Capture what resolveConnector was handed and what the resolved connector was
// called with, so we can assert the dispatch/adapter behaviour without spawning
// anything real.
let resolvedWith: BotConfig | undefined;
let connectorArgs:
  | { prompt: string; config: unknown; botConfig: BotConfig; systemPrompt?: string; onProgress?: unknown }
  | undefined;

mock.module("./connector.ts", () => ({
  resolveConnector: (botConfig: BotConfig) => {
    resolvedWith = botConfig;
    return async (
      prompt: string,
      config: unknown,
      bot: BotConfig,
      systemPrompt?: string,
      onProgress?: unknown,
    ) => {
      connectorArgs = { prompt, config, botConfig: bot, systemPrompt, onProgress };
      return { result: "ok", outputTokens: 1, inputTokens: 1, wallClockMs: 1 };
    };
  },
}));

const { executeOneShot, connectorCapabilities } = await import("./one-shot.ts");

const config = { claudeModel: "sonnet", claudeTimeoutMs: 120_000 } as unknown as Config;

function stubBot(over: Partial<BotConfig> = {}): BotConfig {
  return { name: "b", dir: "/tmp/b", persona: "", telegramAllowedUserIds: [], slackAllowedUserIds: [], ...over } as BotConfig;
}

beforeEach(() => {
  resolvedWith = undefined;
  connectorArgs = undefined;
});

test("connectorCapabilities: only claude-cli (and the unset default) supports extraDirs", () => {
  expect(connectorCapabilities(stubBot()).supportsExtraDirs).toBe(true); // unset ⇒ claude-cli
  expect(connectorCapabilities(stubBot({ connector: "claude-cli" })).supportsExtraDirs).toBe(true);
  for (const c of ["copilot-sdk", "openai-compat", "claude-sdk"] as ConnectorType[]) {
    expect(connectorCapabilities(stubBot({ connector: c })).supportsExtraDirs).toBe(false);
  }
});

test("dispatches through resolveConnector, forwarding prompt/config/systemPrompt/onProgress", async () => {
  const bot = stubBot({ connector: "copilot-sdk" });
  const onProgress = () => {};
  const res = await executeOneShot("hello", config, bot, { systemPrompt: "sys", onProgress });

  expect(res.result).toBe("ok");
  expect(resolvedWith?.connector).toBe("copilot-sdk"); // routed by the bot's connector
  expect(connectorArgs?.prompt).toBe("hello");
  expect(connectorArgs?.config).toBe(config);
  expect(connectorArgs?.systemPrompt).toBe("sys");
  expect(connectorArgs?.onProgress).toBe(onProgress);
});

test("timeoutMs is folded into a botConfig clone, never mutating the caller's config", async () => {
  const bot = stubBot();
  await executeOneShot("p", config, bot, { timeoutMs: 600_000 });

  expect(connectorArgs?.botConfig.timeoutMs).toBe(600_000);
  expect(connectorArgs?.botConfig).not.toBe(bot); // cloned
  expect(bot.timeoutMs).toBeUndefined(); // original untouched
});

test("extraDirs append --add-dir spawnArgs for the CLI connector (preserving existing args)", async () => {
  const bot = stubBot({ connector: "claude-cli", spawnArgs: ["--strict-mcp-config"] });
  await executeOneShot("p", config, bot, { extraDirs: ["/tmp/frames"] });

  expect(connectorArgs?.botConfig.spawnArgs).toEqual(["--strict-mcp-config", "--add-dir", "/tmp/frames"]);
  expect(bot.spawnArgs).toEqual(["--strict-mcp-config"]); // original untouched
});

test("extraDirs on a non-CLI connector throws before the connector runs", async () => {
  const bot = stubBot({ connector: "copilot-sdk" });
  await expect(
    executeOneShot("p", config, bot, { extraDirs: ["/tmp/frames"] }),
  ).rejects.toThrow(/does not support extraDirs/);
  expect(connectorArgs).toBeUndefined(); // never dispatched
});

test("empty extraDirs is a no-op (no spawnArgs added, no throw) on any connector", async () => {
  const bot = stubBot({ connector: "copilot-sdk" });
  await executeOneShot("p", config, bot, { extraDirs: [] });
  expect(connectorArgs?.botConfig.spawnArgs).toBeUndefined();
});

test("empty prompt throws before the connector runs (unresolved template variable)", async () => {
  const bot = stubBot({ connector: "claude-cli" });
  await expect(executeOneShot("   ", config, bot)).rejects.toThrow(/empty prompt/);
  expect(connectorArgs).toBeUndefined(); // never dispatched
});

test("prompt with an unresolved-looking path marker still dispatches (warn-only)", async () => {
  const bot = stubBot({ connector: "claude-cli" });
  await executeOneShot("Read the file undefined/secret.txt and reply.", config, bot);
  expect(connectorArgs?.prompt).toContain("undefined/secret.txt"); // warned, not rejected
});
