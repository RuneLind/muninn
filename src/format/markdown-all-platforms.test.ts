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

// ── Fact-check annotation pair ───────────────────────────────────────────────
// `<Fact>` marks a checked passage inline; `<FactCheck>` is the collapsed
// appendix. Web gets the real affordance (underline + chip button, <details>);
// Telegram/Slack degrade to the passage plus a verdict glyph, and a one-line
// summary. The two `Fact` FORMS (inline vs own-line block) must both look marked.

describe("inline Fact mid-sentence — underline + chip on web, glyph elsewhere", () => {
  const md = 'It weighed <Fact n="4" v="bad">1.32 kg</Fact> at launch.';
  test("web → verdict-tinted mark span plus a chip button", () => {
    const out = formatWebHtml(md);
    expect(out).toContain('<span class="fc-mark fc-mark-bad" data-fact="4">1.32 kg</span>');
    expect(out).toContain('<button type="button" class="fc-chip fc-chip-bad" data-fact="4"');
    expect(out).toContain('title="Claim 4 — corrected"');
    expect(out).toContain("It weighed ");
    expect(out).toContain(" at launch.");
  });
  test("telegram → passage kept, verdict glyph appended", () =>
    expect(formatTelegramHtml(md)).toBe("It weighed 1.32 kg ✗ at launch."));
  test("slack → passage kept, verdict glyph appended", () =>
    expect(formatSlackMrkdwn(md)).toBe("It weighed 1.32 kg ✗ at launch."));
});

describe("own-line Fact is claimed by the BLOCK parser — still visibly marked", () => {
  // A `Fact` owning its whole trimmed line never reaches `renderInline`, so the
  // block renderer must produce its own marked wrapper (a verdict-coloured left
  // rail) rather than dropping the mark. Both forms must look marked.
  const md = '<Fact n="4" v="bad">The rover weighed 1.32 kg.</Fact>';
  test("web → block mark wrapper carrying the same verdict class + chip", () => {
    const out = formatWebHtml(md);
    expect(out).toContain('<div class="fc-mark fc-mark-block fc-mark-bad" data-fact="4">');
    expect(out).toContain("The rover weighed 1.32 kg.");
    expect(out).toContain('class="fc-chip fc-chip-bad"');
    // Never the inline form here — the block parser got there first.
    expect(out).not.toContain('<span class="fc-mark fc-mark-bad"');
  });
  test("telegram → passage kept, verdict glyph appended", () =>
    expect(formatTelegramHtml(md)).toBe("The rover weighed 1.32 kg. ✗"));
  test("slack → passage kept, verdict glyph appended", () =>
    expect(formatSlackMrkdwn(md)).toBe("The rover weighed 1.32 kg. ✗"));
});

// Regression guard against a future "tidy-up" that routes `Fact` through
// `inlineComponent` like `Verdict`/`Pill`: that path escapes its label, which
// would render `**1.32 kg**` as literal asterisks instead of bold. `Fact` is the
// ONLY inline component wrapping PROSE, so it parks its generated tags and leaves
// the body in the stream for the bold/link/escape passes.
describe("markdown inside a paired Fact keeps rendering (prose, not an escaped label)", () => {
  const md = 'It weighed <Fact n="4" v="bad">**1.32 kg** per [spec](https://example.com)</Fact> then.';
  test("web → <strong> and <a> inside the mark span, no literal asterisks", () => {
    const out = formatWebHtml(md);
    expect(out).toContain("<strong>1.32 kg</strong>");
    expect(out).toContain('<a href="https://example.com" target="_blank" rel="noopener">spec</a>');
    expect(out).not.toContain("**1.32 kg**");
    expect(out).toContain('<span class="fc-mark fc-mark-bad" data-fact="4">');
  });
  test("telegram → <b> inside the passage", () =>
    expect(formatTelegramHtml(md)).toContain("<b>1.32 kg</b>"));
  test("slack → *bold* inside the passage", () =>
    expect(formatSlackMrkdwn(md)).toContain("*1.32 kg*"));
});

describe("Fact with an absent/garbage verdict degrades to `unknown`, never to ok", () => {
  for (const [label, md] of [
    ["absent v", '<Fact n="4">passage</Fact>'],
    ["garbage v", '<Fact n="4" v="totally-fine">passage</Fact>'],
  ] as const) {
    test(`web (${label}) → unknown chip, no ok styling`, () => {
      const out = formatWebHtml(md);
      expect(out).toContain("fc-mark-unknown");
      expect(out).toContain('class="fc-chip fc-chip-unknown"');
      expect(out).toContain("unverified");
      expect(out).not.toContain("fc-mark-ok");
      expect(out).not.toContain("fc-chip-ok");
    });
    test(`telegram (${label}) → the ? glyph, never ✓`, () => {
      const out = formatTelegramHtml(md);
      expect(out).toBe("passage ?");
    });
  }
});

describe("FactCheck appendix renders collapsed, with per-claim sections", () => {
  const md =
    '<FactCheck date="2026-07-29" ok="3" warn="1" bad="2">\n### ✅ Claim 1/3 — the weight\n\nEvidence line.\n</FactCheck>';
  test("web → a <details> that is NOT open, with an fc-claim section per claim", () => {
    const out = formatWebHtml(md);
    expect(out).toContain('<details class="fc-block">');
    expect(out).not.toContain("<details open");
    expect(out).toContain('<summary class="fc-strip">');
    expect(out).toContain("Fact-checked <b>2026-07-29</b>");
    expect(out).toContain('<span class="fc-count fc-count-ok">✓ 3 confirmed</span>');
    expect(out).toContain('<span class="fc-count fc-count-warn">⚠ 1 needs care</span>');
    expect(out).toContain('<span class="fc-count fc-count-bad">✗ 2 corrected</span>');
    expect(out).toContain('<section class="fc-claim" id="fc-claim-1" data-claim="1">');
    expect(out).toContain("Evidence line.");
  });
  test("telegram → one-line summary then the children", () => {
    const out = formatTelegramHtml(md);
    expect(out.startsWith("Fact-checked 2026-07-29: 3 confirmed, 1 needs care, 2 corrected")).toBe(true);
    expect(out).toContain("Evidence line.");
    expect(out).not.toContain("<details");
  });
  test("slack → one-line summary then the children", () => {
    const out = formatSlackMrkdwn(md);
    expect(out.startsWith("Fact-checked 2026-07-29: 3 confirmed, 1 needs care, 2 corrected")).toBe(true);
    expect(out).toContain("Evidence line.");
  });
});

describe("FactCheck counts that are absent or garbage are OMITTED, never rendered as 0", () => {
  // The appendix must not claim "0 corrected" on a page whose writer simply
  // didn't say — an omitted count is silence, a rendered 0 is a claim.
  const cases = [
    ['<FactCheck date="2026-07-29">\nbody\n</FactCheck>', "all absent"],
    ['<FactCheck date="2026-07-29" ok="abc" warn="x" bad="-1">\nbody\n</FactCheck>', "garbage/negative"],
    ['<FactCheck date="2026-07-29" ok="" warn=" " bad="">\nbody\n</FactCheck>', "empty-string"],
  ] as const;
  for (const [md, label] of cases) {
    test(`web (${label}) → lead only, no count spans`, () => {
      const out = formatWebHtml(md);
      expect(out).toContain('<span class="fc-strip-lead">Fact-checked <b>2026-07-29</b></span>');
      expect(out).not.toContain("fc-count");
      expect(out).not.toContain("0 confirmed");
      expect(out).not.toContain("0 corrected");
    });
    test(`telegram (${label}) → bare "Fact-checked <date>" line, no counts`, () => {
      const out = formatTelegramHtml(md);
      expect(out.split("\n")[0]).toBe("Fact-checked 2026-07-29");
      expect(out).not.toContain("0 confirmed");
    });
    test(`slack (${label}) → bare "Fact-checked <date>" line, no counts`, () => {
      const out = formatSlackMrkdwn(md);
      expect(out.split("\n")[0]).toBe("Fact-checked 2026-07-29");
      expect(out).not.toContain("0 corrected");
    });
  }

  test("a FactCheck with no date at all still leads with a bare label", () => {
    const out = formatWebHtml("<FactCheck>\nbody\n</FactCheck>");
    expect(out).toContain('<span class="fc-strip-lead">Fact-checked</span>');
    expect(formatTelegramHtml("<FactCheck>\nbody\n</FactCheck>").split("\n")[0]).toBe("Fact-checked");
  });

  // `Number()` accepts JS numeric literals, so these read as 16 and 100000 — a
  // count nobody wrote, rendered as if the writer had.
  for (const [attrs, label] of [
    ['ok="0x10"', "hex"],
    ['ok="1e5"', "exponent"],
    ['ok=" 3 "', "padded (still a real count)"],
  ] as const) {
    const md = `<FactCheck date="2026-07-29" ${attrs}>\nbody\n</FactCheck>`;
    const real = label.startsWith("padded");
    test(`counts are digits-only — ${label}`, () => {
      const web = formatWebHtml(md);
      const tg = formatTelegramHtml(md);
      if (real) {
        expect(web).toContain("3 confirmed");
        expect(tg).toContain("3 confirmed");
      } else {
        expect(web).not.toContain("fc-count");
        expect(web).not.toContain("16");
        expect(web).not.toContain("100000");
        expect(tg.split("\n")[0]).toBe("Fact-checked 2026-07-29");
        expect(formatSlackMrkdwn(md).split("\n")[0]).toBe("Fact-checked 2026-07-29");
      }
    });
  }
});

describe("FactCheck date is escaped on every platform", () => {
  // An unescaped date emits an unbalanced tag, and Telegram 400s the whole
  // message rather than dropping the tag.
  const md = '<FactCheck date="2026 <b>x" ok="1">\nbody\n</FactCheck>';
  test("telegram → no raw tag in the summary line", () => {
    const first = formatTelegramHtml(md).split("\n")[0]!;
    expect(first).toContain("&lt;b&gt;");
    expect(first).not.toContain("<b>x");
  });
  test("slack → same escaping (the twins must not drift)", () => {
    const first = formatSlackMrkdwn(md).split("\n")[0]!;
    expect(first).toContain("&lt;b&gt;");
    expect(first).not.toContain("<b>x");
  });
  test("web → escaped inside the lead's own <b>", () => {
    const out = formatWebHtml(md);
    expect(out).toContain("Fact-checked <b>2026 &lt;b&gt;x</b>");
  });
});

describe("Fact claim numbers are digits-only, and claim ids are unique", () => {
  for (const [n, label] of [
    ["0x10", "hex"],
    ["1e2", "exponent"],
    ["  ", "blank"],
  ] as const) {
    test(`n="${n}" (${label}) → no data-fact, a chip with no claim link`, () => {
      const out = formatWebHtml(`It weighed <Fact n="${n}" v="ok">1.32 kg</Fact> at launch.`);
      expect(out).not.toContain("data-fact");
      expect(out).toContain('class="fc-chip fc-chip-ok"');
      expect(out).toContain("Fact check: confirmed");
    });
  }

  test("two headings with the SAME claim number emit the id only once", () => {
    const md =
      '<FactCheck date="2026-07-29">\n### ✅ Claim 1/2 — first\n\nA.\n\n### ⚠️ Claim 1/2 — dupe\n\nB.\n</FactCheck>';
    const out = formatWebHtml(md);
    expect(out.match(/id="fc-claim-1"/g)?.length).toBe(1);
    // The duplicate still renders its evidence, just unaddressed.
    expect(out).toContain('<section class="fc-claim" data-claim="1">');
    expect(out).toContain("A.");
    expect(out).toContain("B.");
  });
});
