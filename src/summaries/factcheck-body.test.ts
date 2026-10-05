import { test, expect, describe } from "bun:test";
import { factcheckBodySha256, summaryFactcheckBody } from "./factcheck-body.ts";

describe("summaryFactcheckBody", () => {
  test("cuts at ## Transcript", () => {
    expect(summaryFactcheckBody("Body.\n\n## Transcript\n\nSpeech.\n")).toBe("Body.");
  });

  test("cuts at a ## Visual reference appendix above the transcript, in any accepted spelling", () => {
    const src = "Body.\n\n## **Visual References**:\n\n![a](b.jpg)\n\n## Transcript\n\nSpeech.";
    expect(summaryFactcheckBody(src)).toBe("Body.");
  });

  test("only the appendix SECTION is cut: a takeaway closer after it stays in the checked body", () => {
    const src = [
      "Intro.", "", "## Key takeaways", "", "- One.", "",
      "## Visual reference", "", "![a](f/1.jpg) Slide one.", "",
      "> 💬 **Takeaway:** Sleep matters.", "", "## Transcript", "", "Speech.",
    ].join("\n");
    // Exact: the hash is over this string, so the blank line kept between the
    // body and the closer is part of the contract.
    expect(summaryFactcheckBody(src)).toBe(
      "Intro.\n\n## Key takeaways\n\n- One.\n\n> 💬 **Takeaway:** Sleep matters.",
    );
  });

  test("a closer ABOVE the appendix is not duplicated", () => {
    const src = "Intro.\n\n> 💬 **Takeaway:** T.\n\n## Visual reference\n\n![a](f/1.jpg) Cap.\n\n## Transcript\n\nSpeech.";
    expect(summaryFactcheckBody(src)).toBe("Intro.\n\n> 💬 **Takeaway:** T.");
  });

  test("a closer in a LATER section does not cut into that section", () => {
    const src = "Intro.\n\n## Visual reference\n\n![a](f/1.jpg) Cap.\n\n## Notes\n\nLater.\n\n> 💬 **Takeaway:** T.";
    expect(summaryFactcheckBody(src)).toBe("Intro.\n\n## Notes\n\nLater.\n\n> 💬 **Takeaway:** T.");
  });

  test("the appendix ends at the next heading of its level: a section after it stays", () => {
    const src = "Intro.\n\n## Visual reference\n\n![a](f/1.jpg) Slide.\n\n## Notes\n\nA later claim.\n\n## Transcript\n\nSpeech.";
    expect(summaryFactcheckBody(src)).toBe("Intro.\n\n## Notes\n\nA later claim.");
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
