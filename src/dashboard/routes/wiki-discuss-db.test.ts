/**
 * `POST /api/wiki/discuss` against the REAL test database: two POSTs on one
 * discussion that both pass the route's read of the last turn get one stream
 * and one 409, because the turn insert itself refuses a second live turn. The
 * store wraps the real functions only to line the race up: both requests read
 * the discussion before either inserts, and the inserts run one after the
 * other (the second after the first committed). Invented pages only.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { setupTestDb } from "../../test/setup-db.ts";
import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";
import {
  finishDiscussTurn,
  listDiscussTurns,
  markDiscussReaderLeft,
  setDiscussTurnCard,
  startDiscussTurn,
} from "../../db/wiki-discuss-turns.ts";
import * as turns from "../../db/wiki-discuss-turns.ts";
import { getDb } from "../../db/client.ts";
import { __resetWikiRegistryForTest, __setWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import { WIKI_AGENT_RULES_FILE } from "../../wiki/discuss-agent.ts";
import { testTempDir } from "../../test/temp-dir.ts";
import { registerWikiDiscussRoute, WIKI_DISCUSS_PATH, type DiscussStore } from "./wiki-discuss.ts";

setupTestDb();

let dir = "";

beforeAll(async () => {
  dir = await realpath(await testTempDir(path.join(tmpdir(), "muninn-discuss-db-")));
  const wiki = path.join(dir, "harbour");
  await Bun.write(path.join(wiki, WIKI_AGENT_RULES_FILE), "# Rules\n\nAnswer briefly.\n");
  await Bun.write(path.join(wiki, "notes", "harbour.md"), "---\ntitle: Harbour note\n---\n\n# Harbour note\n\nThe harbour opens at six.\n");
  __setWikiRegistryForTest([{ name: "harbour", root: wiki, source: "extra" }]);
});

afterAll(async () => {
  __resetWikiRegistryForTest();
  __resetWikiCacheForTest();
  await rm(dir, { recursive: true, force: true });
});

const copilot: BotConfig = { name: "ivar", dir: "/nonexistent", persona: "", telegramAllowedUserIds: [], slackAllowedUserIds: [], connector: "copilot-sdk", model: "invented-model" };

function app(store: DiscussStore): Hono {
  const a = new Hono();
  registerWikiDiscussRoute(a, { profile: "default", dashboardPort: 4321, claudeModel: "fallback-model", decisionTriageRepoRoots: null } as unknown as Config, {
    store,
    bots: () => [copilot],
    oneShot: async () => ({ result: "It opens at six.", costUsd: 0, toolCalls: [] }) as never,
    surfaceBlocker: async () => null,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return a;
}

const post = (a: Hono, body: unknown) =>
  a.request(WIKI_DISCUSS_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// `turns.touchDiscussTurn` through the namespace: the store's heartbeat.
const real: DiscussStore = { start: startDiscussTurn, finish: finishDiscussTurn, readerLeft: markDiscussReaderLeft, setCard: setDiscussTurnCard, list: listDiscussTurns, heartbeat: (id) => turns.touchDiscussTurn(id) };
const claude: BotConfig = { ...copilot, connector: "claude-sdk" };
const config = { profile: "default", dashboardPort: 4321, claudeModel: "fallback-model", decisionTriageRepoRoots: null } as unknown as Config;
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

/** A finished first turn on the harbour note; its discussion id. */
async function firstTurn(): Promise<string> {
  const first = await post(app(real), { wiki: "harbour", relPath: "notes/harbour.md", question: "When does it open?" });
  return JSON.parse(/event: turn\ndata: (.*)/.exec(await first.text())![1]!).discussionId as string;
}

test("a live turn whose snapshots outlast the stale bound still blocks its discussion, and is not closed", async () => {
  const page = { wiki: "harbour", relPath: "notes/harbour.md" };
  const discussionId = await firstTurn();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let snapshotting!: () => void;
  const inSnapshot = new Promise<void>((r) => (snapshotting = r));
  const a = new Hono();
  // Bounds in milliseconds: the pre-model step runs 4x the stale bound.
  registerWikiDiscussRoute(a, config, {
    store: real,
    bots: () => [claude],
    heartbeatMs: 40,
    staleRunningMs: 250,
    wikiSnapshot: async (d) => {
      snapshotting();
      await held;
      return { kind: "wiki", dir: path.join(dir, "snap"), key: "k", source: d };
    },
    oneShot: async () => ({ result: "At six.", costUsd: 0, toolCalls: [] }) as never,
    surfaceBlocker: async () => null,
    log: quiet,
  });
  const live = await post(a, { ...page, discussionId, question: "Still six?" });
  expect(live.status).toBe(200);
  await inSnapshot;
  // The old margin (the 5-minute timeout + 2) has passed since the insert.
  await getDb()`UPDATE wiki_discuss_turns SET created_at = now() - interval '8 minutes' WHERE discussion_id = ${discussionId} AND seq = 2`;
  await Bun.sleep(1000);
  const second = await post(a, { ...page, discussionId, question: "And on Sunday?" });
  expect(second.status).toBe(409);
  expect(((await second.json()) as { reason: string }).reason).toBe("busy");
  expect((await listDiscussTurns(discussionId)).map((t) => `${t.seq}:${t.endState}`)).toEqual(["1:done", "2:running"]);
  release();
  await live.text();
  expect((await listDiscussTurns(discussionId)).map((t) => `${t.seq}:${t.endState}`)).toEqual(["1:done", "2:done"]);
});

test("a running turn whose heartbeat stopped is closed as abandoned by the next turn, whose prompt says so", async () => {
  const page = { wiki: "harbour", relPath: "notes/harbour.md" };
  const discussionId = await firstTurn();
  // The first turn's process "died": its row is running again and its beats stopped.
  await getDb()`UPDATE wiki_discuss_turns SET end_state = 'running', finished_at = NULL, created_at = now() - interval '8 minutes' WHERE discussion_id = ${discussionId}`;
  await Bun.sleep(400);
  const prompts: string[] = [];
  const a = new Hono();
  registerWikiDiscussRoute(a, config, {
    store: real,
    bots: () => [copilot],
    staleRunningMs: 250,
    oneShot: async (prompt) => {
      prompts.push(prompt);
      return { result: "At six.", costUsd: 0, toolCalls: [] } as never;
    },
    surfaceBlocker: async () => null,
    log: quiet,
  });
  const res = await post(a, { ...page, discussionId, question: "After the crash?" });
  expect(res.status).toBe(200);
  await res.text();
  const rows = await listDiscussTurns(discussionId);
  expect(rows.map((t) => `${t.seq}:${t.endState}`)).toEqual(["1:abandoned", "2:done"]);
  expect(rows[0]!.finishedAt).not.toBeNull();
  expect(prompts[0]).toContain("(abandoned, unfinished)");
  expect(prompts[0]).not.toContain("(running, unfinished)");
});

test("two POSTs on one done discussion that both read it before inserting: one stream, one 409", async () => {
  const page = { wiki: "harbour", relPath: "notes/harbour.md" };
  const first = await post(app(real), { ...page, question: "When does it open?" });
  const turnFrame = /event: turn\ndata: (.*)/.exec(await first.text());
  const discussionId = JSON.parse(turnFrame![1]!).discussionId as string;
  expect((await listDiscussTurns(discussionId)).map((t) => t.endState)).toEqual(["done"]);

  // Both requests list before either inserts; the inserts then run in turn.
  let listed = 0;
  let bothListed!: () => void;
  const barrier = new Promise<void>((r) => (bothListed = r));
  let chain: Promise<unknown> = Promise.resolve();
  const raced: DiscussStore = {
    ...real,
    list: async (id) => {
      const rows = await listDiscussTurns(id);
      if (++listed === 2) bothListed();
      await barrier;
      return rows;
    },
    start: (input, opts) => {
      const next = chain.then(() => startDiscussTurn(input, opts));
      chain = next.catch(() => {});
      return next;
    },
  };
  // Hold the first turn's model call so it is still running when the second inserts.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const a = new Hono();
  registerWikiDiscussRoute(a, { profile: "default", dashboardPort: 4321, claudeModel: "fallback-model", decisionTriageRepoRoots: null } as unknown as Config, {
    store: raced,
    bots: () => [copilot],
    oneShot: async () => {
      await gate;
      return { result: "Still six.", costUsd: 0, toolCalls: [] } as never;
    },
    surfaceBlocker: async () => null,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const [r1, r2] = await Promise.all([post(a, { ...page, discussionId, question: "Still?" }), post(a, { ...page, discussionId, question: "Really?" })]);
  expect([r1.status, r2.status].sort()).toEqual([200, 409]);
  const refused = [r1, r2].find((r) => r.status === 409)!;
  expect(((await refused.json()) as { reason: string }).reason).toBe("busy");
  release();
  await [r1, r2].find((r) => r.status === 200)!.text();
  expect((await listDiscussTurns(discussionId)).map((t) => `${t.seq}:${t.endState}`)).toEqual(["1:done", "2:done"]);
});
