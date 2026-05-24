import { test, expect, describe, beforeEach } from "bun:test";
import { BotClientRegistry, runDelegateTask, runMarkerInstruction, progressNoteInstruction, shortRunId } from "./mcp-server.ts";
import type { HivemindBotClient } from "./client.ts";
import type { Peer } from "./types.ts";
import { setupTestDb } from "../test/setup-db.ts";
import { pushActiveTurn, _resetActiveTurnsForTests } from "./active-turn.ts";
import { birthDevRun, listHandoffs } from "../db/dev-runs.ts";
import { getDb } from "../db/client.ts";

/**
 * Build a minimal stub HivemindBotClient — only the surface the registry
 * touches (botName, namespace, listPeers, sendMessage, askPeer).
 */
function stubClient(opts: {
  botName: string;
  namespace: string;
  listPeersResponse?: Peer[] | (() => Promise<Peer[]>);
}): HivemindBotClient {
  const list = typeof opts.listPeersResponse === "function"
    ? opts.listPeersResponse
    : async () => opts.listPeersResponse ?? [];
  return {
    botName: opts.botName,
    namespace: opts.namespace,
    listPeers: list,
    sendMessage: () => true,
  } as unknown as HivemindBotClient;
}

function peer(id: string, namespace: string, overrides: Partial<Peer> = {}): Peer {
  return {
    id,
    pid: 1,
    cwd: "/tmp",
    git_root: null,
    git_branch: null,
    tty: null,
    summary: "",
    namespace,
    agent_type: "claude-code",
    registered_at: "2026-04-28T00:00:00Z",
    last_seen: "2026-04-28T00:00:00Z",
    connected: 1,
    ...overrides,
  };
}

describe("BotClientRegistry", () => {
  test("listPeers merges results across namespaces and dedupes by id", async () => {
    const reg = new BotClientRegistry();
    reg.add("private", stubClient({
      botName: "m", namespace: "private",
      listPeersResponse: [peer("peer-A", "private"), peer("shared", "private")],
    }));
    reg.add("nav", stubClient({
      botName: "m", namespace: "nav",
      listPeersResponse: [peer("peer-B", "nav"), peer("shared", "nav")],
    }));

    const peers = await reg.listPeers("namespace");
    const ids = peers.map((p) => p.id).sort();
    expect(ids).toEqual(["peer-A", "peer-B", "shared"]);
  });

  test("listPeers filters to a single namespace when requested", async () => {
    const reg = new BotClientRegistry();
    reg.add("private", stubClient({
      botName: "m", namespace: "private",
      listPeersResponse: [peer("peer-A", "private")],
    }));
    reg.add("nav", stubClient({
      botName: "m", namespace: "nav",
      listPeersResponse: [peer("peer-B", "nav")],
    }));

    const peers = await reg.listPeers("namespace", "nav");
    expect(peers.map((p) => p.id)).toEqual(["peer-B"]);
  });

  test("pickClientFor uses the cache populated by listPeers", async () => {
    const privateClient = stubClient({
      botName: "m", namespace: "private",
      listPeersResponse: [peer("peer-A", "private")],
    });
    const navClient = stubClient({
      botName: "m", namespace: "nav",
      listPeersResponse: [peer("peer-B", "nav")],
    });
    const reg = new BotClientRegistry();
    reg.add("private", privateClient);
    reg.add("nav", navClient);

    await reg.listPeers("namespace");

    expect(reg.pickClientFor("peer-A")).toBe(privateClient);
    expect(reg.pickClientFor("peer-B")).toBe(navClient);
  });

  test("pickClientFor falls back to the first client on cache miss", () => {
    const first = stubClient({ botName: "m", namespace: "private" });
    const second = stubClient({ botName: "m", namespace: "nav" });
    const reg = new BotClientRegistry();
    reg.add("private", first);
    reg.add("nav", second);

    expect(reg.pickClientFor("never-seen")).toBe(first);
  });

  test("listPeers swallows per-namespace errors and continues with the rest", async () => {
    const reg = new BotClientRegistry();
    reg.add("private", stubClient({
      botName: "m", namespace: "private",
      listPeersResponse: async () => { throw new Error("boom"); },
    }));
    reg.add("nav", stubClient({
      botName: "m", namespace: "nav",
      listPeersResponse: [peer("peer-B", "nav")],
    }));

    const peers = await reg.listPeers("namespace");
    expect(peers.map((p) => p.id)).toEqual(["peer-B"]);
  });

  describe("peerNameFor (cwd cache)", () => {
    test("derives the cwd-basename from the list_peers cache", async () => {
      const reg = new BotClientRegistry();
      reg.add("nav", stubClient({
        botName: "m", namespace: "nav",
        listPeersResponse: [peer("peer-A", "nav", { cwd: "/Users/x/source/nav/melosys-api-claude" })],
      }));
      await reg.listPeers("machine");
      expect(reg.peerNameFor("peer-A")).toBe("melosys-api-claude");
    });

    test("returns undefined on cache miss (no list_peers yet)", () => {
      const reg = new BotClientRegistry();
      reg.add("nav", stubClient({ botName: "m", namespace: "nav" }));
      expect(reg.peerNameFor("never-seen")).toBeUndefined();
    });

    test("falls back to the summary slug when the peer has no cwd", async () => {
      const reg = new BotClientRegistry();
      reg.add("nav", stubClient({
        botName: "m", namespace: "nav",
        listPeersResponse: [peer("peer-B", "nav", { cwd: "", summary: "NAV Review Bot" })],
      }));
      await reg.listPeers("machine");
      expect(reg.peerNameFor("peer-B")).toBe("nav-review-bot");
    });
  });
});

describe("runMarkerInstruction", () => {
  test("build/test/review report done|failed and echo the short run id", () => {
    const id = "abcdef0123456789-0000";
    const msg = runMarkerInstruction(id, "build");
    expect(msg).toContain("status: done run:abcdef01");
    expect(msg).toContain("status: failed run:abcdef01");
    expect(msg).not.toContain("e2e:");
  });

  test("orchestrate reports e2e green|red", () => {
    const msg = runMarkerInstruction("abcdef0123456789-0000", "orchestrate");
    expect(msg).toContain("e2e: green run:abcdef01");
    expect(msg).toContain("e2e: red run:abcdef01");
    expect(msg).not.toContain("status: done");
  });

  test("shortRunId is the first 8 hex of the run id", () => {
    expect(shortRunId("abcdef01-2345-6789-abcd-ef0123456789")).toBe("abcdef01");
  });
});

describe("progressNoteInstruction", () => {
  test("asks for a non-terminal note marker echoing the short run id", () => {
    const msg = progressNoteInstruction("abcdef0123456789-0000");
    expect(msg).toContain("note: <kind> run:abcdef01");
    expect(msg).toContain("discovery|decision|blocker|milestone");
    // It is NOT a terminal marker — that's runMarkerInstruction's job.
    expect(msg).not.toContain("status: done");
    expect(msg).not.toContain("e2e:");
  });
});

/**
 * Build a stub client that records every sendMessage call, so the delegate
 * tests can assert the run marker was appended to the outgoing message.
 */
function recordingStubClient(opts: { botName: string; namespace: string; peers: Peer[]; sendOk?: boolean }) {
  const sends: Array<{ to: string; text: string; correlationId?: string }> = [];
  const client = {
    botName: opts.botName,
    namespace: opts.namespace,
    listPeers: async () => opts.peers,
    sendMessage: (to: string, text: string, correlationId?: string) => {
      sends.push({ to, text, correlationId });
      return opts.sendOk ?? true;
    },
  } as unknown as HivemindBotClient;
  return { client, sends };
}

describe("runDelegateTask", () => {
  setupTestDb();
  const BOT = "delegate-bot";

  beforeEach(() => {
    _resetActiveTurnsForTests();
  });

  async function registryWithPeer(p: Peer, sendOk = true) {
    const { client, sends } = recordingStubClient({ botName: BOT, namespace: p.namespace, peers: [p], sendOk });
    const reg = new BotClientRegistry();
    reg.add(p.namespace, client);
    await reg.listPeers("machine"); // warm the namespace + cwd caches
    return { reg, sends };
  }

  test("records a handoff against the origin thread's dev_run and appends the run marker", async () => {
    const threadId = crypto.randomUUID();
    const run = await birthDevRun({ botName: BOT, userId: "u", issueKey: "MELOSYS-50", threadId });
    pushActiveTurn(BOT, threadId);

    const p = peer("peer-build", "nav", { cwd: "/Users/x/source/nav/melosys-api-claude" });
    const { reg, sends } = await registryWithPeer(p);

    const res = await runDelegateTask(BOT, reg, {
      to: "peer-build",
      message: "Implement the workplan at /reports/u/MELOSYS-50.md",
      role: "build",
    });

    expect(res.isError).toBe(false);
    expect(res.text).toContain(run.id);

    // The outgoing message carries the original text, the terminal run marker,
    // AND the progress-note instruction (the single delegation seam).
    expect(sends).toHaveLength(1);
    expect(sends[0]!.text).toContain("Implement the workplan");
    expect(sends[0]!.text).toContain(`run:${shortRunId(run.id)}`);
    expect(sends[0]!.text).toContain("note: <kind>");

    // A handoff row exists, keyed to the run, with the resolved peer_name.
    const handoffs = await listHandoffs(run.id);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.peerName).toBe("melosys-api-claude");
    expect(handoffs[0]!.peerId).toBe("peer-build");
    expect(handoffs[0]!.role).toBe("build");
    expect(handoffs[0]!.status).toBe("sent");
  });

  test("orchestrate role uses the e2e marker", async () => {
    const threadId = crypto.randomUUID();
    const run = await birthDevRun({ botName: BOT, userId: "u", issueKey: "MELOSYS-51", threadId });
    pushActiveTurn(BOT, threadId);

    const p = peer("peer-e2e", "nav", { cwd: "/Users/x/source/nav/melosys-e2e-tests" });
    const { reg, sends } = await registryWithPeer(p);

    await runDelegateTask(BOT, reg, { to: "peer-e2e", message: "Run the cross-repo e2e", role: "orchestrate" });
    expect(sends[0]!.text).toContain(`e2e: green run:${shortRunId(run.id)}`);
  });

  test("resolves the run by origin thread, NOT the LLM-supplied issueKey", async () => {
    // The run is born with a synthetic issue_key; the model passes a different
    // (wrong) issueKey. The handoff must still attach to the thread's run.
    const threadId = crypto.randomUUID();
    const run = await birthDevRun({ botName: BOT, userId: "u", issueKey: "research-abcd1234", threadId });
    pushActiveTurn(BOT, threadId);

    const p = peer("peer-test", "nav", { cwd: "/Users/x/source/nav/melosys-e2e-tests" });
    const { reg } = await registryWithPeer(p);

    await runDelegateTask(BOT, reg, {
      to: "peer-test",
      message: "Write the spec test",
      role: "test",
      issueKey: "TOTALLY-WRONG-999",
    });

    const handoffs = await listHandoffs(run.id);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.role).toBe("test");
  });

  test("no dev_run for the thread → sends plain, records nothing", async () => {
    const threadId = crypto.randomUUID(); // a thread with no dev_run
    pushActiveTurn(BOT, threadId);

    const p = peer("peer-x", "nav", { cwd: "/Users/x/source/nav/some-repo" });
    const { reg, sends } = await registryWithPeer(p);

    const res = await runDelegateTask(BOT, reg, { to: "peer-x", message: "do a thing", role: "build" });
    expect(res.isError).toBe(false);
    expect(res.text).toContain("plain delegation");
    // No marker appended.
    expect(sends[0]!.text).toBe("do a thing");
    // And nothing recorded — the no-run path must not insert any handoff.
    const rows = await getDb()<{ count: number }[]>`SELECT count(*)::int AS count FROM dev_run_handoffs`;
    expect(rows[0]!.count).toBe(0);
  });

  test("cold cwd cache → lazy-warms so peer_name is the basename, not the raw id", async () => {
    const threadId = crypto.randomUUID();
    const run = await birthDevRun({ botName: BOT, userId: "u", issueKey: "MELOSYS-52", threadId });
    pushActiveTurn(BOT, threadId);

    // Build the registry WITHOUT pre-warming the caches (no upfront list_peers),
    // so runDelegateTask must refresh them itself to resolve the peer_name.
    const p = peer("peer-cold", "nav", { cwd: "/Users/x/source/nav/melosys-web" });
    const { client } = recordingStubClient({ botName: BOT, namespace: "nav", peers: [p] });
    const reg = new BotClientRegistry();
    reg.add("nav", client);

    await runDelegateTask(BOT, reg, { to: "peer-cold", message: "build it", role: "build" });

    const handoffs = await listHandoffs(run.id);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.peerName).toBe("melosys-web");
  });

  test("returns an error when the peer has no registered client", async () => {
    const reg = new BotClientRegistry(); // no clients added
    const res = await runDelegateTask(BOT, reg, { to: "ghost", message: "x", role: "build" });
    expect(res.isError).toBe(true);
  });
});
