import { test, expect, describe } from "bun:test";
import {
  applyEdits,
  buildIntegratePrompt,
  changedChars,
  changedCharsOfOutcomes,
  collapsedRescueRisk,
  enforceChangeBudget,
  enforceEditBounds,
  findExclusionZones,
  hasSourcesSection,
  integrateBodyLen,
  matchMaskBody,
  maxChangedChars,
  neutralizeFactcheckSentinels,
  outcomeChangedChars,
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

test("integrateBodyLen measures the PROMPT mask — kilobytes below a sentinel-only measure", () => {
  const codeHeavy = ["Prose.", "", "```ts", "x".repeat(4000), "```", "", "Tail."].join("\n");
  // A sentinel-only (same-length) masker reports the raw length by construction.
  expect(matchMaskBody(codeHeavy).length).toBe(codeHeavy.length);
  // The pinned referent measures the NOT-length-preserving prompt mask instead —
  // the whole reason the factcheck `done.bodyLen` and the integrate route's cap
  // check both call this ONE function rather than measuring locally.
  expect(integrateBodyLen(codeHeavy)).toBe(promptMaskBody(codeHeavy).length);
  expect(integrateBodyLen(codeHeavy)).toBeLessThan(codeHeavy.length - 3900);
});

test("findExclusionZones merges and covers all four kinds on an .mdx page", () => {
  const page = `---\na: b\n---\n\n<Figure caption="x">\ntext\n</Figure>\n\n\`\`\`\ncode\n\`\`\`\n\n${FACTCHECK_SENTINEL_START}\nq\n${FACTCHECK_SENTINEL_END}\n`;
  const kinds = findExclusionZones(page, true).map((z) => z.kind);
  expect(kinds).toContain("frontmatter");
  expect(kinds).toContain("component");
  expect(kinds).toContain("fence");
  expect(kinds).toContain("sentinel");
  // Sorted, non-overlapping: each zone starts at or after the previous one's end.
  const zones = findExclusionZones(page, true);
  for (let i = 1; i < zones.length; i++) {
    expect(zones[i]!.start).toBeGreaterThanOrEqual(zones[i - 1]!.end);
  }
});

// ── Fence scanning ───────────────────────────────────────────────────────────

test("findExclusionZones masks a ~~~ fence and a ``` inside it can't close it", () => {
  const page = "Prose here.\n\n~~~\ncode with ``` inside\n~~~\n\nTail prose.\n";
  const zones = findExclusionZones(page, false);
  expect(zones).toHaveLength(1);
  expect(zones[0]!.kind).toBe("fence");
  expect(page.slice(zones[0]!.start, zones[0]!.end)).toBe("~~~\ncode with ``` inside\n~~~");
  // Prose on BOTH sides stays editable — the inner ``` did not flip parity.
  expect(applyEdits(page, [edit({ old: "Tail prose.", new: "Tail corrected." })]).appliedCount).toBe(1);
  expect(applyEdits(page, [edit({ old: "Prose here.", new: "Prose fixed." })]).appliedCount).toBe(1);
});

test("a ``` line inside a ````-opened fence is content, not a closer", () => {
  // CommonMark: the closing run must be at least as long as the opener's. A
  // shorter run closing the block used to flip the rest of the page to "code".
  const page = ["Prose here.", "", "````md", "```ts", "const x = 1;", "```", "````", "", "Tail prose.", ""].join(
    "\n",
  );
  const zones = findExclusionZones(page, false);
  expect(zones).toHaveLength(1);
  expect(page.slice(zones[0]!.start, zones[0]!.end)).toBe("````md\n```ts\nconst x = 1;\n```\n````");
  // Prose on BOTH sides stays editable — the inner ``` did not close the block.
  expect(applyEdits(page, [edit({ old: "Tail prose.", new: "Tail fixed." })]).appliedCount).toBe(1);
  expect(applyEdits(page, [edit({ old: "Prose here.", new: "Prose fixed." })]).appliedCount).toBe(1);
});

test("a stray ``` inside a persisted fact-check block cannot invert fence parity", () => {
  const page = [
    FACTCHECK_SENTINEL_START,
    "> [!factcheck] Fact check (2026-07-29)",
    "> The page quotes ``` in its example.",
    FACTCHECK_SENTINEL_END,
    "",
    "Editable prose about widgets.",
    "",
    "```ts",
    "const shipped = 4;",
    "```",
    "",
    "Trailing prose after the fence.",
    "",
  ].join("\n");
  const kinds = findExclusionZones(page, false).map((z) => z.kind);
  expect(kinds).toEqual(["sentinel", "fence"]);
  // Both prose spans stay editable; the real fence is still masked.
  expect(applyEdits(page, [edit({ old: "Editable prose about widgets.", new: "Fixed." })]).appliedCount).toBe(1);
  expect(applyEdits(page, [edit({ old: "Trailing prose after the fence.", new: "Fixed." })]).appliedCount).toBe(1);
  expect(applyEdits(page, [edit({ old: "const shipped = 4;", new: "const shipped = 2;" })]).appliedCount).toBe(0);
});

// ── Component masking (block-level only) ─────────────────────────────────────

const COMPONENT_PAGE = [
  "Lead.",
  "",
  'The verdict <Verdict value="yes"/> says it ships 4M units.',
  "",
  "The `<Callout>` component wraps prose in a box.",
  "",
  '<Callout tone={warn} title="x">',
  "Inner prose.",
  "</Callout>",
  "",
].join("\n");

test("an INLINE component tag leaves its sentence editable", () => {
  const r = applyEdits(
    COMPONENT_PAGE,
    [edit({ old: "says it ships 4M units", new: "says it ships 2.1M units" })],
    true,
  );
  expect(r.appliedCount).toBe(1);
  expect(r.body).toContain('<Verdict value="yes"/> says it ships 2.1M units');
});

test("a prose MENTION of a component in backticks is untouched and stays editable", () => {
  expect(promptMaskBody(COMPONENT_PAGE, true)).toContain("`<Callout>`");
  const r = applyEdits(
    COMPONENT_PAGE,
    [edit({ old: "component wraps prose in a box", new: "component wraps prose in a callout box" })],
    true,
  );
  expect(r.appliedCount).toBe(1);
  expect(r.body).toContain("The `<Callout>` component wraps prose in a callout box.");
});

test("a BLOCK component tag is masked whole — including non-quoted attrs", () => {
  const zoned = findExclusionZones(COMPONENT_PAGE, true).filter((z) => z.kind === "component");
  expect(zoned.map((z) => COMPONENT_PAGE.slice(z.start, z.end))).toEqual([
    '<Callout tone={warn} title="x">',
    "</Callout>",
  ]);
  // `tone={warn}` is inside the zone, so an edit reaching into it is dropped...
  expect(applyEdits(COMPONENT_PAGE, [edit({ old: "tone={warn}", new: "tone={bad}" })], true).appliedCount).toBe(0);
  // ...while the component's inner prose stays editable.
  expect(applyEdits(COMPONENT_PAGE, [edit({ old: "Inner prose.", new: "Fixed prose." })], true).appliedCount).toBe(1);
  // Block zones get a readable, non-empty prompt placeholder like every other kind.
  expect(promptMaskBody(COMPONENT_PAGE, true)).toContain("[component tag omitted]");
});

test("a MALFORMED opening tag cannot swallow the prose below it", () => {
  // The `>` is missing on the tag's own line. With a newline-crossing attribute
  // tail the zone ran on to the next `>` ANYWHERE — here a blockquote marker —
  // zoning three lines of editable prose (and reporting "no longer found").
  const page = [
    "Lead.",
    "",
    '<Callout tone="warn"',
    "",
    "The device ships 4M units per year.",
    "",
    "> quoted line with a closing bracket",
    "",
  ].join("\n");
  expect(findExclusionZones(page, true).filter((z) => z.kind === "component")).toEqual([]);
  const r = applyEdits(page, [edit({ old: "The device ships 4M units per year.", new: "Fixed." })], true);
  expect(r.appliedCount).toBe(1);
});

test("an INDENTED block tag is still zoned — markdown-ast trims the line before matching", () => {
  const page = ["Lead.", "", '  <Callout tone="warn">', "  Inner prose.", "  </Callout>", ""].join("\n");
  const zoned = findExclusionZones(page, true).filter((z) => z.kind === "component");
  expect(zoned.map((z) => page.slice(z.start, z.end))).toEqual(['<Callout tone="warn">', "</Callout>"]);
  // The captured indent stays OUTSIDE the zone (it is prose whitespace).
  expect(page[zoned[0]!.start - 1]).toBe(" ");
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

test("parseEditList REPORTS every malformed item instead of vaporizing it", () => {
  const parsed = parseEditList(
    JSON.stringify({
      edits: [
        { claimIndex: 1, verdict: "❌", old: "4M units", new: "2.1M units", reason: " filing " },
        "not an object",
        { claimIndex: 2, old: "   ", new: "x" },
        { claimIndex: 3, old: "ships 4M" },
      ],
    }),
  )!;
  expect(parsed.edits).toHaveLength(1);
  expect(parsed.edits[0]!.reason).toBe("filing"); // trimmed
  expect(parsed.dropped).toHaveLength(3);
  // Three DISTINCT reasons — the user can tell which failure they hit.
  expect(new Set(parsed.dropped.map((d) => d.reason)).size).toBe(3);
  expect(parsed.dropped[0]!.reason).toContain("not an edit object");
  expect(parsed.dropped[1]!.reason).toContain("`old` is empty");
  expect(parsed.dropped[2]!.reason).toContain("`new` is missing");
  // The drop still names what it dropped.
  expect(parsed.dropped[2]!.edit.old).toBe("ships 4M");
});

test("parseEditList rejects an EMPTY `new` — a silent deletion is not an edit", () => {
  const parsed = parseEditList('{"edits": [{"old": "ships 4M units", "new": ""}]}')!;
  expect(parsed.edits).toEqual([]);
  expect(parsed.dropped[0]!.reason).toContain("`new` is empty");
});

test("parseEditList neutralizes injected fact-check sentinels in `new`", () => {
  const raw = JSON.stringify({
    edits: [
      {
        old: "ships 4M units",
        new: `ships 2.1M units ${FACTCHECK_SENTINEL_START} and ${FACTCHECK_SENTINEL_END}`,
      },
    ],
  });
  const parsed = parseEditList(raw)!;
  expect(parsed.edits[0]!.new).not.toContain(FACTCHECK_SENTINEL_START);
  expect(parsed.edits[0]!.new).not.toContain(FACTCHECK_SENTINEL_END);
  // ...and the neutralized form is what reaches the page.
  const spliced = applyEdits("The device ships 4M units.\n", parsed.edits);
  expect(spliced.appliedCount).toBe(1);
  expect(spliced.body).not.toContain(FACTCHECK_SENTINEL_START);
  expect(spliced.body).toContain("factcheck:start");
  expect(neutralizeFactcheckSentinels(FACTCHECK_SENTINEL_END)).toBe("factcheck:end");
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

test("changed chars are measured on the RESOLVED span, not on `old.length`", () => {
  // A tier-2 rescue whose raw span is LONGER than `old` (collapsed whitespace runs).
  const body = "Intro.\n\nThe device   ships\n   4M units per\n  year worldwide.\n\nOutro.\n";
  const anchor = "The device ships 4M units per year worldwide.";
  const r = applyEdits(body, [edit({ old: anchor, new: "Short." })]);
  expect(r.appliedCount).toBe(1);
  expect(r.outcomes[0]!.tier).toBe("collapsed");
  const span = r.outcomes[0]!.end! - r.outcomes[0]!.start!;
  expect(span).toBeGreaterThan(anchor.length);
  expect(r.outcomes[0]!.resolvedText!.length).toBe(span);
  // The pre-resolution measure UNDER-counts; the resolved one is the truth.
  expect(changedChars([edit({ old: anchor, new: "Short." })])).toBe(anchor.length);
  expect(outcomeChangedChars(r.outcomes[0]!)).toBe(span);
  expect(changedCharsOfOutcomes(r.outcomes)).toBe(span);
});

test("enforceChangeBudget drops over-budget edits greedily so accept-all always fits", () => {
  // Body short enough that the floor (2000) is the budget.
  const body = `A: ${"a".repeat(900)}\n\nB: ${"b".repeat(900)}\n\nC: ${"c".repeat(900)}\n`;
  const r = applyEdits(body, [
    edit({ old: "a".repeat(900), new: "x".repeat(900) }),
    edit({ old: "b".repeat(900), new: "y".repeat(900) }),
    edit({ old: "c".repeat(900), new: "z".repeat(900) }),
  ]);
  expect(r.appliedCount).toBe(3);
  const bodyLen = integrateBodyLen(body);
  const { dropped, changedChars: total } = enforceChangeBudget(r.outcomes, bodyLen);
  expect(total).toBeLessThanOrEqual(maxChangedChars(bodyLen));
  expect(dropped).toHaveLength(1); // the third no longer fits
  expect(dropped[0]!.reason).toContain("change budget");
  // The dropped outcome is flipped in place — the preview shows it as dropped.
  expect(r.outcomes[2]!.applied).toBe(false);
  expect(r.outcomes[2]!.start).toBeUndefined();
  expect(r.outcomes[2]!.resolvedText).toBeUndefined();
  // The survivors are still the first two, in order.
  expect(r.outcomes.filter((o) => o.applied)).toHaveLength(2);
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

test("applyEdits tier-2 records the RAW resolved text, not the model's quote", () => {
  const body = "Intro.\n\nThe device ships\n4M units per\nyear worldwide.\n\nOutro.\n";
  const anchor = "The device ships 4M units per year worldwide.";
  const r = applyEdits(body, [edit({ old: anchor, new: "Fixed." })]);
  expect(r.outcomes[0]!.resolvedText).toBe("The device ships\n4M units per\nyear worldwide.");
  expect(r.outcomes[0]!.resolvedText).not.toBe(anchor);
  expect(body.slice(r.outcomes[0]!.start!, r.outcomes[0]!.end!)).toBe(r.outcomes[0]!.resolvedText!);
});

// The whitespace-collapse rescue also STRIPS `*`/`_`/backtick and rewrites
// `[label](url)` → `label`, so a naively mapped-back range cuts through markup.
// Every one of these was a reproduced corruption before the guard.
describe("applyEdits tier-2 rescue rejects a range that cuts through markdown", () => {
  const cases: [string, string, string][] = [
    ["orphaned bold", "Intro.\n\nThe **device ships 4M units** per year.\n", "device ships 4M units per year."],
    ["eaten link URL", "See [the filing](https://sec.gov/x) for details.\n", "the filing for details."],
    ["orphaned code span", "Use `foo()` here now.\n", "foo() here now."],
  ];
  for (const [name, body, old] of cases) {
    test(name, () => {
      const r = applyEdits(body, [edit({ old, new: "NEW" })]);
      expect(r.appliedCount).toBe(0);
      expect(r.body).toBe(body); // byte-identical — no corruption
      expect(r.outcomes[0]!.reason).toContain("cut through markdown formatting");
    });
  }

  test("a range that swallows a paragraph break", () => {
    const body = "Alpha beta.\n\nGamma delta.\n";
    const r = applyEdits(body, [edit({ old: "beta. Gamma", new: "NEW" })]);
    expect(r.appliedCount).toBe(0);
    expect(r.body).toBe(body);
    expect(r.outcomes[0]!.reason).toContain("paragraph break");
  });

  test("a legitimate line-wrap-only rescue still applies", () => {
    const body = "Intro.\n\nThe device ships\n4M units per\nyear worldwide.\n\nOutro.\n";
    const r = applyEdits(body, [
      edit({
        old: "The device ships 4M units per year worldwide.",
        new: "The device ships 2.1M units per year worldwide.",
      }),
    ]);
    expect(r.appliedCount).toBe(1);
    expect(r.body).toBe("Intro.\n\nThe device ships 2.1M units per year worldwide.\n\nOutro.\n");
  });

  test("collapsedRescueRisk is the pure predicate behind all of the above", () => {
    expect(collapsedRescueRisk("bold** word", "bold word")).toContain("markdown formatting");
    expect(collapsedRescueRisk("a\n\nb", "a b")).toContain("paragraph break");
    expect(collapsedRescueRisk("The device ships\n4M units", "The device ships 4M units")).toBeNull();
  });

  // The delimiter COUNT comparison is invariant under a ONE-DELIMITER SHIFT: the
  // mapped-back slice can carry the SAME counts as `old` while sitting offset by
  // one delimiter, so the splice re-pairs with the neighbouring construct. The
  // link case is the worst — it silently swaps in the WRONG source URL.
  const OFFSET_CASES: [string, string, string][] = [
    [
      "a link whose splice would carry the OTHER link's URL",
      "Anthropic shipped [Claude 3](https://a.co/n) before [GPT-4o](https://o.ai/g) launched.\n",
      "[Claude 3](https://a.co/n) before GPT-4o",
    ],
    ["a code span shifted by one backtick", "Use `foo` and `bar` today.\n", "`foo` and bar"],
    ["emphasis shifted by one asterisk", "It runs *fast* and *slow* today.\n", "*fast* and slow"],
    ["emphasis shifted by one underscore", "It has _alpha_ and _beta_ today.\n", "_alpha_ and beta"],
  ];
  for (const [name, body, old] of OFFSET_CASES) {
    test(name, () => {
      const r = applyEdits(body, [edit({ old, new: "NEW" })]);
      expect(r.appliedCount).toBe(0);
      expect(r.body).toBe(body); // byte-identical — no corruption
      expect(r.outcomes[0]!.reason).toContain("inside markdown formatting");
    });
  }

  test("a CRLF page's paragraph break is banned too", () => {
    const body = "Alpha beta.\r\n\r\nGamma delta.\r\n";
    const r = applyEdits(body, [edit({ old: "beta. Gamma", new: "NEW" })]);
    expect(r.appliedCount).toBe(0);
    expect(r.body).toBe(body);
    expect(r.outcomes[0]!.reason).toContain("paragraph break");
    // …and the pure predicate says so directly.
    expect(collapsedRescueRisk("a\r\n\r\nb", "a b")).toContain("paragraph break");
  });

  test("the boundary test is edge-aware, not a blanket delimiter ban", () => {
    // Neighbour delimiter matches `old`'s own edge char (the `**bold**` nesting
    // case) ⇒ the range is aligned, not offset.
    expect(collapsedRescueRisk("*fast* and slow", "*fast* and slow", "*", "y")).toBeNull();
    // Neighbour delimiter differs from `old`'s edge char ⇒ offset inside markup.
    expect(collapsedRescueRisk("fast* and *slow", "*fast* and slow", "*", "*")).toContain(
      "inside markdown formatting",
    );
    // No neighbours at all (range spans the whole body) ⇒ nothing to test.
    expect(collapsedRescueRisk("plain words", "plain words")).toBeNull();
  });
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
