/**
 * The LIVE fact-check sentinel block, as all four consumers see it: the ➕ splice,
 * `hasFactcheckBlock`, `stripFactcheckBlock` and integrate's exclusion zones.
 *
 * Every fixture here is a page that DOCUMENTS the sentinels — a fenced example
 * pair, an inline-code mention in prose — which is the shape that broke each
 * consumer in turn (architecture review 2026-09, finding 6; closed PR #586).
 */
import { test, expect, describe } from "bun:test";
import { spliceSentinelBlock, withTrailingNewline } from "./append-block.ts";
import {
  FACTCHECK_SENTINEL_START as START,
  FACTCHECK_SENTINEL_END as END,
  hasFactcheckBlock,
  stripFactcheckBlock,
} from "./factcheck-context.ts";
import { findExclusionZones } from "./integrate-edits.ts";

const block = (label: string, extra: string[] = []): string =>
  [START, `> [!factcheck] Fact check (${label})`, `> verdict ${label}`, ...extra, END].join("\n");

/** The documenting-page shape: a fenced example pair, then an inline-code
 *  mention of the start sentinel in prose, and NO live block. */
const DOC_PAGE = [
  "# Fact-check annotation",
  "",
  "## Target shape",
  "",
  "```mdx",
  "Body prose.",
  "",
  START,
  '<FactCheck date="2026-08-01">',
  "",
  "</FactCheck>",
  END,
  "```",
  "",
  "## Found while building",
  "",
  `\`${START}\` was showing up as a literal line of text in the reader on`,
  "every annotated page.",
  "",
  "## Open questions",
  "",
  "- one",
  "",
  "## See also",
  "",
  "- [[other-page]]",
  "",
].join("\n");

const headings = (s: string): number => s.split("\n").filter((l) => /^#{1,6}\s/.test(l)).length;

/** Fence parity at `offset` under a naive toggle (any indent, ``` or ~~~) —
 *  enough for these fixtures, which carry no nested or mismatched fences. */
function insideFence(text: string, offset: number): boolean {
  let inFence = false;
  let at = 0;
  for (const line of text.split("\n")) {
    if (at >= offset) break;
    const t = line.trim();
    if (t.startsWith("```") || t.startsWith("~~~")) inFence = !inFence;
    at += line.length + 1;
  }
  return inFence;
}

describe("spliceSentinelBlock on a page that documents the sentinels", () => {
  test("two sequential writes: the first appends, the second replaces it in place", () => {
    const b1 = block("one");
    const b2 = block("two");
    const out1 = withTrailingNewline(spliceSentinelBlock(DOC_PAGE, b1));
    // Write 1 leaves every existing byte alone and appends the live block.
    expect(out1).toBe(`${DOC_PAGE.replace(/\n+$/, "")}\n\n${b1}\n`);
    const out2 = withTrailingNewline(spliceSentinelBlock(out1, b2));
    // Write 2 swaps exactly the live block — nothing outside it moves.
    expect(out2).toBe(out1.replace(b1, () => b2));
    expect(headings(out2)).toBe(headings(DOC_PAGE));
    const out3 = withTrailingNewline(spliceSentinelBlock(out2, b1));
    expect(out3).toBe(out1);
  });

  test("an answer carrying a closed fence is replaced, never duplicated", () => {
    const b1 = block("one", ["> prose", "```ts", "const stray = 1;", "```"]);
    const b2 = block("two", ["````", "```", "````"]);
    const page = "# Page\n\nBody.\n\n## See also\n\n- x\n";
    const out1 = withTrailingNewline(spliceSentinelBlock(page, b1));
    const out2 = withTrailingNewline(spliceSentinelBlock(out1, b2));
    expect(out2).toBe(out1.replace(b1, () => b2));
    const out3 = withTrailingNewline(spliceSentinelBlock(out2, b1));
    expect(out3).toBe(out1);
    expect(out3.split(START).length - 1).toBe(1);
  });

  test("an unquoted appendix with a fence, then a DOC page's prose after it", () => {
    // The `.mdx` appendix embeds answer text unquoted, so its fences sit at
    // column 0 inside the live block (the writer closes any it leaves open).
    const b1 = [START, '<FactCheck date="d1">', "", "```", "code", "```", "</FactCheck>", END].join("\n");
    const b2 = [START, '<FactCheck date="d2">', "", "</FactCheck>", END].join("\n");
    const page = `# Page\n\nBody.\n\n${b1}\n\n## Later\n\n\`${START}\` in prose.\n`;
    const out = spliceSentinelBlock(page, b2);
    expect(out).toBe(page.replace(b1, () => b2));
  });

  test("a `## Sources` that exists only inside a fence is not an insertion point", () => {
    const page = [
      "# Page",
      "",
      "Example of a source page:",
      "",
      "```md",
      "## Sources",
      "",
      "- https://example.com",
      "```",
      "",
      "Closing prose.",
      "",
    ].join("\n");
    const b = block("one");
    const out = spliceSentinelBlock(page, b);
    const at = out.indexOf(START);
    expect(insideFence(out, at)).toBe(false);
    expect(out.startsWith(page.replace(/\n+$/, ""))).toBe(true);
  });

  test("a fenced `## Sources` + a fenced example pair: block lands after the fences", () => {
    const page = [
      "# Page",
      "",
      "```md",
      "## Sources",
      START,
      "> old",
      END,
      "```",
      "",
      "Prose.",
      "",
    ].join("\n");
    const out = spliceSentinelBlock(page, block("one"));
    expect(out.startsWith(page.replace(/\n+$/, ""))).toBe(true);
    expect(insideFence(out, out.lastIndexOf(START))).toBe(false);
  });

  test("a real `## Sources` after a fenced one is still used", () => {
    const page = "# P\n\n```md\n## Sources\n```\n\nBody.\n\n## Sources\n\n- u\n";
    const out = spliceSentinelBlock(page, block("one"));
    expect(out.indexOf(START)).toBeGreaterThan(out.indexOf("Body."));
    expect(out.indexOf(START)).toBeLessThan(out.lastIndexOf("## Sources"));
  });

  test("an orphan START with no END deletes nothing", () => {
    const page = `# P\n\n${START}\n\nProse that must survive.\n`;
    const out = spliceSentinelBlock(page, block("one"));
    expect(out.startsWith(page.replace(/\n+$/, ""))).toBe(true);
  });

  test("CRLF: the documenting page is appended to, then replaced in place", () => {
    const crlf = DOC_PAGE.replace(/\n/g, "\r\n");
    const b1 = block("one");
    const b2 = block("two");
    const out1 = spliceSentinelBlock(crlf, b1);
    expect(out1.startsWith(crlf.replace(/(\r?\n)+$/, ""))).toBe(true);
    const out2 = spliceSentinelBlock(out1, b2);
    expect(out2).toBe(out1.replace(b1, () => b2));
  });

  test("CRLF: an existing live block is replaced in place", () => {
    const b1 = block("one").replace(/\n/g, "\r\n");
    const page = `# P\r\n\r\nBody.\r\n\r\n${b1}\r\n\r\n## See also\r\n`;
    const out = spliceSentinelBlock(page, block("two"));
    expect(out).toBe(page.replace(b1, () => block("two")));
  });
});

describe("hasFactcheckBlock / stripFactcheckBlock on a page that documents the sentinels", () => {
  test("a fenced example and an inline mention are not a block", () => {
    expect(hasFactcheckBlock(DOC_PAGE)).toBe(false);
    expect(stripFactcheckBlock(DOC_PAGE)).toBe(DOC_PAGE.trim());
  });

  test("with a live block appended, only the live block is stripped", () => {
    const withBlock = `${DOC_PAGE.trim()}\n\n${block("one")}\n`;
    expect(hasFactcheckBlock(withBlock)).toBe(true);
    expect(stripFactcheckBlock(withBlock)).toBe(DOC_PAGE.trim());
  });

  test("a pair whose interior opens a fence, with a fenced example later, is still a block", () => {
    // An on-disk block from before `buildFactcheckAppendix` closed open fences:
    // its interior cannot pair with the example's fence, so it stays live.
    const page = `Intro.\n\n${[START, "```", "</FactCheck>", END].join("\n")}\n\nOutro.\n\n\`\`\`\ncode\n\`\`\``;
    expect(hasFactcheckBlock(page)).toBe(true);
    expect(stripFactcheckBlock(page)).toBe("Intro.\n\nOutro.\n\n```\ncode\n```");
  });

  test("a pair whose interior holds an opener nothing closes is still a block", () => {
    const page = `Intro.\n\n${[START, "```", "</FactCheck>", END].join("\n")}\n\nOutro.`;
    expect(hasFactcheckBlock(page)).toBe(true);
    expect(stripFactcheckBlock(page)).toBe("Intro.\n\nOutro.");
  });

  test("CRLF: a live block is found and stripped; a fenced example is not", () => {
    const live = `Intro.\r\n\r\n${block("one").replace(/\n/g, "\r\n")}\r\n\r\nOutro.`;
    expect(hasFactcheckBlock(live)).toBe(true);
    expect(stripFactcheckBlock(live)).not.toContain("verdict one");
    expect(stripFactcheckBlock(live)).toContain("Outro.");
    expect(hasFactcheckBlock(DOC_PAGE.replace(/\n/g, "\r\n"))).toBe(false);
  });
});

describe("findExclusionZones sentinel pairing", () => {
  test("prose between an inline mention and a live END is not masked", () => {
    const page = `# P\n\n\`${START}\` is the marker.\n\nTARGET prose to edit.\n\n${block("one")}\n`;
    const target = page.indexOf("TARGET");
    const zones = findExclusionZones(page, true);
    expect(zones.some((z) => z.start <= target && target < z.end)).toBe(false);
    const sentinel = zones.filter((z) => z.kind === "sentinel");
    expect(sentinel).toHaveLength(1);
    expect(page.slice(sentinel[0]!.start, sentinel[0]!.end)).toBe(block("one"));
  });

  test("a fenced example pair stays a FENCE zone, not a sentinel zone", () => {
    const zones = findExclusionZones(DOC_PAGE, true);
    expect(zones.filter((z) => z.kind === "sentinel")).toHaveLength(0);
    const fenceAt = DOC_PAGE.indexOf("```mdx");
    expect(zones.some((z) => z.kind === "fence" && z.start === fenceAt)).toBe(true);
    const prose = DOC_PAGE.indexOf("every annotated page");
    expect(zones.some((z) => z.start <= prose && prose < z.end)).toBe(false);
  });
});
