import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { threadCitationRows } from "./thread-citations.ts";
import { parseHuginnHits } from "./huginn-hits.ts";

/**
 * Row shaping for the thread half of `research_citations`.
 *
 * The shaping is tested rather than the write: the write is fire-and-forget by
 * design, and mocking `db/research-citations.ts` in this file would leak across
 * the whole `test:unit` chunk (see the `mock.module` note in CLAUDE.md).
 */
describe("threadCitationRows", () => {
  const hits = [
    {
      docId: "MELOSYS-101_x.md",
      collection: "jira-issues",
      title: "T",
      url: "https://jira.example.invalid/browse/MELOSYS-101",
      relevance: 0.8,
    },
    { docId: "concepts/Eksempelregister.md", collection: "nav-wiki", relevance: 0.4 },
  ];

  test("one row per hit, stamped with the thread and OUR trace id", () => {
    const rows = threadCitationRows({
      botName: "melosys",
      question: "hvordan?",
      traceId: "9f1d8a0e-0000-4000-8000-000000000000",
      hits,
      threadId: "t-1",
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      botName: "melosys",
      threadId: "t-1",
      traceId: "9f1d8a0e-0000-4000-8000-000000000000",
      question: "hvordan?",
      docId: "MELOSYS-101_x.md",
      collection: "jira-issues",
      url: "https://jira.example.invalid/browse/MELOSYS-101",
      title: "T",
      relevance: 0.8,
      // Always false here: the assistant's reply does not exist yet, and unlike
      // /research there are no [n] markers to read back. It is derived later,
      // from the reply itself (`seedThreadCitations`).
      cited: false,
    });
    expect(rows[1]!.title).toBeNull();
    expect(rows[1]!.url).toBeNull();
  });

  test("no active turn ⇒ no rows at all, never an unattributed write", () => {
    expect(threadCitationRows({ botName: "melosys", hits, threadId: null })).toEqual([]);
  });

  test("the huginn tool path files a null question, not a truncated one", () => {
    // The tool-result seam sees only `abbreviateInput`'s 500-char cut of the
    // tool input; a half-query stored as "the question" is worse than none.
    const rows = threadCitationRows({ botName: "melosys", hits, threadId: "t-2" });
    expect(rows[0]!.question).toBeNull();
    expect(rows[0]!.traceId).toBeNull();
  });
});

describe("parsed huginn hits are row-shapeable end to end", () => {
  // The fixture is synthetic — hand-written to huginn's render grammar, never
  // captured from the corpus. See the header of `huginn-hits.test.ts`.
  test("a rendered `search_knowledge` result becomes storable rows", () => {
    const text = readFileSync(
      join(import.meta.dir, "__fixtures__", "huginn-search-full.txt"),
      "utf-8",
    );
    const rows = threadCitationRows({
      botName: "melosys",
      hits: parseHuginnHits(text),
      threadId: "t-3",
    });
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      botName: "melosys",
      threadId: "t-3",
      collection: "jira-issues",
      docId: "MELOSYS-101_Eksempelsak_om_innlogging.md",
      url: "https://jira.example.invalid/browse/MELOSYS-101",
      relevance: 1,
      cited: false,
    });
  });
});
