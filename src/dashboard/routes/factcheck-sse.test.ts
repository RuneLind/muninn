import { test, expect, describe } from "bun:test";
import { runClaimPool, assembleFactcheckAnswer, verdictOf, type ClaimVerifyOutcome } from "./factcheck-sse.ts";

const ok = (block: string): ClaimVerifyOutcome => ({ block, real: true });
const skip = (i: number): ClaimVerifyOutcome => ({ block: `skip${i}`, real: false });

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
