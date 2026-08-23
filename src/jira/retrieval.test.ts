/**
 * The `unreachable` verdict, and the two derivations it has to survive.
 *
 * **The bug this is written against, measured on the composer's first real run:**
 * huginn was down, every sub-search threw, `researchKnowledge` recorded each as
 * `{resultCount: 0, error}` and swallowed it, `assessCoverage` saw zero hits and
 * said `no_hits` — and the reader was told *"nothing in jira-issues,
 * melosys-confluence-v3 or nav-wiki covered this search"*. The corpus was never
 * asked. Every assertion here is one link in that chain.
 */

import { test, expect, describe } from "bun:test";
import { classifyJiraCoverage, jiraCoverageMessage } from "./retrieval.ts";
import {
  effectiveCoverage,
  JIRA_LOW_CONFIDENCE_MESSAGE,
  JIRA_NO_HITS_MESSAGE,
  JIRA_UNREACHABLE_MESSAGE,
} from "./wire.ts";

const dead = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ resultCount: 0, error: `fetch failed (${i})` }));

describe("classifyJiraCoverage", () => {
  test("EVERY sub-search failed ⇒ unreachable, not no_hits", () => {
    expect(classifyJiraCoverage({ hitCount: 0, subSearches: dead(4) })).toBe("unreachable");
  });

  test("a PARTIAL failure still asked the corpus and is graded the ordinary way", () => {
    expect(
      classifyJiraCoverage({
        hitCount: 3,
        subSearches: [{ resultCount: 3, lowConfidence: false }, ...dead(1)],
      }),
    ).toBe("answer");
  });

  test("a genuinely empty corpus is still no_hits — no error, no hits", () => {
    expect(
      classifyJiraCoverage({ hitCount: 0, subSearches: [{ resultCount: 0 }, { resultCount: 0 }] }),
    ).toBe("no_hits");
  });

  test("an EMPTY fan-out is not an outage (vacuous `every` guarded)", () => {
    expect(classifyJiraCoverage({ hitCount: 0, subSearches: [] })).toBe("no_hits");
  });

  test("low confidence still routes through assessCoverage", () => {
    expect(
      classifyJiraCoverage({
        hitCount: 2,
        subSearches: [{ resultCount: 2, lowConfidence: true }],
      }),
    ).toBe("low_confidence");
  });
});

describe("effectiveCoverage passes unreachable through", () => {
  test("zero retained does NOT convert it into a claim about the corpus", () => {
    // An unreachable retrieval has nothing to retain BY CONSTRUCTION, so the
    // zero-retained branch would otherwise re-create the exact lie.
    expect(effectiveCoverage("unreachable", 0)).toBe("unreachable");
  });

  test("the other verdicts are untouched", () => {
    expect(effectiveCoverage("answer", 0)).toBe("no_hits");
    expect(effectiveCoverage("answer", 3)).toBe("answer");
    expect(effectiveCoverage("low_confidence", 3)).toBe("low_confidence");
    expect(effectiveCoverage(null, 3)).toBe("answer");
  });
});

describe("jiraCoverageMessage", () => {
  test("names the API, not the corpus", () => {
    expect(jiraCoverageMessage("unreachable")).toBe(JIRA_UNREACHABLE_MESSAGE);
    expect(JIRA_UNREACHABLE_MESSAGE).toContain("utilgjengelig");
    expect(JIRA_UNREACHABLE_MESSAGE).not.toContain("jira-issues");
  });

  test("the other two are unchanged", () => {
    expect(jiraCoverageMessage("no_hits")).toBe(JIRA_NO_HITS_MESSAGE);
    expect(jiraCoverageMessage("low_confidence")).toBe(JIRA_LOW_CONFIDENCE_MESSAGE);
  });
});
