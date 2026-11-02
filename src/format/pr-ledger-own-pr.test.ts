import { describe, expect, test } from "bun:test";
import { parseBlocks } from "./markdown-ast.ts";
import { findLedgers, firstRowPerPr, pageLedgers, parseLedgerTable, prStateMap } from "./pr-ledger.ts";

// A row's own PR, the one the GitHub check compares its state with. Made-up repos.
describe("LedgerRow.ownPr", () => {
  const A = "[#1](https://github.com/acme/a/pull/1)";
  const B = "[#2](https://github.com/acme/b/pull/2)";
  const own = (header: string[], cells: string[]) => parseLedgerTable(header, [cells]).rows[0]!;
  const OWN_A = { repo: "acme/a", n: 1 };

  test("first cell, then the PR column, then Landed", () => {
    expect(own(["Slate", "PR", "Landed", "State"], [A, B, B, "open"]).ownPr).toEqual(OWN_A);
    expect(own(["Slate", "PR", "Landed", "State"], ["3 x", A, B, "open"]).ownPr).toEqual(OWN_A);
    expect(own(["Slate", "Landed", "State"], ["3 x", A, "merged"]).ownPr).toEqual(OWN_A);
  });

  test("the state cell counts when the word opening it set the state", () => {
    expect(own(["Slate", "State"], ["3 x", `merged in ${A}`]).ownPr).toEqual(OWN_A);
    expect(own(["Slate", "State"], ["3 x", `open ${A}`]).ownPr).toEqual(OWN_A);
    expect(own(["Slate", "State"], ["3 x", "[merget](https://github.com/acme/a/pull/1)"]).ownPr).toEqual(OWN_A);
  });

  test("not when the state word comes later, or another word set the state", () => {
    expect(own(["Slate", "State"], ["3 x", `see ${A}, then merged ${B}`]).ownPr).toBeUndefined();
    expect(own(["Slate", "State"], ["3 x", `blocked by ${A}; open ${B}`]).ownPr).toBeUndefined();
  });

  test("a PR in another cell is not the row's, though `link` reads it", () => {
    const row = own(["Slate", "What", "State", "Depends on", "Touches"], ["3 x", "y", "open", A, B]);
    expect(row.link).toBe(1);
    expect(row.ownPr).toBeUndefined();
  });

  test("a bare number, a non-GitHub URL and a struck link are none", () => {
    expect(own(["PR", "State"], ["PR #7", "open"]).ownPr).toBeUndefined();
    expect(own(["PR", "State"], ["[#7](https://example.test/acme/a/pull/7)", "open"]).ownPr).toBeUndefined();
    expect(own(["PR", "State"], [`3 ~~${A}~~`, "open"]).ownPr).toBeUndefined();
  });

  test("the field is absent, not null, on a row with none", () => {
    expect("ownPr" in own(["PR", "State"], ["PR #7", "open"])).toBe(false);
  });
});

// The GitHub check reads every row of a ledger; every other reader keeps the numbered rows.
describe("the everyRow read", () => {
  const H = ["PR", "State"];
  const ROWS = [["**P3 — no number**", "not started"], ["7 — numbered", "open"], ["[KEY-1](https://example.test/KEY-1)", "see [[owner]]"]];
  const MD = `**PR ledger.**\n\n| PR | State |\n|---|---|\n${ROWS.map((r) => `| ${r.join(" | ")} |`).join("\n")}\n`;

  test("keeps a row with no number, its pr null", () => {
    const rows = parseLedgerTable(H, ROWS, "ledger", { everyRow: true }).rows;
    expect(rows.map((r) => r.pr)).toEqual([null, 7, null]);
    expect(rows[0]).toMatchObject({ slate: null, link: null, state: "not-started", label: "P3 — no number" });
  });

  test("findLedgers and pageLedgers pass it on", () => {
    const blocks = parseBlocks(MD);
    expect(findLedgers(blocks, { everyRow: true })[0]!.rows).toHaveLength(3);
    expect(pageLedgers(blocks, false, { everyRow: true })[0]!.rows).toHaveLength(3);
  });

  test("every other reader keeps today's parse: the numbered rows, and the share over them", () => {
    const blocks = parseBlocks(MD);
    for (const l of [parseLedgerTable(H, ROWS), findLedgers(blocks)[0]!, pageLedgers(blocks)[0]!, pageLedgers(blocks, true)[0]!]) {
      expect(l.rows.map((r) => r.pr)).toEqual([7]);
      expect([l.parsedShare, l.draws]).toEqual([1, true]);
    }
    expect(firstRowPerPr([parseLedgerTable(H, ROWS)]).map((r) => r.pr)).toEqual([7]);
    expect(prStateMap([parseLedgerTable(H, ROWS)])).toEqual(new Map([[7, "open"]]));
  });

  test("a glance table stays as it is: its rows with no number stay out", () => {
    const glance = "### At a glance\n\n| PR | What |\n|---|---|\n| 1 — a | x |\n| Later | y |\n";
    const rows = pageLedgers(parseBlocks(glance), true, { everyRow: true })[0]!.rows;
    expect(rows.map((r) => [r.pr, r.state, r.claimedState])).toEqual([[1, "planned", "planned"]]);
  });
});

describe("a link in the state cell", () => {
  const A = "[#1](https://github.com/acme/a/pull/1)";
  const B = "[#2](https://github.com/acme/b/pull/2)";
  const own = (state: string) => parseLedgerTable(["Slate", "State"], [["3 x", state]]).rows[0]!;
  const OWN_A = { repo: "acme/a", n: 1 };
  const OWN_B = { repo: "acme/b", n: 2 };

  test.each([
    [`merged ${A}`],
    [`merged  ${A}`],
    [`merged (${A})`],
    [`merged: ${A}`],
    [`merged — ${A}`],
    [`merged, ${A}`],
    [`Merged In ${A}`],
    ['merged [#1](https://github.com/acme/a/pull/1 "the title")'],
    [`merged 2026-10-30, ${A}`],
    [`merged 24.10 (${A})`],
    [`merged 02.11, ${A}`],
    [`**merged** ${A}`],
    [`_merged_ ${A}`],
    [`merged in ${A}`],
    [`merget i ${A}`],
    ["merged https://github.com/acme/a/pull/1"],
    ["[merget](https://github.com/acme/a/pull/1)"],
  ])("%s is the row's own", (state) => {
    expect(own(state).ownPr).toEqual(OWN_A);
  });

  test.each([
    [`open, waits on ${A}`],
    [`open (blocked by ${A})`],
    [`open, see ${A}`],
    [`open — after ${A}`],
    [`open follow-up ${A}`],
    [`merged into ${A}`],
    [`merged 3 days ago ${A}`],
    [`merged 3 ${A}`],
    [`open, merged ${A}`],
    [`open, ${A}; merged ${B}`],
    [`merged 2026-10-30x ${A}`],
    [`merged [notes](https://example.test/n) ${A}`],
  ])("%s is not", (state) => {
    expect(own(state).ownPr).toBeUndefined();
  });

  test("links run on only with nothing but punctuation between", () => {
    expect(own(`merged ${A}, ${B}`).ownPrs).toEqual([OWN_A, OWN_B]);
    expect(own(`merged ${A}, waits on ${B}`).ownPrs).toEqual([OWN_A]);
    expect(own(`merged in ${A} in ${B}`).ownPrs).toEqual([OWN_A]);
    expect(own(`merged ${A}, ${A}`).ownPrs).toEqual([OWN_A]);
    expect(own("[merget](https://github.com/acme/a/pull/1), [#2](https://github.com/acme/b/pull/2)").ownPrs).toEqual([OWN_A, OWN_B]);
  });
});

describe("a cell linking several PRs", () => {
  const A = "[#1](https://github.com/acme/a/pull/1)";
  const B = "[#2](https://github.com/acme/b/pull/2)";
  const row = (header: string[], cells: string[]) => parseLedgerTable(header, [cells]).rows[0]!;

  test("all are the row's own, in order, the first still ownPr", () => {
    const r = row(["PR", "State"], [`${A}, ${B}`, "open"]);
    expect(r.ownPrs).toEqual([{ repo: "acme/a", n: 1 }, { repo: "acme/b", n: 2 }]);
    expect(r.ownPr).toEqual({ repo: "acme/a", n: 1 });
  });

  test("the first cell holding one decides: a later cell adds nothing", () => {
    expect(row(["Slate", "PR", "State"], [A, B, "open"]).ownPrs).toEqual([{ repo: "acme/a", n: 1 }]);
    expect(row(["Slate", "PR", "Landed", "State"], ["3", `${B} ${A}`, A, "open"]).ownPrs).toEqual([{ repo: "acme/b", n: 2 }, { repo: "acme/a", n: 1 }]);
    expect(row(["Slate", "Landed", "State"], ["3", `${A} ${B}`, "open"]).ownPrs).toHaveLength(2);
  });

  test("the same PR twice, in any case, is one", () => {
    expect(row(["PR", "State"], [`${A} ${A.replace("acme", "ACME")}`, "open"]).ownPrs).toEqual([{ repo: "acme/a", n: 1 }]);
  });

  test("a row with none has neither field", () => {
    const r = row(["PR", "State"], ["PR #7", "open"]);
    expect("ownPrs" in r).toBe(false);
    expect("ownPr" in r).toBe(false);
  });
});

describe("claimedState: what the GitHub check compares", () => {
  const A = "[#1](https://github.com/acme/a/pull/1)";
  const one = (state: string) => parseLedgerTable(["Slate", "State"], [["3 x", state]]).rows[0]!;

  test.each([
    ["open follow-up: rail polish", "open"],
    ["planned next: more", "planned"],
    ["not started yet", "not-started"],
    ["ikke startet ennå", "not-started"],
    ["open Ærlig talt", "open"],
    ["**open** follow-up", "open"],
    ["_open_ follow-up", "open"],
    ["*open* follow-up", "open"],
    ["open `follow-up`", "open"],
    ["open [the follow-up](https://example.test/f)", "open"],
    ["open [[plans/follow-up]]", "open"],
    ["[åpen](https://example.test/x) follow-up", "open"],
  ])("%s goes on in prose: unknown, though the strip still reads it", (cell, parsed) => {
    expect(one(cell).claimedState).toBe("unknown");
    expect(one(cell).state).toBe(parsed as never);
    expect(one(cell).rule).toBe(2);
  });

  test.each([
    ["open", "open"],
    ["planned", "planned"],
    ["not started", "not-started"],
    ["open, awaiting review", "open"],
    ["open: awaiting review", "open"],
    ["open — awaiting review", "open"],
    ["open – awaiting review", "open"],
    ["open - awaiting review", "open"],
    ["open (awaiting review)", "open"],
    ["open.", "open"],
    ["**open** — awaiting", "open"],
    ["open 2026-10-01", "open"],
    ["[åpen](https://example.test/x)", "open"],
    ["[åpen](https://example.test/x) — venter", "open"],
    [`open ${A}`, "open"],
  ])("%s keeps its state", (cell, want) => {
    expect(one(cell).claimedState).toBe(want as never);
  });

  test("a state word reading a link deep in prose is about that link, not the row", () => {
    const r = one(`blocked by ${A}; open [#2](https://github.com/acme/b/pull/2)`);
    expect([r.state, r.rule, r.claimedState]).toEqual(["open", 1, "unknown"]);
  });

  test("so is one in a cell that does not hold the row's state or PR", () => {
    const row = parseLedgerTable(["Slate", "State", "Notes"], [["3 x", "?", `open ${A}`]]).rows[0]!;
    expect([row.state, row.rule, row.claimedState]).toEqual(["open", 1, "unknown"]);
  });

  test("a state word opening the PR, Landed or first cell is the row's", () => {
    expect(parseLedgerTable(["Slate", "PR"], [["3 x", `open ${A}`]]).rows[0]!.claimedState).toBe("open");
    expect(parseLedgerTable(["Slate", "Landed"], [["3 x", `open ${A}`]]).rows[0]!.claimedState).toBe("open");
    expect(parseLedgerTable(["Slate", "What"], [[`open ${A}`, "x"]]).rows[0]!.claimedState).toBe("open");
  });

  test("a row with no state keeps none, and a merged one stays merged", () => {
    expect(one("?").claimedState).toBe("unknown");
    expect(one("merged").claimedState).toBe("merged");
    expect(parseLedgerTable(["PR", "Landed"], [["1", A]]).rows[0]!.claimedState).toBe("merged");
  });
});
