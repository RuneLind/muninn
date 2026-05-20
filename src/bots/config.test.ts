import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

// The discovery functions resolve bots/ relative to the source file (../../bots from src/bots/).
// We create temporary bot directories directly inside bots/ (since discovery only reads
// direct children). All test directories use a _test_ prefix for easy cleanup.
const botsDir = resolve(import.meta.dir, "../../bots");

/** Track all test directories for cleanup */
const createdDirs: string[] = [];

function setupTestBot(
  name: string,
  opts: {
    persona?: string;
    config?: Record<string, unknown>;
    configRaw?: string;
    noClaudeMd?: boolean;
    prompts?: Record<string, string>;
  } = {},
): string {
  const dir = join(botsDir, name);
  mkdirSync(dir, { recursive: true });
  createdDirs.push(dir);
  if (!opts.noClaudeMd) {
    writeFileSync(join(dir, "CLAUDE.md"), opts.persona ?? `Test persona for ${name}`);
  }
  if (opts.config) {
    writeFileSync(join(dir, "config.json"), JSON.stringify(opts.config));
  }
  if (opts.configRaw) {
    writeFileSync(join(dir, "config.json"), opts.configRaw);
  }
  if (opts.prompts) {
    const promptsDir = join(dir, "prompts");
    mkdirSync(promptsDir, { recursive: true });
    for (const [key, value] of Object.entries(opts.prompts)) {
      writeFileSync(join(promptsDir, `${key}.md`), value);
    }
  }
  return dir;
}

function cleanTestBots() {
  for (const dir of createdDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  createdDirs.length = 0;
}

import { discoverAllBots, discoverActiveBots, type ConnectorType } from "./config.ts";

describe("bot discovery", () => {
  beforeEach(() => {
    cleanTestBots();
  });

  afterEach(() => {
    cleanTestBots();
  });

  // ── discoverAllBots ──────────────────────────────────────────────────

  describe("discoverAllBots", () => {
    test("finds bots with CLAUDE.md", () => {
      setupTestBot("_test_alpha");
      const bots = discoverAllBots();
      const found = bots.find((b) => b.name === "_test_alpha");
      expect(found).toBeDefined();
      expect(found!.persona).toContain("Test persona for _test_alpha");
    });

    test("skips directories without CLAUDE.md", () => {
      setupTestBot("_test_noclaude", { noClaudeMd: true, config: {} });

      const bots = discoverAllBots();
      const found = bots.find((b) => b.name === "_test_noclaude");
      expect(found).toBeUndefined();
    });

    test("does not require platform tokens", () => {
      setupTestBot("_test_notokenbot");
      const bots = discoverAllBots();
      const found = bots.find((b) => b.name === "_test_notokenbot");
      expect(found).toBeDefined();
      expect(found!.telegramBotToken).toBeUndefined();
    });
  });

  // ── discoverActiveBots ───────────────────────────────────────────────

  describe("discoverActiveBots", () => {
    test("skips bots without platform tokens", () => {
      setupTestBot("_test_notoken");
      const bots = discoverActiveBots();
      const found = bots.find((b) => b.name === "_test_notoken");
      expect(found).toBeUndefined();
    });

    test("includes bots with Telegram token", () => {
      setupTestBot("_test_tgbot");
      process.env.TELEGRAM_BOT_TOKEN__TEST_TGBOT = "fake-token-123";
      process.env.TELEGRAM_ALLOWED_USER_IDS__TEST_TGBOT = "111,222";

      try {
        const bots = discoverActiveBots();
        const found = bots.find((b) => b.name === "_test_tgbot");
        expect(found).toBeDefined();
        expect(found!.telegramBotToken).toBe("fake-token-123");
        expect(found!.telegramAllowedUserIds).toEqual(["111", "222"]);
      } finally {
        delete process.env.TELEGRAM_BOT_TOKEN__TEST_TGBOT;
        delete process.env.TELEGRAM_ALLOWED_USER_IDS__TEST_TGBOT;
      }
    });
  });

  // ── config.json merging ──────────────────────────────────────────────

  describe("config.json merging", () => {
    test("loads connector, model, and other settings from config.json", () => {
      setupTestBot("_test_cfg", {
        config: {
          connector: "copilot-sdk",
          model: "claude-sonnet-4-6",
          thinkingMaxTokens: 16000,
          timeoutMs: 180000,
          baseUrl: "http://localhost:1234/v1",
          showWaterfall: false,
          contextWindow: 32768,
        },
      });

      const bots = discoverAllBots();
      const found = bots.find((b) => b.name === "_test_cfg");
      expect(found).toBeDefined();
      expect(found!.connector).toBe("copilot-sdk");
      expect(found!.model).toBe("claude-sonnet-4-6");
      expect(found!.thinkingMaxTokens).toBe(16000);
      expect(found!.timeoutMs).toBe(180000);
      expect(found!.baseUrl).toBe("http://localhost:1234/v1");
      expect(found!.showWaterfall).toBe(false);
      expect(found!.contextWindow).toBe(32768);
    });

    test("uses defaults when config.json is missing", () => {
      setupTestBot("_test_noconf");

      const bots = discoverAllBots();
      const found = bots.find((b) => b.name === "_test_noconf");
      expect(found).toBeDefined();
      expect(found!.connector).toBeUndefined();
      expect(found!.model).toBeUndefined();
      expect(found!.thinkingMaxTokens).toBeUndefined();
      expect(found!.timeoutMs).toBeUndefined();
      expect(found!.baseUrl).toBeUndefined();
      expect(found!.showWaterfall).toBeUndefined();
      expect(found!.contextWindow).toBeUndefined();
    });

    test("loads prompts from prompts/<key>.md files", () => {
      setupTestBot("_test_prompts", {
        prompts: {
          jiraAnalysis: "Analyze this Jira task",
          investigateCode: "Look at the code",
          specGeneration: "Generate a test spec",
        },
      });

      const bots = discoverAllBots();
      const found = bots.find((b) => b.name === "_test_prompts");
      expect(found).toBeDefined();
      expect(found!.prompts).toEqual({
        jiraAnalysis: "Analyze this Jira task",
        investigateCode: "Look at the code",
        specGeneration: "Generate a test spec",
      });
    });

    test("returns undefined prompts when prompts/ dir is missing", () => {
      setupTestBot("_test_noprompts");
      const bots = discoverAllBots();
      const found = bots.find((b) => b.name === "_test_noprompts");
      expect(found).toBeDefined();
      expect(found!.prompts).toBeUndefined();
    });

    test("ignores unknown prompt filenames", () => {
      setupTestBot("_test_unknownprompt", {
        prompts: {
          jiraAnalysis: "Real prompt",
          notARealKey: "Should be ignored",
        },
      });

      const bots = discoverAllBots();
      const found = bots.find((b) => b.name === "_test_unknownprompt");
      expect(found).toBeDefined();
      expect(found!.prompts).toEqual({ jiraAnalysis: "Real prompt" });
    });

    test("loads jiraAnalysis variants with label comment + fallback", () => {
      setupTestBot("_test_variants", {
        prompts: {
          jiraAnalysis: "Default analysis",
          "jiraAnalysis.coder": "<!-- label: Grundig kodeanalyse -->\nCoder body here",
          "jiraAnalysis.brief": "Brief body without label",
        },
      });

      const bots = discoverAllBots();
      const found = bots.find((b) => b.name === "_test_variants");
      expect(found).toBeDefined();
      expect(found!.prompts?.jiraAnalysis).toBe("Default analysis");

      const variants = found!.prompts?.jiraAnalysisVariants ?? [];
      // Sorted by id alphabetically: brief, coder
      expect(variants).toEqual([
        { id: "brief", label: "Brief", content: "Brief body without label" },
        { id: "coder", label: "Grundig kodeanalyse", content: "Coder body here" },
      ]);
    });

    test("loads restrictedTools from config.json", () => {
      setupTestBot("_test_restrict", {
        config: {
          restrictedTools: {
            "admin-tools": {
              description: "Admin only",
              allowedUsers: ["user-1"],
            },
          },
        },
      });

      const bots = discoverAllBots();
      const found = bots.find((b) => b.name === "_test_restrict");
      expect(found).toBeDefined();
      expect(found!.restrictedTools).toEqual({
        "admin-tools": {
          description: "Admin only",
          allowedUsers: ["user-1"],
        },
      });
    });
  });

  // ── connector validation ─────────────────────────────────────────────

  describe("connector validation", () => {
    test("accepts valid connector types", () => {
      const validConnectors: ConnectorType[] = ["claude-cli", "copilot-sdk", "openai-compat"];
      for (const connector of validConnectors) {
        const name = `_test_conn_${connector.replace(/-/g, "_")}`;
        const botDir = setupTestBot(name, { config: { connector } });

        const bots = discoverAllBots();
        const found = bots.find((b) => b.dir === botDir);
        expect(found).toBeDefined();
        expect(found!.connector).toBe(connector);
      }
    });

    test("strips invalid connector type (falls back to undefined)", () => {
      setupTestBot("_test_badconn", {
        config: { connector: "invalid-connector" },
      });

      const bots = discoverAllBots();
      const found = bots.find((b) => b.name === "_test_badconn");
      expect(found).toBeDefined();
      expect(found!.connector).toBeUndefined();
    });
  });

  // ── malformed config.json ────────────────────────────────────────────

  describe("malformed config.json", () => {
    test("handles invalid JSON gracefully (uses defaults)", () => {
      setupTestBot("_test_badjson", { configRaw: "not valid json {{{" });

      const bots = discoverAllBots();
      const found = bots.find((b) => b.name === "_test_badjson");
      expect(found).toBeDefined();
      expect(found!.connector).toBeUndefined();
      expect(found!.model).toBeUndefined();
    });
  });

  // ── environment variable parsing ─────────────────────────────────────

  describe("environment variable parsing", () => {
    test("parses comma-separated allowed user IDs with whitespace", () => {
      setupTestBot("_test_ids");
      process.env.TELEGRAM_BOT_TOKEN__TEST_IDS = "token-123";
      process.env.TELEGRAM_ALLOWED_USER_IDS__TEST_IDS = "  111 , 222 , 333  ";

      try {
        const bots = discoverActiveBots();
        const found = bots.find((b) => b.name === "_test_ids");
        expect(found).toBeDefined();
        expect(found!.telegramAllowedUserIds).toEqual(["111", "222", "333"]);
      } finally {
        delete process.env.TELEGRAM_BOT_TOKEN__TEST_IDS;
        delete process.env.TELEGRAM_ALLOWED_USER_IDS__TEST_IDS;
      }
    });

    test("handles empty allowed user IDs", () => {
      setupTestBot("_test_noids");

      const bots = discoverAllBots();
      const found = bots.find((b) => b.name === "_test_noids");
      expect(found).toBeDefined();
      expect(found!.telegramAllowedUserIds).toEqual([]);
      expect(found!.slackAllowedUserIds).toEqual([]);
    });
  });

  // ── persona loading ──────────────────────────────────────────────────

  describe("persona loading", () => {
    test("reads CLAUDE.md content as persona", () => {
      setupTestBot("_test_persona", {
        persona: "You are a helpful assistant named TestBot.\n\nBe concise.",
      });

      const bots = discoverAllBots();
      const found = bots.find((b) => b.name === "_test_persona");
      expect(found).toBeDefined();
      expect(found!.persona).toBe("You are a helpful assistant named TestBot.\n\nBe concise.");
    });
  });

  // ── bot directory path ───────────────────────────────────────────────

  describe("bot directory path", () => {
    test("sets dir to absolute path of bot folder", () => {
      const botDir = setupTestBot("_test_dir");

      const bots = discoverAllBots();
      const found = bots.find((b) => b.name === "_test_dir");
      expect(found).toBeDefined();
      expect(found!.dir).toBe(botDir);
    });
  });
});
