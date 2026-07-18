import { test, expect, describe } from "bun:test";
import { formatWebHtml } from "../web/web-format.ts";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { formatSlackMrkdwn } from "../slack/slack-format.ts";

// Early-warning system for divergence: the three platform formatters share one
// block AST + dispatcher, so the same markdown must keep producing each
// platform's expected shape. A drift in one formatter trips exactly one column.

describe("heading (## Hello)", () => {
  test("web → h3", () => expect(formatWebHtml("## Hello")).toBe("<h3>Hello</h3>"));
  test("telegram → bold", () => expect(formatTelegramHtml("## Hello")).toBe("<b>Hello</b>"));
  test("slack → *bold*", () => expect(formatSlackMrkdwn("## Hello")).toBe("*Hello*"));
});

describe("bold (**x**)", () => {
  test("web", () => expect(formatWebHtml("**x**")).toBe("<strong>x</strong>"));
  test("telegram", () => expect(formatTelegramHtml("**x**")).toBe("<b>x</b>"));
  test("slack", () => expect(formatSlackMrkdwn("**x**")).toBe("*x*"));
});

describe("inline code (`x`)", () => {
  test("web", () => expect(formatWebHtml("`x`")).toBe("<code>x</code>"));
  test("telegram", () => expect(formatTelegramHtml("`x`")).toBe("<code>x</code>"));
  test("slack", () => expect(formatSlackMrkdwn("`x`")).toBe("`x`"));
});

describe("link [label](https://example.com)", () => {
  const md = "[label](https://example.com)";
  test("web → anchor with target/rel", () =>
    expect(formatWebHtml(md)).toBe('<a href="https://example.com" target="_blank" rel="noopener">label</a>'));
  test("telegram → bare anchor", () =>
    expect(formatTelegramHtml(md)).toBe('<a href="https://example.com">label</a>'));
  test("slack → mrkdwn link", () => expect(formatSlackMrkdwn(md)).toBe("<https://example.com|label>"));
});

describe("fenced code block", () => {
  const md = "```ts\nconst x = 1;\n```";
  test("web → pre/code with language class", () =>
    expect(formatWebHtml(md)).toBe('<pre><code class="language-ts">const x = 1;</code></pre>'));
  test("telegram → pre/code with language class", () =>
    expect(formatTelegramHtml(md)).toBe('<pre><code class="language-ts">const x = 1;</code></pre>'));
  test("slack → triple-backtick block (no language, no escaping)", () =>
    expect(formatSlackMrkdwn(md)).toBe("```\nconst x = 1;\n```"));
});

describe("unordered list", () => {
  const md = "- a\n- b";
  test("web → <ul>", () => expect(formatWebHtml(md)).toBe("<ul><li>a</li><li>b</li></ul>"));
  test("telegram → dash lines", () => expect(formatTelegramHtml(md)).toBe("- a\n- b"));
  test("slack → dash lines", () => expect(formatSlackMrkdwn(md)).toBe("- a\n- b"));
});

describe("table renders without throwing and matches each platform's shape", () => {
  const md = "| H1 | H2 |\n| --- | --- |\n| a | b |";
  test("web → <table>", () => expect(formatWebHtml(md)).toContain("<table>"));
  test("telegram → pipe table preserved", () => expect(formatTelegramHtml(md)).toContain("| H1 | H2 |"));
  test("slack → labeled bullets", () => expect(formatSlackMrkdwn(md)).toBe("• *H1:* a  *H2:* b"));
});

describe("inline Verdict mid-list — chip on web, plain fallback in-sentence elsewhere", () => {
  const md = "- Result: <Verdict value=\"yes\">shipped</Verdict>";
  test("web → inline chip inside the <li>", () =>
    expect(formatWebHtml(md)).toBe('<ul><li>Result: <span class="verdict verdict-yes">shipped</span></li></ul>'));
  test("telegram → ✅ label sits inline in the list line", () =>
    expect(formatTelegramHtml(md)).toBe("- Result: ✅ shipped"));
  test("slack → ✅ label sits inline in the list line", () =>
    expect(formatSlackMrkdwn(md)).toBe("- Result: ✅ shipped"));
});

describe("inline Pill mid-sentence — chip on web, [text] fallback elsewhere", () => {
  const md = "Ship it <Pill tone=\"rec\">beta</Pill> today";
  test("web → inline pill span", () =>
    expect(formatWebHtml(md)).toBe('Ship it <span class="pill pill-rec">beta</span> today'));
  test("telegram → [beta] inline", () =>
    expect(formatTelegramHtml(md)).toBe("Ship it [beta] today"));
  test("slack → [beta] inline", () =>
    expect(formatSlackMrkdwn(md)).toBe("Ship it [beta] today"));
});

// Regression (PR #307 review): a COMPLETE component tag inside an inline-code
// span must stay literal code on every platform — never get interpreted as a
// chip, and never leak a raw NUL sentinel into the served output. This is the
// two-reviewer BLOCKER + the all-platform code-literal finding.
describe("complete component tag inside backticks stays literal code", () => {
  const md = 'Use `<Verdict value="yes">x</Verdict>` in code.';
  test("web → <code> with the escaped tag, no NUL, no INLINECMP", () => {
    const out = formatWebHtml(md);
    expect(out).toBe(
      "Use <code>&lt;Verdict value=&quot;yes&quot;&gt;x&lt;/Verdict&gt;</code> in code.",
    );
    expect(out).not.toContain("\x00");
    expect(out).not.toContain("INLINECMP");
  });
  test("telegram → <code> with the escaped literal tag, no NUL", () => {
    const out = formatTelegramHtml(md);
    expect(out).toBe(
      "Use <code>&lt;Verdict value=&quot;yes&quot;&gt;x&lt;/Verdict&gt;</code> in code.",
    );
    expect(out).not.toContain("\x00");
    expect(out).not.toContain("✅");
  });
  test("slack → backticked literal tag, no NUL", () => {
    const out = formatSlackMrkdwn(md);
    expect(out).toBe('Use `<Verdict value="yes">x</Verdict>` in code.');
    expect(out).not.toContain("\x00");
    expect(out).not.toContain("✅");
  });
});

// Regression (PR #307 review): the REVERSE nesting — a mid-text component whose
// label itself contains an inline-code span. The fixed-point restore must resolve
// the component→code sentinel nesting; the pinned rendering is the label backticks
// as code, and crucially never a raw NUL byte.
describe("component label containing inline code renders without a sentinel leak", () => {
  const md = "mid <Pill>label with `code` inside</Pill> end";
  test("web → pill span with a nested <code>, no NUL", () => {
    const out = formatWebHtml(md);
    expect(out).toBe('mid <span class="pill">label with <code>code</code> inside</span> end');
    expect(out).not.toContain("\x00");
  });
  test("telegram → [label…] fallback, no NUL", () => {
    const out = formatTelegramHtml(md);
    expect(out).not.toContain("\x00");
    expect(out).toContain("label with");
  });
  test("slack → [label…] fallback, no NUL", () => {
    const out = formatSlackMrkdwn(md);
    expect(out).not.toContain("\x00");
    expect(out).toContain("label with");
  });
});

// Coverage review fold-in: an unquoted (malformed) attr is not a valid component
// tag — it must render as an escaped literal, not a chip.
describe("malformed unquoted attr renders as escaped literal, not a chip", () => {
  const md = "<Verdict value=yes>x</Verdict>";
  test("web → escaped literal, no verdict span", () => {
    const out = formatWebHtml(md);
    expect(out).toContain("&lt;Verdict value=yes&gt;");
    expect(out).not.toContain('<span class="verdict');
  });
});
