import { describe, expect, test } from "bun:test";
import {
  appendLinksSection,
  bodyUrlCounts,
  demoteLinksHeadings,
  endsInsideFence,
  endsInsideHtmlBlock,
  findLinksSection,
  linksHeadingHidden,
  parseLinksLine,
  parseLinksSection,
  prepareLinksAnswer,
  renderLinkLine,
  renderLinksSection,
  splitLinksSection,
  type LinkLine,
} from "./links-section.ts";
import { splitClosingTakeaway } from "./takeaway-check.ts";
import { parseSummaryResponse } from "../utils/summary-parser.ts";
import { Marked } from "marked";
import { renderExportMarkdown } from "./export.ts";
import { escapeHtml } from "../format/markdown-core.ts";
import { sanitizedMarkedInstallScript } from "../dashboard/views/components/doc-panel.ts";
import { splitTranscript } from "./transcript-split.ts";
import { dropFactcheckSentinelLines } from "./factcheck-callout.ts";
import { buildSummaryFactcheckBlock, insertSummaryFactcheckBlock } from "./factcheck-block.ts";
import { insertFoundLinks } from "./find-links.ts";

const LINE: LinkLine = {
  icon: "📄",
  title: "Spending your tokens",
  url: "https://lab.example/blog/spending",
  detail: "Example Lab, Jo Writer",
  provenance: "from description",
};

describe("render", () => {
  test("the fixed grammar, with the count line", () => {
    expect(renderLinksSection({ lines: [LINE], omitted: 7 })).toBe(
      "## Links\n\n" +
        "- 📄 [Spending your tokens](https://lab.example/blog/spending) — Example Lab, Jo Writer · from description\n\n" +
        "_7 creator and social links in the description are not listed._",
    );
  });

  test("no qualifying line, no section — the count line included", () => {
    expect(renderLinksSection({ lines: [], omitted: 7 })).toBeNull();
  });

  test("no detail: no dash; no promo: no count line", () => {
    expect(renderLinksSection({ lines: [{ ...LINE, detail: "" }], omitted: 0 })).toBe(
      "## Links\n\n- 📄 [Spending your tokens](https://lab.example/blog/spending) · from description",
    );
  });

  test("untrusted text is escaped, separators replaced, `!` before `[` dropped, parens in the URL encoded", () => {
    const line = renderLinkLine({
      ...LINE,
      title: "![img](x) *bold* _it_ `code` [a] — b · c",
      url: "https://en.wikipedia.org/wiki/Foo_(bar)",
      detail: "Lab — Team · Unit",
    });
    expect(line).toBe(
      "- 📄 [\\[img\\](x) \\*bold\\* \\_it\\_ \\`code\\` \\[a\\] – b, c](https://en.wikipedia.org/wiki/Foo_%28bar%29) — Lab – Team, Unit · from description",
    );
  });
});

describe("parse", () => {
  test("a rendered section reads back into its lines and count", () => {
    const text = renderLinksSection({ lines: [LINE, { ...LINE, icon: "📦", detail: "", url: "https://github.com/a/b", title: "a/b" }], omitted: 1 })!;
    expect(parseLinksSection(text)).toEqual({
      lines: [LINE, { ...LINE, icon: "📦", detail: "", url: "https://github.com/a/b", title: "a/b" }],
      omitted: 1,
    });
  });

  test("the detail splits on the first ` — ` after the link and the LAST ` · `", () => {
    const parsed = parseLinksSection(
      "## Links\n\n- 📦 [acme/harness](https://github.com/acme/harness) — Eval-first · TypeScript · MIT · from text",
    );
    expect(parsed.lines[0]!.detail).toBe("Eval-first · TypeScript · MIT");
    expect(parsed.lines[0]!.provenance).toBe("from text");
  });

  /**
   * render → parse → render gives the same bytes, over hostile titles: every
   * markdown metacharacter, both separators, backslashes, brackets, newlines.
   */
  test("round trip over hostile titles is byte-stable", () => {
    const pieces = [
      "[", "]", "*", "_", "`", "\\", "!", "![", "!![", " — ", " · ", " — — ", " · · ", "(", ")", "\n", "  ", "—", "·",
      "](", "\\[", "x", "é", "🔗", "<b>", "|", "\u00a0", "\u2003", "\u00a0·\u00a0", "\u2003—\u2003", "\t",
    ];
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 2000; i++) {
      const word = () => Array.from({ length: 1 + rand(8) }, () => pieces[rand(pieces.length)]).join("");
      const line: LinkLine = {
        icon: rand(2) ? "📄" : "📦",
        title: `t${word()}`,
        url: `https://h.example/p_(${rand(9)})${rand(2) ? ")" : ""}`,
        detail: rand(3) ? `d${word()}` : "",
        provenance: "from description",
      };
      const once = renderLinksSection({ lines: [line], omitted: rand(3) })!;
      const twice = renderLinksSection(parseLinksSection(once))!;
      expect(twice).toBe(once);
    }
  });
});

test("round trip over the shapes a single pass missed: `!![`, repeated separators, Unicode spaces", () => {
  const titles = ["!![x", "a — — b", "a · · b", "a\u00a0·\u00a0b", "a\u2003—\u2003b", "a · · · b"];
  const trips = titles.map((t) => {
    const once = renderLinksSection({ lines: [{ ...LINE, title: t, detail: t }], omitted: 0 })!;
    return renderLinksSection(parseLinksSection(once)) === once ? "stable" : once;
  });
  expect(trips).toEqual(titles.map(() => "stable"));
});

describe("the one locator", () => {
  const BODY = "Summary text.\n\n## Visual reference\n\n![a](/api/frames/x/1.jpg)\n\n## Links\n\n- 📄 [A](https://a.example) · from description";

  test("finds the section from its heading to the end", () => {
    const r = findLinksSection(BODY)!;
    expect(BODY.slice(r.start)).toStartWith("## Links\n");
    expect(r.end).toBe(BODY.length);
  });

  test("stops at `## Transcript` and at the next level-2 heading", () => {
    const withT = `${BODY}\n\n## Transcript\n\nwords\n\n## Links\n\nnot this one`;
    const r = findLinksSection(withT)!;
    expect(withT.slice(r.start, r.end).trim()).toBe(BODY.slice(BODY.indexOf("## Links")));
    const next = "## Links\n\n- x\n\n## After\n\nmore";
    expect(next.slice(findLinksSection(next)!.start, findLinksSection(next)!.end)).toBe("## Links\n\n- x\n\n");
  });

  test("ignores a heading inside fenced code, and takes the LAST real one", () => {
    expect(findLinksSection("```\n## Links\n```\ntext")).toBeNull();
    const two = "## Links\n\nfirst\n\n## Links\n\nsecond";
    expect(two.slice(findLinksSection(two)!.start)).toBe("## Links\n\nsecond");
  });

  test("`##NotHeading` (no space) is not a heading and does not end the section", () => {
    const body = "## Links\n\n- 📄 [A](https://a.example) · from description\n##NotHeading\n- more";
    expect(findLinksSection(body)).toEqual({ start: 0, end: body.length });
  });

  test("a CRLF body: the heading and the transcript are found as on LF", () => {
    const body = "Summary.\r\n\r\n## Links\r\n\r\n- 📄 [A](https://a.example) · from description\r\n\r\n## Transcript\r\n\r\nwords";
    const r = findLinksSection(body);
    expect(r && body.slice(r.start, r.end)).toBe("## Links\r\n\r\n- 📄 [A](https://a.example) · from description\r\n\r\n");
  });

  test("a summary that ends inside an open fence: the appended section is still found and split back out", () => {
    const summary = "Intro\n\n```python\nprint(1)\n\n> 💬 **Takeaway:** A closer.";
    const section = "## Links\n\n- 📄 [A](https://a.example) · from description";
    const body = appendLinksSection(summary, section);
    expect(findLinksSection(body)).not.toBeNull();
    expect(splitLinksSection(`${body}\n\n## Transcript\n\nwords`).section).toBe(section);
  });

  test("split takes the section out byte-for-byte; append puts it back as the last block", () => {
    const { body, section } = splitLinksSection(BODY);
    expect(section).toBe("## Links\n\n- 📄 [A](https://a.example) · from description");
    expect(body).toBe("Summary text.\n\n## Visual reference\n\n![a](/api/frames/x/1.jpg)");
    expect(appendLinksSection(body, section)).toBe(BODY);
    expect(splitLinksSection("no section")).toEqual({ body: "no section", section: null });
    expect(appendLinksSection("text", null)).toBe("text");
  });
});

describe("the LINKS: envelope line", () => {
  test("ids, `none`, and no line at all", () => {
    expect(parseLinksLine("CATEGORY: ai/rag\nLINKS: 1, 3\n\nSUMMARY:\nbody").pick).toEqual([1, 3]);
    expect(parseLinksLine("CATEGORY: ai/rag\nLINKS: none\n\nSUMMARY:\nbody").pick).toBe("none");
    expect(parseLinksLine("CATEGORY: ai/rag\n\nSUMMARY:\nbody").pick).toBeNull();
    expect(parseLinksLine("CATEGORY: ai/rag\n**LINKS:** [2]\nSUMMARY:\nbody").pick).toEqual([2]);
  });

  test("a LINKS line with no SUMMARY marker never reaches the parsed summary", () => {
    const { text } = parseLinksLine("CATEGORY: ai/rag\nLINKS: 2\n\n### Heading\n- point");
    expect(parseSummaryResponse(text).summary).toBe("### Heading\n- point");
  });

  test("a LINKS line moved to the END is stripped too", () => {
    const { text, pick } = parseLinksLine("CATEGORY: ai/rag\n\nSUMMARY:\nbody\n\nLINKS: 4\n");
    expect(pick).toEqual([4]);
    expect(parseSummaryResponse(text).summary).toBe("body");
  });

  test("the takeaway check sees the same closer with the LINKS line where the prompt puts it", () => {
    const closer = "> 💬 **Takeaway:** One change moved the number.";
    const without = `CATEGORY: ai/rag\n\nSUMMARY:\n### Heading\n- point\n\n${closer}`;
    const withLine = `CATEGORY: ai/rag\nLINKS: 1\n\nSUMMARY:\n### Heading\n- point\n\n${closer}`;
    expect(splitClosingTakeaway(withLine)!.takeaway).toBe(splitClosingTakeaway(without)!.takeaway);
    expect(splitClosingTakeaway(withLine)!.after).toBe("");
  });

  test("only an id list or `none` is an envelope line; prose starting with «Links:» stays in the body", () => {
    const prose = [
      "CATEGORY: ai/general\n\nSUMMARY:\n**Links:** this talk links agents to tools.\n\nMore",
      "CATEGORY: ai/general\n\nSUMMARY:\nbody\n\nLinks: see the resources in the description",
      "CATEGORY: ai/general\n\nSUMMARY:\nbody\n\nLinks: https://arxiv.org/abs/2401.12345",
    ];
    expect(prose.map((t) => prepareLinksAnswer(t))).toEqual(prose.map((text) => ({ text, pick: null })));
    // The envelope's own spellings still parse.
    expect(parseLinksLine("CATEGORY: x\nlinks: 2 4\nSUMMARY:\nb").pick).toEqual([2, 4]);
    expect(parseLinksLine("CATEGORY: x\n**LINKS:** NONE\nSUMMARY:\nb").pick).toBe("none");
  });

  test("a model-written `## Links…` heading is demoted, outside code only", () => {
    expect(demoteLinksHeadings("## Links\n- a\n## Links and resources\n```\n## Links\n```\n### Links")).toBe(
      "### Links\n- a\n### Links and resources\n```\n## Links\n```\n### Links",
    );
    expect(prepareLinksAnswer("CATEGORY: x\nLINKS: none\nSUMMARY:\n## **Links**").text).toBe("CATEGORY: x\nSUMMARY:\n### **Links**");
  });

  test("an indented (1–3 spaces) model `## Links` heading is demoted too, keeping its indent", () => {
    expect(demoteLinksHeadings(" ## Links\n- a\n   ## Links to read")).toBe(" ### Links\n- a\n   ### Links to read");
    expect(findLinksSection(demoteLinksHeadings("body\n\n  ## Links\n\n- a"))).toBeNull();
  });
});

test("bodyUrlCounts counts prose URLs outside the section, and the ones the description never listed", () => {
  const summary =
    "See https://a.example/x, and https://invented.example/y.\n\n## Links\n\n- 📄 [A](https://a.example/x) · from description";
  expect(bodyUrlCounts(summary, new Set(["https://a.example/x"]))).toEqual({ bodyUrls: 2, bodyUrlsUnlisted: 1 });
});

test("bodyUrlCounts reads URLs the way the classifier does, and compares them normalized", () => {
  const listed = new Set(["https://en.wikipedia.org/wiki/Foo_(bar)", "https://lab.example/x"]);
  expect(bodyUrlCounts("See https://en.wikipedia.org/wiki/Foo_(bar).", listed)).toEqual({ bodyUrls: 1, bodyUrlsUnlisted: 0 });
  expect(bodyUrlCounts("See https://www.lab.example/x/?utm_source=yt and [it](https://lab.example/x).", listed)).toEqual({
    bodyUrls: 2,
    bodyUrlsUnlisted: 0,
  });
});

/**
 * The two places a stored summary is rendered: the export (`renderExportMarkdown`)
 * and the `/summaries` article view, whose `renderMarkdown` runs the page's
 * marked (the same 15.0.12 build, default options) with the install script.
 */
function clientRender(markdown: string): string {
  const m = new Marked();
  new Function("marked", "esc", sanitizedMarkedInstallScript())(m, escapeHtml);
  return m.parse(markdown, { async: false }) as string;
}

describe("fix round 2 batch 1 — R2-1: the fence closer agrees with marked", () => {
  const SECTION = "## Links\n\n- 📄 [A](https://a.example) · from description";
  const renders = (summary: string) => {
    const body = `${appendLinksSection(summary, SECTION)}\n\n## Transcript\n\nwords`;
    return [renderExportMarkdown(body), clientRender(body)];
  };

  test("a line opening with an inline triple-backtick span opens no fence: Links and Transcript render as headings", () => {
    const summary = "Intro.\n\n```js``` is the inline form.\n\nMore text.";
    for (const html of renders(summary)) {
      expect(html).toContain("<h2>Links</h2>");
      expect(html).toContain("<h2>Transcript</h2>");
      expect(html).not.toContain("<pre>");
    }
    expect(appendLinksSection(summary, SECTION)).toBe(`${summary}\n\n${SECTION}`);
  });

  test("a ``` inside an indented code block opens no fence", () => {
    const summary = "Intro.\n\n    ```\n    const x = 1;";
    for (const html of renders(summary)) {
      expect(html).toContain("<h2>Links</h2>");
      expect(html).toContain("<h2>Transcript</h2>");
    }
    expect(appendLinksSection(summary, SECTION)).toBe(`${summary}\n\n${SECTION}`);
  });

  test("a body that really ends inside a fence is closed with the opener's own marker", () => {
    for (const [summary, closer] of [
      ["Intro\n\n```python\nprint(1)", "```"],
      ["Intro\n\n~~~~\ncode", "~~~~"],
      ["Intro\n\n````md\n```js\nx\n```", "````"],
    ] as const) {
      expect(appendLinksSection(summary, SECTION)).toBe(`${summary}\n${closer}\n\n${SECTION}`);
      for (const html of renders(summary)) {
        expect(html).toContain("<h2>Links</h2>");
        expect(html).toContain("<h2>Transcript</h2>");
      }
    }
  });

  test("a closed fence is untouched", () => {
    const summary = "Intro\n\n```\nx\n```\n\nAfter.";
    expect(appendLinksSection(summary, SECTION)).toBe(`${summary}\n\n${SECTION}`);
  });
});

/** Pins for mutants the round-1 verify passes found surviving. */
describe("fix round 2 batch 1 — mutant pins (links-section)", () => {
  test("M7: every Unicode space run collapses, so a separator spelled with NBSP or em-space is replaced too", () => {
    const line = renderLinkLine({ ...LINE, title: "a  b", detail: "x — y" });
    expect(line).toBe("- 📄 [a b](https://lab.example/blog/spending) — x – y · from description");
    const sep = renderLinksSection({ lines: [{ ...LINE, title: "t", detail: "x y" }], omitted: 0 })!;
    expect(renderLinksSection(parseLinksSection(sep))).toBe(sep);
  });

  test("M8b: an indented (1–3 spaces) level-2 heading ends the section", () => {
    const body = "## Links\n\n- x\n\n  ## After\n\nmore";
    expect(body.slice(0, findLinksSection(body)!.end)).toBe("## Links\n\n- x\n\n");
  });

  test("M13: an envelope line ending in a full stop is still the envelope line", () => {
    expect(parseLinksLine("CATEGORY: x\nLINKS: 1, 2.\nSUMMARY:\nb")).toEqual({ text: "CATEGORY: x\nSUMMARY:\nb", pick: [1, 2] });
  });
});

/**
 * The two fence readers — the line walker (`findLinksSection`, `splitTranscript`)
 * and marked (`/summaries`, the export) — each say whether the body ends inside
 * a fence. A closer goes in only when both say yes; every other cell keeps the
 * plain append of 5fc5a849, which no reader may do worse than.
 */
describe("class check — the closer per (walker, marked) cell", () => {
  const SECTION = "## Links\n\n- 📄 [A](https://a.example) · from description";
  /** 5fc5a849's append, with no closer. */
  const baseAppend = (summary: string) => `${summary.trimEnd()}\n\n${SECTION}`;
  const verdicts = (body: string) => {
    const range = findLinksSection(body);
    const withTranscript = `${body}\n\n## Transcript\n\nwords`;
    return {
      walkerLinks: range !== null && body.slice(range.start, range.end).trim() === SECTION,
      walkerTranscript: splitTranscript(withTranscript).transcript?.trim() === "words",
      markedLinks: clientRender(withTranscript).includes("<h2>Links</h2>"),
      exportLinks: renderExportMarkdown(withTranscript).includes("<h2>Links</h2>"),
    };
  };
  const ALL = { walkerLinks: true, walkerTranscript: true, markedLinks: true, exportLinks: true };

  test("both closed: nothing appended, every reader sees the section", () => {
    const summary = "Intro\n\n```\nx\n```\n\nAfter.";
    expect(appendLinksSection(summary, SECTION)).toBe(baseAppend(summary));
    expect(verdicts(appendLinksSection(summary, SECTION))).toEqual(ALL);
  });

  test("both open: a closer both accept, and every reader sees the section", () => {
    for (const [summary, closer] of [
      ["Intro\n\n```python\nprint(1)", "```"],
      ["Intro\n\n  ~~~~ js\ncode", "~~~~"],
    ] as const) {
      expect(appendLinksSection(summary, SECTION)).toBe(`${summary}\n${closer}\n\n${SECTION}`);
      expect(verdicts(appendLinksSection(summary, SECTION))).toEqual(ALL);
    }
    // Both open on different characters: no closer ends both, so nothing is appended.
    const mixed = "Intro\n\n```js``` inline\n~~~\ncode";
    expect(appendLinksSection(mixed, SECTION)).toBe(baseAppend(mixed));
  });

  test("walker closed, marked open: nothing appended, the walker keeps the section and the transcript", () => {
    for (const summary of [
      "Intro\n\n```\ncode\n```text",
      "Intro\n\n```\ncode\n    ```",
      "1. Install:\n   ```bash\n   npm i\n```\n2. Run it.",
      "Intro\n\n```js``` inline\n\n```\ncode",
    ]) {
      expect(appendLinksSection(summary, SECTION)).toBe(baseAppend(summary));
      const v = verdicts(appendLinksSection(summary, SECTION));
      expect(v.walkerLinks).toBe(true);
      expect(v.walkerTranscript).toBe(true);
    }
  });

  test("walker open, marked closed: nothing appended, marked keeps the heading", () => {
    for (const summary of ["Intro\n\n```js``` is the inline form.\n\nMore.", "Intro\n\n    ```\n    const x = 1;"]) {
      expect(appendLinksSection(summary, SECTION)).toBe(baseAppend(summary));
      const v = verdicts(appendLinksSection(summary, SECTION));
      expect(v.markedLinks).toBe(true);
      expect(v.exportLinks).toBe(true);
    }
  });

  /** mulberry32 — a fixed seed, so a failure names a reproducible body. */
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const SEED = 742;
  const CASES = 5000;
  const fenceBody = (r: () => number): string => {
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
    const fence = () =>
      " ".repeat(pick([0, 0, 0, 1, 2, 3, 4, 6])) +
      pick(["`", "~"]).repeat(3 + Math.floor(r() * 3)) +
      pick(["", "", "", "js", " text", "python x"]);
    const lines: string[] = [];
    const n = 1 + Math.floor(r() * 8);
    for (let i = 0; i < n; i++) {
      lines.push(
        pick([
          fence,
          fence,
          fence,
          () => "",
          () => "Prose line.",
          () => "   code inside",
          () => "1. Install:",
          () => "- item",
          () => "```js``` inline",
          () => "Some ```x``` span",
        ])(),
      );
    }
    return lines.join("\n");
  };

  test(`property: ${CASES} fence-ish bodies (seed ${SEED}) — no reader does worse than the plain append`, () => {
    const r = rng(SEED);
    const worse: string[] = [];
    let closersAppended = 0;
    for (let i = 0; i < CASES; i++) {
      const summary = fenceBody(r);
      const out = appendLinksSection(summary, SECTION);
      if (out !== baseAppend(summary)) closersAppended++;
      const base = verdicts(baseAppend(summary));
      const now = verdicts(out);
      for (const k of Object.keys(base) as (keyof typeof base)[]) {
        if (base[k] && !now[k]) worse.push(`${k}: ${JSON.stringify(summary)}`);
      }
    }
    expect(worse.slice(0, 5)).toEqual([]);
    // The generator reaches the both-open cell, so the closer path is exercised.
    expect(closersAppended).toBeGreaterThan(100);
  });
});

describe("fix round 1 batch 3 — a summary ending inside an open HTML block", () => {
  const SECTION = "## Links\n\n- 📄 [A](https://a.example) · from description";
  // One opener per CommonMark HTML block type: 1–5 run to their end marker or
  // the document's end, 6–7 end at a blank line.
  const CASES: [string, string, boolean][] = [
    ["type 1 <pre>", "<pre>\nconst x = 1;", true],
    ["type 1 <script>", "<script>\nlet a = 1;", true],
    ["type 1 <style>", "<style>\np { color: red }", true],
    ["type 1 <textarea>", "<textarea>\nhi", true],
    ["type 2 comment", "<!-- note to self", true],
    ["type 3 processing instruction", "<?php echo 1;", true],
    ["type 4 declaration", "<!DOCTYPE html", true],
    ["type 5 CDATA", "<![CDATA[ x", true],
    ["type 6 <div>", "<div>\nx", false],
    ["type 7 custom tag", '<span class="a">\nx', false],
    ["a closed comment", "<!-- ok -->", false],
    ["an inline comment in a paragraph", "Text <!-- open", false],
  ];
  test.each(CASES)("%s: refused exactly when marked folds the appended section", (_name, tail, open) => {
    const summary = `# T\n\nBody.\n\n${tail}`;
    const body = `${appendLinksSection(summary, SECTION)}\n`;
    for (const html of [renderExportMarkdown(body), clientRender(body)]) {
      expect(html.includes("<h2>Links</h2>")).toBe(!open);
    }
    expect(endsInsideHtmlBlock(summary)).toBe(open);
    // The walker finds the section either way: only marked can tell.
    expect(findLinksSection(body)).not.toBeNull();
  });
});

describe("pr745 fix round 2 batch 1 — the predicates read what the readers parse (sentinels dropped)", () => {
  const FC = buildSummaryFactcheckBlock("### ✅ Claim 1/1 — ok\n\nConfidence: high", "2026-10-25");
  const ADD = [{ url: "https://found.example/post", title: "Found post", detail: "" }];
  /** Both readers as they run: the export, and the page's `renderMarkdown` (sentinel lines dropped first). */
  const readers = (body: string) => [renderExportMarkdown(body), clientRender(dropFactcheckSentinelLines(body))];

  test("F1: a `<!--` closed in the file only by the start sentinel is refused, and the readers would swallow the appended section", () => {
    const summary = insertSummaryFactcheckBlock("# T\n\nBody.\n\n<!-- note to self", FC);
    const saved = insertFoundLinks(summary, ADD).body;
    expect(findLinksSection(saved)).not.toBeNull();
    for (const html of readers(saved)) expect(html.includes("<h2>Links</h2>")).toBe(false);
    expect(endsInsideHtmlBlock(summary)).toBe(true);
    expect(endsInsideFence(summary)).toBe(false);
  });

  test("F1 control: a closed comment above the block, and a block with nothing open, stay available", () => {
    for (const summary of [
      insertSummaryFactcheckBlock("# T\n\n<!-- note -->\n\nBody.", FC),
      insertSummaryFactcheckBlock("# T\n\nBody.", FC),
    ]) {
      expect(endsInsideHtmlBlock(summary)).toBe(false);
      expect(endsInsideFence(summary)).toBe(false);
      const saved = insertFoundLinks(summary, ADD).body;
      for (const html of readers(saved)) expect(html).toContain("<h2>Links</h2>");
    }
  });

  const LINKS = "## Links\n\n- 📄 [A](https://a.example) · from description";
  const HIDDEN: [string, string][] = [
    ["inside <pre> that closes later", `# T\n\n<pre>\n${LINKS}\n</pre>\n\nMore.`],
    ["inside a comment that closes later", `# T\n\n<!-- old\n${LINKS}\n-->\n\nMore.`],
    ["after a `<!--` only the start sentinel closes", insertSummaryFactcheckBlock(`# T\n\n<!-- note\n\n${LINKS}`, FC)],
  ];
  test.each(HIDDEN)("F2: a Links section %s is hidden, and a save into it shows in no reader", (_name, body) => {
    expect(findLinksSection(body)).not.toBeNull();
    expect(linksHeadingHidden(body)).toBe(true);
    const saved = insertFoundLinks(body, ADD).body;
    for (const html of readers(saved)) expect(html.includes("<h2>Links</h2>")).toBe(false);
  });

  const SHOWN: [string, string][] = [
    ["an ordinary section", `# T\n\nBody.\n\n${LINKS}`],
    ["a section after a closed <pre>", `# T\n\n<pre>\nx\n</pre>\n\n${LINKS}`],
    ["a section after the fact-check block", insertSummaryFactcheckBlock(`# T\n\nBody.\n\n${LINKS}`, FC)],
    ["a CRLF heading", `# T\r\n\r\nBody.\r\n\r\n## Links\r\n\r\n- 📄 [A](https://a.example) · from description`],
    ["no section at all", "# T\n\nBody."],
  ];
  test.each(SHOWN)("F2 control: %s is not hidden", (_name, body) => {
    expect(linksHeadingHidden(body)).toBe(false);
  });
});
