/**
 * Pure-logic tests for the runner. Anything that needs `processMessage` or
 * a real DB lives in higher-level integration tests; this file only covers
 * helpers that can run in isolation.
 */

import { describe, expect, test } from "bun:test";
import { findLeakedSpans } from "./runner.ts";
import { disallowedToolsForConnector } from "./audit.ts";
import type { ConnectorType } from "../bots/config.ts";

describe("findLeakedSpans (Bug 11 audit)", () => {
  test("returns empty for a clean trace", () => {
    const clean = [
      "benchmark_analysis",
      "claude",
      "prompt_build",
      "search_knowledge (knowledge)",
      "search (yggdrasil)",
      "symbol_context (yggdrasil)",
      "impact (yggdrasil)",
      "find_symbol (b7588-api)",
      "db_save_user",
      "db_save_response",
      "send",
    ];
    expect(findLeakedSpans(clean)).toEqual([]);
  });

  test("flags Claude Code harness tools", () => {
    const dirty = [
      "claude",
      "search_knowledge (knowledge)",
      "Agent",
      "Skill",
      "ToolSearch",
      "Monitor",
    ];
    const leaked = findLeakedSpans(dirty);
    expect(leaked).toContain("Agent");
    expect(leaked).toContain("Skill");
    expect(leaked).toContain("ToolSearch");
    expect(leaked).toContain("Monitor");
    expect(leaked).not.toContain("claude");
    expect(leaked).not.toContain("search_knowledge (knowledge)");
  });

  test("does NOT flag ToolSearch under claude-sdk (legitimate deferred-MCP discovery)", () => {
    const trace = [
      "claude",
      "search_knowledge (knowledge)",
      "ToolSearch",
    ];
    expect(findLeakedSpans(trace, "claude-sdk")).toEqual([]);
  });

  test("still flags other harness tools under claude-sdk", () => {
    const trace = ["ToolSearch", "Agent", "Bash"];
    const leaked = findLeakedSpans(trace, "claude-sdk");
    expect(leaked).not.toContain("ToolSearch");
    expect(leaked).toContain("Agent");
    expect(leaked).toContain("Bash");
  });

  test("flags ToolSearch under claude-cli (CLI has no deferred-MCP use for it)", () => {
    expect(findLeakedSpans(["ToolSearch"], "claude-cli")).toEqual(["ToolSearch"]);
  });

  test("disallowedToolsForConnector drops ToolSearch only for claude-sdk", () => {
    expect(disallowedToolsForConnector("claude-cli")).toContain("ToolSearch");
    expect(disallowedToolsForConnector("copilot-sdk")).toContain("ToolSearch");
    expect(disallowedToolsForConnector("openai-compat")).toContain("ToolSearch");
    expect(disallowedToolsForConnector(undefined)).toContain("ToolSearch");
    expect(disallowedToolsForConnector("claude-sdk")).not.toContain("ToolSearch");
    // Everything else stays for every connector
    const all: (ConnectorType | undefined)[] = [
      "claude-cli", "copilot-sdk", "openai-compat", "claude-sdk", undefined,
    ];
    for (const c of all) {
      expect(disallowedToolsForConnector(c)).toContain("Bash");
      expect(disallowedToolsForConnector(c)).toContain("Agent");
      expect(disallowedToolsForConnector(c)).toContain("TaskCreate");
    }
  });

  test("flags raw filesystem and shell tools", () => {
    expect(findLeakedSpans(["Bash"])).toEqual(["Bash"]);
    expect(findLeakedSpans(["Read"])).toEqual(["Read"]);
    expect(findLeakedSpans(["Write"])).toEqual(["Write"]);
    expect(findLeakedSpans(["Edit"])).toEqual(["Edit"]);
    expect(findLeakedSpans(["MultiEdit"])).toEqual(["MultiEdit"]);
    expect(findLeakedSpans(["Glob"])).toEqual(["Glob"]);
    expect(findLeakedSpans(["Grep"])).toEqual(["Grep"]);
  });

  test("flags JetBrains MCP via pattern match", () => {
    expect(findLeakedSpans(["read_file (jetbrains)"])).toEqual([
      "read_file (jetbrains)",
    ]);
    expect(findLeakedSpans(["execute_terminal_command (jetbrains)"])).toEqual([
      "execute_terminal_command (jetbrains)",
    ]);
  });

  test("flags claude-hivemind MCP via pattern match", () => {
    expect(findLeakedSpans(["send_message (claude-hivemind)"])).toEqual([
      "send_message (claude-hivemind)",
    ]);
  });

  test("does not false-positive on legitimate MCP servers ending in similar suffixes", () => {
    // A hypothetical MCP server called "knowledge-jetbrains-mirror" should NOT match
    // because the regex anchors on "(jetbrains)$".
    expect(findLeakedSpans(["search (knowledge-jetbrains-mirror)"])).toEqual([]);
    expect(findLeakedSpans(["search (knowledge)"])).toEqual([]);
    expect(findLeakedSpans(["search (yggdrasil)"])).toEqual([]);
  });

  test("recreates the H4 contamination signature", () => {
    // The exact tool list observed in the contaminated H4 cell that revealed Bug 11.
    const h4 = [
      "benchmark_analysis",
      "claude",
      "prompt_build",
      "search_knowledge (knowledge)",
      "get_graph_node (knowledge)",
      "search (yggdrasil)",
      "impact (yggdrasil)",
      "symbol_context (yggdrasil)",
      "read_source (yggdrasil)",
      "ToolSearch",
      "Agent",
      "Skill",
      "Monitor",
      "read_file (jetbrains)",
      "execute_terminal_command (jetbrains)",
      "db_save_user",
      "db_save_response",
      "send",
    ];
    const leaked = findLeakedSpans(h4);
    expect(leaked.sort()).toEqual([
      "Agent",
      "Monitor",
      "Skill",
      "ToolSearch",
      "execute_terminal_command (jetbrains)",
      "read_file (jetbrains)",
    ].sort());
  });
});
