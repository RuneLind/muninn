/**
 * The answer store against the real test database (migration 082): append-only
 * versions, the latest-per-answer read, and the unique (answer_id, version)
 * that turns a concurrent second edit into a conflict rather than two version 2s.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { setupTestDb } from "../test/setup-db.ts";
import { getDb } from "./client.ts";
import {
  getLatestWikiAnswerVersion,
  insertWikiAnswerVersion,
  listLatestWikiAnswers,
  listWikiAnswerVersions,
  WikiAnswerVersionConflict,
  type WikiAnswerVersionInput,
} from "./wiki-answers.ts";

setupTestDb();

const author = { userId: "u-synne", oid: "oid-1", navIdent: "X111111", name: "Synne Testdal" };

const input = (over: Partial<WikiAnswerVersionInput> = {}): WikiAnswerVersionInput => ({
  answerId: randomUUID(),
  version: 1,
  wiki: "mimir",
  relPath: "plans/answers.mdx",
  questionId: "O3",
  author,
  choice: "B",
  body: "The page's language.",
  questionHash: "h1",
  ...over,
});

describe("wiki_answers store", () => {
  test("an edit is a new row; the latest read returns it with the version count", async () => {
    const v1 = await insertWikiAnswerVersion(input());
    await insertWikiAnswerVersion(input({ answerId: v1.answerId, version: 2, body: "Edited." }));
    const other = await insertWikiAnswerVersion(input({ questionId: "O4", choice: null, body: "Other." }));

    const latest = await listLatestWikiAnswers("mimir", "plans/answers.mdx");
    expect(latest.map((a) => [a.answerId, a.version, a.versionCount, a.body])).toEqual([
      [v1.answerId, 2, 2, "Edited."],
      [other.answerId, 1, 1, "Other."],
    ]);
    expect(latest[0]!.firstCreatedAt).toBe(v1.createdAt);
    // The first version is still there, untouched.
    const all = await listWikiAnswerVersions([v1.answerId]);
    expect(all.map((v) => [v.version, v.body])).toEqual([
      [2, "Edited."],
      [1, "The page's language."],
    ]);
    expect((await getLatestWikiAnswerVersion(v1.answerId))!.version).toBe(2);
    expect(await getLatestWikiAnswerVersion(randomUUID())).toBeNull();
  });

  test("the read is scoped to one page of one wiki", async () => {
    await insertWikiAnswerVersion(input({ wiki: "mimir", relPath: "plans/a.mdx" }));
    await insertWikiAnswerVersion(input({ wiki: "melosys-kode-wiki", relPath: "plans/a.mdx" }));
    expect((await listLatestWikiAnswers("mimir", "plans/a.mdx")).length).toBe(1);
    expect((await listLatestWikiAnswers("mimir", "plans/b.mdx")).length).toBe(0);
  });

  test("two writers racing for the same next version: one row, one conflict", async () => {
    const v1 = await insertWikiAnswerVersion(input());
    const results = await Promise.allSettled([
      insertWikiAnswerVersion(input({ answerId: v1.answerId, version: 2, body: "first" })),
      insertWikiAnswerVersion(input({ answerId: v1.answerId, version: 2, body: "second" })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected.length).toBe(1);
    expect(rejected[0]!.reason).toBeInstanceOf(WikiAnswerVersionConflict);
    expect((await listWikiAnswerVersions([v1.answerId])).length).toBe(2);
  });

  test("the author's oid and ident are stored; an off-mode row has none", async () => {
    const off = await insertWikiAnswerVersion(
      input({ author: { userId: null, oid: null, navIdent: null, name: "Rune Owner" } }),
    );
    expect(off.author).toEqual({ userId: null, oid: null, navIdent: null, name: "Rune Owner" });
    const on = await insertWikiAnswerVersion(input());
    expect(on.author).toEqual(author);
  });

  test("exportedAt and redactedAt read back from the latest version only", async () => {
    const v1 = await insertWikiAnswerVersion(input());
    await getDb()`UPDATE wiki_answers SET exported_at = now() WHERE answer_id = ${v1.answerId} AND version = 1`;
    expect((await listLatestWikiAnswers("mimir", "plans/answers.mdx"))[0]!.exportedAt).not.toBeNull();
    await insertWikiAnswerVersion(input({ answerId: v1.answerId, version: 2 }));
    // The edit is unexported again: the export reads the LATEST version.
    expect((await listLatestWikiAnswers("mimir", "plans/answers.mdx"))[0]!.exportedAt).toBeNull();
  });

  test("the table refuses a body over 8000 characters and a version below 1", async () => {
    await expect(insertWikiAnswerVersion(input({ body: "x".repeat(8001) }))).rejects.toThrow();
    await expect(insertWikiAnswerVersion(input({ version: 0 }))).rejects.toThrow();
    // 8000 astral characters are 16000 UTF-16 units and still fit: char_length counts characters.
    await insertWikiAnswerVersion(input({ body: "😀".repeat(8000) }));
  });
});
