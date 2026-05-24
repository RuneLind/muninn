import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { getLog } from "../logging.ts";
import type { HivemindBotClient } from "./client.ts";
import type { Namespace, Peer } from "./types.ts";
import { DEFAULT_ASK_PEER_TIMEOUT_SEC } from "./config.ts";
import { peekActiveTurn } from "./active-turn.ts";
import { setPendingPeer } from "./correlation.ts";
import { mintCorrelationToken, setCorrelationToken } from "./correlation-tokens.ts";
import { peerNameFor } from "./peer-name.ts";
import { getDevRunByThreadId, insertHandoff } from "../db/dev-runs.ts";

/** Tie any inbound reply from `to` back to the thread this outbound came from,
 *  so peer responses route into the originating chat thread instead of the
 *  default `peer:<ns>/<name>` bucket.
 *
 *  Mints an opaque token bound to this exact outbound and returns it for the
 *  caller to put on the wire — the peer's echoed reply then resolves to this
 *  thread precisely, even if another outbound to the same peer races (the
 *  precise path). Also writes the `(bot, peer)` row as the un-echoed fallback
 *  for raw peers that don't echo the token. Returns undefined (no token) when
 *  there's no active turn to bind to — the reply then falls back to the default
 *  bucket, same as before. */
async function bindOutboundToOriginThread(botName: string, to: string): Promise<string | undefined> {
  return bindOutboundToThread(botName, to, peekActiveTurn(botName));
}

/** Like `bindOutboundToOriginThread` but for callers that have already resolved
 *  the origin thread (e.g. `delegate_task`, which peeks once to resolve the run
 *  AND bind the token to the *same* thread — peeking twice across an await could
 *  pick a different thread if a concurrent turn on the bot races). */
async function bindOutboundToThread(
  botName: string,
  to: string,
  originThread: string | null,
): Promise<string | undefined> {
  if (!originThread) return undefined;
  const correlationId = mintCorrelationToken();
  await Promise.all([
    setCorrelationToken(botName, correlationId, originThread),
    setPendingPeer(botName, to, originThread),
  ]);
  return correlationId;
}

const log = getLog("hivemind", "mcp-server");

export const HIVEMIND_MCP_PORT = 9180;

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
}

/**
 * Tracks all `HivemindBotClient` instances for one bot (one per joined
 * namespace). Maintains a `peer_id → namespace` cache populated by every
 * `list_peers` response so the shim can route `ask_peer`/`send_to_peer`
 * through the correct WS without persona changes.
 */
export class BotClientRegistry {
  private clients = new Map<Namespace, HivemindBotClient>();
  /** peer_id → namespace owning that peer. Updated on every list_peers response. */
  private peerNamespace = new Map<string, Namespace>();
  /** peer_id → { cwd, summary } from the last list_peers, for deriving a stable
   *  peer_name (cwd-basename) when recording a delegate_task handoff. Rebuilt on
   *  every unfiltered list_peers, same lifecycle as peerNamespace. */
  private peerInfo = new Map<string, { cwd: string; summary: string }>();

  add(namespace: Namespace, client: HivemindBotClient): void {
    this.clients.set(namespace, client);
  }

  get namespaces(): Namespace[] {
    return Array.from(this.clients.keys());
  }

  /**
   * List peers across all namespaces (or just one when filtered). Each
   * client's response is cached so subsequent `ask_peer` calls can find
   * the right WS for a given peer ID. Cache is rebuilt every call so
   * dead peer IDs from prior sessions don't accumulate.
   */
  async listPeers(scope: "namespace" | "machine", filter?: Namespace): Promise<Peer[]> {
    const single = filter ? this.clients.get(filter) : null;
    const targets = filter ? (single ? [single] : []) : Array.from(this.clients.values());
    if (targets.length === 0) return [];

    const results = await Promise.allSettled(targets.map((c) => c.listPeers(scope)));
    if (!filter) {
      this.peerNamespace.clear();
      this.peerInfo.clear();
    }

    const merged: Peer[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < targets.length; i++) {
      const c = targets[i]!;
      const r = results[i]!;
      if (r.status === "rejected") {
        log.warn("listPeers failed in namespace {ns}: {error}", {
          botName: c.botName, ns: c.namespace,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
        continue;
      }
      for (const p of r.value) {
        this.peerNamespace.set(p.id, c.namespace);
        this.peerInfo.set(p.id, { cwd: p.cwd, summary: p.summary });
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        merged.push(p);
      }
    }
    return merged;
  }

  /**
   * Pick the client that owns this peer ID. Cache hit when the bot called
   * `list_peers` first (the dominant flow). On miss falls back to the first
   * client and logs a warn — bot can recover by calling list_peers again.
   */
  pickClientFor(peerId: string): HivemindBotClient | null {
    const ns = this.peerNamespace.get(peerId);
    if (ns) {
      const c = this.clients.get(ns);
      if (c) return c;
    }
    const fallback = this.clients.values().next().value ?? null;
    if (fallback) {
      log.warn(
        "No cached namespace for peer {peerId} — falling back to {ns}. " +
          "Bot should call list_peers before ask_peer/send_to_peer.",
        { botName: fallback.botName, peerId, ns: fallback.namespace },
      );
    }
    return fallback;
  }

  /**
   * Stable peer_name (cwd-basename) for a peer id, from the list_peers cache.
   * Uses the same `peerNameFor` the router uses for inbound naming, so a
   * delegate_task handoff and the peer's later reply agree on the name (the
   * (run_id, peer_name) join in Phase 4). Returns undefined on cache miss —
   * the bot should have called list_peers first to get the peer id anyway.
   */
  peerNameFor(peerId: string): string | undefined {
    const info = this.peerInfo.get(peerId);
    if (!info) return undefined;
    return peerNameFor({ fromCwd: info.cwd, fromSummary: info.summary, fromId: peerId });
  }
}

export class HivemindMcpServer {
  private httpServer: ReturnType<typeof Bun.serve> | null = null;
  private sessions = new Map<string, Session>();
  /** Map of bot name → registry of (namespace, client) pairs. */
  private bots = new Map<string, BotClientRegistry>();
  private port: number;

  constructor(port = HIVEMIND_MCP_PORT) {
    this.port = port;
  }

  get isRunning(): boolean {
    return this.httpServer !== null;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Register one client (one namespace) for a bot. May be called multiple
   *  times per bot — once per joined namespace. */
  registerBotClient(botName: string, namespace: Namespace, client: HivemindBotClient): void {
    let reg = this.bots.get(botName);
    if (!reg) {
      reg = new BotClientRegistry();
      this.bots.set(botName, reg);
    }
    reg.add(namespace, client);
    log.info("Registered bot {botName} namespace {ns} at /mcp/{botName}", { botName, ns: namespace });
  }

  unregisterBot(botName: string): void {
    this.bots.delete(botName);
  }

  start(): void {
    if (this.httpServer) return;
    this.httpServer = Bun.serve({
      port: this.port,
      hostname: "127.0.0.1",
      // ask_peer can block up to ~600s waiting for a peer reply. Bun's
      // default idle timeout (~10s) closes the MCP request mid-wait and the
      // bot sees "fetch failed". 255 is the maximum allowed value.
      idleTimeout: 255,
      fetch: (req) => this.handleHttp(req),
    });
    log.info("Hivemind MCP server started on :{port}", { port: this.port });
  }

  async stop(): Promise<void> {
    if (!this.httpServer) return;
    for (const [, session] of this.sessions) {
      try {
        await session.server.close();
      } catch {
        // ignore
      }
    }
    this.sessions.clear();
    this.httpServer.stop();
    this.httpServer = null;
    log.info("Hivemind MCP server stopped");
  }

  // ── HTTP routing ──────────────────────────────────────────

  private async handleHttp(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        bots: Array.from(this.bots.keys()),
        sessions: this.sessions.size,
      });
    }

    // Extract bot name from /mcp/<botName>
    const match = url.pathname.match(/^\/mcp\/([^/]+)$/);
    if (!match) {
      return new Response("Not found", { status: 404 });
    }
    const botName = decodeURIComponent(match[1]!);
    const registry = this.bots.get(botName);
    if (!registry) {
      return new Response(`Unknown bot: ${botName}`, { status: 404 });
    }

    const sessionId = req.headers.get("mcp-session-id");
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) return new Response("Session not found", { status: 404 });
      return session.transport.handleRequest(req);
    }

    if (req.method === "POST") {
      return this.handleNewSession(req, botName, registry);
    }
    return new Response("Bad request — missing session ID", { status: 400 });
  }

  private async handleNewSession(req: Request, botName: string, registry: BotClientRegistry): Promise<Response> {
    const server = createMcpServerForBot(botName, registry);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        this.sessions.set(id, { transport, server });
        log.info("New MCP session {id} for bot {bot}", { id: id.slice(0, 8), bot: botName });
      },
      onsessionclosed: (id) => {
        this.sessions.delete(id);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) this.sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    return transport.handleRequest(req);
  }
}

/** Build an MCP server scoped to a single bot's set of HivemindBotClients. */
function createMcpServerForBot(botName: string, registry: BotClientRegistry): McpServer {
  const server = new McpServer(
    { name: `muninn-hivemind-${botName}`, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  const namespacesHint = registry.namespaces.join(", ");

  server.tool(
    "list_peers",
    "List other AI coding agents reachable via claude-hivemind. Use this first to find the peer ID before calling ask_peer or send_to_peer. " +
      'Default scope "namespace" returns peers in all namespaces this bot has joined; "machine" returns all peers on this computer. ' +
      `Pass an optional namespace to filter to one (joined namespaces: ${namespacesHint}).`,
    {
      scope: z
        .enum(["namespace", "machine"])
        .optional()
        .describe('"namespace" (default) or "machine"'),
      namespace: z
        .string()
        .optional()
        .describe(`Filter to one of the bot's joined namespaces (${namespacesHint}). Default: list across all of them.`),
    },
    async ({ scope, namespace }) => {
      try {
        const peers = await registry.listPeers(scope ?? "namespace", namespace);
        if (peers.length === 0) {
          const where = namespace ? `namespace=${namespace}` : `joined namespaces=${namespacesHint}`;
          return textResult(`No peers found (scope: ${scope ?? "namespace"}, ${where}).`);
        }
        const lines = peers.map((p) => {
          const parts = [
            `ID: ${p.id}`,
            `Type: ${p.agent_type}`,
            `CWD: ${p.cwd}`,
            `Namespace: ${p.namespace}`,
          ];
          if (p.git_root) parts.push(`Repo: ${p.git_root}`);
          if (p.git_branch) parts.push(`Branch: ${p.git_branch}`);
          if (p.summary) parts.push(`Summary: ${p.summary}`);
          parts.push(`Status: ${p.connected ? "connected" : "disconnected"}`);
          return parts.join("\n  ");
        });
        return textResult(`Found ${peers.length} peer(s):\n\n${lines.join("\n\n")}`);
      } catch (e) {
        return textResult(`Error listing peers: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    },
  );

  server.tool(
    "ask_peer",
    "Send a message to another AI coding agent and wait up to wait_seconds for a reply. " +
      "Use this for short Q&A while the peer is online and likely to respond quickly. " +
      "For long-running tasks (where the peer needs minutes to complete), use send_to_peer instead — " +
      "ask_peer will time out and return a hint.",
    {
      to: z.string().describe("Peer ID from list_peers"),
      message: z.string().describe("The message to send"),
      wait_seconds: z
        .number()
        .int()
        .positive()
        .max(240)
        .optional()
        .describe(`How long to wait for a reply (default ${DEFAULT_ASK_PEER_TIMEOUT_SEC}s, max 240s — bounded by the MCP HTTP idle timeout)`),
    },
    async ({ to, message, wait_seconds }) => {
      const client = registry.pickClientFor(to);
      if (!client) {
        return textResult("No hivemind client registered for this bot", true);
      }
      // ask_peer's blocking reply flows back as the tool result, but late
      // (post-timeout) and unsolicited follow-up replies still need correlation.
      const correlationId = await bindOutboundToOriginThread(botName, to);
      const timeout = wait_seconds ?? DEFAULT_ASK_PEER_TIMEOUT_SEC;
      const reply = await client.askPeer(to, message, timeout, correlationId);
      switch (reply.status) {
        case "ok":
          return textResult(reply.text);
        case "timeout":
          return textResult(`[timed out] ${reply.text}`);
        case "not_connected":
        case "send_failed":
          return textResult(reply.text, true);
      }
    },
  );

  server.tool(
    "send_to_peer",
    "Send a fire-and-forget message to another AI coding agent. Returns immediately. " +
      "Use this for long-running tasks (e.g. \"please rebuild the search index\") where you don't want to block. " +
      "The peer's reply, if any, will arrive asynchronously and may not be visible in this turn.",
    {
      to: z.string().describe("Peer ID from list_peers"),
      message: z.string().describe("The message to send"),
    },
    async ({ to, message }) => {
      const client = registry.pickClientFor(to);
      if (!client) {
        return textResult("No hivemind client registered for this bot", true);
      }
      const correlationId = await bindOutboundToOriginThread(botName, to);
      const ok = client.sendMessage(to, message, correlationId);
      if (!ok) return textResult("Failed to send — not connected to broker", true);
      return textResult(`Message sent to peer ${to}.`);
    },
  );

  server.tool(
    "delegate_task",
    "Delegate a task to another AI coding agent AND record it as a tracked handoff in the current dev run (spec-driven dev loop). " +
      "Fire-and-forget like send_to_peer, but additionally ties the handoff to this research thread's dev_run and asks the peer to echo a run marker so its reply routes back precisely. " +
      "Call list_peers first to get the peer id. Use this (instead of send_to_peer) when handing a workplan to a build agent, a spec to a test agent, or an e2e run to an orchestrate agent. " +
      "The peer's reply arrives asynchronously and may not be visible in this turn.",
    {
      to: z.string().describe("Peer ID from list_peers"),
      message: z
        .string()
        .describe("The task to delegate — e.g. the workplan/spec path plus what to do and to report back"),
      role: z
        .enum(["build", "test", "orchestrate", "review"])
        .describe(
          "This peer's role in the run: build (implement the workplan), test (write the e2e spec + test), orchestrate (run the cross-repo e2e), or review",
        ),
      issueKey: z
        .string()
        .optional()
        .describe(
          "Optional Jira/issue key, for display only. The run is resolved by the originating thread, so a wrong or missing value will not misroute the handoff.",
        ),
    },
    async ({ to, message, role, issueKey }) => {
      const r = await runDelegateTask(botName, registry, { to, message, role, issueKey });
      return textResult(r.text, r.isError);
    },
  );

  return server;
}

/** Short, echo-friendly form of a run id for the reply marker. Autonomous peers
 *  truncate or paraphrase long uuids (Phase 1.5 finding), so the marker carries
 *  the first 8 hex chars of the run id; Phase 4 resolves it back by prefix match. */
export function shortRunId(runId: string): string {
  return runId.slice(0, 8);
}

/** Instruction appended to a delegated task telling the peer how to close the
 *  loop: end its reply with a status marker that echoes the run id. The in-marker
 *  `run:<id>` — not the broker correlation token — is the authoritative join for
 *  handoff replies, because it rides in the message body the agent fully controls.
 *  Build/test/review report done|failed; orchestrate reports e2e green|red. */
export function runMarkerInstruction(runId: string, role: string): string {
  const id = shortRunId(runId);
  const marker =
    role === "orchestrate"
      ? `<!-- e2e: green run:${id} --> on success, or <!-- e2e: red run:${id} --> if it failed`
      : `<!-- status: done run:${id} --> on success, or <!-- status: failed run:${id} --> if it failed`;
  return `When you finish, end your reply with this status marker on its own line so the run is tracked: ${marker}. Echo the id "${id}" exactly.`;
}

/**
 * Core of the `delegate_task` tool — sends a tracked handoff to a peer and
 * records it against the originating thread's dev_run. Exported for tests.
 *
 * Routing decision (locked — see mimir plan / handover): the run is resolved by
 * the ORIGIN thread (`peekActiveTurn`), NOT the LLM-supplied issueKey. Chat-started
 * research has a synthetic issue_key the model can't reproduce, and the run was
 * born keyed to the thread, so joining on issueKey would fork a second run for
 * exactly that case. issueKey is a non-authoritative stamp; role is persisted on
 * the handoff. When there's no dev_run for the thread the message is still sent
 * (plain delegation), just untracked.
 */
export async function runDelegateTask(
  botName: string,
  registry: BotClientRegistry,
  args: { to: string; message: string; role: string; issueKey?: string },
): Promise<{ text: string; isError: boolean }> {
  const { to, message, role } = args;
  const client = registry.pickClientFor(to);
  if (!client) return { text: "No hivemind client registered for this bot", isError: true };

  // Peek the origin thread ONCE and reuse it for both run resolution and the
  // token binding — peeking again inside the bind could pick a different thread
  // if a concurrent turn on this bot races during the awaited DB read.
  const originThread = peekActiveTurn(botName);
  const run = originThread ? await getDevRunByThreadId(originThread) : null;

  // Mint the broker correlation token + write the (bot,peer) fallback — exactly
  // what send_to_peer does, so the legacy reply path keeps working alongside the
  // in-marker run id.
  const correlationId = await bindOutboundToThread(botName, to, originThread);

  // Append the run marker so the peer echoes run:<id> back.
  const outgoing = run ? `${message}\n\n${runMarkerInstruction(run.id, role)}` : message;

  const ok = client.sendMessage(to, outgoing, correlationId);
  if (!ok) return { text: "Failed to send — not connected to broker", isError: true };

  if (!run) {
    log.warn(
      "delegate_task sent to {to} but no dev_run for origin thread {thread} — handoff not recorded",
      { botName, to, role, thread: originThread ?? "(no active turn)" },
    );
    return {
      text: `Message sent to peer ${to}. No active dev run for this thread, so it was sent as a plain delegation (no run tracking). Start the task from a research thread to get run tracking.`,
      isError: false,
    };
  }

  // The handoff's peer_name MUST match what the inbound router derives for the
  // peer's reply (cwd-basename) — that's the (run_id, peer_name) join. On a cold
  // cwd cache (no recent unfiltered list_peers) refresh it once; only if the peer
  // is genuinely unknown do we fall back to the id and warn, since a UUID
  // peer_name will never match the reply and the handoff would stick at 'sent'.
  let peerName = registry.peerNameFor(to);
  if (!peerName) {
    await registry.listPeers("machine");
    peerName = registry.peerNameFor(to);
  }
  if (!peerName) {
    log.warn(
      "delegate_task: no cwd cache for peer {to} after refresh — handoff peer_name falls back to the id, which won't match the inbound reply name (the run won't auto-roll-up)",
      { botName, to, run: run.id },
    );
    peerName = to;
  }
  try {
    await insertHandoff({ runId: run.id, peerName, role, peerId: to, correlationToken: correlationId });
  } catch (err) {
    log.warn("delegate_task: failed to record handoff for run {run}: {error}", {
      botName,
      run: run.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      text: `Task delegated to ${peerName} (${to}) as ${role}, but recording the handoff failed (see logs). The peer was still messaged.`,
      isError: false,
    };
  }

  return {
    text: `Task delegated to ${peerName} (${to}) as ${role}. Tracked under dev run ${run.id}; the peer will echo run:${shortRunId(run.id)} in its reply.`,
    isError: false,
  };
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError && { isError: true }),
  };
}
