import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTurnThread, threadCitationRows } from "./thread-citations.ts";
import {
  _resetActiveTurnsForTests,
  popActiveTurn,
  pushActiveTurn,
  runInActiveTurn,
} from "../hivemind/active-turn.ts";
import { isHuginnSearchTool, parseHuginnHits } from "./huginn-hits.ts";

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
    expect(rows).toHaveLength(5);
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

  test("a `get_document` page that quotes the anchor grammar files NOTHING", () => {
    // The whole capture, composed as `captureKnowledgeToolCitations` composes
    // it: name gate → parse → shape. The page is a `render_document` render of
    // a wiki page ABOUT huginn's search output, so its body carries the anchor
    // line verbatim — which the parser, correctly, reads as a hit. The gate is
    // what has to refuse it, and it is refused before the parser ever runs.
    const page = [
      "# Slik ser et søkeresultat ut",
      "file://./huginn-nav/wiki/concepts/Søkeresultat.md",
      "",
      "Hvert treff avsluttes med en ankerlinje:",
      "",
      "## Eksempelside om testdata (82.3% relevant · medium) | updated: 2025-11-02",
      "collection: `melosys-confluence-v3` doc_id: `Eksempelside om testdata.md`",
    ].join("\n");

    // The trap, stated: fed to the parser this page DOES produce a hit.
    expect(parseHuginnHits(page)).toHaveLength(1);

    const toolName = "mcp__knowledge__get_document";
    const hits = isHuginnSearchTool(toolName) ? parseHuginnHits(page) : [];
    expect(threadCitationRows({ botName: "melosys", hits, threadId: "t-4" })).toEqual([]);
  });
});

/**
 * PR A acceptance 1, DB-write half — "zero `research_citations` rows carry a
 * `thread_id` belonging to the other".
 *
 * This is the assertion no frame test can make: the defect is a row written
 * during two SIMULTANEOUS turns, not anything visible on a socket. It is tested
 * on `resolveTurnThread` rather than through a mocked DB because
 * `persistThreadCitations` is fire-and-forget by design, and because mocking
 * `db/research-citations.ts` here would leak across the whole `test:unit` chunk
 * (the `mock.module` note in CLAUDE.md).
 */
describe("resolveTurnThread — which turn a retrieval belongs to", () => {
  test("the async binding wins, even with another turn on top of the stack", () => {
    _resetActiveTurnsForTests();
    // Both people are mid-turn on the same bot. B pushed last, so the LIFO peek
    // — what this used to do, unconditionally — answers B for BOTH of them.
    pushActiveTurn("melosys", "thread-a");
    pushActiveTurn("melosys", "thread-b");

    const inA = runInActiveTurn("melosys", "thread-a", () => resolveTurnThread("melosys"));
    const inB = runInActiveTurn("melosys", "thread-b", () => resolveTurnThread("melosys"));

    expect(inA).toBe("thread-a");
    expect(inB).toBe("thread-b");
    _resetActiveTurnsForTests();
  });

  test("the binding survives the awaits a real tool call is made of", async () => {
    _resetActiveTurnsForTests();
    pushActiveTurn("melosys", "thread-a");
    pushActiveTurn("melosys", "thread-b");

    // The tool-result seam runs deep inside the connector's promise chain, not
    // synchronously under the call. If the store did not propagate across
    // awaits, the whole mechanism would be inert on the only path that uses it.
    const resolved = await runInActiveTurn("melosys", "thread-a", async () => {
      await Bun.sleep(5);
      await Promise.resolve();
      return resolveTurnThread("melosys");
    });

    expect(resolved).toBe("thread-a");
    _resetActiveTurnsForTests();
  });

  test("two interleaved bound turns never see each other", async () => {
    _resetActiveTurnsForTests();
    pushActiveTurn("melosys", "thread-a");
    pushActiveTurn("melosys", "thread-b");

    const [a, b] = await Promise.all([
      runInActiveTurn("melosys", "thread-a", async () => {
        await Bun.sleep(10);
        return resolveTurnThread("melosys");
      }),
      runInActiveTurn("melosys", "thread-b", async () => {
        await Bun.sleep(1);
        return resolveTurnThread("melosys");
      }),
    ]);

    expect([a, b]).toEqual(["thread-a", "thread-b"]);
    _resetActiveTurnsForTests();
  });

  test("out-of-band and unambiguous ⇒ the single turn in flight", () => {
    // muninn's own `research_knowledge` MCP tool: a separate Bun.serve request
    // answering the model's subprocess, so there is no store to inherit. With
    // one turn in flight there is nothing to be wrong about.
    _resetActiveTurnsForTests();
    pushActiveTurn("melosys", "thread-a");
    expect(resolveTurnThread("melosys")).toBe("thread-a");
    _resetActiveTurnsForTests();
  });

  test("out-of-band and ambiguous ⇒ null, so the row is dropped rather than misfiled", () => {
    _resetActiveTurnsForTests();
    pushActiveTurn("melosys", "thread-a");
    pushActiveTurn("melosys", "thread-b");

    expect(resolveTurnThread("melosys")).toBeNull();
    // ...and nothing is written, which is the property that matters.
    expect(threadCitationRows({
      botName: "melosys",
      hits: [{ docId: "d.md", collection: "nav-wiki" }],
      threadId: resolveTurnThread("melosys"),
    })).toEqual([]);

    // Once the other turn finishes, the remaining one is unambiguous again.
    popActiveTurn("melosys", "thread-b");
    expect(resolveTurnThread("melosys")).toBe("thread-a");
    _resetActiveTurnsForTests();
  });

  test("a binding from a DIFFERENT bot is not trusted", () => {
    _resetActiveTurnsForTests();
    pushActiveTurn("jarvis", "thread-j");
    const resolved = runInActiveTurn("melosys", "thread-m", () => resolveTurnThread("jarvis"));
    // jarvis has exactly one turn in flight, so the fallback answers correctly —
    // the point is that melosys's bound thread did not leak into jarvis's rows.
    expect(resolved).toBe("thread-j");
    _resetActiveTurnsForTests();
  });

  test("nothing in flight ⇒ null", () => {
    _resetActiveTurnsForTests();
    expect(resolveTurnThread("melosys")).toBeNull();
  });

  test("concurrency on OTHER bots does not make this bot ambiguous", () => {
    _resetActiveTurnsForTests();
    pushActiveTurn("jarvis", "j-1");
    pushActiveTurn("jarvis", "j-2");
    pushActiveTurn("melosys", "m-1");
    expect(resolveTurnThread("melosys")).toBe("m-1");
    _resetActiveTurnsForTests();
  });
});
