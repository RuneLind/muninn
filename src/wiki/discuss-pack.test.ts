/**
 * Discuss's context pack (`discuss-pack.ts`) and the handoff prompt it feeds
 * (`discuss-prompt.ts`): the mask keeps line numbers, the section is bounded
 * with a marked cut, and the prompt carries five things and stays near the
 * prototype's size.
 */
import { describe, expect, test } from "bun:test";
import { buildContextPack, packMask, PACK_SECTION_MAX } from "./discuss-pack.ts";
import { buildHandoff, HANDOFF_PROMPT_MAX, planCardCommand, renderHandoffPrompt } from "./discuss-prompt.ts";
import { parseDiscussReaderConfig } from "./store.ts";
import { readerPayload } from "./render.ts";

const page = (...lines: string[]) => lines.join("\n") + "\n";

const PLAN = page(
  "---", //                                   1
  "title: Harbour plan",
  "plan_status: in-flight",
  "---",
  "", //                                      5
  "# Harbour plan",
  "",
  "## Design",
  "",
  '<Fold title="Routes" summary="three">', // 10
  "",
  "- **R2, behind.** The page's `status_date` is older than the newest merge.",
  'A <Fact n="1" v="ok">checked</Fact> claim.',
  "",
  "```md", //                                 15
  "<Callout>kept as code</Callout>",
  "```",
  "",
  "</Fold>",
  "", //                                      20
  "## Other",
  "",
  "Other text.",
);

const ABS = "/home/example/wiki/plans/harbour.mdx";
const input = { wiki: "w", relPath: "plans/harbour.mdx", title: "Harbour plan", absPath: ABS, raw: PLAN };

describe("the mask", () => {
  test("frontmatter and block component tag lines become empty lines, one for one; code and fact wrappers stay", () => {
    const m = packMask(PLAN);
    expect(m.length).toBe(PLAN.split("\n").length);
    expect(m.slice(0, 4)).toEqual(["", "", "", ""]);
    expect(m[9]).toBe("");
    expect(m[18]).toBe("");
    expect(m[12]).toBe('A <Fact n="1" v="ok">checked</Fact> claim.');
    expect(m[15]).toBe("<Callout>kept as code</Callout>");
    expect(m[11]).toContain("R2, behind.");
  });
});

describe("the pack", () => {
  test("a passage: its lines, the section it sits in with the file's line numbers, the headings", () => {
    const pack = buildContextPack({ ...input, selection: "R2, behind. The page's status_date is older than the newest merge.", heading: "Design" });
    expect(pack.location).toMatchObject({ found: "one", fromLine: 12, toLine: 12 });
    expect(pack.section).toMatchObject({ heading: "Design", fromLine: 8, toLine: 19, cut: false });
    expect(pack.section.text.split("\n")[12 - 8]).toContain("R2, behind.");
    expect(pack.headingTrail).toEqual(["Harbour plan", "Design"]);
    expect(pack.headings.map((h) => h.text)).toEqual(["Harbour plan", "Design", "Other"]);
    expect(pack.path).toBe(ABS);
  });
  test("the whole page: no passage, the text from the top under the same bound", () => {
    const pack = buildContextPack(input);
    expect(pack.passage).toBeNull();
    expect(pack.location).toBeNull();
    expect(pack.section.fromLine).toBe(5);
  });
  test("a section past the bound is cut, and the cut is marked", () => {
    const long = page("# L", "", ...Array.from({ length: 400 }, (_, k) => `Line ${k} of a very long section about the harbour.`));
    const pack = buildContextPack({ ...input, raw: long, selection: "Line 3 of a very long section about the harbour." });
    expect(pack.section.cut).toBe(true);
    expect(pack.section.text.length).toBeLessThan(PACK_SECTION_MAX + 200);
    expect(pack.section.text).toMatch(/\[… cut at 12,000 characters; the section runs to line 402 …\]$/);
  });
});

describe("the prompt", () => {
  test("five things: the card command, the path, the line range, the passage and the question", () => {
    const { prompt } = buildHandoff({
      ...input,
      selection: "R2, behind. The page's status_date is older than the newest merge.",
      heading: "Design",
      cardCommand: planCardCommand("~/.claude/skills/plan-card/plan-card.ts", ABS),
      question: "Does R2 read the frontmatter status_date or the Brief's Status line?",
    });
    expect(prompt).toBe(
      [
        "Read the card first, then the lines I point at. Do not load the whole page unless you need it:",
        `  bun --no-env-file ~/.claude/skills/plan-card/plan-card.ts ${ABS}`,
        "",
        `Page: ${ABS}`,
        "",
        "Passage (line 12, Harbour plan › Design):",
        "> R2, behind. The page's status_date is older than the newest merge.",
        "",
        "Question: Does R2 read the frontmatter status_date or the Brief's Status line?",
        "",
        "Check the code before you answer. If the page turns out to be wrong, show me the edit before you write it.",
      ].join("\n"),
    );
    // Near the prototype's 746 characters for one passage and one question.
    expect(prompt.length).toBeLessThan(800);
  });
  test("no card command without one; the section fallback and a missing end say so", () => {
    const fallback = renderHandoffPrompt(buildContextPack({ ...input, selection: "Not on this page at all.", heading: "Other" }), "q");
    expect(fallback).not.toContain("plan-card");
    expect(fallback).toContain("Passage (not placed exactly; it is in the section «Other», lines 21–23):");
    const none = renderHandoffPrompt(buildContextPack({ ...input, selection: "Not on this page at all." }), "q");
    expect(none).toContain("Passage (not found in the file as selected):");
    expect(none).not.toMatch(/\blines? \d/);
  });
  test("bounded: a huge passage gives way, the path and the question stay", () => {
    const pack = buildContextPack({ ...input, selection: "word ".repeat(5000) });
    const prompt = renderHandoffPrompt(pack, "Q?".repeat(1500));
    expect(prompt.length).toBeLessThanOrEqual(HANDOFF_PROMPT_MAX);
    expect(prompt).toContain(`Page: ${ABS}`);
    expect(prompt).toContain("Question: " + "Q?".repeat(1000));
  });
  test("a path with a space is quoted in the card command", () => {
    expect(planCardCommand("/opt/pc.ts", "/home/a b/p.mdx")).toBe("bun --no-env-file /opt/pc.ts '/home/a b/p.mdx'");
  });
});

describe("the reader config key and the page payload", () => {
  test("discuss.handoff: true, false, absent, or bad (off with a warning)", () => {
    expect(parseDiscussReaderConfig({ handoff: true })).toEqual({ handoff: true });
    expect(parseDiscussReaderConfig(undefined)).toEqual({ handoff: false });
    expect(parseDiscussReaderConfig({})).toEqual({ handoff: false });
    expect(parseDiscussReaderConfig({ handoff: "yes" }).handoff).toBe(false);
    expect(parseDiscussReaderConfig({ handoff: "yes" }).warning).toBeDefined();
    expect(parseDiscussReaderConfig([true]).warning).toBeDefined();
  });
  test("the payload offers it only on an opted-in wiki and to an admin", () => {
    const cfg = (handoff: boolean) => ({ discuss: { handoff } }) as never;
    expect(readerPayload("w", cfg(true), undefined, { roles: [], admin: true }).discussHandoff).toBe(true);
    expect(readerPayload("w", cfg(true), undefined, { roles: [], admin: false }).discussHandoff).toBe(false);
    expect(readerPayload("w", cfg(false), undefined, { roles: [], admin: true }).discussHandoff).toBe(false);
    expect(readerPayload("w", null, undefined, { roles: [], admin: true }).discussHandoff).toBe(false);
  });
});
