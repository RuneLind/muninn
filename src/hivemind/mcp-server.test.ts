import { test, expect, describe } from "bun:test";
import { BotClientRegistry } from "./mcp-server.ts";
import type { HivemindBotClient } from "./client.ts";
import type { Peer } from "./types.ts";

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
});
