import { test, expect } from "bun:test";
import { parseYggdrasilTracePointer } from "./yggdrasil-trace-pointer.ts";

// ── parseYggdrasilTracePointer ───────────────────────────────

test("returns input unchanged when no pointer present", () => {
  const text = "## Result 1\nfoo\n\n## Result 2\nbar";
  const { text: out, fetchUrl } = parseYggdrasilTracePointer(text, ["http://x:1"]);
  expect(out).toBe(text);
  expect(fetchUrl).toBeNull();
});

test("returns input unchanged on empty string", () => {
  const { text, fetchUrl } = parseYggdrasilTracePointer("");
  expect(text).toBe("");
  expect(fetchUrl).toBeNull();
});

test("parses url pointer with allowed origin", () => {
  const input =
    "results\n\nyggdrasil-trace-url: http://127.0.0.1:9130/api/trace/deadbeef00112233";
  const { text, fetchUrl } = parseYggdrasilTracePointer(input, [
    "http://127.0.0.1:9130",
  ]);
  expect(text).toBe("results");
  expect(fetchUrl).toBe("http://127.0.0.1:9130/api/trace/deadbeef00112233");
});

test("parses url pointer with trailing newline", () => {
  const input =
    "results\n\nyggdrasil-trace-url: http://127.0.0.1:9130/api/trace/0123456789abcdef\n";
  const { text, fetchUrl } = parseYggdrasilTracePointer(input, [
    "http://127.0.0.1:9130",
  ]);
  expect(text).toBe("results");
  expect(fetchUrl).toBe("http://127.0.0.1:9130/api/trace/0123456789abcdef");
});

test("strips trailing whitespace before pointer", () => {
  const input =
    "results\n   \n\n\nyggdrasil-trace-url: http://127.0.0.1:9130/api/trace/a3f8b21c4e9d0a55\n";
  const { text } = parseYggdrasilTracePointer(input, ["http://127.0.0.1:9130"]);
  expect(text).toBe("results");
});

test("ignores literal 'yggdrasil-trace-url:' inside text body", () => {
  const input =
    "## Doc\nThe pointer line looks like: `yggdrasil-trace-url: http://x.y/api/trace/abc`\n\n## Other";
  const { text, fetchUrl } = parseYggdrasilTracePointer(input, ["http://x.y"]);
  expect(text).toBe(input);
  expect(fetchUrl).toBeNull();
});

test("unwraps {\"result\":\"<inner>\"} envelope and finds inner pointer", () => {
  const inner =
    "## Symbol A\nfoo\n\nyggdrasil-trace-url: http://127.0.0.1:9130/api/trace/cafef00ddeadbeef\n";
  const wrapped = JSON.stringify({ result: inner });
  const { text, fetchUrl } = parseYggdrasilTracePointer(wrapped, [
    "http://127.0.0.1:9130",
  ]);
  expect(fetchUrl).toBe("http://127.0.0.1:9130/api/trace/cafef00ddeadbeef");
  expect(text).toBe("## Symbol A\nfoo");
  expect(text).not.toContain("yggdrasil-trace-url");
  expect(text).not.toContain("\"result\"");
});

// ── host allow-list ──────────────────────────────────────────

test("URL pointer with disallowed origin is dropped (line stripped, no fetch)", () => {
  const input =
    "results\n\nyggdrasil-trace-url: https://evil.example/api/trace/cafef00ddeadbeef";
  const { text, fetchUrl } = parseYggdrasilTracePointer(input, [
    "http://127.0.0.1:9130",
  ]);
  expect(fetchUrl).toBeNull();
  expect(text).toBe("results");
  expect(text).not.toContain("yggdrasil-trace-url");
});

test("empty allow-list rejects every URL pointer", () => {
  const input =
    "results\n\nyggdrasil-trace-url: http://127.0.0.1:9130/api/trace/cafef00ddeadbeef";
  const { text, fetchUrl } = parseYggdrasilTracePointer(input, []);
  expect(fetchUrl).toBeNull();
  expect(text).toBe("results");
});

test("wrapped envelope with disallowed origin is also rejected", () => {
  const inner =
    "results\n\nyggdrasil-trace-url: https://evil.example/api/trace/cafef00ddeadbeef\n";
  const wrapped = JSON.stringify({ result: inner });
  const { text, fetchUrl } = parseYggdrasilTracePointer(wrapped, [
    "http://127.0.0.1:9130",
  ]);
  expect(fetchUrl).toBeNull();
  // Pointer line is stripped from the inner text even though origin was rejected.
  expect(text).toBe("results");
  expect(text).not.toContain("yggdrasil-trace-url");
});

test("default allow-list reads YGGDRASIL_MCP_URL from config", () => {
  const prev = process.env.YGGDRASIL_MCP_URL;
  process.env.YGGDRASIL_MCP_URL = "http://config-host.local:7777";
  try {
    const input =
      "results\n\nyggdrasil-trace-url: http://config-host.local:7777/api/trace/aaaabbbbccccdddd";
    const { fetchUrl } = parseYggdrasilTracePointer(input);
    expect(fetchUrl).toBe(
      "http://config-host.local:7777/api/trace/aaaabbbbccccdddd",
    );
  } finally {
    if (prev === undefined) delete process.env.YGGDRASIL_MCP_URL;
    else process.env.YGGDRASIL_MCP_URL = prev;
  }
});

// ── regex shape ──────────────────────────────────────────────

test("non-/api/trace/ path does not match", () => {
  const input =
    "results\n\nyggdrasil-trace-url: http://127.0.0.1:9130/cafef00ddeadbeef";
  const { fetchUrl, text } = parseYggdrasilTracePointer(input, [
    "http://127.0.0.1:9130",
  ]);
  expect(fetchUrl).toBeNull();
  expect(text).toBe(input);
});

test("non-16-hex id does not match", () => {
  const tooShort =
    "results\n\nyggdrasil-trace-url: http://127.0.0.1:9130/api/trace/deadbeef";
  expect(
    parseYggdrasilTracePointer(tooShort, ["http://127.0.0.1:9130"]).fetchUrl,
  ).toBeNull();

  const nonHex =
    "results\n\nyggdrasil-trace-url: http://127.0.0.1:9130/api/trace/g3f8b21c4e9d0a55";
  expect(
    parseYggdrasilTracePointer(nonHex, ["http://127.0.0.1:9130"]).fetchUrl,
  ).toBeNull();

  const tooLong =
    "results\n\nyggdrasil-trace-url: http://127.0.0.1:9130/api/trace/cafef00ddeadbeef00";
  expect(
    parseYggdrasilTracePointer(tooLong, ["http://127.0.0.1:9130"]).fetchUrl,
  ).toBeNull();
});

test("extra path segments after id do not match", () => {
  const input =
    "results\n\nyggdrasil-trace-url: http://127.0.0.1:9130/api/trace/cafef00ddeadbeef/extra";
  const { fetchUrl } = parseYggdrasilTracePointer(input, [
    "http://127.0.0.1:9130",
  ]);
  expect(fetchUrl).toBeNull();
});

test("does not match huginn-trace-url marker", () => {
  const input =
    "results\n\nhuginn-trace-url: http://127.0.0.1:9130/api/trace/cafef00ddeadbeef";
  const { fetchUrl, text } = parseYggdrasilTracePointer(input, [
    "http://127.0.0.1:9130",
  ]);
  expect(fetchUrl).toBeNull();
  expect(text).toBe(input);
});
