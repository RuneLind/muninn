/**
 * The live fact-check block under CommonMark fences: marker-matched openers and
 * closers, run length, the backtick-in-info-string rule, an unclosed fence at end
 * of file, nested fence examples, orphan STARTs, indented and frontmatter
 * sentinels, and an appendix whose answer leaves a fence open.
 *
 * Imports only modules the pre-fix walker already had, so the same file runs
 * against the walker before this fix round (the red run).
 */
import { test, expect, describe } from "bun:test";
import { spliceSentinelBlock, withTrailingNewline } from "./append-block.ts";
import {
  FACTCHECK_SENTINEL_START as START,
  FACTCHECK_SENTINEL_END as END,
  buildFactcheckAppendix,
  hasFactcheckBlock,
  stripFactcheckBlock,
} from "./factcheck-context.ts";
import { findExclusionZones } from "./integrate-edits.ts";
import { renderWikiHtml } from "./render.ts";

const block = (label: string): string =>
  [START, `> [!factcheck] Fact check (${label})`, `> verdict ${label}`, END].join("\n");

const count = (s: string, needle: string): number => s.split(needle).length - 1;

/** Two ➕ writes, as the route runs them. */
function twoWrites(page: string): { out1: string; out2: string } {
  const out1 = withTrailingNewline(spliceSentinelBlock(page, block("one")));
  const out2 = withTrailingNewline(spliceSentinelBlock(out1, block("two")));
  return { out1, out2 };
}

/** Is `offset`'s line inside a fence, as the reader pairs fences — written out
 *  independently of `fenceLineStates`: CommonMark openers and closers, and an opener
 *  with no closer is plain text. */
function insideFence(text: string, offset: number): boolean {
  const lines = text.split("\n");
  const target = text.slice(0, offset).split("\n").length - 1;
  const opener = (l: string) => {
    const m = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/.exec(l);
    return m && !(m[1]![0] === "`" && m[2]!.includes("`")) ? m[1]! : null;
  };
  const closes = (l: string, run: string) => {
    const m = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/.exec(l);
    return m !== null && m[1]![0] === run[0] && m[1]!.length >= run.length;
  };
  for (let i = 0; i < lines.length; i++) {
    const run = opener(lines[i]!);
    if (!run) continue;
    let j = i + 1;
    while (j < lines.length && !closes(lines[j]!, run)) j++;
    if (j === lines.length) continue;
    if (target >= i && target <= j) return true;
    i = j;
  }
  return false;
}

/** Pages whose fences the old any-line toggle misread (review finding F1). */
const MISREAD_FENCES: Record<string, string> = {
  "A: a ````md block holding one ```ts line": [
    "# Page", "", "````md", "```ts", "const x = 1;", "````", "", "Prose after.", "",
  ].join("\n"),
  "B: a ```md block holding a ~~~ line": [
    "# Page", "", "```md", "~~~", "text", "```", "", "Prose after.", "",
  ].join("\n"),
  "F: a 4-space-indented ``` line (indented code, not a fence)": [
    "# Page", "", "Code:", "", "    ```", "    x", "", "Prose after.", "",
  ].join("\n"),
  "H: a prose line starting with an inline ```js``` span": [
    "# Page", "", "```js``` is how you write an inline span.", "", "Prose after.", "",
  ].join("\n"),
  "I: an unclosed fence at EOF (the reader shows it as text)": [
    "# Page", "", "Prose.", "", "```ts", "const open = true;", "",
  ].join("\n"),
};

describe("fences the old toggle misread (F1)", () => {
  for (const [name, page] of Object.entries(MISREAD_FENCES)) {
    test(`${name}: two writes leave one block; has/strip see it after write 1`, () => {
      const { out1, out2 } = twoWrites(page);
      expect(out1).toBe(`${page.replace(/\n+$/, "")}\n\n${block("one")}\n`);
      expect(count(out2, START)).toBe(1);
      expect(out2).toBe(out1.replace(block("one"), () => block("two")));
      expect(hasFactcheckBlock(out1)).toBe(true);
      expect(stripFactcheckBlock(out1)).toBe(page.trim());
    });
  }

  // Mid-page: a fenced example AFTER the block gives a misread opener above it a
  // closer to pair with, which is what hides a replace-in-place block.
  for (const [name, head] of Object.entries(MISREAD_FENCES)) {
    if (name.startsWith("I:")) continue; // its ```ts really does pair with the example
    test(`${name}: a block above a fenced example is replaced in place`, () => {
      const page = `${head}\n${block("zero")}\n\n\`\`\`sh\nls\n\`\`\`\n`;
      expect(hasFactcheckBlock(page)).toBe(true);
      expect(spliceSentinelBlock(page, block("one"))).toBe(page.replace(block("zero"), () => block("one")));
      expect(stripFactcheckBlock(page)).not.toContain("verdict zero");
    });
  }
});

/** Nested fence examples that carry a sentinel pair (the #586 failure class). */
const NESTED_EXAMPLES: Record<string, string> = {
  "C: ```mdx inside ````md": [
    "# Page", "", "````md", "```mdx", START, "> example", END, "```", "````", "", "Prose.", "",
  ].join("\n"),
  "E: ```ts inside ```md (an info string never closes)": [
    "# Page", "", "```md", "```ts", START, "> example", END, "```", "", "Prose.", "",
  ].join("\n"),
  "D: ``` inside ~~~md": [
    "# Page", "", "~~~md", "```", START, "> example", END, "```", "~~~", "", "Prose.", "",
  ].join("\n"),
};

describe("a sentinel pair inside a nested fence example is not live", () => {
  for (const [name, page] of Object.entries(NESTED_EXAMPLES)) {
    test(name, () => {
      expect(hasFactcheckBlock(page)).toBe(false);
      expect(stripFactcheckBlock(page)).toBe(page.trim());
      expect(findExclusionZones(page, true).filter((z) => z.kind === "sentinel")).toHaveLength(0);
      const { out1, out2 } = twoWrites(page);
      expect(out1.startsWith(page.replace(/\n+$/, ""))).toBe(true);
      expect(count(out2, START)).toBe(2); // the example's, and one live block
      expect(out2).toBe(out1.replace(block("one"), () => block("two")));
      const html = renderWikiHtml(page, () => undefined);
      expect(html).toContain("factcheck:start");
      expect(html).toContain("factcheck:end");
    });
  }
});

describe("orphan STARTs (F2)", () => {
  test("an orphan START before a live block: the prose between them survives", () => {
    const page = `# P\n\n${START}\n\nProse that must survive.\n\n${block("one")}\n`;
    const out = withTrailingNewline(spliceSentinelBlock(page, block("two")));
    expect(out).toBe(page.replace(block("one"), () => block("two")));
    expect(stripFactcheckBlock(page)).toContain("Prose that must survive.");
    expect(stripFactcheckBlock(page)).not.toContain("verdict one");
  });

  test("an orphan START before a fenced example pair: nothing is deleted", () => {
    const page = [
      "# P", "", START, "", "Prose.", "", "```mdx", START, "> example", END, "```", "", "Outro.", "",
    ].join("\n");
    expect(hasFactcheckBlock(page)).toBe(false);
    expect(stripFactcheckBlock(page)).toBe(page.trim());
    const out = spliceSentinelBlock(page, block("one"));
    expect(out.startsWith(page.replace(/\n+$/, ""))).toBe(true);
  });
});

describe("indented and frontmatter sentinels (F3)", () => {
  test("a pair in a 4-space-indented code block is not live", () => {
    const page = `Intro.\n\n    ${START}\n    > example\n    ${END}\n\nOutro.\n`;
    expect(hasFactcheckBlock(page)).toBe(false);
    expect(stripFactcheckBlock(page)).toBe(page.trim());
    expect(renderWikiHtml(page, () => undefined)).toContain("factcheck:start");
  });

  test("a pair inside the YAML frontmatter is not live", () => {
    const page = `---\ntitle: P\n${START}\n${END}\n---\n# P\n\nBody.\n`;
    expect(hasFactcheckBlock(page)).toBe(false);
    expect(stripFactcheckBlock(page)).toBe(page.trim());
    const out = spliceSentinelBlock(page, block("one"));
    expect(out.startsWith(page.replace(/\n+$/, ""))).toBe(true);
  });
});

describe("an appendix whose answer leaves a fence open", () => {
  const answer = (tag: string): string =>
    [
      `### ⚠️ Claim 1/2 — ${tag} first`,
      "",
      "Example:",
      "",
      "```ts",
      "const stray = 1;",
      "",
      "Confidence: 70/100",
      "",
      `### ✅ Claim 2/2 — ${tag} second`,
      "",
      "Fine.",
      "",
      "Confidence: 90/100",
    ].join("\n");

  test("is closed by the writer, so a later page fence cannot pair with it", () => {
    // The block sits mid-page with a fenced example after it: an unclosed ```ts
    // in the appendix would pair with that example's closer and hide the END.
    const page = `# Page\n\nBody.\n\n${block("zero")}\n\n## Later\n\n\`\`\`sh\nls\n\`\`\`\n`;
    const b1 = buildFactcheckAppendix(answer("one"), "2026-09-26");
    const b2 = buildFactcheckAppendix(answer("two"), "2026-09-27");
    const out1 = withTrailingNewline(spliceSentinelBlock(page, b1));
    const out2 = withTrailingNewline(spliceSentinelBlock(out1, b2));
    expect(out1).toBe(page.replace(block("zero"), () => b1));
    expect(insideFence(out1, out1.indexOf(END))).toBe(false);
    expect(insideFence(out1, out1.indexOf("## Later"))).toBe(false);
    expect(count(out2, START)).toBe(1);
    expect(out2).toBe(out1.replace(b1, () => b2));
  });
});

describe("the reader's sentinel filter reads the writers' walker", () => {
  test("an unpaired marker line is content and renders literally", () => {
    const html = renderWikiHtml(`Before.\n\n${START}\n\nAfter.`, () => undefined);
    expect(html).toContain("factcheck:start");
  });
});
