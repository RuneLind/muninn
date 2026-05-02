import { test, expect, mock, afterEach } from "bun:test";
import {
  parseYggdrasilTracePointer,
  fetchYggdrasilTrace,
} from "./yggdrasil-trace-pointer.ts";

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
  // Disjoint producers: yggdrasil parser must not accidentally pick up huginn's.
  const input =
    "results\n\nhuginn-trace-url: http://127.0.0.1:9130/api/trace/cafef00ddeadbeef";
  const { fetchUrl, text } = parseYggdrasilTracePointer(input, [
    "http://127.0.0.1:9130",
  ]);
  expect(fetchUrl).toBeNull();
  expect(text).toBe(input);
});

// ── fetchYggdrasilTrace ──────────────────────────────────────

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("fetches and returns parsed trace on 200", async () => {
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify({ schemaVersion: 1, tool: "search" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
  const trace = await fetchYggdrasilTrace("http://x:1/api/trace/abc");
  expect(trace).toEqual({ schemaVersion: 1, tool: "search" });
});

test("returns null on 404 (expired / unknown)", async () => {
  globalThis.fetch = mock(async () =>
    new Response("not found", { status: 404 }),
  ) as unknown as typeof fetch;
  expect(await fetchYggdrasilTrace("http://x:1/api/trace/abc")).toBeNull();
});

test("returns null on network error", async () => {
  globalThis.fetch = mock(async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  expect(await fetchYggdrasilTrace("http://x:1/api/trace/abc")).toBeNull();
});

test("returns null on timeout", async () => {
  globalThis.fetch = mock(
    (_url: string, init: RequestInit | undefined) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
  ) as unknown as typeof fetch;
  const trace = await fetchYggdrasilTrace("http://x:1/api/trace/abc", 50);
  expect(trace).toBeNull();
});
