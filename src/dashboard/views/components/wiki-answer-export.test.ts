import { describe, expect, test } from "bun:test";
import { exportRowsKey, unexportedRowsKey } from "./wiki-answer-export.ts";
import type { AnswerWire } from "./wiki-answer-card-model.ts";

/**
 * The stale-block test behind "Copy new answers": the click copies the
 * prefetched block only when its rows are exactly the answers the cards show
 * as unexported. The DOM half is `e2e/wiki-answer-export.spec.ts`.
 */

const answer = (answerId: string, version: number, over: Partial<AnswerWire> = {}): AnswerWire => ({
  answerId,
  questionId: "O1",
  version,
  authorName: "Synne Testdal",
  choice: null,
  body: "x",
  createdAt: 0,
  firstCreatedAt: 0,
  exported: false,
  redacted: false,
  versionCount: version,
  mine: true,
  ...over,
});

describe("export keys", () => {
  test("order-free", () => {
    expect(exportRowsKey([["b", 1], ["a", 2]])).toBe(exportRowsKey([["a", 2], ["b", 1]]));
  });

  test("the cards' key matches the server's rows: exported and redacted answers left out", () => {
    const answers = [answer("a", 2), answer("b", 1, { exported: true }), answer("c", 1, { redacted: true }), answer("d", 3)];
    expect(unexportedRowsKey(answers)).toBe(exportRowsKey([["d", 3], ["a", 2]]));
  });

  test("an edit changes the key even though the count does not", () => {
    expect(unexportedRowsKey([answer("a", 3)])).not.toBe(exportRowsKey([["a", 2]]));
  });
});
