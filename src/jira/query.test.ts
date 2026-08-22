/**
 * Acceptance for the notes → one-question condenser and the retrieval helpers.
 *
 * The failure this module exists to prevent is concrete: `decomposeQuestion`'s
 * documented failure mode is PASSTHROUGH of the original string, straight into a
 * `?q=` URL parameter. So the assertions that matter are the BOUNDS — every
 * degrade path must still produce something short.
 */

import { test, expect, describe } from "bun:test";
import {
  buildJiraRetrievalQuestion,
  fallbackRetrievalQuestion,
  normalizeRetrievalQuestion,
  JIRA_QUERY_MAX,
} from "./query.ts";
import {
  applyExclusions,
  humanizeJiraTitle,
  isLinkableUrl,
  jiraKeyFromDocId,
  sliceForDepth,
  toJiraCitations,
  JIRA_MAX_SOURCES_BY_DEPTH,
  JIRA_STORED_MAX_SOURCES,
} from "./retrieval.ts";
import type { ResearchHit } from "../ai/research-knowledge.ts";
import type { JiraCitation } from "./wire.ts";

const haikuOk = (text: string) =>
  (async () => ({ result: text, inputTokens: 1, outputTokens: 1, model: "haiku" })) as never;
const haikuThrows = (async () => {
  throw new Error("no auth");
}) as never;

const NOTES = "Vi diskuterte årsavregning av trygdeavgift og hvordan MELOSYS-5677 henger sammen.";

describe("buildJiraRetrievalQuestion", () => {
  test("uses the model's condensed question", async () => {
    const r = await buildJiraRetrievalQuestion({
      notes: NOTES, botName: "melosys", haiku: haikuOk("Hvordan beregnes årsavregning av trygdeavgift?"),
    });
    expect(r.question).toBe("Hvordan beregnes årsavregning av trygdeavgift?");
    expect(r.degraded).toBe(false);
  });

  test("a Haiku failure degrades to a BOUNDED clip, never to the raw notes", async () => {
    const huge = "x".repeat(10_000);
    const r = await buildJiraRetrievalQuestion({ notes: huge, botName: "melosys", haiku: haikuThrows });
    expect(r.degraded).toBe(true);
    expect(r.question.length).toBeLessThanOrEqual(JIRA_QUERY_MAX);
  });

  test("an EMPTY answer degrades too", async () => {
    const r = await buildJiraRetrievalQuestion({ notes: NOTES, botName: "melosys", haiku: haikuOk("   ") });
    expect(r.degraded).toBe(true);
    expect(r.question).toBe(fallbackRetrievalQuestion(NOTES));
  });

  test("a model that echoes the whole note back is CLAMPED, not passed through", async () => {
    const huge = "y".repeat(10_000);
    const r = await buildJiraRetrievalQuestion({ notes: huge, botName: "melosys", haiku: haikuOk(huge) });
    expect(r.question.length).toBeLessThanOrEqual(JIRA_QUERY_MAX);
  });
});

describe("normalizeRetrievalQuestion", () => {
  test("strips the shapes a model reaches for despite the instruction", () => {
    expect(normalizeRetrievalQuestion('"Hva er lovvalg?"')).toBe("Hva er lovvalg?");
    expect(normalizeRetrievalQuestion("Spørsmål: Hva er lovvalg?")).toBe("Hva er lovvalg?");
    expect(normalizeRetrievalQuestion("- Hva er lovvalg?")).toBe("Hva er lovvalg?");
    expect(normalizeRetrievalQuestion("«Hva er lovvalg?»")).toBe("Hva er lovvalg?");
  });

  test("keeps only the first line — a rationale goes on line 2", () => {
    expect(normalizeRetrievalQuestion("Hva er lovvalg?\n\nBegrunnelse: ...")).toBe("Hva er lovvalg?");
  });
});

describe("citation helpers", () => {
  const hit = (i: number, collection = "jira-issues"): ResearchHit => ({
    collection,
    id: collection === "jira-issues" ? `MELOSYS-${i}_slug.md` : `page-${i}.md`,
    title: `Doc ${i}`,
    relevance: 1 - i / 100,
    viaSubQuestion: ["q"],
  });

  test("jiraKeyFromDocId only fires on the jira-issues collection", () => {
    expect(jiraKeyFromDocId("jira-issues", "MELOSYS-8028_Manglende.md")).toBe("MELOSYS-8028");
    // A Confluence page has no key; inventing one would put a broken link in
    // `## Referanser`.
    expect(jiraKeyFromDocId("melosys-confluence-v3", "MELOSYS-8028_x.md")).toBeUndefined();
    expect(jiraKeyFromDocId("jira-issues", "readme.md")).toBeUndefined();
  });

  test("toJiraCitations OVERWRITES the badge — the inert-fix trap", () => {
    // `badgeForCollection` (via `buildCitations`) cannot answer for these three:
    // they are in COLLECTION_META but in no /research profile, and RESEARCH_CORPUS
    // is derived from the profiles. Without the overwrite the badge is the raw
    // collection name.
    const out = toJiraCitations([hit(1), hit(2, "melosys-confluence-v3"), hit(3, "nav-wiki")]);
    expect(out.map((c) => c.badge)).toEqual(["Jira", "Confluence", "NAV-wiki"]);
    expect(out[0]!.key).toBe("MELOSYS-1");
    expect(out[1]!.key).toBeUndefined();
  });

  test("stores at most JIRA_STORED_MAX_SOURCES, 1-based", () => {
    const out = toJiraCitations(Array.from({ length: 40 }, (_, i) => hit(i + 1)));
    expect(out).toHaveLength(JIRA_STORED_MAX_SOURCES);
    expect(out[0]!.n).toBe(1);
    expect(out.at(-1)!.n).toBe(JIRA_STORED_MAX_SOURCES);
  });

  test("applyExclusions drops AND renumbers — otherwise the draft cites gaps", () => {
    const stored: JiraCitation[] = toJiraCitations([hit(1), hit(2), hit(3)]);
    const kept = applyExclusions(stored, ["MELOSYS-2_slug.md"]);
    expect(kept.map((c) => c.docId)).toEqual(["MELOSYS-1_slug.md", "MELOSYS-3_slug.md"]);
    expect(kept.map((c) => c.n)).toEqual([1, 2]);
  });

  test("sliceForDepth narrows the PROMPT only — Full gets the whole stored set", () => {
    const stored = toJiraCitations(Array.from({ length: 24 }, (_, i) => hit(i + 1)));
    expect(sliceForDepth(stored, "ingen")).toHaveLength(JIRA_MAX_SOURCES_BY_DEPTH.ingen);
    expect(sliceForDepth(stored, "skisse")).toHaveLength(JIRA_MAX_SOURCES_BY_DEPTH.skisse);
    expect(sliceForDepth(stored, "full")).toHaveLength(24);
    // The stored set itself is untouched, which is why PR 2's toggle column does
    // not resize when the reader changes depth.
    expect(stored).toHaveLength(24);
  });
});

describe("what the live corpus actually returns", () => {
  test("humanizeJiraTitle strips the key prefix and the underscores", () => {
    // Measured: huginn's `title` for a jira-issues doc IS the filename.
    expect(
      humanizeJiraTitle(
        "jira-issues",
        "MELOSYS-6528_Ny_flyt_steg1_Foreløpig_fakturert_trygdeavgift",
        "MELOSYS-6528",
      ),
    ).toBe("Ny flyt steg1 Foreløpig fakturert trygdeavgift");
  });

  test("humanizeJiraTitle leaves other collections' real prose alone", () => {
    expect(humanizeJiraTitle("nav-wiki", "Pensjonister og trygdeavgift")).toBe(
      "Pensjonister og trygdeavgift",
    );
    expect(humanizeJiraTitle("melosys-confluence-v3", "Mapping fra Melosys til MEDL")).toBe(
      "Mapping fra Melosys til MEDL",
    );
  });

  test("isLinkableUrl rejects the `file://` paths nav-wiki documents carry", () => {
    // Pasted into Jira a bare URL becomes a smart-link card, so a file:// href is
    // a visibly broken card. Such a source renders as plain text instead.
    expect(isLinkableUrl("file://./huginn-nav/wiki/entities/MEDL.md")).toBe(false);
    expect(isLinkableUrl(undefined)).toBe(false);
    expect(isLinkableUrl("https://jira.adeo.no/browse/MELOSYS-1")).toBe(true);
  });
});
