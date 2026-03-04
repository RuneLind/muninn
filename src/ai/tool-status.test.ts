import { test, expect, describe } from "bun:test";
import { getToolStatus, parseToolName } from "./tool-status.ts";

describe("parseToolName", () => {
  test("Claude CLI format: mcp__server__tool", () => {
    expect(parseToolName("mcp__knowledge__search_knowledge")).toEqual({ server: "knowledge", tool: "search_knowledge" });
    expect(parseToolName("mcp__google-calendar__list_events")).toEqual({ server: "google-calendar", tool: "list_events" });
  });

  test("double-underscore format: server__tool", () => {
    expect(parseToolName("knowledge__search_knowledge")).toEqual({ server: "knowledge", tool: "search_knowledge" });
  });

  test("Copilot SDK format: server-tool", () => {
    expect(parseToolName("knowledge-search_knowledge")).toEqual({ server: "knowledge", tool: "search_knowledge" });
    expect(parseToolName("gmail-search_emails")).toEqual({ server: "gmail", tool: "search_emails" });
  });

  test("Copilot SDK format with multi-dash server name (known)", () => {
    expect(parseToolName("google-calendar-list_events")).toEqual({ server: "google-calendar", tool: "list_events" });
  });

  test("Copilot SDK format with multi-dash server name (unknown, underscore heuristic)", () => {
    expect(parseToolName("serena-api-search_for_pattern")).toEqual({ server: "serena-api", tool: "search_for_pattern" });
    expect(parseToolName("serena-web-find_symbol")).toEqual({ server: "serena-web", tool: "find_symbol" });
    expect(parseToolName("serena-eessi-read_file")).toEqual({ server: "serena-eessi", tool: "read_file" });
  });

  test("unknown server with dash format", () => {
    expect(parseToolName("notion-search_pages")).toEqual({ server: "notion", tool: "search_pages" });
  });

  test("returns undefined for names without separators", () => {
    expect(parseToolName("report_intent")).toBeUndefined();
    expect(parseToolName("WebSearch")).toBeUndefined();
  });
});

describe("getToolStatus", () => {
  test("Claude CLI format matches", () => {
    expect(getToolStatus("mcp__knowledge__search_knowledge")).toBe("Searching knowledge base...");
    expect(getToolStatus("mcp__gmail__send_email")).toBe("Sending email...");
    expect(getToolStatus("mcp__google-calendar__list_events")).toBe("Checking calendar...");
  });

  test("Copilot SDK format matches", () => {
    expect(getToolStatus("knowledge-search_knowledge")).toBe("Searching knowledge base...");
    expect(getToolStatus("knowledge-get_document")).toBe("Loading document...");
    expect(getToolStatus("gmail-search_emails")).toBe("Searching email...");
    expect(getToolStatus("google-calendar-list_events")).toBe("Checking calendar...");
  });

  test("includes search query detail when input provided", () => {
    const input = '{"query": "trygdeavtaler med Sverige", "collection": "melosys"}';
    expect(getToolStatus("knowledge-search_knowledge", input)).toBe(
      "Searching knowledge base: trygdeavtaler med Sverige",
    );
    expect(getToolStatus("mcp__knowledge__search_knowledge", input)).toBe(
      "Searching knowledge base: trygdeavtaler med Sverige",
    );
  });

  test("includes email search detail", () => {
    const input = '{"query": "invoice from Capra"}';
    expect(getToolStatus("gmail-search_emails", input)).toBe("Searching email: invoice from Capra");
  });

  test("includes document detail (title preferred over id)", () => {
    const input = '{"id": "doc-123", "title": "Architecture overview"}';
    expect(getToolStatus("knowledge-get_document", input)).toBe("Loading document: Architecture overview");
  });

  test("falls back to id when no title", () => {
    const input = '{"id": "doc-123"}';
    expect(getToolStatus("knowledge-get_document", input)).toBe("Loading document: doc-123");
  });

  test("truncates long search queries", () => {
    const longQuery = "a".repeat(100);
    const input = `{"query": "${longQuery}"}`;
    const result = getToolStatus("knowledge-search_knowledge", input)!;
    expect(result.length).toBeLessThan(100);
    expect(result).toContain("…");
  });

  test("server-level fallback for unknown tools on known servers", () => {
    expect(getToolStatus("mcp__gmail__some_new_action")).toBe("Checking email...");
    expect(getToolStatus("gmail-some_new_action")).toBe("Checking email...");
    expect(getToolStatus("knowledge-reindex")).toBe("Searching knowledge...");
  });

  test("generic fallback for unknown MCP servers uses waterfall format", () => {
    expect(getToolStatus("mcp__notion__search_pages")).toBe("search_pages (notion)...");
    expect(getToolStatus("notion-search_pages")).toBe("search_pages (notion)...");
    expect(getToolStatus("mcp__serena-api__find_symbol")).toBe("find_symbol (serena-api)...");
  });

  test("generic fallback includes detail from common input fields", () => {
    expect(getToolStatus("mcp__serena-api__find_symbol", '{"name": "Pensjonsopptjening"}')).toBe(
      "find_symbol (serena-api): Pensjonsopptjening",
    );
    expect(getToolStatus("mcp__serena-api__search_for_pattern", '{"pattern": "VARSLE_PENSJONSOPPTJENING"}')).toBe(
      "search_for_pattern (serena-api): VARSLE_PENSJONSOPPTJENING",
    );
    expect(getToolStatus("mcp__serena-api__read_file", '{"path": "src/main/kotlin/Service.kt"}')).toBe(
      "read_file (serena-api): src/main/kotlin/Service.kt",
    );
  });

  test("generic fallback works with Copilot SDK dash format (serena)", () => {
    expect(getToolStatus("serena-api-search_for_pattern", '{"regex": "VARSLE_PENSJONSOPPTJENING"}')).toBe(
      "search_for_pattern (serena-api): VARSLE_PENSJONSOPPTJENING",
    );
    expect(getToolStatus("serena-web-find_symbol", '{"name": "AnnullerSak"}')).toBe(
      "find_symbol (serena-web): AnnullerSak",
    );
  });

  test("generic fallback uses first string value when no known field matches", () => {
    expect(getToolStatus("mcp__serena-api__custom_action", '{"foobar": "SomeValue"}')).toBe(
      "custom_action (serena-api): SomeValue",
    );
  });

  test("non-MCP tool fallback", () => {
    expect(getToolStatus("WebSearch")).toBe("Using WebSearch...");
    expect(getToolStatus("some_custom_tool")).toBe("Using some custom tool...");
  });

  test("non-MCP tool includes detail when input has known fields", () => {
    expect(getToolStatus("Bash", '{"command": "git status"}')).toBe("Using Bash: git status");
    expect(getToolStatus("Read", '{"path": "src/index.ts"}')).toBe("Using Read: src/index.ts");
  });

  test("skips report_intent", () => {
    expect(getToolStatus("report_intent")).toBeUndefined();
  });
});
