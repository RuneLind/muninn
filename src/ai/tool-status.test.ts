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

  test("knowledge search renders configured fields as key=value", () => {
    const input = '{"query": "authentication flow", "collection": "team-docs"}';
    expect(getToolStatus("knowledge-search_knowledge", input)).toBe(
      "Searching knowledge base: collection=team-docs · query=authentication flow",
    );
    expect(getToolStatus("mcp__knowledge__search_knowledge", input)).toBe(
      "Searching knowledge base: collection=team-docs · query=authentication flow",
    );
  });

  test("knowledge search renders brief=true as bare flag", () => {
    const input = '{"query": "lovvalg", "collection": "nav-wiki", "brief": true}';
    expect(getToolStatus("knowledge-search_knowledge", input)).toBe(
      "Searching knowledge base: collection=nav-wiki · brief · query=lovvalg",
    );
  });

  test("knowledge search omits brief=false", () => {
    const input = '{"query": "lovvalg", "collection": "nav-wiki", "brief": false}';
    expect(getToolStatus("knowledge-search_knowledge", input)).toBe(
      "Searching knowledge base: collection=nav-wiki · query=lovvalg",
    );
  });

  test("knowledge search handles escaped quotes in field values", () => {
    // A raw regex approach would stop at the first inner quote; structured parse handles this correctly.
    const input = JSON.stringify({ query: 'find "foo" AND bar', collection: "nav-wiki" });
    expect(getToolStatus("knowledge-search_knowledge", input)).toBe(
      'Searching knowledge base: collection=nav-wiki · query=find "foo" AND bar',
    );
  });

  test("knowledge search falls back to regex when input is truncated", () => {
    // Simulates the upstream `abbreviateInput` trailing-dots truncation at 500 chars.
    const input = '{"query": "foo", "collection": "nav-wiki", "big_field": "xxx...';
    expect(getToolStatus("knowledge-search_knowledge", input)).toBe(
      "Searching knowledge base: collection=nav-wiki · query=foo",
    );
  });

  test("includes email search detail", () => {
    const input = '{"query": "invoice from Acme Corp"}';
    expect(getToolStatus("gmail-search_emails", input)).toBe("Searching email: invoice from Acme Corp");
  });

  test("knowledge get_document renders collection and doc_id", () => {
    const input = '{"collection": "team-docs", "doc_id": "MELOSYS-7912"}';
    expect(getToolStatus("knowledge-get_document", input)).toBe(
      "Loading document: collection=team-docs · doc_id=MELOSYS-7912",
    );
  });

  test("knowledge get_document with no matching fields shows label only", () => {
    const input = '{"irrelevant": "value"}';
    expect(getToolStatus("knowledge-get_document", input)).toBe("Loading document...");
  });

  test("truncates long search queries", () => {
    const longQuery = "a".repeat(200);
    const input = `{"query": "${longQuery}"}`;
    const result = getToolStatus("knowledge-search_knowledge", input)!;
    expect(result.length).toBeLessThan(180);
    expect(result).toContain("…");
  });

  test("yggdrasil search renders repo and query from config", () => {
    const input = '{"query": "BehandlingService", "repo": "melosys-api", "limit": 10}';
    expect(getToolStatus("mcp__yggdrasil__search", input)).toBe(
      "search (yggdrasil): repo=melosys-api · query=BehandlingService",
    );
  });

  test("yggdrasil symbol_context renders qualified_name", () => {
    const input = '{"qualified_name": "no.nav.melosys.BehandlingService", "repo": "melosys-api"}';
    expect(getToolStatus("yggdrasil-symbol_context", input)).toBe(
      "symbol_context (yggdrasil): qualified_name=no.nav.melosys.BehandlingService · repo=melosys-api",
    );
  });

  test("yggdrasil impact renders numeric max_depth", () => {
    const input = '{"qualified_name": "no.nav.melosys.Foo", "repo": "melosys-api", "max_depth": 3}';
    expect(getToolStatus("yggdrasil-impact", input)).toBe(
      "impact (yggdrasil): qualified_name=no.nav.melosys.Foo · repo=melosys-api · max_depth=3",
    );
  });

  test("yggdrasil list_repos shows label only (no fields in config)", () => {
    expect(getToolStatus("yggdrasil-list_repos", "{}")).toBe("list_repos (yggdrasil)...");
  });

  test("yggdrasil read_source renders line range", () => {
    const input = '{"repo": "melosys-api", "path": "src/Service.kt", "start_line": 34, "end_line": 80}';
    expect(getToolStatus("yggdrasil-read_source", input)).toBe(
      "read_source (yggdrasil): repo=melosys-api · path=src/Service.kt · start_line=34 · end_line=80",
    );
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
