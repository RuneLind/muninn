import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isHuginnSearchTool, parseHuginnHits } from "./huginn-hits.ts";

/**
 * Reading huginn's rendered `search_knowledge` result back into hits.
 *
 * **The fixtures are SYNTHETIC — hand-written, never captured.** This repo is
 * public and the corpus behind the melosys bot is not: every key, title, page
 * name and url under `__fixtures__/` is invented (`MELOSYS-101`,
 * `jira.example.invalid`, `confluence.example.invalid`, `entities/Eksempel.md`).
 * What they mirror is the FORMAT, transcribed from huginn's renderer
 * (`mcp_adapter/formatting.render_results` + the adapter's no-hit branch), which
 * is the only thing the parser reads: the `## <title> (NN.N% relevant · band) |
 * updated: <date>` header of full mode, the `N. **<title>** > <section> (NN.N%
 * relevant · band) | <date>` header of brief mode, the
 * `` collection: `x` doc_id: `y` `` anchor, the optional url line, and the
 * `**Graph:**` / `*Weak match …*` / `huginn-trace-url:` chrome around them.
 *
 * That transcription is verified, not eyeballed: all three fixtures were checked
 * byte-identical (2026-08-23) to what `render_results` itself emits when fed
 * invented result dicts — the renderer run locally against made-up payloads, no
 * corpus and no search involved. Re-run that check by hand if huginn's renderer
 * moves; it cannot live here, since it needs huginn's checkout.
 *
 * Both fixtures carry the decoy the parser exists for — a `##` line inside a
 * body or snippet that is not a header — and the mutation each decoy actually
 * catches is named on the test. They were measured, not assumed: see the two
 * decoy tests.
 */

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "__fixtures__", name), "utf-8");

describe("parseHuginnHits — full mode", () => {
  const hits = parseHuginnHits(fixture("huginn-search-full.txt"));

  test("one hit per anchor line, in render order", () => {
    expect(hits).toHaveLength(4);
    expect(hits.map((h) => h.docId)).toEqual([
      "MELOSYS-101_Eksempelsak_om_innlogging.md",
      "Eksempelside om testdata.md",
      "entities/Eksempel.md",
      "entities/Eksempeltjeneste.md",
    ]);
  });

  test("title, url, collection and relevance come off the header + anchor", () => {
    expect(hits[0]).toEqual({
      docId: "MELOSYS-101_Eksempelsak_om_innlogging.md",
      collection: "jira-issues",
      title: "MELOSYS-101 Eksempelsak om innlogging",
      url: "https://jira.example.invalid/browse/MELOSYS-101",
      relevance: 1,
    });
    expect(hits[2]).toEqual({
      docId: "entities/Eksempel.md",
      collection: "nav-wiki",
      title: "Eksempel",
      // nav-wiki pages carry a file:// url; the url line is not http-only.
      url: "file://./huginn-nav/wiki/entities/Eksempel.md",
      relevance: 0.61,
    });
  });

  test("the [UNDER ARBEID] flag is stripped out of the title", () => {
    expect(hits[1]!.title).toBe("Eksempelside om testdata");
    expect(hits[1]!.collection).toBe("melosys-confluence-v3");
    expect(hits[1]!.relevance).toBeCloseTo(0.823, 5);
  });

  test("a bare url inside the PREVIOUS hit's body is not adopted", () => {
    // Hit 3's body ends on a line that is nothing but a url; hit 4 is rendered
    // without one. The url must not slide forward onto hit 4.
    expect(hits[3]!.url).toBeNull();
    expect(hits[3]!.title).toBe("Eksempeltjeneste");
  });

  test("DECOY: a `## Description` line in a Jira body never titles the next hit", () => {
    // Hit 1's body contains `## Description` and `## Løsning` at column 0,
    // between hit 1's anchor and hit 2's real header. Measured against two
    // mutants: dropping the relevance-suffix gate alone leaves this correct
    // (the last `##` before the anchor is still hit 2's own header), and
    // first-wins-instead-of-last-wins alone leaves it correct too (the decoy
    // carries no relevance suffix, so it is not a candidate). Dropping BOTH
    // titles this hit "Description" with relevance 0 — which is exactly the
    // naive parser this module was written to replace.
    expect(hits[1]!.title).toBe("Eksempelside om testdata");
    expect(hits.map((h) => h.title)).not.toContain("Description");
    expect(hits.map((h) => h.title)).not.toContain("Løsning");
  });
});

describe("parseHuginnHits — brief mode", () => {
  const hits = parseHuginnHits(fixture("huginn-search-brief.txt"));

  test("one hit per numbered entry, in render order", () => {
    expect(hits).toHaveLength(3);
    expect(hits.map((h) => h.collection)).toEqual([
      "jira-issues",
      "nav-wiki",
      "melosys-confluence-v3",
    ]);
  });

  test("the bolded title is taken without the ` > <section>` tail", () => {
    expect(hits[0]).toEqual({
      docId: "MELOSYS-101_Eksempelsak_om_innlogging.md",
      collection: "jira-issues",
      title: "MELOSYS-101 Eksempelsak om innlogging",
      url: "https://jira.example.invalid/browse/MELOSYS-101",
      relevance: 1,
    });
    // Section tail AND the wip flag, both outside the bolded title.
    expect(hits[2]!.title).toBe("Eksempelside om testdata");
    expect(hits[2]!.relevance).toBeCloseTo(0.823, 5);
    expect(hits[2]!.url).toBe(
      "https://confluence.example.invalid/display/EKS/Eksempelside+om+testdata",
    );
  });

  test("DECOY: a `## Integrasjoner` line inside a snippet never becomes the title", () => {
    // Entry 2's snippet embeds its own heading at column 0, AFTER the entry's
    // real header and BEFORE its anchor — so the last-`##`-wins rule would take
    // it. The relevance-suffix gate is the only thing that rejects it: measured,
    // dropping that gate alone renames this hit to "Integrasjoner", zeroes its
    // relevance and loses its url (the url line precedes the decoy).
    expect(hits[1]).toEqual({
      docId: "entities/Eksempel.md",
      collection: "nav-wiki",
      title: "Eksempel",
      url: "file://./huginn-nav/wiki/entities/Eksempel.md",
      relevance: 0.61,
    });
  });
});

describe("parseHuginnHits — what it refuses to invent", () => {
  test("a block without a doc_id is skipped, not half-parsed", () => {
    const text = [
      "## Eksempel uten doc_id (91.0% relevant · high) | updated: 2026-03-01",
      "https://eksempel.invalid/uten-doc-id",
      "collection: `nav-wiki`",
      "",
      "## Eksempel med doc_id (70.0% relevant · medium) | updated: 2026-03-02",
      "https://eksempel.invalid/med-doc-id",
      "collection: `nav-wiki` doc_id: `entities/Med.md`",
    ].join("\n");
    const hits = parseHuginnHits(text);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.docId).toBe("entities/Med.md");
    // And the surviving hit keeps its OWN header, not the doc_id-less one's.
    expect(hits[0]!.title).toBe("Eksempel med doc_id");
    expect(hits[0]!.url).toBe("https://eksempel.invalid/med-doc-id");
  });

  test("a repeated doc_id is filed once", () => {
    const anchor = "collection: `nav-wiki` doc_id: `entities/Eksempel.md`";
    expect(parseHuginnHits([anchor, "", anchor].join("\n"))).toHaveLength(1);
  });

  test("a no-hit render parses to no rows", () => {
    expect(parseHuginnHits(fixture("huginn-search-no-hits.txt"))).toEqual([]);
  });

  test("garbage returns [] and never throws", () => {
    for (const junk of [
      "",
      "   ",
      "not a search result at all",
      "# Et dokument\n\nBrødtekst uten anker.",
      "collection: doc_id:",
      "doc_id: `",
      "## (100.0% relevant · high)",
      "1. **** (100.0% relevant · high) | 2026-01-01",
      "{\"results\": [{\"id\": \"x\"}]}",
      // A NUL byte and a lone replacement char, as source escapes so this file
      // stays text: a raw NUL in the fixture would make git treat it as binary.
      "\u0000\uFFFD".repeat(50),
    ]) {
      expect(() => parseHuginnHits(junk)).not.toThrow();
      expect(parseHuginnHits(junk)).toEqual([]);
    }
  });
});

describe("isHuginnSearchTool", () => {
  test("accepts the adapter's tools under every connector's spelling", () => {
    for (const name of [
      "mcp__knowledge__search_knowledge",
      "knowledge-search_knowledge",
      "search_knowledge",
      "search_knowledge (knowledge)",
      "mcp__knowledge__get_document",
    ]) {
      expect(isHuginnSearchTool(name)).toBe(true);
    }
  });

  test("rejects muninn's own tool and everything else", () => {
    // `research_knowledge` persists from its own handler; claiming it here too
    // would file every row twice.
    for (const name of ["", "research_knowledge", "mcp__muninn__research_knowledge", "Read"]) {
      expect(isHuginnSearchTool(name)).toBe(false);
    }
  });
});
