/**
 * Redact against edit, on the REAL test database with two transactions in
 * flight at once (answer cards PR 5). The write seams expose a `beforeCommit`
 * hook, so a test can hold one transaction open after its last statement and
 * watch what the other does meanwhile.
 *
 * The two interleavings the per-answer lock exists for:
 *  (a) a redact holds the lock → an edit waits → once the redact commits, the
 *      edit is refused as redacted, so no unredacted version lands after it;
 *  (b) an edit holds the lock with its new version inserted → a redact waits →
 *      once the edit commits, the redact covers that version too. A redact
 *      whose UPDATE snapshot predated the edit's commit would miss it.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { setupTestDb } from "../test/setup-db.ts";
import { getDb } from "./client.ts";
import {
  insertWikiAnswerVersion,
  redactWikiAnswer,
  WikiAnswerRedacted,
  type WikiAnswerVersionInput,
} from "./wiki-answers.ts";

setupTestDb();

const version = (answerId: string, v: number): WikiAnswerVersionInput => ({
  answerId,
  version: v,
  wiki: "race-wiki",
  relPath: "plans/race.mdx",
  questionId: "Q1",
  author: { userId: "u-test", oid: null, navIdent: null, name: "Test Person" },
  choice: "A",
  body: `version ${v} text`,
  questionHash: "h",
});

/** A promise the test releases by hand, plus one that resolves when the held
 *  transaction has reached its hook. */
function holdPoint() {
  let release!: () => void;
  let reached!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const atHook = new Promise<void>((r) => (reached = r));
  return {
    release,
    atHook,
    hook: async () => {
      reached();
      await released;
    },
  };
}

/** Wait until the held write reaches its hook — or surface the error it threw
 *  before getting there, rather than waiting out the test's own timeout. */
async function reachedHook(hold: { atHook: Promise<void> }, write: Promise<unknown>): Promise<void> {
  await Promise.race([
    hold.atHook,
    write.then(() => {
      throw new Error("the held write settled without reaching its hook");
    }),
  ]);
}

/** "settled" when `p` settles within `ms`, else "pending". */
async function stateAfter(p: Promise<unknown>, ms: number): Promise<"settled" | "pending"> {
  return Promise.race([
    p.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    new Promise<"pending">((r) => setTimeout(() => r("pending"), ms)),
  ]);
}

const rowsOf = (answerId: string) =>
  getDb()`SELECT version, body, choice, redacted_at FROM wiki_answers WHERE answer_id = ${answerId} ORDER BY version`;

describe("redact and edit serialize per answer", () => {
  test("(a) a redact holding the lock makes a concurrent edit wait, and the edit is then refused", async () => {
    const id = randomUUID();
    await insertWikiAnswerVersion(version(id, 1));

    const hold = holdPoint();
    const redact = redactWikiAnswer(id, { beforeCommit: hold.hook });
    await reachedHook(hold, redact);

    const edit = insertWikiAnswerVersion(version(id, 2));
    edit.catch(() => {});
    // Released whatever the assertion says: a held transaction would block
    // the next test's TRUNCATE.
    const waited = await stateAfter(edit, 400).finally(() => hold.release());
    expect(waited).toBe("pending");

    expect(await redact).toMatchObject({ versions: 1, alreadyRedacted: false });
    await expect(edit).rejects.toBeInstanceOf(WikiAnswerRedacted);

    const rows = await rowsOf(id);
    expect(rows.map((r) => r.version)).toEqual([1]);
    expect(rows.every((r) => r.redacted_at !== null && r.body === "" && r.choice === null)).toBe(true);
  });

  test("(a) with the edit spelling the id in UPPERCASE: the same lock, so the edit still waits and is refused", async () => {
    const id = randomUUID();
    await insertWikiAnswerVersion(version(id, 1));

    const hold = holdPoint();
    const redact = redactWikiAnswer(id, { beforeCommit: hold.hook });
    await reachedHook(hold, redact);

    const edit = insertWikiAnswerVersion(version(id.toUpperCase(), 2));
    edit.catch(() => {});
    const waited = await stateAfter(edit, 400).finally(() => hold.release());
    expect(waited).toBe("pending");

    expect(await redact).toMatchObject({ versions: 1, alreadyRedacted: false });
    await expect(edit).rejects.toBeInstanceOf(WikiAnswerRedacted);
    expect((await rowsOf(id)).map((r) => r.version)).toEqual([1]);
  });

  test("(b) an edit holding the lock with its version inserted makes a redact wait, and the redact covers it", async () => {
    const id = randomUUID();
    await insertWikiAnswerVersion(version(id, 1));

    const hold = holdPoint();
    const edit = insertWikiAnswerVersion(version(id, 2), { beforeCommit: hold.hook });
    await reachedHook(hold, edit);

    const redact = redactWikiAnswer(id);
    redact.catch(() => {});
    const waited = await stateAfter(redact, 400).finally(() => hold.release());
    expect(waited).toBe("pending");

    expect((await edit).version).toBe(2);
    expect(await redact).toMatchObject({ versions: 2, alreadyRedacted: false });

    const rows = await rowsOf(id);
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(rows.every((r) => r.redacted_at !== null && r.body === "" && r.choice === null)).toBe(true);
  });
});

describe("redactWikiAnswer", () => {
  test("an unknown answer is null and writes nothing", async () => {
    expect(await redactWikiAnswer(randomUUID())).toBeNull();
  });

  test("a second redact is idempotent and keeps the first redacted_at", async () => {
    const id = randomUUID();
    await insertWikiAnswerVersion(version(id, 1));
    const first = await redactWikiAnswer(id);
    const second = await redactWikiAnswer(id);
    expect(first).toMatchObject({ versions: 1, alreadyRedacted: false });
    expect(second).toMatchObject({ versions: 1, alreadyRedacted: true, redactedAt: first!.redactedAt });
  });

  test("an edit after a redact is refused, even when nothing else is in flight", async () => {
    const id = randomUUID();
    await insertWikiAnswerVersion(version(id, 1));
    await redactWikiAnswer(id);
    await expect(insertWikiAnswerVersion(version(id, 2))).rejects.toBeInstanceOf(WikiAnswerRedacted);
  });
});
