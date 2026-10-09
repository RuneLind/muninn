/**
 * A fact-check mark inside a `<DecisionLog>` item (reader lenses PR 2, fix
 * round 1, item A). The item renders as a first sentence and a rest; a mark
 * must neither move that split in a way the render guard reads as a change,
 * nor be refused where `origin/main` (no split) accepted it. Synthetic.
 */

import { describe, expect, test } from "bun:test";
import { annotateEdits } from "./integrate-edits.ts";
import { formatWebHtml } from "../web/web-format.ts";
import type { FactcheckClaimAnchor } from "../dashboard/views/components/wiki-integrate.ts";

const anchor = (index: number, verdict: string): FactcheckClaimAnchor => ({
  index,
  total: 9,
  verdict,
  title: "claim " + index,
  block: `### ${verdict} Claim ${index}/9 — claim ${index}`,
});

const log = (item: string) => `<DecisionLog>\n\n- ${item}\n\n</DecisionLog>\n`;

function marks(body: string, quote: string) {
  return annotateEdits({
    body,
    isMdx: true,
    corrections: [],
    claims: [anchor(1, "✅")],
    quotes: [{ index: 1, quote }],
    maxEdits: 20,
    maxEditChars: 2000,
  });
}

describe("a mark in a split DecisionLog item is not refused", () => {
  const cases: [string, string][] = [
    ["**D1** The cache holds ten entries. It evicts the oldest first. More text here.", "The cache holds ten entries."],
    ["**D1** The cache holds ten entries. It evicts the oldest first. More text here.", "ten entries. It evicts"],
    ["**D1** — Vi velger alternativ A. Fordi B er dyrt.", "Vi velger alternativ A. Fordi B er dyrt"],
    ["**D1** — Vi velger alternativ A nå. Fordi B er dyrt. Og mer.", "alternativ A nå. Fordi B"],
  ];
  for (const [item, quote] of cases) {
    test(quote, () => {
      // The item splits, so the mark meets a first sentence and a rest.
      expect(formatWebHtml(log(item))).toContain('<span class="dl-first">');
      const r = marks(log(item), quote);
      expect(r.dropped.map((d) => d.reason)).toEqual([]);
      expect(r.edits).toHaveLength(1);
    });
  }
});
