import { test, expect } from "bun:test";
import {
  applyEdits,
  buildIntegratePrompt,
  changedChars,
  enforceEditBounds,
  findExclusionZones,
  hasSourcesSection,
  integrateBodyLen,
  matchMaskBody,
  maxChangedChars,
  parseEditList,
  promptMaskBody,
  ZONE_SENTINEL,
  INTEGRATE_MAX_EDITS,
  INTEGRATE_MAX_EDIT_CHARS,
  type IntegrateEdit,
} from "./integrate-edits.ts";
import { FACTCHECK_SENTINEL_START, FACTCHECK_SENTINEL_END } from "./factcheck-context.ts";

const edit = (over: Partial<IntegrateEdit> = {}): IntegrateEdit => ({
  claimIndex: 1,
  verdict: "❌",
  old: "",
  new: "",
  reason: "because",
  ...over,
});

/** A page carrying every exclusion zone AND a deliberate 3-blank-line gap. */
const ZONED_PAGE = [
  "---",
  "title: Zoned",
  "tags: [a]",
  "---",
  "",
  "Intro prose about widgets.",
  "",
  "",
  "",
  "After a three-blank-line gap.",
  "",
  "```ts",
  "const shipped = 4_000_000; // editable-looking but fenced",
  "```",
  "",
  FACTCHECK_SENTINEL_START,
  "> [!factcheck] Fact check (2026-07-29)",
  "> Ships 4M units is contradicted.",
  FACTCHECK_SENTINEL_END,
  "",
  "## Sources",
  "",
  "- https://example.com",
  "",
].join("\n");

// ── Masks ────────────────────────────────────────────────────────────────────

test("matchMaskBody is SAME-LENGTH, uses U+E000, and never emits NUL", () => {
  const masked = matchMaskBody(ZONED_PAGE);
  expect(masked.length).toBe(ZONED_PAGE.length);
  expect(masked).toContain(ZONE_SENTINEL);
  expect(masked).not.toContain("\u0000");
  expect(ZONE_SENTINEL).toBe("\uE000");
  expect(ZONE_SENTINEL.length).toBe(1); // one UTF-16 code unit
  // Editable prose survives untouched, at its ORIGINAL offsets.
  expect(masked.indexOf("Intro prose about widgets.")).toBe(
    ZONED_PAGE.indexOf("Intro prose about widgets."),
  );
  // Every zone's content is gone from the masked text.
  expect(masked).not.toContain("title: Zoned");
  expect(masked).not.toContain("const shipped");
  expect(masked).not.toContain("Ships 4M units is contradicted");
});

test("matchMaskBody preserves the 3-blank-line gap (no adjacency splice)", () => {
  const masked = matchMaskBody(ZONED_PAGE);
  expect(masked).toContain("Intro prose about widgets.\n\n\n\nAfter a three-blank-line gap.");
});

test("promptMaskBody uses readable placeholders and keeps the blank-line gap", () => {
  const prompt = promptMaskBody(ZONED_PAGE);
  expect(prompt).toContain("[frontmatter omitted]");
  expect(prompt).toContain("[code block omitted]");
  expect(prompt).toContain("[prior fact-check block omitted]");
  expect(prompt).toContain("Intro prose about widgets.\n\n\n\nAfter a three-blank-line gap.");
  expect(prompt).not.toContain(ZONE_SENTINEL);
  expect(prompt).not.toContain("\u0000");
  expect(prompt.length).toBeLessThan(ZONED_PAGE.length); // NOT length-preserving
});

test("promptMaskBody masks .mdx component TAG MARKUP only — inner prose stays", () => {
  const page = 'Lead.\n\n<Callout tone="warn" title="Heads up">\nThe inner prose is editable.\n</Callout>\n';
  const prompt = promptMaskBody(page, true);
  expect(prompt).toContain("The inner prose is editable.");
  expect(prompt).not.toContain("<Callout");
  expect(prompt).not.toContain("</Callout>");
  // On a plain .md page there is no component vocabulary — tags stay literal.
  expect(promptMaskBody(page, false)).toContain("<Callout");
});

test("integrateBodyLen is the one referent — both call sites measure equal on a code-heavy page", () => {
  const codeHeavy = ["Prose.", "", "```ts", "x".repeat(4000), "```", "", "Tail."].join("\n");
  // The fact-check route's `done.bodyLen` and the integrate route's cap check.
  const factcheckRouteBodyLen = integrateBodyLen(codeHeavy);
  const integrateRouteBodyLen = integrateBodyLen(codeHeavy);
  expect(factcheckRouteBodyLen).toBe(integrateRouteBodyLen);
  // ...and it is NOT what a sentinel-only masker would have reported — the whole
  // reason the referent is pinned to one function.
  const sentinelOnlyLen = codeHeavy.length;
  expect(factcheckRouteBodyLen).toBeLessThan(sentinelOnlyLen - 3000);
});

test("findExclusionZones merges and covers all four kinds on an .mdx page", () => {
  const page = `---\na: b\n---\n\n<Figure caption="x">\ntext\n</Figure>\n\n\`\`\`\ncode\n\`\`\`\n\n${FACTCHECK_SENTINEL_START}\nq\n${FACTCHECK_SENTINEL_END}\n`;
  const kinds = findExclusionZones(page, true).map((z) => z.kind);
  expect(kinds).toContain("frontmatter");
  expect(kinds).toContain("component");
  expect(kinds).toContain("fence");
  expect(kinds).toContain("sentinel");
  // Sorted, non-overlapping.
  const zones = findExclusionZones(page, true);
  for (let i = 1; i < zones.length; i++) expect(zones[i]!.start).toBeGreaterThan(zones[i - 1]!.end - 1);
});

// ── parseEditList ────────────────────────────────────────────────────────────

test("parseEditList accepts a well-formed list with a note", () => {
  const raw = JSON.stringify({
    edits: [{ claimIndex: 2, verdict: "❌", old: "4M units", new: "2.1M units", reason: "filing" }],
    note: "one correction",
  });
  const parsed = parseEditList(raw);
  expect(parsed).not.toBeNull();
  expect(parsed!.note).toBe("one correction");
  expect(parsed!.edits).toHaveLength(1);
  expect(parsed!.edits[0]!.old).toBe("4M units");
});

test("parseEditList accepts a bare array and normalizes a bare ⚠", () => {
  const parsed = parseEditList('[{"claimIndex":1,"verdict":"⚠","old":"a","new":"b"}]');
  expect(parsed!.edits[0]!.verdict).toBe("⚠️");
  expect(parsed!.edits[0]!.reason).toBe("");
});

test("parseEditList validates to null on malformed output", () => {
  expect(parseEditList("not json at all")).toBeNull();
  expect(parseEditList("")).toBeNull();
  expect(parseEditList('{"foo": 1}')).toBeNull();
  expect(parseEditList('{"edits": "nope"}')).toBeNull();
});

test("parseEditList drops anchor-less entries but keeps a legitimately empty list", () => {
  expect(parseEditList('{"edits": []}')!.edits).toEqual([]);
  expect(parseEditList('{"edits": [{"old": "   ", "new": "x"}]}')!.edits).toEqual([]);
});

// ── Bounds ───────────────────────────────────────────────────────────────────

test("enforceEditBounds drops over-cap counts and oversized edit text with reasons", () => {
  const many = Array.from({ length: INTEGRATE_MAX_EDITS + 3 }, (_, i) =>
    edit({ old: `anchor ${i}`, new: `fixed ${i}` }),
  );
  const { kept, dropped } = enforceEditBounds(many);
  expect(kept).toHaveLength(INTEGRATE_MAX_EDITS);
  expect(dropped).toHaveLength(3);
  expect(dropped[0]!.reason).toContain(`${INTEGRATE_MAX_EDITS}-edit cap`);

  const huge = enforceEditBounds([edit({ old: "x".repeat(INTEGRATE_MAX_EDIT_CHARS + 1), new: "y" })]);
  expect(huge.kept).toHaveLength(0);
  expect(huge.dropped[0]!.reason).toContain(`${INTEGRATE_MAX_EDIT_CHARS} chars`);
});

test("changedChars counts the larger side; maxChangedChars floors at the per-edit cap", () => {
  expect(changedChars([edit({ old: "12345", new: "123" }), edit({ old: "1", new: "1234" })])).toBe(9);
  expect(maxChangedChars(200)).toBe(INTEGRATE_MAX_EDIT_CHARS); // short stub → floor
  expect(maxChangedChars(40_000)).toBe(10_000);
});

// ── applyEdits ───────────────────────────────────────────────────────────────

test("applyEdits applies a unique match and records the exact tier", () => {
  const body = "The device ships 4M units per year.\n";
  const r = applyEdits(body, [edit({ old: "ships 4M units", new: "ships 2.1M units ([sec.gov](https://sec.gov/x))" })]);
  expect(r.appliedCount).toBe(1);
  expect(r.outcomes[0]!.tier).toBe("exact");
  expect(r.body).toBe("The device ships 2.1M units ([sec.gov](https://sec.gov/x)) per year.\n");
  expect(r.outcomes[0]!.beforeCtx).toBe("The device ");
});

test("applyEdits drops a 0-match anchor without touching the body", () => {
  const body = "Stable prose.\n";
  const r = applyEdits(body, [edit({ old: "absent sentence", new: "x" })]);
  expect(r.appliedCount).toBe(0);
  expect(r.body).toBe(body);
  expect(r.outcomes[0]!.reason).toContain("no longer found");
});

test("applyEdits drops an ambiguous (≥2 match) anchor rather than guessing", () => {
  const body = "widgets are good.\n\nwidgets are good.\n";
  const r = applyEdits(body, [edit({ old: "widgets are good.", new: "widgets are fine." })]);
  expect(r.appliedCount).toBe(0);
  expect(r.body).toBe(body);
  expect(r.outcomes[0]!.reason).toContain("ambiguous");
});

test("applyEdits tier-2 rescues a line-wrap-drifted anchor at the RIGHT raw offsets", () => {
  const body = "Intro.\n\nThe device ships\n4M units per\nyear worldwide.\n\nOutro.\n";
  const r = applyEdits(body, [
    edit({ old: "The device ships 4M units per year worldwide.", new: "The device ships 2.1M units per year worldwide." }),
  ]);
  expect(r.appliedCount).toBe(1);
  expect(r.outcomes[0]!.tier).toBe("collapsed");
  expect(r.body).toBe("Intro.\n\nThe device ships 2.1M units per year worldwide.\n\nOutro.\n");
  // The rescued range is the real one — surrounding prose is untouched.
  expect(r.body.startsWith("Intro.\n\n")).toBe(true);
  expect(r.body.endsWith("\n\nOutro.\n")).toBe(true);
});

test("applyEdits rejects overlapping ranges — the EARLIER edit wins", () => {
  const body = "alpha beta gamma delta\n";
  const r = applyEdits(body, [
    edit({ old: "beta gamma", new: "BETA GAMMA" }),
    edit({ old: "gamma delta", new: "GAMMA DELTA" }),
  ]);
  expect(r.appliedCount).toBe(1);
  expect(r.outcomes[0]!.applied).toBe(true);
  expect(r.outcomes[1]!.applied).toBe(false);
  expect(r.outcomes[1]!.reason).toBe("overlaps an earlier edit");
  expect(r.body).toBe("alpha BETA GAMMA delta\n");
});

test("applyEdits splices descending — multi-edit offsets never shift", () => {
  const body = "one two three four five six\n";
  const r = applyEdits(body, [
    edit({ old: "one", new: "1111111111" }), // grows
    edit({ old: "three", new: "3" }), // shrinks
    edit({ old: "five", new: "55555" }),
  ]);
  expect(r.appliedCount).toBe(3);
  expect(r.body).toBe("1111111111 two 3 four 55555 six\n");
});

test("applyEdits is order-insensitive for non-overlapping edits given out of body order", () => {
  const body = "AAA middle BBB\n";
  const r = applyEdits(body, [edit({ old: "BBB", new: "bbb" }), edit({ old: "AAA", new: "aaa" })]);
  expect(r.appliedCount).toBe(2);
  expect(r.body).toBe("aaa middle bbb\n");
});

test("applyEdits drops an anchor inside frontmatter / the sentinel block / a fence", () => {
  const inFrontmatter = applyEdits(ZONED_PAGE, [edit({ old: "title: Zoned", new: "title: Other" })]);
  expect(inFrontmatter.appliedCount).toBe(0);
  expect(inFrontmatter.body).toBe(ZONED_PAGE);

  const inSentinel = applyEdits(ZONED_PAGE, [
    edit({ old: "Ships 4M units is contradicted.", new: "changed" }),
  ]);
  expect(inSentinel.appliedCount).toBe(0);

  const inFence = applyEdits(ZONED_PAGE, [edit({ old: "const shipped = 4_000_000;", new: "const shipped = 2;" })]);
  expect(inFence.appliedCount).toBe(0);
});

test("applyEdits drops an anchor inside .mdx component tag markup", () => {
  const page = 'Lead.\n\n<Callout tone="warn">\nInner prose.\n</Callout>\n';
  const inTag = applyEdits(page, [edit({ old: 'tone="warn"', new: 'tone="bad"' })], true);
  expect(inTag.appliedCount).toBe(0);
  // ...while the prose inside the component stays editable.
  const inProse = applyEdits(page, [edit({ old: "Inner prose.", new: "Corrected prose." })], true);
  expect(inProse.appliedCount).toBe(1);
  expect(inProse.body).toContain('<Callout tone="warn">\nCorrected prose.\n</Callout>');
});

test("applyEdits drops a cross-boundary anchor that spans into a masked zone", () => {
  const r = applyEdits(ZONED_PAGE, [
    edit({ old: "After a three-blank-line gap.\n\n```ts\nconst shipped", new: "x" }),
  ]);
  expect(r.appliedCount).toBe(0);
  expect(r.body).toBe(ZONED_PAGE);
});

test("applyEdits leaves the body byte-identical when nothing resolves", () => {
  const r = applyEdits(ZONED_PAGE, [edit({ old: "nowhere", new: "x" }), edit({ old: "also nowhere", new: "y" })]);
  expect(r.body).toBe(ZONED_PAGE);
  expect(r.appliedCount).toBe(0);
});

test("applyEdits does NOT re-validate mid-apply — a duplicate created by a sibling still applies", () => {
  // Edit 1's `new` text introduces a second copy of edit 2's anchor. With pinned
  // original-body offsets that is irrelevant; a re-validate would false-drop it.
  const body = "first line\nsecond line\n";
  const r = applyEdits(body, [
    edit({ old: "first line", new: "second line (was first)" }),
    edit({ old: "second line", new: "SECOND LINE" }),
  ]);
  expect(r.appliedCount).toBe(2);
  expect(r.body).toBe("second line (was first)\nSECOND LINE\n");
});

// ── Prompt ───────────────────────────────────────────────────────────────────

test("buildIntegratePrompt carries the verdict blocks, the masked body, and the JSON contract", () => {
  const { systemPrompt, userPrompt } = buildIntegratePrompt({
    pageTitle: "Widgets",
    wikiName: "jarvis",
    claims: [{ index: 2, verdict: "❌", title: "Ships 4M units", block: "### ❌ Claim 2/3 — Ships 4M units\n\nThe filing says 2.1M." }],
    maskedBody: promptMaskBody(ZONED_PAGE),
    hasSourcesSection: hasSourcesSection(ZONED_PAGE),
  });
  expect(systemPrompt).toContain("VERBATIM");
  expect(systemPrompt).toContain('"edits"');
  expect(systemPrompt).toContain("do NOT use any tool");
  expect(userPrompt).toContain("The filing says 2.1M.");
  expect(userPrompt).toContain("[code block omitted]");
  expect(userPrompt).toContain("## Sources");
  expect(userPrompt).not.toContain("const shipped");
});

test("hasSourcesSection detects a trailing Sources heading", () => {
  expect(hasSourcesSection(ZONED_PAGE)).toBe(true);
  expect(hasSourcesSection("# Page\n\nBody.\n")).toBe(false);
});
