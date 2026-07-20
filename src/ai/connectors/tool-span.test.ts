import { test, expect } from "bun:test";
import { recordToolSpan } from "./tool-span.ts";
import { TOOL_OUTPUT_MAX_BYTES } from "../truncate-output.ts";

test("recordToolSpan builds the ToolCall shape from a plain string result", () => {
  const { toolCall, toolEndEvent, cleanedText } = recordToolSpan({
    id: "call_1",
    name: "mcp__gmail__search_emails",
    input: '{"query":"invoices"}',
    rawResult: "3 matching threads",
    startMs: 1000,
    endMs: 1250,
    wallStart: 900,
  });

  expect(toolCall).toEqual({
    id: "call_1",
    name: "mcp__gmail__search_emails",
    displayName: "search_emails (gmail)",
    durationMs: 250,
    startOffsetMs: 100,
    input: '{"query":"invoices"}',
    output: "3 matching threads",
    searchTrace: undefined,
    searchTracePointer: undefined,
    searchTraceFetch: undefined,
  });
  expect(cleanedText).toBe("3 matching threads");
});

test("tool_end event carries the post-truncation output size", () => {
  const { toolEndEvent, toolCall } = recordToolSpan({
    id: "call_2",
    name: "Read",
    input: undefined,
    rawResult: "hello world",
    startMs: 0,
    endMs: 10,
    wallStart: 0,
  });

  expect(toolEndEvent).toEqual({
    type: "tool_end",
    name: "Read",
    displayName: "Read",
    outputSize: "hello world".length,
  });
  // outputSize matches the stored (truncated) output length, not the raw input.
  expect(toolEndEvent.outputSize).toBe(toolCall.output!.length);
});

test("outputSize reflects the truncation envelope, not the raw payload length", () => {
  const huge = "x".repeat(TOOL_OUTPUT_MAX_BYTES * 2);
  const { toolCall, toolEndEvent } = recordToolSpan({
    id: "call_3",
    name: "mcp__huginn__search",
    input: undefined,
    rawResult: huge,
    startMs: 0,
    endMs: 5,
    wallStart: 0,
  });

  // The stored output is the truncation envelope, far smaller than the raw 32KB.
  expect(toolCall.output!.length).toBeLessThan(huge.length);
  expect(toolCall.output).toContain("_truncated");
  // tool_end reports the post-truncation size, aligned across all connectors.
  expect(toolEndEvent.outputSize).toBe(toolCall.output!.length);
});

test("rounds fractional timings and clamps via Math.round", () => {
  const { toolCall } = recordToolSpan({
    id: "call_4",
    name: "Bash",
    input: undefined,
    rawResult: undefined,
    startMs: 100.6,
    endMs: 150.2,
    wallStart: 50.1,
  });
  expect(toolCall.durationMs).toBe(Math.round(150.2 - 100.6));
  expect(toolCall.startOffsetMs).toBe(Math.round(100.6 - 50.1));
  // A null/undefined tool result yields no output and no outputSize.
  expect(toolCall.output).toBeUndefined();
});

test("error payloads are serialized into the output snapshot", () => {
  const { toolCall } = recordToolSpan({
    id: "call_5",
    name: "mcp__gmail__search_emails",
    input: undefined,
    rawResult: { error: "tool execution failed" },
    startMs: 0,
    endMs: 1,
    wallStart: 0,
  });
  expect(toolCall.output).toContain("tool execution failed");
});
