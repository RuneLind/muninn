/**
 * Discuss's context pack (`discuss-pack.ts`) and the handoff prompt it feeds
 * (`discuss-prompt.ts`): the mask keeps line numbers, the section is bounded
 * with a marked cut, a passage not placed carries no section, the whole
 * selection is located however long, and the prompt carries five things,
 * question last, and stays near the prototype's size.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildContextPack, packMask, PACK_SECTION_MAX } from "./discuss-pack.ts";
import { HANDOFF_SELECTION_MAX } from "./discuss-bounds.ts";
import { buildHandoff, HANDOFF_PROMPT_MAX, planCardCommand, quoteFor, renderHandoffPrompt } from "./discuss-prompt.ts";
import { parseDiscussReaderConfig, readWikiReaderConfig } from "./store.ts";
import { readerPayload } from "./render.ts";
import { PLAN_CARD_SKILL_SCRIPT, planCardTargetFor } from "./plan-card.ts";
import { testTempDir } from "../test/temp-dir.ts";

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
  "- **B4, late.** The ferry's `dock_time` is earlier than the first bell.",
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
/** B4's bullet as the reader shows it, with the context the client reads. */
const B4 = {
  selection: "B4, late. The ferry's dock_time is earlier than the first bell.",
  before: "Design Routes three",
  after: "A checked claim. <Callout>kept as code</Callout>",
  heading: "Design",
};

describe("the mask", () => {
  test("frontmatter and block component tag lines become empty lines, one for one; code and fact wrappers stay", () => {
    const m = packMask(PLAN);
    expect(m.length).toBe(PLAN.split("\n").length);
    expect(m.slice(0, 4)).toEqual(["", "", "", ""]);
    expect(m[9]).toBe("");
    expect(m[18]).toBe("");
    expect(m[12]).toBe('A <Fact n="1" v="ok">checked</Fact> claim.');
    expect(m[15]).toBe("<Callout>kept as code</Callout>");
    expect(m[11]).toContain("B4, late.");
  });
});

describe("the pack", () => {
  test("a passage: its lines, the section it sits in with the file's line numbers, the headings", () => {
    const pack = buildContextPack({ ...input, ...B4 });
    expect(pack.location).toMatchObject({ found: "exact", fromLine: 12, toLine: 12 });
    expect(pack.section).toMatchObject({ heading: "Design", fromLine: 8, toLine: 19, cut: false });
    expect(pack.section!.text.split("\n")[12 - 8]).toContain("B4, late.");
    expect(pack.headingTrail).toEqual(["Harbour plan", "Design"]);
    expect(pack.headings.map((h) => h.text)).toEqual(["Harbour plan", "Design", "Other"]);
    expect(pack.path).toBe(ABS);
  });
  test("the whole page: no passage, the text from the top under the same bound", () => {
    const pack = buildContextPack(input);
    expect(pack.passage).toBeNull();
    expect(pack.location).toBeNull();
    expect(pack.section!.fromLine).toBe(5);
  });
  test("finding 8: a passage not placed carries no section (never the head of the page)", () => {
    const pack = buildContextPack({ ...input, selection: "Not on this page at all." });
    expect(pack.location).toMatchObject({ found: "none" });
    expect(pack.section).toBeNull();
    expect(pack.headingTrail).toEqual([]);
  });
  test("a section past the bound is cut, and the cut is marked", () => {
    const long = page("# L", "", ...Array.from({ length: 400 }, (_, k) => `Line ${k} of a very long section about the harbour.`));
    const pack = buildContextPack({ ...input, raw: long, selection: "Line 3 of a very long section about the harbour.", before: "Line 2 of a very long section about the harbour.", after: "Line 4 of a very long section about the harbour." });
    expect(pack.section!.cut).toBe(true);
    expect(pack.section!.text.length).toBeLessThan(PACK_SECTION_MAX + 200);
    expect(pack.section!.text).toMatch(/\[… cut at 12,000 characters; the section runs to line 402 …\]$/);
  });
  test("finding 6: a selection past Explain's 1,500 characters is located whole, so the range runs to its end", () => {
    const lines = Array.from({ length: 60 }, (_, k) => `Line ${k} says something different about pier number ${k}.`);
    const long = page("# L", "", "Intro.", "", ...lines, "", "Outro.");
    const selection = lines.join("\n");
    expect(selection.length).toBeGreaterThan(1500);
    const pack = buildContextPack({ ...input, raw: long, selection, before: "L Intro.", atStart: true, after: "Outro.", atEnd: true });
    expect(pack.passage).toBe(selection);
    expect(pack.location).toMatchObject({ found: "exact", fromLine: 5, toLine: 64 });
  });
  test("a selection past the shared bound is refused, never cut", () => {
    expect(() => buildContextPack({ ...input, selection: "x".repeat(HANDOFF_SELECTION_MAX + 1) })).toThrow(RangeError);
  });
});

describe("the prompt", () => {
  test("five things: the card command, the path, the line range, the passage, and the question last", () => {
    const { prompt } = buildHandoff({
      ...input,
      ...B4,
      cardCommand: planCardCommand("~/.claude/skills/plan-card/plan-card.ts", ABS),
      question: "Does B4 read the frontmatter dock_time or the Brief's Timetable line?",
    });
    expect(prompt).toBe(
      [
        "Read the card first, then the lines I point at. Do not load the whole page unless you need it:",
        `  bun --no-env-file ~/.claude/skills/plan-card/plan-card.ts ${ABS}`,
        "",
        `Page: ${ABS}`,
        "",
        "Passage (line 12, Harbour plan › Design):",
        "> B4, late. The ferry's dock_time is earlier than the first bell.",
        "",
        "Check the code before you answer. If the page turns out to be wrong, show me the edit before you write it.",
        "",
        "Question: Does B4 read the frontmatter dock_time or the Brief's Timetable line?",
      ].join("\n"),
    );
    // Near the prototype's 746 characters for one passage and one question.
    expect(prompt.length).toBeLessThan(800);
  });
  test("a multi-line question stays last: nothing after it", () => {
    const prompt = renderHandoffPrompt(buildContextPack({ ...input, ...B4 }), "First line.\nCheck the code before you answer.");
    expect(prompt.endsWith("Question: First line.\nCheck the code before you answer.")).toBe(true);
  });
  test("no card command without one; a fallback says it was not placed, and why", () => {
    const fallback = renderHandoffPrompt(buildContextPack({ ...input, selection: "Not on this page at all.", heading: "Other" }), "q");
    expect(fallback).not.toContain("plan-card");
    expect(fallback).toContain("Passage (not placed exactly: the file does not hold it as selected; it is in the section «Other», lines 21–23):");
    const none = renderHandoffPrompt(buildContextPack({ ...input, selection: "Not on this page at all." }), "q");
    expect(none).toContain("Passage (not placed: the file does not hold it as selected):");
    expect(none).not.toMatch(/\blines? \d/);
  });
  test("finding 6: a passage too long for the prompt is cut with a visible mark, and the range still covers all of it", () => {
    const lines = Array.from({ length: 200 }, (_, k) => `Line ${k} says something different about pier number ${k}.`);
    const long = page("# L", "", "Intro.", "", ...lines, "", "Outro.");
    const selection = lines.join("\n");
    const { prompt } = buildHandoff({ ...input, raw: long, selection, before: "L Intro.", atStart: true, after: "Outro.", atEnd: true, question: "Q?".repeat(1000) });
    expect(prompt.length).toBeLessThanOrEqual(HANDOFF_PROMPT_MAX);
    expect(prompt).toContain("Passage (lines 5–204, L):");
    expect(prompt).toMatch(/\[… [\d,]+ more characters cut here; the lines above cover the whole passage\]/);
    expect(prompt).toContain(`Page: ${ABS}`);
    expect(prompt.endsWith("Question: " + "Q?".repeat(1000))).toBe(true);
  });
  test("a cut quote claims the lines cover the passage only when a range of its own was stated", () => {
    const lines = Array.from({ length: 200 }, (_, k) => `Line ${k} says something different about pier number ${k}.`);
    const long = page("# L", "", "## Part", "", "Intro.", "", ...lines, "", "Outro.");
    const selection = lines.join("\n") + " and words the file does not hold";
    const none = buildHandoff({ ...input, raw: long, selection, question: "Q?".repeat(1000) }).prompt;
    expect(none).toContain("Passage (not placed: ");
    expect(none).toMatch(/\[… [\d,]+ more characters cut here\]/);
    expect(none).not.toContain("cover the whole passage");
    const section = buildHandoff({ ...input, raw: long, selection, heading: "Part", question: "Q?".repeat(1000) }).prompt;
    expect(section).toContain("Passage (not placed exactly: ");
    expect(section).toMatch(/\[… [\d,]+ more characters cut here\]/);
    expect(section).not.toContain("cover the whole passage");
  });
  test("the quote is cut to the room left, never below 80 characters, and not cut when it fits", () => {
    expect(quoteFor("short passage", 100)).toBe("short passage");
    const cut = quoteFor("word ".repeat(400), 300);
    expect(cut.length).toBeLessThanOrEqual(300);
    expect(cut).toContain("more characters cut here");
    expect(quoteFor("word ".repeat(400), 10).startsWith("word ".repeat(16).trim())).toBe(true);
  });
  test("a path with a space is quoted in the card command", () => {
    expect(planCardCommand("/opt/pc.ts", "/home/a b/p.mdx")).toBe("bun --no-env-file /opt/pc.ts '/home/a b/p.mdx'");
  });
});

describe("the card command's target", () => {
  const roots = ["/home/example/wiki"];
  test("a plan page in a plan-card root: PLAN_CARD_BIN when absolute, else the skill's script", () => {
    expect(planCardTargetFor({ env: { PLAN_CARD_BIN: "/opt/plan-card.ts" }, roots, wikiDir: "/home/example/wiki", relPath: "plans/a.mdx", hasPlanStatus: true })).toEqual({
      bin: "/opt/plan-card.ts",
      abs: "/home/example/wiki/plans/a.mdx",
    });
    expect(planCardTargetFor({ env: {}, roots, wikiDir: "/home/example/wiki", relPath: "plans/a.mdx", hasPlanStatus: true })?.bin).toBe(PLAN_CARD_SKILL_SCRIPT);
  });
  test("a relative PLAN_CARD_BIN falls back to the skill's script", () => {
    expect(planCardTargetFor({ env: { PLAN_CARD_BIN: "bin/plan-card.ts" }, roots, wikiDir: "/home/example/wiki", relPath: "plans/a.mdx", hasPlanStatus: true })?.bin).toBe(PLAN_CARD_SKILL_SCRIPT);
  });
  test("no card for a page without plan_status, or outside every plan-card root", () => {
    expect(planCardTargetFor({ env: {}, roots, wikiDir: "/home/example/wiki", relPath: "notes/a.md", hasPlanStatus: false })).toBeNull();
    expect(planCardTargetFor({ env: {}, roots, wikiDir: "/home/example/other", relPath: "plans/a.mdx", hasPlanStatus: true })).toBeNull();
  });
});

describe("the reader config key and the page payload", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await testTempDir(path.join(tmpdir(), "muninn-discuss-cfg-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  test("discuss.handoff: true, false, absent, or bad (off with a warning)", () => {
    expect(parseDiscussReaderConfig({ handoff: true })).toEqual({ handoff: true });
    expect(parseDiscussReaderConfig(undefined)).toEqual({ handoff: false });
    expect(parseDiscussReaderConfig({})).toEqual({ handoff: false });
    expect(parseDiscussReaderConfig({ handoff: "yes" }).handoff).toBe(false);
    expect(parseDiscussReaderConfig({ handoff: "yes" }).warning).toBeDefined();
    expect(parseDiscussReaderConfig([true]).warning).toBeDefined();
  });
  test("readWikiReaderConfig reads the block from .wiki-reader.json", async () => {
    const on = path.join(dir, "on");
    const bad = path.join(dir, "bad");
    await Bun.write(path.join(on, ".wiki-reader.json"), JSON.stringify({ discuss: { handoff: true } }));
    await Bun.write(path.join(bad, ".wiki-reader.json"), JSON.stringify({ discuss: { handoff: "yes" } }));
    expect((await readWikiReaderConfig(on))?.discuss).toEqual({ handoff: true });
    expect((await readWikiReaderConfig(bad))?.discuss).toEqual({ handoff: false });
  });
  test("finding 10: the payload offers it only where the route is registered, on an opted-in wiki, to an admin", () => {
    const cfg = (handoff: boolean) => ({ discuss: { handoff } }) as never;
    const admin = { roles: [], admin: true };
    expect(readerPayload("w", cfg(true), undefined, admin, false, true).discussHandoff).toBe(true);
    // The read slice (MUNINN_PROFILE=nais) registers no tool route.
    expect(readerPayload("w", cfg(true), undefined, admin, false, false).discussHandoff).toBe(false);
    expect(readerPayload("w", cfg(true), undefined, { roles: [], admin: false }, false, true).discussHandoff).toBe(false);
    expect(readerPayload("w", cfg(false), undefined, admin, false, true).discussHandoff).toBe(false);
    expect(readerPayload("w", null, undefined, admin, false, true).discussHandoff).toBe(false);
  });
  test("P3: the tab's flag needs the rules file, the route registered and an admin; not discuss.handoff", () => {
    const admin = { roles: [], admin: true };
    expect(readerPayload("w", null, undefined, admin, false, true, true).discussAgent).toBe(true);
    expect(readerPayload("w", null, undefined, admin, false, true, false).discussAgent).toBe(false);
    expect(readerPayload("w", null, undefined, admin, false, false, true).discussAgent).toBe(false);
    expect(readerPayload("w", null, undefined, { roles: [], admin: false }, false, true, true).discussAgent).toBe(false);
  });
});
