/**
 * The visual-coverage policy and the pass that enforces it.
 *
 * The prompt half is a promise; this is the half that makes it true. Every case
 * below is a way a summary can quote a picture nobody can serve — a second that
 * was never extracted, another video's id, a spelling the route 404s, the same
 * frame twice, or one more than the policy allows — and the property under test
 * is always the same: what comes out references only frames this capture has,
 * and no more of them than it said.
 *
 * Pure and import-free of any I/O, so it runs in the shared chunk.
 */

import { describe, expect, test } from "bun:test";
import {
  MAX_INLINE_SLIDES,
  VIMEO_FRAME_SOURCE,
  YOUTUBE_FRAME_SOURCE,
  framesPromptSection,
  parseFrameAddress,
  referencedFrameSeconds,
  type CaptureFrame,
} from "./frames.ts";
import {
  DEFAULT_VISUAL_DETAIL,
  MAX_DETAILED_VISUALS,
  VISUAL_DETAIL_VALUES,
  dropFrameReferences,
  enforceVisualReferences,
  isVisualDetail,
  visualDetailCaps,
  visualDetailOptions,
  visualDetailPolicy,
  type VisualDetail,
} from "./visual-detail.ts";

const YT_ID = "Vjh3YCnI3vo";

/** `![Slide at …](…)` for one second of this video. */
function quote(sec: number, id = YT_ID): string {
  return `![Slide at 00:00:${String(sec).padStart(2, "0")}](/api/frames/youtube/${id}/${sec}.jpg)`;
}

function run(input: {
  summary: string;
  extracted: readonly number[];
  detail?: VisualDetail;
  videoId?: string;
}) {
  return enforceVisualReferences({
    summary: input.summary,
    source: YOUTUBE_FRAME_SOURCE,
    videoId: input.videoId ?? YT_ID,
    extracted: input.extracted,
    detail: input.detail ?? "selected",
  });
}

describe("the policy the prompt states", () => {
  test("selected caps everything at the inline bound; detailed adds an appendix", () => {
    expect(visualDetailCaps("selected")).toEqual({
      maxInline: MAX_INLINE_SLIDES,
      maxTotal: MAX_INLINE_SLIDES,
    });
    expect(visualDetailCaps("detailed")).toEqual({
      maxInline: MAX_INLINE_SLIDES,
      maxTotal: MAX_DETAILED_VISUALS,
    });
  });

  test("the detailed ceiling is twenty, in the constant AND in the rules the model reads", () => {
    // Pinned HERE, beside the pass that enforces it, and not only in the
    // summarizer test that counts images: the number is a product limit to
    // evaluate, so a change to it is a decision, never a side effect.
    expect(MAX_DETAILED_VISUALS).toBe(20);
    expect(visualDetailPolicy("detailed", YOUTUBE_FRAME_SOURCE, YT_ID).rules).toContain(
      `${MAX_DETAILED_VISUALS} distinct frames`,
    );
  });

  test("neither policy raises the seam's inline bound", () => {
    // The plan's explicit instruction: `MAX_INLINE_SLIDES` is not globally
    // raised, and a body with more than eight images is no longer a summary.
    for (const detail of VISUAL_DETAIL_VALUES) {
      expect(visualDetailCaps(detail).maxInline).toBeLessThanOrEqual(MAX_INLINE_SLIDES);
    }
  });

  test("the rules state the caps the pass will enforce, and the route's own address", () => {
    const selected = visualDetailPolicy("selected", YOUTUBE_FRAME_SOURCE, YT_ID);
    expect(selected.rules).toContain(`/api/frames/youtube/${YT_ID}/<sec>.jpg`);
    expect(selected.rules).toContain(`At most ${MAX_INLINE_SLIDES} distinct frames`);
    expect(selected.rules).not.toContain("Visual reference");

    const detailed = visualDetailPolicy("detailed", YOUTUBE_FRAME_SOURCE, YT_ID);
    expect(detailed.rules).toContain("## Visual reference");
    expect(detailed.rules).toContain(`${MAX_INLINE_SLIDES} frames inline`);
    expect(detailed.rules).toContain(`${MAX_DETAILED_VISUALS} distinct frames`);
  });

  test("the revised inclusion rule is the one the prompt carries", () => {
    // "adds facts the transcript did not say" excluded the frames a talk is
    // ABOUT: a speaker reading their own chart aloud disqualified the chart.
    for (const detail of VISUAL_DETAIL_VALUES) {
      const rules = visualDetailPolicy(detail, YOUTUBE_FRAME_SOURCE, YT_ID).rules;
      expect(rules).toContain("explain, compare, verify or revisit");
      expect(rules).toContain("talking through a chart is a reason to show it");
      expect(rules).toContain("does not disqualify");
      expect(rules).not.toContain("ADDS something the transcript did not say");
    }
  });

  test("a policy that tried to quote more than the seam allows is refused", () => {
    const frames: CaptureFrame[] = [{ path: "/tmp/1.jpg", tSeconds: 1 }];
    expect(() =>
      framesPromptSection(YOUTUBE_FRAME_SOURCE, YT_ID, frames, {
        maxInline: MAX_INLINE_SLIDES + 1,
        maxTotal: 30,
        rules: "anything",
      }),
    ).toThrow(/at most 8 frames inline/i);
  });

  test("the picker rows and the enum agree, and the default is the cheaper policy", () => {
    expect(visualDetailOptions().map((o) => o.id)).toEqual([...VISUAL_DETAIL_VALUES]);
    expect(visualDetailOptions().every((o) => o.label.length > 0)).toBe(true);
    expect(DEFAULT_VISUAL_DETAIL).toBe("selected");
    expect(isVisualDetail("selected")).toBe(true);
    expect(isVisualDetail("detailed")).toBe(true);
    for (const bad of ["", "  ", "Selected", "exhaustive", 7, null, undefined, {}]) {
      expect(isVisualDetail(bad)).toBe(false);
    }
  });
});

describe("parseFrameAddress — what is an address this capture can serve", () => {
  test("the current spelling of this source", () => {
    expect(parseFrameAddress(`/api/frames/youtube/${YT_ID}/137.jpg`, YOUTUBE_FRAME_SOURCE)).toEqual({
      id: YT_ID,
      sec: 137,
    });
  });

  test("the legacy prefix, where the source declares one", () => {
    expect(parseFrameAddress("/api/vimeo/frames/1223642971/90.jpg", VIMEO_FRAME_SOURCE)).toEqual({
      id: "1223642971",
      sec: 90,
    });
    // YouTube has no legacy spelling, so the same path addresses nothing.
    expect(parseFrameAddress("/api/vimeo/frames/1223642971/90.jpg", YOUTUBE_FRAME_SOURCE)).toBeNull();
  });

  test("null for every path the route would not serve", () => {
    for (const path of [
      "/api/frames/vimeo/123/90.jpg", // another source
      `/api/frames/youtube/${YT_ID}/047.jpg`, // 404s: the file is 47.jpg
      `/api/frames/youtube/${YT_ID}/137.png`,
      `/api/frames/youtube/${YT_ID}/137`,
      `/api/frames/youtube/${YT_ID}/sub/137.jpg`,
      "/api/frames/youtube//137.jpg",
      `/api/frames/youtube/${YT_ID}`,
      "https://example.com/137.jpg",
    ]) {
      expect(parseFrameAddress(path, YOUTUBE_FRAME_SOURCE)).toBeNull();
    }
  });
});

describe("enforceVisualReferences — the stored text promises only what exists", () => {
  test("a summary quoting only extracted frames is returned untouched", () => {
    const summary = `Intro.\n\n${quote(137)}\n\nMore.\n\n${quote(1472)}\n`;
    const out = run({ summary, extracted: [137, 1472] });
    expect(out.text).toBe(summary);
    expect(out.referenced).toEqual([137, 1472]);
    expect(out.selected).toEqual([137, 1472]);
    expect(out.droppedInvalid).toBe(0);
  });

  test("a summary with no frame quotes at all is returned untouched", () => {
    const summary = "Just prose, with a ![diagram](https://example.com/x.png) from elsewhere.";
    const out = run({ summary, extracted: [137] });
    expect(out.text).toBe(summary);
    expect(out.referenced).toEqual([]);
  });

  test("an invented timestamp is removed — with the line it sat on", () => {
    const summary = `Intro.\n\n${quote(137)}\n\n${quote(999)}\n\nOutro.`;
    const out = run({ summary, extracted: [137] });
    expect(out.text).toContain("/137.jpg");
    expect(out.text).not.toContain("999");
    expect(out.text).toContain("Outro.");
    expect(out.droppedInvalid).toBe(1);
    expect(out.referenced).toEqual([137]);
    // Never extracted ⇒ never SELECTED either: `selected` is what the model
    // chose out of what it was shown.
    expect(out.selected).toEqual([137]);
  });

  test("another video's frames, another source's frames and an unservable spelling all go", () => {
    const summary = [
      "A.",
      quote(137),
      "B.",
      quote(137, "abcdefghijk"),
      "C.",
      "![Slide at 00:02:17](/api/frames/vimeo/1223642971/137.jpg)",
      "D.",
      `![Slide at 00:02:17](/api/frames/youtube/${YT_ID}/0137.jpg)`,
      "E.",
    ].join("\n\n");
    const out = run({ summary, extracted: [137] });
    expect(out.droppedInvalid).toBe(3);
    expect(out.referenced).toEqual([137]);
    expect(out.text).not.toContain("abcdefghijk");
    expect(out.text).not.toContain("vimeo");
    expect(out.text).not.toContain("0137.jpg");
    // The prose between them survives.
    for (const line of ["A.", "B.", "C.", "D.", "E."]) expect(out.text).toContain(line);
  });

  test("with NOTHING extracted, every frames address is invented", () => {
    const out = run({ summary: `Intro.\n\n${quote(137)}\n\nOutro.`, extracted: [] });
    expect(out.text).not.toContain("/api/frames/");
    expect(out.referenced).toEqual([]);
    expect(out.droppedInvalid).toBe(1);
  });

  test("a repeated frame keeps the first and drops the rest", () => {
    const summary = `A.\n\n${quote(137)}\n\nB.\n\n${quote(137)}\n\nC.`;
    const out = run({ summary, extracted: [137] });
    expect(out.text.match(/137\.jpg/g)).toHaveLength(1);
    expect(out.droppedDuplicate).toBe(1);
    expect(out.referenced).toEqual([137]);
  });

  test("selected keeps at most eight, whatever the model quoted", () => {
    const secs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
    const summary = secs.map((s) => `Point.\n\n${quote(s)}`).join("\n\n");
    const out = run({ summary, extracted: secs, detail: "selected" });
    expect(out.referenced).toHaveLength(MAX_INLINE_SLIDES);
    expect(out.referenced).toEqual(secs.slice(0, MAX_INLINE_SLIDES));
    expect(out.selected).toHaveLength(secs.length);
    expect(out.droppedOverCap).toBe(secs.length - MAX_INLINE_SLIDES);
    expect(out.text.match(/\/api\/frames\//g)).toHaveLength(MAX_INLINE_SLIDES);
  });

  test("selected does not grant an appendix — the heading buys nothing", () => {
    const inline = [10, 20, 30, 40, 50, 60, 70, 80];
    const appendix = [90, 100];
    const summary =
      `${inline.map((s) => quote(s)).join("\n\n")}\n\n## Visual reference\n\n` +
      appendix.map((s) => `${quote(s)}\nWhy it is here.`).join("\n\n");
    const out = run({ summary, extracted: [...inline, ...appendix], detail: "selected" });
    expect(out.referenced).toEqual(inline);
    expect(out.droppedOverCap).toBe(appendix.length);
  });

  test("detailed allows eight inline plus the rest of twenty under the heading", () => {
    const inline = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const appendix = Array.from({ length: 18 }, (_, i) => 200 + i * 10);
    const summary =
      `${inline.map((s) => `Point.\n\n${quote(s)}`).join("\n\n")}\n\n## Visual reference\n\n` +
      appendix.map((s) => `${quote(s)}\nWhy it is here.`).join("\n\n");
    const out = run({ summary, extracted: [...inline, ...appendix], detail: "detailed" });

    expect(out.referenced).toHaveLength(MAX_DETAILED_VISUALS);
    // Eight inline, twelve in the appendix.
    const [body, tail] = out.text.split("## Visual reference") as [string, string];
    expect(body.match(/\/api\/frames\//g)).toHaveLength(MAX_INLINE_SLIDES);
    expect(tail.match(/\/api\/frames\//g)).toHaveLength(MAX_DETAILED_VISUALS - MAX_INLINE_SLIDES);
    expect(out.droppedOverCap).toBe(inline.length + appendix.length - MAX_DETAILED_VISUALS);
  });

  test("detailed with no appendix heading is still bounded by the inline cap", () => {
    // Nothing is "after the heading" when there is no heading, so every quote is
    // an inline one and the eight-image body rule still binds.
    const secs = Array.from({ length: 14 }, (_, i) => 10 + i * 10);
    const summary = secs.map((s) => `Point.\n\n${quote(s)}`).join("\n\n");
    const out = run({ summary, extracted: secs, detail: "detailed" });
    expect(out.referenced).toHaveLength(MAX_INLINE_SLIDES);
  });

  test("a quote inside a sentence loses the image and keeps the prose", () => {
    const summary = `The chart ${quote(999)} shows growth.`;
    const out = run({ summary, extracted: [137] });
    expect(out.text).toBe("The chart  shows growth.");
  });

  test("a quote in a list bullet takes the bullet with it", () => {
    const summary = `Points:\n\n- ${quote(999)}\n- Still here.\n`;
    const out = run({ summary, extracted: [] });
    expect(out.text).toBe("Points:\n\n- Still here.\n");
  });

  test("a markdown title on the image is part of the reference", () => {
    const summary = `A.\n\n![Slide at 00:16:39](/api/frames/youtube/${YT_ID}/999.jpg "The chart")\n\nB.`;
    const out = run({ summary, extracted: [137] });
    expect(out.text).not.toContain("999.jpg");
    expect(out.text).not.toContain("The chart");
    expect(out.droppedInvalid).toBe(1);
  });

  test("the pass is idempotent — running it over its own answer changes nothing", () => {
    const secs = [10, 20, 30, 40, 50, 60, 70, 80, 90];
    const summary = `${secs.map((s) => quote(s)).join("\n\n")}\n\n${quote(999)}\n`;
    const once = run({ summary, extracted: secs });
    const twice = run({ summary: once.text, extracted: secs });
    expect(twice.text).toBe(once.text);
    expect(twice.droppedInvalid + twice.droppedDuplicate + twice.droppedOverCap).toBe(0);
  });
});

describe("dropFrameReferences — the repair for a frame that could not be copied", () => {
  test("only the named seconds go", () => {
    const summary = `A.\n\n${quote(137)}\n\nB.\n\n${quote(1472)}\n\nC.`;
    const out = dropFrameReferences(summary, YOUTUBE_FRAME_SOURCE, YT_ID, [1472]);
    expect(out.removed).toBe(1);
    expect(out.text).toContain("137.jpg");
    expect(out.text).not.toContain("1472.jpg");
    expect(out.text).toContain("C.");
  });

  test("an empty list is a no-op, and so is a second with nothing quoting it", () => {
    const summary = `A.\n\n${quote(137)}\n`;
    expect(dropFrameReferences(summary, YOUTUBE_FRAME_SOURCE, YT_ID, [])).toEqual({
      text: summary,
      removed: 0,
    });
    expect(dropFrameReferences(summary, YOUTUBE_FRAME_SOURCE, YT_ID, [999])).toEqual({
      text: summary,
      removed: 0,
    });
  });

  test("another video's quote of the same second is left alone", () => {
    const summary = `${quote(137, "abcdefghijk")}\n`;
    expect(dropFrameReferences(summary, YOUTUBE_FRAME_SOURCE, YT_ID, [137]).removed).toBe(0);
  });

  test("every occurrence of a named second goes, not just the first", () => {
    const summary = `A.\n\n${quote(137)}\n\nB.\n\n${quote(137)}\n`;
    const out = dropFrameReferences(summary, YOUTUBE_FRAME_SOURCE, YT_ID, [137]);
    expect(out.removed).toBe(2);
    expect(out.text).not.toContain("/api/frames/");
  });
});

describe("the appendix is a SECTION, not one exact heading spelling", () => {
  const inline = [10, 20, 30];
  const extra = [40, 50, 60, 70, 80, 90];

  /** Three inline quotes, a heading in the given spelling, six appendix entries. */
  function withHeading(heading: string): string {
    return (
      `${inline.map((s) => `Point.\n\n${quote(s)}`).join("\n\n")}\n\n${heading}\n\n` +
      extra.map((s) => `${quote(s)}\nWhy it is here.`).join("\n\n")
    );
  }

  test("every spelling a model reaches for opens the appendix", () => {
    // Under `detailed` the appendix's own bound is twenty, so all nine survive —
    // but ONLY if the heading was recognized. Read as prose, the same nine
    // quotes are nine INLINE ones and the eighth is the last that fits.
    for (const heading of [
      "## Visual reference",
      "## Visual Reference",
      "## Visual references",
      "##Visual reference",
      "## **Visual reference**",
      "### Visual reference",
      "## Visual reference:",
    ]) {
      const out = run({ summary: withHeading(heading), extracted: [...inline, ...extra], detail: "detailed" });
      expect({ heading, referenced: out.referenced.length, overCap: out.droppedOverCap }).toEqual({
        heading,
        referenced: inline.length + extra.length,
        overCap: 0,
      });
    }
  });

  test("a sentence that merely NAMES the section is not the heading", () => {
    const summary =
      `${inline.map((s) => `Point.\n\n${quote(s)}`).join("\n\n")}\n\n` +
      `The rest are under ## Visual reference below.\n\n` +
      extra.map((s) => quote(s)).join("\n\n");
    // Nine inline quotes and no appendix: the ninth is over the inline cap.
    const out = run({ summary, extracted: [...inline, ...extra], detail: "detailed" });
    expect(out.referenced).toHaveLength(MAX_INLINE_SLIDES);
    expect(out.droppedOverCap).toBe(1);
  });

  test("a heading quoted inside a fence does not open the appendix", () => {
    // The `detailed` rules paragraph shows the model this very shape, so a
    // summary echoing it in a fence is ordinary. Read as the appendix, it starts
    // at the top of the document and the inline cap never applies to anything.
    const secs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const summary =
      "```markdown\n## Visual reference\n\n![Slide at 00:00:10](/api/frames/youtube/x/10.jpg)\n```\n\n" +
      secs.map((s) => `Point.\n\n${quote(s)}`).join("\n\n");
    const out = run({ summary, extracted: secs, detail: "detailed" });
    expect(out.referenced).toHaveLength(MAX_INLINE_SLIDES);
    expect(out.droppedOverCap).toBe(secs.length - MAX_INLINE_SLIDES);
  });

  test("under selected the whole section goes — heading, entries and captions", () => {
    const out = run({ summary: withHeading("## Visual reference"), extracted: [...inline, ...extra], detail: "selected" });
    expect(out.referenced).toEqual(inline);
    expect(out.text).not.toContain("Visual reference");
    expect(out.text).not.toContain("Why it is here.");
    expect(out.text).toContain("Point.");
    expect(out.droppedOverCap).toBe(extra.length);
  });

  test("under detailed an appendix no entry survived goes with its captions", () => {
    // Every entry names a second this capture never extracted, so the section is
    // left as a heading over six captions describing pictures that are not there.
    const summary = withHeading("## Visual reference");
    const out = run({ summary, extracted: inline, detail: "detailed" });
    expect(out.referenced).toEqual(inline);
    expect(out.text).not.toContain("Visual reference");
    expect(out.text).not.toContain("Why it is here.");
    // The body is untouched.
    for (const s of inline) expect(out.text).toContain(`/${s}.jpg`);
  });

  test("an appendix with one surviving entry keeps the section", () => {
    const summary = withHeading("## Visual reference");
    const out = run({ summary, extracted: [...inline, extra[0]!], detail: "detailed" });
    expect(out.referenced).toEqual([...inline, extra[0]!]);
    expect(out.text).toContain("## Visual reference");
    expect(out.text).toContain(`/${extra[0]}.jpg`);
  });

  test("the section ends at the next heading of its own level or above", () => {
    const summary =
      `${quote(10)}\n\n## Visual reference\n\n${quote(999)}\nA caption.\n\n## Transcript\n\n### [00:00:00]\nWords.\n`;
    const out = run({ summary, extracted: [10], detail: "detailed" });
    expect(out.text).not.toContain("Visual reference");
    expect(out.text).not.toContain("A caption.");
    expect(out.text).toContain("## Transcript");
    expect(out.text).toContain("### [00:00:00]");
    expect(out.text).toContain("Words.");
  });
});

describe("what counts as a quote is what the copy would serve", () => {
  test("a plain LINK to a frame is a quote — capped, and removable when invented", () => {
    const summary = `A.\n\n[the growth chart](/api/frames/youtube/${YT_ID}/999.jpg)\n\nB.`;
    const out = run({ summary, extracted: [137] });
    expect(out.droppedInvalid).toBe(1);
    expect(out.text).not.toContain("999.jpg");
    expect(out.text).toContain("A.");
    expect(out.text).toContain("B.");
  });

  test("an alt carrying a `]` is a quote", () => {
    const summary = `![Slide at 00:16:39 [the chart]](/api/frames/youtube/${YT_ID}/999.jpg)\n`;
    const out = run({ summary, extracted: [137] });
    expect(out.droppedInvalid).toBe(1);
    expect(out.text).not.toContain("999.jpg");
  });

  test("what the pass says it kept is exactly what the copy would keep", () => {
    // The property the two patterns disagreed on: `referenced` is handed to
    // `keepReferencedFrames` and decides which JPEGs are served, so a quote
    // this pass cannot see is a file copied with nothing holding it.
    const summary = [
      `Inline: ${quote(10)}`,
      `A link: [the chart](/api/frames/youtube/${YT_ID}/20.jpg)`,
      `Odd alt: ![Slide at 00:00:30 [chart]](/api/frames/youtube/${YT_ID}/30.jpg)`,
      `Invented: ${quote(999)}`,
      `In a fence:\n\n\`\`\`\n${quote(40)}\n\`\`\``,
    ].join("\n\n");
    const out = run({ summary, extracted: [10, 20, 30, 40] });
    expect(out.referenced).toEqual([10, 20, 30]);
    expect(referencedFrameSeconds(out.text, YOUTUBE_FRAME_SOURCE, YT_ID)).toEqual(out.referenced);
  });

  test("a quote inside a fence or inline code is documentation, not a picture", () => {
    const summary =
      "The address shape is `" +
      `![Slide at 00:00:10](/api/frames/youtube/${YT_ID}/10.jpg)` +
      "`.\n\n```markdown\n" +
      `${quote(999)}\n` +
      "```\n\nReal one:\n\n" +
      quote(20);
    const out = run({ summary, extracted: [20] });
    // Neither the fenced invented second nor the inline-code example is counted…
    expect(out.referenced).toEqual([20]);
    expect(out.droppedInvalid).toBe(0);
    // …and neither is rewritten: the source text a reader copies is verbatim.
    expect(out.text).toContain("`![Slide at 00:00:10](/api/frames/youtube/" + YT_ID + "/10.jpg)`");
    expect(out.text).toContain("999.jpg");
  });

  test("a fenced example cannot exhaust the cap", () => {
    const fenced = Array.from({ length: 10 }, (_, i) => quote(100 + i)).join("\n");
    const real = [10, 20, 30];
    const summary = "```\n" + fenced + "\n```\n\n" + real.map((s) => quote(s)).join("\n\n");
    const out = run({ summary, extracted: [...real, ...Array.from({ length: 10 }, (_, i) => 100 + i)] });
    expect(out.referenced).toEqual(real);
    expect(out.droppedOverCap).toBe(0);
  });
});

describe("a kept quote's alt says the time its own file does", () => {
  test("an alt naming another time is corrected to the parsed second", () => {
    const summary = `A.\n\n![Slide at 00:24:32](/api/frames/youtube/${YT_ID}/137.jpg)\n\nB.`;
    const out = run({ summary, extracted: [137] });
    expect(out.referenced).toEqual([137]);
    expect(out.text).toContain(`![Slide at 00:02:17](/api/frames/youtube/${YT_ID}/137.jpg)`);
    expect(out.text).not.toContain("00:24:32");
  });

  test("an alt that already agrees is untouched, in either spelling", () => {
    for (const alt of ["Slide at 00:02:17", "Slide at 02:17", "Slide at 00:00:137"]) {
      const summary = `![${alt}](/api/frames/youtube/${YT_ID}/137.jpg)`;
      expect(run({ summary, extracted: [137] }).text).toBe(summary);
    }
  });

  test("an alt with no time claims nothing and keeps its words", () => {
    const summary = `![The research-growth chart](/api/frames/youtube/${YT_ID}/137.jpg)`;
    expect(run({ summary, extracted: [137] }).text).toBe(summary);
  });

  test("words around the time survive the correction", () => {
    const summary = `![The chart at 00:24:32, redrawn](/api/frames/youtube/${YT_ID}/137.jpg)`;
    expect(run({ summary, extracted: [137] }).text).toBe(
      `![The chart at 00:02:17, redrawn](/api/frames/youtube/${YT_ID}/137.jpg)`,
    );
  });
});

describe("what a removed quote leaves behind", () => {
  test("an ordered-list item, a heading and a bold label go with the image", () => {
    for (const line of [
      `1. ${quote(999)}`,
      `1) ${quote(999)}`,
      `### ${quote(999)}`,
      `**Figure:** ${quote(999)}`,
      `> ${quote(999)}`,
    ]) {
      const summary = `Before.\n${line}\nAfter.\n`;
      expect(run({ summary, extracted: [] }).text).toBe("Before.\nAfter.\n");
    }
  });

  test("a link WRAPPING an image is removed whole, never left as an empty link", () => {
    const summary = `Before.\n[${quote(999)}](https://youtu.be/${YT_ID}?t=999)\nAfter.\n`;
    const out = run({ summary, extracted: [] });
    expect(out.text).toBe("Before.\nAfter.\n");
    expect(out.text).not.toContain("youtu.be");
  });

  test("a line with real prose on it keeps the prose", () => {
    const summary = `1. ${quote(999)} The chart shows growth.\n`;
    expect(run({ summary, extracted: [] }).text).toBe("1.  The chart shows growth.\n");
  });
});
