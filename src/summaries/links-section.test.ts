import { describe, expect, test } from "bun:test";
import {
  appendLinksSection,
  bodyUrlCounts,
  demoteLinksHeadings,
  findLinksSection,
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
