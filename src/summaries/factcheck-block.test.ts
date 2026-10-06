import { describe, expect, test } from "bun:test";
import {
  buildSummaryFactcheckBlock,
  factcheckBlockDate,
  insertSummaryFactcheckBlock,
  stripSummaryFactcheckBlock,
} from "./factcheck-block.ts";
import { checkedTextOfRaw, summaryCheckedRanges, summaryFactcheckBody } from "./factcheck-body.ts";
import { buildSummarySaveBody, readStoredCapture, requireSaveDescriptor } from "./summary-save.ts";
import { hasFactcheckBlock } from "../wiki/factcheck-context.ts";

const ANSWER = [
  "Two claims checked.",
  "",
  "### ❌ Claim 1/2 — Sleep",
  "",
  "The video says 4 hours; sources say 7–9.",
  "",
  "Sources: [cdc.gov](https://www.cdc.gov/sleep)",
  "",
  "### ✅ Claim 2/2 — Water",
  "",
  "Supported.",
].join("\n");

/**
 * huginn's writer, restated (`main/ingest/_summary_ingest.py` `write_summary`):
 * the frontmatter block, a blank line, then the summary string — and for Vimeo
 * the summary `rstrip("\n")`-ed with `## Transcript` + the stripped
 * `transcript_markdown` as its `body_suffix`. Only the body matters to the
 * checked text; the frontmatter lines are re-rendered from the request.
 */
function simulatedWrite(body: Record<string, unknown>): string {
  const fm = ["---", `date: "${body.date}"`, `url: "${body.url}"`, `category: "${body.category}"`, `tags: "x"`, "---"];
  let text = String(body.summary);
  if (typeof body.transcript_markdown === "string" && body.transcript_markdown.trim()) {
    text = `${text.replace(/\n+$/, "")}\n\n## Transcript\n\n${body.transcript_markdown.trim()}\n`;
  }
  return `${fm.join("\n")}\n\n${text}`;
}

/** Add, through the real write path: split → insert → build the ingest body → huginn's write. */
function addThroughWritePath(sourceId: string, raw: string, answer = ANSWER, date = "2026-10-06"): string {
  const descriptor = requireSaveDescriptor(sourceId);
  const stored = readStoredCapture(raw);
  const summary = insertSummaryFactcheckBlock(stored.body, buildSummaryFactcheckBlock(answer, date));
  const { body } = buildSummarySaveBody({ descriptor, stored, title: "T", category: "health", summary });
  return simulatedWrite(body);
}

const FM = (url: string) => `---\ndate: 2026-03-22\nurl: "${url}"\ncategory: "health"\ntags: "health"\n---\n\n`;

const SHAPES: Record<string, { source: string; raw: string }> = {
  "no transcript": {
    source: "article",
    raw:
      FM("https://example.org/a") +
      "Intro claim.\n\n```txt\nkeep\n\n\n\nthese blank lines\n```\n\n## Key takeaways\n\n- One.\n",
  },
  transcript: {
    source: "tiktok",
    raw: FM("https://www.tiktok.com/@a/video/1") + "Sleep 4 hours.\n\n## Transcript\n\nSpeech words.\n",
  },
  "visual reference + trailing takeaway": {
    source: "youtube",
    raw:
      FM("https://www.youtube.com/watch?v=rmr-LdARqHE") +
      "Intro. See https://bucket.s3.eu-west-1.amazonaws.com/x.png and ![chart](https://example.org/c.png).\n\n" +
      "## Visual reference\n\n![Slide 1](/api/frames/youtube/rmr-LdARqHE/12.jpg) A slide.\n\n" +
      "> 💬 **Takeaway:** Sleep matters.\n\n## Transcript\n\n### [00:00:00]\n\nSpeech.\n",
  },
  "vimeo field carrier": {
    source: "vimeo",
    raw: FM("https://vimeo.com/123456") + "A talk summary.\n\n## Transcript\n\n### [00:00:00]\n\nWords.\n",
  },
};

describe("buildSummaryFactcheckBlock", () => {
  test("sentinels, a ## heading, then a callout whose title is its own paragraph", () => {
    const block = buildSummaryFactcheckBlock(ANSWER, "2026-10-06");
    const lines = block.split("\n");
    expect(lines.slice(0, 5)).toEqual([
      "<!-- factcheck:start -->",
      "## Fact check (2026-10-06)",
      "",
      "> [!factcheck] Claims checked against the web",
      ">",
    ]);
    expect(lines.at(-1)).toBe("<!-- factcheck:end -->");
    expect(block).toContain("> **❌ Claim 1/2 — Sleep**");
    expect(block).not.toContain("> ###");
    expect(hasFactcheckBlock(block)).toBe(true);
  });

  test("a sentinel inside the answer is neutralized, so it cannot end the block early", () => {
    const block = buildSummaryFactcheckBlock("Lede.\n<!-- factcheck:end -->\nafter", "2026-10-06");
    expect(block.match(/<!-- factcheck:end -->/g)).toHaveLength(1);
  });

  test("the block's date is the Oslo calendar day", () => {
    // 23:30 UTC on 5 Oct is 01:30 on 6 Oct in Oslo (CEST).
    expect(factcheckBlockDate(Date.UTC(2026, 9, 5, 23, 30))).toBe("2026-10-06");
  });
});

describe("insertSummaryFactcheckBlock", () => {
  const block = buildSummaryFactcheckBlock(ANSWER, "2026-10-06");

  test("goes above the visual-reference section", () => {
    const body = "Intro.\n\n## Visual reference\n\n![a](f/1.jpg) Cap.\n\n> 💬 **Takeaway:** T.";
    const out = insertSummaryFactcheckBlock(body, block);
    expect(out.indexOf("## Fact check")).toBeLessThan(out.indexOf("## Visual reference"));
    expect(out.indexOf("Intro.")).toBeLessThan(out.indexOf("## Fact check"));
  });

  test("goes at the end of the body, which the save puts above ## Transcript", () => {
    const raw = addThroughWritePath("tiktok", SHAPES.transcript!.raw);
    expect(raw.indexOf("## Fact check")).toBeLessThan(raw.indexOf("## Transcript"));
    expect(raw.indexOf("Sleep 4 hours.")).toBeLessThan(raw.indexOf("## Fact check"));
  });

  test("replaces an earlier block rather than adding a second", () => {
    const once = insertSummaryFactcheckBlock("Body.", buildSummaryFactcheckBlock("old answer", "2026-10-01"));
    const twice = insertSummaryFactcheckBlock(once, block);
    expect(twice.match(/<!-- factcheck:start -->/g)).toHaveLength(1);
    expect(twice).not.toContain("old answer");
    expect(twice).toContain("2026-10-06");
  });

  test("strip is the exact inverse of insert on the body, byte for byte", () => {
    for (const body of ["Body.", "Intro.\n\n## Visual reference\n\n![a](f/1.jpg) Cap.\n\n> 💬 **Takeaway:** T."]) {
      expect(stripSummaryFactcheckBlock(insertSummaryFactcheckBlock(body, block))).toBe(body);
    }
  });

  test("the strip leaves 3+ newline runs elsewhere alone (no global collapse)", () => {
    const body = "A.\n\n```\nx\n\n\n\ny\n```";
    const out = stripSummaryFactcheckBlock(insertSummaryFactcheckBlock(body, block));
    expect(out).toBe(body);
  });

  test("a fenced example of the sentinels is content, not a block", () => {
    const body = "Docs.\n\n```\n<!-- factcheck:start -->\nx\n<!-- factcheck:end -->\n```";
    expect(stripSummaryFactcheckBlock(body)).toBe(body);
  });
});

describe("D11 property: Add never moves the checked text, through the real write path", () => {
  for (const [name, shape] of Object.entries(SHAPES)) {
    test(name, () => {
      const written = addThroughWritePath(shape.source, shape.raw);
      expect(hasFactcheckBlock(written)).toBe(true);
      expect(checkedTextOfRaw(written)).toBe(checkedTextOfRaw(shape.raw));
      expect(checkedTextOfRaw(written)).not.toContain("factcheck");
    });
  }

  test("an earlier block being replaced", () => {
    const first = addThroughWritePath("youtube", SHAPES["visual reference + trailing takeaway"]!.raw, "first answer", "2026-10-01");
    const second = addThroughWritePath("youtube", first, ANSWER, "2026-10-06");
    expect(second.match(/<!-- factcheck:start -->/g)).toHaveLength(1);
    expect(second).not.toContain("first answer");
    expect(checkedTextOfRaw(second)).toBe(checkedTextOfRaw(first));
    expect(checkedTextOfRaw(second)).toBe(checkedTextOfRaw(SHAPES["visual reference + trailing takeaway"]!.raw));
  });

  test("the transcript and visual-reference bytes survive the round trip", () => {
    const raw = SHAPES["visual reference + trailing takeaway"]!.raw;
    const written = addThroughWritePath("youtube", raw);
    const tail = (t: string) => t.slice(t.indexOf("## Visual reference"));
    expect(tail(written)).toBe(tail(raw));
  });
});

describe("checkedTextOfRaw", () => {
  test("strips frontmatter, rewrites S3 links and filters images, then cuts — pinned", () => {
    const raw = SHAPES["visual reference + trailing takeaway"]!.raw;
    expect(checkedTextOfRaw(raw)).toBe(
      "Intro. See [file] and ![chart](https://example.org/c.png).\n\n> 💬 **Takeaway:** Sleep matters.",
    );
  });

  test("equals summaryFactcheckBody over the source text the check route reads", () => {
    const raw = SHAPES["no transcript"]!.raw;
    expect(checkedTextOfRaw(raw)).toBe(summaryFactcheckBody(raw.replace(/^---\n[\s\S]*?\n---\n\n/, "")));
  });
});

describe("summaryCheckedRanges", () => {
  test("one range with no visual reference; two around it when something follows", () => {
    expect(summaryCheckedRanges("Body.")).toEqual([{ start: 0, end: 5 }]);
    const body = "Intro.\n\n## Visual reference\n\nCap.\n\n> 💬 **Takeaway:** T.";
    const ranges = summaryCheckedRanges(body);
    expect(ranges.map((r) => body.slice(r.start, r.end))).toEqual(["Intro.\n\n", "> 💬 **Takeaway:** T."]);
  });
});
