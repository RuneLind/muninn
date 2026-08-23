import { describe, expect, test, beforeEach, mock } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The claude-cli half of the thread-citation capture seam.
 *
 * **This file gets its OWN `bun test` link in package.json.** `mock.module`
 * invalidates the target for the whole test process graph, so mocking
 * `research/thread-citations.ts` inside the big `test:unit` chunk would break
 * export resolution for every already-loaded file that imports it (see the
 * `mock.module` note in CLAUDE.md). The placement is load-bearing and invisible
 * from this file alone.
 *
 * What it pins is the ONE thing the pure parser tests cannot: which text the
 * stream parser hands the capture, and how many times. The interesting case is
 * the CLI's oversized-result divert — the tool_result the parser sees is then a
 * pointer stub with no hits in it at all, and the hits live in the file on disk.
 */

interface CapturedCall {
  botName?: string;
  toolName?: string;
  text?: string;
}

const captured: CapturedCall[] = [];

const realCitations = await import("../research/thread-citations.ts");
mock.module("../research/thread-citations.ts", () => ({
  ...realCitations,
  captureKnowledgeToolCitations: (botName?: string, toolName?: string, text?: string) => {
    captured.push({ botName, toolName, text });
  },
}));

const { StreamParser } = await import("./stream-parser.ts");

/** A minimal rendered huginn full-mode result — synthetic, invented keys. */
const RENDERED_HITS = [
  "## MELOSYS-101 Eksempelsak om innlogging (100.0% relevant · high) | updated: 2026-01-15",
  "https://jira.example.invalid/browse/MELOSYS-101",
  "collection: `jira-issues` doc_id: `MELOSYS-101_Eksempelsak_om_innlogging.md`",
  "",
  "## Description",
  "Ved innlogging i eksempelmiljøet feiler oppslaget.",
].join("\n");

const TOOL_NAME = "mcp__knowledge__search_knowledge";

function feed(toolResultText: string): void {
  const parser = new StreamParser(0, undefined, "melosys");
  parser.parseLine(
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-sonnet-4-6",
        content: [
          { type: "tool_use", id: "toolu_1", name: TOOL_NAME, input: { query: "innlogging" } },
        ],
      },
    }),
    1,
  );
  parser.parseLine(
    JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: toolResultText }],
      },
    }),
    2,
  );
}

/** The CLI's placeholder when it diverts an oversized tool result to disk. */
function makePlaceholder(filePath: string): string {
  return (
    "Error: result (198,415 characters) exceeds maximum allowed tokens. " +
    `Output has been saved to ${filePath}.\nFormat: JSON with schema: {result: string}`
  );
}

describe("StreamParser files the hits it saw", () => {
  beforeEach(() => {
    captured.length = 0;
  });

  test("an ordinary tool result is captured exactly once, untruncated", () => {
    feed(RENDERED_HITS);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.botName).toBe("melosys");
    expect(captured[0]!.toolName).toBe(TOOL_NAME);
    expect(captured[0]!.text).toContain("doc_id: `MELOSYS-101_Eksempelsak_om_innlogging.md`");
  });

  test("an OVERSIZED result is captured from the recovered body, not the stub", () => {
    // The CLI hands the model a pointer stub; the hits are in the file. Without
    // re-capturing from the recovered text the thread's whole retrieval — the
    // biggest result sets, the ones a refinement discussion leans on hardest —
    // is filed as nothing at all.
    const dir = mkdtempSync(join(tmpdir(), "cli-divert-cite-"));
    const filePath = join(dir, "result.txt");
    writeFileSync(filePath, JSON.stringify({ result: RENDERED_HITS }), "utf8");
    try {
      feed(makePlaceholder(filePath));
      expect(captured).toHaveLength(1);
      expect(captured[0]!.text).toContain("doc_id: `MELOSYS-101_Eksempelsak_om_innlogging.md`");
      expect(captured[0]!.text).not.toContain("exceeds maximum allowed tokens");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("the trace fence is peeled off the recovered body before it is captured", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-divert-cite-"));
    const filePath = join(dir, "result.txt");
    const withFence =
      RENDERED_HITS + '\n\n```huginn-trace\n{"schemaVersion":1}\n```';
    writeFileSync(filePath, JSON.stringify({ result: withFence }), "utf8");
    try {
      feed(makePlaceholder(filePath));
      expect(captured).toHaveLength(1);
      expect(captured[0]!.text).toContain("doc_id: `MELOSYS-101_Eksempelsak_om_innlogging.md`");
      expect(captured[0]!.text).not.toContain("huginn-trace");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("an unreadable diverted file still captures once, with the stub", () => {
    // Degradation, not a second call: the stub parses to no hits, so the row
    // count is the same zero it would be if we skipped the call entirely.
    feed(makePlaceholder(join(tmpdir(), "does-not-exist-9f1d8a0e", "result.txt")));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.text).toContain("exceeds maximum allowed tokens");
  });
});
