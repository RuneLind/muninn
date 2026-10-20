import { describe, expect, test } from "bun:test";
import { checkDecisionChain } from "./lint-decision-chain.ts";
import { checkPageText, PAGE_TEXT_LINT_CHECKS } from "./lint.ts";

// Check 16 over synthetic pages: an unreadable ledger row and a contradicted
// «Lukker», both info, each pointing at its own line.

const PAGE = [
  "---", // 1
  "title: P", // 2
  "---", // 3
  "<DecisionLog>", // 4
  "", // 5
  "- **S1** — Hva? Lukket 01.10.2026 (D1).", // 6
  "- **D1** — A.", // 7
  "- **D2** — B. Lukker S1.", // 8
  "", // 9
  "</DecisionLog>", // 10
  "", // 11
  "**PR-oversikt.**", // 12
  "", // 13
  "| PR | Status |", // 14
  "|---|---|", // 15
  "| 1 — a | merget [#3](https://example.test/pull/3) |", // 16
  "| 2 — b | se notatet |", // 17
  "", // 18
].join("\n");

describe("lint: ledger-row-state / chain-close-conflict", () => {
  test("one info finding each, on the row's and the claimant's line", () => {
    const f = checkDecisionChain({ relPath: "plans/p.mdx" }, PAGE);
    expect(f.map((x) => [x.check, x.line, x.severity])).toEqual([
      ["ledger-row-state", 17, "info"],
      ["chain-close-conflict", 8, "info"],
    ]);
    expect(f[0]!.message).toContain("PR 2");
    expect(f[1]!.message).toContain("D2 closes S1");
  });

  test("a ledger with no state column reports no row; neither does the glance table", () => {
    const noState = PAGE.replace("| PR | Status |", "| PR | Result |");
    expect(checkDecisionChain({ relPath: "p.mdx" }, noState).filter((x) => x.check === "ledger-row-state")).toEqual([]);
    const glance = ["### At a glance", "", "| PR | What |", "|---|---|", "| 1 | a |", ""].join("\n");
    expect(checkDecisionChain({ relPath: "p.mdx" }, glance)).toEqual([]);
  });

  test("a ledger quoted in a code fence is not read", () => {
    const fenced = ["```markdown", "**PR ledger.**", "", "| PR | State |", "|---|---|", "| 1 | ??? |", "```", ""].join("\n");
    expect(checkDecisionChain({ relPath: "p.mdx" }, fenced)).toEqual([]);
  });

  test("both run in checkPageText", () => {
    expect(PAGE_TEXT_LINT_CHECKS).toContain("ledger-row-state");
    expect(PAGE_TEXT_LINT_CHECKS).toContain("chain-close-conflict");
    const checks = checkPageText({ relPath: "plans/p.mdx" }, PAGE, []).map((x) => x.check);
    expect(checks).toContain("ledger-row-state");
    expect(checks).toContain("chain-close-conflict");
  });

  // Fix round 1, batch 4 (F10): a wikilink in a row reads as its label, so its
  // `|` does not split the cell, and the row is still found on its line.
  test("a row whose label is a wikilink is read and located", () => {
    const linked = PAGE.replace("| 2 — b | se notatet |", "| 2 — [[plans/b|b]] | se notatet |");
    const f = checkDecisionChain({ relPath: "plans/p.mdx" }, linked).filter((x) => x.check === "ledger-row-state");
    expect(f.map((x) => [x.line, x.message.slice(0, 40)])).toEqual([[17, "PR ledger row PR 2: no state the strip c"]]);
    expect(f[0]!.message).toContain('("se notatet")');
  });
});
