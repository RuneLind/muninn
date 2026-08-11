import { test, expect, describe } from "bun:test";
import {
  prepareWikiPageBody,
  prepareExplainerBody,
  prepareSummaryDocBody,
  prepareShareBody,
  clipShareBody,
  SHARE_BODY_MAX,
  SHARE_BODY_CLIP_MARKER,
} from "./body-prep.ts";
import { FACTCHECK_SENTINEL_START, FACTCHECK_SENTINEL_END } from "../wiki/factcheck-context.ts";

describe("prepareWikiPageBody", () => {
  test("strips frontmatter", () => {
    const raw = "---\ntitle: X\ntags: [a, b]\n---\nThe prose.";
    expect(prepareWikiPageBody(raw)).toBe("The prose.");
  });

  test("strips a persisted fact-check block whole (sentinels and inner prose)", () => {
    const raw = [
      "Body before.",
      "",
      FACTCHECK_SENTINEL_START,
      "> [!factcheck] Fact-checked",
      "> Claim 1 was wrong.",
      FACTCHECK_SENTINEL_END,
      "",
      "Body after.",
    ].join("\n");
    const out = prepareWikiPageBody(raw);
    expect(out).toBe("Body before.\n\nBody after.");
    expect(out).not.toContain("factcheck");
  });

  test("unwraps <Fact> marks but keeps the passage prose", () => {
    const raw = 'It weighed <Fact n="4" v="bad">1.32 kg</Fact> at launch.';
    expect(prepareWikiPageBody(raw)).toBe("It weighed 1.32 kg at launch.");
  });

  test("a fenced component sample keeps its prose, but NOT its tags", () => {
    // `stripFactWrappers` is zone-aware (src/web/CLAUDE.md) and leaves the fenced
    // tag alone — but the component-tag strip that runs after it is the one from
    // `similar.ts`, which is not. Pinned as the known, deliberate limitation:
    // sharing a page that documents the component vocabulary loses its tags.
    const raw = 'Prose.\n\n```md\n<Fact n="1" v="ok">example</Fact>\n```';
    const out = prepareWikiPageBody(raw);
    expect(out).toBe("Prose.\n\n```md\nexample\n```");
  });

  test("strips component tags but keeps their inner prose", () => {
    const raw = '<Callout tone="info">\nThe important bit.\n</Callout>';
    expect(prepareWikiPageBody(raw)).toBe("The important bit.");
  });

  // Adversarial review, EXECUTED repro: the component strip used to be
  // `similar.ts`'s, built on the newline-CROSSING tag source. A malformed opener
  // plus any later `>` deleted the prose between them.
  test("a malformed component opener does not swallow the prose below it", () => {
    const raw = [
      '<Callout tone="info"',
      "",
      "The paragraph that must survive.",
      "",
      "A quote> with a stray angle bracket.",
    ].join("\n");
    const out = prepareWikiPageBody(raw);
    expect(out).toContain("The paragraph that must survive.");
    expect(out).toContain("stray angle bracket");
  });

  test("flattens wiki-internal links and keeps external ones", () => {
    const raw = "See [[Harness Engineering]], [the plan](plans/x.mdx) and [docs](https://example.com).";
    expect(prepareWikiPageBody(raw)).toBe(
      "See Harness Engineering, the plan and [docs](https://example.com).",
    );
  });

  test("keeps emphasis and inline code — a shared post keeps its bold", () => {
    const raw = "This is **bold**, *italic* and `code`.";
    expect(prepareWikiPageBody(raw)).toBe("This is **bold**, *italic* and `code`.");
  });

  test("runs the whole pipeline in order on a realistic page", () => {
    const raw = [
      "---",
      "title: Zone 2",
      "type: concept",
      "---",
      "",
      '<Callout tone="warn">',
      "Read [[Cardio Basics|the basics]] first.",
      "</Callout>",
      "",
      'The rate is <Fact n="1" v="ok">**180 bpm**</Fact> per [the study](https://example.com/s).',
      "",
      FACTCHECK_SENTINEL_START,
      "> [!factcheck] appendix",
      FACTCHECK_SENTINEL_END,
    ].join("\n");
    expect(prepareWikiPageBody(raw)).toBe(
      "Read the basics first.\n\nThe rate is **180 bpm** per [the study](https://example.com/s).",
    );
  });
});

describe("prepareExplainerBody", () => {
  test("reduces HTML to prose, keeping heading markers", () => {
    const raw = "<html><head><style>p{color:red}</style></head><body><h2>Findings</h2><p>The point.</p></body></html>";
    const out = prepareExplainerBody(raw);
    expect(out).toContain("## Findings");
    expect(out).toContain("The point.");
    expect(out).not.toContain("<p>");
    expect(out).not.toContain("color:red");
  });

  test("drops inline svg wholesale (a rendered mermaid diagram is not prose)", () => {
    const raw = "<p>Before</p><svg><path d='M0 0'/></svg><p>After</p>";
    const out = prepareExplainerBody(raw);
    expect(out).toContain("Before");
    expect(out).toContain("After");
    expect(out).not.toContain("path");
  });
});

describe("prepareSummaryDocBody", () => {
  test("strips the leading bracketed breadcrumb", () => {
    const raw = "[youtube-summaries > 2026-08-01 > Some Talk]\n\nThe summary body.";
    expect(prepareSummaryDocBody(raw)).toBe("The summary body.");
  });

  test("strips frontmatter injected by huginn's tagger", () => {
    const raw = "---\ntags: [ai, agents]\n---\nThe summary body.";
    expect(prepareSummaryDocBody(raw)).toBe("The summary body.");
  });

  test("strips a leftover bare `tags:` line at the head", () => {
    const raw = "[coll > path]\ntags: ai, agents\n\nThe summary body.";
    expect(prepareSummaryDocBody(raw)).toBe("The summary body.");
  });

  test("a `tags:` line MID-BODY survives — the strip is head-anchored", () => {
    // The dashboard client pattern (no head anchor, no `g`) deletes the first
    // `tags:`-prefixed line anywhere in the doc. Do not copy that bug.
    const raw = "[coll > path]\nThe author explains their scheme.\n\ntags: are how huginn files things.";
    const out = prepareSummaryDocBody(raw);
    expect(out).toContain("tags: are how huginn files things.");
    expect(out).toBe("The author explains their scheme.\n\ntags: are how huginn files things.");
  });

  test("a doc with neither breadcrumb nor frontmatter is unchanged", () => {
    expect(prepareSummaryDocBody("Just the body.")).toBe("Just the body.");
  });

  // Adversarial review, EXECUTED repros: the pattern only required a bracketed
  // segment at the head, so any document OPENING with a bracket lost it — a
  // markdown link came back as a bare URL in parentheses, a bracketed lead-in
  // lost its first words. The breadcrumb now has to own its whole line.
  test("a leading markdown link is NOT a breadcrumb", () => {
    const raw = "[Read the original](https://example.com/post)\n\nBody";
    expect(prepareSummaryDocBody(raw)).toBe(raw);
  });

  test("a bracketed lead-in on a prose line is NOT a breadcrumb", () => {
    const raw = "[TL;DR] Everything you need";
    expect(prepareSummaryDocBody(raw)).toBe(raw);
  });

  test("a real full-line breadcrumb is still stripped", () => {
    expect(prepareSummaryDocBody("[youtube-summaries > 2026-08-01 > Talk]   \nBody")).toBe("Body");
  });
});

describe("clipShareBody", () => {
  test("a body at or under the cap is returned untouched", () => {
    const body = "x".repeat(SHARE_BODY_MAX);
    expect(clipShareBody(body)).toBe(body);
  });

  test("an over-cap body is clipped AND marked — the marker rides INSIDE the cap", () => {
    // The cap is hard: marker included, the result never exceeds `max`. Appended
    // on top (as it was until review) every clipped body came back 62 over.
    const out = clipShareBody("y".repeat(SHARE_BODY_MAX + 500));
    expect(out.endsWith(SHARE_BODY_CLIP_MARKER)).toBe(true);
    expect(out.length).toBe(SHARE_BODY_MAX);
  });

  test("truncation is surrogate-safe — no U+FFFD from a cut astral char", () => {
    const out = clipShareBody("🚀".repeat(200), 100);
    expect(out).not.toContain("�");
    expect(out.startsWith("🚀🚀")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith(SHARE_BODY_CLIP_MARKER)).toBe(true);
  });

  test("the clip applies through the preparers", () => {
    expect(prepareWikiPageBody("z".repeat(SHARE_BODY_MAX + 10))).toContain(SHARE_BODY_CLIP_MARKER);
  });
});

describe("prepareShareBody dispatcher", () => {
  test("routes each kind to its preparer", () => {
    expect(prepareShareBody("wiki", "---\ntitle: X\n---\nBody")).toBe("Body");
    expect(prepareShareBody("explainer", "<p>Body</p>")).toBe("Body");
    expect(prepareShareBody("summary", "[c > p]\nBody")).toBe("Body");
  });
});
