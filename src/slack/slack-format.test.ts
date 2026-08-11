import { test, expect, describe } from "bun:test";
import { formatSlackMrkdwn } from "./slack-format.ts";

describe("formatSlackMrkdwn", () => {
  test("converts markdown headings to bold", () => {
    expect(formatSlackMrkdwn("## Summary")).toBe("*Summary*");
    expect(formatSlackMrkdwn("### Details")).toBe("*Details*");
    expect(formatSlackMrkdwn("# Title")).toBe("*Title*");
  });

  test("removes horizontal rules", () => {
    expect(formatSlackMrkdwn("above\n---\nbelow")).toBe("above\n\nbelow");
  });

  test("converts **bold** to *bold*", () => {
    expect(formatSlackMrkdwn("this is **bold** text")).toBe("this is *bold* text");
  });

  test("converts ~~strikethrough~~ to ~strike~", () => {
    expect(formatSlackMrkdwn("this is ~~gone~~ text")).toBe("this is ~gone~ text");
  });

  test("converts markdown links to Slack format", () => {
    const result = formatSlackMrkdwn("[click](https://example.com)");
    expect(result).toBe("<https://example.com|click>");
  });

  test("converts HTML <a> tags to Slack format", () => {
    const result = formatSlackMrkdwn('<a href="https://example.com">click</a>');
    expect(result).toBe("<https://example.com|click>");
  });

  test("preserves code blocks", () => {
    const input = "before\n```js\nconst x = 1;\n```\nafter";
    const result = formatSlackMrkdwn(input);
    expect(result).toContain("```\nconst x = 1;\n```");
    expect(result).toContain("before");
    expect(result).toContain("after");
  });

  test("preserves inline code", () => {
    expect(formatSlackMrkdwn("use `npm install` here")).toBe("use `npm install` here");
  });

  test("does not convert formatting inside code blocks", () => {
    const input = "```\n**not bold**\n```";
    const result = formatSlackMrkdwn(input);
    expect(result).toContain("**not bold**");
  });

  test("does not convert formatting inside inline code", () => {
    const input = "use `**not bold**` here";
    const result = formatSlackMrkdwn(input);
    expect(result).toContain("`**not bold**`");
  });

  test("converts HTML <b> to *bold*", () => {
    expect(formatSlackMrkdwn("<b>bold</b>")).toBe("*bold*");
  });

  test("converts HTML <i> to _italic_", () => {
    expect(formatSlackMrkdwn("<i>italic</i>")).toBe("_italic_");
  });

  test("converts HTML <s> to ~strike~", () => {
    expect(formatSlackMrkdwn("<s>strike</s>")).toBe("~strike~");
  });

  test("converts HTML <code> to backtick", () => {
    expect(formatSlackMrkdwn("<code>code</code>")).toBe("`code`");
  });

  test("strips remaining HTML tags", () => {
    expect(formatSlackMrkdwn("<div>content</div>")).toBe("content");
    expect(formatSlackMrkdwn("<br>line")).toBe("line");
  });

  test("collapses excessive blank lines", () => {
    expect(formatSlackMrkdwn("a\n\n\n\nb")).toBe("a\n\nb");
  });

  test("trims output", () => {
    expect(formatSlackMrkdwn("  hello  \n\n")).toBe("hello");
  });

  test("handles a realistic Claude response", () => {
    const input = `## Summary

---

### 1. Item One
This is **important** with a [link](https://example.com).

### 2. Item Two
Found it ~~wrong~~ correct.`;

    const result = formatSlackMrkdwn(input);
    expect(result).not.toContain("##");
    expect(result).not.toContain("---");
    expect(result).toContain("*Summary*");
    expect(result).toContain("*1. Item One*");
    expect(result).toContain("*important*");
    expect(result).toContain("<https://example.com|link>");
    expect(result).toContain("~wrong~");
  });

  // --- Table conversion tests ---

  describe("markdown table conversion", () => {
    test("converts multi-column table to labeled bullets", () => {
      const input = `| # | Anbud | Status |
|---|---|---|
| 1 | Rammeavtale | Aktiv |
| 2 | DigDir | Lukket |`;

      const result = formatSlackMrkdwn(input);
      expect(result).toContain("• *#:* 1  *Anbud:* Rammeavtale  *Status:* Aktiv");
      expect(result).toContain("• *#:* 2  *Anbud:* DigDir  *Status:* Lukket");
      expect(result).not.toContain("|");
    });

    test("converts single-column table to simple bullets", () => {
      const input = `| Name |
|------|
| Alice |
| Bob |`;

      const result = formatSlackMrkdwn(input);
      expect(result).toContain("• Alice");
      expect(result).toContain("• Bob");
    });

    test("skips empty cells in table rows", () => {
      const input = `| Name | Email | Phone |
|------|-------|-------|
| Alice | alice@test.com |  |
| Bob |  | 12345 |`;

      const result = formatSlackMrkdwn(input);
      const lines = result.split("\n").filter(l => l.trim());
      expect(lines[0]).toBe("• *Name:* Alice  *Email:* alice@test.com");
      expect(lines[0]).not.toContain("*Phone:*");
      expect(lines[1]).toBe("• *Name:* Bob  *Phone:* 12345");
      expect(lines[1]).not.toContain("*Email:*");
    });

    test("preserves tables inside code blocks", () => {
      const input = "```\n| A | B |\n|---|---|\n| 1 | 2 |\n```";
      const result = formatSlackMrkdwn(input);
      expect(result).toContain("| A | B |");
      expect(result).toContain("| 1 | 2 |");
    });

    test("handles table with links (realistic knowledge output)", () => {
      const input = `| # | Anbud | Lenke |
|---|---|---|
| 1 | Rammeavtale | [Se her](https://notion.so/page1) |
| 2 | DigDir | [Se her](https://notion.so/page2) |`;

      const result = formatSlackMrkdwn(input);
      expect(result).toContain("<https://notion.so/page1|Se her>");
      expect(result).toContain("<https://notion.so/page2|Se her>");
      expect(result).toContain("*Anbud:* Rammeavtale");
    });

    test("passes through non-table pipe content", () => {
      const input = "this | is not | a table";
      const result = formatSlackMrkdwn(input);
      expect(result).toBe("this | is not | a table");
    });

    test("passes through incomplete table (no separator row)", () => {
      const input = "| A | B |\n| 1 | 2 |";
      const result = formatSlackMrkdwn(input);
      expect(result).toContain("| A | B |");
    });
  });

  // --- Empty bullet removal tests ---

  describe("empty bullet removal", () => {
    test("strips empty bullet points with •", () => {
      const input = "• Item 1\n•\n• Item 2";
      const result = formatSlackMrkdwn(input);
      expect(result).toBe("• Item 1\n\n• Item 2");
    });

    test("strips empty bullet points with -", () => {
      const input = "- Item 1\n-\n- Item 2";
      const result = formatSlackMrkdwn(input);
      expect(result).toBe("- Item 1\n\n- Item 2");
    });

    test("strips bullets with only whitespace", () => {
      const input = "• Item 1\n•   \n• Item 2";
      const result = formatSlackMrkdwn(input);
      expect(result).toBe("• Item 1\n\n• Item 2");
    });

    test("keeps bullets with content", () => {
      const input = "• Real item\n• Another item";
      const result = formatSlackMrkdwn(input);
      expect(result).toBe("• Real item\n• Another item");
    });
  });

  // --- Link preservation tests ---

  describe("link preservation", () => {
    test("preserves multiple markdown links", () => {
      const input = "See [docs](https://docs.com) and [api](https://api.com)";
      const result = formatSlackMrkdwn(input);
      expect(result).toBe("See <https://docs.com|docs> and <https://api.com|api>");
    });

    test("preserves links alongside HTML tags", () => {
      const input = '<div>Check <a href="https://example.com">this</a></div>';
      const result = formatSlackMrkdwn(input);
      expect(result).toBe("Check <https://example.com|this>");
    });

    test("preserves bare URL links", () => {
      const input = "Visit <https://example.com> for details";
      const result = formatSlackMrkdwn(input);
      expect(result).toBe("Visit <https://example.com> for details");
    });
  });

  // --- Italics (`*x*` → `_x_`) ---
  // Slack renders a single `*` as BOLD, so markdown italics arrived looking like a
  // second bold word. This pass changes live Slack output for every bot.

  describe("italics conversion", () => {
    test("converts *italic* to _italic_", () => {
      expect(formatSlackMrkdwn("this is *italic* text")).toBe("this is _italic_ text");
    });

    test("bold and italics in one line keep their own emphasis", () => {
      // Measured: the guarded pattern placed AFTER the bold rewrite re-reads the
      // just-produced `*b*` and yields `_b_ and _i_`. Before it, both are right.
      expect(formatSlackMrkdwn("**b** and *i*")).toBe("*b* and _i_");
    });

    test("_underscore italics_ pass through as mrkdwn already", () => {
      expect(formatSlackMrkdwn("this is _italic_ text")).toBe("this is _italic_ text");
    });

    // The flanking rule: no whitespace immediately inside the delimiters. Without
    // it, prose arithmetic reads as one emphasis span.
    for (const input of [
      "2 * 3 and 4 * 5",
      "a * b",
      "select * from t",
      "src/**/*.ts",
      "a*b*c",
      "5 * 5 = 25",
    ]) {
      test(`leaves non-emphasis asterisks alone: ${input}`, () => {
        expect(formatSlackMrkdwn(input)).toBe(input);
      });
    }

    // Adversarial review, EXECUTED repros: the first flanking rule only rejected
    // whitespace immediately inside the delimiters, so any two asterisks on a line
    // separated by non-word characters paired up. Every input below came back
    // mangled (`/usr/_/bin`, `SELECT _, count(_)`, `\_not italic\_`). The rule is
    // now strict word-flanking; the safe direction is "leave unchanged".
    for (const input of [
      "Files live in /usr/*/bin and /var/*/log",
      "SELECT *, count(*) FROM t",
      "regex ^.*$ and .*?",
      "see https://ex.com/x/*b*/c",
      "<https://ex.com/x/*b*/c>",
      "\\*not italic\\*",
      "glob **/*.test.ts here",
    ]) {
      test(`strict flanking leaves it alone: ${input}`, () => {
        expect(formatSlackMrkdwn(input)).toBe(input);
      });
    }

    // Round-2 widening, the one knock-on flip: `(` joined the allowed preceders
    // (so `«*økta*»` and friends work), which makes a parenthesized span emphasize
    // where it used to be left alone. Pinned as behaviour rather than left as a
    // surprise — it is what CommonMark does. Full table: markdown-all-platforms.
    test("a parenthesized span now emphasizes (deliberate flip, was inert)", () => {
      expect(formatSlackMrkdwn("a (*b*) in parens")).toBe("a (_b_) in parens");
    });

    test("a non-ASCII word still italicizes (the rule is unicode-aware)", () => {
      expect(formatSlackMrkdwn("dette er *økta* nå")).toBe("dette er _økta_ nå");
    });

    test("italics inside inline code stay literal", () => {
      expect(formatSlackMrkdwn("use `a *b* c` here")).toBe("use `a *b* c` here");
    });

    test("italics inside a fenced block stay literal", () => {
      expect(formatSlackMrkdwn("```\na *b* c\n```")).toBe("```\na *b* c\n```");
    });
  });

  // --- Link/emphasis ordering ---
  // The link rewrite runs BEFORE the emphasis passes; only the generated `<url|`
  // and `>` are parked, so the label still gets bold/italics while the URL can't.

  describe("link + emphasis ordering", () => {
    test("an asterisk pair inside a URL is never read as emphasis", () => {
      expect(formatSlackMrkdwn("[docs](https://ex.com/a*b*c)")).toBe("<https://ex.com/a*b*c|docs>");
      expect(formatSlackMrkdwn("[docs](https://ex.com/x/*b*/c)")).toBe("<https://ex.com/x/*b*/c|docs>");
    });

    test("an intraword asterisk pair in a link LABEL is left alone (as in prose)", () => {
      expect(formatSlackMrkdwn("[a*b*c](https://x.com)")).toBe("<https://x.com|a*b*c>");
    });

    test("emphasis inside a link label still renders", () => {
      expect(formatSlackMrkdwn("[**bold**](https://x.com)")).toBe("<https://x.com|*bold*>");
      expect(formatSlackMrkdwn("[see *this*](https://x.com)")).toBe("<https://x.com|see _this_>");
    });

    test("a `>` inside a URL survives the trailing tag-strip", () => {
      expect(formatSlackMrkdwn("[q](https://x.com/?a=1>2)")).toBe("<https://x.com/?a=1>2|q>");
    });

    // Adversarial review, EXECUTED repro: the tag-strip ran THROUGH the parked
    // `>` sentinel, so a `<` in a link label ate everything up to the next `>`
    // anywhere later in the message. Text loss on live output.
    describe("a `<` in a link label never eats the text after the link", () => {
      test("bare `<` in the label", () => {
        const out = formatSlackMrkdwn("[a<b](https://x.com) then more > text");
        expect(out).toContain("then more > text");
        expect(out).toContain("https://x.com");
      });

      test("a tag-shaped label loses only the tag, never what follows the link", () => {
        const out = formatSlackMrkdwn("[Foo <Bar>](https://x.com) and after");
        expect(out).toContain("and after");
        expect(out).toContain("Foo");
      });

      test("spaced comparison operators around a link", () => {
        const out = formatSlackMrkdwn("[a < b](https://x.com) and c > d");
        expect(out).toContain("and c > d");
        expect(out).toContain("a < b");
      });
    });

    // The ACCEPTED COST of that NUL exclusion, pinned as behaviour so a future
    // "tidy-up" of the strip has to argue with the trade instead of rediscovering
    // it. Because the tag body may not run through a sentinel, a tag-shaped span
    // that CONTAINS a parked placeholder is no longer strippable and survives into
    // the posted message. Deliberate: the alternative is the data loss above, and
    // a leaked tag is visible in a message the user reads, while eaten prose is
    // not. Documented in `src/slack/CLAUDE.md`.
    describe("a tag-shaped span containing a parked placeholder survives the strip", () => {
      test("a plain tag is still stripped (the rule still does its job)", () => {
        expect(formatSlackMrkdwn("plain <span> stripped")).toBe("plain  stripped");
        expect(formatSlackMrkdwn('<span class="x">kept?</span>')).toBe("kept?");
      });

      test("a backticked attr parks inline code, so the whole span survives", () => {
        expect(formatSlackMrkdwn("a <span title=`code`> b")).toBe("a <span title=`code`> b");
      });

      test("an embedded markdown link parks link delimiters, same effect", () => {
        expect(formatSlackMrkdwn("a <div data=[lab](https://x.com)> b")).toBe(
          "a <div data=<https://x.com|lab>> b",
        );
      });
    });

    test("a non-scheme link target degrades to its LABEL (Slack renders `</path|x>` oddly)", () => {
      expect(formatSlackMrkdwn("[rel](/path/to.md)")).toBe("rel");
      expect(formatSlackMrkdwn("[page](plans/x.mdx)")).toBe("page");
      // mailto is linkable, like http(s).
      expect(formatSlackMrkdwn("[mail](mailto:a@b.no)")).toBe("<mailto:a@b.no|mail>");
    });
  });

  describe("component blocks", () => {
    test("Callout → bold title + body", () => {
      expect(formatSlackMrkdwn("<Callout title=\"Heads up\">\nbody\n</Callout>")).toBe("*Heads up*\nbody");
    });

    test("Callout without title → just body", () => {
      expect(formatSlackMrkdwn("<Callout>\nbody\n</Callout>")).toBe("body");
    });

    test("Verdict → check/cross + label", () => {
      expect(formatSlackMrkdwn("<Verdict value=\"yes\">Fast</Verdict>")).toBe("✅ Fast");
      expect(formatSlackMrkdwn("<Verdict value=\"no\" />")).toBe("❌ No");
    });

    test("Pill → [text]", () => {
      expect(formatSlackMrkdwn("<Pill>beta</Pill>")).toBe("[beta]");
    });

    test("FileRef self-closing → plain path", () => {
      expect(formatSlackMrkdwn("<FileRef path=\"src/x.ts\" />")).toBe("src/x.ts");
    });

    test("ComparisonTable → labeled bullets (inner table shape)", () => {
      const out = formatSlackMrkdwn("<ComparisonTable>\n| A | B |\n| --- | --- |\n| 1 | 2 |\n</ComparisonTable>");
      expect(out).toBe("• *A:* 1  *B:* 2");
    });

    test("Meter → label: value/max fallback", () => {
      expect(formatSlackMrkdwn("<Meter value=\"4\" max=\"5\" tone=\"good\">Autonomy</Meter>")).toBe(
        "Autonomy: 4/5",
      );
    });

    test("Meter clamps out-of-range value", () => {
      expect(formatSlackMrkdwn("<Meter value=\"9\" max=\"5\">Over</Meter>")).toBe("Over: 5/5");
    });

    test("Meter with non-numeric value degrades to plain label", () => {
      expect(formatSlackMrkdwn("<Meter value=\"abc\">Autonomy</Meter>")).toBe("Autonomy");
    });

    test("Diff → fence as-is (Slack renders the code block)", () => {
      const out = formatSlackMrkdwn("<Diff>\n```diff\n context\n-old\n+new\n```\n</Diff>");
      expect(out).toBe("```\n context\n-old\n+new\n```");
    });

    test("unclosed Diff degrades to text (no code block emitted)", () => {
      const out = formatSlackMrkdwn("<Diff>\nno close here");
      expect(out).toContain("no close here");
      expect(out).not.toContain("```");
    });

    test("FileTree → fence as-is (Slack renders the code block)", () => {
      const out = formatSlackMrkdwn("<FileTree>\n```\nsrc/\n  a.ts\n```\n</FileTree>");
      expect(out).toBe("```\nsrc/\n  a.ts\n```");
    });

    test("unclosed FileTree degrades to text (no code block emitted)", () => {
      const out = formatSlackMrkdwn("<FileTree>\nno close");
      expect(out).toContain("no close");
      expect(out).not.toContain("```");
    });

    test("Checklist → ☑/☐-prefixed lines fallback", () => {
      const out = formatSlackMrkdwn("<Checklist>\n- [x] Done\n- [ ] Todo\n</Checklist>");
      expect(out).toBe("☑ Done\n☐ Todo");
    });

    test("unclosed Checklist degrades to text (the raw open tag survives)", () => {
      const out = formatSlackMrkdwn("<Checklist>\n- [x] no close");
      expect(out).toContain("no close");
      expect(out).not.toContain("☑");
    });

    test("AnnotatedCode → file line + fence + notes fallback", () => {
      const out = formatSlackMrkdwn(
        "<AnnotatedCode file=\"src/x.ts\" lang=\"ts\">\n```ts\nconst x = 1;\n```\n\nSets x.\n</AnnotatedCode>",
      );
      expect(out).toBe("*src/x.ts*\n```\nconst x = 1;\n```\n\nSets x.");
    });

    test("unclosed AnnotatedCode degrades to text (no code block emitted)", () => {
      const out = formatSlackMrkdwn("<AnnotatedCode file=\"x.ts\">\nno close");
      expect(out).toContain("no close");
      expect(out).not.toContain("```");
    });

    test("CodeTabs → sequential — label — sections fallback", () => {
      const out = formatSlackMrkdwn(
        "<CodeTabs>\n<Tab label=\"TS\">\n```ts\nconst x=1;\n```\n</Tab>\n<Tab label=\"JS\">\n```js\nvar x=1;\n```\n</Tab>\n</CodeTabs>",
      );
      expect(out).toBe("— TS —\n```\nconst x=1;\n```\n— JS —\n```\nvar x=1;\n```");
    });

    test("standalone Tab renders a labeled section", () => {
      const out = formatSlackMrkdwn("<Tab label=\"Only\">\n```ts\nx\n```\n</Tab>");
      expect(out).toBe("— Only —\n```\nx\n```");
    });
  });

  describe("inline components (Verdict/Pill mid-text)", () => {
    test("inline Verdict → ✅ label in the sentence flow", () => {
      expect(formatSlackMrkdwn("Build is <Verdict value=\"yes\">green</Verdict> now")).toBe(
        "Build is ✅ green now",
      );
    });

    test("inline Pill → [text] in the sentence flow", () => {
      expect(formatSlackMrkdwn("Rollout <Pill tone=\"rec\">beta</Pill> today")).toBe(
        "Rollout [beta] today",
      );
    });

    test("inline component inner-text tag is stripped (no live markup)", () => {
      const out = formatSlackMrkdwn("tag <Pill><img src=x onerror=alert(1)></Pill> here");
      expect(out).not.toContain("<img");
    });
  });
});
