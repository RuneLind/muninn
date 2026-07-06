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

import { discoverAllBots, discoverActiveBots, resolveSummarizerBot, resolveResearchBot, type BotConfig, type ConnectorType } from "./config.ts";

function stubBot(name: string, overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    name,
    dir: `/tmp/${name}`,
    persona: "",
    telegramAllowedUserIds: [],
    slackAllowedUserIds: [],
    ...overrides,
  };
}

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
          specDomain: "Draft the domain spec",
        },
      });

      const bots = discoverAllBots();
      const found = bots.find((b) => b.name === "_test_prompts");
      expect(found).toBeDefined();
      expect(found!.prompts).toEqual({
        jiraAnalysis: "Analyze this Jira task",
        investigateCode: "Look at the code",
        specGeneration: "Generate a test spec",
        specDomain: "Draft the domain spec",
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

    test("title-cases hyphen/underscore ids and ignores a blank label", () => {
      setupTestBot("_test_labels", {
        prompts: {
          jiraAnalysis: "Default",
          "jiraAnalysis.code-review": "Body A",
          "jiraAnalysis.deep_dive": "<!-- label:    -->\nBody B",
        },
      });

      const bots = discoverAllBots();
      const found = bots.find((b) => b.name === "_test_labels");
      expect(found!.prompts?.jiraAnalysisVariants).toEqual([
        { id: "code-review", label: "Code Review", content: "Body A" },
        // blank label falls back to the title-cased id; the comment line is stripped
        { id: "deep_dive", label: "Deep Dive", content: "Body B" },
      ]);
    });

    test("reserves the \"default\" variant id (file cannot shadow the synthetic default)", () => {
      setupTestBot("_test_reserved", {
        prompts: {
          jiraAnalysis: "The default body",
          "jiraAnalysis.default": "Unreachable — should be skipped",
          "jiraAnalysis.coder": "Coder body",
        },
      });

      const bots = discoverAllBots();
      const found = bots.find((b) => b.name === "_test_reserved");
      expect(found!.prompts?.jiraAnalysis).toBe("The default body");
      expect(found!.prompts?.jiraAnalysisVariants).toEqual([
        { id: "coder", label: "Coder", content: "Coder body" },
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

  // ── config.json scalar field type validation ─────────────────────────

  describe("config.json scalar field types", () => {
    test("drops wrong-typed scalar fields and falls back to defaults", () => {
      setupTestBot("_test_badtypes", {
        config: {
          model: 123, // should be string
          baseUrl: false, // should be string
          thinkingMaxTokens: "16000", // should be number
          timeoutMs: true, // should be number
          contextWindow: "32768", // should be number
          showWaterfall: "yes", // should be boolean
        },
      });

      const bots = discoverAllBots();
      const found = bots.find((b) => b.name === "_test_badtypes");
      expect(found).toBeDefined();
      expect(found!.model).toBeUndefined();
      expect(found!.baseUrl).toBeUndefined();
      expect(found!.thinkingMaxTokens).toBeUndefined();
      expect(found!.timeoutMs).toBeUndefined();
      expect(found!.contextWindow).toBeUndefined();
      expect(found!.showWaterfall).toBeUndefined();
    });

    test("keeps correctly-typed scalars, including falsy-but-valid 0 and false", () => {
      setupTestBot("_test_goodtypes", {
        config: {
          model: "sonnet",
          thinkingMaxTokens: 0, // 0 disables thinking — must NOT be dropped as falsy
          showWaterfall: false, // false must NOT be dropped as falsy
        },
      });

      const bots = discoverAllBots();
      const found = bots.find((b) => b.name === "_test_goodtypes");
      expect(found).toBeDefined();
      expect(found!.model).toBe("sonnet");
      expect(found!.thinkingMaxTokens).toBe(0);
      expect(found!.showWaterfall).toBe(false);
    });

    test("drops only the mistyped field, keeps valid siblings", () => {
      setupTestBot("_test_mixedtypes", {
        config: {
          connector: "copilot-sdk",
          model: "claude-sonnet-4-6",
          timeoutMs: "nope", // invalid → dropped
        },
      });

      const bots = discoverAllBots();
      const found = bots.find((b) => b.name === "_test_mixedtypes");
      expect(found).toBeDefined();
      expect(found!.connector).toBe("copilot-sdk");
      expect(found!.model).toBe("claude-sonnet-4-6");
      expect(found!.timeoutMs).toBeUndefined();
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

describe("resolveSummarizerBot", () => {
  const prev = process.env.SUMMARIZER_BOT;
  afterEach(() => {
    if (prev === undefined) delete process.env.SUMMARIZER_BOT;
    else process.env.SUMMARIZER_BOT = prev;
  });

  test("returns undefined for an empty bot list", () => {
    delete process.env.SUMMARIZER_BOT;
    expect(resolveSummarizerBot([])).toBeUndefined();
  });

  test("falls back to the first bot when SUMMARIZER_BOT is unset", () => {
    delete process.env.SUMMARIZER_BOT;
    const bots = [stubBot("alpha"), stubBot("beta")];
    expect(resolveSummarizerBot(bots)?.name).toBe("alpha");
  });

  test("selects the named bot regardless of directory order (case-insensitive)", () => {
    process.env.SUMMARIZER_BOT = "BETA";
    const bots = [stubBot("alpha"), stubBot("beta")];
    expect(resolveSummarizerBot(bots)?.name).toBe("beta");
  });

  test("falls back to the first bot when SUMMARIZER_BOT names a missing bot", () => {
    process.env.SUMMARIZER_BOT = "gamma";
    const bots = [stubBot("alpha"), stubBot("beta")];
    expect(resolveSummarizerBot(bots)?.name).toBe("alpha");
  });
});

describe("resolveResearchBot", () => {
  const prevResearch = process.env.RESEARCH_BOT;
  const prevSummarizer = process.env.SUMMARIZER_BOT;
  beforeEach(() => {
    delete process.env.RESEARCH_BOT;
    delete process.env.SUMMARIZER_BOT;
  });
  afterEach(() => {
    if (prevResearch === undefined) delete process.env.RESEARCH_BOT;
    else process.env.RESEARCH_BOT = prevResearch;
    if (prevSummarizer === undefined) delete process.env.SUMMARIZER_BOT;
    else process.env.SUMMARIZER_BOT = prevSummarizer;
  });

  test("returns undefined for an empty bot list", () => {
    expect(resolveResearchBot([])).toBeUndefined();
  });

  test("RESEARCH_BOT pins a bot by name (case-insensitive), even an opus one", () => {
    process.env.RESEARCH_BOT = "CAPRA";
    const bots = [stubBot("capra", { model: "claude-opus-4-6" }), stubBot("jarvis", { model: "claude-sonnet-4-6" })];
    expect(resolveResearchBot(bots)?.name).toBe("capra");
  });

  test("prefers the first fast (non-opus) bot over a slow first-discovered opus bot", () => {
    // Mirrors prod discovery order: capra (opus) is first, jarvis (sonnet) second.
    const bots = [stubBot("capra", { model: "claude-opus-4-6" }), stubBot("jarvis", { model: "claude-sonnet-4-6" })];
    expect(resolveResearchBot(bots)?.name).toBe("jarvis");
  });

  test("treats a bot with no model override as fast (global model is sonnet-class)", () => {
    const bots = [stubBot("capra", { model: "claude-opus-4-6" }), stubBot("plain")];
    expect(resolveResearchBot(bots)?.name).toBe("plain");
  });

  test("picks any-connector bot by speed now that synthesis routes through executeOneShot", () => {
    // Connector no longer gates selection — the first non-opus bot wins, even a
    // copilot-sdk one. (Previously copilot/openai bots were skipped for the CLI.)
    const bots = [
      stubBot("melosys", { connector: "copilot-sdk", model: "claude-sonnet-4.6" }),
      stubBot("local", { connector: "openai-compat", model: "qwen3.5:35b" }),
      stubBot("jarvis", { model: "claude-sonnet-4-6" }),
    ];
    expect(resolveResearchBot(bots)?.name).toBe("melosys");
  });

  test("prefers a fast non-CLI bot over a slow (opus) CLI bot", () => {
    // local (openai, fast) beats capra (opus, slow) — only speed matters now.
    const bots = [
      stubBot("local", { connector: "openai-compat", model: "qwen3.5:35b" }),
      stubBot("capra", { model: "claude-opus-4-6" }),
    ];
    expect(resolveResearchBot(bots)?.name).toBe("local");
  });

  test("falls back to resolveSummarizerBot when every bot is a slow (opus) one", () => {
    process.env.SUMMARIZER_BOT = "opusB"; // last-resort summarizer pick honored
    const bots = [
      stubBot("opusA", { model: "claude-opus-4-6" }),
      stubBot("opusB", { model: "claude-opus-4-6" }),
    ];
    // No fast (non-opus) bot exists, so the summarizer fallback returns its pick.
    expect(resolveResearchBot(bots)?.name).toBe("opusB");
  });

  test("RESEARCH_BOT naming a missing bot falls through to the fast-bot heuristic", () => {
    process.env.RESEARCH_BOT = "ghost";
    const bots = [stubBot("capra", { model: "claude-opus-4-6" }), stubBot("jarvis", { model: "claude-sonnet-4-6" })];
    expect(resolveResearchBot(bots)?.name).toBe("jarvis");
  });
});
