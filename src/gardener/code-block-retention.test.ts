import { describe, expect, test } from "bun:test";
import { measureCodeRetention, missingCodeBlocks, summaryCodeBlocks } from "./code-block-retention.ts";

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

  test("a fence line carrying an info string does not close a block (CommonMark)", () => {
    const blocks = summaryCodeBlocks("```\nline one long enough\n```yaml\nline two long enough\n```");
    expect(blocks).toEqual([{ lang: "", lines: ["line one long enough", "```yaml", "line two long enough"] }]);
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

describe("missingCodeBlocks", () => {
  const summary = [
    "Prose.",
    "```yaml",
    "services:",
    "  postgres:",
    "    image: postgres:latest",
    "```",
    "More prose.",
    "```",
    "spring.threads.virtual.enabled=true",
    "spring.application.name=adoptions",
    "```",
  ].join("\n");

  test("names the block the page lost and omits the one it carries", () => {
    const page = "# Page\n\nIt quotes:\n\n```\nspring.threads.virtual.enabled=true\nspring.application.name=adoptions\n```\n";
    const missing = missingCodeBlocks(summary, page);
    expect(missing).toHaveLength(1);
    expect(missing[0]!.lang).toBe("yaml");
    expect(missing[0]!.text).toContain("image: postgres:latest");
  });

  test("a PARTIAL block is asked for again — the same 80% threshold the score uses", () => {
    // A page carrying 2 of the yaml block's 3 lines (67%) scores `partial`, not
    // `kept`. Asking for it again is what lets a half-quoted block be completed;
    // a `lost`-only filter would leave it half-quoted forever and then report
    // "no block recovered".
    // Three measurable lines (12+ chars each); the page carries two of them.
    const threeLines = [
      "Prose.",
      "```yaml",
      "    image: postgres:latest",
      "    container_name: adoptions-db",
      "    restart: unless-stopped",
      "```",
    ].join("\n");
    const partial = "# Page\n\n```yaml\n    image: postgres:latest\n    container_name: adoptions-db\n```\n";
    expect(measureCodeRetention(threeLines, partial)[0]).toMatchObject({ found: 2, lines: 3, verdict: "partial" });
    expect(missingCodeBlocks(threeLines, partial).map((m) => m.lang)).toEqual(["yaml"]);
  });

  test("a page carrying every block asks for nothing", () => {
    expect(missingCodeBlocks(summary, summary)).toEqual([]);
  });

  test("carries the block's own text, so the prompt and the score can't disagree", () => {
    const missing = missingCodeBlocks(summary, "# Page\n\nNothing quoted.");
    expect(missing.map((m) => m.lang)).toEqual(["yaml", ""]);
    expect(missing[1]!.text.split("\n")).toEqual([
      "spring.threads.virtual.enabled=true",
      "spring.application.name=adoptions",
    ]);
  });
});
