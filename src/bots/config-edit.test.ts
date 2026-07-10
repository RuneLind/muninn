import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeBotConfigField } from "./config-edit.ts";
import { validateBotConfigField } from "./config.ts";

let baseDir: string;

function makeBot(name: string, config?: Record<string, unknown>): string {
  const dir = join(baseDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "CLAUDE.md"), "persona", "utf-8");
  if (config) writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2), "utf-8");
  return dir;
}

function readConfig(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(baseDir, name, "config.json"), "utf-8"));
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "muninn-cfg-"));
});
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

test("round-trips a field into an existing config.json, preserving other keys", () => {
  makeBot("jarvis", { connector: "claude-cli", timeoutMs: 120000 });
  const res = writeBotConfigField("jarvis", "model", "opus", { baseDir });
  expect(res.cleared).toBe(false);
  const cfg = readConfig("jarvis");
  expect(cfg.model).toBe("opus");
  expect(cfg.connector).toBe("claude-cli"); // untouched
  expect(cfg.timeoutMs).toBe(120000); // untouched
});

test("creates config.json with only the edited field when none exists", () => {
  makeBot("newbot");
  expect(existsSync(join(baseDir, "newbot", "config.json"))).toBe(false);
  writeBotConfigField("newbot", "connector", "copilot-sdk", { baseDir });
  const cfg = readConfig("newbot");
  expect(cfg).toEqual({ connector: "copilot-sdk" });
});

test("clearing a field (value null) removes the key", () => {
  makeBot("jarvis", { model: "opus", connector: "claude-cli" });
  const res = writeBotConfigField("jarvis", "model", null, { baseDir });
  expect(res.cleared).toBe(true);
  const cfg = readConfig("jarvis");
  expect("model" in cfg).toBe(false);
  expect(cfg.connector).toBe("claude-cli");
});

test("writes thinkingMaxTokens: 0 (falsy but valid)", () => {
  makeBot("jarvis");
  writeBotConfigField("jarvis", "thinkingMaxTokens", 0, { baseDir });
  expect(readConfig("jarvis").thinkingMaxTokens).toBe(0);
});

test("rejects an unknown bot", () => {
  expect(() => writeBotConfigField("ghost", "model", "opus", { baseDir })).toThrow(/Unknown bot "ghost"/);
});

test("rejects an invalid connector with discovery's message", () => {
  makeBot("jarvis");
  expect(() => writeBotConfigField("jarvis", "connector", "gpt-cli", { baseDir })).toThrow(
    'Bot "jarvis" has unknown connector "gpt-cli" — valid values: claude-cli, copilot-sdk, openai-compat, claude-sdk',
  );
});

test("rejects an unknown editable field", () => {
  makeBot("jarvis");
  expect(() => writeBotConfigField("jarvis", "timeoutMs", 999, { baseDir })).toThrow(/Unknown editable field/);
});

test("validateBotConfigField: matches discovery messages + edge cases", () => {
  expect(validateBotConfigField("jarvis", "connector", "claude-cli")).toBeNull();
  expect(validateBotConfigField("jarvis", "connector", "bad")).toBe(
    'Bot "jarvis" has unknown connector "bad" — valid values: claude-cli, copilot-sdk, openai-compat, claude-sdk',
  );
  expect(validateBotConfigField("jarvis", "haikuBackend", "anthropic")).toBeNull();
  expect(validateBotConfigField("jarvis", "haikuBackend", "gemini")).toBe(
    'Bot "jarvis" has unknown haikuBackend "gemini" — valid values: cli, anthropic, copilot',
  );
  expect(validateBotConfigField("jarvis", "model", "")).toContain("must not be empty");
  expect(validateBotConfigField("jarvis", "thinkingMaxTokens", -5)).toContain("non-negative integer");
  expect(validateBotConfigField("jarvis", "thinkingMaxTokens", 1.5)).toContain("non-negative integer");
  expect(validateBotConfigField("jarvis", "thinkingMaxTokens", "180000")).toContain("should be a number");
  expect(validateBotConfigField("jarvis", "thinkingMaxTokens", 0)).toBeNull();
  expect(validateBotConfigField("jarvis", "model", null)).toBeNull(); // clear
});
