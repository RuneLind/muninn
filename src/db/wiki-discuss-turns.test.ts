/**
 * `wiki_discuss_turns` (migration 090) against the test database: a turn
 * inserted running and finished once, the discussion's sequence, the one-live-
 * turn rule (sequential and concurrent), a running row whose heartbeat stopped
 * closed as abandoned (by the next start and by the sweep) while one whose
 * heartbeat runs is not, a forced collision on the sequence, the reader-left
 * mark, the card and the hand-over mark (migration 091). Invented pages only.
 */
import { describe, expect, test } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { getDb } from "./client.ts";
import { getRecentMessages } from "./messages.ts";
import {
  DiscussTurnConflict,
  finishDiscussTurn,
  getDiscussTurn,
  listDiscussTurns,
  markDiscussReaderLeft,
  markDiscussTurnHandedOver,
  setDiscussTurnCard,
  startDiscussTurn as startTurn,
  type DiscussTurnStart,
} from "./wiki-discuss-turns.ts";
// The heartbeat and the sweep through the namespace, so this file loads
// against a store that has neither.
import * as turns from "./wiki-discuss-turns.ts";

setupTestDb();

const STALE_MS = 7 * 60 * 1000;
const startDiscussTurn = (i: DiscussTurnStart) => startTurn(i, { staleRunningMs: STALE_MS });
const done = (id: string) => finishDiscussTurn(id, { endState: "done", answer: "An answer." });

const start = (discussionId: string, over: Partial<DiscussTurnStart> = {}): DiscussTurnStart => ({
  discussionId,
  wiki: "invented",
  relPath: "plans/ferry.mdx",
  pageHash: "h1",
  selection: "The summer route adds a stop.",
  question: "Which stop?",
  location: { found: "exact", fromLine: 15, toLine: 15 },
  botName: "ivar",
  connector: "claude-sdk",
  model: "invented-model",
  surface: { kind: "readSearch" },
  ...over,
});

describe("wiki_discuss_turns", () => {
  test("a turn starts running and is finished once, with how it ended", async () => {
    const d = crypto.randomUUID();
    const t = await startDiscussTurn(start(d));
    expect(t.seq).toBe(1);
    let row = await getDiscussTurn(t.id);
    expect(row?.endState).toBe("running");
    expect(row?.location).toEqual({ found: "exact", fromLine: 15, toLine: 15 });
    expect(
      await finishDiscussTurn(t.id, {
        endState: "done",
        answer: "Example Island.",
        toolCalls: [{ name: "Read", input: "{}" }],
        proposedEdit: { edits: [], dropped: [], overLimit: false },
        costUsd: 0.02,
        durationMs: 1234,
      }),
    ).toBe(true);
    // A second finish does not overwrite the first.
    expect(await finishDiscussTurn(t.id, { endState: "error", answer: "", error: "late" })).toBe(false);
    row = await getDiscussTurn(t.id);
    expect(row).toMatchObject({ endState: "done", answer: "Example Island.", error: null, toolCalls: [{ name: "Read", input: "{}" }], costUsd: 0.02, durationMs: 1234 });
    expect(row?.proposedEdit).toEqual({ edits: [], dropped: [], overLimit: false });
    expect(row?.finishedAt).not.toBeNull();
  });

  test("turns of a discussion count up once each has finished", async () => {
    const d = crypto.randomUUID();
    const a = await startDiscussTurn(start(d));
    await done(a.id);
    const b = await startDiscussTurn(start(d, { question: "And the night route?" }));
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect((await listDiscussTurns(d)).map((t) => t.question)).toEqual(["Which stop?", "And the night route?"]);
  });

  test("a second turn is refused while the discussion's turn runs, even after the first committed", async () => {
    const d = crypto.randomUUID();
    await done((await startDiscussTurn(start(d))).id);
    const running = await startDiscussTurn(start(d, { question: "Second?" }));
    expect(running.seq).toBe(2);
    const err = await startDiscussTurn(start(d, { question: "Third?" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscussTurnConflict);
    expect((await listDiscussTurns(d)).map((t) => `${t.seq}:${t.endState}`)).toEqual(["1:done", "2:running"]);
  });

  test("concurrent starts after a done turn: exactly one runs", async () => {
    const d = crypto.randomUUID();
    await done((await startDiscussTurn(start(d))).id);
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => startDiscussTurn(start(d, { question: `Q${i}` }))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(DiscussTurnConflict);
    expect((await listDiscussTurns(d)).filter((t) => t.endState === "running")).toHaveLength(1);
  });

  test("a running turn whose heartbeat stopped is closed as abandoned by the next start, which then runs", async () => {
    const d = crypto.randomUUID();
    const dead = await startTurn(start(d), { staleRunningMs: 200 });
    await Bun.sleep(300);
    const next = await startTurn(start(d, { question: "After the crash?" }), { staleRunningMs: 200 });
    expect(next.seq).toBe(2);
    const row = await getDiscussTurn(dead.id);
    expect(row?.endState).toBe("abandoned");
    expect(row?.finishedAt).not.toBeNull();
    // A turn whose process only stalled past the bound still stores its result.
    expect(await done(dead.id)).toBe(true);
    expect((await getDiscussTurn(dead.id))?.endState).toBe("done");
  });

  test("a running turn whose heartbeat runs is never closed and keeps blocking its discussion", async () => {
    const d = crypto.randomUUID();
    const live = await startTurn(start(d), { staleRunningMs: 200 });
    for (let i = 0; i < 12; i++) {
      await Bun.sleep(50);
      await turns.touchDiscussTurn(live.id);
    }
    // Long past any turn timeout since it started, but still beating.
    await getDb()`UPDATE wiki_discuss_turns SET created_at = now() - interval '8 minutes' WHERE id = ${live.id}`;
    expect(await turns.closeAbandonedDiscussTurns(200)).not.toContain(live.id);
    const err = await startTurn(start(d, { question: "Second?" }), { staleRunningMs: 200 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscussTurnConflict);
    expect((await getDiscussTurn(live.id))?.endState).toBe("running");
  });

  test("the sweep closes every running turn whose heartbeat is past the bound, and nothing else", async () => {
    const [d1, d2, d3] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const stale = await startDiscussTurn(start(d1));
    const finished = await startDiscussTurn(start(d2));
    await done(finished.id);
    const fresh = await startDiscussTurn(start(d3));
    await getDb()`UPDATE wiki_discuss_turns SET heartbeat_at = now() - ${STALE_MS + 60_000}::double precision * interval '1 millisecond' WHERE id IN (${stale.id}, ${finished.id})`;
    const closed = await turns.closeAbandonedDiscussTurns(STALE_MS);
    expect(closed).toContain(stale.id);
    expect(closed).not.toContain(finished.id);
    expect(closed).not.toContain(fresh.id);
    expect(await getDiscussTurn(stale.id)).toMatchObject({ endState: "abandoned", error: expect.stringContaining("heartbeat") });
    expect((await getDiscussTurn(stale.id))?.finishedAt).not.toBeNull();
    expect((await getDiscussTurn(finished.id))?.endState).toBe("done");
    expect((await getDiscussTurn(fresh.id))?.endState).toBe("running");
  });

  test("an insert that collides on the sequence number is a conflict", async () => {
    // A held transaction inserts seq 1 (done, so it does not count as live);
    // the start's snapshot cannot see it, computes seq 1 too and waits on the
    // unique index until the holder commits.
    const d = crypto.randomUUID();
    const sql = getDb();
    let commit!: () => void;
    const holding = new Promise<void>((r) => (commit = r));
    let inserted!: () => void;
    const holderInserted = new Promise<void>((r) => (inserted = r));
    const holder = sql.begin(async (tx) => {
      await tx`INSERT INTO wiki_discuss_turns (discussion_id, seq, wiki, rel_path, page_hash, question, bot_name, connector, end_state)
               VALUES (${d}, 1, 'invented', 'plans/ferry.mdx', 'h1', 'Held?', 'ivar', 'claude-sdk', 'done')`;
      inserted();
      await holding;
    });
    await holderInserted;
    const racer = startDiscussTurn(start(d)).catch((e: unknown) => e);
    let waiting = 0;
    for (let i = 0; i < 200 && waiting === 0; i++) {
      const [row] = await sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%INSERT INTO wiki_discuss_turns%'`;
      waiting = row!.n as number;
      if (waiting === 0) await Bun.sleep(10);
    }
    expect(waiting).toBeGreaterThan(0);
    commit();
    await holder;
    expect(await racer).toBeInstanceOf(DiscussTurnConflict);
    expect((await listDiscussTurns(d)).map((t) => t.question)).toEqual(["Held?"]);
  });

  test("the reader-left mark and the card are stored on the turn", async () => {
    const d = crypto.randomUUID();
    const t = await startDiscussTurn(start(d));
    await markDiscussReaderLeft(t.id);
    await setDiscussTurnCard(t.id, "# Ferry card");
    await finishDiscussTurn(t.id, { endState: "timeout", answer: "", error: "timed out after 300000ms" });
    expect(await getDiscussTurn(t.id)).toMatchObject({ readerLeft: true, card: "# Ferry card", endState: "timeout" });
  });

  test("a hand-over to Claude Code is stored once, on that turn only", async () => {
    const d = crypto.randomUUID();
    const a = await startDiscussTurn(start(d));
    await done(a.id);
    const b = await startDiscussTurn(start(d, { question: "And the night route?" }));
    await done(b.id);
    expect((await getDiscussTurn(a.id))?.handedOverAt).toBeNull();
    const first = await markDiscussTurnHandedOver(a.id);
    expect(first?.handedOverAt).toBeNumber();
    // A second hand-over keeps the first moment.
    await Bun.sleep(5);
    expect((await markDiscussTurnHandedOver(a.id))?.handedOverAt).toBe(first!.handedOverAt);
    expect((await getDiscussTurn(b.id))?.handedOverAt).toBeNull();
    expect(await markDiscussTurnHandedOver(crypto.randomUUID())).toBeNull();
  });
});

describe("wiki thread turns (migration 094)", () => {
  async function thread(): Promise<string> {
    const [t] = await getDb()`INSERT INTO threads (user_id, bot_name, name, kind, wiki, rel_path) VALUES ('kari', 'ivar', 'wiki: ferry', 'wiki', 'invented', 'plans/ferry.mdx') RETURNING id`;
    return t!.id as string;
  }
  const threadStart = (threadId: string): DiscussTurnStart => ({
    ...start(threadId),
    threadId,
    userMessage: { userId: "kari", botName: "ivar", content: "> The summer route adds a stop.\n\nWhich stop?" },
  });

  test("the user message is stored in the insert's transaction, and a refused insert stores none", async () => {
    const tid = await thread();
    const a = await startDiscussTurn(threadStart(tid));
    await expect(startDiscussTurn(threadStart(tid))).rejects.toBeInstanceOf(DiscussTurnConflict);
    const msgs = await getDb()`SELECT id, role, source, platform, thread_id FROM messages`;
    expect(msgs).toHaveLength(1);
    expect({ ...msgs[0] }).toEqual({ id: a.userMessageId, role: "user", source: "wiki", platform: "web", thread_id: tid });
    expect((await getDiscussTurn(a.id))!.userMessageId).toBe(a.userMessageId);
  });

  test("the sweep closes an abandoned thread turn with an «(unfinished)» assistant message; the turn coming back rewrites that message", async () => {
    const tid = await thread();
    const a = await startDiscussTurn(threadStart(tid));
    await getDb()`UPDATE wiki_discuss_turns SET heartbeat_at = now() - interval '10 minutes' WHERE id = ${a.id}`;
    expect(await turns.closeAbandonedDiscussTurns(60_000)).toEqual([a.id]);
    const row = (await getDiscussTurn(a.id))!;
    expect(row.endState).toBe("abandoned");
    expect(row.assistantMessageId).not.toBeNull();
    const [m] = await getDb()`SELECT content, role, source FROM messages WHERE id = ${row.assistantMessageId}`;
    expect({ ...m }).toEqual({ content: turns.UNFINISHED_MARK, role: "assistant", source: "wiki" });
    // A sweep again writes nothing more.
    expect(await turns.closeAbandonedDiscussTurns(60_000)).toEqual([]);
    // The stalled turn comes back: its own answer replaces the unfinished one.
    expect(await done(a.id)).toBe(true);
    expect(await turns.storeDiscussAssistantMessage(a.id, "An answer.")).toBe(row.assistantMessageId);
    const all = await getDb()`SELECT content FROM messages WHERE role = 'assistant'`;
    expect(all.map((r) => r.content)).toEqual(["An answer."]);
  });

  test("a one-shot turn (no thread) gets no message from the sweep or the store", async () => {
    const a = await startDiscussTurn(start(crypto.randomUUID()));
    await getDb()`UPDATE wiki_discuss_turns SET heartbeat_at = now() - interval '10 minutes' WHERE id = ${a.id}`;
    expect(await turns.closeAbandonedDiscussTurns(60_000)).toEqual([a.id]);
    expect(await turns.storeDiscussAssistantMessage(a.id, "x")).toBeNull();
    const [n] = await getDb()`SELECT count(*)::int AS n FROM messages`;
    expect(n!.n).toBe(0);
    expect((await turns.listPageOneShotTurns("invented", "plans/ferry.mdx")).map((t) => t.id)).toEqual([a.id]);
  });

  test("a thread's messages read joined to their ledger rows; a deleted message leaves the row with its id cleared", async () => {
    const tid = await thread();
    const a = await startDiscussTurn(threadStart(tid));
    await done(a.id);
    const aid = await turns.storeDiscussAssistantMessage(a.id, "An answer.");
    const read = await turns.listThreadMessagesWithTurns(tid);
    expect(read.map((m) => `${m.role}:${m.turn?.id === a.id}`)).toEqual(["user:true", "assistant:true"]);
    await getDb()`DELETE FROM messages WHERE id = ${aid}`;
    expect((await getDiscussTurn(a.id))!.assistantMessageId).toBeNull();
  });

  test("history not scoped by thread leaves the wiki thread's rows out; the thread's own history keeps them", async () => {
    const tid = await thread();
    await startDiscussTurn(threadStart(tid));
    await getDb()`INSERT INTO messages (user_id, bot_name, role, content, platform) VALUES ('kari', 'ivar', 'user', 'a chat line', 'web')`;
    expect((await getRecentMessages("kari", 20, "ivar")).map((m) => m.text)).toEqual(["a chat line"]);
    expect((await getRecentMessages("kari", 20)).map((m) => m.text)).toEqual(["a chat line"]);
    expect((await getRecentMessages("kari", 20, "ivar", tid, { excludeProactive: true })).map((m) => m.role)).toEqual(["user"]);
  });
});
