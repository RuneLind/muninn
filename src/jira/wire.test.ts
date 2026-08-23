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
  JIRA_TITLE_SCAN_CHARS,
  clampJiraArchiveLimit,
  depthLabel,
  jiraArchiveUrl,
  jiraDraftTitle,
  jiraDraftUrl,
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

describe("jiraDraftTitle — hygiene", () => {
  test("a leading block marker is not part of the name", () => {
    // Measured on real rows: a draft opening on a task-list item titled the
    // whole archive "- [ ] oppgave". The marker is markdown syntax, not text.
    expect(jiraDraftTitle("- [ ] Rydd opp i avgiftsberegningen")).toBe(
      "Rydd opp i avgiftsberegningen",
    );
    expect(jiraDraftTitle("- Punkt uten avkryssing")).toBe("Punkt uten avkryssing");
    expect(jiraDraftTitle("* Stjernepunkt")).toBe("Stjernepunkt");
    expect(jiraDraftTitle("1. Første steg")).toBe("Første steg");
    expect(jiraDraftTitle("> Sitat som åpner utkastet")).toBe("Sitat som åpner utkastet");
    expect(jiraDraftTitle("| Kolonne | Verdi |")).toBe("Kolonne | Verdi |");
    // Stacked markers unwind, and a line that is ONLY markers names nothing.
    expect(jiraDraftTitle("> - [x] Gjort\n")).toBe("Gjort");
    expect(jiraDraftTitle("- \n\nProsa etterpå")).toBe("Prosa etterpå");
  });

  test("a marker only strips when a marker is what it is", () => {
    // `>` and `|` used to strip with no whitespace behind them, so a draft
    // opening on a comparison ate its own first character: ">=100 saker feiler"
    // was titled "=100 saker feiler" and "|x| er absoluttverdi" lost the bar.
    expect(jiraDraftTitle(">=100 saker feiler")).toBe(">=100 saker feiler");
    expect(jiraDraftTitle("|x| er absoluttverdi")).toBe("|x| er absoluttverdi");
    // …and a real quote still is one.
    expect(jiraDraftTitle("> Sitat som åpner utkastet")).toBe("Sitat som åpner utkastet");
  });

  test("a QUOTED heading is read as a heading, not as prose", () => {
    // The strip used to run only inside `cleanJiraTitle`, i.e. AFTER the heading
    // test, so a quoted section heading fell through to the prose branch and
    // titled the row "## Sitert tittel" — markdown syntax rendered as a name.
    expect(jiraDraftTitle("> ## Sitert tittel\n\nprosa")).toBe("prosa");
    expect(jiraDraftTitle("> ## Sitert tittel")).toBe("Sitert tittel");
    // A quoted level-1 heading on the first line is still an authored title.
    expect(jiraDraftTitle("> # Sitert tittel\n\nprosa")).toBe("Sitert tittel");
  });

  test("the clip never cuts through a surrogate pair", () => {
    // `.slice(0, 119)` on a title whose 119th unit is the high half of an astral
    // pair stores a lone surrogate — a replacement character in the list row.
    const title = jiraDraftTitle(`# ${"a".repeat(118)}${"\u{1F600}".repeat(10)}`)!;
    expect(title.endsWith("…")).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(title)).toBe(false);
    expect([...title].every((ch) => ch !== "\uFFFD")).toBe(true);
  });

  test("the scan is bounded by the function, so page and row agree", () => {
    // The listing reads only the head of the markdown out of the DB; the page
    // holds all of it. One derivation, one bound — or a draft opening with a
    // long fenced block is "(uten tittel)" in the list and titled on the page.
    const fence = ["```", "x".repeat(JIRA_TITLE_SCAN_CHARS + 200), "```", "", "Prosa"].join("\n");
    expect(jiraDraftTitle(fence)).toBeNull();
    expect(jiraDraftTitle(fence.slice(0, JIRA_TITLE_SCAN_CHARS))).toBeNull();
  });
});

describe("archive urls — one builder, list state preserved", () => {
  test("a draft link is plain by default and carries list state when given one", () => {
    expect(jiraDraftUrl("a b")).toBe("/jira?draft=a%20b");
    expect(jiraDraftUrl("d-1", { all: true, limit: 200 })).toBe("/jira?draft=d-1&all=1&limit=200");
    expect(jiraDraftUrl("d-1", { all: false, limit: null })).toBe("/jira?draft=d-1");
    expect(jiraDraftUrl("d-1", { all: false, limit: 3 })).toBe("/jira?draft=d-1&limit=3");
  });

  test("the toggle keeps every other param it was reached with", () => {
    expect(jiraArchiveUrl({ all: true, limit: null })).toBe("/jira?all=1");
    expect(jiraArchiveUrl({ all: false, limit: null })).toBe("/jira");
    expect(jiraArchiveUrl({ all: true, limit: 200 })).toBe("/jira?all=1&limit=200");
    expect(jiraArchiveUrl({ all: false, limit: 200 })).toBe("/jira?limit=200");
  });
});

describe("depthLabel", () => {
  test("one spelling for the archive row and the chat card", () => {
    expect(depthLabel("skisse")).toBe("Skisse");
    expect(depthLabel("full")).toBe("Full");
    expect(depthLabel("dyp")).toBe("dyp");
  });
});
