import { test, expect, describe } from "bun:test";
import { findRefs, headingSlug } from "./wiki-ref-links.ts";

/** The browser half (wrapping, the peek, the jump and Back) is driven in
 *  e2e/wiki-ref-links.spec.ts. */

const keys = (text: string, ids: string[], titles: string[] = []) =>
  findRefs(text, new Set(ids), new Set(titles)).map((m) => `${m.kind}:${text.slice(m.start, m.end)}`);

describe("headingSlug", () => {
  test("matches GitHub's slugs on the links kode-wiki pages already carry", () => {
    expect(headingSlug("Runde 3 — 2026-08-18 kveld")).toBe("runde-3--2026-08-18-kveld");
    expect(headingSlug("Kontinuitetsresultat (kjørt i prod 2026-07-02)")).toBe(
      "kontinuitetsresultat-kjørt-i-prod-2026-07-02",
    );
    expect(headingSlug("Q8 — dekningssjekk (paste og annoter)")).toBe("q8--dekningssjekk-paste-og-annoter");
    expect(headingSlug("Q2-oppskrift")).toBe("q2-oppskrift");
    expect(headingSlug("Executive Summary")).toBe("executive-summary");
  });
});

describe("findRefs: ids", () => {
  const ids = ["D4", "D5", "D6", "S1", "S4", "Q-1", "Q-14", "MEL-601780"];

  test("whole ids, in order, including both ends of a range", () => {
    expect(keys("fag sa nei (D5, D6), se Q-1–Q-14 og S1–S4.", ids)).toEqual([
      "id:D5",
      "id:D6",
      "id:Q-1",
      "id:Q-14",
      "id:S1",
      "id:S4",
    ]);
  });

  test("not inside a longer token", () => {
    expect(keys("Q-10 XD4 D4x D4-saken D45 MEL-6017801", ids)).toEqual([]);
  });

  test("an id ending a sentence or followed by a slash or hyphen-space still matches", () => {
    expect(keys("S1/S4. Gjelder D4- og D5.", ids)).toEqual(["id:S1", "id:S4", "id:D4", "id:D5"]);
  });

  test("case-sensitive: d4 is not D4", () => {
    expect(keys("d4 og D4", ids)).toEqual(["id:D4"]);
  });

  test("an undefined id is plain text", () => {
    expect(keys("D1 og D2", ids)).toEqual([]);
  });

  test("a case id with a hyphen", () => {
    expect(keys("saken MEL-601780, ikke MEL-60178", ids)).toEqual(["id:MEL-601780"]);
  });
});

describe("findRefs: quoted titles", () => {
  const titles = ["Q2-oppskrift", "Saker", "As run — decisions"];

  test("all three quote styles, quotes included in the match", () => {
    expect(keys('oppskriften i «Q2-oppskrift», se “Saker” og "As run — decisions".', [], titles)).toEqual([
      "title:«Q2-oppskrift»",
      "title:“Saker”",
      'title:"As run — decisions"',
    ]);
  });

  test("a quote that names no section is no link, and ids inside it still are", () => {
    expect(keys("skiller «vedtak fattet i Melosys» fra «D4 og D5»", ["D4", "D5"], titles)).toEqual([
      "id:D4",
      "id:D5",
    ]);
  });

  test("a stray straight quote does not swallow the next title", () => {
    expect(keys('en 5" skjerm og "Saker"', [], titles)).toEqual(['title:"Saker"']);
  });

  test("surrounding spaces inside the quote are tolerated; case is not", () => {
    expect(keys("se « Saker » og «saker»", [], titles)).toEqual(["title:« Saker »"]);
  });

  test("ids and titles mixed, non-overlapping", () => {
    expect(keys("D4 står i «Saker», D5 også", ["D4", "D5"], titles)).toEqual([
      "id:D4",
      "title:«Saker»",
      "id:D5",
    ]);
  });
});

test("an empty index finds nothing", () => {
  expect(findRefs("D4 «Saker»", new Set(), new Set())).toEqual([]);
});
