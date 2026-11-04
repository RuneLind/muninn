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

describe("lint: plan-no-ledger", () => {
  const LEDGER = ["**PR ledger**", "", "| PR | State |", "|---|---|", "| 1 — a | merged |", "| 2 — b | merged |"];
  const page = (fm: string[], body: string[]) => ["---", "title: P", ...fm, "---", "", ...body, ""].join("\n");
  const fired = (content: string) => checkDecisionChain({ relPath: "plans/p.mdx" }, content).filter((x) => x.check === "plan-no-ledger");
  const SHIPPED = ["plan_status: shipped", "prs: [o/r#1, o/r#2]"];

  test("a shipped plan with two PRs and no ledger gets one info finding", () => {
    const f = fired(page(SHIPPED, ["## Brief", "", "Text."]));
    expect(f.map((x) => [x.severity, x.relPath])).toEqual([["info", "plans/p.mdx"]]);
    expect(f[0]!.message).toContain("shipped with 2 PRs");
    expect(fired(page(["plan_status: in-flight", "prs: [o/r#1, o/r#2]"], ["Text."]))).toHaveLength(1);
  });

  test("another table in the Brief is no ledger: the page that prompted this check", () => {
    const body = ["## Brief", "", "**Answer / numbers / decision**", "", "| Question | Answer |", "|---|---|", "| a | b |"];
    expect(fired(page(SHIPPED, body))).toHaveLength(1);
  });

  test("a ledger in a Fold or a Historic does not count, and the at-a-glance slate is one of those", () => {
    expect(fired(page(SHIPPED, ['<Fold title="Old">', "", ...LEDGER, "", "</Fold>"]))).toHaveLength(1);
    const glance = ["## Slate", "", "### At a glance", "", '<Historic since="r#1">', "", "| PR | What |", "|---|---|", "| 1 | a |", "", "</Historic>"];
    expect(fired(page(SHIPPED, glance))).toHaveLength(1);
  });

  test("a ledger in the Brief ends it, labelled in either language", () => {
    expect(fired(page(SHIPPED, ["## Brief", "", ...LEDGER]))).toEqual([]);
    const no = ["**PR-oversikt.**", "", "| PR | Status |", "|---|---|", "| 1 — a | merget |"];
    expect(fired(page(SHIPPED, no))).toEqual([]);
  });

  test("not asked of a proposed plan, a one-PR plan, a page with no plan_status, or a ledger in a fence", () => {
    expect(fired(page(["plan_status: proposed", "prs: [o/r#1, o/r#2]"], ["Text."]))).toEqual([]);
    expect(fired(page(["plan_status: shipped", "prs: [o/r#1]"], ["Text."]))).toEqual([]);
    expect(fired(page(["plan_status: shipped"], ["Text."]))).toEqual([]);
    expect(fired(page(["prs: [o/r#1, o/r#2]"], ["Text."]))).toEqual([]);
    expect(fired(page(SHIPPED, ["```markdown", ...LEDGER, "```"]))).toHaveLength(1);
  });

  test("runs in checkPageText, beside a page's other chain findings", () => {
    expect(PAGE_TEXT_LINT_CHECKS).toContain("plan-no-ledger");
    expect(checkPageText({ relPath: "plans/p.mdx" }, page(SHIPPED, ["Text."]), []).map((x) => x.check)).toContain("plan-no-ledger");
    const both = page(SHIPPED, ["<DecisionLog>", "", "- **S1** — Hva? Lukket 01.10.2026 (D1).", "- **D1** — A.", "- **D2** — B. Lukker S1.", "", "</DecisionLog>"]);
    expect(checkDecisionChain({ relPath: "plans/p.mdx" }, both).map((x) => x.check).sort()).toEqual(["chain-close-conflict", "plan-no-ledger"]);
  });
});

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
