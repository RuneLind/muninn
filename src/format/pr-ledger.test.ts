import { describe, expect, test } from "bun:test";
import { parseBlocks } from "./markdown-ast.ts";
import { findGlanceLedger, findLedgers, isLedgerLabel, pageLedgers, parseLedgerTable, prStateMap, LEDGER_PARSED_MIN } from "./pr-ledger.ts";

// Synthetic ledgers shaped like the plan pages' (slate number first, state
// column, a Landed column that carries the PR link once the state cell turns
// into result prose). No text is copied from a real page.

const table = (header: string[], rows: string[][]): string =>
  [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

const ledgerPage = (label: string, header: string[], rows: string[][]): string => [label, "", table(header, rows), ""].join("\n");

describe("isLedgerLabel", () => {
  test.each([
    ["**PR ledger.**", true],
    ["**PR-oversikt.**", true],
    ["**PR ledger:**", true],
    ["## PR ledger", true],
    ["**PR ledger (oppdatert).**", true],
    ["PR-oversikt", true],
    ["## Hvorfor PR-oversikt mangler:", false],
    ["**Status:**", false],
  ])("%s → %s", (line, want) => {
    expect(isLedgerLabel(line)).toBe(want);
  });
});

describe("row state, in the rule order", () => {
  const H = ["PR", "State", "Landed"];
  const one = (row: string[], header = H) => parseLedgerTable(header, [row]).rows[0]!;

  test("rule 1: a state word followed by a PR link or a sha, anywhere in the row", () => {
    expect(one(["1 — a", "merged [#12](https://example.test/pull/12)", ""])).toMatchObject({ state: "merged", rule: 1 });
    expect(one(["2 — b", "merget `e44793fb1e`", ""])).toMatchObject({ state: "merged", rule: 1 });
    // State-cell result prose, `merged [#n]` in the next cell.
    expect(one(["3 — c", "planned last, then retuned", "merged [#40](https://example.test/pull/40)"])).toMatchObject({ state: "merged", rule: 1 });
    expect(one(["4 — d", "Retune dropped after the run", "dropped in [#41](https://example.test/pull/41)"])).toMatchObject({ state: "dropped", rule: 1 });
  });

  test("rule 2: a state word at the start of the state cell", () => {
    expect(one(["5 — e", "closed, no code: the run settled it", ""])).toMatchObject({ state: "closed", rule: 2 });
    expect(one(["6 — f", "dropped as measured: no gain", ""])).toMatchObject({ state: "dropped", rule: 2 });
    expect(one(["7 — g", "**ikke startet**", ""])).toMatchObject({ state: "not-started", rule: 2 });
    expect(one(["8 — h", "_åpen_", ""])).toMatchObject({ state: "open", rule: 2 });
    expect(one(["9 — k", "[merget](https://example.test/pull/9) `abc1234`", ""])).toMatchObject({ state: "merged", rule: 2 });
    expect(one(["10 — l", "landet 29.09", ""])).toMatchObject({ state: "merged", rule: 2 });
  });

  test("every state word, both languages", () => {
    const words: [string, string][] = [
      ["merged", "merged"], ["dropped", "dropped"], ["closed", "closed"], ["open", "open"], ["measurement", "measurement"],
      ["not started", "not-started"], ["blocked", "blocked"], ["optional", "optional"], ["planned", "planned"],
      ["merget", "merged"], ["landet", "merged"], ["landed", "merged"], ["forkastet", "dropped"], ["lukket", "closed"], ["åpen", "open"], ["måling", "measurement"],
      ["ikke startet", "not-started"], ["blokkert", "blocked"], ["valgfri", "optional"], ["planlagt", "planned"],
    ];
    for (const [w, s] of words) expect(`${w} → ${one(["1", w, ""]).state}`).toBe(`${w} → ${s}`);
  });

  test("rule 3: a merged-PR link alone in a Landed / Landet cell", () => {
    expect(one(["9 — i", "see notes", "[#55](https://example.test/pull/55)"])).toMatchObject({ state: "merged", rule: 3 });
    expect(one(["9 — i", "se notat", "[#55](https://example.test/pull/55)"], ["PR", "Status", "Landet"])).toMatchObject({ state: "merged", rule: 3 });
  });

  test("a state word inside prose never counts", () => {
    expect(one(["10 — j", "the branch was merged into the spike", ""])).toMatchObject({ state: "unknown", rule: 0 });
  });
});

describe("PR identity and the decisions a row cites", () => {
  test("the slate number first, bold and dashes stripped; a phase id is no PR", () => {
    const l = parseLedgerTable(["PR", "State"], [["**12** — harness", "merged [#640](https://example.test/pull/640)"], ["A1 — phase", "open"], ["[#77](https://example.test/pull/77) fix", "open"]]);
    expect(l.rows.map((r) => [r.pr, r.slate, r.link])).toEqual([
      [12, 12, 640],
      [77, null, 77],
    ]);
    expect(l.rows[0]!.label).toBe("harness");
  });

  test("a Decisions column: every Dn there, a bare number is no id", () => {
    const r = parseLedgerTable(["PR", "What it gives", "Decisions", "State"], [["3 — x", "per D9", "6, D7, D8", "open"]]).rows[0]!;
    expect(r.decisions).toEqual(["D7", "D8"]);
  });

  test("no Decisions column: every distinct Dn in the row, one in «What it gives», one in State", () => {
    const r = parseLedgerTable(["PR", "What it gives", "State"], [["4 — y", "the cache, per D15", "open — D16 ruled it in, D15 again"]]).rows[0]!;
    expect(r.decisions).toEqual(["D15", "D16"]);
  });
});

describe("which ledgers draw", () => {
  const rows = (n: number, known: number) =>
    Array.from({ length: n }, (_, i) => [`${i + 1} — p`, i < known ? "merged [#1](https://example.test/pull/1)" : "see the run notes"]);

  test(`the ${LEDGER_PARSED_MIN * 100} % floor`, () => {
    expect(parseLedgerTable(["PR", "State"], rows(4, 3)).draws).toBe(true);
    expect(parseLedgerTable(["PR", "State"], rows(5, 3)).draws).toBe(false);
  });

  test("no state column ⇒ never draws", () => {
    const l = parseLedgerTable(["PR", "Landed"], [["1", "[#5](https://example.test/pull/5)"], ["2", "[#6](https://example.test/pull/6)"]]);
    expect(l.stateColumn).toBe(-1);
    expect(l.draws).toBe(false);
  });

  test("a ledger inside a Lane is found; a table under another label is not", () => {
    const md = [
      "<NextMoves>",
      "",
      '<Lane kind="you">',
      "",
      ledgerPage("**PR-oversikt.**", ["PR", "Status"], [["1 — a", "merget [#3](https://example.test/pull/3)"]]),
      "</Lane>",
      "",
      "</NextMoves>",
      "",
      ledgerPage("**Other table.**", ["PR", "Status"], [["9", "open"]]),
    ].join("\n");
    const found = findLedgers(parseBlocks(md));
    expect(found).toHaveLength(1);
    expect(found[0]!.rows[0]).toMatchObject({ pr: 1, state: "merged" });
  });

  test("a label with prose after it, and a Meter between label and table, still find the table", () => {
    const md = [
      "**PR ledger.** Merged rows first, then the rest.",
      "",
      '<Meter value="1" max="2" tone="good">1 of 2 merged</Meter>',
      "",
      "| PR | State |",
      "|---|---|",
      "| 1 — a | merged |",
      "| 2 — b | open |",
      "",
    ].join("\n");
    expect(findLedgers(parseBlocks(md)).map((l) => l.rows.map((r) => r.state))).toEqual([["merged", "open"]]);
    expect(isLedgerLabel("**PR ledger.** Merged rows first, then the rest.")).toBe(false);
    expect(findLedgers(parseBlocks(md.replace("**PR ledger.**", "**Plan.**")))).toEqual([]);
  });

  test("no ledger on a proposed plan ⇒ the At a glance table, every PR planned; a ledger beats it", () => {
    const glance = ["### At a glance", "", table(["PR", "What"], [["1", "a"], ["2", "b"]]), ""].join("\n");
    const g = findGlanceLedger(parseBlocks(glance))!;
    expect(g.rows.map((r) => r.state)).toEqual(["planned", "planned"]);
    expect(pageLedgers(parseBlocks(glance), true)[0]!.source).toBe("glance");
    // Not proposed (shipped, in flight): no slate of planned PRs.
    expect(pageLedgers(parseBlocks(glance))).toEqual([]);
    const both = [glance, ledgerPage("**PR ledger.**", ["PR", "State"], [["1", "open"]])].join("\n");
    expect(pageLedgers(parseBlocks(both), true).map((l) => l.source)).toEqual(["ledger"]);
  });

  test("prStateMap: the first row naming a PR wins", () => {
    const a = parseLedgerTable(["PR", "State"], [["1", "open"]]);
    const b = parseLedgerTable(["PR", "State"], [["1", "merged [#2](https://example.test/pull/2)"]]);
    expect(prStateMap([a, b]).get(1)).toBe("open");
  });
});
