/**
 * Acceptance for the key-verification post-pass.
 *
 * The four cases the plan names, seeded here so the defence is a test rather than
 * an intention:
 *
 *   · a fabricated key whose PROJECT PREFIX retrieval never surfaced (`TRYGD-99`)
 *     is `unknown` — the case a prefix allow-list would silently drop;
 *   · a key present only in the notes is `notes` (amber), NOT `verified` —
 *     unioning them would bless a key mistyped in a meeting note;
 *   · `UTF-8` is not flagged at all (denylist);
 *   · a key inside a fenced code block is not flagged (fence mask).
 */

import { test, expect, describe, beforeEach } from "bun:test";
import {
  extractJiraKeys,
  indexFromListing,
  verifyJiraKeys,
  __resetJiraKeyIndexForTest,
  JIRA_KEY_DENYLIST,
} from "./verify-keys.ts";
import type { JiraCitation } from "./wire.ts";

const cite = (n: number, docId: string, key?: string): JiraCitation => ({
  n,
  collection: "jira-issues",
  docId,
  title: docId,
  badge: "Jira",
  relevance: 0.9,
  ...(key ? { key } : {}),
});

/** Stand-in for `fetchKnowledgeApi` returning the real listing SHAPE. */
function listing(ids: string[]) {
  return (async () => ({
    documents: ids.map((id) => ({ id, url: `https://jira.adeo.no/browse/${id.split("_")[0]}` })),
  })) as never;
}

/** A listing fetch that fails — the degraded-lookup case. */
const deadHuginn = (async () => {
  throw new Error("connection refused");
}) as never;

beforeEach(() => __resetJiraKeyIndexForTest());

describe("extractJiraKeys", () => {
  test("finds keys and de-dupes in first-seen order", () => {
    expect(extractJiraKeys("MELOSYS-2 then MELOSYS-1 then MELOSYS-2")).toEqual([
      "MELOSYS-2",
      "MELOSYS-1",
    ]);
  });

  test("does NOT flag denylisted abbreviations", () => {
    const text = "Encoding is UTF-8, dates ISO-8601, digest SHA-256, per RFC-2119, over HTTP-2.";
    expect(extractJiraKeys(text)).toEqual([]);
  });

  test("the denylist carries this corpus's own vocabulary, not just generic tech", () => {
    // BUC/SED are advertised in the knowledge MCP's own description.
    expect(JIRA_KEY_DENYLIST.has("BUC")).toBe(true);
    expect(extractJiraKeys("Flyten dekker BUC-02 og SED-01.")).toEqual([]);
  });

  test("skips keys inside a fenced code block", () => {
    const md = [
      "Se MELOSYS-1.",
      "```kotlin",
      'val ticket = "MELOSYS-9999"',
      "```",
      "Og MELOSYS-2.",
    ].join("\n");
    expect(extractJiraKeys(md)).toEqual(["MELOSYS-1", "MELOSYS-2"]);
  });

  test("an UNCLOSED fence does not swallow the rest of the document", () => {
    // CommonMark would run it to EOF; believing that would hide every key below a
    // stray backtick run — the exact failure the wiki side's fence walk is layered
    // against.
    const md = "```\nMELOSYS-1\n\nAnd later MELOSYS-2 is cited.";
    expect(extractJiraKeys(md)).toEqual(["MELOSYS-1", "MELOSYS-2"]);
  });

  test("does not match a key glued to a word", () => {
    expect(extractJiraKeys("xMELOSYS-1")).toEqual([]);
  });
});

describe("indexFromListing", () => {
  test("prefix-matches `<KEY>_<slug>.md` and keeps the url", () => {
    const idx = indexFromListing([
      { id: "MELOSYS-8028_Manglende_innbetaling.md", url: "https://jira.adeo.no/browse/MELOSYS-8028" },
      { id: "not-an-issue.md" },
      { id: 42 },
    ]);
    expect([...idx.keys()]).toEqual(["MELOSYS-8028"]);
    expect(idx.get("MELOSYS-8028")).toBe("https://jira.adeo.no/browse/MELOSYS-8028");
  });

  test("a shorter key cannot claim a longer one's document", () => {
    const idx = indexFromListing([{ id: "MELOSYS-1234_slug.md" }]);
    expect(idx.has("MELOSYS-1")).toBe(false);
    expect(idx.has("MELOSYS-1234")).toBe(true);
  });
});

describe("verifyJiraKeys — the three states", () => {
  const markdown = [
    "## Symptom",
    "Feilen ligner MELOSYS-8028 og henger sammen med MELOSYS-6587.",
    "Hypotese: dette er samme sak som TRYGD-99.",
    "Kodingen er UTF-8.",
    "```",
    "MELOSYS-7777",
    "```",
  ].join("\n");

  const notes = "Fra refinement: se MELOSYS-6587 og MELOSYS-8028 i Jira.";

  test("retrieved ⇒ verified; notes-only ⇒ amber; neither ⇒ unknown", async () => {
    const verdicts = await verifyJiraKeys({
      markdown,
      // Only 8028 was retrieved. 6587 is in the notes only.
      citations: [cite(1, "MELOSYS-8028_slug.md", "MELOSYS-8028")],
      notes,
      knowledgeApiUrl: "http://huginn.test",
      fetchApi: listing(["MELOSYS-8028_slug.md", "MELOSYS-6587_slug.md"]),
    });

    const by = new Map(verdicts.map((v) => [v.key, v]));
    expect([...by.keys()]).toEqual(["MELOSYS-8028", "MELOSYS-6587", "TRYGD-99"]);

    expect(by.get("MELOSYS-8028")!.state).toBe("verified");
    // The notes-only key is AMBER, not verified — even though it exists.
    expect(by.get("MELOSYS-6587")!.state).toBe("notes");
    expect(by.get("MELOSYS-6587")!.resolved).toBe(true);
    // The fabricated key from a prefix retrieval never surfaced.
    expect(by.get("TRYGD-99")!.state).toBe("unknown");
    expect(by.get("TRYGD-99")!.resolved).toBe(false);

    // Neither the denylisted abbreviation nor the fenced key is present at all.
    expect(by.has("UTF-8")).toBe(false);
    expect(by.has("MELOSYS-7777")).toBe(false);
  });

  test("`resolved` is UNDEFINED (never false) when the lookup is unavailable", async () => {
    // "huginn is down" and "this key is fabricated" are opposite conclusions;
    // rendering the first as the second is how a red row stops meaning anything.
    const verdicts = await verifyJiraKeys({
      markdown: "Se TRYGD-99.",
      citations: [],
      notes: "",
      knowledgeApiUrl: "http://huginn.test",
      fetchApi: deadHuginn,
    });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.state).toBe("unknown");
    expect(verdicts[0]!.resolved).toBeUndefined();
  });

  test("an EMPTY listing is treated as unavailable, not as `nothing exists`", async () => {
    const verdicts = await verifyJiraKeys({
      markdown: "Se MELOSYS-8028.",
      citations: [],
      notes: "",
      knowledgeApiUrl: "http://huginn.test",
      fetchApi: listing([]),
    });
    expect(verdicts[0]!.resolved).toBeUndefined();
  });

  test("a UTF-8 in the NOTES cannot turn a UTF-8 in the draft amber", async () => {
    const verdicts = await verifyJiraKeys({
      markdown: "Filen er UTF-8.",
      citations: [],
      notes: "Husk UTF-8.",
      knowledgeApiUrl: "http://huginn.test",
      fetchApi: listing(["MELOSYS-1_a.md"]),
    });
    expect(verdicts).toEqual([]);
  });

  test("carries the retrieved url so `[KEY](url)` can be rendered", async () => {
    const verdicts = await verifyJiraKeys({
      markdown: "Se MELOSYS-8028.",
      citations: [{ ...cite(1, "MELOSYS-8028_slug.md", "MELOSYS-8028"), url: "https://jira.adeo.no/browse/MELOSYS-8028" }],
      notes: "",
      knowledgeApiUrl: "http://huginn.test",
      fetchApi: listing(["MELOSYS-8028_slug.md"]),
    });
    expect(verdicts[0]!.url).toBe("https://jira.adeo.no/browse/MELOSYS-8028");
  });
});
