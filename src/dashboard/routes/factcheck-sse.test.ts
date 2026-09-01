import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import {
  runClaimPool,
  assembleFactcheckAnswer,
  linkifySourcesLines,
  verdictOf,
  parseConfidence,
  realOutcome,
  claimsEventPayload,
  classifyClaimFailure,
  claimTimeoutReason,
  shortFailureReason,
  pairToolEvents,
  FACTCHECK_CLAIM_TIMEOUT_MS,
  type ClaimVerifyOutcome,
  type StampedToolEvent,
} from "./factcheck-sse.ts";
import { claimExtractionText } from "./factcheck-sse.ts";
import { CLAIM_QUOTE_MAX } from "../views/components/wiki-integrate.ts";
import { formatWebHtml } from "../../web/web-format.ts";

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

  // ── FIX 1: parenthesized URLs (Wikipedia disambig et al.) ──────────────────
  test("bare Wikipedia disambig URL keeps its (balanced) parens, encoded in the href", () => {
    expect(
      linkifySourcesLines("Sources: https://en.wikipedia.org/wiki/Mercury_(planet)"),
    ).toBe("Sources: [en.wikipedia.org](https://en.wikipedia.org/wiki/Mercury_%28planet%29)");
  });

  test("an existing markdown link with parens in the href is normalized (parens encoded)", () => {
    expect(
      linkifySourcesLines("Sources: [en.wikipedia.org](https://en.wikipedia.org/wiki/Mercury_(planet))"),
    ).toBe("Sources: [en.wikipedia.org](https://en.wikipedia.org/wiki/Mercury_%28planet%29)");
  });

  test("a WRAPPER paren (see …) is shed, not swallowed into the href", () => {
    expect(linkifySourcesLines("Sources: (see https://x.com/a)")).toBe(
      "Sources: (see [x.com](https://x.com/a))",
    );
  });

  test("balanced paren followed by trailing punctuation splits both", () => {
    expect(
      linkifySourcesLines("Sources: https://en.wikipedia.org/wiki/Mercury_(planet)."),
    ).toBe("Sources: [en.wikipedia.org](https://en.wikipedia.org/wiki/Mercury_%28planet%29).");
  });

  test("idempotent — a second pass does not re-encode %28/%29", () => {
    const once = linkifySourcesLines("Sources: https://en.wikipedia.org/wiki/Foo_(bar)");
    expect(linkifySourcesLines(once)).toBe(once);
    expect(once).not.toContain("%2528");
  });

  test("mixed line: bare parens URL + markdown parens link both encoded", () => {
    const line =
      "Sources: https://en.wikipedia.org/wiki/A_(b), [c.org](https://c.org/d_(e))";
    expect(linkifySourcesLines(line)).toBe(
      "Sources: [en.wikipedia.org](https://en.wikipedia.org/wiki/A_%28b%29), [c.org](https://c.org/d_%28e%29)",
    );
  });
});

// FIX 1 end-to-end: a Sources line with a parenthesized URL, piped through the
// real render path (assembleFactcheckAnswer → the shared formatWebHtml markdown
// parser), yields an <a href> equal to the FULL encoded URL with no truncated
// href and no dangling `(bar)` text after the anchor.
describe("factcheck Sources render path (assemble → formatWebHtml)", () => {
  const anchorHref = (html: string): string | null => {
    const m = html.match(/<a href="([^"]*)"[^>]*>([^<]*)<\/a>/);
    return m ? m[1]! : null;
  };

  test("bare Wikipedia disambig URL renders one <a> with the full encoded href", () => {
    const block =
      "### ✅ Claim 1/1 — Mercury\n\nSupported.\n\nSources: https://en.wikipedia.org/wiki/Mercury_(planet)";
    const html = formatWebHtml(assembleFactcheckAnswer("", [block]));
    expect(anchorHref(html)).toBe("https://en.wikipedia.org/wiki/Mercury_%28planet%29");
    // No truncated href and no dangling text after the anchor.
    expect(html).not.toContain('href="https://en.wikipedia.org/wiki/Mercury_"');
    expect(html).not.toContain("(planet)");
  });

  test("model-emitted markdown link with parens in the href renders the full href", () => {
    const block =
      "### ✅ Claim 1/1 — Mercury\n\nSupported.\n\nSources: [en.wikipedia.org](https://en.wikipedia.org/wiki/Mercury_(planet))";
    const html = formatWebHtml(assembleFactcheckAnswer("", [block]));
    expect(anchorHref(html)).toBe("https://en.wikipedia.org/wiki/Mercury_%28planet%29");
    expect(html).not.toContain("(planet)");
    // Exactly one anchor — the parens didn't spawn a stray truncated link.
    expect(html.match(/<a /g)?.length ?? 0).toBe(1);
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

describe("claimsEventPayload", () => {
  test("1-based indexes, and an absent quote stays absent (never \"\")", () => {
    expect(
      claimsEventPayload([
        { title: "Ships 4M units", quote: "The device ships 4M units per year." },
        { title: "An implicit claim" },
      ]),
    ).toEqual([
      { index: 1, title: "Ships 4M units", quote: "The device ships 4M units per year." },
      { index: 2, title: "An implicit claim" },
    ]);
  });

  test("an over-cap quote is DROPPED, not truncated — parity with the propose route", () => {
    // A truncated quote could resolve to a different span than the model meant, and
    // the propose route rejects anything over the cap anyway: so the value that
    // survives extraction is exactly the value that survives propose.
    const out = claimsEventPayload([
      { title: "too long", quote: "x".repeat(CLAIM_QUOTE_MAX + 1) },
      { title: "exactly at the cap", quote: "y".repeat(CLAIM_QUOTE_MAX) },
    ]);
    expect(out[0]).toEqual({ index: 1, title: "too long" });
    expect(out[1]!.quote).toHaveLength(CLAIM_QUOTE_MAX);
  });

  test("a blank / whitespace-only quote is omitted", () => {
    expect(claimsEventPayload([{ title: "a", quote: "   " }, { title: "b", quote: "" }])).toEqual([
      { index: 1, title: "a" },
      { index: 2, title: "b" },
    ]);
  });

  test("the cap is measured on the TRIMMED quote (padding alone can't drop it)", () => {
    const padded = "  " + "z".repeat(CLAIM_QUOTE_MAX) + "  ";
    expect(claimsEventPayload([{ title: "a", quote: padded }])[0]!.quote).toBe(padded);
  });
});

describe("classifyClaimFailure", () => {
  // The four literal strings the connectors throw. Pinned verbatim (not
  // regex-ish paraphrases) so a reworded connector message fails HERE rather
  // than silently relabelling every timed-out claim as an error in production.
  const CONNECTOR_TIMEOUTS: [string, string][] = [
    ["claude-sdk", "Claude Agent SDK timed out after 90000ms"],
    ["claude-cli", "Claude timed out after 110000ms"],
    ["copilot-sdk", "Copilot SDK timed out after 45000ms"],
    ["openai-compat", "OpenAI-compat request timed out after 30000ms"],
  ];

  for (const [connector, message] of CONNECTOR_TIMEOUTS) {
    test(`${connector}'s literal throw string reads as a timeout, with its budget`, () => {
      const out = classifyClaimFailure(message);
      expect(out.isTimeout).toBe(true);
      expect(out.ms).toBe(Number(message.match(/(\d+)ms/)![1]));
    });
  }

  test("a non-timeout connector error is NOT a timeout", () => {
    expect(classifyClaimFailure("OpenAI-compat API error 500: upstream exploded")).toEqual({
      isTimeout: false,
      ms: null,
      msRejected: false,
    });
  });

  test("an empty / reasonless message is not a timeout", () => {
    expect(classifyClaimFailure("")).toEqual({ isTimeout: false, ms: null, msRejected: false });
  });

  test("timeout detection is case-insensitive", () => {
    expect(classifyClaimFailure("Request TIMED OUT AFTER 5000ms").isTimeout).toBe(true);
  });

  test("an UPPERCASE unit still yields its budget (phrase and unit share one pattern)", () => {
    // A case-insensitive phrase test beside a case-sensitive unit test read the
    // message as a timeout and then lost the number it named.
    expect(classifyClaimFailure("CLAUDE TIMED OUT AFTER 110000MS")).toEqual({
      isTimeout: true,
      ms: 110_000,
      msRejected: false,
    });
  });

  test("an earlier `ms` token elsewhere in the message never wins over the clause", () => {
    // A fetched URL carrying its own `ms` token, BEFORE the timeout clause: an
    // unanchored `(\d+)\s*ms` takes the URL's figure and renders "0s".
    const out = classifyClaimFailure(
      "Claude Agent SDK timed out after 110000ms while fetching https://ex.com/a?delay=250ms",
    );
    expect(out).toEqual({ isTimeout: true, ms: 110_000, msRejected: false });

    const before = classifyClaimFailure(
      "WebFetch https://ex.com/a?delay=250ms failed: Claude Agent SDK timed out after 110000ms",
    );
    expect(before.ms).toBe(110_000);
  });

  test("a wrapped message takes the figure adjacent to the OUTER clause", () => {
    // Two clauses, two budgets — the first (the caller we are reporting on) wins.
    expect(
      classifyClaimFailure(
        "Claude Agent SDK timed out after 110000ms (upstream: request timed out after 5000ms)",
      ).ms,
    ).toBe(110_000);
  });

  test("a CLI crash passthrough is an error, even when stderr says 'timed out after'", () => {
    // `ai/executor.ts` throws `Claude exited with code <n>: <stderr>` and stderr is
    // whatever the child wrote. Reporting that as ⏱️ invents a budget this route
    // never set and hides that the process died.
    const wrapped =
      "Claude exited with code 1: Error: connection to upstream timed out after 30000ms\n" +
      "    at Object.<anonymous> (/app/dist/index.js:42:11)";
    expect(classifyClaimFailure(wrapped)).toEqual({
      isTimeout: false,
      ms: null,
      msRejected: false,
    });
  });

  test("a timeout with no millisecond figure yields ms=null and NO rejection", () => {
    // Nothing was named ⇒ the caller may honestly stand the constant in for it.
    expect(classifyClaimFailure("Claude timed out after a while")).toEqual({
      isTimeout: true,
      ms: null,
      msRejected: false,
    });
  });

  test("tolerates a space between the number and the unit", () => {
    expect(classifyClaimFailure("Claude timed out after 90000 ms").ms).toBe(90_000);
  });

  test("an implausible budget is rejected AND flagged, so the caller can't stand the constant in", () => {
    // Over the absolute 1h plausibility window — a nested/foreign figure.
    expect(classifyClaimFailure("Claude timed out after 99999999ms")).toEqual({
      isTimeout: true,
      ms: null,
      msRejected: true,
    });
    expect(classifyClaimFailure("Claude timed out after 0ms")).toEqual({
      isTimeout: true,
      ms: null,
      msRejected: true,
    });
  });

  test("the window is ABSOLUTE, so a test-shortened budget still parses", () => {
    // The guard must not be a ratio against FACTCHECK_CLAIM_TIMEOUT_MS: a 50ms
    // budget is wildly off that constant and still perfectly legitimate.
    expect(classifyClaimFailure("Claude Agent SDK timed out after 50ms").ms).toBe(50);
    expect(classifyClaimFailure(`Claude timed out after ${FACTCHECK_CLAIM_TIMEOUT_MS}ms`).ms).toBe(
      FACTCHECK_CLAIM_TIMEOUT_MS,
    );
  });
});

describe("claimTimeoutReason", () => {
  test("a message-named budget is reported verbatim, in seconds", () => {
    expect(claimTimeoutReason({ ms: 90_000, msRejected: false })).toBe(
      "Verification timed out after 90s — the claim was not checked.",
    );
  });

  test("NO figure in the message ⇒ the constant stands in for it", () => {
    expect(claimTimeoutReason({ ms: null, msRejected: false })).toBe(
      `Verification timed out after ${Math.round(FACTCHECK_CLAIM_TIMEOUT_MS / 1000)}s — the claim was not checked.`,
    );
  });

  test("a REJECTED figure ⇒ figure-free prose, never the constant", () => {
    // The constant here would print a measured-looking number over a figure we
    // just refused to believe.
    const out = claimTimeoutReason({ ms: null, msRejected: true });
    expect(out).toBe("Verification timed out — the claim was not checked.");
    expect(out).not.toContain("s —");
    expect(out).not.toContain(String(Math.round(FACTCHECK_CLAIM_TIMEOUT_MS / 1000)));
  });

  test("end to end: an implausible budget never renders the constant", () => {
    const failure = classifyClaimFailure("Claude timed out after 0ms");
    expect(claimTimeoutReason(failure)).toBe("Verification timed out — the claim was not checked.");
  });
});

describe("shortFailureReason", () => {
  test("flattens newlines and ends the clause with a period", () => {
    expect(shortFailureReason("upstream\n  exploded")).toBe("upstream exploded.");
  });

  test("keeps an existing terminator", () => {
    expect(shortFailureReason("upstream exploded!")).toBe("upstream exploded!");
  });

  test("bounds a blob and marks the clip", () => {
    const out = shortFailureReason("x".repeat(500));
    expect(out).toHaveLength(200);
    expect(out.endsWith("…")).toBe(true);
  });

  test("a blank message still yields a sentence", () => {
    expect(shortFailureReason("   ")).toBe("the verifier reported no reason.");
  });
});

describe("pairToolEvents", () => {
  const start = (id: string, name = "WebFetch", atMs = 0, input?: string): StampedToolEvent => ({
    event: { type: "tool_start", id, name, displayName: name, ...(input ? { input } : {}) },
    atMs,
  });
  const end = (id: string, name = "WebFetch", atMs = 0): StampedToolEvent => ({
    event: { type: "tool_end", id, name, displayName: name, outputSize: 10 },
    atMs,
  });

  test("zero events → zero tool calls", () => {
    expect(pairToolEvents([], 1_000, 2_000)).toEqual([]);
  });

  test("interleaved same-name starts/ends pair by id, not arrival order", () => {
    // Two WebFetches in flight at once, finishing in REVERSE order — the case a
    // LIFO-by-displayName heuristic gets wrong (it would swap the durations).
    const out = pairToolEvents(
      [start("a", "WebFetch", 1_100), start("b", "WebFetch", 1_200), end("b", "WebFetch", 1_500), end("a", "WebFetch", 1_900)],
      1_000,
      3_000,
    );
    expect(out.map((t) => t.id)).toEqual(["a", "b"]); // start order
    expect(out.find((t) => t.id === "a")).toMatchObject({ durationMs: 800, startOffsetMs: 100 });
    expect(out.find((t) => t.id === "b")).toMatchObject({ durationMs: 300, startOffsetMs: 200 });
    expect(out.every((t) => t.unterminated === undefined)).toBe(true);
  });

  test("an unpaired start runs to the failure instant and is flagged unterminated", () => {
    const out = pairToolEvents(
      [start("a", "WebFetch", 1_100), end("a", "WebFetch", 1_400), start("b", "WebSearch", 1_500, '{"q":"x"}')],
      1_000,
      3_000,
    );
    expect(out).toHaveLength(2);
    const hung = out[1]!;
    expect(hung).toMatchObject({
      id: "b",
      displayName: "WebSearch",
      durationMs: 1_500, // 3000 − 1500
      startOffsetMs: 500,
      input: '{"q":"x"}',
      unterminated: true,
    });
    // The completed sibling is NOT flagged.
    expect(out[0]!.unterminated).toBeUndefined();
  });

  test("an unpaired END is dropped (no start instant to anchor or measure it)", () => {
    expect(pairToolEvents([end("ghost", "WebFetch", 1_500)], 1_000, 3_000)).toEqual([]);
  });

  test("offsets and durations are clamped at 0, never negative", () => {
    // A start stamped before the span-start instant (clock jitter at the seam).
    const out = pairToolEvents([start("a", "WebFetch", 900), end("a", "WebFetch", 800)], 1_000, 3_000);
    expect(out[0]).toMatchObject({ startOffsetMs: 0, durationMs: 0 });
  });

  test("input is omitted when the start carried none", () => {
    const out = pairToolEvents([start("a", "Read", 1_000)], 1_000, 2_000);
    expect("input" in out[0]!).toBe(false);
  });

  test("id-less starts each survive as their own unterminated call, never collapsed", () => {
    // `id` is typed required but three emit sites read it off untyped runtime
    // JSON, so `undefined` is reachable. Keyed naively, all in-flight starts
    // collapse onto ONE map entry and every earlier call vanishes.
    const out = pairToolEvents(
      [
        start("", "WebFetch", 1_100),
        start(undefined as unknown as string, "WebFetch", 1_200),
        start(undefined as unknown as string, "WebSearch", 1_300),
      ],
      1_000,
      3_000,
    );
    expect(out).toHaveLength(3);
    expect(out.map((t) => t.displayName)).toEqual(["WebFetch", "WebFetch", "WebSearch"]);
    // Unpairable by construction, so each is honestly reported as still running.
    expect(out.every((t) => t.unterminated === true)).toBe(true);
    expect(out.map((t) => t.startOffsetMs)).toEqual([100, 200, 300]);
    // The synthetic keys are distinct, so nothing shares a toolId on the spans.
    expect(new Set(out.map((t) => t.id)).size).toBe(3);
  });

  test("an id-less END is dropped rather than closing an unrelated call", () => {
    const out = pairToolEvents(
      [start("", "WebFetch", 1_100), end("", "WebFetch", 1_400)],
      1_000,
      3_000,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ displayName: "WebFetch", unterminated: true });
  });

  test("a duplicated start id flushes the displaced call as unterminated, never deletes it", () => {
    // A connector reusing an id must cost the earlier call its END pairing, not
    // its existence — this function is the only surviving record of the call.
    const out = pairToolEvents(
      [start("dup", "WebFetch", 1_100), start("dup", "WebSearch", 1_200), end("dup", "WebSearch", 1_600)],
      1_000,
      3_000,
    );
    expect(out).toHaveLength(2);
    // Output stays in START order.
    expect(out.map((t) => t.displayName)).toEqual(["WebFetch", "WebSearch"]);
    expect(out[0]).toMatchObject({ startOffsetMs: 100, durationMs: 1_900, unterminated: true });
    // The end belongs to the latest start — the only one it could belong to.
    expect(out[1]).toMatchObject({ startOffsetMs: 200, durationMs: 400 });
    expect(out[1]!.unterminated).toBeUndefined();
  });
});

/**
 * What claim extraction READS.
 *
 * Extraction used to run over the raw stripped body, so the model happily quoted a
 * mermaid node or a code comment — a claim that is perfectly checkable and can never
 * be MARKED, because the integrate pass MASKS fenced blocks and the anchor then
 * resolves to nothing ("no longer found in the page"). Measured on
 * `life/sources/Neurochemical Focus Stack…mdx`: one of eight claims was quoted out
 * of the mermaid diagram, and the prose sentence two lines below it says the same
 * thing and marks cleanly. The two passes now read the same masked text, so the
 * extractor no longer sees the text the annotator cannot resolve.
 *
 * NOT the stronger claim that every anchor the extractor produces resolves: the model
 * still reads the PLACEHOLDERS (`[code block omitted]`, `[component tag omitted]`,
 * `[frontmatter omitted]`) and can quote into or across one, which exists in neither
 * the raw body nor the match mask and drops the same way. That is a smaller door, not
 * a closed one.
 */
describe("claimExtractionText", () => {
  const BODY =
    "---\ntype: source\ntitle: T\n---\n\n" +
    "# T\n\nThe stack is taken 20-30 minutes before deep work.\n\n" +
    "```mermaid\nflowchart LR\n    D --> E[\"Wait 20-30 min\"]\n```\n\n" +
    "<Callout>\nTreat the dosing claims as unverified.\n</Callout>\n";

  test("article mode hides fenced blocks behind the integrate placeholder", () => {
    const out = claimExtractionText({ mode: "article", sel: "", strippedBody: BODY, isMdx: true });
    expect(out).not.toContain("flowchart LR");
    expect(out).not.toContain("Wait 20-30 min");
    expect(out).toContain("[code block omitted]");
  });

  test("the prose the extractor should anchor on instead is untouched", () => {
    // The point of the mask is not to remove claims, it is to move the anchor onto
    // text the annotator can find. Prose — including prose INSIDE a component — must
    // survive verbatim, or the mask has traded one unmarkable claim for none at all.
    const out = claimExtractionText({ mode: "article", sel: "", strippedBody: BODY, isMdx: true });
    expect(out).toContain("The stack is taken 20-30 minutes before deep work.");
    expect(out).toContain("Treat the dosing claims as unverified.");
  });

  test("`isMdx` decides component TAG masking and is threaded, not assumed", () => {
    const mdx = claimExtractionText({ mode: "article", sel: "", strippedBody: BODY, isMdx: true });
    const md = claimExtractionText({ mode: "article", sel: "", strippedBody: BODY, isMdx: false });
    expect(mdx).not.toContain("<Callout>");
    expect(md).toContain("<Callout>");
    // The FENCE mask is extension-independent — a `.md` page's code block is just as
    // unmarkable — so both sides hide it.
    expect(md).not.toContain("flowchart LR");
  });

  test("the cap is applied AFTER the mask", () => {
    // A code-heavy page used to spend its whole extraction budget on fences the
    // annotator cannot anchor in. `max` counts the text the model actually reads.
    const fence = "```ts\n" + "const x = 1;\n".repeat(200) + "```\n\n";
    const tail = "The tail sentence is the checkable claim.";
    const out = claimExtractionText({
      mode: "article", sel: "", strippedBody: fence + tail, isMdx: false, max: 200,
    });
    expect(out).toContain(tail);
    expect(out.length).toBeLessThanOrEqual(200);
  });

  test("the ROUTE passes isMdx — the one line no behavioural test can reach", () => {
    // Every test above hands `isMdx` in directly, so dropping the field at the call
    // site (or passing `annotatable`, the POLICY twin of the same extension test)
    // would leave component tags visible to the extractor with nothing failing. The
    // handler builds its opts inside a Hono route and cannot be driven from a unit
    // test, so this is a SOURCE assertion — the house pattern already used to refuse
    // a bare `fetch(` under `src/chat/views/` and a bare `postgres()` under `src/`.
    // It pins the wiring's existence, not its value; the derivation itself is the
    // same `endsWith(".mdx")` the integrate route uses two functions away.
    const routes = readFileSync(
      new URL("./wiki-routes.ts", import.meta.url).pathname,
      "utf8",
    );
    // Both assertions are scoped to THIS handler — from its `let isMdx` declaration
    // to its `streamFactcheckSSE` call. A whole-file `toContain` is vacuous here: the
    // two integrate routes spell `const isMdx = meta.relPath.endsWith(".mdx")` of
    // their own, so a mutation of the factcheck derivation still finds a match
    // elsewhere in the file (measured — that mutant survived the first spelling).
    const from = routes.indexOf("let isMdx = false;");
    const to = routes.indexOf("return streamFactcheckSSE(c, {", from);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const handler = routes.slice(from, to);
    // Derived from the resolved PATH, never from `annotatable` (the policy twin).
    expect(handler).toContain('isMdx = meta.relPath.endsWith(".mdx")');
    expect(handler).not.toContain("isMdx = isAnnotatablePage");
    // …and actually handed over.
    const call = routes.slice(to);
    expect(call.slice(0, call.indexOf("\n    });"))).toContain("isMdx,");
  });

  test("sel mode passes the reader's selection through untouched", () => {
    // A selection is a FRAGMENT: its fences need not be balanced, so masking one is
    // guesswork — and a reader who selected a code block asked about that code. The
    // article body is not consulted at all in this mode.
    const sel = "```ts\nconst answer = 42;\n```";
    expect(claimExtractionText({ mode: "sel", sel, strippedBody: BODY, isMdx: true })).toBe(sel);
  });
});
