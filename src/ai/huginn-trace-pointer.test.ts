import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  parseHuginnTracePointer,
  fetchHuginnTrace,
} from "./huginn-trace-pointer.ts";

// ── parseHuginnTracePointer ──────────────────────────────────

test("returns input unchanged when no pointer present", () => {
  const text = "## Result 1\nfoo\n\n## Result 2\nbar";
  const { text: out, fetchUrl } = parseHuginnTracePointer(text, "http://x:1");
  expect(out).toBe(text);
  expect(fetchUrl).toBeNull();
});

test("returns input unchanged on empty string", () => {
  const { text, fetchUrl } = parseHuginnTracePointer("");
  expect(text).toBe("");
  expect(fetchUrl).toBeNull();
});

test("parses bare id pointer with default base URL", () => {
  const input = "search results here\n\nhuginn-trace-id: a3f8b21c4e9d0a55";
  const { text, fetchUrl } = parseHuginnTracePointer(input, "http://localhost:8321");
  expect(text).toBe("search results here");
  expect(fetchUrl).toBe("http://localhost:8321/api/trace/a3f8b21c4e9d0a55");
});

test("parses bare id pointer with trailing newline", () => {
  const input = "results\n\nhuginn-trace-id: 0123456789abcdef\n";
  const { text, fetchUrl } = parseHuginnTracePointer(input, "http://h:1");
  expect(text).toBe("results");
  expect(fetchUrl).toBe("http://h:1/api/trace/0123456789abcdef");
});

test("parses url pointer (preferred form — no base URL needed)", () => {
  const input = "results\n\nhuginn-trace-url: http://localhost:8321/api/trace/deadbeef00112233";
  const { text, fetchUrl } = parseHuginnTracePointer(input);
  expect(text).toBe("results");
  expect(fetchUrl).toBe("http://localhost:8321/api/trace/deadbeef00112233");
});

test("strips trailing whitespace before pointer", () => {
  const input = "results\n   \n\n\nhuginn-trace-id: a3f8b21c4e9d0a55\n";
  const { text } = parseHuginnTracePointer(input, "http://h:1");
  expect(text).toBe("results");
});

test("ignores literal 'huginn-trace-id:' inside text body", () => {
  // A search hit might quote the wire format. Anchor must be end-of-string.
  const input =
    "## Doc about tracing\nThe pointer line looks like: `huginn-trace-id: abc123`\n\n## Other result";
  const { text, fetchUrl } = parseHuginnTracePointer(input, "http://h:1");
  expect(text).toBe(input);
  expect(fetchUrl).toBeNull();
});

test("rejects malformed id (wrong length / non-hex)", () => {
  const tooShort = "results\n\nhuginn-trace-id: deadbeef";
  expect(parseHuginnTracePointer(tooShort, "http://h:1").fetchUrl).toBeNull();

  const nonHex = "results\n\nhuginn-trace-id: g3f8b21c4e9d0a55";
  expect(parseHuginnTracePointer(nonHex, "http://h:1").fetchUrl).toBeNull();
});

test("returns text without pointer when id present but no base URL", () => {
  const input = "results\n\nhuginn-trace-id: a3f8b21c4e9d0a55";
  const { text, fetchUrl } = parseHuginnTracePointer(input);
  // Pointer line is still stripped (so the model wouldn't see it even on
  // misconfig), but we have nowhere to fetch from.
  expect(text).toBe("results");
  expect(fetchUrl).toBeNull();
});

test("unwraps {\"result\":\"<inner>\"} envelope and finds inner pointer", () => {
  // Recent Claude CLI versions hand the orchestrator a JSON-wrapped form for
  // some MCP tool results. The pointer lives inside the result string,
  // not at the end of the wrapper. Without unwrapping, the regex anchors on
  // `"}` and misses.
  const inner =
    "## Result A\nfoo\n\n## Result B\nbar\n\nhuginn-trace-url: http://localhost:8321/api/trace/cafef00ddeadbeef\n";
  const wrapped = JSON.stringify({ result: inner });
  const { text, fetchUrl } = parseHuginnTracePointer(wrapped);
  expect(fetchUrl).toBe("http://localhost:8321/api/trace/cafef00ddeadbeef");
  // Inner text returned (envelope discarded — model sees just the results).
  expect(text).toBe("## Result A\nfoo\n\n## Result B\nbar");
  expect(text).not.toContain("huginn-trace-url");
  expect(text).not.toContain("\"result\"");
});

test("ignores envelope-shaped strings that don't actually parse as JSON", () => {
  const fake = "{not valid json with huginn-trace-url: http://x.y/api/trace/cafef00ddeadbeef}";
  const { fetchUrl } = parseHuginnTracePointer(fake);
  expect(fetchUrl).toBeNull();
});

// ── host allow-list (security: don't fetch arbitrary URLs from search hits) ──

test("URL pointer with allowed origin is fetched", () => {
  const input = "results\n\nhuginn-trace-url: http://huginn.local:8321/api/trace/cafef00ddeadbeef";
  const { text, fetchUrl } = parseHuginnTracePointer(input, undefined, [
    "http://huginn.local:8321",
  ]);
  expect(fetchUrl).toBe("http://huginn.local:8321/api/trace/cafef00ddeadbeef");
  expect(text).toBe("results");
});

test("URL pointer with disallowed origin is dropped (line stripped, no fetch)", () => {
  const input = "results\n\nhuginn-trace-url: https://evil.example/api/trace/cafef00ddeadbeef";
  const { text, fetchUrl } = parseHuginnTracePointer(input, undefined, [
    "http://localhost:8321",
  ]);
  expect(fetchUrl).toBeNull();
  // Pointer line is still stripped — model must never see it even on misconfig.
  expect(text).toBe("results");
  expect(text).not.toContain("huginn-trace-url");
});

test("multi-host allow-list permits any matching origin", () => {
  const allowed = ["http://h1:1", "http://h2:2", "http://h3:3"];

  const hit = parseHuginnTracePointer(
    "results\n\nhuginn-trace-url: http://h2:2/api/trace/cafef00ddeadbeef",
    undefined,
    allowed,
  );
  expect(hit.fetchUrl).toBe("http://h2:2/api/trace/cafef00ddeadbeef");

  const miss = parseHuginnTracePointer(
    "results\n\nhuginn-trace-url: http://h4:4/api/trace/cafef00ddeadbeef",
    undefined,
    allowed,
  );
  expect(miss.fetchUrl).toBeNull();
  expect(miss.text).toBe("results");
});

test("empty allow-list rejects every URL pointer", () => {
  const input = "results\n\nhuginn-trace-url: http://localhost:8321/api/trace/cafef00ddeadbeef";
  const { text, fetchUrl } = parseHuginnTracePointer(input, undefined, []);
  expect(fetchUrl).toBeNull();
  expect(text).toBe("results");
});

// ── regex shape (URL must look like /api/trace/<16hex>) ──

test("URL pointing to non-/api/trace/ path does not match", () => {
  const input = "results\n\nhuginn-trace-url: http://localhost:8321/cafef00ddeadbeef";
  const { fetchUrl, text } = parseHuginnTracePointer(input);
  expect(fetchUrl).toBeNull();
  // Regex didn't match → original text returned unchanged.
  expect(text).toBe(input);
});

test("URL with non-16-hex id at end does not match", () => {
  const tooShort = "results\n\nhuginn-trace-url: http://localhost:8321/api/trace/deadbeef";
  expect(parseHuginnTracePointer(tooShort).fetchUrl).toBeNull();

  const nonHex = "results\n\nhuginn-trace-url: http://localhost:8321/api/trace/g3f8b21c4e9d0a55";
  expect(parseHuginnTracePointer(nonHex).fetchUrl).toBeNull();

  const tooLong = "results\n\nhuginn-trace-url: http://localhost:8321/api/trace/cafef00ddeadbeef00";
  expect(parseHuginnTracePointer(tooLong).fetchUrl).toBeNull();
});

test("URL with extra path segments after the id does not match", () => {
  const input =
    "results\n\nhuginn-trace-url: http://localhost:8321/api/trace/cafef00ddeadbeef/extra";
  const { fetchUrl } = parseHuginnTracePointer(input);
  expect(fetchUrl).toBeNull();
});

// ── fetchHuginnTrace ─────────────────────────────────────────

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("fetches and returns parsed trace on 200", async () => {
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify({ schemaVersion: 1, totalMs: 71 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
  const trace = await fetchHuginnTrace("http://x:1/api/trace/abc");
  expect(trace).toEqual({ schemaVersion: 1, totalMs: 71 });
});

test("returns null on 404 (expired / unknown)", async () => {
  globalThis.fetch = mock(async () =>
    new Response("not found", { status: 404 }),
  ) as unknown as typeof fetch;
  expect(await fetchHuginnTrace("http://x:1/api/trace/abc")).toBeNull();
});

test("returns null on 5xx (server error)", async () => {
  globalThis.fetch = mock(async () =>
    new Response("internal error", { status: 500 }),
  ) as unknown as typeof fetch;
  expect(await fetchHuginnTrace("http://x:1/api/trace/abc")).toBeNull();
});

test("returns null on network error", async () => {
  globalThis.fetch = mock(async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  expect(await fetchHuginnTrace("http://x:1/api/trace/abc")).toBeNull();
});

test("returns null on timeout", async () => {
  globalThis.fetch = mock(
    (_url: string, init: RequestInit | undefined) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
        // never resolves otherwise
      }),
  ) as unknown as typeof fetch;
  const trace = await fetchHuginnTrace("http://x:1/api/trace/abc", 50);
  expect(trace).toBeNull();
});
