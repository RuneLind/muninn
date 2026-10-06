import { describe, expect, test } from "bun:test";
import {
  rebuildSummaryBody,
  resolveSummaryEdits,
  summaryEditorVoice,
  summaryEditSlices,
  summaryIntegratePreviewHtml,
  summaryPromptBody,
} from "./factcheck-integrate.ts";
import { buildIntegratePrompt } from "../wiki/integrate-edits.ts";
import { buildSummaryFactcheckBlock, insertSummaryFactcheckBlock } from "./factcheck-block.ts";

describe("the summary editor's system prompt (D5, D7)", () => {
  test("pinned: attribute every ❌ and ⚠️, in the system prompt", () => {
    const { systemPrompt, userPrompt } = buildIntegratePrompt({
      pageTitle: "Sleep talk",
      wikiName: "youtube-summaries",
      claims: [],
      maskedBody: "Body.",
      hasSourcesSection: false,
      voice: summaryEditorVoice("the video"),
    });
    expect(systemPrompt).toBe(
      [
        "You are a meticulous summary editor applying fact-check results to a summary of a video.",
        "",
        "You are given the summary's text and the fact-check verdicts for some of its claims. The summary reports what the video says, so a correction must never put words in the video's mouth.",
        "Produce a MINIMAL list of in-place text edits that make the summary accurate.",
        "",
        "Rules:",
        '- ❌ (contradicted): ATTRIBUTE, never correct silently. The edited sentence must say what the video says and then what the sources say, in this shape: "The video says X; sources say Y ([hostname](url))." Cite the correcting source as a markdown link `[hostname](url)` right there in the sentence.',
        '- ⚠️ (partly supported): attribute the same way: the claim stays the video\'s ("the video says …"), followed by what the sources say — the missing precision or the caveat — with the same in-place source link.',
        '- For ❌ and ⚠️ alike, the claim must READ as the video\'s after the edit. If it states the claim as plain fact, rewrite it to start from the video ("The video says …"), and make `old` cover the sentence from its start. Appending "Sources say …" after a sentence that still asserts the claim as fact is NOT attribution.',
        '- Every ❌/⚠️ edit\'s `new` must contain the words "the video says" (or "the video claims" / "the video states"), even when the sentence already names a speaker. An edit without them is discarded.',
        "- Edit NOTHING else. Do not restructure, retitle, reformat, or improve prose that no verdict challenges.",
        "- Use ONLY the source URLs that appear in the verdict blocks. Never invent a URL, and do NOT use any tool — everything you need is in this message.",
        "",
        "Each edit is an exact string replacement:",
        "- `old` MUST be copied VERBATIM from the summary body below, character for character, and must be long enough to occur EXACTLY ONCE in it (extend it with surrounding words if the short form repeats).",
        "- `old` must NOT contain, start in, or run past any `[… omitted]` placeholder — those regions are not editable.",
        "- `new` is the full replacement for `old`.",
        "- Prefer a handful of surgical sentence-level edits over one large block.",
        "",
        "Produce ONLY valid JSON (no markdown fences, no commentary), shaped:",
        '{"edits": [{"claimIndex": 3, "verdict": "❌", "old": "exact substring currently in the page", "new": "replacement text", "reason": "one-line why"}], "note": "optional one-line summary"}',
        "",
        "Return an empty `edits` array if no verdict warrants a change to the text.",
      ].join("\n"),
    );
    // The user turn frames the same task; it carries no rule of its own.
    expect(userPrompt.split("\n")[0]).toBe('Apply these fact-check verdicts to the summary of the video "Sleep talk" (the "youtube-summaries" collection).');
    expect(userPrompt).toContain("SUMMARY BODY (copy `old` verbatim");
    expect(userPrompt).not.toMatch(/correct the statement/);
  });

  test("the noun follows the source", () => {
    expect(summaryEditorVoice("the talk").verdictRules[0]).toContain('"The talk says X; sources say Y');
    expect(summaryEditorVoice("the post").verdictRules[1]).toContain("the post says");
    expect(summaryEditorVoice("the article").role).toContain("a summary of an article.");
  });
});

const BODY = [
  "Intro: the video says 4 hours.",
  "",
  "```txt",
  "4 hours",
  "```",
  "",
  "## Visual reference",
  "",
  "![s](/api/frames/youtube/x/1.jpg) The slide says 4 hours.",
  "",
  "> 💬 **Takeaway:** Sleep 4 hours.",
].join("\n");

describe("slices (D12)", () => {
  test("the model sees the two kept ranges, the section between them omitted, code masked", () => {
    const shown = summaryPromptBody(summaryEditSlices(BODY));
    expect(shown).toContain("Intro: the video says 4 hours.");
    expect(shown).toContain("[visual reference section omitted]");
    expect(shown).toContain("> 💬 **Takeaway:** Sleep 4 hours.");
    expect(shown).not.toContain("The slide says");
    expect(shown).toContain("[code block omitted]");
  });

  test("an earlier fact-check block is no edit target", () => {
    const withBlock = insertSummaryFactcheckBlock(BODY, buildSummaryFactcheckBlock("Verdict text 4 hours.", "2026-10-06"));
    const slices = summaryEditSlices(withBlock);
    expect(slices.base).toBe(BODY);
    expect(summaryPromptBody(slices)).not.toContain("Verdict text");
  });

  test("each edit resolves in ONE slice; the section and the code between stay byte-identical", () => {
    const slices = summaryEditSlices(BODY);
    const r = resolveSummaryEdits(slices, [
      { claimIndex: 1, verdict: "❌", old: "the video says 4 hours.", new: "the video says 4 hours; sources say 7–9.", reason: "" },
      { claimIndex: 2, verdict: "❌", old: "Sleep 4 hours.", new: "The video says sleep 4 hours; sources say 7–9.", reason: "" },
      { claimIndex: 3, verdict: "❌", old: "The slide says 4 hours.", new: "x", reason: "" },
      { claimIndex: 4, verdict: "❌", old: "4 hours", new: "y", reason: "" },
    ]);
    expect(r.outcomes.map((o) => [o.applied, o.slice])).toEqual([[true, 0], [true, 1], [false, -1], [false, -1]]);
    const out = rebuildSummaryBody(slices, r.texts);
    expect(out).toContain("sources say 7–9.\n\n```txt\n4 hours\n```");
    const section = (t: string) => t.slice(t.indexOf("```txt"), t.indexOf("> 💬"));
    expect(section(out)).toBe(section(BODY));
    expect(out.endsWith("> 💬 **Takeaway:** The video says sleep 4 hours; sources say 7–9.")).toBe(true);
  });

  test("an anchor present in both slices is ambiguous and drops", () => {
    const body = "Sleep matters.\n\n## Visual reference\n\nCap.\n\n> 💬 **Takeaway:** Sleep matters.";
    const r = resolveSummaryEdits(summaryEditSlices(body), [{ claimIndex: 1, verdict: "❌", old: "Sleep matters.", new: "x", reason: "" }]);
    expect(r.outcomes[0]!.applied).toBe(false);
    expect(r.outcomes[0]!.reason).toContain("more than one part");
  });
});

describe("the preview", () => {
  test("escapes everything and numbers the checkboxes by edit index", () => {
    const html = summaryIntegratePreviewHtml(
      [{ claimIndex: 2, verdict: "❌", new: "<b>new</b>", reason: "r<", resolvedText: "old" }],
      [{ edit: { old: "<img src=x>" }, reason: "not found" }],
      new Map([[2, "Title <x>"]]),
    );
    expect(html).toContain('data-edit-idx="0"');
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<img");
    expect(html).toContain("Title &lt;x&gt;");
    expect(html).toContain("1 not applied");
  });
});

describe("fix round 1: the per-edit refusals", () => {
  // Real shapes from the 2026-10-06 propose runs on the scratch corpus.
  const JWST_CLAIM_8 =
    "as flagged by Nobel laureate Adam Riess (sources confirm his Nobel and Hubble-tension work but do not show him commenting on early galaxy formation in these pages ([skyatnightmagazine.com](https://www.skyatnightmagazine.com/space-science/webb-broken-cosmology))).*";
  const TRAILING_PER =
    "A single 15-minute dose of 670nm red light cut blood sugar elevation by 27.7%, per the video; sources say the study was by City, University of London ([news-medical.net](https://www.news-medical.net/x)).";

  test("an edit with no 'the video says/claims/states' is not attributed", async () => {
    const { attributionRefusal } = await import("./factcheck-integrate.ts");
    expect(attributionRefusal(JWST_CLAIM_8, "the video")).toBe("not attributed");
    expect(attributionRefusal(TRAILING_PER, "the video")).toBe("not attributed");
    expect(attributionRefusal("The video says X; sources say Y.", "the video")).toBeNull();
    expect(attributionRefusal("and, the Video Claims, Y", "the video")).toBeNull();
    expect(attributionRefusal("the talk states X", "the talk")).toBeNull();
    expect(attributionRefusal("the video says X", "the talk")).toBe("not attributed");
  });

  test("an unfenced structural line in an edit is refused, naming it", async () => {
    const { structuralLineRefusal } = await import("./factcheck-integrate.ts");
    expect(structuralLineRefusal("Fixed.\n\n## Transcript\n\nx")).toContain("## Transcript");
    expect(structuralLineRefusal("Fixed.\n\n## Visual reference\n\nx")).toContain("Visual reference");
    expect(structuralLineRefusal("Fixed.\n\n### **Visual references**:")).toContain("Visual references");
    expect(structuralLineRefusal("Fixed.\n## Fact check (2026-10-06)")).toContain("Fact check");
    expect(structuralLineRefusal("Fixed.\n<!-- factcheck:end -->")).toContain("factcheck:end");
    // Prose that mentions them, and a fenced example, are content.
    expect(structuralLineRefusal("The transcript says ## Transcript is a heading.")).toBeNull();
    expect(structuralLineRefusal("```\n## Transcript\n```")).toBeNull();
    expect(structuralLineRefusal("The video says X; sources say Y.")).toBeNull();
  });
});

describe("fix round 1: summaryStructureChanged", () => {
  const BASE = "Intro claim.\n\n## Visual reference\n\nA caption.\n\n## More\n\nTail claim.";
  test("unchanged structure: prose edits in either slice", async () => {
    const { summaryStructureChanged } = await import("./factcheck-integrate.ts");
    expect(summaryStructureChanged(BASE, BASE.replace("Intro claim.", "The video says intro; sources say no."))).toBe(false);
    expect(summaryStructureChanged(BASE, BASE.replace("Tail claim.", "The video says tail."))).toBe(false);
  });

  test("a heading demoted after the visual section moves the cut: prose would leave the checked text", async () => {
    const { summaryStructureChanged } = await import("./factcheck-integrate.ts");
    expect(summaryStructureChanged(BASE, BASE.replace("## More", "### More"))).toBe(true);
  });

  test("an unclosed fence at the end swallows the transcript appended after it", async () => {
    const { summaryStructureChanged } = await import("./factcheck-integrate.ts");
    expect(summaryStructureChanged(BASE, `${BASE}\n\n\`\`\`\nunclosed`)).toBe(true);
  });
});
