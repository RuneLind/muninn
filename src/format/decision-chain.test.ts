import { describe, expect, test } from "bun:test";
import { parseBlocks } from "./markdown-ast.ts";
import { analyzeDecisionChains, lineageLine, type ChainAnalysis } from "./decision-chain.ts";
import { pageLedgers } from "./pr-ledger.ts";

// Synthetic DecisionLogs and ledgers in the plan pages' shape. One fixture per
// edge phrase, in both languages; no text is copied from a real page.

const log = (...items: string[]): string => ["<DecisionLog>", "", ...items.map((i) => `- ${i}`), "", "</DecisionLog>", ""].join("\n");
const ledger = (header: string[], rows: string[][]): string =>
  ["**PR ledger.**", "", `| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`), ""].join("\n");

function analyze(md: string, linkText?: (i: number) => string): ChainAnalysis {
  const blocks = parseBlocks(md);
  return analyzeDecisionChains(blocks, pageLedgers(blocks, true), linkText ? { linkText } : {});
}
const lines = (md: string): string[] => analyze(md).chains.map(lineageLine);

describe("question → decision", () => {
  test("the question's own close, English and Norwegian", () => {
    expect(lines(log("**O1** — Which store? Closed 2026-10-01 (D1).", "**D1** — The flat file."))).toEqual(["O1 → D1"]);
    expect(lines(log("**S1** — Hvilken lagring? Lukket 01.10.2026 (D1).", "**D1** — Flat fil."))).toEqual(["S1 → D1"]);
  });

  test("«Lukker Sn» / «Closes On» on a decision, when the question carries no close", () => {
    expect(lines(log("**S2** — Hvilken form?", "**D3** — Rader. Lukker S2."))).toEqual(["S2 → D3"]);
    expect(lines(log("**O2** — Which shape?", "**O4** — Which key?", "**D3** — Rows. Closes O2 and O4."))).toEqual(["O2, O4 → D3"]);
  });

  test("the question's close wins over a decision's «Lukker», and the pair is a conflict", () => {
    const a = analyze(log("**S1** — Hva? Lukket 01.10.2026 (D1).", "**D1** — A.", "**D2** — B. Lukker S1."));
    expect(a.chains.map(lineageLine)).toEqual(["S1 → D1"]);
    expect(a.conflicts).toEqual([{ question: "S1", closedBy: "D1", claimant: "D2" }]);
  });

  test("«Lukker Sn» after the question was reopened: the reopen is no close, so the edge stands", () => {
    const a = analyze(log("**S1** — Hva? Gjenåpnet 03.10.2026.", "**D2** — B. Lukker S1."));
    expect(a.chains.map(lineageLine)).toEqual(["S1 → D2"]);
    expect(a.chains[0]!.questions[0]!.source).toBe("closes");
    expect(a.conflicts).toEqual([]);
    const reopened = analyze(log("**O1** — What? Closed 2026-10-01 (D1). Reopened 2026-10-03.", "**D1** — A.", "**D2** — B. Closes O1."));
    expect(reopened.chains.map(lineageLine)).toEqual(["O1 → D2"]);
    expect(reopened.conflicts).toEqual([]);
  });

  test("«Lukker Sn» naming the decision the question's own close names: one edge, no conflict", () => {
    const a = analyze(log("**S1** — Hva? Lukket 01.10.2026 (D1).", "**D1** — A. Lukker S1."));
    expect(a.chains.map(lineageLine)).toEqual(["S1 → D1"]);
    expect(a.chains[0]!.questions).toEqual([{ id: "S1", label: "Hva? Lukket 01.10.2026 (D1).", source: "close" }]);
    expect(a.conflicts).toEqual([]);
  });

  test("«Lukket S1 og S2» past tense, then a reopen: no edge, no conflict", () => {
    const a = analyze(log("**S1** — Hva? Gjenåpnet 03.10.2026.", "**S2** — Hvor?", "**D4** — C. Lukket S1 og S2 i forrige runde."));
    expect(a.chains).toEqual([]);
    expect(a.conflicts).toEqual([]);
  });

  test("a question closed by a decision on another page: no edge, an orphan", () => {
    const a = analyze(log("**O7** — Elsewhere? Closed 2026-10-01 (D40).", "**D1** — Unrelated."));
    expect(a.chains).toEqual([]);
    expect(a.orphans).toEqual([{ question: "O7", decision: "D40" }]);
  });

  test("«via»: the Q-n ids a question item names", () => {
    const a = analyze(log("**O1** — Which? Measured in Q-3 and Q-5. Closed 2026-10-01 (D1).", "**D1** — This."));
    expect(a.chains[0]!.via).toEqual(["Q-3", "Q-5"]);
  });
});

describe("decision → PR", () => {
  const LOG = log("**D1** — Use the cache.", "**D2** — Retune it.", "**D3** — Ship it.");

  test("ledger rows citing a decision, with the row's state", () => {
    const md = LOG + ledger(["PR", "State", "Decisions"], [["1 — cache", "merged [#11](https://example.test/pull/11)", "D1"], ["2 — retune", "dropped", "D2, D1"]]);
    expect(lines(md)).toEqual(["D2 → PR 2 (dropped)", "D1 → PR 1 (merged), PR 2 (dropped)"]);
  });

  test("a row citing one decision in «What it gives» and another in State gets both edges", () => {
    const md = LOG + ledger(["PR", "What it gives", "State"], [["4 — x", "the cache D1 asked for", "open — D2 ruled"]]);
    expect(lines(md)).toEqual(["D2 → PR 4 (open)", "D1 → PR 4 (open)"]);
  });

  test("«PR n» / «oppgave n» in decision prose, when no ledger row cites that PR", () => {
    expect(lines(log("**D1** — Do it in PR 7 and oppgave 2."))).toEqual(["D1 → oppgave 2, PR 7"]);
  });

  test("a decision that names another PR as context makes no prose edge", () => {
    const md = log("**D1** — Use the cache.", "**D2** — Charge it as PR 1 charges its own.") + ledger(["PR", "State"], [["1 — cache", "open — per D1"]]);
    expect(lines(md)).toEqual(["D1 → PR 1 (open)"]);
  });

  test("a PR named after a context word makes no prose edge, either language", () => {
    expect(lines(log("**D1** — Run it nightly, starting after PR 4."))).toEqual([]);
    expect(lines(log("**D1** — Charge Hard as PR 20 charges Medium."))).toEqual([]);
    expect(lines(log("**D1** — Keep the rule. Orchestrator, from the PR 2 review."))).toEqual([]);
    expect(lines(log("**D1** — Kjør etter PR 3, på samme måte som den PR 1."))).toEqual([]);
    expect(lines(log("**D1** — Run PR 3 after PR 1."))).toEqual(["D1 → PR 3"]);
  });

  test("«PR n» and «oppgave n» with one number are two outputs", () => {
    expect(lines(log("**D1** — Ship PR 3 and oppgave 3."))).toEqual(["D1 → PR 3, oppgave 3"]);
  });

  test("a ledger row citing a decision gates «PR n»; «oppgave n» only under an Oppgave ledger", () => {
    const LOG2 = log("**D1** — Do PR 3 and oppgave 3.", "**D2** — Other.");
    expect(lines(LOG2 + ledger(["PR", "State"], [["3 — x", "open — per D2"]]))).toEqual(["D2 → PR 3 (open)", "D1 → oppgave 3"]);
    expect(lines(LOG2 + ledger(["Oppgave", "State"], [["3 — x", "open — per D2"]]))).toEqual(["D2 → PR 3 (open)"]);
  });

  test("an oppgave takes a state only from an Oppgave ledger", () => {
    expect(lines(log("**D1** — Do oppgave 3.") + ledger(["PR", "State"], [["3 — x", "open"]]))).toEqual(["D1 → oppgave 3"]);
    expect(lines(log("**D1** — Do oppgave 3.") + ledger(["Oppgave", "State"], [["3 — x", "open"]]))).toEqual(["D1 → oppgave 3 (open)"]);
  });

  test("a range expands like a list; a range over 10 keeps its ends", () => {
    expect(lines(log("**D1** — Ship PR 4–6."))).toEqual(["D1 → PR 4, PR 5, PR 6"]);
    expect(lines(log("**D1** — Ship PR 4-6."))).toEqual(["D1 → PR 4, PR 5, PR 6"]);
    expect(lines(log("**D1** — Ship PR 4, 5 og 6."))).toEqual(["D1 → PR 4, PR 5, PR 6"]);
    expect(lines(log("**D1** — Gjør oppgave 1–2 og 4."))).toEqual(["D1 → oppgave 1, oppgave 2, oppgave 4"]);
    expect(lines(log("**D1** — Ship PR 4–30."))).toEqual(["D1 → PR 4, PR 30"]);
  });

  test("«pr n» in lower case is no slate number (Norwegian «pr.» reads «per»)", () => {
    expect(lines(log("**D1** — Én kjøring pr 4 uker."))).toEqual([]);
  });

  test("a `#` PR reference is evidence, never a slate edge", () => {
    expect(lines(log("**D1** — See [PR #3497](https://example.test/pull/3497) and PR #12."))).toEqual([]);
  });
});

describe("reversals and order", () => {
  test("a struck first sentence followed by «Snudd» / «superseded by» is a reversal row", () => {
    const a = analyze(log("**D9** — ~~Keep the old key.~~ Snudd, erstattet av D12.", "**D12** — A new key."));
    expect(a.chains.map(lineageLine)).toEqual(["D9 (reversed by D12)"]);
    expect(a.chains[0]!.label).toBe("Keep the old key.");
    const en = analyze(log("**D2** — ~~Batch nightly.~~ Reversed: superseded by D5.", "**D5** — Stream."));
    expect(en.chains.map(lineageLine)).toEqual(["D2 (reversed by D5)"]);
  });

  test("a struck lead with no reversal word is no reversal", () => {
    expect(analyze(log("**D3** — ~~Typo~~ Fixed wording.")).chains).toEqual([]);
  });

  test("the reversal word is read in any case, Snudd, Reversed, superseded or erstattet", () => {
    expect(lines(log("**D1** — ~~Bruk X.~~ Erstattet av ny løsning."))).toEqual(["D1 (reversed)"]);
    expect(lines(log("**D1** — ~~Use X.~~ Superseded: see D2.", "**D2** — Y."))).toEqual(["D1 (reversed)"]);
    expect(lines(log("**D1** — ~~Bruk X.~~ SNUDD 03.10."))).toEqual(["D1 (reversed)"]);
    expect(lines(log("**D1** — ~~Use X.~~ — reversed in round 2."))).toEqual(["D1 (reversed)"]);
  });

  test("a reversal needs the whole first sentence struck and the word right after it", () => {
    expect(lines(log("**D1** — ~~Use~~ the cache; this is not reversed."))).toEqual([]);
    expect(lines(log("**D1** — ~~Use X.~~ Kept, and never reversed."))).toEqual([]);
    expect(lines(log("**D1** — ~~Use X~~ and Y. Snudd."))).toEqual([]);
    expect(lines(log("**D1** — ~~Old~~ reversed order is the default now."))).toEqual([]);
  });

  test("newest decision first", () => {
    const md = log("**O1** — A? Closed 2026-10-01 (D2).", "**O2** — B? Closed 2026-10-01 (D10).", "**D2** — Two.", "**D10** — Ten.");
    expect(lines(md)).toEqual(["O2 → D10", "O1 → D2"]);
  });

  test("a label resolves wikilink sentinels through the link texts", () => {
    const a = analyze(log("**O1** — A? Closed 2026-10-01 (D1).", "**D1** — Follow \u0000WIKIPAGELINK0\u0000 here."), (i) => ["the guide"][i]!);
    expect(a.chains[0]!.label).toBe("Follow the guide here.");
  });
});
