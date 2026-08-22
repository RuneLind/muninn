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
