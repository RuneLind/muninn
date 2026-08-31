/**
 * Red→green pins for the MARK-mode rescue relaxation and the drop-reason tally.
 *
 * Written against the UNFIXED engine first: every `expect` here fails on the
 * pre-fix code, and for the reason the fix claims — a wrapper-only anchor whose
 * raw slice is a BALANCED markup superset of the model's plain-text quote was
 * refused by `collapsedRescueRisk`'s count-equality rule, which exists to protect
 * a SPLICE and has nothing to protect when the range is only being wrapped.
 */
import { test, expect, describe } from "bun:test";
import {
  annotateEdits,
  collapsedRescueRisk,
  dropReasonTally,
  RESCUE_DELIM_FAMILIES,
} from "./integrate-edits.ts";
import type { FactcheckClaimAnchor } from "../dashboard/views/components/wiki-integrate.ts";

const okClaim = (index: number): FactcheckClaimAnchor => ({
  index,
  total: 1,
  verdict: "✅",
  title: `claim ${index}`,
  block: `### ✅ Claim ${index}/1 — claim ${index}\n\nreasoning`,
});

/** Wrapper-only pass over one body + one plain-text quote. */
function markOne(body: string, quote: string) {
  return annotateEdits({
    body,
    isMdx: true,
    corrections: [],
    claims: [okClaim(1)],
    quotes: [{ index: 1, quote }],
    maxEdits: 32,
    maxEditChars: 2000,
  });
}

describe("mark-mode rescue", () => {
  test("a balanced **bold** superset is marked, not refused", () => {
    // The measured muninn case: the extractor returns the READING text, the body
    // carries the source text. The raw slice is the same words plus a balanced
    // `**…**` pair, so wrapping it changes nothing about what renders.
    const body =
      "# T\n\n- **Norepinephrine** acts as a mental spotlight, narrowing attention.\n";
    const res = markOne(body, "Norepinephrine acts as a mental spotlight, narrowing attention.");
    expect(res.dropped.map((d) => d.reason)).toEqual([]);
    expect(res.edits).toHaveLength(1);
    expect(res.edits[0]!.new).toContain('<Fact n="1" v="ok">');
    // The wrapped text is the RAW slice — markup included, byte-identical.
    expect(res.edits[0]!.old).toBe(
      "**Norepinephrine** acts as a mental spotlight, narrowing attention.",
    );
  });

  test("a balanced `code` superset is marked too", () => {
    const body = "# T\n\nThe flag `--strict` is on by default here.\n";
    const res = markOne(body, "The flag --strict is on by default here.");
    expect(res.dropped).toEqual([]);
    expect(res.edits).toHaveLength(1);
  });

  test("an UNBALANCED emphasis run is still refused in mark mode", () => {
    // `old` stops mid-construct, so the raw slice carries ONE `**` run: wrapping it
    // would leave the opening delimiter outside the tag and the closing one inside.
    // The relaxation must not reach this.
    expect(collapsedRescueRisk("Norepinephrine** acts", "Norepinephrine acts", "", "", "mark"))
      .toContain("markdown formatting");
  });

  test("a link's brackets are still COUNT-checked in mark mode, not parity-checked", () => {
    // `collapseWithMap` rewrites `[label](url)` → `label`, so a three-link
    // sentence's plain-text quote maps back to a slice that opens inside link 1 and
    // closes inside link 3. Every bracket char then appears an EVEN number of times
    // — parity alone waves it through — while wrapping it puts the `<Fact>` tag
    // between `[c` and its `](url)`. The bracket family therefore keeps the strict
    // count rule in BOTH modes. (This fixture is the one that fails when the mark
    // branch is widened to cover brackets; a single-link fixture does not.)
    const rawSlice = "a](https://a.co) and [b](https://b.co) and [c";
    for (const ch of ["[", "]", "(", ")"]) {
      expect([...rawSlice].filter((c) => c === ch).length % 2).toBe(0);
    }
    expect(collapsedRescueRisk(rawSlice, "a and b and c", "", "", "mark")).toContain(
      "markdown formatting",
    );
  });

  test("splice mode is unchanged by the new parameter", () => {
    expect(collapsedRescueRisk("**bold** word", "bold word")).toContain("markdown formatting");
    expect(collapsedRescueRisk("**bold** word", "bold word", "", "", "splice")).toContain(
      "markdown formatting",
    );
    // …and the paragraph-break rule binds in BOTH modes.
    expect(collapsedRescueRisk("a\n\nb", "a b", "", "", "mark")).toContain("paragraph break");
  });
});

describe("dropReasonTally", () => {
  test("collapses repeated reasons into counted, most-frequent-first phrases", () => {
    const drop = (reason: string) => ({ edit: { claimIndex: 0, old: "", new: "", reason: "" }, reason });
    // The FIRST-SEEN reason is deliberately the RARE one, so insertion order and
    // frequency order disagree — without that the sort is untested (measured: a
    // mutation deleting `.sort` survived the first spelling of this assertion).
    expect(
      dropReasonTally([
        drop("no longer found in the page"),
        drop("the checked passage is a table row — marking it would break the table"),
        drop("the checked passage is a table row — marking it would break the table"),
        drop("the checked passage is a table row — marking it would break the table"),
      ]),
    ).toBe(
      "3× the checked passage is a table row — marking it would break the table; " +
        "1× no longer found in the page",
    );
  });

  test("is empty for an empty list", () => {
    expect(dropReasonTally([])).toBe("");
  });
});

describe("the two delimiter families", () => {
  test("partition RESCUE_DELIMS, with EMPHASIS as the explicit half", () => {
    const { all, emphasis, bracket } = RESCUE_DELIM_FAMILIES;
    expect([...emphasis, ...bracket].sort()).toEqual([...all].sort());
    expect(emphasis.filter((d) => bracket.includes(d))).toEqual([]);
    // The DIRECTION is the point. `bracket` is derived by subtraction, so a
    // delimiter added to `RESCUE_DELIMS` for a new construct (`~~strike~~`) lands on
    // the STRICT count-equality path until someone classifies it. Deriving
    // `emphasis` instead reads tidier and fails OPEN — it would join the lenient
    // parity path silently, with no compile error.
    expect(emphasis).toEqual(["*", "`", "_"]);
    expect(bracket).toEqual(["[", "]", "(", ")"]);
  });
});
