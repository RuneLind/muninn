/**
 * `wiki_discuss_turns` (migration 090) against the test database: a turn
 * inserted running and finished once, the discussion's sequence, a race on
 * the sequence, the reader-left mark and the card. Invented pages only.
 */
import { describe, expect, test } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import {
  DiscussTurnConflict,
  finishDiscussTurn,
  getDiscussTurn,
  listDiscussTurns,
  markDiscussReaderLeft,
  setDiscussTurnCard,
  startDiscussTurn,
  type DiscussTurnStart,
} from "./wiki-discuss-turns.ts";

setupTestDb();

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

  test("turns of a discussion count up; a concurrent insert of the same number is a conflict", async () => {
    const d = crypto.randomUUID();
    const a = await startDiscussTurn(start(d));
    const b = await startDiscussTurn(start(d, { question: "And the night route?" }));
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect((await listDiscussTurns(d)).map((t) => t.question)).toEqual(["Which stop?", "And the night route?"]);
    const e = crypto.randomUUID();
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => startDiscussTurn(start(e))));
    const conflicts = results.filter((r) => r.status === "rejected");
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    for (const c of conflicts) expect((c as PromiseRejectedResult).reason).toBeInstanceOf(DiscussTurnConflict);
    const seqs = (await listDiscussTurns(e)).map((t) => t.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
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
