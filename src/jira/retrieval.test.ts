/**
 * Acceptance for the citation helpers — everything that has to be TRUE of a Jira
 * citation whatever produced it.
 *
 * Each of these is a defect this feature shipped once, measured on the live
 * corpus: a key read off a `/browse/<KEY>` url (without it a retrieved issue
 * verified amber and `## Referanser` listed it twice), a badge overwritten
 * because `buildCitations` cannot name these three collections, a title
 * humanized out of the filename huginn serves as `title`, and a url unescaped
 * before it is judged (five real `jira-issues` docs carry `https\://`).
 */

import { test, expect, describe } from "bun:test";
import {
  humanizeJiraTitle,
  isLinkableUrl,
  jiraKeyFor,
  jiraKeyFromDocId,
  normalizeJiraUrl,
  sliceForDepth,
  toJiraCitation,
  type JiraCitationSource,
  JIRA_MAX_SOURCES_BY_DEPTH,
} from "./retrieval.ts";
import { appendReferences } from "./prompt.ts";

/** A `research_citations`-shaped source row — what the thread path seeds from. */
const source = (
  i: number,
  over: Partial<JiraCitationSource> = {},
): JiraCitationSource => ({
  collection: "jira-issues",
  docId: `MELOSYS-${i}_slug.md`,
  title: `Doc ${i}`,
  relevance: 1 - i / 100,
  ...over,
});

const cites = (rows: JiraCitationSource[]) => rows.map((r, i) => toJiraCitation(r, i + 1));

describe("citation helpers", () => {
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
    // Only a JIRA host mints a key: Bitbucket/Stash spell `/browse/<repo>-<n>` too,
    // and an ungated match produced a fabricated `BUILD-12` Jira key from a repo path.
    expect(jiraKeyFor("nav-wiki", "x.md", "https://bitbucket.nav.no/projects/X/repos/y/browse/build-12")).toBeUndefined();
    expect(jiraKeyFor("nav-wiki", "x.md", "https://example.com/browse/MELOSYS-99")).toBeUndefined();
    expect(jiraKeyFor("nav-wiki", "x.md", "https://nav.atlassian.net/browse/MELOSYS-8170?focusedCommentId=1")).toBe("MELOSYS-8170");
    expect(jiraKeyFor("nav-wiki", "x.md", "https://jira.adeo.no/browse/melosys-1")).toBeUndefined();
    // A Confluence page that merely LINKS to an issue is not that issue.
    expect(jiraKeyFor("melosys-confluence-v3", "arkitektur.md", "https://confluence.test/x")).toBeUndefined();
  });

  test("a nav-wiki issue page and its jira-issues twin are ONE Referanser line", () => {
    const rows = cites([
      source(1, {
        docId: "MELOSYS-5677_Ny_flyt.md", title: "MELOSYS-5677_Ny_flyt",
        url: "https://jira.adeo.no/browse/MELOSYS-5677", relevance: 0.9,
      }),
      source(2, {
        collection: "nav-wiki", docId: "sources/jira/MELOSYS-5677.md", title: "MELOSYS-5677",
        url: "https://jira.adeo.no/browse/MELOSYS-5677", relevance: 0.8,
      }),
    ]);
    expect(rows.map((c) => c.key)).toEqual(["MELOSYS-5677", "MELOSYS-5677"]);
    const refs = appendReferences("# Sak\n", rows);
    expect(refs.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1);
  });

  test("toJiraCitation OVERWRITES the badge — the inert-fix trap", () => {
    // `badgeForCollection` (via `buildCitations`) cannot answer for these three:
    // they are in COLLECTION_META but in no /research profile, and RESEARCH_CORPUS
    // is derived from the profiles. Without the overwrite the badge is the raw
    // collection name.
    const out = cites([
      source(1),
      source(2, { collection: "melosys-confluence-v3", docId: "page-2.md" }),
      source(3, { collection: "nav-wiki", docId: "page-3.md" }),
    ]);
    expect(out.map((c) => c.badge)).toEqual(["Jira", "Confluence", "NAV-wiki"]);
    expect(out[0]!.key).toBe("MELOSYS-1");
    expect(out[1]!.key).toBeUndefined();
  });

  test("sliceForDepth narrows `## Referanser` only — Full keeps the whole set", () => {
    const seeded = cites(Array.from({ length: 24 }, (_, i) => source(i + 1)));
    expect(sliceForDepth(seeded, "ingen")).toHaveLength(JIRA_MAX_SOURCES_BY_DEPTH.ingen);
    expect(sliceForDepth(seeded, "skisse")).toHaveLength(JIRA_MAX_SOURCES_BY_DEPTH.skisse);
    expect(sliceForDepth(seeded, "full")).toHaveLength(24);
    // The seeded set itself is untouched — the row keeps the wide hit set.
    expect(seeded).toHaveLength(24);
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

  test("humanizeJiraTitle drops the doc id's `.md` tail", () => {
    // The title IS the filename, extension included — and it is rendered beside
    // the key in `## Referanser`, where a trailing `.md` is noise. Also the
    // fallback title when huginn's `title` is null is the bare doc id.
    expect(
      humanizeJiraTitle("jira-issues", "MELOSYS-8150_Uttrekk_av_medlemskap.md", "MELOSYS-8150"),
    ).toBe("Uttrekk av medlemskap");
    expect(humanizeJiraTitle("jira-issues", "MELOSYS-8150_Uttrekk.md")).toBe(
      "MELOSYS-8150 Uttrekk",
    );
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
    const row = toJiraCitation(
      source(1, { docId: "MELOSYS-1_x.md", title: "MELOSYS-1_x", url: "https\\://jira.adeo.no/browse/MELOSYS-1" }),
      1,
    );
    expect(row.url).toBe("https://jira.adeo.no/browse/MELOSYS-1");
  });
});
