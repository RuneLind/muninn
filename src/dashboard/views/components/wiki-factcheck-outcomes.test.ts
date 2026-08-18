import { test, expect, describe } from "bun:test";
import {
  tallyClaimOutcomes,
  factcheckOutcomeSummary,
  appendSuccessStatus,
  type OutcomeRow,
} from "./wiki-factcheck-outcomes.ts";

const row = (status: string, outcome?: string): OutcomeRow => ({ status, outcome });

describe("tallyClaimOutcomes", () => {
  test("tallies per-outcome counts across done rows", () => {
    const counts = tallyClaimOutcomes([
      row("done", "verified"),
      row("done", "verified"),
      row("done", "unverifiable"),
      row("done", "skipped"),
    ]);
    expect(counts).toEqual({ verified: 2, unverifiable: 1, skipped: 1 });
  });

  test("a done row with no outcome counts as verified (pre-outcome server)", () => {
    expect(tallyClaimOutcomes([row("done")])).toEqual({ verified: 1 });
  });

  // FIX 3c — a still-pending row has no outcome and must NOT default to verified.
  test("skips rows that never reached 'done' (does not inflate verified)", () => {
    const counts = tallyClaimOutcomes([
      row("done", "verified"),
      row("pending"),
      row("pending"),
    ]);
    expect(counts).toEqual({ verified: 1 });
  });

  test("undefined / empty input → empty counts", () => {
    expect(tallyClaimOutcomes(undefined)).toEqual({});
    expect(tallyClaimOutcomes([])).toEqual({});
  });

  test("ignores unknown outcome strings", () => {
    expect(tallyClaimOutcomes([row("done", "bogus")])).toEqual({});
  });
});

describe("factcheckOutcomeSummary", () => {
  // FIX 2 — the `verified` outcome displays as "checked", not "verified": a
  // debunked ❌ claim got a ruling but was not verified as true.
  test("renders the verified count with the honest 'checked' label", () => {
    expect(factcheckOutcomeSummary({ verified: 5, unverifiable: 1, skipped: 2 }))
      .toBe("5 checked · 1 unverifiable · 2 skipped");
  });

  test("omits zero-count categories", () => {
    expect(factcheckOutcomeSummary({ verified: 3 })).toBe("3 checked");
  });

  test("empty tally → empty string", () => {
    expect(factcheckOutcomeSummary({})).toBe("");
  });

  test("renders timeout/error with their display labels", () => {
    expect(factcheckOutcomeSummary({ timeout: 1, error: 2 })).toBe("1 timed out · 2 failed");
  });
});

describe("appendSuccessStatus", () => {
  // The ➕ write can DELETE marks an earlier ✎ Integrate put on the page. Before
  // this, the only feedback was a fixed "✓ Added to article" and a reload showing
  // a page whose underlines had vanished.
  // Joined with ": " — the note already carries its own em-dash, so " — " here made
  // one line out of three peer clauses.
  test("folds the route's supersededNote into the confirmation", () => {
    expect(appendSuccessStatus("7 marks from a previous check superseded — this action rebuilds the fact-check block and adds no new marks"))
      .toBe("✓ Added to article: 7 marks from a previous check superseded — this action rebuilds the fact-check block and adds no new marks");
  });

  test("no note ⇒ the plain confirmation (unchanged)", () => {
    expect(appendSuccessStatus()).toBe("✓ Added to article");
    expect(appendSuccessStatus(undefined)).toBe("✓ Added to article");
  });

  // A blank/whitespace note is a server that sent the field with nothing in it —
  // an em-dash trailing into nowhere is worse than no note.
  test("blank note ⇒ the plain confirmation, no dangling dash", () => {
    expect(appendSuccessStatus("")).toBe("✓ Added to article");
    expect(appendSuccessStatus("   ")).toBe("✓ Added to article");
  });
});
