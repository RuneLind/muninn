import { describe, expect, test } from "bun:test";
import { stripCitationMarkers } from "./citation-markers.ts";

describe("stripCitationMarkers", () => {
  test("removes a marker inside the citation range and keeps a literal year", () => {
    const body = "Feilen ble meldt i 2024 [5] og gjelder [2024] fortsatt.";
    expect(stripCitationMarkers(body, 6)).toBe("Feilen ble meldt i 2024 og gjelder [2024] fortsatt.");
  });

  test("a marker at the end of a sentence takes its leading space with it", () => {
    expect(stripCitationMarkers("Beregningen feiler [3].", 6)).toBe("Beregningen feiler.");
  });

  test("a marker between two words leaves exactly one space", () => {
    expect(stripCitationMarkers("se [2] og videre", 6)).toBe("se og videre");
  });

  test("a run of markers collapses to nothing", () => {
    expect(stripCitationMarkers("grunnlaget [1][2][3] er dokumentert", 6)).toBe(
      "grunnlaget er dokumentert",
    );
  });

  test("a marker leading a line loses its trailing space, not the line", () => {
    expect(stripCitationMarkers("[1] Innledning", 6)).toBe("Innledning");
  });

  test("nothing is touched when the draft was written from no citations", () => {
    expect(stripCitationMarkers("uten kilder [1]", 0)).toBe("uten kilder [1]");
  });

  test("a number above the citations the model was given is left alone", () => {
    // The repair only removes what it can prove is a citation marker. A higher
    // number is either a hallucinated reference or an ordinary bracketed number,
    // and the two are indistinguishable from here.
    expect(stripCitationMarkers("kap. [12]", 6)).toBe("kap. [12]");
  });

  test("indentation and code fences survive — no global whitespace collapse", () => {
    const body = "- punkt\n    - underpunkt [1]\n\n```kotlin\nval x =  1\n```";
    expect(stripCitationMarkers(body, 3)).toBe("- punkt\n    - underpunkt\n\n```kotlin\nval x =  1\n```");
  });
});

/**
 * The MEASURED corruption set.
 *
 * Every input below was destroyed by the first cut of this repair, on real
 * Norwegian Jira drafts. They are the reason the pass now masks code, refuses a
 * marker it cannot prove is one, and repairs whitespace by removing at most one
 * space. All of them must come back BYTE-IDENTICAL — the only thing this repair
 * is allowed to touch is a bare `[n]` marker standing in prose.
 */
describe("stripCitationMarkers — the measured corruption set", () => {
  const unchanged = (body: string, used: number): void => {
    expect(stripCitationMarkers(body, used)).toBe(body);
  };

  test("a legal-article reference above the citation count survives", () => {
    // The generation path binds by `citationsUsed` (6–8 on this corpus), so a
    // `[13]` naming article 13 of a regulation is out of range and untouchable.
    unchanged("artikkel [13] i forordning 883/2004", 8);
  });

  test("an index expression glued to a word is not a marker", () => {
    unchanged("liste[2]", 6);
    unchanged("lovvalg[1] og videre", 6);
    unchanged("Se deler[1] her.", 6);
  });

  test("code survives — fenced and inline", () => {
    unchanged("```kotlin\nval navn = deler[1]\n```", 6);
    unchanged("Bruk `args[1]` som første argument.", 6);
    unchanged("~~~\nliste[2]\n~~~", 6);
  });

  test("a markdown link and a reference definition survive", () => {
    unchanged("[1](https://x.no)", 6);
    unchanged("Se [1](https://x.no) her.", 6);
    unchanged("[1]: https://x.no", 6);
    unchanged("![1](https://x.no/bilde.png)", 6);
    unchanged("En [lenke][1] i teksten.", 6);
  });

  test("a footnote reference survives", () => {
    unchanged("Påstanden[^1] er omstridt.", 6);
    unchanged("[^1]: fotnoten", 6);
  });

  test("a marker alone on its line is left alone — removing it splits the paragraph", () => {
    // `tekst\n\nmer` is two paragraphs where the source had one, and the only way
    // to avoid that is to collapse a newline, which this pass never does.
    unchanged("tekst\n[1]\nmer", 6);
    unchanged("tekst\n  [1]  \nmer", 6);
  });

  test("a bare marker in prose IS removed — the one thing the repair is for", () => {
    expect(stripCitationMarkers("Se her [5] og videre", 6)).toBe("Se her og videre");
    expect(stripCitationMarkers("Se her [5].", 6)).toBe("Se her.");
  });

  test("two words are never joined and a newline is never collapsed", () => {
    expect(stripCitationMarkers("lovvalg [1] og", 6)).toBe("lovvalg og");
    expect(stripCitationMarkers("linje\nen [1] to\nlinje", 6)).toBe("linje\nen to\nlinje");
  });

  test("only ONE adjacent space goes, on the side that had one", () => {
    expect(stripCitationMarkers("a  [1]  b", 6)).toBe("a   b");
    expect(stripCitationMarkers("a[1]  b", 6)).toBe("a[1]  b"); // glued left ⇒ not a marker
    expect(stripCitationMarkers("a  [1]b", 6)).toBe("a b");
  });
});
