import { test, expect, describe } from "bun:test";
import { claimSourceUrls, factcheckBodySha256, summaryFactcheckBody } from "./factcheck-body.ts";

describe("summaryFactcheckBody", () => {
  test("cuts at ## Transcript", () => {
    expect(summaryFactcheckBody("Body.\n\n## Transcript\n\nSpeech.\n")).toBe("Body.");
  });

  test("cuts at a ## Visual reference appendix above the transcript, in any accepted spelling", () => {
    const src = "Body.\n\n## **Visual References**:\n\n![a](b.jpg)\n\n## Transcript\n\nSpeech.";
    expect(summaryFactcheckBody(src)).toBe("Body.");
  });

  test("a heading quoted inside a code fence is not a cut", () => {
    const src = "Body.\n\n```md\n## Visual reference\n## Transcript\n```\n\nMore body.";
    expect(summaryFactcheckBody(src)).toBe(src);
  });

  test("a document with neither heading is checked whole", () => {
    expect(summaryFactcheckBody("Just a pasted article.\n")).toBe("Just a pasted article.");
  });
});

describe("factcheckBodySha256", () => {
  test("moves with the summary, not with the transcript", () => {
    const a = factcheckBodySha256("Body.\n\n## Transcript\n\nOne.");
    expect(factcheckBodySha256("Body.\n\n## Transcript\n\nTwo.")).toBe(a);
    expect(factcheckBodySha256("Body!\n\n## Transcript\n\nOne.")).not.toBe(a);
  });
});

describe("claimSourceUrls", () => {
  test("reads bare and markdown-link URLs off the Sources line only, de-duplicated", () => {
    const block = [
      "### ❌ Claim 1/1 — x",
      "",
      "See https://not-a-source.example for nothing.",
      "**Sources:** [who.int](https://who.int/a), https://nih.gov/b. https://who.int/a",
    ].join("\n");
    expect(claimSourceUrls(block)).toEqual(["https://who.int/a", "https://nih.gov/b"]);
  });

  test("a block without a Sources line has none", () => {
    expect(claimSourceUrls("### ❓ Claim 1/1 — x\n\nSkipped.")).toEqual([]);
  });
});
