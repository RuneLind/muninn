/**
 * A fake Anthropic Messages API and the fixture around it, for driving a REAL
 * Claude CLI or Agent SDK subprocess through a scripted tool turn without
 * touching the real API.
 *
 * The fake answers the first request that carries {@link PROBE_MARKER} with
 * the scripted `tool_use` blocks, and every later request in that loop with
 * plain text. Any other request (WebFetch's secondary summarizing call,
 * auxiliary calls) gets plain text. The `tool_result` blocks the CLI sends back
 * are the record of what each tool did.
 *
 * Point a subprocess at it with `ANTHROPIC_BASE_URL` and a dummy
 * `ANTHROPIC_API_KEY`. The fixture also serves one HTTPS page on 127.0.0.1 with
 * a self-signed certificate, trusted in the subprocess through
 * `NODE_EXTRA_CA_CERTS`: WebFetch upgrades http to https and refuses
 * single-label hosts, so neither plain http nor `localhost` works.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PROBE_MARKER = "FENCE-PROBE-7c1e";

export interface ScriptedToolUse {
  name: string;
  input: Record<string, unknown>;
}

export interface ObservedToolResult {
  id: string;
  name: string;
  isError: boolean;
  text: string;
}

/** An 8x8 red JPEG, so a Read of `x.jpg` has a real image to decode. */
const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAACKADAAQAAAABAAAACAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgACAAIAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A+L6KKK/lM/38P//Z";

/**
 * A stdio MCP server that writes `started` on boot and appends one line per
 * `tools/call` to `calls`, so a test can tell "never started" apart from
 * "started but never called".
 */
const RECORDING_MCP_SERVER = `
import { appendFileSync, writeFileSync } from "node:fs";
const [startedPath, callsPath] = process.argv.slice(2);
writeFileSync(startedPath, String(process.pid));
let buf = "";
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    if (req.id === undefined) continue;
    if (req.method === "initialize") {
      send({ jsonrpc: "2.0", id: req.id, result: {
        protocolVersion: req.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "stub", version: "1.0.0" },
      } });
    } else if (req.method === "tools/list") {
      send({ jsonrpc: "2.0", id: req.id, result: { tools: [{
        name: "record",
        description: "Records that it was called.",
        inputSchema: { type: "object", properties: { note: { type: "string" } } },
      }] } });
    } else if (req.method === "tools/call") {
      appendFileSync(callsPath, JSON.stringify(req.params ?? {}) + "\\n");
      send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "STUB-RECORDED" }] } });
    } else if (req.method === "ping") {
      send({ jsonrpc: "2.0", id: req.id, result: {} });
    } else {
      send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "method not found" } });
    }
  }
});
`;

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

function messageEvents(blocks: Block[], stopReason: "end_turn" | "tool_use"): string {
  const id = `msg_${Math.random().toString(36).slice(2, 10)}`;
  let out = sse("message_start", {
    type: "message_start",
    message: {
      id, type: "message", role: "assistant", model: "claude-fake", content: [],
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      out += sse("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      out += sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else {
      out += sse("content_block_start", {
        type: "content_block_start", index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      });
      out += sse("content_block_delta", {
        type: "content_block_delta", index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      });
    }
    out += sse("content_block_stop", { type: "content_block_stop", index });
  });
  out += sse("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 5 },
  });
  out += sse("message_stop", { type: "message_stop" });
  return out;
}

function jsonMessage(blocks: Block[], stopReason: "end_turn" | "tool_use"): unknown {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 10)}`,
    type: "message", role: "assistant", model: "claude-fake",
    content: blocks, stop_reason: stopReason, stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: { type?: string; text?: string; content?: unknown }) =>
      b?.type === "text" ? (b.text ?? "") : b?.type === "tool_result" ? contentText(b.content) : JSON.stringify(b))
    .join("\n");
}

export interface FakeMessagesApi {
  url: string;
  /** Every request body the fake received, in order. */
  requests: Array<{ path: string; body: any }>;
  /** The tool_result blocks the CLI sent back for the scripted tool_use blocks. */
  toolResults(): ObservedToolResult[];
  /** Set the tool_use blocks the next probe turn answers with. */
  setPlan(plan: ScriptedToolUse[]): void;
  stop(): void;
}

export function startFakeMessagesApi(): FakeMessagesApi {
  let plan: ScriptedToolUse[] = [];
  let planned: Array<{ id: string; name: string }> = [];
  const requests: Array<{ path: string; body: any }> = [];
  const results = new Map<string, ObservedToolResult>();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method !== "POST" || !path.startsWith("/v1/messages") || path.includes("count_tokens")) {
        if (path.includes("count_tokens")) return Response.json({ input_tokens: 10 });
        return new Response("not found", { status: 404 });
      }
      const body = await req.json();
      requests.push({ path, body });
      const messages: Array<{ role: string; content: unknown }> = body.messages ?? [];
      const first = messages.find((m) => m.role === "user");
      const isProbe = first !== undefined && contentText(first.content).includes(PROBE_MARKER);

      let blocks: Block[];
      let stop: "end_turn" | "tool_use" = "end_turn";
      if (isProbe && !messages.some((m) => m.role === "assistant")) {
        planned = plan.map((t, i) => ({ id: `toolu_probe_${i}_${Math.random().toString(36).slice(2, 8)}`, name: t.name }));
        blocks = plan.map((t, i) => ({ type: "tool_use", id: planned[i]!.id, name: t.name, input: t.input }));
        stop = blocks.length > 0 ? "tool_use" : "end_turn";
        if (blocks.length === 0) blocks = [{ type: "text", text: "PROBE-DONE" }];
      } else if (isProbe) {
        for (const m of messages) {
          if (m.role !== "user" || !Array.isArray(m.content)) continue;
          for (const b of m.content as Array<{ type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }>) {
            if (b?.type !== "tool_result" || !b.tool_use_id) continue;
            const p = planned.find((x) => x.id === b.tool_use_id);
            results.set(b.tool_use_id, {
              id: b.tool_use_id,
              name: p?.name ?? "?",
              isError: b.is_error === true,
              text: contentText(b.content),
            });
          }
        }
        blocks = [{ type: "text", text: "PROBE-DONE" }];
      } else {
        blocks = [{ type: "text", text: "PAGE-SUMMARY: fetched." }];
      }

      if (body.stream) {
        return new Response(messageEvents(blocks, stop), {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      }
      return Response.json(jsonMessage(blocks, stop));
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    toolResults: () => planned.map((p) => results.get(p.id) ?? { id: p.id, name: p.name, isError: true, text: "(no tool_result sent)" }),
    setPlan(next) {
      plan = next;
      planned = [];
      results.clear();
    },
    stop: () => server.stop(true),
  };
}

export interface FenceFixture {
  root: string;
  /** A bot folder: `config.json` with a secret, `.mcp.json` naming the recording stub. */
  botDir: string;
  /** The one directory a `{ read }` surface allows; holds `x.jpg`. */
  allowedDir: string;
  /** A canary file outside every allowed dir, and its secret. */
  canaryPath: string;
  /** `<allowedDir>/../../traversal.txt`, a real file the traversal Read would reach. */
  traversalPath: string;
  /** Every secret a leaked Read would carry back. */
  secrets: string[];
  /** Created only if the scripted Bash command ran. */
  bashMarker: string;
  mcpStartedPath: string;
  mcpCallsPath: string;
  certPath: string;
  page: { url: string; hits: () => number; stop(): void };
  api: FakeMessagesApi;
  /** The env a spawned CLI/SDK subprocess needs: fake API, dummy key, trusted cert. */
  env: Record<string, string>;
  mcpCalls(): number;
  mcpStarted(): boolean;
  cleanup(): void;
}

/** Whether `openssl` is available to mint the page certificate. */
export function hasOpenssl(): boolean {
  try {
    return Bun.spawnSync(["openssl", "version"]).exitCode === 0;
  } catch {
    return false;
  }
}

export function createFenceFixture(): FenceFixture {
  // realpath: macOS tmpdir is a /var → /private/var symlink, and the CLI and
  // canUseTool compare resolved paths.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fence-fixture-")));
  const botDir = join(root, "bots", "probe");
  const allowedDir = join(root, "frames", "job-1");
  const outside = join(root, "elsewhere");
  for (const d of [botDir, allowedDir, outside]) mkdirSync(d, { recursive: true });

  const secrets = ["CANARY-OUTSIDE-91f2", "BOTCONFIG-SECRET-44ab", "TRAVERSAL-SECRET-0d7e"];
  const canaryPath = join(outside, "canary.txt");
  writeFileSync(canaryPath, `${secrets[0]}\n`);
  writeFileSync(join(botDir, "config.json"), JSON.stringify({ canary: secrets[1] }));
  writeFileSync(join(root, "frames", "..", "traversal.txt"), `${secrets[2]}\n`);
  const traversalPath = join(allowedDir, "..", "..", "traversal.txt");
  writeFileSync(join(allowedDir, "x.jpg"), Buffer.from(TINY_JPEG_B64, "base64"));
  writeFileSync(join(botDir, "CLAUDE.md"), "probe bot\n");

  const mcpDir = join(root, "mcp");
  mkdirSync(mcpDir);
  const mcpScript = join(mcpDir, "recording-server.mjs");
  writeFileSync(mcpScript, RECORDING_MCP_SERVER);
  const mcpStartedPath = join(mcpDir, "started");
  const mcpCallsPath = join(mcpDir, "calls");
  writeFileSync(
    join(botDir, ".mcp.json"),
    JSON.stringify({ mcpServers: { stub: { command: process.execPath, args: [mcpScript, mcpStartedPath, mcpCallsPath] } } }),
  );
  // The bot's own permission file pre-approves the stub, so on the "bot"
  // surface a call is not lost to a permission prompt: the control arm proves
  // the stub is reachable when the surface allows it.
  mkdirSync(join(botDir, ".claude"));
  writeFileSync(join(botDir, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["mcp__stub__record"] } }));

  const certDir = join(root, "cert");
  mkdirSync(certDir);
  const certPath = join(certDir, "cert.pem");
  const keyPath = join(certDir, "key.pem");
  const gen = Bun.spawnSync([
    "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath, "-days", "2",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
  ]);
  if (gen.exitCode !== 0) throw new Error(`openssl failed: ${gen.stderr.toString()}`);

  let hits = 0;
  const pageServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: readFileSync(certPath, "utf8"), key: readFileSync(keyPath, "utf8") },
    fetch() {
      hits++;
      return new Response("<html><body><h1>Probe page</h1><p>PAGE-CONTENT-5a3c</p></body></html>", {
        headers: { "content-type": "text/html" },
      });
    },
  });

  const api = startFakeMessagesApi();
  const env = {
    ANTHROPIC_BASE_URL: api.url,
    ANTHROPIC_API_KEY: "sk-ant-fake-fence-probe",
    NODE_EXTRA_CA_CERTS: certPath,
  };

  return {
    root, botDir, allowedDir, canaryPath, traversalPath, secrets,
    bashMarker: join(root, "bash-ran"),
    mcpStartedPath, mcpCallsPath, certPath,
    page: { url: `https://127.0.0.1:${pageServer.port}/page`, hits: () => hits, stop: () => pageServer.stop(true) },
    api, env,
    mcpCalls: () => (existsSync(mcpCallsPath) ? readFileSync(mcpCallsPath, "utf8").split("\n").filter(Boolean).length : 0),
    mcpStarted: () => existsSync(mcpStartedPath),
    cleanup() {
      api.stop();
      pageServer.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * The hostile half of the plan, the same on every surface: none of these may run.
 */
export function hostilePlan(f: FenceFixture): ScriptedToolUse[] {
  return [
    { name: "Bash", input: { command: `echo ran > ${f.bashMarker}`, description: "probe" } },
    { name: "Read", input: { file_path: f.canaryPath } },
    { name: "Read", input: { file_path: join(f.botDir, "config.json") } },
    { name: "Read", input: { file_path: f.traversalPath } },
    { name: "mcp__stub__record", input: { note: "probe" } },
  ];
}

export function allowedReadPlan(f: FenceFixture): ScriptedToolUse {
  return { name: "Read", input: { file_path: join(f.allowedDir, "x.jpg") } };
}

export function webFetchPlan(f: FenceFixture): ScriptedToolUse {
  return { name: "WebFetch", input: { url: f.page.url, prompt: "Summarize the page." } };
}
