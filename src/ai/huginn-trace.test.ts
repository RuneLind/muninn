import { test, expect, describe } from "bun:test";
import { parseHuginnTrace, extractMcpResultText } from "./huginn-trace.ts";

describe("parseHuginnTrace — text-mode", () => {
  test("extracts trailing ```huginn-trace fence", () => {
    const trace = { query: { raw: "hello" }, schemaVersion: 1, totalMs: 71 };
    const input = `Some search results here.\n\n\`\`\`huginn-trace\n${JSON.stringify(trace)}\n\`\`\``;

    const { text, trace: extracted } = parseHuginnTrace(input);

    expect(extracted).toEqual(trace);
    expect(text).toBe("Some search results here.");
  });

  test("handles trailing whitespace after the fence", () => {
    const trace = { schemaVersion: 1 };
    const input = `Result.\n\n\`\`\`huginn-trace\n${JSON.stringify(trace)}\n\`\`\`\n\n  `;

    const { text, trace: extracted } = parseHuginnTrace(input);

    expect(extracted).toEqual(trace);
    expect(text).toBe("Result.");
  });

  test("handles multiline JSON inside the fence", () => {
    const trace = { collections: [{ name: "wiki", candidates: [] }], schemaVersion: 1 };
    const pretty = JSON.stringify(trace, null, 2);
    const input = `Output.\n\n\`\`\`huginn-trace\n${pretty}\n\`\`\``;

    const { text, trace: extracted } = parseHuginnTrace(input);

    expect(extracted).toEqual(trace);
    expect(text).toBe("Output.");
  });

  test("returns input untouched when no fence present", () => {
    const input = "Plain tool result with no trace.";
    const { text, trace } = parseHuginnTrace(input);
    expect(text).toBe(input);
    expect(trace).toBeNull();
  });

  test("returns input untouched on malformed JSON inside fence", () => {
    const input = "Result.\n\n```huginn-trace\n{not: valid json}\n```";
    const { text, trace } = parseHuginnTrace(input);
    expect(text).toBe(input);
    expect(trace).toBeNull();
  });

  test("only matches the trailing fence — earlier fences are ignored", () => {
    const trace = { schemaVersion: 1 };
    const input =
      "An earlier ```code``` block.\n" +
      "Some text.\n\n" +
      "```huginn-trace\n" + JSON.stringify(trace) + "\n```";

    const { text, trace: extracted } = parseHuginnTrace(input);

    expect(extracted).toEqual(trace);
    expect(text).toContain("An earlier ```code``` block.");
  });
});

describe("parseHuginnTrace — JSON-mode", () => {
  test("peels off top-level `trace` key", () => {
    const trace = { schemaVersion: 1, totalMs: 42 };
    const payload = { results: [{ id: "1", title: "Doc" }], trace };
    const input = JSON.stringify(payload);

    const { text, trace: extracted } = parseHuginnTrace(input);

    expect(extracted).toEqual(trace);
    expect(JSON.parse(text)).toEqual({ results: payload.results });
  });

  test("returns input untouched when JSON has no `trace` key", () => {
    const input = JSON.stringify({ results: [], totalMs: 10 });
    const { text, trace } = parseHuginnTrace(input);
    expect(text).toBe(input);
    expect(trace).toBeNull();
  });

  test("returns input untouched on malformed JSON", () => {
    const input = '{"results": [malformed';
    const { text, trace } = parseHuginnTrace(input);
    expect(text).toBe(input);
    expect(trace).toBeNull();
  });

  test("ignores arrays at the top level", () => {
    const input = JSON.stringify([{ trace: { x: 1 } }]);
    const { text, trace } = parseHuginnTrace(input);
    expect(text).toBe(input);
    expect(trace).toBeNull();
  });
});

describe("extractMcpResultText", () => {
  test("returns plain string as-is", () => {
    expect(extractMcpResultText("hello")).toBe("hello");
  });

  test("extracts from { content: string }", () => {
    expect(extractMcpResultText({ content: "hello" })).toBe("hello");
  });

  test("extracts from { content: [{type:'text', text:...}, ...] } MCP standard", () => {
    expect(extractMcpResultText({
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    })).toBe("first\nsecond");
  });

  test("un-nests double-encoded { content: '{\"result\":\"...\"}' } (Huginn HTTP wrapper)", () => {
    const inner = { result: "the actual text" };
    const sdkResult = { content: JSON.stringify(inner) };
    expect(extractMcpResultText(sdkResult)).toBe("the actual text");
  });

  test("supports the full copilot-sdk → Huginn shape with a fence inside", () => {
    const trace = { schemaVersion: 1, totalMs: 71 };
    const innerText = "Some result\n\n```huginn-trace\n" + JSON.stringify(trace) + "\n```";
    const sdkResult = { content: JSON.stringify({ result: innerText }) };

    const text = extractMcpResultText(sdkResult);
    expect(text).toBe(innerText);

    // And verify the parser then succeeds on it
    const { trace: extracted, text: cleaned } = parseHuginnTrace(text!);
    expect(extracted).toEqual(trace);
    expect(cleaned).toBe("Some result");
  });

  test("falls back to { result: string } and { text: string }", () => {
    expect(extractMcpResultText({ result: "r" })).toBe("r");
    expect(extractMcpResultText({ text: "t" })).toBe("t");
  });

  test("returns null for unrecognized shapes", () => {
    expect(extractMcpResultText({ random: 1 })).toBeNull();
    expect(extractMcpResultText(null)).toBeNull();
    expect(extractMcpResultText(123)).toBeNull();
  });

  test("extract+parse pipeline yields readable text for non-Huginn copilot-sdk results", () => {
    // Repros the "Output too large" trace shape: SDK envelope wraps a plain
    // string tool result, no trace fence. Storing the structured payload would
    // double-encode to {"content":"Output too large..."} — the pipeline should
    // produce just "Output too large..." instead.
    const sdkResult = { content: "Output too large to read at once (159.3 KB). Saved to: /tmp/abc" };
    const text = extractMcpResultText(sdkResult);
    expect(text).toBe("Output too large to read at once (159.3 KB). Saved to: /tmp/abc");
    const { text: cleaned, trace } = parseHuginnTrace(text!);
    expect(trace).toBeNull();
    expect(cleaned).toBe("Output too large to read at once (159.3 KB). Saved to: /tmp/abc");
  });
});

describe("parseHuginnTrace — defensive", () => {
  test("handles empty string", () => {
    const { text, trace } = parseHuginnTrace("");
    expect(text).toBe("");
    expect(trace).toBeNull();
  });

  test("handles non-string input gracefully", () => {
    const { text, trace } = parseHuginnTrace(undefined as unknown as string);
    expect(text).toBeUndefined();
    expect(trace).toBeNull();
  });
});
