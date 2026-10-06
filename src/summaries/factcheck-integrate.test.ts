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
    expect(html).toContain('data-edit-idxs="0"');
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

describe("fix round 2: attribution follows the summary's language", () => {
  test("en (and an absent summary_lang): 'the <noun> says|claims|states'", async () => {
    const { attributionRefusal } = await import("./factcheck-integrate.ts");
    expect(attributionRefusal("The talk says X; sources say Y.", "the talk", "en")).toBeNull();
    expect(attributionRefusal("The talk says X; sources say Y.", "the talk", undefined)).toBeNull();
    expect(attributionRefusal("Foredraget sier at X.", "the talk", "en")).toBe("not attributed");
  });

  test("nb: the noun in bokmål with sier/hevder/påstår; English and 'kildene sier' alone are not attribution", async () => {
    const { attributionRefusal } = await import("./factcheck-integrate.ts");
    // The measured HEAD shape: English spliced into Norwegian prose.
    expect(attributionRefusal("- 📊 The talk says en egen evaluering viste 23 modeller; sources say 21.", "the talk", "nb")).toBe("not attributed");
    expect(attributionRefusal("- 📊 Foredraget sier at en egen evaluering viste 23 modeller; kildene sier at rapporten omfatter 21.", "the talk", "nb")).toBeNull();
    expect(attributionRefusal("Listepris sier lite: foredraget hevder at to modeller ga 2,1× forskjell.", "the talk", "nb")).toBeNull();
    expect(attributionRefusal("Videoen påstår at søvn er overvurdert.", "the video", "nb")).toBeNull();
    expect(attributionRefusal("Artikkelen sier at X.", "the article", "nb")).toBeNull();
    expect(attributionRefusal("Innlegget hevder at X.", "the post", "nb")).toBeNull();
    expect(attributionRefusal("To modeller ga 2,1× forskjell; kildene sier 1,4× ([knowit.no](https://knowit.example)).", "the talk", "nb")).toBe("not attributed");
    // The noun is the document's: a talk is not attributed to "videoen".
    expect(attributionRefusal("Videoen sier at X.", "the talk", "nb")).toBe("not attributed");
  });

  test("any other language: no literal check", async () => {
    const { attributionRefusal } = await import("./factcheck-integrate.ts");
    expect(attributionRefusal("Der Vortrag sagt X; Quellen sagen Y.", "the talk", "de")).toBeNull();
  });

  test("the nb voice gives the attribution form in bokmål and asks for bokmål edits", () => {
    const rules = summaryEditorVoice("the talk", "nb").verdictRules.join("\n");
    expect(rules).toContain('"Foredraget sier at X; kildene sier at Y ([hostname](url)).');
    expect(rules).toContain('must contain the words "foredraget sier" (or "foredraget hevder" / "foredraget påstår")');
    expect(rules).toContain("Norwegian bokmål");
    expect(rules).not.toContain("The talk says");
    expect(summaryEditorVoice("the video", "nb").verdictRules.join("\n")).toContain('"Videoen sier at X');
  });

  test("another language's voice keeps the shape, asks for the summary's language, and names no literal words", () => {
    const rules = summaryEditorVoice("the talk", "de").verdictRules.join("\n");
    expect(rules).toContain("the summary's own language");
    expect(rules).not.toContain("An edit without them is discarded");
    // English is unchanged by the parameter (the pinned prompt above).
    expect(summaryEditorVoice("the video", "en").verdictRules).toEqual(summaryEditorVoice("the video").verdictRules);
  });
});

describe("fix round 2: attribution is judged per claim, over its edits in document order", () => {
  const propose = async (body: string, edits: { claimIndex: number; verdict: string; old: string; new: string }[], correctable: number[]) => {
    const { proposeSummaryEdits, summaryEditSlices } = await import("./factcheck-integrate.ts");
    return proposeSummaryEdits({
      slices: summaryEditSlices(body),
      edits: edits.map((e) => ({ reason: "", ...e })),
      priorDrops: [],
      sourceNoun: "the video",
      correctable: new Set(correctable),
      bodyLen: 20_000,
    });
  };

  // Real shape: Light Bulbs claim 5, one sentence split into two adjacent edits.
  const BULBS =
    'Red/near-infrared photons at ~0.75 electron volts match the exact energy barrier electrons must cross in this chain — a discovery from the paper "Metabolism in the Solar Photon Field" (Fosbury, Jeffery et al.).\n\nAnother line.';
  const BULBS_A = {
    claimIndex: 5,
    verdict: "⚠️",
    old: "red/near-infrared photons at ~0.75 electron volts match the exact energy barrier electrons must cross in this chain — a discovery from the paper".replace(/^r/, "R"),
    new: "The video says red/near-infrared photons at ~0.75 electron volts match the exact energy barrier electrons must cross in this chain — a discovery from the paper",
  };
  const BULBS_B = {
    claimIndex: 5,
    verdict: "⚠️",
    old: '"Metabolism in the Solar Photon Field" (Fosbury, Jeffery et al.).',
    new: '"Metabolism in the Solar Photon Field" (Fosbury, Jeffery et al.); sources say this is a non-peer-reviewed preprint describing an overlap, not an exact match ([biorxiv.org](https://www.biorxiv.org/content/x)).',
  };

  test("Light Bulbs claim 5: the unattributed second half rides on the first", async () => {
    const r = await propose(BULBS, [BULBS_A, BULBS_B], [5]);
    expect(r.outcomes.map((o) => o.applied)).toEqual([true, true]);
    expect(r.dropped).toEqual([]);
  });

  test("document order, not list order: the attributed half listed second still covers the claim", async () => {
    const r = await propose(BULBS, [BULBS_B, BULBS_A], [5]);
    expect(r.outcomes.map((o) => o.applied)).toEqual([true, true]);
  });

  // Real shape: JWST claim 4 — "(per the video; sources say ~300 million)" plus an attributed edit.
  const JWST =
    "**JADES-GS-z14-0** (~290–350 million years after the Big Bang) and unnamed objects dated to ~300 million years or earlier that scientists can't even classify.";
  const JWST_PER = {
    claimIndex: 4,
    verdict: "⚠️",
    old: "(~290–350 million years after the Big Bang)",
    new: "(~290–350 million years after the Big Bang, per the video; sources say ~300 million ([en.wikipedia.org](https://en.wikipedia.org/wiki/JADES-GS-z14-0)))",
  };
  const JWST_SAYS = {
    claimIndex: 4,
    verdict: "⚠️",
    old: "and unnamed objects dated to ~300 million years or earlier that scientists can't even classify",
    new: "and, the video says, unnamed objects dated to ~300 million years or earlier that scientists can't even classify; sources say such objects are unconfirmed candidates ([scientificamerican.com](https://www.scientificamerican.com/x))",
  };

  test("the join is in document order: an attribution that spans two edits reads only that way", async () => {
    const body = "Alpha one. Beta two.";
    const first = { claimIndex: 2, verdict: "❌", old: "Alpha one.", new: "Alpha one, as the video" };
    const second = { claimIndex: 2, verdict: "❌", old: "Beta two.", new: "says, beta two; sources say three." };
    expect((await propose(body, [second, first], [2])).outcomes.map((o) => o.applied)).toEqual([true, true]);
  });

  test("JWST claim 4: the 'per the video' edit is kept with the attributed one", async () => {
    const r = await propose(JWST, [JWST_PER, JWST_SAYS], [4]);
    expect(r.outcomes.map((o) => o.applied)).toEqual([true, true]);
  });

  test("a claim none of whose edits attributes: every edit drops as not attributed", async () => {
    const r = await propose(JWST, [JWST_PER, { ...JWST_SAYS, new: JWST_SAYS.new.replace("the video says", "reportedly") }], [4]);
    expect(r.outcomes.filter((o) => o.applied)).toEqual([]);
    expect(r.dropped.map((d) => d.reason)).toEqual(["not attributed", "not attributed"]);
  });

  test("the check covers a claim the saved claims mark ❌/⚠️ even when the model's verdict says ✅", async () => {
    const r = await propose(JWST, [{ ...JWST_PER, verdict: "✅" }], [4]);
    expect(r.outcomes.filter((o) => o.applied)).toEqual([]);
    expect(r.dropped.map((d) => d.reason)).toEqual(["not attributed"]);
  });

  test("the check covers an edit the model marks ❌ even when the saved claims do not", async () => {
    const r = await propose(JWST, [{ ...JWST_PER, verdict: "❌" }], []);
    expect(r.outcomes.filter((o) => o.applied)).toEqual([]);
    expect(r.dropped.map((d) => d.reason)).toEqual(["not attributed"]);
  });

  test("a ✅ edit for a claim the saved claims do not mark is not checked", async () => {
    const r = await propose(JWST, [{ ...JWST_PER, verdict: "✅" }], []);
    expect(r.outcomes[0]!.applied).toBe(true);
  });

  test("a claim whose attributed edit cannot be placed: the rest drop for the missing edit, not as unattributed", async () => {
    const r = await propose(JWST, [{ ...JWST_SAYS, old: "Not in the summary." }, JWST_PER], [4]);
    expect(r.outcomes.filter((o) => o.applied)).toEqual([]);
    expect(r.dropped.find((d) => d.edit.old === JWST_PER.old)?.reason).toBe("another edit for claim 4 was dropped, so this one is too");
  });

  test("claim-0 edits are judged one by one: an attributed one does not cover another", async () => {
    const r = await propose(JWST, [
      { ...JWST_SAYS, claimIndex: 0, verdict: "❌" },
      { ...JWST_PER, claimIndex: 0, verdict: "❌" },
    ], []);
    expect(r.outcomes.filter((o) => o.applied).map((o) => o.edit.old)).toEqual([JWST_SAYS.old]);
    expect(r.dropped.map((d) => d.reason)).toEqual(["not attributed"]);
  });

  test("claim 0 is no group: one claim-0 edit failing does not drop another", async () => {
    const r = await propose(JWST, [
      { ...JWST_PER, claimIndex: 0, verdict: "" },
      { claimIndex: 0, verdict: "", old: "Not in the summary.", new: "x" },
    ], []);
    expect(r.outcomes.map((o) => o.applied)).toEqual([true, false]);
  });
});

describe("fix round 2: the structure checks", () => {
  // Found by enumerating pairs of single-line insertions: each edit alone keeps
  // the structure, together the second closing takeaway moves the cut.
  const BASE = "Intro claim one.\n\nSecond para two.\n\n## Visual reference\n\nA caption.\n\n## More\n\nTail claim three.\n\nTail four.";
  test("two edits that each keep the structure but together move it are both dropped", async () => {
    const { proposeSummaryEdits, summaryEditSlices } = await import("./factcheck-integrate.ts");
    const a = { claimIndex: 1, verdict: "", old: "three.", new: "three.\n\n> 💬 **Takeaway:** x", reason: "" };
    const b = { claimIndex: 2, verdict: "", old: "## More", new: "> 💬 **Takeaway:** x\n\n## More", reason: "" };
    const run = (edits: typeof a[]) =>
      proposeSummaryEdits({ slices: summaryEditSlices(BASE), edits, priorDrops: [], sourceNoun: "the video", correctable: new Set(), bodyLen: 20_000 });
    expect(run([a]).outcomes[0]!.applied).toBe(true);
    expect(run([b]).outcomes[0]!.applied).toBe(true);
    const both = run([a, b]);
    expect(both.outcomes.map((o) => o.applied)).toEqual([false, false]);
    expect(both.dropped.map((d) => d.reason)).toEqual([
      "together with the other edits, would change the summary's structure",
      "together with the other edits, would change the summary's structure",
    ]);
  });

  test("a stored block below the visual section is no structure change when the write moves it above", async () => {
    const { summaryStructureChanged } = await import("./factcheck-integrate.ts");
    const block = buildSummaryFactcheckBlock("### ❌ Claim 1/1 — x\n\nSources say y.", "2026-10-06");
    const stored = `Intro claim.\n\n## Visual reference\n\nA caption.\n\n${block}`;
    const written = insertSummaryFactcheckBlock(stored, block);
    expect(written.indexOf("## Fact check")).toBeLessThan(written.indexOf("## Visual reference"));
    expect(summaryStructureChanged(stored, written)).toBe(false);
  });
});

describe("fix round 2: the preview selects per claim", () => {
  test("one checkbox per claim, naming every edit index of that claim", () => {
    const html = summaryIntegratePreviewHtml(
      [
        { claimIndex: 5, verdict: "⚠️", new: "a", reason: "", resolvedText: "x" },
        { claimIndex: 2, verdict: "❌", new: "b", reason: "", resolvedText: "y" },
        { claimIndex: 5, verdict: "⚠️", new: "c", reason: "", resolvedText: "z" },
        { claimIndex: 0, verdict: "", new: "d", reason: "", resolvedText: "w" },
        { claimIndex: 0, verdict: "", new: "e", reason: "", resolvedText: "v" },
      ],
      [],
      new Map(),
    );
    expect(html.match(/class="sum-fc-int-cb"/g)).toHaveLength(4);
    expect(html).toContain('data-edit-idxs="0,2"');
    expect(html).toContain('data-edit-idxs="1"');
    expect(html).toContain('data-edit-idxs="3"');
    expect(html).toContain('data-edit-idxs="4"');
    expect(html.match(/class="sum-fc-int-diff"/g)).toHaveLength(5);
  });
});

describe("attribution is judged per run of contiguous edits (#650 follow-up)", () => {
  const propose = async (body: string, edits: { claimIndex: number; old: string; new: string }[]) => {
    const { proposeSummaryEdits, summaryEditSlices } = await import("./factcheck-integrate.ts");
    const r = proposeSummaryEdits({
      slices: summaryEditSlices(body),
      edits: edits.map((e) => ({ reason: "", verdict: "❌", ...e })),
      priorDrops: [],
      sourceNoun: "the video",
      correctable: new Set(),
      bodyLen: 20_000,
    });
    return r.outcomes.map((o) => (o.applied ? "ok" : o.reason));
  };
  const SAYS = "The video says adults need 4 hours of sleep; sources say 7–9.";
  const SILENT = "Adults need 7–9 hours of sleep.";
  const PARA = "Adults need 4 hours of sleep. Alpha one. Gamma. Beta two.";
  const TWO_SLICES = `${PARA}\n\n## Visual reference\n\nCap.\n\n> 💬 **Takeaway:** Rest 4 hours.`;
  const LIST = `## Key takeaways\n\n- Sleep 4 hours a night.\n- Coffee is fine.\n\n${PARA}`;
  const DROPPED = (c: number) => `another edit for claim ${c} was dropped, so this one is too`;
  const body = { claimIndex: 1, old: "Adults need 4 hours of sleep.", new: SAYS };
  const silentBody = { ...body, new: SILENT };
  const takeaway = { claimIndex: 1, old: "Sleep 4 hours a night.", new: "The video says sleep 4 hours a night; sources say 7–9." };
  const silentTakeaway = { ...takeaway, new: "Sleep 7–9 hours a night." };
  const halfA = { claimIndex: 1, old: "Alpha one.", new: "Alpha one, as the video" };
  const halfB = { claimIndex: 1, old: "Beta two.", new: "says, beta two; sources say three." };

  const rows: [string, string, { claimIndex: number; old: string; new: string }[], string[]][] = [
    ["one run, attributed", PARA, [body], ["ok"]],
    ["one run, unattributed", PARA, [silentBody], ["not attributed"]],
    ["several runs, all attributed", LIST, [takeaway, body], ["ok", "ok"]],
    ["several runs, one unattributed: the takeaway does not cover the body", LIST, [takeaway, silentBody], [DROPPED(1), "not attributed"]],
    ["two list items are two runs", LIST, [takeaway, { claimIndex: 1, old: "Coffee is fine.", new: "Coffee is fine at 4 hours." }], [DROPPED(1), "not attributed"]],
    ["an attribution spanning two contiguous edits", PARA.replace(" Gamma.", ""), [halfB, halfA], ["ok", "ok"]],
    ["another claim's edit between breaks the run", PARA, [{ ...halfA, new: "The video says alpha one; sources say two." }, { ...halfB, new: "Beta three." }, { claimIndex: 2, old: "Gamma.", new: "The video says gamma; sources say delta." }], [DROPPED(1), "not attributed", "ok"]],
    ["a paragraph break between: each edit must attribute alone", "Alpha one.\n\nBeta two.", [halfA, halfB], ["not attributed", "not attributed"]],
    ["different slices: each must attribute alone", TWO_SLICES, [body, { claimIndex: 1, old: "Rest 4 hours.", new: "Rest 7–9 hours." }], [DROPPED(1), "not attributed"]],
  ];
  test.each(rows)("%s", async (_name, text, edits, expected) => {
    expect(await propose(text, edits)).toEqual(expected);
  });
});
