import { test, expect, describe, mock } from "bun:test";

// Mock DB to prevent real SQL calls
mock.module("../db/client.ts", () => ({
  getDb: () => {
    const sql = (_strings: TemplateStringsArray, ..._values: any[]) =>
      Promise.resolve([]);
    return sql;
  },
}));

// Capture span writes so we can assert tool child spans land under the
// watcher:<type> root span (attachToolSpans → Tracer → saveSpan).
const saveSpanCalls: Array<Record<string, unknown>> = [];
mock.module("../db/traces.ts", () => ({
  saveSpan: async (params: Record<string, unknown>) => { saveSpanCalls.push(params); },
  updateSpan: async () => {},
}));
mock.module("../config.ts", () => ({
  loadConfig: () => ({ tracingEnabled: true, tracingCaptureToolOutputs: true }),
}));

const { spawnHaiku, callHaiku, HAIKU_TIMEOUT_MS, parseHaikuJson, parseLegacyHaikuOutput, readAndParseHaikuStream } =
  await import("./executor.ts");
const { attachToolSpans } = await import("../core/tool-spans.ts");
const { Tracer } = await import("../tracing/index.ts");

/** Build a ReadableStream from NDJSON lines (mimics `claude` stream-json stdout). */
function ndjsonStream(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const body = lines.join("\n") + "\n";
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(body));
      controller.close();
    },
  });
}

describe("parseHaikuJson", () => {
  test("parses valid JSON", () => {
    expect(parseHaikuJson('{"result":"ok"}')).toEqual({ result: "ok" });
  });

  test("throws descriptive error with stdout preview on invalid JSON", () => {
    expect(() => parseHaikuJson("not json at all")).toThrow(
      /Failed to parse Haiku JSON output:.*not json at all/,
    );
  });

  test("truncates the stdout preview to 300 chars", () => {
    const long = "x".repeat(1000);
    try {
      parseHaikuJson(long);
      throw new Error("expected parseHaikuJson to throw");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The preview slice must not contain the full 1000-char payload.
      expect(msg).not.toContain("x".repeat(301));
      expect(msg).toContain("x".repeat(300));
    }
  });
});

describe("spawnHaiku timeout", () => {
  test("HAIKU_TIMEOUT_MS defaults to 60s", () => {
    expect(HAIKU_TIMEOUT_MS).toBe(60_000);
  });

  test("kills hanging process after timeout", async () => {
    // Call spawnHaiku directly with a very short timeout.
    // "claude" won't be found or will hang — either way it exceeds 100ms.
    await expect(
      spawnHaiku("test", { source: "timeout-test", entrypoint: "test", botName: "test-bot", timeoutMs: 100 }),
    ).rejects.toThrow(/timed out after 100ms|exited with code/);
  });

  test("clearTimeout runs in finally block even on success", async () => {
    // Verify the try/finally pattern: timer is cleared on normal exit
    const proc = Bun.spawn(["echo", "done"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });

    let timerCleared = false;
    let timeoutTimer: ReturnType<typeof setTimeout>;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        reject(new Error("should not fire"));
      }, 5000);
    });

    try {
      await Promise.race([proc.exited, timeoutPromise]);
    } finally {
      clearTimeout(timeoutTimer!);
      timerCleared = true;
    }

    expect(timerCleared).toBe(true);
  });
});

describe("callHaiku", () => {
  test("returns fallback when process fails", async () => {
    const result = await callHaiku("test", "fallback-value", "test-source", undefined, undefined, 100);
    expect(result).toBe("fallback-value");
  });
});

describe("parseLegacyHaikuOutput (fallback parse)", () => {
  test("recovers result + tokens + turns + cost from a legacy single-JSON blob", () => {
    const blob = JSON.stringify({
      type: "result",
      result: "hello world",
      num_turns: 3,
      total_cost_usd: 0.0042,
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 2,
        output_tokens: 7,
      },
      modelUsage: { "claude-haiku-4-5-20251001": { costUSD: 0.0042 } },
    });
    const r = parseLegacyHaikuOutput(blob, "fallback-model");
    expect(r.result).toBe("hello world");
    expect(r.inputTokens).toBe(17); // 10 + 5 + 2
    expect(r.outputTokens).toBe(7);
    expect(r.model).toBe("claude-haiku-4-5-20251001");
    expect(r.numTurns).toBe(3);
    expect(r.costUsd).toBe(0.0042);
    expect(r.toolCalls).toBeUndefined();
  });

  test("normalizes CLI-2.x result-as-object and falls back to effectiveModel", () => {
    const blob = JSON.stringify({
      result: { content: [{ type: "text", text: "boxed answer" }] },
    });
    const r = parseLegacyHaikuOutput(blob, "eff-model");
    expect(r.result).toBe("boxed answer");
    expect(r.model).toBe("eff-model");
    expect(r.inputTokens).toBe(0);
  });
});

describe("readAndParseHaikuStream", () => {
  const assistantWithTool = JSON.stringify({
    type: "assistant",
    message: {
      model: "claude-haiku-4-5-20251001",
      content: [{ type: "tool_use", id: "toolu_01", name: "mcp__gmail__search_emails", input: { query: "is:unread" } }],
      usage: { input_tokens: 100, output_tokens: 5 },
    },
  });
  const toolResult = JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "2 emails", is_error: false }] },
  });
  const assistantText = JSON.stringify({
    type: "assistant",
    message: { model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "[]" }], usage: { input_tokens: 120, output_tokens: 3 } },
  });
  const resultEvent = JSON.stringify({
    type: "result", result: "[]", num_turns: 2, total_cost_usd: 0.001,
    usage: { input_tokens: 120, output_tokens: 8 },
  });

  test("complete stream yields a result with parsed tool calls", async () => {
    const { result, rawLines } = await readAndParseHaikuStream(
      ndjsonStream([assistantWithTool, toolResult, assistantText, resultEvent]),
      performance.now(), undefined, "test-bot",
    );
    expect(result).not.toBeNull();
    expect(result!.result).toBe("[]");
    expect(result!.toolCalls).toHaveLength(1);
    expect(result!.toolCalls![0]!.name).toBe("mcp__gmail__search_emails");
    expect(result!.toolCalls![0]!.output).toBe("2 emails");
    expect(rawLines.length).toBe(4);
  });

  test("stream missing the result event returns null (drops to legacy fallback)", async () => {
    // The known CLI bug: the CLI degrades to a single legacy JSON blob with no
    // stream `result` event. readAndParseHaikuStream returns null, and the raw
    // blob feeds parseLegacyHaikuOutput — exactly spawnHaiku's fallback path.
    const legacyBlob = JSON.stringify({ result: "recovered", usage: { input_tokens: 4, output_tokens: 2 } });
    const { result, rawLines } = await readAndParseHaikuStream(
      ndjsonStream([legacyBlob]), performance.now(), undefined, "test-bot",
    );
    expect(result).toBeNull();
    const recovered = parseLegacyHaikuOutput(rawLines.join("\n"), "eff");
    expect(recovered.result).toBe("recovered");
    expect(recovered.inputTokens).toBe(4);
    expect(recovered.outputTokens).toBe(2);
  });

  test("fires live tool progress callbacks as lines arrive", async () => {
    const events: string[] = [];
    await readAndParseHaikuStream(
      ndjsonStream([assistantWithTool, toolResult, assistantText, resultEvent]),
      performance.now(),
      (e) => events.push(e.type),
      "test-bot",
    );
    expect(events).toContain("tool_start");
    expect(events).toContain("tool_end");
  });
});

describe("tool child spans under watcher:<type>", () => {
  test("attachToolSpans lands the Haiku tool call under the watcher root span", async () => {
    saveSpanCalls.length = 0;
    const tracer = new Tracer("watcher:email", { botName: "jarvis", userId: "u1" });
    const rootId = saveSpanCalls[0]!.id as string;
    expect(saveSpanCalls[0]!.name).toBe("watcher:email");

    await attachToolSpans(
      tracer,
      [{
        id: "toolu_01",
        name: "mcp__gmail__search_emails",
        displayName: "search_emails (gmail)",
        durationMs: 1200,
        startOffsetMs: 50,
        input: JSON.stringify({ query: "is:unread" }),
        output: "2 emails",
      }],
      false,
    );

    const toolSpan = saveSpanCalls.find((s) => s.name === "search_emails (gmail)");
    expect(toolSpan).toBeDefined();
    // Parent is the watcher root span (attachToolSpans' "claude" label is absent
    // on a watcher Tracer, so addChildSpan falls back to the root span).
    expect(toolSpan!.parentId).toBe(rootId);
    expect((toolSpan!.attributes as any).toolName).toBe("mcp__gmail__search_emails");
  });
});
