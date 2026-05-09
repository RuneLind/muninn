import { test, expect, describe, mock } from "bun:test";
import { StreamParser, formatToolDisplayName, isReportIntentTool, extractIntentText, type StreamProgressEvent } from "./stream-parser.ts";
import { truncateOutput, TOOL_OUTPUT_MAX_BYTES } from "./truncate-output.ts";

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
    expect(tool.output).toBe("2 emails found");
  });

  test("captures tool output from user event", () => {
    const parser = new StreamParser(0);
    parser.parseLine(JSON.stringify(systemEvent), 0);
    parser.parseLine(JSON.stringify(makeAssistant([
      { type: "tool_use", id: "toolu_A", name: "mcp__knowledge__search_knowledge", input: { query: "foo" } },
      { type: "tool_use", id: "toolu_B", name: "mcp__knowledge__get_document", input: { doc_id: "x" } },
    ])), 100);
    parser.parseLine(JSON.stringify(makeUser([
      { type: "tool_result", tool_use_id: "toolu_A", content: "search hit", is_error: false },
      { type: "tool_result", tool_use_id: "toolu_B", content: [{ type: "text", text: "doc body" }, { type: "text", text: " part two" }], is_error: false },
    ])), 200);
    parser.parseLine(JSON.stringify(makeResult({ num_turns: 2 })), 300);

    const result = parser.getResult();
    expect(result.toolCalls![0]!.output).toBe("search hit");
    expect(result.toolCalls![1]!.output).toBe("doc body\n part two");
  });

  test("tool output is undefined when user event lacks matching tool_result", () => {
    const parser = new StreamParser(0);
    parser.parseLine(JSON.stringify(systemEvent), 0);
    parser.parseLine(JSON.stringify(makeAssistant([
      { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "ls" } },
    ])), 100);
    // User event without content array — legacy format / missing result
    parser.parseLine(JSON.stringify({ type: "user", message: {}, parent_tool_use_id: null }), 200);
    parser.parseLine(JSON.stringify(makeResult({ num_turns: 2 })), 300);

    const result = parser.getResult();
    expect(result.toolCalls![0]!.output).toBeUndefined();
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

  test("handles parallel tools split across separate assistant + user events (claude-cli pattern)", () => {
    const t0 = 1000;
    const parser = new StreamParser(t0);

    parser.parseLine(JSON.stringify(systemEvent), t0);
    parser.parseLine(JSON.stringify(makeAssistant([
      { type: "tool_use", id: "toolu_01", name: "mcp__knowledge__search_knowledge", input: { query: "x" } },
    ])), t0 + 100);
    parser.parseLine(JSON.stringify(makeAssistant([
      { type: "tool_use", id: "toolu_02", name: "mcp__yggdrasil__search", input: { query: "y" } },
    ])), t0 + 110);
    parser.parseLine(JSON.stringify(makeUser([
      { type: "tool_result", tool_use_id: "toolu_01", content: "knowledge result", is_error: false },
    ])), t0 + 4500);
    parser.parseLine(JSON.stringify(makeUser([
      { type: "tool_result", tool_use_id: "toolu_02", content: "yggdrasil result", is_error: false },
    ])), t0 + 4600);
    parser.parseLine(JSON.stringify(makeAssistant([
      { type: "text", text: "Done." },
    ])), t0 + 5000);
    parser.parseLine(JSON.stringify(makeResult({ num_turns: 2 })), t0 + 5100);

    const result = parser.getResult();
    expect(result.toolCalls!.length).toBe(2);
    const knowledge = result.toolCalls!.find((t) => t.id === "toolu_01")!;
    const yggdrasil = result.toolCalls!.find((t) => t.id === "toolu_02")!;
    expect(knowledge.output).toBe("knowledge result");
    expect(yggdrasil.output).toBe("yggdrasil result");
    expect(knowledge.durationMs).toBe(4400);
    expect(yggdrasil.durationMs).toBe(4490);
  });

  test("drains pending tools at result event when tool_result never arrived", () => {
    const t0 = 0;
    const parser = new StreamParser(t0);

    parser.parseLine(JSON.stringify(systemEvent), t0);
    parser.parseLine(JSON.stringify(makeAssistant([
      { type: "tool_use", id: "toolu_01", name: "mcp__x__y", input: {} },
    ])), t0 + 100);
    parser.parseLine(JSON.stringify(makeResult({ num_turns: 1 })), t0 + 500);

    const result = parser.getResult();
    expect(result.toolCalls!.length).toBe(1);
    expect(result.toolCalls![0]!.output).toBeUndefined();
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

  test("eagerly starts trace fetch when a pointer arrives, not deferred to result", async () => {
    // Huginn's trace store has a short TTL. If muninn waits to fetch until the
    // claude session ends (which can be many minutes for multi-tool sessions),
    // the pointer 404s. The parser must kick the fetch off the moment the
    // tool_result is parsed, so even a long subsequent session keeps the trace.
    const origUrl = process.env.KNOWLEDGE_API_URL;
    process.env.KNOWLEDGE_API_URL = "http://test-allowed.example.com";
    const origFetch = globalThis.fetch;
    let fetchInvocations = 0;
    let fetchInvokedAtMs: number | null = null;
    const start = performance.now();
    globalThis.fetch = mock(async () => {
      fetchInvocations++;
      fetchInvokedAtMs = performance.now() - start;
      return new Response(JSON.stringify({ schemaVersion: 1, query: "x", collections: [] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    try {
      const parser = new StreamParser(0);
      parser.parseLine(JSON.stringify(systemEvent), 0);
      parser.parseLine(
        JSON.stringify(
          makeAssistant([{ type: "tool_use", id: "toolu_P", name: "mcp__knowledge__search_knowledge", input: { query: "x" } }]),
        ),
        100,
      );
      const pointer = "http://test-allowed.example.com/api/trace/0123456789abcdef";
      parser.parseLine(
        JSON.stringify(
          makeUser([
            {
              type: "tool_result",
              tool_use_id: "toolu_P",
              content: `1. **Hit.md** (75% relevant)\n   collection: knowledge\n\nhuginn-trace-url: ${pointer}\n`,
              is_error: false,
            },
          ]),
        ),
        200,
      );
      parser.parseLine(JSON.stringify(makeResult({ num_turns: 2 })), 300);

      const result = parser.getResult();
      const tool = result.toolCalls![0]!;

      // The fetch must have been initiated by the time parseLine returned.
      expect(fetchInvocations).toBe(1);
      expect(fetchInvokedAtMs).toBeLessThan(50); // well within ms of pointer arrival
      expect(tool.searchTracePointer).toBe(pointer);
      expect(tool.searchTraceFetch).toBeInstanceOf(Promise);

      // The in-flight fetch resolves to the trace body — message-processor.ts
      // will await this and merge onto attrs.searchTrace.
      const fetched = await tool.searchTraceFetch!;
      expect(fetched).toEqual({ schemaVersion: 1, query: "x", collections: [] });

      // Output is unwrapped + stripped of the marker line.
      expect(tool.output).not.toContain("huginn-trace-url");
      expect(tool.searchTrace).toBeUndefined(); // pointer mode: trace lives behind the URL until awaited
    } finally {
      globalThis.fetch = origFetch;
      if (origUrl === undefined) delete process.env.KNOWLEDGE_API_URL;
      else process.env.KNOWLEDGE_API_URL = origUrl;
    }
  });

  test("does not start a fetch when no pointer is present", () => {
    const origFetch = globalThis.fetch;
    let invoked = 0;
    globalThis.fetch = mock(async () => {
      invoked++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const parser = new StreamParser(0);
      parser.parseLine(JSON.stringify(systemEvent), 0);
      parser.parseLine(
        JSON.stringify(
          makeAssistant([{ type: "tool_use", id: "toolu_X", name: "Read", input: { file_path: "/a" } }]),
        ),
        100,
      );
      parser.parseLine(
        JSON.stringify(
          makeUser([{ type: "tool_result", tool_use_id: "toolu_X", content: "plain output", is_error: false }]),
        ),
        200,
      );
      parser.parseLine(JSON.stringify(makeResult({ num_turns: 2 })), 300);

      const tool = parser.getResult().toolCalls![0]!;
      expect(invoked).toBe(0);
      expect(tool.searchTraceFetch).toBeUndefined();
      expect(tool.searchTracePointer).toBeUndefined();
    } finally {
      globalThis.fetch = origFetch;
    }
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

describe("StreamParser progress callbacks", () => {
  test("fires tool_start and tool_end for tool calls", () => {
    const events: StreamProgressEvent[] = [];
    const onProgress = mock((e: StreamProgressEvent) => events.push(e));

    const t0 = 1000;
    const parser = new StreamParser(t0, onProgress);

    parser.parseLine(JSON.stringify(systemEvent), t0);
    parser.parseLine(JSON.stringify(makeAssistant([
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "toolu_01", name: "mcp__gmail__search_emails", input: { query: "test" } },
    ])), t0 + 100);

    // tool_start should have fired
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "tool_start", name: "mcp__gmail__search_emails", displayName: "search_emails (gmail)", input: '{"query":"test"}' });

    // Tool result resolves the tool
    parser.parseLine(JSON.stringify(makeUser([
      { type: "tool_result", tool_use_id: "toolu_01", content: "emails", is_error: false },
    ])), t0 + 2100);

    // User message with tool_result resolves pending tools → fires tool_end
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ type: "tool_end", name: "mcp__gmail__search_emails", displayName: "search_emails (gmail)" });

    // Final assistant response
    parser.parseLine(JSON.stringify(makeAssistant([
      { type: "text", text: "You have emails." },
    ])), t0 + 3000);

    // text event fires for text-only assistant message
    expect(events).toHaveLength(3);
    expect(events[2]).toEqual({ type: "text" });

    parser.parseLine(JSON.stringify(makeResult({ result: "You have emails." })), t0 + 3100);
    expect(parser.complete).toBe(true);
  });

  test("fires tool_start for each tool in a multi-tool turn", () => {
    const events: StreamProgressEvent[] = [];
    const t0 = 1000;
    const parser = new StreamParser(t0, (e) => events.push(e));

    parser.parseLine(JSON.stringify(systemEvent), t0);
    parser.parseLine(JSON.stringify(makeAssistant([
      { type: "tool_use", id: "toolu_01", name: "mcp__gmail__search_emails", input: {} },
      { type: "tool_use", id: "toolu_02", name: "mcp__calendar__get_events", input: {} },
    ])), t0 + 100);

    // Both tool_start events should fire
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("tool_start");
    expect((events[0] as any).displayName).toBe("search_emails (gmail)");
    expect(events[1]!.type).toBe("tool_start");
    expect((events[1] as any).displayName).toBe("get_events (calendar)");

    // Resolve
    parser.parseLine(JSON.stringify(makeUser([
      { type: "tool_result", tool_use_id: "toolu_01", content: "ok", is_error: false },
      { type: "tool_result", tool_use_id: "toolu_02", content: "ok", is_error: false },
    ])), t0 + 5000);

    // Both tool_end events
    expect(events).toHaveLength(4);
    expect(events[2]!.type).toBe("tool_end");
    expect(events[3]!.type).toBe("tool_end");
  });

  test("does not fire text event when assistant message has tools", () => {
    const events: StreamProgressEvent[] = [];
    const t0 = 0;
    const parser = new StreamParser(t0, (e) => events.push(e));

    parser.parseLine(JSON.stringify(systemEvent), t0);
    parser.parseLine(JSON.stringify(makeAssistant([
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "toolu_01", name: "Read", input: {} },
    ])), t0 + 100);

    // Only tool_start, no text event
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("tool_start");
  });

  test("works without callback (backward compatible)", () => {
    const parser = new StreamParser();
    parser.parseAll(buildStream(
      systemEvent,
      makeAssistant([{ type: "text", text: "Hello" }]),
      makeResult(),
    ));
    expect(parser.getResult().result).toBe("Hello world");
  });
});

describe("StreamParser text_delta from stream_event", () => {
  function makeStreamEvent(deltaType: string, text: string) {
    return {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 1,
        delta: { type: deltaType, text },
      },
    };
  }

  test("emits text_delta from stream_event content_block_delta", () => {
    const events: StreamProgressEvent[] = [];
    const t0 = 1000;
    const parser = new StreamParser(t0, (e) => events.push(e));

    parser.parseLine(JSON.stringify(systemEvent), t0);
    parser.parseLine(JSON.stringify(makeStreamEvent("text_delta", "Hello")), t0 + 100);
    parser.parseLine(JSON.stringify(makeStreamEvent("text_delta", " world")), t0 + 200);

    const deltas = events.filter((e) => e.type === "text_delta");
    expect(deltas).toHaveLength(2);
    expect((deltas[0] as any).text).toBe("Hello");
    expect((deltas[1] as any).text).toBe(" world");
  });

  test("ignores thinking_delta stream events", () => {
    const events: StreamProgressEvent[] = [];
    const t0 = 1000;
    const parser = new StreamParser(t0, (e) => events.push(e));

    parser.parseLine(JSON.stringify(systemEvent), t0);
    parser.parseLine(JSON.stringify(makeStreamEvent("thinking_delta", "Let me think")), t0 + 100);

    const deltas = events.filter((e) => e.type === "text_delta");
    expect(deltas).toHaveLength(0);
  });

  test("text_delta flows alongside tool events in multi-turn", () => {
    const events: StreamProgressEvent[] = [];
    const t0 = 1000;
    const parser = new StreamParser(t0, (e) => events.push(e));

    parser.parseLine(JSON.stringify(systemEvent), t0);

    // Streaming text deltas before assistant message completes
    parser.parseLine(JSON.stringify(makeStreamEvent("text_delta", "Let me ")), t0 + 50);
    parser.parseLine(JSON.stringify(makeStreamEvent("text_delta", "check.")), t0 + 60);

    // Assistant message with text + tool (non-streaming, complete message)
    parser.parseLine(JSON.stringify(makeAssistant([
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "toolu_01", name: "Read", input: {} },
    ])), t0 + 100);

    // Tool result
    parser.parseLine(JSON.stringify(makeUser([
      { type: "tool_result", tool_use_id: "toolu_01", content: "ok", is_error: false },
    ])), t0 + 500);

    // Streaming text for second turn
    parser.parseLine(JSON.stringify(makeStreamEvent("text_delta", "Done.")), t0 + 550);

    const deltas = events.filter((e) => e.type === "text_delta");
    expect(deltas).toHaveLength(3);
    expect((deltas[0] as any).text).toBe("Let me ");
    expect((deltas[1] as any).text).toBe("check.");
    expect((deltas[2] as any).text).toBe("Done.");

    // Tool events also fired
    const toolStarts = events.filter((e) => e.type === "tool_start");
    expect(toolStarts).toHaveLength(1);
  });

  test("works without callback (no crash)", () => {
    const parser = new StreamParser();
    // Should not throw when no callback
    parser.parseLine(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
    }));
  });
});

describe("StreamParser huginn-trace extraction", () => {
  test("peels trace fence off tool_result before truncation", () => {
    const t0 = 0;
    const parser = new StreamParser(t0);

    // Build a result whose body alone is over the 16 KB cap, with the
    // huginn-trace fence appended after — the closing ``` would otherwise
    // get cut by truncateOutput and parseHuginnTrace would find nothing.
    const body = "x".repeat(20 * 1024);
    const trace = { query: { raw: "hello" }, schemaVersion: 1 };
    const raw = `${body}\n\n\`\`\`huginn-trace\n${JSON.stringify(trace)}\n\`\`\``;

    parser.parseLine(JSON.stringify(systemEvent), t0);
    parser.parseLine(JSON.stringify(makeAssistant([
      { type: "tool_use", id: "toolu_01", name: "mcp__knowledge__search_knowledge", input: { q: "hi" } },
    ])), t0 + 100);
    parser.parseLine(JSON.stringify(makeUser([
      { type: "tool_result", tool_use_id: "toolu_01", content: raw, is_error: false },
    ])), t0 + 200);
    parser.parseLine(JSON.stringify(makeResult({ num_turns: 2 })), t0 + 300);

    const result = parser.getResult();
    const tool = result.toolCalls![0]!;
    expect(tool.searchTrace).toEqual(trace);
    // Output is the cleaned body (truncated for storage), no fence present
    expect(typeof tool.output).toBe("string");
    expect(tool.output!).not.toContain("huginn-trace");
  });

  test("leaves non-huginn outputs unchanged", () => {
    const t0 = 0;
    const parser = new StreamParser(t0);
    parser.parseLine(JSON.stringify(systemEvent), t0);
    parser.parseLine(JSON.stringify(makeAssistant([
      { type: "tool_use", id: "toolu_01", name: "Read", input: {} },
    ])), t0 + 100);
    parser.parseLine(JSON.stringify(makeUser([
      { type: "tool_result", tool_use_id: "toolu_01", content: "hello world", is_error: false },
    ])), t0 + 200);
    parser.parseLine(JSON.stringify(makeResult()), t0 + 300);

    const tool = parser.getResult().toolCalls![0]!;
    expect(tool.output).toBe("hello world");
    expect(tool.searchTrace).toBeUndefined();
  });
});

describe("StreamParser contextTokens (per-turn input tokens)", () => {
  test("tracks last assistant turn's input tokens as contextTokens", () => {
    const parser = new StreamParser();
    parser.parseLine(JSON.stringify(systemEvent));
    // Turn 1: smaller input
    parser.parseLine(JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-sonnet-4-6",
        content: [{ type: "tool_use", id: "toolu_01", name: "Read", input: {} }],
        usage: { input_tokens: 1000, output_tokens: 50 },
      },
      parent_tool_use_id: null,
    }));
    parser.parseLine(JSON.stringify(makeUser([
      { type: "tool_result", tool_use_id: "toolu_01", content: "ok", is_error: false },
    ])));
    // Turn 2: larger input (cumulative growth)
    parser.parseLine(JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Done." }],
        usage: { input_tokens: 2500, cache_read_input_tokens: 500, output_tokens: 80 },
      },
      parent_tool_use_id: null,
    }));
    parser.parseLine(JSON.stringify(makeResult({
      num_turns: 2,
      usage: { input_tokens: 3500, output_tokens: 130 },
    })));

    const result = parser.getResult();
    // contextTokens = last turn's input + cache_read = 2500 + 500
    expect(result.contextTokens).toBe(3000);
    // cumulative inputTokens unchanged (from result event)
    expect(result.inputTokens).toBe(3500);
  });

  test("contextTokens undefined when no per-turn usage seen", () => {
    const parser = new StreamParser();
    parser.parseAll(buildStream(
      systemEvent,
      makeAssistant([{ type: "text", text: "Hi" }]),  // no usage on assistant
      makeResult(),
    ));
    expect(parser.getResult().contextTokens).toBeUndefined();
  });

  test("emits usage_progress per assistant turn with usage", () => {
    const events: StreamProgressEvent[] = [];
    const parser = new StreamParser(performance.now(), (e) => events.push(e));
    parser.parseLine(JSON.stringify(systemEvent));
    parser.parseLine(JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Working" }],
        usage: { input_tokens: 1000, cache_read_input_tokens: 200, output_tokens: 50 },
      },
      parent_tool_use_id: null,
    }));
    parser.parseLine(JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "Done" }],
        usage: { input_tokens: 2000, output_tokens: 80 },
      },
      parent_tool_use_id: null,
    }));

    const usageEvents = events.filter((e) => e.type === "usage_progress");
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[0]).toEqual({
      type: "usage_progress",
      inputTokens: 1200,  // 1000 + 200 cache_read
      outputTokens: 50,
      model: "claude-sonnet-4-6",
    });
    // Second turn — output is cumulative across turns
    expect(usageEvents[1]).toEqual({
      type: "usage_progress",
      inputTokens: 2000,  // last turn only
      outputTokens: 130,  // 50 + 80
      model: "claude-sonnet-4-6",
    });
  });

  test("does not emit usage_progress when assistant message has no usage", () => {
    const events: StreamProgressEvent[] = [];
    const parser = new StreamParser(performance.now(), (e) => events.push(e));
    parser.parseAll(buildStream(
      systemEvent,
      makeAssistant([{ type: "text", text: "Hi" }]),
      makeResult(),
    ));
    expect(events.filter((e) => e.type === "usage_progress")).toHaveLength(0);
  });
});

describe("StreamParser report_intent → intent event", () => {
  test("emits intent event for bare report_intent tool", () => {
    const events: StreamProgressEvent[] = [];
    const parser = new StreamParser(0, (e) => events.push(e));

    parser.parseLine(JSON.stringify(systemEvent), 0);
    parser.parseLine(JSON.stringify(makeAssistant([
      { type: "tool_use", id: "toolu_01", name: "report_intent", input: { intent: "Looking up your calendar" } },
    ])), 100);

    const intents = events.filter((e) => e.type === "intent");
    expect(intents).toHaveLength(1);
    expect((intents[0] as { type: "intent"; text: string }).text).toBe("Looking up your calendar");
    // Tool span still emits — intent doesn't replace it
    expect(events.filter((e) => e.type === "tool_start")).toHaveLength(1);
  });

  test("emits intent event for mcp-wrapped report_intent tool", () => {
    const events: StreamProgressEvent[] = [];
    const parser = new StreamParser(0, (e) => events.push(e));

    parser.parseLine(JSON.stringify(systemEvent), 0);
    parser.parseLine(JSON.stringify(makeAssistant([
      { type: "tool_use", id: "toolu_01", name: "mcp__intent__report_intent", input: { description: "Drafting reply" } },
    ])), 100);

    const intents = events.filter((e) => e.type === "intent");
    expect(intents).toHaveLength(1);
    expect((intents[0] as { type: "intent"; text: string }).text).toBe("Drafting reply");
  });

  test("does not emit intent for non-report_intent tools", () => {
    const events: StreamProgressEvent[] = [];
    const parser = new StreamParser(0, (e) => events.push(e));

    parser.parseLine(JSON.stringify(systemEvent), 0);
    parser.parseLine(JSON.stringify(makeAssistant([
      { type: "tool_use", id: "toolu_01", name: "Read", input: { file_path: "/x" } },
    ])), 100);

    expect(events.filter((e) => e.type === "intent")).toHaveLength(0);
  });

  test("does not emit intent when input lacks recognizable text field", () => {
    const events: StreamProgressEvent[] = [];
    const parser = new StreamParser(0, (e) => events.push(e));

    parser.parseLine(JSON.stringify(systemEvent), 0);
    parser.parseLine(JSON.stringify(makeAssistant([
      { type: "tool_use", id: "toolu_01", name: "report_intent", input: { unrelated: 42 } },
    ])), 100);

    expect(events.filter((e) => e.type === "intent")).toHaveLength(0);
    // tool_start still emitted
    expect(events.filter((e) => e.type === "tool_start")).toHaveLength(1);
  });
});

describe("isReportIntentTool", () => {
  test("matches all known formats", () => {
    expect(isReportIntentTool("report_intent")).toBe(true);
    expect(isReportIntentTool("mcp__intent__report_intent")).toBe(true);
    expect(isReportIntentTool("intent__report_intent")).toBe(true);
    expect(isReportIntentTool("intent-report_intent")).toBe(true);
  });

  test("rejects unrelated tools", () => {
    expect(isReportIntentTool("Read")).toBe(false);
    expect(isReportIntentTool("mcp__gmail__search_emails")).toBe(false);
    expect(isReportIntentTool("report_intent_v2")).toBe(false);
  });
});

describe("extractIntentText", () => {
  test("reads intent / description / text fields from object", () => {
    expect(extractIntentText({ intent: "looking up X" })).toBe("looking up X");
    expect(extractIntentText({ description: "drafting reply" })).toBe("drafting reply");
    expect(extractIntentText({ text: "thinking" })).toBe("thinking");
  });

  test("parses JSON string arguments (openai-compat path)", () => {
    expect(extractIntentText('{"intent":"checking calendar"}')).toBe("checking calendar");
  });

  test("returns undefined for missing or non-string field", () => {
    expect(extractIntentText({ unrelated: 42 })).toBeUndefined();
    expect(extractIntentText(null)).toBeUndefined();
    expect(extractIntentText(undefined)).toBeUndefined();
    expect(extractIntentText("not json")).toBeUndefined();
  });

  test("prefers intent over description over text", () => {
    expect(extractIntentText({ intent: "A", description: "B", text: "C" })).toBe("A");
    expect(extractIntentText({ description: "B", text: "C" })).toBe("B");
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

describe("truncateOutput", () => {
  test("returns undefined for null/undefined", () => {
    expect(truncateOutput(null)).toBeUndefined();
    expect(truncateOutput(undefined)).toBeUndefined();
  });

  test("passes through small strings unchanged", () => {
    expect(truncateOutput("hello world")).toBe("hello world");
  });

  test("JSON-stringifies non-string values", () => {
    expect(truncateOutput({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}');
    expect(truncateOutput([1, 2, 3])).toBe("[1,2,3]");
  });

  test("passes through values at exactly the cap", () => {
    const atCap = "a".repeat(TOOL_OUTPUT_MAX_BYTES);
    expect(truncateOutput(atCap)).toBe(atCap);
  });

  test("wraps over-cap strings in a truncation envelope", () => {
    const oversized = "x".repeat(TOOL_OUTPUT_MAX_BYTES + 100);
    const out = truncateOutput(oversized)!;
    const parsed = JSON.parse(out);
    expect(parsed._truncated).toBe(true);
    expect(parsed._originalBytes).toBe(TOOL_OUTPUT_MAX_BYTES + 100);
    expect(typeof parsed.head).toBe("string");
    // The head should be the first ~16 KB of the original (byte-wise)
    expect(Buffer.byteLength(parsed.head, "utf8")).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_BYTES);
    expect(parsed.head.startsWith("xxx")).toBe(true);
  });

  test("wraps over-cap objects in a truncation envelope", () => {
    // Build a JSON object whose serialization exceeds the cap
    const fatArray = Array.from({ length: 2000 }, (_, i) => `item-${i}`);
    const out = truncateOutput({ items: fatArray })!;
    const parsed = JSON.parse(out);
    expect(parsed._truncated).toBe(true);
    expect(parsed._originalBytes).toBeGreaterThan(TOOL_OUTPUT_MAX_BYTES);
    expect(typeof parsed.head).toBe("string");
  });

  test("handles unserializable values gracefully", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(truncateOutput(circular)).toBeUndefined();
  });
});
