/**
 * `wiki_discuss_turns` (migration 090) against the test database: a turn
 * inserted running and finished once, the discussion's sequence, the one-live-
 * turn rule (sequential and concurrent, and a stale running row), a forced
 * collision on the sequence, the reader-left mark and the card. Invented pages
 * only.
 */
import { describe, expect, test } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { getDb } from "./client.ts";
import {
  DiscussTurnConflict,
  finishDiscussTurn,
  getDiscussTurn,
  listDiscussTurns,
  markDiscussReaderLeft,
  setDiscussTurnCard,
  startDiscussTurn as startTurn,
  type DiscussTurnStart,
} from "./wiki-discuss-turns.ts";

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

  test("a running turn older than the stale bound does not block the discussion", async () => {
    const d = crypto.randomUUID();
    const dead = await startDiscussTurn(start(d));
    await getDb()`UPDATE wiki_discuss_turns SET created_at = now() - ${STALE_MS + 60_000}::double precision * interval '1 millisecond' WHERE id = ${dead.id}`;
    const next = await startDiscussTurn(start(d, { question: "After the crash?" }));
    expect(next.seq).toBe(2);
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
});
