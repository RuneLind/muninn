import { test, expect, describe } from "bun:test";
import { parseHuginnTrace, extractMcpResultText, recoverOversizedClaudeCliToolResult } from "./huginn-trace.ts";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

  test("prefers contents[] when content is the SDK oversized-tool placeholder", () => {
    // Captured 2026-04-30 from a live melosys + jira-issues knowledge_search.
    // copilot-sdk's `tool.execution_complete` event for an oversized result
    // carries three keys:
    //   content         → short placeholder string (~857 B)
    //   detailedContent → TRUNCATED JSON envelope (~10 KB) — never use
    //   contents        → MCP-standard `[{type:"text", text:"<full>"}]` (~37 KB)
    //
    // The Huginn trace fence lives only in the full payload, so we must read
    // `contents[0].text` rather than the placeholder.
    const trace = { schemaVersion: 1, totalMs: 71 };
    const innerText = "Some long result\n\n```huginn-trace\n" + JSON.stringify(trace) + "\n```";
    const fullPayload = JSON.stringify({ result: innerText });
    const sdkResult = {
      content:
        "Output too large to read at once (37.1 KB). Saved to: /var/folders/.../tmp.txt\n" +
        "Consider using tools like grep (for searching), head/tail (for first/last lines)…",
      detailedContent: '{"result":"Some long result',
      contents: [{ type: "text", text: fullPayload }],
    };

    const text = extractMcpResultText(sdkResult);
    expect(text).toBe(innerText);

    const { trace: extracted, text: cleaned } = parseHuginnTrace(text!);
    expect(extracted).toEqual(trace);
    expect(cleaned).toBe("Some long result");
  });

  test("falls back to the placeholder string when contents[] is missing", () => {
    // Defensive: if a future SDK or non-Huginn adapter emits the placeholder
    // without an accompanying contents[], we still return the placeholder
    // string instead of null. Same downstream behavior as a normal text
    // envelope — the trace gets the placeholder, no searchTrace is parsed.
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

  test("matches a fence at the very end of a >4 KB output", () => {
    const trace = { schemaVersion: 1, totalMs: 5 };
    const filler = "x".repeat(8000);
    const input = filler + "\n\n```huginn-trace\n" + JSON.stringify(trace) + "\n```";
    const { text, trace: extracted } = parseHuginnTrace(input);
    expect(extracted).toEqual(trace);
    expect(text).toBe(filler);
  });

  test("extracts a trace whose JSON body itself exceeds 4 KB", () => {
    // Real melosys queries produce ~14 KB trace bodies (one candidate object
    // per chunk in fetch-K, often 33+ candidates with full stage scoring).
    const candidates = Array.from({ length: 50 }, (_, i) => ({
      chunkId: i,
      stages: { faiss: { rank: i, score: -(i + 1) / 10 }, bm25: { rank: i, score: -(i + 1) / 5 } },
      kept: true,
    }));
    const trace = { collections: [{ name: "wiki", candidates }], schemaVersion: 1 };
    const traceJson = JSON.stringify(trace);
    expect(traceJson.length).toBeGreaterThan(4096);
    const input = "Result.\n\n```huginn-trace\n" + traceJson + "\n```";

    const { text, trace: extracted } = parseHuginnTrace(input);
    expect(extracted).toEqual(trace);
    expect(text).toBe("Result.");
  });
});

describe("recoverOversizedClaudeCliToolResult", () => {
  function makePlaceholder(filePath: string, chars = 198_415): string {
    return `Error: result (${chars.toLocaleString("en-US")} characters) exceeds maximum allowed tokens. Output has been saved to ${filePath}.\nFormat: JSON with schema: {result: string}`;
  }

  test("returns null when input is not the divert placeholder", () => {
    expect(recoverOversizedClaudeCliToolResult("hello world")).toBeNull();
    expect(recoverOversizedClaudeCliToolResult("Error: something else")).toBeNull();
  });

  test("recovers trace and rewrites file fence-free by default", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-divert-"));
    const filePath = join(dir, "result.txt");
    const trace = { query: { raw: "hello" }, schemaVersion: 1 };
    const body = "## Search results\n\nlots of content here";
    const original = body + "\n\n```huginn-trace\n" + JSON.stringify(trace) + "\n```";
    writeFileSync(filePath, JSON.stringify({ result: original }), "utf8");

    try {
      const recovered = recoverOversizedClaudeCliToolResult(makePlaceholder(filePath));
      expect(recovered).not.toBeNull();
      expect(recovered!.filePath).toBe(filePath);
      expect(recovered!.trace).toEqual(trace);
      expect(recovered!.rewritten).toBe(true);
      // File now holds the cleaned text — no fence
      const after = JSON.parse(readFileSync(filePath, "utf8")) as { result: string };
      expect(after.result).toBe(body);
      expect(after.result).not.toContain("huginn-trace");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("does not rewrite when stripTraceFromFile is false", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-divert-"));
    const filePath = join(dir, "result.txt");
    const trace = { schemaVersion: 1 };
    const original = "body\n\n```huginn-trace\n" + JSON.stringify(trace) + "\n```";
    const fileContent = JSON.stringify({ result: original });
    writeFileSync(filePath, fileContent, "utf8");

    try {
      const recovered = recoverOversizedClaudeCliToolResult(
        makePlaceholder(filePath),
        { stripTraceFromFile: false },
      );
      expect(recovered!.trace).toEqual(trace);
      expect(recovered!.rewritten).toBe(false);
      // File untouched
      expect(readFileSync(filePath, "utf8")).toBe(fileContent);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("returns trace=null when file has no fence (and does not rewrite)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-divert-"));
    const filePath = join(dir, "result.txt");
    const fileContent = JSON.stringify({ result: "no fence in here" });
    writeFileSync(filePath, fileContent, "utf8");

    try {
      const recovered = recoverOversizedClaudeCliToolResult(makePlaceholder(filePath));
      expect(recovered!.trace).toBeNull();
      expect(recovered!.rewritten).toBe(false);
      expect(readFileSync(filePath, "utf8")).toBe(fileContent);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("degrades gracefully when file is missing", () => {
    const recovered = recoverOversizedClaudeCliToolResult(
      makePlaceholder("/nonexistent/path/to/result.txt"),
    );
    expect(recovered).not.toBeNull();
    expect(recovered!.trace).toBeNull();
    expect(recovered!.rewritten).toBe(false);
  });

  test("degrades gracefully when file is not the expected JSON shape", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-divert-"));
    const filePath = join(dir, "result.txt");
    writeFileSync(filePath, "not json at all", "utf8");

    try {
      const recovered = recoverOversizedClaudeCliToolResult(makePlaceholder(filePath));
      expect(recovered!.trace).toBeNull();
      expect(recovered!.rewritten).toBe(false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("recovers Phase 2 pointer URL from diverted file and strips it", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-divert-"));
    const filePath = join(dir, "result.txt");
    const body = "## Search results\n\nrelevant content here";
    const url = "http://localhost:8321/api/trace/86251f3c5c58db3a";
    const original = body + "\n\nhuginn-trace-url: " + url + "\n";
    writeFileSync(filePath, JSON.stringify({ result: original }), "utf8");

    try {
      const recovered = recoverOversizedClaudeCliToolResult(makePlaceholder(filePath));
      expect(recovered).not.toBeNull();
      expect(recovered!.trace).toBeNull();
      expect(recovered!.tracePointer).toBe(url);
      expect(recovered!.rewritten).toBe(true);
      // File now holds cleaned text — no pointer
      const after = JSON.parse(readFileSync(filePath, "utf8")) as { result: string };
      expect(after.result).toBe(body);
      expect(after.result).not.toContain("huginn-trace-url");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("pointer recovery does not rewrite when stripTraceFromFile is false", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-divert-"));
    const filePath = join(dir, "result.txt");
    const url = "http://localhost:8321/api/trace/0123456789abcdef";
    const original = "body\n\nhuginn-trace-url: " + url + "\n";
    const fileContent = JSON.stringify({ result: original });
    writeFileSync(filePath, fileContent, "utf8");

    try {
      const recovered = recoverOversizedClaudeCliToolResult(
        makePlaceholder(filePath),
        { stripTraceFromFile: false },
      );
      expect(recovered!.tracePointer).toBe(url);
      expect(recovered!.rewritten).toBe(false);
      expect(readFileSync(filePath, "utf8")).toBe(fileContent);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
