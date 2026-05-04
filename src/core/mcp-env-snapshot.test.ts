import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mcpEnvSnapshotForTool } from "./message-processor.ts";

describe("mcpEnvSnapshotForTool", () => {
  const original = {
    HUGINN_TRACE_POINTER: process.env.HUGINN_TRACE_POINTER,
    HUGINN_TRACE_DEFAULT: process.env.HUGINN_TRACE_DEFAULT,
  };

  beforeEach(() => {
    delete process.env.HUGINN_TRACE_POINTER;
    delete process.env.HUGINN_TRACE_DEFAULT;
  });

  afterEach(() => {
    if (original.HUGINN_TRACE_POINTER !== undefined) {
      process.env.HUGINN_TRACE_POINTER = original.HUGINN_TRACE_POINTER;
    }
    if (original.HUGINN_TRACE_DEFAULT !== undefined) {
      process.env.HUGINN_TRACE_DEFAULT = original.HUGINN_TRACE_DEFAULT;
    }
  });

  test("returns null for non-trace-emitting tools", () => {
    expect(mcpEnvSnapshotForTool("Read")).toBeNull();
    expect(mcpEnvSnapshotForTool("Bash")).toBeNull();
    expect(mcpEnvSnapshotForTool("mcp__github__create_pr")).toBeNull();
    expect(mcpEnvSnapshotForTool("github-create_pr")).toBeNull();
  });

  test("snapshots env for both claude-cli and copilot-sdk knowledge tool name shapes", () => {
    process.env.HUGINN_TRACE_POINTER = "1";
    process.env.HUGINN_TRACE_DEFAULT = "1";
    const claudeCli = mcpEnvSnapshotForTool("mcp__knowledge__search_knowledge");
    const copilotSdk = mcpEnvSnapshotForTool("knowledge-search_knowledge");
    expect(claudeCli).toEqual({ huginnTracePointer: "1", huginnTraceDefault: "1" });
    expect(copilotSdk).toEqual({ huginnTracePointer: "1", huginnTraceDefault: "1" });
  });

  test("snapshots env for yggdrasil tool name shapes", () => {
    process.env.HUGINN_TRACE_POINTER = "1";
    const claudeCli = mcpEnvSnapshotForTool("mcp__yggdrasil__symbol_context");
    const copilotSdk = mcpEnvSnapshotForTool("yggdrasil-symbol_context");
    expect(claudeCli).toEqual({ huginnTracePointer: "1", huginnTraceDefault: null });
    expect(copilotSdk).toEqual({ huginnTracePointer: "1", huginnTraceDefault: null });
  });

  test("uses null for unset env keys (not the string 'undefined')", () => {
    const snap = mcpEnvSnapshotForTool("knowledge-search_knowledge");
    expect(snap).toEqual({ huginnTracePointer: null, huginnTraceDefault: null });
  });

  test("preserves the literal string value when env is set to '0' (so a future audit can flag it)", () => {
    process.env.HUGINN_TRACE_POINTER = "0";
    process.env.HUGINN_TRACE_DEFAULT = "0";
    const snap = mcpEnvSnapshotForTool("knowledge-search_knowledge");
    expect(snap).toEqual({ huginnTracePointer: "0", huginnTraceDefault: "0" });
  });
});
