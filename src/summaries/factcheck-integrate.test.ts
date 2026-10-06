import { describe, expect, test } from "bun:test";
import {
  rebuildSummaryBody,
  resolveSummaryEdits,
  summaryEditorVoice,
  summaryEditSlices,
  summaryIntegratePreviewHtml,
  summaryPromptBody,
  summarySourceNoun,
} from "./factcheck-integrate.ts";
import { buildIntegratePrompt } from "../wiki/integrate-edits.ts";
import { buildSummaryFactcheckBlock, insertSummaryFactcheckBlock } from "./factcheck-block.ts";

describe("summarySourceNoun (D7): the host first, then the collection", () => {
  test.each([
    ["https://www.youtube.com/watch?v=x", "article-summaries", "video"],
    ["https://youtu.be/x", "article-summaries", "video"],
    ["https://vimeo.com/123", "article-summaries", "talk"],
    ["https://www.tiktok.com/@a/video/1", "article-summaries", "video"],
    ["https://x.com/a/status/1", "article-summaries", "post"],
    ["https://twitter.com/a/status/1", "youtube-summaries", "post"],
    ["https://example.org/post", "youtube-summaries", "video"],
    ["https://example.org/post", "vimeo-summaries", "talk"],
    ["https://example.org/post", "x-articles", "post"],
    ["https://www.anthropic.com/news/x", "anthropic-summaries", "article"],
    ["not a url", "article-summaries", "article"],
    [null, "tiktok-summaries", "video"],
  ] as const)("%s in %s → %s", (url, collection, noun) => {
    expect(summarySourceNoun(url, collection)).toBe(noun);
  });
});

describe("the summary editor's system prompt (D5, D7)", () => {
  test("pinned: attribute every ❌ and ⚠️, in the system prompt", () => {
    const { systemPrompt, userPrompt } = buildIntegratePrompt({
      pageTitle: "Sleep talk",
      wikiName: "youtube-summaries",
      claims: [],
      maskedBody: "Body.",
      hasSourcesSection: false,
      voice: summaryEditorVoice("video"),
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
        '- For ❌ and ⚠️ alike, the claim must READ as the video\'s after the edit. If the sentence already names its source (the video, its speaker, "is described as", "claims"), keep that and add what the sources say. If it states the claim as plain fact, rewrite it to start from the video ("The video says …"), and make `old` cover the sentence from its start. Appending "Sources say …" after a sentence that still asserts the claim as fact is NOT attribution.',
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
    expect(summaryEditorVoice("talk").verdictRules[0]).toContain('"The talk says X; sources say Y');
    expect(summaryEditorVoice("post").verdictRules[1]).toContain("the post says");
    expect(summaryEditorVoice("article").role).toContain("a summary of an article.");
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
