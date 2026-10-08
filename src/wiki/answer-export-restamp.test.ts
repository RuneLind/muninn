import { describe, expect, test } from "bun:test";
import { exportStamp, formatAnswerExport, restampAnswerExport } from "./answer-export.ts";

/** The reader stamps a prefetched block with the click's time (answer cards
 *  PR 4, fix round 1). The click path itself is `wiki-answer-export-mount.test.ts`. */
describe("restampAnswerExport", () => {
  const PREFETCH = Date.UTC(2026, 9, 8, 6, 2); // 08:02 Oslo
  const CLICK = Date.UTC(2026, 9, 8, 7, 14); // 09:14 Oslo
  const block = formatAnswerExport({
    wiki: "mimir",
    relPath: "plans/a · exported 2026-01-01 00:00.mdx",
    exportedAt: PREFETCH,
    answers: [
      { questionId: "O3", authorName: "Yvonne Jacobs", asked: true, createdAt: PREFETCH, choice: null, body: "Svar.", version: 1, redacted: false },
    ],
    orphanCount: 0,
  });

  test("only the header's time changes, to the click's minute in Oslo", () => {
    const out = restampAnswerExport(block, CLICK);
    const [head, ...rest] = out.split("\n");
    expect(head).toBe(`<!-- answers · mimir · plans/a · exported 2026-01-01 00:00.mdx · exported ${exportStamp(CLICK)} -->`);
    expect(exportStamp(CLICK)).toBe("2026-10-08 09:14");
    expect(rest).toEqual(block.split("\n").slice(1));
  });

  test("a text without the header comes back unchanged", () => {
    expect(restampAnswerExport("", CLICK)).toBe("");
    expect(restampAnswerExport("### O3 — x\n> y\n", CLICK)).toBe("### O3 — x\n> y\n");
  });
});
