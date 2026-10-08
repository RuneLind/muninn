/**
 * The answer retention sweep (decision D17) on the real test database: each
 * rule at its boundary, unset windows, the redacted rule, an exported-then-
 * edited answer, an orphan, a per-answer failure, and the races against a
 * concurrent edit and export confirm (two transactions in flight, held open by
 * the seams' hooks, with the waiter seen in `pg_locks` before release).
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { setupTestDb } from "../test/setup-db.ts";
import { getDb } from "./client.ts";
import {
  insertWikiAnswerVersion,
  listWikiAnswerLocations,
  markWikiAnswersExported,
  redactWikiAnswer,
  sweepWikiAnswerRetention,
  WikiAnswerVersionConflict,
  type WikiAnswerVersionInput,
} from "./wiki-answers.ts";

setupTestDb();

const WIKI = "ret-wiki";
const PAGE = "plans/retention.mdx";
const ON = { exportedDays: 30, unexportedDays: 90 };
const OFF = { exportedDays: null, unexportedDays: null };

const version = (answerId: string, v: number, relPath = PAGE): WikiAnswerVersionInput => ({
  answerId,
  version: v,
  wiki: WIKI,
  relPath,
  questionId: "Q1",
  author: { userId: null, oid: null, navIdent: null, name: "Test Person" },
  choice: "A",
  body: `version ${v} text`,
  questionHash: "h",
});

/** An answer with `versions` versions, every one saved `createdDaysAgo` days ago. */
async function answer(createdDaysAgo: number, versions = 1, relPath = PAGE): Promise<string> {
  const id = randomUUID();
  for (let v = 1; v <= versions; v++) await insertWikiAnswerVersion(version(id, v, relPath));
  await getDb()`
    UPDATE wiki_answers SET created_at = now() - make_interval(days => ${createdDaysAgo}) WHERE answer_id = ${id}
  `;
  return id;
}

/** Mark every version of `id` exported `daysAgo` days ago. */
async function exported(id: string, daysAgo: number): Promise<void> {
  await getDb()`
    UPDATE wiki_answers SET exported_at = now() - make_interval(days => ${daysAgo}) WHERE answer_id = ${id}
  `;
}

const survivors = async () =>
  (await getDb()`SELECT DISTINCT answer_id FROM wiki_answers`).map((r) => r.answer_id as string).sort();

const versionsOf = async (id: string) =>
  (await getDb()`SELECT version FROM wiki_answers WHERE answer_id = ${id} ORDER BY version`).map((r) => r.version);

describe("sweepWikiAnswerRetention rules", () => {
  test("exported: 31 days after exported_at deletes every version; 29 days keeps it", async () => {
    const old = await answer(200, 3);
    await exported(old, 31);
    const recent = await answer(200, 2);
    await exported(recent, 29);

    expect(await sweepWikiAnswerRetention(ON)).toEqual({ exported: 1, unexported: 0, redacted: 0, failed: 0 });
    expect(await survivors()).toEqual([recent]);
    expect(await versionsOf(recent)).toEqual([1, 2]);
  });

  test("unexported: 91 days after the latest version deletes; 89 days keeps", async () => {
    const old = await answer(91, 2);
    const recent = await answer(89);
    expect(await sweepWikiAnswerRetention(ON)).toEqual({ exported: 0, unexported: 1, redacted: 0, failed: 0 });
    expect(await survivors()).toEqual([recent]);
  });

  test("an answer exported and then edited is judged unexported, from its latest version", async () => {
    const id = await answer(200);
    await exported(id, 100);
    await insertWikiAnswerVersion(version(id, 2)); // saved now, not exported
    expect(await sweepWikiAnswerRetention(ON)).toEqual({ exported: 0, unexported: 0, redacted: 0, failed: 0 });
    expect(await versionsOf(id)).toEqual([1, 2]);

    // The same answer once its latest version is 91 days old: unexported rule.
    await getDb()`UPDATE wiki_answers SET created_at = now() - interval '91 days' WHERE answer_id = ${id}`;
    expect(await sweepWikiAnswerRetention(ON)).toEqual({ exported: 0, unexported: 1, redacted: 0, failed: 0 });
    expect(await survivors()).toEqual([]);
  });

  test("a redacted answer is deleted at the next sweep, whatever its age", async () => {
    const id = await answer(0, 2);
    await redactWikiAnswer(id);
    const kept = await answer(0);
    expect(await sweepWikiAnswerRetention(ON)).toEqual({ exported: 0, unexported: 0, redacted: 1, failed: 0 });
    expect(await survivors()).toEqual([kept]);
  });

  test("the redacted rule runs when only one window is set", async () => {
    const id = await answer(0);
    await redactWikiAnswer(id);
    expect(await sweepWikiAnswerRetention({ exportedDays: null, unexportedDays: 90 })).toMatchObject({ redacted: 1, failed: 0 });
    expect(await survivors()).toEqual([]);
  });

  test("each age rule runs only when its own window is set", async () => {
    const exp = await answer(400);
    await exported(exp, 300);
    const unexp = await answer(400);

    expect(await sweepWikiAnswerRetention({ exportedDays: null, unexportedDays: 90 })).toEqual({
      exported: 0,
      unexported: 1,
      redacted: 0,
      failed: 0,
    });
    expect(await survivors()).toEqual([exp]);
    expect(await sweepWikiAnswerRetention({ exportedDays: 30, unexportedDays: null })).toEqual({
      exported: 1,
      unexported: 0,
      redacted: 0,
      failed: 0,
    });
    expect(await survivors()).toEqual([]);
    void unexp;
  });

  test("both windows unset: nothing is deleted, not even a redacted answer", async () => {
    const a = await answer(400);
    await exported(a, 300);
    const b = await answer(400);
    const c = await answer(0);
    await redactWikiAnswer(c);
    expect(await sweepWikiAnswerRetention(OFF)).toEqual({ exported: 0, unexported: 0, redacted: 0, failed: 0 });
    expect(await survivors()).toEqual([a, b, c].sort());
  });

  test("an orphan (its page gone) falls under the same rules; the orphan list shrinks with it", async () => {
    const orphanOld = await answer(91, 1, "plans/removed-page.mdx");
    const orphanNew = await answer(10, 1, "plans/removed-page.mdx");
    const live = await answer(10);
    const before = (await listWikiAnswerLocations(WIKI)).map((l) => l.answerId).sort();
    expect(before).toEqual([orphanOld, orphanNew, live].sort());

    expect(await sweepWikiAnswerRetention(ON)).toEqual({ exported: 0, unexported: 1, redacted: 0, failed: 0 });
    const after = (await listWikiAnswerLocations(WIKI)).map((l) => l.answerId).sort();
    expect(after).toEqual([orphanNew, live].sort());
  });

  test("one answer whose transaction fails is counted and skipped; the run goes on", async () => {
    const bad = await answer(91);
    const good = await answer(91);
    const counts = await sweepWikiAnswerRetention(ON, Date.now(), {
      afterRecheck: async (answerId) => {
        if (answerId === bad) throw new Error("synthetic failure");
      },
    });
    expect(await survivors()).toEqual([bad]);
    expect(counts).toEqual({ exported: 0, unexported: 1, redacted: 0, failed: 1 });
    void good;
  });

  test("an export after a sweep still marks what survived, and only that", async () => {
    const gone = await answer(91);
    const kept = await answer(10, 2);
    await sweepWikiAnswerRetention(ON);
    expect(await survivors()).toEqual([kept]);
    // The page's confirm names both; only the surviving answer's rows exist to mark.
    expect(await markWikiAnswersExported(WIKI, PAGE, [[gone, 1], [kept, 2]])).toBe(2);
    expect(await listWikiAnswerLocations(WIKI)).toEqual([]);
  });
});

/** A promise the test releases by hand, plus one that resolves when the held
 *  transaction has reached its hook. */
function holdPoint() {
  let release!: () => void;
  let reached!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const atHook = new Promise<void>((r) => (reached = r));
  return { release, atHook, hook: async () => (reached(), await released) };
}

/** Wait until some transaction in this database is blocked on an advisory
 *  lock (the per-answer lock), or until `stop()` says the race is over. True
 *  when a waiter was seen. Throws after 5 s: a race test that never reached
 *  the lock exercised nothing. */
async function advisoryWaiter(stop: () => boolean = () => false): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (stop()) return false;
    const [row] = await getDb()`
      SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
    `;
    if (row!.n > 0) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("no transaction ever waited on the per-answer lock");
}

describe("sweep against a concurrent edit: the whole answer or nothing", () => {
  test("an edit holding the lock with its version inserted wins: the sweep re-checks and keeps every version", async () => {
    const id = await answer(91);

    const hold = holdPoint();
    const edit = insertWikiAnswerVersion(version(id, 2), { beforeCommit: hold.hook });
    await hold.atHook;

    const sweep = sweepWikiAnswerRetention(ON);
    sweep.catch(() => {});
    // The sweep picked the answer (version 1 is 91 days old) and is now blocked
    // on the lock: pg_locks shows it waiting, so the re-check is what decides.
    await advisoryWaiter().finally(() => hold.release());

    expect((await edit).version).toBe(2);
    await sweep;
    // The outcome first: never a lone version 2 with version 1 deleted.
    expect(await versionsOf(id)).toEqual([1, 2]);
    expect(await sweep).toEqual({ exported: 0, unexported: 0, redacted: 0, failed: 0 });
  });

  test("a sweep holding the lock after its delete wins: the waiting edit is refused, nothing lands", async () => {
    const id = await answer(91);

    const hold = holdPoint();
    const sweep = sweepWikiAnswerRetention(ON, Date.now(), { beforeCommit: hold.hook });
    await hold.atHook;

    const edit = insertWikiAnswerVersion(version(id, 2));
    edit.catch(() => {});
    await advisoryWaiter().finally(() => hold.release());

    const err = await edit.then(
      () => null,
      (e: unknown) => e,
    );
    await sweep;
    // The outcome first: never a lone version 2 after the sweep deleted version 1.
    expect(await versionsOf(id)).toEqual([]);
    expect(await sweep).toEqual({ exported: 0, unexported: 1, redacted: 0, failed: 0 });
    // The answer is gone, not changed: the route answers 404 unknown_answer, not 409.
    expect(err).not.toBeInstanceOf(WikiAnswerVersionConflict);
    expect((err as Error | null)?.constructor.name).toBe("WikiAnswerGone");
  });

  test("an export confirm landing between the sweep's re-check and its delete waits for the sweep, and marks nothing", async () => {
    const id = await answer(91);

    const hold = holdPoint();
    const sweep = sweepWikiAnswerRetention(ON, Date.now(), { afterRecheck: hold.hook });
    await hold.atHook;

    let confirmSettled = false;
    const confirm = markWikiAnswersExported(WIKI, PAGE, [[id, 1]]).finally(() => (confirmSettled = true));
    confirm.catch(() => {});
    const waited = await advisoryWaiter(() => confirmSettled).finally(() => hold.release());

    const marked = await confirm;
    const counts = await sweep;
    // The outcome first: a confirm that says it marked the answer while the
    // sweep deletes it anyway (and counts it unexported) is the defect.
    expect({ marked, left: await versionsOf(id) }).toEqual({ marked: 0, left: [] });
    expect(counts).toEqual({ exported: 0, unexported: 1, redacted: 0, failed: 0 });
    expect(waited).toBe(true);
  });
});
