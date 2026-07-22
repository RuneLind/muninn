import { test, expect, describe } from "bun:test";
import {
  runClaimPool,
  assembleFactcheckAnswer,
  linkifySourcesLines,
  verdictOf,
  parseConfidence,
  realOutcome,
  type ClaimVerifyOutcome,
} from "./factcheck-sse.ts";

const ok = (block: string): ClaimVerifyOutcome => ({ block, real: true, outcome: "verified" });
const skip = (i: number): ClaimVerifyOutcome => ({ block: `skip${i}`, real: false, outcome: "skipped" });

describe("runClaimPool", () => {
  test("returns outcomes in claim order regardless of completion order", async () => {
    // Reverse the finish order (claim 0 finishes last) — output must still be ordered.
    const verify = async (i: number): Promise<ClaimVerifyOutcome> => {
      await new Promise((r) => setTimeout(r, (4 - i) * 4));
      return ok(`claim${i}`);
    };
    const doneOrder: number[] = [];
    const out = await runClaimPool({
      total: 4,
      concurrency: 4,
      shouldSkip: () => false,
      verify,
      onSkip: skip,
      onDone: (i) => doneOrder.push(i),
    });
    expect(out.map((o) => o.block)).toEqual(["claim0", "claim1", "claim2", "claim3"]);
    // onDone fires in COMPLETION order (not claim order) — claim 3 finishes first.
    expect(doneOrder[0]).toBe(3);
    expect(doneOrder.slice().sort()).toEqual([0, 1, 2, 3]);
  });

  test("runs at most `concurrency` verifies in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const verify = async (i: number): Promise<ClaimVerifyOutcome> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return ok(`v${i}`);
    };
    await runClaimPool({
      total: 6,
      concurrency: 2,
      shouldSkip: () => false,
      verify,
      onSkip: skip,
      onDone: () => {},
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
  });

  test("skips claims once shouldSkip flips (deadline) — never launching verify for them", async () => {
    let launched = 0;
    let past = false;
    const out = await runClaimPool({
      total: 4,
      concurrency: 1, // deterministic: strictly sequential
      shouldSkip: () => past,
      verify: async (i) => {
        launched++;
        if (i === 1) past = true; // deadline crosses after claim 1
        return ok(`v${i}`);
      },
      onSkip: skip,
      onDone: () => {},
    });
    expect(launched).toBe(2); // claims 0 + 1 launched; 2 + 3 gated out
    expect(out[0]).toEqual(ok("v0"));
    expect(out[1]).toEqual(ok("v1"));
    expect(out[2]).toEqual(skip(2));
    expect(out[3]).toEqual(skip(3));
  });

  test("skips every claim when shouldSkip is true from the start (client gone)", async () => {
    let launched = 0;
    const out = await runClaimPool({
      total: 3,
      concurrency: 2,
      shouldSkip: () => true,
      verify: async (i) => { launched++; return ok(`v${i}`); },
      onSkip: skip,
      onDone: () => {},
    });
    expect(launched).toBe(0);
    expect(out).toEqual([skip(0), skip(1), skip(2)]);
  });

  test("concurrency is floored at 1 and capped at total", async () => {
    const out = await runClaimPool({
      total: 1,
      concurrency: 8,
      shouldSkip: () => false,
      verify: async (i) => ok(`v${i}`),
      onSkip: skip,
      onDone: () => {},
    });
    expect(out).toEqual([ok("v0")]);
  });
});

describe("assembleFactcheckAnswer", () => {
  test("single claim: the lone block IS the answer (no lede)", () => {
    const block = "### ✅ Claim 1/1 — A\n\nSupported.";
    expect(assembleFactcheckAnswer("", [block])).toBe(block);
  });

  test("multi claim: compose lede on top of blocks in order", () => {
    const out = assembleFactcheckAnswer("Overall the claims held up.", ["B1", "B2", "B3"]);
    expect(out).toBe("Overall the claims held up.\n\nB1\n\nB2\n\nB3");
  });

  test("trims surrounding whitespace on the assembled answer", () => {
    expect(assembleFactcheckAnswer("  lede  ", ["B1", "B2"]).startsWith("lede")).toBe(true);
  });

  test("empty blocks → empty string", () => {
    expect(assembleFactcheckAnswer("x", [])).toBe("");
  });

  test("linkifies bare URLs on the Sources line of the assembled answer", () => {
    const block = "### ✅ Claim 1/1 — A\n\nSupported.\n\nSources: https://www.nature.com/articles/x";
    const out = assembleFactcheckAnswer("", [block]);
    expect(out).toContain("Sources: [nature.com](https://www.nature.com/articles/x)");
  });
});

describe("linkifySourcesLines", () => {
  test("wraps a bare URL into a [hostname](url) markdown link (www stripped)", () => {
    expect(linkifySourcesLines("Sources: https://www.example.com/a")).toBe(
      "Sources: [example.com](https://www.example.com/a)",
    );
  });

  test("leaves an already-markdown link untouched (no double-wrap)", () => {
    const line = "Sources: [example.com](https://example.com/a)";
    expect(linkifySourcesLines(line)).toBe(line);
  });

  test("mixed bare + markdown link on one line — only the bare one is wrapped", () => {
    const line = "Sources: [example.com](https://example.com/a), https://who.int/b";
    expect(linkifySourcesLines(line)).toBe(
      "Sources: [example.com](https://example.com/a), [who.int](https://who.int/b)",
    );
  });

  test("multiple bare URLs on one line are all wrapped", () => {
    const line = "Sources: https://a.com/x, https://b.org/y";
    expect(linkifySourcesLines(line)).toBe(
      "Sources: [a.com](https://a.com/x), [b.org](https://b.org/y)",
    );
  });

  test("trailing punctuation stays OUTSIDE the href", () => {
    expect(linkifySourcesLines("Sources: https://a.com/x, https://b.org/y.")).toBe(
      "Sources: [a.com](https://a.com/x), [b.org](https://b.org/y).",
    );
  });

  test("non-Sources lines are left untouched", () => {
    const md = "Reasoning mentions https://a.com/x inline.\n\nSources: https://b.org/y";
    expect(linkifySourcesLines(md)).toBe(
      "Reasoning mentions https://a.com/x inline.\n\nSources: [b.org](https://b.org/y)",
    );
  });

  test("only http(s) schemes are linkified", () => {
    const line = "Sources: ftp://a.com/x https://b.org/y";
    expect(linkifySourcesLines(line)).toBe(
      "Sources: ftp://a.com/x [b.org](https://b.org/y)",
    );
  });

  test("no URLs on the Sources line → unchanged", () => {
    expect(linkifySourcesLines("Sources: none opened")).toBe("Sources: none opened");
  });
});

describe("verdictOf", () => {
  test("✅ / ❌ / ❓ verdicts pass through", () => {
    expect(verdictOf("### ✅ Claim 1/2 — a\n\nSupported.")).toBe("✅");
    expect(verdictOf("### ❌ Claim 1/2 — a\n\nRefuted.")).toBe("❌");
    expect(verdictOf("### ❓ Claim 1/2 — a\n\nUnclear.")).toBe("❓");
  });

  test("VS16 ⚠️ verdict passes through unchanged", () => {
    expect(verdictOf("### ⚠️ Claim 1/2 — a\n\nPartly true.")).toBe("⚠️");
  });

  test("bare ⚠ (no VS16) is normalized to ⚠️", () => {
    // Models routinely emit U+26A0 without the U+FE0F variation selector.
    expect(verdictOf("### ⚠ Claim 1/2 — x")).toBe("⚠️");
  });

  test("no leading verdict marker → ❓", () => {
    expect(verdictOf("Claim 1/2 — a\n\nno heading marker")).toBe("❓");
  });
});

describe("parseConfidence", () => {
  const block = (line: string) =>
    `### ✅ Claim 1/2 — a\n\nReasoning here.\n\n${line}\n\nSources: https://x`;

  test("parses a normal score", () => {
    expect(parseConfidence(block("Confidence: 85/100"))).toBe(85);
  });

  test("tolerates extra spaces after the colon", () => {
    expect(parseConfidence(block("Confidence:   72/100"))).toBe(72);
  });

  test("0 is kept (not treated as falsy/absent)", () => {
    expect(parseConfidence(block("Confidence: 0/100"))).toBe(0);
  });

  test("clamps a >100 score to 100", () => {
    expect(parseConfidence(block("Confidence: 150/100"))).toBe(100);
  });

  test("missing Confidence line → undefined", () => {
    expect(parseConfidence("### ✅ Claim 1/2 — a\n\nReasoning.\n\nSources: https://x")).toBeUndefined();
  });

  test("malformed Confidence line (no /100) → undefined", () => {
    expect(parseConfidence(block("Confidence: high"))).toBeUndefined();
    expect(parseConfidence(block("Confidence: 85 out of 100"))).toBeUndefined();
  });

  test("matches the line anywhere in the block (not just first line)", () => {
    expect(parseConfidence(block("Confidence: 40/100"))).toBe(40);
  });

  test("is case-insensitive (models emit lowercase 'confidence:')", () => {
    expect(parseConfidence(block("confidence: 62/100"))).toBe(62);
    expect(parseConfidence(block("CONFIDENCE: 91/100"))).toBe(91);
  });
});

describe("realOutcome", () => {
  test("✅ / ⚠️ / ❌ real verdicts map to 'verified' (a real ruling, not a truth claim)", () => {
    expect(realOutcome("### ✅ Claim 1/2 — a\n\nSupported.")).toBe("verified");
    expect(realOutcome("### ⚠️ Claim 1/2 — a\n\nPartly.")).toBe("verified");
    expect(realOutcome("### ❌ Claim 1/2 — a\n\nContradicted.")).toBe("verified");
  });

  test("a model-chosen ❓ verdict maps to 'unverifiable'", () => {
    expect(realOutcome("### ❓ Claim 1/2 — a\n\nThe web genuinely doesn't cover this.")).toBe("unverifiable");
  });

  test("a bare ⚠ (no VS16) still maps to 'verified'", () => {
    expect(realOutcome("### ⚠ Claim 1/2 — a\n\nPartly.")).toBe("verified");
  });
});
