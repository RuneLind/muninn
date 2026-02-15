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
});
