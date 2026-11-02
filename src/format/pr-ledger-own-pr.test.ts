import { describe, expect, test } from "bun:test";
import { parseLedgerTable } from "./pr-ledger.ts";

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
