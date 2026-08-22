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
  jiraKeyFor,
  jiraKeyFromDocId,
  sliceForDepth,
  toJiraCitations,
  JIRA_MAX_SOURCES_BY_DEPTH,
  JIRA_STORED_MAX_SOURCES,
} from "./retrieval.ts";
import { appendReferences } from "./prompt.ts";
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

  test("jiraKeyFor reads the key off a /browse/ url in ANY collection", () => {
    // The real nav-wiki shape, measured on the live corpus: the wiki carries a
    // page PER ISSUE under `sources/jira/`, whose url is the issue itself. The
    // doc id gives nothing away outside `jira-issues`, so retrieval surfaced the
    // issue while the verdict stayed amber `notes` — "the reader wrote it, we
    // never retrieved it" — about an issue that had just been retrieved.
    expect(jiraKeyFor("nav-wiki", "sources/jira/MELOSYS-5677.md", "https://jira.adeo.no/browse/MELOSYS-5677"))
      .toBe("MELOSYS-5677");
    // The doc-id rule still wins where it applies, and still only there.
    expect(jiraKeyFor("jira-issues", "MELOSYS-8028_Manglende.md")).toBe("MELOSYS-8028");
    expect(jiraKeyFor("nav-wiki", "entities/MEDL.md", "file://./huginn-nav/wiki/entities/MEDL.md"))
      .toBeUndefined();
    // A Confluence page that merely LINKS to an issue is not that issue.
    expect(jiraKeyFor("melosys-confluence-v3", "arkitektur.md", "https://confluence.test/x")).toBeUndefined();
  });

  test("a nav-wiki issue page and its jira-issues twin are ONE Referanser line", () => {
    const cites = toJiraCitations([
      {
        collection: "jira-issues", id: "MELOSYS-5677_Ny_flyt.md", title: "MELOSYS-5677_Ny_flyt",
        url: "https://jira.adeo.no/browse/MELOSYS-5677", relevance: 0.9, viaSubQuestion: ["q"],
      },
      {
        collection: "nav-wiki", id: "sources/jira/MELOSYS-5677.md", title: "MELOSYS-5677",
        url: "https://jira.adeo.no/browse/MELOSYS-5677", relevance: 0.8, viaSubQuestion: ["q"],
      },
    ] as unknown as ResearchHit[]);
    expect(cites.map((c) => c.key)).toEqual(["MELOSYS-5677", "MELOSYS-5677"]);
    const refs = appendReferences("# Sak\n", cites);
    expect(refs.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1);
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

// ── The echo check, the url normalization and the full-document budget ───────

import { normalizeJiraUrl } from "./retrieval.ts";

describe("an echoed question is a degrade, not a condensation", () => {
  test("the notes handed back verbatim fall back to the bounded question", async () => {
    const long = `${NOTES} `.repeat(20);
    const r = await buildJiraRetrievalQuestion({
      notes: long,
      botName: "melosys",
      haiku: haikuOk(long),
    });
    expect(r.degraded).toBe(true);
    expect(r.question.length).toBeLessThanOrEqual(JIRA_QUERY_MAX);
  });

  test("a question that merely STARTS with the raw material is an echo too", async () => {
    const r = await buildJiraRetrievalQuestion({
      notes: NOTES,
      botName: "melosys",
      haiku: haikuOk(`${NOTES} Hva er årsaken?`),
    });
    expect(r.degraded).toBe(true);
  });

  test("a condensation that QUOTES the note's opening sentence is not an echo", async () => {
    // The reported false positive: a good question that opens by quoting the
    // refinement's first sentence verbatim (well past the 80-char floor) and then
    // asks its own thing. The old prefix test flagged it, and the fallback it
    // degraded to — the first 400 chars of the note — is MORE passthrough-shaped
    // than the question it threw away.
    const notes = [
      "Årsavregning av trygdeavgift feiler når saken allerede er fakturert i faktureringskomponenten.",
      "Vi gikk gjennom loggene og fant at avstemmingen kjører to ganger.",
      "Ligner MELOSYS-5677, men der var det manuell fakturering.",
      "Neste steg: sjekke om trygdeavgiftberegningen kalles på nytt ved reberegning.",
    ].join(" ");
    // 93 shared leading characters — past the 80-char floor — but only 31% of the
    // notes and 53% of the question. It reproduces neither side.
    const q =
      "Årsavregning av trygdeavgift feiler når saken allerede er fakturert i faktureringskomponenten — " +
      "hvordan henger avstemmingen sammen med reberegning, og hva gjorde MELOSYS-5677?";
    const r = await buildJiraRetrievalQuestion({ notes, botName: "melosys", haiku: haikuOk(q) });
    expect(r.degraded).toBe(false);
    expect(r.question).toBe(q);
  });

  test("a real condensation is not mistaken for an echo", async () => {
    const r = await buildJiraRetrievalQuestion({
      notes: NOTES,
      botName: "melosys",
      haiku: haikuOk("Hvordan beregnes årsavregning av trygdeavgift, og hva gjør faktureringskomponenten?"),
    });
    expect(r.degraded).toBe(false);
  });
});

describe("normalizeJiraUrl", () => {
  test("unescapes the `https\\://` five real jira-issues docs carry", () => {
    expect(normalizeJiraUrl("https\\://jira.adeo.no/browse/MELOSYS-1")).toBe(
      "https://jira.adeo.no/browse/MELOSYS-1",
    );
  });
  test("still drops a non-http url", () => {
    expect(normalizeJiraUrl("file://./huginn-nav/wiki/entities/MEDL.md")).toBeUndefined();
    expect(normalizeJiraUrl(undefined)).toBeUndefined();
  });
  test("an escaped url survives all the way onto the citation row", () => {
    const hits = [{
      collection: "jira-issues",
      id: "MELOSYS-1_x.md",
      title: "MELOSYS-1_x",
      url: "https\\://jira.adeo.no/browse/MELOSYS-1",
      relevance: 0.9,
      viaSubQuestion: ["q"],
    }] as unknown as ResearchHit[];
    expect(toJiraCitations(hits)[0]!.url).toBe("https://jira.adeo.no/browse/MELOSYS-1");
  });
});
