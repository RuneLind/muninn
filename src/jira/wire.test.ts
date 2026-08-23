/**
 * The two archive-listing helpers that live in the wire module, and the reason
 * they live there rather than beside the page: the DB reader derives a row's
 * title and clamps the caller's limit, the route clamps the query param, and the
 * page renders the result — three callers, one spelling.
 *
 * `parseJiraDraftBody`'s own contract is pinned by the route tests, which assert
 * its sentences verbatim; this file covers only what PR 2 added.
 *
 * Synthetic text only — muninn is a public repo.
 */

import { describe, expect, test } from "bun:test";
import {
  JIRA_ARCHIVE_LIMIT_DEFAULT,
  JIRA_ARCHIVE_LIMIT_MAX,
  clampJiraArchiveLimit,
  jiraDraftTitle,
} from "./wire.ts";

describe("clampJiraArchiveLimit", () => {
  test("absent, blank and unparseable all fall back to the default", () => {
    expect(clampJiraArchiveLimit(undefined)).toBe(JIRA_ARCHIVE_LIMIT_DEFAULT);
    expect(clampJiraArchiveLimit(null)).toBe(JIRA_ARCHIVE_LIMIT_DEFAULT);
    expect(clampJiraArchiveLimit("")).toBe(JIRA_ARCHIVE_LIMIT_DEFAULT);
    expect(clampJiraArchiveLimit("mange")).toBe(JIRA_ARCHIVE_LIMIT_DEFAULT);
  });

  test("bounds are held at both ends", () => {
    expect(clampJiraArchiveLimit("0")).toBe(1);
    expect(clampJiraArchiveLimit("-4")).toBe(1);
    expect(clampJiraArchiveLimit("100000")).toBe(JIRA_ARCHIVE_LIMIT_MAX);
    expect(clampJiraArchiveLimit("7")).toBe(7);
  });

  test("`Number()`, not `parseInt` — the clampIntQuery rule", () => {
    // `parseInt("1e3")` is 1, which answers a request for a thousand rows with
    // one and says nothing about why.
    expect(clampJiraArchiveLimit("1e3")).toBe(JIRA_ARCHIVE_LIMIT_MAX);
    expect(clampJiraArchiveLimit("12.6")).toBe(13);
  });
});

describe("jiraDraftTitle", () => {
  test("a leading `# ` heading is an authored title and wins", () => {
    expect(jiraDraftTitle("# Feil i beregning\n\nnoe tekst")).toBe("Feil i beregning");
  });

  test("a SECTION heading does not — the sentence under it does", () => {
    // The measured case: every shipped template opens on `## Symptom` /
    // `## Problem` / `## Verdi`, so heading-first labels the whole archive with
    // four repeated words.
    expect(jiraDraftTitle("## Symptom\n\nKafka-produsenten sender til feil topic.")).toBe(
      "Kafka-produsenten sender til feil topic.",
    );
    expect(jiraDraftTitle("## Verdi\n\nSaksbehandlere slipper å telle manuelt.")).toBe(
      "Saksbehandlere slipper å telle manuelt.",
    );
  });

  test("no heading at all ⇒ the first line of real prose", () => {
    expect(jiraDraftTitle("Kort beskrivelse av feilen\n\nmer")).toBe("Kort beskrivelse av feilen");
  });

  test("a headings-only draft falls back to its first heading, not to nothing", () => {
    expect(jiraDraftTitle("## Symptom\n\n## Løsning")).toBe("Symptom");
  });

  test("a `# ` further down is NOT treated as the authored title", () => {
    // Only the first line of content can be one; anything later is a section.
    expect(jiraDraftTitle("innledningen forklarer\n\n# Senere overskrift")).toBe(
      "innledningen forklarer",
    );
  });

  test("a `#` inside a fence is not a heading", () => {
    expect(jiraDraftTitle("```\n# ikke en tittel\n```\n\nprosa")).toBe("prosa");
    expect(jiraDraftTitle("~~~\n# ikke en tittel\n~~~\n\nprosa")).toBe("prosa");
  });

  test("inline markup is stripped, not rendered", () => {
    expect(jiraDraftTitle("# **Feil** i `beregning`")).toBe("Feil i beregning");
    expect(jiraDraftTitle("## Symptom\n\nSe [MELOSYS-1](https://example.test/x)")).toBe(
      "Se MELOSYS-1",
    );
  });

  test("nothing to name ⇒ null, so the caller can say so in its own words", () => {
    expect(jiraDraftTitle(null)).toBeNull();
    expect(jiraDraftTitle("")).toBeNull();
    expect(jiraDraftTitle("   \n\n  ")).toBeNull();
  });

  test("a long title is clipped rather than wrapping a whole list row", () => {
    const title = jiraDraftTitle(`# ${"a".repeat(300)}`);
    expect(title).toHaveLength(120);
    expect(title!.endsWith("…")).toBe(true);
  });
});
