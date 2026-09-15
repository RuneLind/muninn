import { describe, expect, test } from "bun:test";
import { measureCodeRetention, summaryCodeBlocks } from "./code-block-retention.ts";

const SUMMARY = [
  "# Routing files",
  "",
  "```markdown",
  "| Task        | Model            |",
  "| planning    | opus-5           |",
  "| bulk edits  | sonnet-5         |",
  "}",
  "```",
  "",
  "Prose between blocks.",
  "",
  "````yaml",
  "```",
  "routing: fallback-to-local",
  "````",
  "",
  "## Transcript",
  "",
  "```",
  "a transcript block that must never be measured",
  "```",
].join("\n");

describe("summaryCodeBlocks", () => {
  test("closes a fence only on its own marker at the opening length, and skips the transcript", () => {
    const blocks = summaryCodeBlocks(SUMMARY);
    expect(blocks.map((b) => b.lang)).toEqual(["markdown", "yaml"]);
    expect(blocks[1]!.lines).toEqual(["```", "routing: fallback-to-local"]);
  });
});

describe("measureCodeRetention", () => {
  test("whitespace-normalized lines found anywhere in the page count as kept", () => {
    const page = "---\ntitle: X\n---\n\n```\n| Task | Model |\n| planning | opus-5 |\n| bulk edits | sonnet-5 |\n```\n";
    const [md, yaml] = measureCodeRetention(SUMMARY, page);
    // The 1-char "}" line is under the length floor, so three lines are measured.
    expect(md).toEqual({ index: 0, lang: "markdown", lines: 3, found: 3, verdict: "kept" });
    expect(yaml).toMatchObject({ lines: 1, found: 0, verdict: "lost" });
  });

  test("a paraphrased block is lost and a partial copy is partial", () => {
    const page = "The table routes planning to Opus.\n| planning | opus-5 |";
    expect(measureCodeRetention(SUMMARY, page)[0]).toMatchObject({ found: 1, verdict: "partial" });
    expect(measureCodeRetention(SUMMARY, "The table routes planning to Opus.")[0]!.verdict).toBe("lost");
  });

  test("a block with no measurable line is not reported", () => {
    expect(measureCodeRetention("```\n}\n```", "anything")).toEqual([]);
  });
});
