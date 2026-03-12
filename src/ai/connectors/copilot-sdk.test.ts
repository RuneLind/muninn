import { test, expect, describe } from "bun:test";
import { buildCustomAgents } from "./copilot-sdk.ts";
import type { BotConfig } from "../../bots/config.ts";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeBotDir(serena?: object[]): { botsDir: string; botDir: string; cleanup: () => void } {
  const botsDir = mkdtempSync(join(tmpdir(), "bots-test-"));
  const botDir = join(botsDir, "testbot");
  mkdirSync(botDir);
  if (serena) {
    writeFileSync(join(botDir, "config.json"), JSON.stringify({ serena }));
  }
  return { botsDir, botDir, cleanup: () => rmSync(botsDir, { recursive: true }) };
}

function baseBotConfig(dir: string): BotConfig {
  return {
    name: "testbot",
    dir,
    persona: "Test persona",
    telegramAllowedUserIds: [],
    slackAllowedUserIds: [],
  };
}

describe("buildCustomAgents", () => {
  test("returns empty array when no config.json exists", () => {
    const { botDir, cleanup } = makeBotDir();
    try {
      const result = buildCustomAgents(baseBotConfig(botDir));
      expect(result).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("returns empty array when config.json has no serena entries", () => {
    const { botDir, cleanup } = makeBotDir();
    writeFileSync(join(botDir, "config.json"), JSON.stringify({ model: "sonnet" }));
    try {
      const result = buildCustomAgents(baseBotConfig(botDir));
      expect(result).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("returns empty array when serena array is empty", () => {
    const { botDir, cleanup } = makeBotDir([]);
    try {
      const result = buildCustomAgents(baseBotConfig(botDir));
      expect(result).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("returns verify-code agent with project paths from serena config", () => {
    const { botDir, cleanup } = makeBotDir([
      { name: "serena-api", displayName: "Backend API", projectPath: "/src/api", port: 9121 },
      { name: "serena-web", displayName: "Frontend", projectPath: "/src/web", port: 9122 },
    ]);
    try {
      const result = buildCustomAgents(baseBotConfig(botDir));
      expect(result).toHaveLength(1);
      const agent = result[0]!;
      expect(agent.name).toBe("verify-code");
      expect(agent.displayName).toBe("Code Verifier");
      expect(agent.mcpServers).toEqual({});
      expect(agent.prompt).toContain("/src/api");
      expect(agent.prompt).toContain("/src/web");
      expect(agent.prompt).toContain("Backend API");
      expect(agent.prompt).toContain("Frontend");
    } finally {
      cleanup();
    }
  });

  test("skips invalid serena entries (missing required fields)", () => {
    const { botDir, cleanup } = makeBotDir([
      { name: "valid", displayName: "Valid", projectPath: "/src/valid", port: 9121 },
      { name: "no-path", displayName: "Missing Path" }, // missing projectPath and port
    ]);
    try {
      const result = buildCustomAgents(baseBotConfig(botDir));
      expect(result).toHaveLength(1);
      const agent = result[0]!;
      expect(agent.prompt).toContain("/src/valid");
      expect(agent.prompt).not.toContain("Missing Path");
    } finally {
      cleanup();
    }
  });

  test("only includes agents for the matching bot name", () => {
    const botsDir = mkdtempSync(join(tmpdir(), "bots-test-"));
    const botDir = join(botsDir, "mybot");
    const otherDir = join(botsDir, "otherbot");
    mkdirSync(botDir);
    mkdirSync(otherDir);
    writeFileSync(join(botDir, "config.json"), JSON.stringify({}));
    writeFileSync(join(otherDir, "config.json"), JSON.stringify({
      serena: [{ name: "s1", displayName: "Other", projectPath: "/other", port: 9121 }],
    }));
    try {
      const result = buildCustomAgents({ ...baseBotConfig(botDir), name: "mybot" });
      expect(result).toEqual([]);
    } finally {
      rmSync(botsDir, { recursive: true });
    }
  });
});
