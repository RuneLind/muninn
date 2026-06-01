/**
 * Contract test: Huginn Phase 2 trace-id pointer pipeline.
 *
 * Run AFTER Huginn API server has been restarted with HUGINN_TRACE_POINTER=1.
 * Verifies the wire contract end-to-end before flipping any production bot.
 *
 * Tests:
 *   1. POST /api/search?...&trace=true → response has `traceId: "<16hex>"`,
 *      not `trace: {...}`
 *   2. GET /api/trace/<traceId from #1> → 200, schema matches the inline-fence
 *      payload (schemaVersion, query, collections, totalMs)
 *   3. GET /api/trace/0000000000000000 → 404 with Huginn's specific detail
 *      string ("trace not found or expired")
 *   4. End-to-end via MCP adapter: spawn knowledge_api_mcp_adapter.py with
 *      HUGINN_TRACE_POINTER=1, call search_knowledge over stdio MCP, verify
 *      the tool result ends with the pointer line (not a fence)
 *
 * Usage:
 *   bun run scripts/probe-huginn-trace-pointer.ts
 *   bun run scripts/probe-huginn-trace-pointer.ts --api http://localhost:8321
 */
import { connectToServer, callTool, disconnectAll } from "../src/ai/mcp-tool-caller.ts";
import { parseHuginnTracePointer } from "../src/ai/huginn-trace-pointer.ts";
import { extractMcpResultText } from "../src/ai/huginn-trace.ts";

const API_URL = process.argv.includes("--api")
  ? process.argv[process.argv.indexOf("--api") + 1]!
  : "http://localhost:8321";
const HUGINN_DIR = "/Users/rune/source/private/huginn";
const QUERY = "SED structured electronic document";

let pass = 0;
let fail = 0;

function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    pass++;
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

// ── Test 1: API returns traceId, not trace ────────────────────
console.log(`\n[1] POST ${API_URL}/api/search?q=...&trace=true`);
let traceId: string | null = null;
try {
  const url = new URL(`${API_URL}/api/search`);
  url.searchParams.set("q", QUERY);
  url.searchParams.set("limit", "3");
  url.searchParams.set("trace", "true");
  const resp = await fetch(url);
  check("status 200", resp.ok, `got ${resp.status}`);
  const body = await resp.json() as { trace?: unknown; traceId?: string; results?: unknown[] };
  check("response has results", Array.isArray(body.results), "no results field");
  check("response has traceId (not trace)", typeof body.traceId === "string", "got `trace` instead — server probably not in pointer mode");
  check("traceId is 16-hex", typeof body.traceId === "string" && /^[0-9a-f]{16}$/.test(body.traceId), `got ${body.traceId}`);
  check("response does NOT have inline trace", body.trace === undefined, "both `trace` and `traceId` present");
  if (typeof body.traceId === "string") traceId = body.traceId;
} catch (e) {
  check("API reachable", false, e instanceof Error ? e.message : String(e));
}

// ── Test 2: GET /api/trace/<id> returns the trace ─────────────
console.log(`\n[2] GET ${API_URL}/api/trace/<id>`);
if (traceId) {
  try {
    const resp = await fetch(`${API_URL}/api/trace/${traceId}`);
    check("status 200", resp.ok, `got ${resp.status}`);
    const trace = await resp.json() as Record<string, unknown>;
    check("has schemaVersion=1", trace.schemaVersion === 1, `got ${trace.schemaVersion}`);
    check("has query object", typeof trace.query === "object" && trace.query !== null);
    check("has collections array", Array.isArray(trace.collections));
    check("has totalMs", typeof trace.totalMs === "number");
  } catch (e) {
    check("trace endpoint reachable", false, e instanceof Error ? e.message : String(e));
  }
} else {
  console.log("  (skipped — no traceId from test 1)");
}

// ── Test 3: GET /api/trace/<bad id> → 404 ─────────────────────
console.log(`\n[3] GET ${API_URL}/api/trace/0000000000000000 (expired/unknown)`);
try {
  const resp = await fetch(`${API_URL}/api/trace/0000000000000000`);
  check("status 404", resp.status === 404, `got ${resp.status}`);
  const body = await resp.json() as { detail?: string };
  check("detail mentions 'trace'", typeof body.detail === "string" && /trace/i.test(body.detail), `got ${JSON.stringify(body.detail)}`);
} catch (e) {
  check("404 endpoint reachable", false, e instanceof Error ? e.message : String(e));
}

// ── Test 4: End-to-end via MCP adapter ────────────────────────
console.log(`\n[4] MCP adapter spawn → search_knowledge → pointer in tool result`);
const BOT = "__pointer-probe";
try {
  await connectToServer(BOT, "knowledge", {
    type: "stdio",
    command: "uv",
    args: ["--directory", HUGINN_DIR, "run", "knowledge_api_mcp_adapter.py"],
    env: {
      KNOWLEDGE_API_URL: API_URL,
      HUGINN_TRACE_POINTER: "1",
    },
  });
  const result = await callTool(BOT, "knowledge", "search_knowledge", {
    query: QUERY,
    limit: 3,
  });
  const text = extractMcpResultText(result);
  check("tool result extractable as text", typeof text === "string");
  if (typeof text === "string") {
    const pointer = parseHuginnTracePointer(text);
    check("pointer parsed from tool result", pointer.fetchUrl !== null,
      `tail of result: ...${text.slice(-200)}`);
    check("text body does NOT contain ```huginn-trace fence",
      !text.includes("```huginn-trace"),
      "fence still emitted alongside pointer — server in dual mode?");
    if (pointer.fetchUrl) {
      console.log(`    fetched URL: ${pointer.fetchUrl}`);
      // Roundtrip: fetch via the URL the adapter handed us
      const trace = await fetch(pointer.fetchUrl).then((r) => r.ok ? r.json() : null);
      check("roundtrip fetch succeeds", trace !== null);
    }
  }
} catch (e) {
  check("MCP adapter probe", false, e instanceof Error ? e.message : String(e));
} finally {
  await disconnectAll();
}

// ── Summary ───────────────────────────────────────────────────
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
