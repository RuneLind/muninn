import { test, expect, describe } from "bun:test";
import {
  buildClaimExtractionPrompt,
  parseClaimList,
  buildClaimVerifyPrompt,
  buildComposePrompt,
  stripFactcheckBlock,
  FACTCHECK_SENTINEL_START,
  FACTCHECK_SENTINEL_END,
  FACTCHECK_MAX_CLAIMS,
  type Claim,
} from "./factcheck-context.ts";

describe("stripFactcheckBlock", () => {
  test("removes a sentinel-wrapped block, keeping surrounding body", () => {
    const body = `Real content here.\n\n${FACTCHECK_SENTINEL_START}\n## Fact check\n✅ **Claim** supported.\n${FACTCHECK_SENTINEL_END}\n\nMore content.`;
    const out = stripFactcheckBlock(body);
    expect(out).toContain("Real content here.");
    expect(out).toContain("More content.");
    expect(out).not.toContain("Fact check");
    expect(out).not.toContain(FACTCHECK_SENTINEL_START);
    expect(out).not.toContain(FACTCHECK_SENTINEL_END);
  });

  test("removes multiple blocks", () => {
    const body = `A\n${FACTCHECK_SENTINEL_START}one${FACTCHECK_SENTINEL_END}\nB\n${FACTCHECK_SENTINEL_START}two${FACTCHECK_SENTINEL_END}\nC`;
    const out = stripFactcheckBlock(body);
    expect(out).not.toContain("one");
    expect(out).not.toContain("two");
    expect(out).toContain("A");
    expect(out).toContain("B");
    expect(out).toContain("C");
  });

  test("is a no-op on a body with no block", () => {
    const body = "Just a normal page with no fact-check block.";
    expect(stripFactcheckBlock(body)).toBe(body);
  });
});

describe("buildClaimExtractionPrompt", () => {
  test("frames the text + title and asks for capped JSON claims", () => {
    const out = buildClaimExtractionPrompt("Claude 3.5 Sonnet was released in June 2024.", "Model History", 5);
    expect(out).toContain('from the article "Model History"');
    expect(out).toContain("Claude 3.5 Sonnet was released in June 2024.");
    expect(out).toContain("up to 5 claims");
    expect(out).toContain('{"claims":');
    expect(out).toContain("empty array");
  });

  test("respects the cap value", () => {
    expect(buildClaimExtractionPrompt("x", "T", FACTCHECK_MAX_CLAIMS)).toContain(
      `up to ${FACTCHECK_MAX_CLAIMS} claims`,
    );
  });
});

describe("parseClaimList", () => {
  test("parses a well-formed {claims:[…]} object", () => {
    const raw = '{"claims":[{"title":"Eiffel Tower completed 1889","quote":"completed in 1889"},{"title":"In Paris"}]}';
    const out = parseClaimList(raw);
    expect(out).toEqual([
      { title: "Eiffel Tower completed 1889", quote: "completed in 1889" },
      { title: "In Paris" },
    ]);
  });

  test("tolerates markdown fences around the JSON", () => {
    const raw = '```json\n{"claims":[{"title":"A"}]}\n```';
    expect(parseClaimList(raw)).toEqual([{ title: "A" }]);
  });

  test("accepts a bare array (dropped wrapper)", () => {
    expect(parseClaimList('[{"title":"A"},{"title":"B"}]')).toEqual([{ title: "A" }, { title: "B" }]);
  });

  test("drops claims with a missing/blank title", () => {
    const raw = '{"claims":[{"title":""},{"title":"Good"},{"quote":"no title"},{"title":"   "}]}';
    expect(parseClaimList(raw)).toEqual([{ title: "Good" }]);
  });

  test("drops a non-string quote", () => {
    const raw = '{"claims":[{"title":"A","quote":42}]}';
    expect(parseClaimList(raw)).toEqual([{ title: "A" }]);
  });

  test("returns null for an empty claim list (⇒ clean app_error)", () => {
    expect(parseClaimList('{"claims":[]}')).toBeNull();
    expect(parseClaimList('{"claims":[{"title":""}]}')).toBeNull();
  });

  test("returns null on unparseable / wrong-shaped input", () => {
    expect(parseClaimList("not json at all")).toBeNull();
    expect(parseClaimList('{"nope":1}')).toBeNull();
    expect(parseClaimList("")).toBeNull();
  });
});

describe("buildClaimVerifyPrompt", () => {
  const claim: Claim = { title: "Eiffel Tower completed 1889", quote: "The Eiffel Tower was completed in 1889." };

  test("carries the web-verification + verdict-discipline system prompt", () => {
    const { systemPrompt } = buildClaimVerifyPrompt(claim, {
      index: 1, total: 3, pageTitle: "P", wikiName: "w", mode: "article",
    });
    expect(systemPrompt).toContain("WebFetch");
    expect(systemPrompt).toContain("Cite ONLY URLs you actually opened");
    expect(systemPrompt).toContain("A ✅ verdict REQUIRES at least one URL you actually OPENED with WebFetch");
    expect(systemPrompt).toContain("cap the verdict at ⚠️");
    expect(systemPrompt).toContain("NO first-person or meta commentary");
    expect(systemPrompt).toContain("`Sources:` line");
    expect(systemPrompt).toContain("### <verdict emoji> Claim <n>/<total> — <short claim title>");
    expect(systemPrompt).toContain("output ONLY this ONE block");
  });

  test("the Sources contract asks for markdown links, not bare URLs", () => {
    const { systemPrompt } = buildClaimVerifyPrompt(claim, {
      index: 1, total: 3, pageTitle: "P", wikiName: "w", mode: "article",
    });
    expect(systemPrompt).toContain("markdown link `[hostname](url)`");
  });

  test("carries the confidence rubric + a `Confidence: NN/100` output line", () => {
    const { systemPrompt } = buildClaimVerifyPrompt(claim, {
      index: 1, total: 3, pageTitle: "P", wikiName: "w", mode: "article",
    });
    // The rubric is anchored in the prompt (evidence strength, not the verdict).
    expect(systemPrompt).toContain("Confidence rubric");
    expect(systemPrompt).toContain("90–100");
    expect(systemPrompt).toContain("70–89");
    expect(systemPrompt).toContain("40–69");
    expect(systemPrompt).toContain("below 40");
    // The output contract gains the line, after the reasoning + before Sources.
    expect(systemPrompt).toContain("`Confidence: NN/100`");
    const confIdx = systemPrompt.indexOf("`Confidence: NN/100`");
    const srcIdx = systemPrompt.indexOf("A `Sources:` line");
    expect(confIdx).toBeGreaterThan(-1);
    expect(srcIdx).toBeGreaterThan(confIdx); // Confidence precedes Sources
    // FIX 3d — the Confidence line must be mandated as a standalone paragraph
    // (blank line before it), so every downstream renderer keeps it on its own line.
    expect(systemPrompt).toContain("OWN standalone paragraph");
    expect(systemPrompt).toContain("preceded by a blank line");
    // The block-heading contract is UNTOUCHED — still the exact ### emoji form.
    expect(systemPrompt).toContain("### <verdict emoji> Claim <n>/<total> — <short claim title>");
  });

  test("fixes the exact Claim n/total heading + includes the claim + quote", () => {
    const { userPrompt } = buildClaimVerifyPrompt(claim, {
      index: 3, total: 8, pageTitle: "Landmarks", wikiName: "jarvis", mode: "article",
    });
    expect(userPrompt).toContain("CLAIM (3/8): Eiffel Tower completed 1889");
    expect(userPrompt).toContain("SOURCE PASSAGE");
    expect(userPrompt).toContain("The Eiffel Tower was completed in 1889.");
    expect(userPrompt).toContain('from "Landmarks"');
    expect(userPrompt).toContain("Claim 3/8");
  });

  test("omits the source passage when the claim carries no quote", () => {
    const { userPrompt } = buildClaimVerifyPrompt({ title: "A" }, {
      index: 1, total: 1, pageTitle: "P", wikiName: "w", mode: "article",
    });
    expect(userPrompt).not.toContain("SOURCE PASSAGE");
  });

  test("sel mode adds the located excerpt + heading; article mode does not", () => {
    const sel = buildClaimVerifyPrompt(claim, {
      index: 1, total: 1, pageTitle: "P", wikiName: "w", mode: "sel",
      excerpt: "Surrounding sentence about the tower.", heading: "Landmarks of Paris",
    });
    expect(sel.userPrompt).toContain("SURROUNDING CONTEXT");
    expect(sel.userPrompt).toContain("Surrounding sentence about the tower.");
    expect(sel.userPrompt).toContain("Section: Landmarks of Paris");

    const article = buildClaimVerifyPrompt(claim, {
      index: 1, total: 1, pageTitle: "P", wikiName: "w", mode: "article",
      excerpt: "Ignored in article mode.",
    });
    expect(article.userPrompt).not.toContain("SURROUNDING CONTEXT");
  });
});

describe("buildComposePrompt", () => {
  test("asks for a lede-only assessment over the verdict blocks", () => {
    const blocks = [
      "### ✅ Claim 1/2 — A\n\nSupported.",
      "### ❌ Claim 2/2 — B\n\nContradicted.",
    ];
    const { systemPrompt, userPrompt } = buildComposePrompt({ title: "Page", wikiName: "w", blocks });
    expect(systemPrompt).toContain("OVERALL ASSESSMENT");
    expect(systemPrompt).toContain("do NOT restate or re-list the individual claims");
    expect(userPrompt).toContain('from "Page"');
    expect(userPrompt).toContain("### ✅ Claim 1/2 — A");
    expect(userPrompt).toContain("### ❌ Claim 2/2 — B");
  });
});
