import { test, expect, describe } from "bun:test";
import { StreamParser, formatToolDisplayName } from "./stream-parser.ts";

/** Helper to build a stream-json NDJSON string from events */
function buildStream(...events: object[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n");
}

const systemEvent = {
  type: "system",
  subtype: "init",
  session_id: "test-session",
  tools: ["Read", "Write"],
};

function makeResult(overrides: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    session_id: "test-session",
    is_error: false,
    num_turns: 1,
    duration_ms: 5000,
    duration_api_ms: 3000,
    total_cost_usd: 0.01,
    usage: { input_tokens: 500, output_tokens: 200 },
    result: "Hello world",
    ...overrides,
  };
}

function makeAssistant(content: object[], model = "claude-haiku-4-5-20251001") {
  return {
    type: "assistant",
    message: { content, model },
    parent_tool_use_id: null,
  };
}

function makeUser(content: object[]) {
  return {
    type: "user",
    uuid: crypto.randomUUID(),
    message: { content },
    parent_tool_use_id: null,
  };
}

describe("StreamParser", () => {
  test("parses simple text-only response", () => {
    const parser = new StreamParser();
    parser.parseAll(buildStream(
      systemEvent,
      makeAssistant([{ type: "text", text: "Hello world" }]),
      makeResult(),
    ));

    const result = parser.getResult();
    expect(result.result).toBe("Hello world");
    expect(result.durationMs).toBe(5000);
    expect(result.durationApiMs).toBe(3000);
    expect(result.costUsd).toBe(0.01);
    expect(result.numTurns).toBe(1);
    expect(result.inputTokens).toBe(500);
    expect(result.outputTokens).toBe(200);
    expect(result.model).toBe("claude-haiku-4-5-20251001");
    expect(result.toolCalls).toBeUndefined();
  });

  test("extracts tool calls from assistant messages", () => {
    const t0 = 1000;
    const parser = new StreamParser(t0);

    // Simulate: assistant calls a tool, user returns result, assistant responds
    parser.parseLine(JSON.stringify(systemEvent), t0);
    parser.parseLine(JSON.stringify(makeAssistant([
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "toolu_01", name: "mcp__gmail__search_emails", input: { query: "from:boss" } },
    ])), t0 + 100);
    parser.parseLine(JSON.stringify(makeUser([
      { type: "tool_result", tool_use_id: "toolu_01", content: "2 emails found", is_error: false },
    ])), t0 + 2100); // 2 seconds for tool execution
    parser.parseLine(JSON.stringify(makeAssistant([
      { type: "text", text: "You have 2 emails." },
    ])), t0 + 3000);
    parser.parseLine(JSON.stringify(makeResult({ num_turns: 2, result: "You have 2 emails." })), t0 + 3100);

    const result = parser.getResult();
    expect(result.result).toBe("You have 2 emails.");
    expect(result.numTurns).toBe(2);
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls!.length).toBe(1);

    const tool = result.toolCalls![0]!;
    expect(tool.id).toBe("toolu_01");
    expect(tool.name).toBe("mcp__gmail__search_emails");
    expect(tool.displayName).toBe("search_emails (gmail)");
    expect(tool.durationMs).toBe(2000); // 2100 - 100
    expect(tool.startOffsetMs).toBe(100); // tool started 100ms after ref
    expect(tool.input).toBe('{"query":"from:boss"}');
  });

  test("handles multiple tools in one turn", () => {
    const t0 = 1000;
    const parser = new StreamParser(t0);

    parser.parseLine(JSON.stringify(systemEvent), t0);
    parser.parseLine(JSON.stringify(makeAssistant([
      { type: "text", text: "Checking both." },
      { type: "tool_use", id: "toolu_01", name: "mcp__gmail__search_emails", input: { query: "test" } },
      { type: "tool_use", id: "toolu_02", name: "mcp__calendar__get_events", input: { date: "2026-02-15" } },
    ])), t0 + 100);
    parser.parseLine(JSON.stringify(makeUser([
      { type: "tool_result", tool_use_id: "toolu_01", content: "emails", is_error: false },
      { type: "tool_result", tool_use_id: "toolu_02", content: "events", is_error: false },
    ])), t0 + 5100);
    parser.parseLine(JSON.stringify(makeAssistant([
      { type: "text", text: "Here are results." },
    ])), t0 + 6000);
    parser.parseLine(JSON.stringify(makeResult({ num_turns: 2 })), t0 + 6100);

    const result = parser.getResult();
    expect(result.toolCalls!.length).toBe(2);
    expect(result.toolCalls![0]!.name).toBe("mcp__gmail__search_emails");
    expect(result.toolCalls![1]!.name).toBe("mcp__calendar__get_events");
    // Both tools started at same time, resolved at same time
    expect(result.toolCalls![0]!.durationMs).toBe(5000);
    expect(result.toolCalls![1]!.durationMs).toBe(5000);
    // Both have same start offset (appeared in same assistant message)
    expect(result.toolCalls![0]!.startOffsetMs).toBe(100);
    expect(result.toolCalls![1]!.startOffsetMs).toBe(100);
  });

  test("handles multiple sequential tool turns", () => {
    const t0 = 0;
    const parser = new StreamParser(t0);

    parser.parseLine(JSON.stringify(systemEvent), t0);
    // Turn 1: read file
    parser.parseLine(JSON.stringify(makeAssistant([
      { type: "tool_use", id: "toolu_01", name: "Read", input: { file_path: "/test.ts" } },
    ])), t0 + 100);
    parser.parseLine(JSON.stringify(makeUser([
      { type: "tool_result", tool_use_id: "toolu_01", content: "file content", is_error: false },
    ])), t0 + 200);
    // Turn 2: write file
    parser.parseLine(JSON.stringify(makeAssistant([
      { type: "tool_use", id: "toolu_02", name: "Write", input: { file_path: "/out.ts", content: "new" } },
    ])), t0 + 1200);
    parser.parseLine(JSON.stringify(makeUser([
      { type: "tool_result", tool_use_id: "toolu_02", content: "written", is_error: false },
    ])), t0 + 1300);
    // Final response
    parser.parseLine(JSON.stringify(makeAssistant([
      { type: "text", text: "Done." },
    ])), t0 + 2300);
    parser.parseLine(JSON.stringify(makeResult({ num_turns: 3 })), t0 + 2400);

    const result = parser.getResult();
    expect(result.toolCalls!.length).toBe(2);
    expect(result.toolCalls![0]!.name).toBe("Read");
    expect(result.toolCalls![0]!.displayName).toBe("Read");
    expect(result.toolCalls![0]!.durationMs).toBe(100); // 200 - 100
    expect(result.toolCalls![0]!.startOffsetMs).toBe(100); // started at t0 + 100
    expect(result.toolCalls![1]!.name).toBe("Write");
    expect(result.toolCalls![1]!.durationMs).toBe(100); // 1300 - 1200
    expect(result.toolCalls![1]!.startOffsetMs).toBe(1200); // started at t0 + 1200
  });

  test("uses result text over last assistant text", () => {
    const parser = new StreamParser();
    parser.parseAll(buildStream(
      systemEvent,
      makeAssistant([{ type: "text", text: "intermediate" }]),
      makeResult({ result: "final answer from result event" }),
    ));

    const result = parser.getResult();
    expect(result.result).toBe("final answer from result event");
  });

  test("throws on error result", () => {
    const parser = new StreamParser();
    parser.parseLine(JSON.stringify(systemEvent));

    expect(() => {
      parser.parseLine(JSON.stringify(makeResult({ is_error: true, result: "Rate limited" })));
    }).toThrow("Claude error: Rate limited");
  });

  test("throws if no result event received", () => {
    const parser = new StreamParser();
    parser.parseLine(JSON.stringify(systemEvent));
    parser.parseLine(JSON.stringify(makeAssistant([{ type: "text", text: "hello" }])));

    expect(() => parser.getResult()).toThrow("No result event");
  });

  test("handles cache tokens in usage", () => {
    const parser = new StreamParser();
    parser.parseAll(buildStream(
      systemEvent,
      makeAssistant([{ type: "text", text: "test" }]),
      makeResult({
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 50,
          cache_read_input_tokens: 25,
          output_tokens: 200,
        },
      }),
    ));

    const result = parser.getResult();
    expect(result.inputTokens).toBe(175);
    expect(result.outputTokens).toBe(200);
  });

  test("ignores malformed lines", () => {
    const parser = new StreamParser();
    parser.parseLine("not valid json");
    parser.parseLine("");
    parser.parseLine("   ");
    parser.parseLine(JSON.stringify(systemEvent));
    parser.parseLine(JSON.stringify(makeAssistant([{ type: "text", text: "ok" }])));
    parser.parseLine(JSON.stringify(makeResult()));

    const result = parser.getResult();
    expect(result.result).toBe("Hello world");
  });

  test("handles empty stream", () => {
    const parser = new StreamParser();
    parser.parseAll("");
    expect(() => parser.getResult()).toThrow("No result event");
  });

  test("abbreviates long tool input", () => {
    const t0 = 0;
    const parser = new StreamParser(t0);
    const longInput = { data: "x".repeat(600) };

    parser.parseLine(JSON.stringify(systemEvent), t0);
    parser.parseLine(JSON.stringify(makeAssistant([
      { type: "tool_use", id: "toolu_01", name: "Read", input: longInput },
    ])), t0 + 100);
    parser.parseLine(JSON.stringify(makeUser([
      { type: "tool_result", tool_use_id: "toolu_01", content: "result", is_error: false },
    ])), t0 + 200);
    parser.parseLine(JSON.stringify(makeAssistant([{ type: "text", text: "done" }])), t0 + 300);
    parser.parseLine(JSON.stringify(makeResult()), t0 + 400);

    const result = parser.getResult();
    expect(result.toolCalls![0]!.input!.length).toBeLessThanOrEqual(500);
    expect(result.toolCalls![0]!.input!).toEndWith("...");
  });

  test("complete flag tracks result receipt", () => {
    const parser = new StreamParser();
    expect(parser.complete).toBe(false);

    parser.parseLine(JSON.stringify(systemEvent));
    expect(parser.complete).toBe(false);

    parser.parseLine(JSON.stringify(makeAssistant([{ type: "text", text: "hi" }])));
    expect(parser.complete).toBe(false);

    parser.parseLine(JSON.stringify(makeResult()));
    expect(parser.complete).toBe(true);
  });
});

describe("formatToolDisplayName", () => {
  test("formats MCP tool names", () => {
    expect(formatToolDisplayName("mcp__gmail__search_emails")).toBe("search_emails (gmail)");
    expect(formatToolDisplayName("mcp__calendar__get_events")).toBe("get_events (calendar)");
    expect(formatToolDisplayName("mcp__claude_ai_Context7__query-docs")).toBe("query-docs (claude_ai_Context7)");
  });

  test("returns non-MCP names as-is", () => {
    expect(formatToolDisplayName("Read")).toBe("Read");
    expect(formatToolDisplayName("Write")).toBe("Write");
    expect(formatToolDisplayName("Bash")).toBe("Bash");
  });
});
