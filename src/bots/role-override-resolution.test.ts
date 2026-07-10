import { test, expect, beforeEach, afterEach } from "bun:test";
import type { BotConfig } from "./config.ts";
import { resolveResearchBot, resolveSummarizerBot } from "./config.ts";
import { resolveBackendWithReason } from "../ai/haiku-direct.ts";
import { _resetSnapshotForTests } from "../db/role-overrides.ts";

function bot(name: string, over: Partial<BotConfig> = {}): BotConfig {
  return {
    name,
    dir: `/bots/${name}`,
    persona: "",
    telegramAllowedUserIds: [],
    slackAllowedUserIds: [],
    ...over,
  } as BotConfig;
}

const BOTS = [bot("jarvis"), bot("melosys", { connector: "copilot-sdk" }), bot("capra", { model: "opus" })];

const SAVED = { ...process.env };
beforeEach(() => {
  _resetSnapshotForTests();
  delete process.env.SUMMARIZER_BOT;
  delete process.env.RESEARCH_BOT;
  delete process.env.HAIKU_BACKEND;
  delete process.env.HAIKU_DIRECT_ENABLED;
});
afterEach(() => {
  _resetSnapshotForTests();
  process.env = { ...SAVED };
});

test("summarizer: DB override beats env", () => {
  process.env.SUMMARIZER_BOT = "jarvis";
  _resetSnapshotForTests({ SUMMARIZER_BOT: "melosys" });
  expect(resolveSummarizerBot(BOTS)?.name).toBe("melosys");
});

test("summarizer: env used when no override", () => {
  process.env.SUMMARIZER_BOT = "melosys";
  expect(resolveSummarizerBot(BOTS)?.name).toBe("melosys");
});

test("summarizer: clearing the override falls back to env/first-discovered", () => {
  _resetSnapshotForTests({ SUMMARIZER_BOT: "melosys" });
  expect(resolveSummarizerBot(BOTS)?.name).toBe("melosys");
  _resetSnapshotForTests(); // cleared
  expect(resolveSummarizerBot(BOTS)?.name).toBe("jarvis"); // first discovered
});

test("research: DB override beats env and the non-opus default", () => {
  process.env.RESEARCH_BOT = "jarvis";
  _resetSnapshotForTests({ RESEARCH_BOT: "melosys" });
  expect(resolveResearchBot(BOTS)?.name).toBe("melosys");
});

test("research: override can even pin an opus bot", () => {
  _resetSnapshotForTests({ RESEARCH_BOT: "capra" });
  expect(resolveResearchBot(BOTS)?.name).toBe("capra");
});

test("research: no override → first non-opus bot", () => {
  expect(resolveResearchBot(BOTS)?.name).toBe("jarvis");
});

test("haiku backend: DB override beats env", () => {
  process.env.HAIKU_BACKEND = "cli";
  _resetSnapshotForTests({ HAIKU_BACKEND: "anthropic" });
  const r = resolveBackendWithReason({ connector: "claude-cli" });
  expect(r.backend).toBe("anthropic");
  expect(r.reason).toBe("HAIKU_BACKEND override");
});

test("haiku backend: explicit opts.backend still beats the override", () => {
  _resetSnapshotForTests({ HAIKU_BACKEND: "anthropic" });
  const r = resolveBackendWithReason({ backend: "copilot", connector: "claude-cli" });
  expect(r.backend).toBe("copilot");
  expect(r.reason).toBe("explicit override");
});

test("haiku backend: env used when no override; per-bot below env", () => {
  process.env.HAIKU_BACKEND = "copilot";
  const r = resolveBackendWithReason({ haikuBackend: "anthropic", connector: "claude-cli" });
  expect(r.backend).toBe("copilot");
  expect(r.reason).toBe("HAIKU_BACKEND env");
});

test("haiku backend: an invalid override value is ignored (falls through)", () => {
  _resetSnapshotForTests({ HAIKU_BACKEND: "bogus" });
  const r = resolveBackendWithReason({ connector: "copilot-sdk" });
  expect(r.backend).toBe("copilot");
  expect(r.reason).toBe("connector default (copilot-sdk)");
});
