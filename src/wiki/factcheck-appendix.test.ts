/**
 * `buildFactcheckAppendix` — the `<FactCheck>` component form of the persisted
 * fact-check block, written to native `.mdx` pages.
 *
 * The headline test is ACCEPTANCE 1 of the annotation slice: a pinned
 * persisted-answer fixture in, and the approved page fixture's `<FactCheck>` block
 * out, BYTE FOR BYTE. The appendix is the one surface a human already signed off on
 * (`factcheck-annotated-page.mdx`, approved in the real reader), so "close enough"
 * is not a passing grade — a drifted blank line changes how the reader renders the
 * claim sections, and the fixture is the only record of what was approved.
 */

import { test, expect, describe } from "bun:test";
import {
  buildFactcheckAppendix,
  buildFactcheckBlock,
  FACTCHECK_SENTINEL_START,
  FACTCHECK_SENTINEL_END,
} from "./factcheck-context.ts";
import { CREATINE_ORIGINALS } from "./__fixtures__/factcheck-creatine-originals.ts";

const ANNOTATED_PAGE = await Bun.file(
  new URL("./__fixtures__/factcheck-annotated-page.mdx", import.meta.url),
).text();
const CREATINE_ANSWER = await Bun.file(
  new URL("./__fixtures__/factcheck-creatine-answer.md", import.meta.url),
).text();

/** The approved fixture's persisted block, sentinels included. */
function approvedBlock(): string {
  const s = ANNOTATED_PAGE.indexOf(FACTCHECK_SENTINEL_START);
  const e = ANNOTATED_PAGE.indexOf(FACTCHECK_SENTINEL_END) + FACTCHECK_SENTINEL_END.length;
  expect(s).toBeGreaterThan(-1);
  return ANNOTATED_PAGE.slice(s, e);
}

test("ACCEPTANCE 1 — the appendix reproduces the approved fixture byte for byte", () => {
  const got = buildFactcheckAppendix(CREATINE_ANSWER, "2026-07-29", {
    originals: CREATINE_ORIGINALS,
  });
  expect(got).toBe(approvedBlock());
});

test("the date is the only thing that moves — same answer, different day", () => {
  const a = buildFactcheckAppendix(CREATINE_ANSWER, "2026-07-29", { originals: CREATINE_ORIGINALS });
  const b = buildFactcheckAppendix(CREATINE_ANSWER, "2026-08-01", { originals: CREATINE_ORIGINALS });
  expect(b).toBe(a.replace('date="2026-07-29"', 'date="2026-08-01"'));
});

describe("deterministic transform", () => {
  const answer = [
    "An overall assessment lede that must not survive into the appendix.",
    "",
    "### ✅ Claim 1/4 — first confirmed",
    "",
    "Reasoning one.",
    "",
    "Confidence: 90/100",
    "",
    "### ❓ Claim 2/4 — unverifiable",
    "",
    "Skipped — the fact check ran out of time.",
    "",
    "### ❌ Claim 3/4 — contradicted",
    "",
    "Reasoning three.",
    "",
    "Confidence: 80/100",
    "",
    "### ⚠️ Claim 4/4 — partly supported",
    "",
    "Reasoning four.",
    "",
    "Confidence: 55/100",
    "",
  ].join("\n");

  test("drops the compose lede", () => {
    const out = buildFactcheckAppendix(answer, "2026-07-29");
    expect(out).not.toContain("overall assessment lede");
  });

  test("orders by SEVERITY — ❌ then ⚠️ then ✅", () => {
    const out = buildFactcheckAppendix(answer, "2026-07-29");
    expect(out.indexOf("Claim 3/4")).toBeLessThan(out.indexOf("Claim 4/4"));
    expect(out.indexOf("Claim 4/4")).toBeLessThan(out.indexOf("Claim 1/4"));
  });

  test("index order WITHIN a tier", () => {
    const twoOk = [
      "### ✅ Claim 5/5 — later",
      "",
      "Reasoning.",
      "",
      "### ✅ Claim 2/5 — earlier",
      "",
      "Reasoning.",
    ].join("\n");
    const out = buildFactcheckAppendix(twoOk, "2026-07-29");
    expect(out.indexOf("Claim 2/5")).toBeLessThan(out.indexOf("Claim 5/5"));
  });

  test("❓ claims leave the body but are COUNTED in unknown=", () => {
    const out = buildFactcheckAppendix(answer, "2026-07-29");
    expect(out).not.toContain("Claim 2/4");
    expect(out).not.toContain("ran out of time");
    // Without this attr a deadline-truncated run renders as a clean ✓/⚠/✗ page.
    expect(out).toContain('unknown="1"');
  });

  test("zero counts are OMITTED, never emitted as 0", () => {
    const allOk = "### ✅ Claim 1/1 — fine\n\nReasoning.\n";
    const out = buildFactcheckAppendix(allOk, "2026-07-29");
    expect(out).toContain('<FactCheck date="2026-07-29" ok="1">');
    expect(out).not.toContain('bad="0"');
    expect(out).not.toContain('unknown="0"');
  });
});

describe("tag neutralization (the answer is CLIENT-POSTED)", () => {
  test("a literal `</FactCheck>` line cannot close the block early", () => {
    const answer = [
      "### ✅ Claim 1/2 — first",
      "",
      "Reasoning that quotes the markup:",
      "</FactCheck>",
      "",
      "Confidence: 90/100",
      "",
      "### ✅ Claim 2/2 — second",
      "",
      "Reasoning two.",
    ].join("\n");
    const out = buildFactcheckAppendix(answer, "2026-07-29");
    // Exactly ONE real closing tag, and it is the last line of the component.
    expect(out.split("</FactCheck>").length - 1).toBe(1);
    expect(out.indexOf("</FactCheck>")).toBeGreaterThan(out.indexOf("Claim 2/2"));
    // The quoted text survives, defanged.
    expect(out).toContain("/FactCheck");
    // …and the second claim is still inside the block, not stranded after it.
    const closeAt = out.indexOf("</FactCheck>");
    expect(out.indexOf("Reasoning two.")).toBeLessThan(closeAt);
  });

  test("a line-owning component tag cannot become a real nested component", () => {
    const answer = ["### ✅ Claim 1/1 — first", "", "<Callout>", "Injected.", "</Callout>"].join("\n");
    const out = buildFactcheckAppendix(answer, "2026-07-29");
    expect(out).not.toContain("<Callout>");
    expect(out).not.toContain("</Callout>");
    expect(out).toContain("Callout");
  });

  test("an embedded end sentinel is neutralized, as in the .md form", () => {
    const answer = `### ✅ Claim 1/1 — first\n\n${FACTCHECK_SENTINEL_END} quoted.\n`;
    const out = buildFactcheckAppendix(answer, "2026-07-29");
    expect(out.split(FACTCHECK_SENTINEL_END).length - 1).toBe(1);
  });
});

describe("Was: lines", () => {
  const answer = [
    "### ❌ Claim 1/1 — contradicted",
    "",
    "Reasoning.",
    "",
    "Confidence: 80/100",
    "",
    "Sources: [a.com](https://a.com/x)",
  ].join("\n");

  test("sits as its own paragraph immediately BEFORE Confidence:", () => {
    const out = buildFactcheckAppendix(answer, "2026-07-29", {
      originals: new Map([[1, "The old sentence."]]),
    });
    const lines = out.split("\n");
    const was = lines.findIndex((l) => l.startsWith("Was:"));
    expect(was).toBeGreaterThan(-1);
    expect(lines[was - 1]).toBe("");
    expect(lines[was + 1]).toBe("");
    expect(lines[was + 2]).toBe("Confidence: 80/100");
  });

  test("appends at block end when the model omitted Confidence:", () => {
    const noConf = "### ❌ Claim 1/1 — contradicted\n\nReasoning only.\n";
    const out = buildFactcheckAppendix(noConf, "2026-07-29", {
      originals: new Map([[1, "The old sentence."]]),
    });
    const body = out.slice(0, out.indexOf("</FactCheck>")).trimEnd();
    expect(body.endsWith("Was: The old sentence.")).toBe(true);
  });

  test("absent when no originals are passed — the ➕ append route can never make one", () => {
    expect(buildFactcheckAppendix(answer, "2026-07-29")).not.toContain("Was:");
  });

  test("whitespace in the original is collapsed onto one line", () => {
    const out = buildFactcheckAppendix(answer, "2026-07-29", {
      originals: new Map([[1, "  wrapped\n   original  text  "]]),
    });
    expect(out).toContain("Was: wrapped original text");
  });
});

test("the .md blockquote form is untouched by any of this", () => {
  const answer = "### ✅ Claim 1/1 — fine\n\nReasoning.\n";
  const md = buildFactcheckBlock(answer, "2026-07-29");
  expect(md).toContain("> [!factcheck] Fact check (2026-07-29)");
  expect(md).not.toContain("<FactCheck");
});

describe("malformed markup can't eat the evidence", () => {
  test("a MALFORMED component tag defangs only its own line", () => {
    // The single-line tag source is what stops `<Callout tone=` from swallowing
    // every following line up to the next `>` — including blockquote markers, the
    // `Confidence:` line and any autolink.
    const answer = [
      "### ❌ Claim 1/1 — contradicted",
      "",
      "<Callout tone=",
      "> quoted evidence line",
      "",
      "Confidence: 80/100",
      "",
      "Sources: [a.com](https://a.com/x)",
    ].join("\n");
    const out = buildFactcheckAppendix(answer, "2026-07-29");
    expect(out).toContain("> quoted evidence line");
    expect(out).toContain("Confidence: 80/100");
    expect(out).toContain("[a.com](https://a.com/x)");
  });

  test("a `Was:` original is neutralized like the answer", () => {
    const answer = "### ❌ Claim 1/1 — contradicted\n\nReasoning.\n\nConfidence: 80/100\n";
    const out = buildFactcheckAppendix(answer, "2026-07-29", {
      originals: new Map([[1, "</FactCheck> was the old line"]]),
    });
    // Exactly ONE real closing tag, still the component's own.
    expect(out.split("</FactCheck>").length - 1).toBe(1);
    expect(out).toContain("Was: /FactCheck was the old line");
    // An embedded end sentinel in an original can't strand the block either.
    const sentinel = buildFactcheckAppendix(answer, "2026-07-29", {
      originals: new Map([[1, `${FACTCHECK_SENTINEL_END} old`]]),
    });
    expect(sentinel.split(FACTCHECK_SENTINEL_END).length - 1).toBe(1);
  });
});

test("an answer with NO parsed claim falls back to the blockquote form, never an empty block", () => {
  // An empty `<FactCheck>` block persisted by the ➕ route would discard the whole
  // answer — the one outcome worse than the wrong container.
  const answer = "The check ran but wrote no claim headings.\n\nJust prose.";
  const out = buildFactcheckAppendix(answer, "2026-07-29");
  expect(out).not.toContain("<FactCheck");
  expect(out).toContain("> [!factcheck] Fact check (2026-07-29)");
  expect(out).toContain("The check ran but wrote no claim headings.");
  expect(out).toContain("Just prose.");
});
