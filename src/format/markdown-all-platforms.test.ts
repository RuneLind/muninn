import { test, expect, describe } from "bun:test";
import { formatWebHtml } from "../web/web-format.ts";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { formatSlackMrkdwn } from "../slack/slack-format.ts";
import { formatEmailHtml } from "./email-format.ts";
import { RAW_EMPHASIS_SOURCES } from "./markdown-core.ts";
import { stripTokenSpans } from "../test/highlighted-code.ts";
import * as ast from "./markdown-ast.ts";

// Early-warning system for divergence: the FOUR platform formatters share one
// block AST + dispatcher, so the same markdown must keep producing each
// platform's expected shape. A drift in one formatter trips exactly one column.
//
// The email column asserts STRUCTURE plus the load-bearing inline `style=`, not
// the full style string — mail clients drop <style> blocks and ignore classes, so
// "the rule is inline at all" is the contract; its exact px values are not.

describe("heading (## Hello)", () => {
  test("web → h3", () => expect(formatWebHtml("## Hello")).toBe("<h3>Hello</h3>"));
  test("telegram → bold", () => expect(formatTelegramHtml("## Hello")).toBe("<b>Hello</b>"));
  test("slack → *bold*", () => expect(formatSlackMrkdwn("## Hello")).toBe("*Hello*"));
  test("email → h3 carrying its own inline style", () => {
    const out = formatEmailHtml("## Hello");
    expect(out.startsWith("<h3 style=")).toBe(true);
    expect(out).toContain(">Hello</h3>");
    expect(out).toContain("font-weight:600");
  });
});

describe("bold (**x**)", () => {
  test("web", () => expect(formatWebHtml("**x**")).toBe("<strong>x</strong>"));
  test("telegram", () => expect(formatTelegramHtml("**x**")).toBe("<b>x</b>"));
  test("slack", () => expect(formatSlackMrkdwn("**x**")).toBe("*x*"));
  test("email → <strong> inside a styled <p>", () => {
    const out = formatEmailHtml("**x**");
    expect(out).toContain("<strong>x</strong>");
    expect(out.startsWith("<p style=")).toBe(true);
  });
});

describe("inline code (`x`)", () => {
  test("web", () => expect(formatWebHtml("`x`")).toBe("<code>x</code>"));
  test("telegram", () => expect(formatTelegramHtml("`x`")).toBe("<code>x</code>"));
  test("slack", () => expect(formatSlackMrkdwn("`x`")).toBe("`x`"));
  test("email → <code> with an inline mono/background rule", () => {
    const out = formatEmailHtml("`x`");
    expect(out).toContain("<code style=");
    expect(out).toContain("font-family:ui-monospace");
    expect(out).toContain(">x</code>");
  });
});

describe("link [label](https://example.com)", () => {
  const md = "[label](https://example.com)";
  test("web → anchor with target/rel", () =>
    expect(formatWebHtml(md)).toBe('<a href="https://example.com" target="_blank" rel="noopener">label</a>'));
  test("telegram → bare anchor", () =>
    expect(formatTelegramHtml(md)).toBe('<a href="https://example.com">label</a>'));
  test("slack → mrkdwn link", () => expect(formatSlackMrkdwn(md)).toBe("<https://example.com|label>"));
  test("email → anchor with an inline colour (mail has no stylesheet to inherit)", () => {
    const out = formatEmailHtml(md);
    expect(out).toContain('<a href="https://example.com" style=');
    expect(out).toContain("text-decoration:underline");
    expect(out).toContain(">label</a>");
  });
  test("email → a NON-http target degrades to its label, never a dead href", () =>
    expect(formatEmailHtml("[label](plans/x.md)")).not.toContain("<a "));
  test("slack → a NON-scheme target degrades to its label (mrkdwn has no relative link)", () =>
    expect(formatSlackMrkdwn("[label](plans/x.md)")).toBe("label"));
});

// The linkable gate is ONE regex (`LINKABLE_TARGET_RE` in markdown-core.ts), and
// this block is why it had to become one. Email spelled its own case-SENSITIVE
// `^https?://` with no trim, so all three of these linked on Slack and degraded to
// bare label text in the mail body — a silent per-platform divergence in a share
// feature whose whole job is producing the same post twice.
describe("the linkable-target gate is shared by slack + email", () => {
  test("mailto: is a real link on both", () => {
    expect(formatSlackMrkdwn("[mail](mailto:a@b.no)")).toBe("<mailto:a@b.no|mail>");
    expect(formatEmailHtml("[mail](mailto:a@b.no)")).toContain('<a href="mailto:a@b.no"');
  });

  test("the scheme match is case-insensitive on both", () => {
    expect(formatSlackMrkdwn("[t](HTTPS://X.COM/a)")).toBe("<HTTPS://X.COM/a|t>");
    expect(formatEmailHtml("[t](HTTPS://X.COM/a)")).toContain('<a href="HTTPS://X.COM/a"');
  });

  test("the target is trimmed before the gate AND in the emitted href", () => {
    expect(formatSlackMrkdwn("[lab](  https://x.com  )")).toBe("<https://x.com|lab>");
    const out = formatEmailHtml("[lab](  https://x.com  )");
    expect(out).toContain('<a href="https://x.com"');
    expect(out).not.toContain('href="  ');
  });

  test("…and a javascript: target is still no link at all, on either", () => {
    // The gate is an allow-list; widening it to mailto must not widen it further.
    expect(formatSlackMrkdwn("[x](javascript:alert)")).not.toContain("<javascript");
    expect(formatEmailHtml("[x](javascript:alert)")).not.toContain("<a ");
  });
});

// Adversarial review, EXECUTED repro: `***x***` met the non-greedy bold pattern
// `\*\*(.+?)\*\*`, which claimed the FIRST two stars and stopped at the next two —
// email rendered `<strong>*triple</strong>*`, leaking a literal asterisk into the
// mail body (worse than main's mis-nested but styled output). Both strict-rule
// platforms now rewrite the triple in one step, BEFORE their bold pass — under
// the SAME flanking guards as their italics rule (round 3), with everything the
// guards reject parked literal. Both halves are pinned in "stars are never
// silently dropped" below.
describe("triple emphasis (***x***) is bold + italic, with no star left over", () => {
  const md = "a ***triple*** span";
  test("slack → *_x_*, mrkdwn's bold-italic", () =>
    expect(formatSlackMrkdwn(md)).toBe("a *_triple_* span"));
  test("email → nested <strong><em>, no literal asterisk", () => {
    const out = formatEmailHtml(md);
    expect(out).toContain("<strong><em>triple</em></strong>");
    expect(out).not.toContain("*");
  });
  // Telegram and web are PINNED TO TODAY'S OUTPUT — they keep their own weaker
  // passes, which produce mis-NESTED but correctly styled tags. Not corrected
  // here for the same reason their italics rule isn't: it would move
  // long-standing live output as a side effect of a share feature.
  test("web → today's mis-nested-but-styled output (known, deliberate)", () =>
    expect(formatWebHtml(md)).toBe("a <strong><em>triple</strong></em> span"));
  test("telegram → today's mis-nested-but-styled output (known, deliberate)", () =>
    expect(formatTelegramHtml(md)).toBe("a <b><i>triple</b></i> span"));
});

// Adversarial review, EXECUTED repro: email emitted its `<a href="…">` BEFORE the
// emphasis passes, so markdown characters inside a URL were rewritten into the
// href — the exact bug the Slack column already pins. The absence of an email
// column here is why it shipped green. All three emphasis markers are covered.
describe("emphasis characters inside a link URL never reach the href", () => {
  const cases = [
    ["asterisks", "[the doc](https://example.com/a/*b*/c)", "https://example.com/a/*b*/c"],
    ["underscores", "[the doc](https://example.com/a/_b_/c)", "https://example.com/a/_b_/c"],
    ["double tilde", "[the doc](https://example.com/a~~b~~c)", "https://example.com/a~~b~~c"],
  ] as const;
  for (const [name, md, url] of cases) {
    test(`email → ${name} survive verbatim in the href`, () => {
      const out = formatEmailHtml(md);
      expect(out).toContain(`<a href="${url}"`);
      expect(out).toContain(">the doc</a>");
    });
    test(`slack → ${name} survive verbatim in the target`, () =>
      expect(formatSlackMrkdwn(md)).toBe(`<${url}|the doc>`));
  }

  test("email → emphasis in the link LABEL still renders (only the tags are parked)", () => {
    const out = formatEmailHtml("[**bold** and *i*](https://example.com/x)");
    expect(out).toContain('<a href="https://example.com/x"');
    expect(out).toContain("<strong>bold</strong> and <em>i</em>");
  });
});

describe("fenced code block", () => {
  const md = "```ts\nconst x = 1;\n```";
  test("web → pre/code with language class", () =>
    // Web is the ONLY platform that highlights: strip the token spans and the
    // contract is the same one the other three answer to.
    expect(stripTokenSpans(formatWebHtml(md))).toBe(
      '<pre><code class="language-ts">const x = 1;</code></pre>',
    ));
  test("web → and ONLY web colors the body", () => {
    expect(formatWebHtml(md)).toContain('<span class="tok-kw">const</span>');
    expect(formatTelegramHtml(md)).not.toContain("tok-");
    expect(formatSlackMrkdwn(md)).not.toContain("tok-");
  });
  test("telegram → pre/code with language class", () =>
    expect(formatTelegramHtml(md)).toBe('<pre><code class="language-ts">const x = 1;</code></pre>'));
  test("slack → triple-backtick block (no language, no escaping)", () =>
    expect(formatSlackMrkdwn(md)).toBe("```\nconst x = 1;\n```"));
  test("email → styled <pre>, no language class (nothing highlights it)", () => {
    const out = formatEmailHtml(md);
    expect(out.startsWith("<pre style=")).toBe(true);
    expect(out).toContain("<code>const x = 1;</code>");
    expect(out).not.toContain("language-ts");
  });
});

describe("unordered list", () => {
  const md = "- a\n- b";
  test("web → <ul>", () => expect(formatWebHtml(md)).toBe("<ul><li>a</li><li>b</li></ul>"));
  test("telegram → dash lines", () => expect(formatTelegramHtml(md)).toBe("- a\n- b"));
  test("slack → dash lines", () => expect(formatSlackMrkdwn(md)).toBe("- a\n- b"));
  test("email → styled <ul>/<li>", () => {
    const out = formatEmailHtml(md);
    expect(out.startsWith("<ul style=")).toBe(true);
    expect(out).toContain(">a</li>");
    expect(out).toContain(">b</li>");
  });
});

describe("table renders without throwing and matches each platform's shape", () => {
  const md = "| H1 | H2 |\n| --- | --- |\n| a | b |";
  test("web → <table>", () => expect(formatWebHtml(md)).toContain("<table>"));
  test("telegram → pipe table preserved", () => expect(formatTelegramHtml(md)).toContain("| H1 | H2 |"));
  test("slack → labeled bullets", () => expect(formatSlackMrkdwn(md)).toBe("• *H1:* a  *H2:* b"));
  test("email → <table> whose CELLS carry their own borders", () => {
    // A bare <table> renders borderless in most mail clients, and the border
    // cannot come from a stylesheet — so every th/td states it.
    const out = formatEmailHtml(md);
    expect(out).toContain("border-collapse:collapse");
    expect(out).toContain("<th style=");
    expect(out).toContain("<td style=");
    expect((out.match(/border:1px solid/g) ?? []).length).toBe(4);
  });
});

// The italics divergence, in one place. Slack was fixed (a single `*` renders as
// BOLD there, so markdown italics arrived looking like a second bold word) and
// email — new code — was written with the same CommonMark-style flanking rule.
// Telegram and web are PINNED TO TODAY'S OUTPUT with their older, weaker
// `(?<!\w)\*([^*]+?)\*(?!\w)`: it has the `2 * 3` defect below, but unifying the
// rule would change long-standing output on two live platforms as a side effect
// of a share feature. The divergence is documented here rather than hidden.
describe("italics (*i*) — Slack + email use the flanking rule, telegram + web the weaker one", () => {
  describe("a real italic span", () => {
    const md = "this is *italic* text";
    test("web → <em>", () => expect(formatWebHtml(md)).toBe("this is <em>italic</em> text"));
    test("telegram → <i>", () => expect(formatTelegramHtml(md)).toBe("this is <i>italic</i> text"));
    test("slack → _italic_", () => expect(formatSlackMrkdwn(md)).toBe("this is _italic_ text"));
    test("email → <em>", () => expect(formatEmailHtml(md)).toContain("<em>italic</em>"));
  });

  describe("prose arithmetic (2 * 3 and 4 * 5) is NOT emphasis", () => {
    const md = "2 * 3 and 4 * 5";
    test("slack → unchanged (flanking rule)", () => expect(formatSlackMrkdwn(md)).toBe(md));
    test("email → unchanged (flanking rule)", () => expect(formatEmailHtml(md)).toContain(md));
    // Pinned to today's output, NOT to what it should be: see the note above.
    test("web → today's weaker rule emphasizes it (known, deliberate)", () =>
      expect(formatWebHtml(md)).toBe("2 <em> 3 and 4 </em> 5"));
    test("telegram → today's weaker rule emphasizes it (known, deliberate)", () =>
      expect(formatTelegramHtml(md)).toBe("2 <i> 3 and 4 </i> 5"));
  });

  describe("bold and italics on one line keep their own emphasis everywhere", () => {
    const md = "**b** and *i*";
    test("web", () => expect(formatWebHtml(md)).toBe("<strong>b</strong> and <em>i</em>"));
    test("telegram", () => expect(formatTelegramHtml(md)).toBe("<b>b</b> and <i>i</i>"));
    test("slack", () => expect(formatSlackMrkdwn(md)).toBe("*b* and _i_"));
    test("email", () => expect(formatEmailHtml(md)).toContain("<strong>b</strong> and <em>i</em>"));
  });

  // ONE home for the strict rule (`FLANKING_ITALIC_SOURCE` in markdown-core.ts),
  // compiled by both Slack and email — pinned here as behaviour, so a second
  // literal re-introduced in either file trips this block. Every input is an
  // EXECUTED adversarial-review repro of the earlier, looser rule, which paired
  // two unrelated asterisks across non-word characters.
  describe("the strict flanking rule is shared by slack + email", () => {
    // TABLE 1 — must STAY INERT. Every entry is an EXECUTED repro of a looser
    // rule that paired two unrelated asterisks across non-word characters. This
    // is the table any future widening of the rule has to survive; the safe
    // direction is always "leave unchanged".
    const inert = [
      "Files live in /usr/*/bin and /var/*/log",
      "SELECT *, count(*) FROM t",
      "regex ^.*$ and .*?",
      "cp *.md dir/*",
      "see https://ex.com/x/*b*/c",
      "<https://ex.com/x/*b*/c>",
      "2 * 3 and 4 * 5",
      "\\*escaped\\*",
      "src/**/*.ts",

      // ROUND 3, group A — a QUOTED literal asterisk. The opening `*` sits
      // immediately inside a quote, so it is the quoted character, not a
      // delimiter. Round 2 had `"` and `'` among the allowed preceders and paired
      // the two literals into one span on both platforms (measured:
      // `use "_" and "_" as wildcards`, `sep='_' and end='_'`). Removing the two
      // quote preceders is what makes all four inert.
      `use "*" and "*" as wildcards`,
      `SELECT "*" , count("*") FROM t`,
      "sep='*' and end='*'",
      "('*', '*')",

      // ROUND 3, group B — the entity-aware EMAIL edge. Round 2 admitted a bare
      // `&` as a content-opening edge (for `*&quot;quoted phrase&quot;*`), which
      // opened EVERY entity: email rendered `<em>&amp;</em>` here while Slack left
      // the line alone. Only the two quote entities are quote edges now.
      "escape *&* alone",

      // ROUND 3, group C — the `***triple***` rule now carries the SAME flanking
      // guards as the italics rule. Round 2 spelled it as a bare
      // `\*\*\*([^*\n]+)\*\*\*`, which re-opened this entire table three stars
      // wide (measured: `/usr/*_/bin and /var/_*/log`, `x*_mid_*y`, …). Whatever
      // the guarded rule rejects is then parked LITERAL before the unguardable
      // `\*\*(.+?)\*\*` bold pass, which otherwise mangles the rejects just as
      // badly — see the star-run block below.
      "Files live in /usr/***/bin and /var/***/log",
      "see https://ex.com/x/***b***/c",
      "2 *** 3 and 4 *** 5",
      "\\***escaped\\***",
      "cp ***.md dir/***",
      "x***mid***y",
      // The inner `*` of `**a *b***` must not open on a writer-escaped star:
      // without the `(?<!\\)` guard, `boldThenItalic` consumed the `\*` as its
      // italic opener and emitted a stray `\` plus emphasis the writer suppressed.
      "**a \\*b***",
      "**pass the flag as \\*x***",
    ];
    for (const md of inert) {
      test(`slack leaves it alone: ${md}`, () => expect(formatSlackMrkdwn(md)).toBe(md));
      test(`email leaves it alone: ${md}`, () => {
        // `<strong>` joined the assertion in round 3: the triple-star entries
        // above are only inert if the BOLD pass leaves them alone too, and an
        // `<em>`-only check cannot see a `<strong>` mangle.
        const out = formatEmailHtml(md);
        expect(out).not.toContain("<em>");
        expect(out).not.toContain("<strong>");
      });
    }

    // TABLE 2 — must EMPHASIZE. The round-2 widening: the first rule's content
    // edges (`\p{L}\p{N}` at both ends) and follower set were tight enough to
    // reject ordinary prose — a quoted phrase, a parenthetical, any span ending
    // in a comma or a full stop, a language name with a `#`. All measured against
    // TABLE 1 before landing.
    const emphasized: [string, string][] = [
      ['*"quoted phrase"* is what he said', '"quoted phrase"'],
      ["*(parenthetical aside)* follows", "(parenthetical aside)"],
      ["a *word,* then continuation", "word,"],
      ["it is *important.* Next sentence.", "important."],
      ["really *important!* yes", "important!"],
      ["*emphasis*-hyphenated", "emphasis"],
      ["«*økta*» norsk", "økta"],
      ["*C#* and *F#*", "C#"],
      ["see *§4* now", "§4"],
      ["*🚀 launch*", "🚀 launch"],
    ];
    for (const [md, inner] of emphasized) {
      test(`slack emphasizes it: ${md}`, () => expect(formatSlackMrkdwn(md)).toContain(`_${inner}_`));
      test(`email emphasizes it: ${md}`, () => {
        // The email column escapes BEFORE it emphasizes, so a quoted phrase
        // reaches the pattern as `&quot;…&quot;` — which is why the email variant
        // of the rule accepts the quote ENTITIES as content opening edges (round
        // 3; round 2 accepted a bare `&`, which opened every entity). Compare
        // against the escaped form.
        const escaped = inner.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        expect(formatEmailHtml(md)).toContain(`<em>${escaped}</em>`);
      });
    }

    test("and both still emphasize a real span, including a non-ASCII word", () => {
      expect(formatSlackMrkdwn("den *økta* der")).toBe("den _økta_ der");
      expect(formatEmailHtml("den *økta* der")).toContain("<em>økta</em>");
    });

    // The ONE knock-on flip of the widening, pinned as behaviour rather than left
    // as a surprise: `(` had to join the allowed preceders, so a parenthesized
    // emphasis span now emphasizes. It was inert under the first strict rule and
    // is listed here, not in TABLE 1, because this IS what CommonMark does.
    test("a parenthesized span now emphasizes — the deliberate flip", () => {
      expect(formatSlackMrkdwn("a (*b*) in parens")).toBe("a (_b_) in parens");
      expect(formatEmailHtml("a (*b*) in parens")).toContain("(<em>b</em>)");
    });

    // KNOWN MISS, pinned so it stays a known one: raw-HTML-adjacent italics stay
    // literal on both. Email has escaped the tags to `&lt;span&gt;` by the time
    // the pattern runs; Slack's tag-strip runs after it. Equal to origin/main,
    // which had no italics pass here at all.
    test("raw-HTML-adjacent italics stay literal (documented miss)", () => {
      expect(formatSlackMrkdwn("<span>*i*</span>")).toBe("*i*");
      expect(formatEmailHtml("<span>*i*</span>")).not.toContain("<em>");
    });

    // KNOWN MISS (round 3), the price of killing the quoted-literal pairing in
    // TABLE 1 group A: an emphasis span that opens immediately inside a quote is
    // now rejected, so quotes-inside-quotes stays literal. It stays literal on
    // BOTH columns, which is the improvement — under round 2 Slack italicized it
    // and email did not, because only email had escaped its `"` to `&quot;` by the
    // time the pattern ran. A silent divergence traded for a loud, symmetric miss.
    test("quotes inside quotes stay literal on both (documented miss)", () => {
      expect(formatSlackMrkdwn(`he said "*hi*" loudly`)).toBe(`he said "*hi*" loudly`);
      expect(formatEmailHtml(`he said "*hi*" loudly`)).not.toContain("<em>");
    });

    // The RESIDUAL of the entity-aware email edge, pinned rather than chased. `;`
    // is a content-CLOSING edge (it has to be — `*word;*` emphasizes on both), and
    // `;` also ends an entity, so a span whose content ends in an escaped `<`
    // closes on email and not on Slack. Same pre-existing raw-tag-handling class
    // as `<span>*i*</span>` above: email ESCAPES the tag, Slack STRIPS it. Removing
    // `;` from the closing edge would just move the divergence onto `*word;*`.
    test("raw-tag handling (escape vs strip) is the residual divergence, not italics", () => {
      // The opening `<` is rejected on both, so a whole tag never italicizes.
      expect(formatSlackMrkdwn("x *<b>* y")).toBe("x ** y"); // tag-strip leaves `**`
      expect(formatEmailHtml("x *<b>* y")).toContain("*&lt;b&gt;*"); // literal escaped text
      expect(formatEmailHtml("x *<b>* y")).not.toContain("<em>");
      expect(formatSlackMrkdwn("tag *<Callout>* here")).toBe("tag ** here");
      expect(formatEmailHtml("tag *<Callout>* here")).toContain("*&lt;Callout&gt;*");
      expect(formatEmailHtml("tag *<Callout>* here")).not.toContain("<em>");
      // …but a content edge that ends ON the escaped tag still closes on email.
      expect(formatSlackMrkdwn("*x<*")).toBe("*x<*");
      expect(formatEmailHtml("*x<*")).toContain("<em>x&lt;</em>");
      // The `;` that makes that possible is load-bearing for ordinary prose.
      expect(formatSlackMrkdwn("*word;*")).toBe("_word;_");
      expect(formatEmailHtml("*word;*")).toContain("<em>word;</em>");
    });

    test("the rule itself, compiled from the shared source", () => {
      const re = new RegExp(RAW_EMPHASIS_SOURCES.italic, "gu");
      expect("this is *italic* text".replace(re, "_$1_")).toBe("this is _italic_ text");
      for (const md of inert) expect(md.replace(re, "_$1_")).toBe(md);
      for (const [md, inner] of emphasized) expect(md.replace(re, "_$1_")).toContain(`_${inner}_`);
    });

    // The TRIPLE rule is built from the same pieces, so TABLE 1 has to survive it
    // in isolation too — that is the whole content of round 3's third fix.
    test("…and the triple rule, from the same pieces, leaves TABLE 1 alone", () => {
      const re = new RegExp(RAW_EMPHASIS_SOURCES.triple, "gu");
      expect("a ***triple*** span".replace(re, "*_$1_*")).toBe("a *_triple_* span");
      for (const md of inert) expect(md.replace(re, "*_$1_*")).toBe(md);
    });

    // Round 4: the two COMPOSITION rules come from the same pieces, so TABLE 1
    // has to survive each of them in isolation as well. They are the widest
    // patterns in the file — each spans a two-star AND a three-star run — so this
    // is the check that matters most for a future widening.
    test("…and both composition rules leave TABLE 1 alone", () => {
      const bti = new RegExp(RAW_EMPHASIS_SOURCES.boldThenItalic, "gu");
      const itb = new RegExp(RAW_EMPHASIS_SOURCES.italicThenBold, "gu");
      expect("a **bold *ital*** span".replace(bti, "*$1_$2_*")).toBe("a *bold _ital_* span");
      expect("a ***ital* bold** span".replace(itb, "*_$1_$2*")).toBe("a *_ital_ bold* span");
      for (const md of inert) {
        expect(md.replace(bti, "*$1_$2_*")).toBe(md);
        expect(md.replace(itb, "*_$1_$2*")).toBe(md);
      }
    });
  });

  // ── Round 3: a 3+ star run is claimed by the triple rule, or it is LITERAL ──
  // The guarded triple rule can only reject; the `\*\*(.+?)\*\*` bold pass that
  // runs after it has no flanking guards and cannot grow any (it must keep
  // matching `**bold**` anywhere). So every run the triple rule rejects is parked
  // literal in between. Without that park the guards bought nothing: measured on
  // round 3 without it, the triple-star path-glob pair lost two of its six stars
  // and `****four****` came out a six-star run.
  describe("stars are never silently dropped", () => {
    const stars = (s: string) => (s.match(/\*/g) ?? []).length;

    // Star-count arithmetic, stated per case: input stars − stars consumed by a
    // RENDERED emphasis span = stars left in the output.
    const runs: [string, number][] = [
      ["Files live in /usr/***/bin and /var/***/log", 6], // nothing rendered → all 6 survive
      ["see https://ex.com/x/***b***/c", 6],
      ["2 *** 3 and 4 *** 5", 6],
      ["\\***escaped\\***", 6],
      ["cp ***.md dir/***", 6],
      ["x***mid***y", 6],
      ["****four****", 8], // four-star runs: literal by construction
    ];
    for (const [md, expected] of runs) {
      test(`slack keeps every star: ${md}`, () => {
        expect(stars(formatSlackMrkdwn(md))).toBe(expected);
        expect(formatSlackMrkdwn(md)).toBe(md);
      });
      test(`email keeps every star: ${md}`, () => {
        const out = formatEmailHtml(md);
        expect(stars(out)).toBe(expected);
        expect(out).not.toContain("<strong>");
        expect(out).not.toContain("<em>");
      });
    }

    // The real triple spans still render — the guards reject, they do not disable.
    test("a real ***span*** still renders on both", () => {
      expect(formatSlackMrkdwn("***word***")).toBe("*_word_*");
      expect(formatEmailHtml("***word***")).toContain("<strong><em>word</em></strong>");
    });

    test("…including inside a link label, whose parked delimiters are legal flanks", () => {
      expect(formatSlackMrkdwn("[***lab***](https://x.com)")).toBe("<https://x.com|*_lab_*>");
      const out = formatEmailHtml("[***lab***](https://x.com)");
      expect(out).toContain('<a href="https://x.com"');
      expect(out).toContain("<strong><em>lab</em></strong>");
    });

    // KNOWN MISS, narrowed in round 4 to the shapes that genuinely do not compose:
    // the delimiters are ambiguous and CommonMark's answer needs a real inline
    // parser, which neither renderer has. Round 2 rendered a half-span and dropped
    // stars; today's output is fully literal — still not right, but nothing is
    // silently lost, which is the invariant this block defends. (`**x *y***` used
    // to live here and now RENDERS — see the composition block below.)
    for (const md of ["a ***b** c*", "***a* and *b***"]) {
      test(`mixed nesting stays literal (documented miss): ${md}`, () => {
        expect(formatSlackMrkdwn(md)).toBe(md);
        expect(formatEmailHtml(md)).toContain(md);
      });
    }

    // The ARGUED COST of the park, pinned as behaviour. `**bold*** trailing` used
    // to render bold with a stray star (`<strong>bold</strong>*`); its 3-star run
    // is now literal, so the whole line is. Malformed input either way, and the
    // safe direction is the one that does not eat a star the writer typed.
    test("a malformed bold+star run is literal rather than half-rendered", () => {
      expect(formatSlackMrkdwn("**bold*** trailing")).toBe("**bold*** trailing");
      const out = formatEmailHtml("**bold*** trailing");
      expect(out).toContain("**bold*** trailing");
      expect(out).not.toContain("<strong>");
    });

    // …and a plain `**bold**` run is untouched by the park: it is two stars, not
    // three. The park must not become a bold-pass killswitch.
    test("plain bold is unaffected by the star-run park", () => {
      expect(formatSlackMrkdwn("**b** and *i*")).toBe("*b* and _i_");
      expect(formatEmailHtml("**b** and *i*")).toContain("<strong>b</strong> and <em>i</em>");
    });
  });

  // ── Round 4: bold and italic that COMPOSE into one span ────────────────────
  // The defect this block closes, EXECUTED before the fix: `**bold *italic***`
  // ends on a three-star run that IS a delimiter, but the triple rule cannot claim
  // it (the run at the other end is two stars), so `parkLeftoverStarRuns` parked
  // it — and parking a delimiter ORPHANS the `**` that opened the span. The orphan
  // then paired with the next `**` on the line and inverted every bold after it:
  //
  //   `**bold with *italic*** then **second bold** and **third bold** end`
  //     → `<strong>bold with *italic*** then </strong>second bold<strong> and
  //        </strong>third bold** end`
  //
  // — three bolds wrong, a literal `**` leaked, and an adjoining link swallowed
  // into the inverted span. Round 2 and `origin/main` rendered all three bolds
  // correctly, so the park was a REGRESSION on multi-bold lines. The fix matches
  // the composition instead of parking it: two more rules from the same guard
  // pieces (`boldThenItalic`, `italicThenBold`), run BEFORE the triple rule and
  // the park, so only true leftovers ever reach the park.
  describe("bold composed with italic renders, and does not invert the rest of the line", () => {
    test("the cascade: all three bolds render, the inner italic renders, no star leaks", () => {
      const md = "**bold with *italic*** then **second bold** and **third bold** end";
      expect(formatSlackMrkdwn(md)).toBe(
        "*bold with _italic_* then *second bold* and *third bold* end",
      );
      const out = formatEmailHtml(md);
      expect(out).toContain(
        "<strong>bold with <em>italic</em></strong> then <strong>second bold</strong> " +
          "and <strong>third bold</strong> end",
      );
      expect(out).not.toContain("**");
    });

    test("an adjoining link stays intact and OUTSIDE every emphasis span", () => {
      const md = "**bold *ital*** and [link](https://ex.com) and **more**";
      expect(formatSlackMrkdwn(md)).toBe("*bold _ital_* and <https://ex.com|link> and *more*");
      const out = formatEmailHtml(md);
      expect(out).toContain("<strong>bold <em>ital</em></strong> and ");
      expect(out).toContain('<a href="https://ex.com"');
      expect(out).toContain(">link</a> and <strong>more</strong>");
    });

    test("the mirror shape, bold STARTING with italic", () => {
      expect(formatSlackMrkdwn("***italic* then bold**")).toBe("*_italic_ then bold*");
      expect(formatEmailHtml("***italic* then bold**")).toContain(
        "<strong><em>italic</em> then bold</strong>",
      );
    });

    // Real corpus, verbatim. Re-running the round-4 sweep over the two wikis
    // (`grep -rE '\*\*[^*]+\*[^*]+\*\*\*'` across mimir + huginn-jarvis) returns
    // 20+ LLM-written prose lines in this shape; these two are pinned as written.
    // The first carries TWO composed spans plus a plain italic on one line, which
    // is exactly the cascade the old park inverted.
    test("real wiki line: two composed spans and a plain italic on one line", () => {
      const md =
        "**Anthropic treats the model as a *potentially sentient life form*** " +
        "(to be respected); **OpenAI treats it as a *tool*** (designed for utility).";
      expect(formatSlackMrkdwn(md)).toBe(
        "*Anthropic treats the model as a _potentially sentient life form_* " +
          "(to be respected); *OpenAI treats it as a _tool_* (designed for utility).",
      );
      const out = formatEmailHtml(md);
      expect(out).toContain(
        "<strong>Anthropic treats the model as a <em>potentially sentient life form</em></strong>",
      );
      expect(out).toContain("<strong>OpenAI treats it as a <em>tool</em></strong>");
      expect(out).not.toContain("**");
    });

    test("real wiki line: a composed span followed by an em-dash clause", () => {
      const md =
        "- **Opus 4.7 is the first model that *naturally hill-climbs*** — give it a target.";
      expect(formatSlackMrkdwn(md)).toBe(
        "- *Opus 4.7 is the first model that _naturally hill-climbs_* — give it a target.",
      );
      expect(formatEmailHtml(md)).toContain(
        "<strong>Opus 4.7 is the first model that <em>naturally hill-climbs</em></strong> — give it a target.",
      );
    });

    // The composition rules must not become a second way in for TABLE 1. The
    // guards are what makes `***word***` still a plain triple and `****four****`
    // still literal — both patterns reject the moment the flanks or content edges
    // do not hold. (Full TABLE-1 sweep against both rules lives above.)
    test("…and the plain triple is unchanged by the two new rules", () => {
      expect(formatSlackMrkdwn("***word***")).toBe("*_word_*");
      expect(formatEmailHtml("***word***")).toContain("<strong><em>word</em></strong>");
      expect(formatSlackMrkdwn("****four****")).toBe("****four****");
      expect(formatSlackMrkdwn("**bold*** trailing")).toBe("**bold*** trailing");
    });

    // Round 4 minor: the trailing-quote FOLLOWER. `"` is an allowed follower, but
    // email had already escaped it to `&quot;`, whose leading `&` is a rejected
    // one — so the span rendered on Slack and stayed literal on email (70 corpus
    // rows). `&quot;` is now a follower atom in the escaped variant only.
    test("a span closing just before a quote agrees across platforms", () => {
      expect(formatSlackMrkdwn(`he called it ***critical***"`)).toBe(`he called it *_critical_*"`);
      expect(formatEmailHtml(`he called it ***critical***"`)).toContain(
        "<strong><em>critical</em></strong>&quot;",
      );
      expect(formatSlackMrkdwn(`he called it *critical*"`)).toBe(`he called it _critical_"`);
      expect(formatEmailHtml(`he called it *critical*"`)).toContain("<em>critical</em>&quot;");
    });
  });
});

describe("inline Verdict mid-list — chip on web, plain fallback in-sentence elsewhere", () => {
  const md = "- Result: <Verdict value=\"yes\">shipped</Verdict>";
  test("web → inline chip inside the <li>", () =>
    expect(formatWebHtml(md)).toBe('<ul><li>Result: <span class="verdict verdict-yes">shipped</span></li></ul>'));
  test("telegram → ✅ label sits inline in the list line", () =>
    expect(formatTelegramHtml(md)).toBe("- Result: ✅ shipped"));
  test("slack → ✅ label sits inline in the list line", () =>
    expect(formatSlackMrkdwn(md)).toBe("- Result: ✅ shipped"));
  test("email → coloured inline span inside the <li>", () =>
    expect(formatEmailHtml(md)).toContain("<li style=\"margin:0 0 4px;\">Result: <span style=\"color:#1a7f37;font-weight:600;\">✅ shipped</span></li>"));
});

describe("inline Pill mid-sentence — chip on web, [text] fallback elsewhere", () => {
  const md = "Ship it <Pill tone=\"rec\">beta</Pill> today";
  test("web → inline pill span", () =>
    expect(formatWebHtml(md)).toBe('Ship it <span class="pill pill-rec">beta</span> today'));
  test("telegram → [beta] inline", () =>
    expect(formatTelegramHtml(md)).toBe("Ship it [beta] today"));
  test("slack → [beta] inline", () =>
    expect(formatSlackMrkdwn(md)).toBe("Ship it [beta] today"));
  test("email → an inline-styled pill span (no class to hang CSS on)", () => {
    const out = formatEmailHtml(md);
    expect(out).toContain("border-radius:10px");
    expect(out).toContain(">beta</span> today");
    expect(out).not.toContain("class=");
  });
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
  test("email → <code> with the escaped tag, no NUL, no chip", () => {
    const out = formatEmailHtml(md);
    expect(out).toContain("&lt;Verdict value=&quot;yes&quot;&gt;x&lt;/Verdict&gt;</code>");
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
  test("email → underlined passage + glyph, no chip button (nothing to expand in mail)", () => {
    const out = formatEmailHtml(md);
    expect(out).toContain('<span style="border-bottom:2px solid #cf222e;">1.32 kg</span>');
    expect(out).toContain("✗");
    expect(out).not.toContain("<button");
  });
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
  test("email → <strong> and <a> inside the mark, no literal asterisks", () => {
    const out = formatEmailHtml(md);
    expect(out).toContain("<strong>1.32 kg</strong>");
    expect(out).toContain('<a href="https://example.com"');
    expect(out).not.toContain("**1.32 kg**");
  });
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

describe("Fold — a details on the web, an open run-in section everywhere else", () => {
  const md = '<Fold title="What was measured">\n\n## What was measured\n\nThe probe returned 149 lines.\n\n</Fold>';

  /**
   * The same fold with a body heading that DIFFERS from the title — which is what
   * the three run-in surfaces have to be asserted against. On `md` the title and
   * the body's first heading are the same words (the retrofit convention), and
   * every surface renders a bare `##` as bold too, so "the title is rendered as a
   * bold run-in" passed off the BODY: deleting a platform's whole `case "Fold"`
   * left all three cases green. Here the title appears nowhere in the body, so
   * both must be present and in that order.
   */
  const twoHeadings =
    '<Fold title="What was measured">\n\n## Method and probe\n\nThe probe returned 149 lines.\n\n</Fold>';

  test("web → a CLOSED details whose duplicate heading is marked", () => {
    const out = formatWebHtml(md);
    expect(out).toContain('<details class="fold">');
    expect(out).not.toContain("<details open");
    expect(out).toContain("<summary>What was measured</summary>");
    expect(out).toContain('<h3 class="fold-heading-dup">What was measured</h3>');
    expect(out).toContain("The probe returned 149 lines.");
  });

  test('web → open="true" renders it expanded', () =>
    expect(formatWebHtml(md.replace(">", ' open="true">'))).toContain('<details class="fold" open>'));

  test("telegram → bold run-in title ABOVE the body's own heading, no fold", () => {
    const out = formatTelegramHtml(twoHeadings);
    expect(out.startsWith("<b>What was measured</b>")).toBe(true);
    expect(out).toContain("<b>Method and probe</b>");
    expect(out.indexOf("What was measured")).toBeLessThan(out.indexOf("Method and probe"));
    expect(out).toContain("The probe returned 149 lines.");
    expect(out).not.toContain("<details");
  });

  test("slack → bold run-in title ABOVE the body's own heading", () => {
    const out = formatSlackMrkdwn(twoHeadings);
    expect(out.startsWith("*What was measured*")).toBe(true);
    expect(out).toContain("*Method and probe*");
    expect(out.indexOf("What was measured")).toBeLessThan(out.indexOf("Method and probe"));
    expect(out).toContain("The probe returned 149 lines.");
  });

  test("email → styled run-in title ABOVE the body's own heading (no <details> in mail)", () => {
    const out = formatEmailHtml(twoHeadings);
    expect(out).toContain('<div style="font-weight:600;margin:0 0 6px;color:#1f2328;">What was measured</div>');
    expect(out).toContain("Method and probe");
    expect(out.indexOf("What was measured")).toBeLessThan(out.indexOf("Method and probe"));
    expect(out).toContain("The probe returned 149 lines.");
    expect(out).not.toContain("<details");
  });

  test("every platform keeps the body of a title-less fold", () => {
    const plain = "<Fold>\n\nThe probe returned 149 lines.\n\n</Fold>";
    for (const out of [formatWebHtml(plain), formatTelegramHtml(plain), formatSlackMrkdwn(plain), formatEmailHtml(plain)]) {
      expect(out).toContain("The probe returned 149 lines.");
    }
    // Only the web surface has somewhere to put a label for a title-less fold.
    expect(formatWebHtml(plain)).toContain("<summary>Details</summary>");
  });

  test("a title carrying markup is handled on every surface", () => {
    const hostile = '<Fold title="a <b>x">\n\nbody\n\n</Fold>';
    // The three HTML surfaces ESCAPE it.
    for (const out of [formatWebHtml(hostile), formatTelegramHtml(hostile), formatEmailHtml(hostile)]) {
      expect(out).toContain("a &lt;b&gt;x");
      expect(out).not.toContain("<b>x");
    }
    // Slack is mrkdwn, not HTML, so it runs the title through `renderInline` like
    // any other inline text: the tag is CONVERTED AWAY rather than escaped. House
    // style — asserted as it is, not changed. What matters is the same guarantee:
    // no live tag survives into the message.
    const slack = formatSlackMrkdwn(hostile);
    expect(slack.startsWith("*a x*")).toBe(true);
    expect(slack).not.toContain("<b>");
  });
});

describe("Fold summary= — a teaser beside the title on every surface", () => {
  const md =
    '<Fold title="Runder" summary="4 runder · vårt svar: utkast">\n\n## Runder\n\nBody line.\n\n</Fold>';

  test("web → the teaser rides inside <summary>, after the title, and the dup heading still hides", () => {
    const out = formatWebHtml(md);
    expect(out).toContain(
      '<summary>Runder<span class="fold-summary">4 runder · vårt svar: utkast</span></summary>',
    );
    // The suppression compares the TITLE alone, so the summary must not defeat it.
    expect(out).toContain('<h3 class="fold-heading-dup">Runder</h3>');
  });

  test("web → the teaser is escaped as text", () => {
    const out = formatWebHtml('<Fold title="T" summary="a <b>x</b> &amp;">\n\nbody\n\n</Fold>');
    expect(out).toContain('<span class="fold-summary">a &lt;b&gt;x&lt;/b&gt; &amp;amp;</span>');
  });

  test("web → an empty or absent summary renders no teaser span", () => {
    expect(formatWebHtml('<Fold title="T" summary="  ">\n\nbody\n\n</Fold>')).not.toContain("fold-summary");
    expect(formatWebHtml('<Fold title="T">\n\nbody\n\n</Fold>')).not.toContain("fold-summary");
  });

  test("telegram → bold title — teaser", () =>
    expect(formatTelegramHtml(md).startsWith("<b>Runder</b> — 4 runder · vårt svar: utkast\n")).toBe(true));

  test("slack → *title* — teaser", () =>
    expect(formatSlackMrkdwn(md).startsWith("*Runder* — 4 runder · vårt svar: utkast\n")).toBe(true));

  test("email → teaser in the run-in title line, dimmed", () => {
    const out = formatEmailHtml(md);
    expect(out).toContain("Runder — <span");
    expect(out).toContain("4 runder · vårt svar: utkast</span></div>");
  });

  test("a summary with no title still shows on the run-in surfaces", () => {
    const noTitle = '<Fold summary="only a teaser">\n\nbody\n\n</Fold>';
    expect(formatTelegramHtml(noTitle).startsWith("only a teaser\n")).toBe(true);
    expect(formatSlackMrkdwn(noTitle).startsWith("only a teaser\n")).toBe(true);
    expect(formatEmailHtml(noTitle)).toContain("only a teaser</span>");
  });
});

describe("Callout resolved= — a closed issue collapses to one ✓ row", () => {
  const md =
    '<Callout tone="warn" title="Gate-kjøringer mangler feltene" resolved="2026-09-28">\n\nOld warning body.\n\n</Callout>';

  test("web → a good-tone <details> row with ✓ date · title, body behind it", () => {
    const out = formatWebHtml(md);
    expect(out).toContain('<details class="callout callout-good callout-resolved">');
    expect(out).not.toContain("callout-warn");
    expect(out).toContain(
      '<summary class="callout-resolved-row"><span class="callout-resolved-mark">✓</span> ' +
        '<span class="callout-resolved-date">2026-09-28</span> · ' +
        '<span class="callout-resolved-title">Gate-kjøringer mangler feltene</span></summary>',
    );
    expect(out).not.toContain("<details class=\"callout callout-good callout-resolved\" open");
    expect(out).toContain('<div class="callout-body">');
    expect(out).toContain("Old warning body.");
  });

  test("web → no title renders the date alone", () => {
    const out = formatWebHtml('<Callout resolved="2026-09-28">\n\nb\n\n</Callout>');
    expect(out).toContain('<span class="callout-resolved-date">2026-09-28</span></summary>');
  });

  for (const bad of ["2026-9-28", "2026-02-30", "28.09.2026", "2026-13-01", "yes", "", "2026-09-28x"]) {
    test(`web → resolved="${bad}" is ignored and the callout renders open, in its own tone`, () => {
      const out = formatWebHtml(`<Callout tone="warn" title="T" resolved="${bad}">\n\nb\n\n</Callout>`);
      expect(out).toContain('<div class="callout callout-warn">');
      expect(out).not.toContain("callout-resolved");
    });
  }

  test("web → the title is escaped", () =>
    expect(formatWebHtml('<Callout title="a <i>" resolved="2026-09-28">\n\nb\n\n</Callout>')).toContain(
      '<span class="callout-resolved-title">a &lt;i&gt;</span>',
    ));

  test("telegram → ✓ date · bold title, body open", () => {
    const out = formatTelegramHtml(md);
    expect(out.startsWith("✓ 2026-09-28 · <b>Gate-kjøringer mangler feltene</b>\n")).toBe(true);
    expect(out).toContain("Old warning body.");
  });

  test("slack → ✓ date · *title*, body open", () => {
    const out = formatSlackMrkdwn(md);
    expect(out.startsWith("✓ 2026-09-28 · *Gate-kjøringer mangler feltene*\n")).toBe(true);
    expect(out).toContain("Old warning body.");
  });

  test("email → good-tone accent and a ✓ date · title line", () => {
    const out = formatEmailHtml(md);
    expect(out).toContain("✓ 2026-09-28 · Gate-kjøringer mangler feltene</div>");
    expect(out).toContain("Old warning body.");
    const warn = formatEmailHtml(md.replace(' resolved="2026-09-28"', ""));
    // The accent differs from the unresolved warn callout's.
    expect(out.match(/border-left:3px solid (#[0-9a-f]+)/i)![1]).not.toBe(
      warn.match(/border-left:3px solid (#[0-9a-f]+)/i)![1],
    );
  });
});

describe("Historic — dimmed and stamped on the web, a lead line elsewhere", () => {
  const md =
    '<Historic since="melosys-console#270" note="§2 erstattet">\n\n## 2. Foreslått løsning\n\nOld design.\n\n</Historic>';

  test("web → section.historic with a stamp line and the body in historic-body", () => {
    const out = formatWebHtml(md);
    expect(out).toContain(
      '<section class="historic"><div class="historic-stamp"><span class="historic-mark">↻</span> ' +
        '<span class="historic-since">melosys-console#270</span> · <span class="historic-note">§2 erstattet</span></div>' +
        '<div class="historic-body">',
    );
    expect(out).toContain("<h3>2. Foreslått løsning</h3>");
    expect(out).toContain("Old design.");
  });

  test("web → since and note are escaped; both optional", () => {
    const out = formatWebHtml('<Historic since="<x>" note="a&b">\n\nbody\n\n</Historic>');
    expect(out).toContain('<span class="historic-since">&lt;x&gt;</span>');
    expect(out).toContain('<span class="historic-note">a&amp;b</span>');
    expect(formatWebHtml("<Historic>\n\nbody\n\n</Historic>")).toContain(
      '<div class="historic-stamp"><span class="historic-mark">↻</span></div>',
    );
  });

  test("web → a Fold holding a Callout still renders inside a Historic (depth 3)", () => {
    const nested =
      '<Historic since="x">\n\n<Fold title="F">\n\n<Callout tone="warn" title="C">\n\ninner\n\n</Callout>\n\n</Fold>\n\n</Historic>';
    const out = formatWebHtml(nested);
    expect(out).toContain('<section class="historic">');
    expect(out).toContain('<details class="fold">');
    expect(out).toContain('<div class="callout callout-warn">');
    expect(out).not.toContain("&lt;Callout");
  });

  test("telegram → italic (historic: since — note) lead line, body after", () => {
    const out = formatTelegramHtml(md);
    expect(out.startsWith("<i>(historic: melosys-console#270 — §2 erstattet)</i>\n")).toBe(true);
    expect(out).toContain("Old design.");
  });

  test("slack → (historic: since — note) lead line, body after", () => {
    const out = formatSlackMrkdwn(md);
    expect(out.startsWith("(historic: melosys-console#270 — §2 erstattet)\n")).toBe(true);
    expect(out).toContain("Old design.");
  });

  test("email → dim lead line, body after", () => {
    const out = formatEmailHtml(md);
    expect(out).toContain("(historic: melosys-console#270 — §2 erstattet)</div>");
    expect(out.indexOf("(historic:")).toBeLessThan(out.indexOf("Old design."));
  });

  test("no since → (historic)", () =>
    expect(formatSlackMrkdwn("<Historic>\n\nbody\n\n</Historic>").startsWith("(historic)\n")).toBe(true));
});

describe("NextMoves — a lane grid on the web, a label line per lane elsewhere", () => {
  const md = [
    "<NextMoves>",
    "",
    '<Lane kind="you" who="Du">',
    "",
    "1. **Send it.** Blocks Å3.",
    "   - nested",
    "2. Create task",
    "",
    "</Lane>",
    "",
    '<Lane kind="waiting" who="Venter <på> fag" since="2026-09-30">',
    "",
    "- Å1",
    "",
    "</Lane>",
    "",
    '<Lane kind="someday">',
    "",
    "- q",
    "",
    "</Lane>",
    "",
    "</NextMoves>",
  ].join("\n");

  test("web → one lane card per Lane, count from top-level items, date kept for the client", () => {
    const out = formatWebHtml(md);
    expect(out).toContain('<section class="next-moves"><div class="nm-grid nm-cols-3">');
    expect(out).toContain(
      '<div class="nm-lane nm-you" data-kind="you" data-count="2" data-who="Du"><div class="nm-head"><span class="nm-who">Du</span><span class="nm-count">2</span></div>',
    );
    // Nested items render inside their step and do not count.
    expect(out).toContain("<ol><li><strong>Send it.</strong> Blocks Å3.<ul><li>nested</li></ul></li><li>Create task</li></ol>");
    expect(out).toContain(
      'data-kind="waiting" data-count="1" data-since="2026-09-30" data-who="Venter &lt;på&gt; fag"><div class="nm-head"><span class="nm-who">Venter &lt;på&gt; fag</span>',
    );
    expect(out).toContain('<span class="nm-since" data-since="2026-09-30">2026-09-30</span>');
    // Unknown kind ⇒ waiting plus a marker class, default English label.
    expect(out).toContain('class="nm-lane nm-waiting nm-kind-unknown" data-kind="waiting" data-count="1"');
    expect(out).toContain('<span class="nm-who">Waiting</span>');
    expect(out).not.toContain("&lt;Lane");
  });

  test("web → a bad since renders as written, with no date for the client to age", () => {
    const out = formatWebHtml('<NextMoves>\n\n<Lane kind="draft" since="2026-02-31 <b>">\n\n- x\n\n</Lane>\n\n</NextMoves>');
    expect(out).not.toContain("data-since");
    expect(out).toContain('<span class="nm-who">Draft, not sent</span>');
    expect(out).toContain('<span class="nm-since nm-since-raw">2026-02-31 &lt;b&gt;</span>');
  });

  test("web → since in the house DD.MM.YYYY is normalised to ISO", () => {
    const out = formatWebHtml('<NextMoves>\n\n<Lane kind="waiting" since="30.09.2026">\n\n- x\n\n</Lane>\n\n</NextMoves>');
    expect(out).toContain('data-since="2026-09-30"');
    expect(out).toContain('<span class="nm-since" data-since="2026-09-30">2026-09-30</span>');
  });

  test("web → [x]/[ ] items render with the checklist marks; only the open ones count", () => {
    const out = formatWebHtml(
      '<NextMoves>\n\n<Lane kind="you">\n\n- [x] Sent the draft\n- [ ] Open the task\n- plain step\n\n</Lane>\n\n</NextMoves>',
    );
    expect(out).toContain('data-kind="you" data-count="2"');
    expect(out).toContain('<li class="check-item check-done"><span class="check-mark">✓</span> <span class="check-text">Sent the draft</span></li>');
    expect(out).toContain('<li class="check-item check-todo"><span class="check-mark">✗</span> <span class="check-text">Open the task</span></li>');
    expect(out).toContain('<li class="check-plain">plain step</li>');
    expect(out).not.toContain("[x]");
    expect(out).not.toContain("[ ]");
  });

  test("web → a lane of prose alone counts 0 and still renders", () => {
    const out = formatWebHtml('<NextMoves>\n\n<Lane kind="you" who="Du">\n\nIngenting å gjøre nå.\n\n</Lane>\n\n</NextMoves>');
    expect(out).toContain('data-kind="you" data-count="0"');
    expect(out).toContain("Ingenting å gjøre nå.");
  });

  test("web → four lanes: three cards in a row and the blocked lane as a strip below", () => {
    const four = md.replace("</NextMoves>", '<Lane kind="blocked" who="Blokkert">\n\n- b\n\n</Lane>\n\n<Lane kind="draft">\n\n- d\n\n</Lane>\n\n</NextMoves>');
    const out = formatWebHtml(four);
    // four cards (you, waiting, someday→waiting, draft) ⇒ 2×2
    expect(out).toContain('<div class="nm-grid nm-cols-2">');
    expect(out).toContain('<div class="nm-strips"><div class="nm-lane nm-blocked"');
    expect(out.indexOf("nm-blocked")).toBeGreaterThan(out.indexOf("nm-draft"));
  });

  test("web → no lanes ⇒ the body plain; a stray Lane ⇒ a label paragraph, no card", () => {
    expect(formatWebHtml("<NextMoves>\n\n- a\n\n</NextMoves>")).not.toContain("next-moves");
    const stray = formatWebHtml('<Lane kind="you" since="2026-09-30">\n\n- a\n\n</Lane>');
    expect(stray).toContain("<p><strong>You — since 2026-09-30</strong></p>");
    expect(stray).not.toContain("nm-lane");
  });

  test("web → Fold > NextMoves > Lane renders (depth 3)", () => {
    const out = formatWebHtml(`<Fold title="F">\n\n${md}\n\n</Fold>`);
    expect(out).toContain('<details class="fold">');
    expect(out).toContain('class="nm-lane nm-you"');
  });

  test("web → Fold > Historic > NextMoves > Lane > Checklist renders every level", () => {
    const lane =
      '<NextMoves>\n\n<Lane kind="you">\n\n<Checklist>\n- [ ] Open step\n- [x] Done step\n</Checklist>\n\n</Lane>\n\n</NextMoves>';
    const out = formatWebHtml(`<Fold title="F">\n\n<Historic since="x">\n\n${lane}\n\n</Historic>\n\n</Fold>`);
    expect(out).toContain('<section class="historic">');
    expect(out).toContain('class="nm-lane nm-you" data-kind="you" data-count="1"');
    expect(out).toContain('<ul class="checklist">');
    expect(out).not.toContain("&lt;Lane");
    expect(out).not.toContain("&lt;Checklist");
  });

  test("web → Fold > NextMoves > Lane > Callout, and Pill inside a lane, render", () => {
    const out = formatWebHtml(
      '<Fold title="F">\n\n<NextMoves>\n\n<Lane kind="waiting">\n\n<Callout tone="warn" title="T">\nInside.\n</Callout>\n\n- step <Pill tone="warn">haster</Pill>\n\n</Lane>\n\n</NextMoves>\n\n</Fold>',
    );
    expect(out).toContain('<div class="callout callout-warn"><strong class="callout-title">T</strong>');
    expect(out).toContain('<span class="pill pill-warn">haster</span>');
    expect(out).not.toContain("&lt;Callout");
  });

  test("a NextMoves inside a NextMoves is not a block, at any depth: its tags are text, its lanes stray", () => {
    const inner = '<NextMoves>\n\n<Lane kind="you">\n\n- deep\n\n</Lane>\n\n</NextMoves>';
    for (const wrap of [(x: string) => x, (x: string) => `<Callout>\n\n${x}\n\n</Callout>`]) {
      const out = formatWebHtml(
        `<Fold title="F">\n\n<NextMoves>\n\n<Lane kind="you">\n\n${wrap(inner)}\n\n</Lane>\n\n</NextMoves>\n\n</Fold>`,
      );
      expect(out.match(/class="next-moves"/g)?.length).toBe(1);
      expect(out.match(/class="nm-lane /g)?.length).toBe(1);
      expect(out).toContain("&lt;NextMoves&gt;");
      expect(out).toContain("<p><strong>You</strong></p>");
    }
  });

  const oddSince = '<NextMoves>\n\n<Lane kind="waiting" who="Du" since="<b>x & y">\n\n- a\n\n</Lane>\n\n</NextMoves>';

  test("telegram → a free-text since is escaped", () => {
    expect(formatTelegramHtml(oddSince)).toContain("<b>Du</b> — since &lt;b&gt;x &amp; y\n");
  });

  test("web → a stray Lane's free-text since is escaped", () => {
    expect(formatWebHtml('<Lane kind="you" since="<b>x & y">\n\n- a\n\n</Lane>')).toContain(
      "<p><strong>You — since &lt;b&gt;x &amp; y</strong></p>",
    );
  });

  test("slack → a free-text since is literal", () => {
    expect(formatSlackMrkdwn(oddSince).split("\n")[0]).toBe("*Du* — since &lt;b&gt;x &amp; y");
  });

  test("web → a lane inside Historic or a resolved Callout still renders", () => {
    const lane = '<NextMoves>\n\n<Lane kind="you">\n\n- old step\n\n</Lane>\n\n</NextMoves>';
    expect(formatWebHtml(`<Historic>\n\n${lane}\n\n</Historic>`)).toContain('class="nm-lane nm-you"');
    expect(formatWebHtml(`<Callout resolved="2026-09-01">\n\n${lane}\n\n</Callout>`)).toContain('class="nm-lane nm-you"');
  });

  test("slack → the lane label is literal text: no mention, no broken bold", () => {
    const out = formatSlackMrkdwn('<NextMoves>\n\n<Lane kind="you" who="<!channel> Rune & <Co> *and* _x_ ~y~ `z`">\n\n- a\n\n</Lane>\n\n</NextMoves>');
    const head = out.split("\n")[0]!;
    expect(head).toBe("*&lt;!channel&gt; Rune &amp; &lt;Co&gt; \u2217and\u2217 \uFF3Fx\uFF3F \u223Cy\u223C \u02CBz\u02CB*");
    expect(head).not.toMatch(/[~`]/);
    // Exactly the two bold delimiters the label line adds.
    expect(head.match(/\*/g)?.length).toBe(2);
  });

  test("telegram → bold label line (+ since) over the items", () => {
    const out = formatTelegramHtml(md);
    expect(out).toContain("<b>Du</b>\n");
    expect(out).toContain("<b>Venter &lt;på&gt; fag</b> — since 2026-09-30\n");
    expect(out).toContain("<b>Waiting</b>\n");
    expect(out.indexOf("<b>Du</b>")).toBeLessThan(out.indexOf("Send it."));
  });

  test("slack → bold label line (+ since) over the items", () => {
    const out = formatSlackMrkdwn(md);
    expect(out.startsWith("*Du*\n")).toBe(true);
    expect(out).toContain("— since 2026-09-30\n");
    expect(out).toContain("*Waiting*\n");
  });

  test("email → bold label line (+ since) over the items", () => {
    const out = formatEmailHtml(md);
    expect(out).toContain(">Du</div>");
    expect(out).toContain(">Venter &lt;på&gt; fag — since 2026-09-30</div>");
    expect(out.indexOf(">Du</div>")).toBeLessThan(out.indexOf("Send it."));
  });
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
  test("email → summary line then the evidence, OPEN (no <details> in mail)", () => {
    const out = formatEmailHtml(md);
    expect(out).toContain("Fact-checked <strong>2026-07-29</strong>");
    expect(out).toContain("3 confirmed");
    expect(out).toContain("Evidence line.");
    expect(out).not.toContain("<details");
  });
  test("email → an absent count is omitted, never rendered as a 0 nobody wrote", () => {
    const out = formatEmailHtml('<FactCheck date="2026-07-29" ok="5">\nbody\n</FactCheck>');
    expect(out).toContain("5 confirmed");
    expect(out).not.toContain("0 corrected");
    expect(out).not.toContain("not checked");
  });
});

describe("the unknown= count is the only trace a deadline-truncated run leaves", () => {
  // ❓ claims get NO `<Fact>` mark and NO appendix section, so without this count a
  // half-finished check renders as a clean ✓/⚠/✗ page. It reads "not checked", not
  // "unverified" — the latter sounds like a judgement the checker made.
  const md = '<FactCheck date="2026-07-29" ok="5" unknown="3">\n### ✅ Claim 1/8 — x\n\nEvidence.\n</FactCheck>';
  test("web → a count span, LAST, after the real verdicts", () => {
    const out = formatWebHtml(md);
    expect(out).toContain('<span class="fc-count fc-count-unknown">? 3 not checked</span>');
    expect(out.indexOf("5 confirmed")).toBeLessThan(out.indexOf("3 not checked"));
  });
  test("telegram + slack → the same wording in the plain-text summary", () => {
    for (const out of [formatTelegramHtml(md), formatSlackMrkdwn(md)]) {
      expect(out.split("\n")[0]).toBe("Fact-checked 2026-07-29: 5 confirmed, 3 not checked");
    }
  });
  test("an absent unknown= is still silence, not `0 not checked`", () => {
    const out = formatWebHtml('<FactCheck date="2026-07-29" ok="5">\nbody\n</FactCheck>');
    expect(out).not.toContain("not checked");
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

const NUL = String.fromCharCode(0);

// An indented fence — the "code block inside a numbered list" shape — used to
// leave an anchored placeholder on a line that also held the indent, so all FOUR
// formatters dropped the block and served a raw U+0000. The fix is in the shared
// AST, so all four move together; this is the column that proves it.
describe("indented fenced code block (inside a list)", () => {
  const md = "1. Step\n\n   ```ts\n   const x = 1;\n   ```";
  test("no platform serves a U+0000", () => {
    for (const out of [
      formatWebHtml(md),
      formatTelegramHtml(md),
      formatSlackMrkdwn(md),
      formatEmailHtml(md),
    ]) {
      expect(out.includes(NUL)).toBe(false);
    }
  });
  test("web → pre/code with language class", () =>
    expect(stripTokenSpans(formatWebHtml(md))).toContain(
      '<pre><code class="language-ts">const x = 1;</code></pre>',
    ));
  test("telegram → pre/code with language class", () =>
    expect(formatTelegramHtml(md)).toContain(
      '<pre><code class="language-ts">const x = 1;</code></pre>',
    ));
  test("slack → triple-backtick block", () =>
    expect(formatSlackMrkdwn(md)).toContain("```\nconst x = 1;\n```"));
  test("email → styled <pre>", () => {
    const out = formatEmailHtml(md);
    expect(out).toContain("<pre style=");
    expect(out).toContain("<code>const x = 1;</code>");
  });
});

// `telegram-format.ts` interpolates `block.lang` into `class="language-${lang}"`
// with NO escaping — the one place a fence's info string reaches an HTML
// attribute raw, and the reason `FENCE_LANG_RE` is a narrow charset rather than
// "the info string's first word". COMPUTED here from hostile info strings, not
// asserted in a comment. This one is a mutation-checked guard, not a red→green
// test: before the line walker such an info string opened no fence at all, so
// there was no attribute to break.
describe("a fence's info string can never break an HTML attribute", () => {
  const hostile = [
    '```ts" onload="alert(1)',
    "```ts' onload='alert(1)",
    "```ts><script>alert(1)</script>",
    "```ts&amp;",
    "```ts x=1",
  ];
  test.each(hostile)("%j yields a well-formed telegram class", (opener) => {
    const out = formatTelegramHtml(`${opener}\nbody\n\`\`\``);
    // The hostile text may legitimately appear as escaped TEXT; what it may
    // never do is appear inside a tag, so the property is read off the tags.
    for (const tag of out.match(/<[^>]*>/g) ?? []) {
      expect(tag).not.toContain("onload");
      const cls = tag.match(/^<code class="([^"]*)">$/);
      if (cls) expect(cls[1]!).toMatch(/^language-[A-Za-z0-9_+#.-]*$/);
    }
    expect(out).not.toContain("<script");
  });
});

describe("report blocks — fix round 1 (title trimming, shared lead text, dates)", () => {
  test("email Fold → a whitespace-only title leaves no dangling dash before the summary", () => {
    const out = formatEmailHtml('<Fold title="   " summary="teaser">\n\nbody\n\n</Fold>');
    expect(out).not.toContain(" — ");
    expect(out).toContain(">teaser</span></div>");
  });

  test("resolvedLeadText trims the title and drops the separator when it is empty", () => {
    const lead = ast.resolvedLeadText;
    expect(typeof lead).toBe("function");
    expect(lead!("2026-09-28", "  T  ")).toBe("✓ 2026-09-28 · T");
    expect(lead!("2026-09-28", "   ")).toBe("✓ 2026-09-28");
    expect(lead!("2026-09-28", undefined)).toBe("✓ 2026-09-28");
    expect(lead!("2026-09-28", " T ", (t) => `*${t}*`)).toBe("✓ 2026-09-28 · *T*");
  });

  test("an unresolved callout's title is trimmed on all four surfaces", () => {
    const md = '<Callout tone="warn" title="  T  ">\n\nb\n\n</Callout>';
    expect(formatWebHtml(md)).toContain('<strong class="callout-title">T</strong>');
    expect(formatTelegramHtml(md).startsWith("<b>T</b>\n")).toBe(true);
    expect(formatSlackMrkdwn(md).startsWith("*T*\n")).toBe(true);
    expect(formatEmailHtml(md)).toContain(">T</div>");
    const blank = '<Callout tone="warn" title="   ">\n\nb\n\n</Callout>';
    expect(formatWebHtml(blank)).not.toContain("callout-title");
    expect(formatTelegramHtml(blank).startsWith("<b>")).toBe(false);
    expect(formatSlackMrkdwn(blank).startsWith("*")).toBe(false);
    expect(formatEmailHtml(blank)).not.toContain("font-weight:600");
  });

  test("a resolved callout's lead line trims a padded title and drops the separator for a blank one", () => {
    const padded = '<Callout title="  T  " resolved="2026-09-28">\n\nb\n\n</Callout>';
    const blank = '<Callout title="   " resolved="2026-09-28">\n\nb\n\n</Callout>';
    expect(formatTelegramHtml(padded).startsWith("✓ 2026-09-28 · <b>T</b>\n")).toBe(true);
    expect(formatTelegramHtml(blank).startsWith("✓ 2026-09-28\n")).toBe(true);
    expect(formatSlackMrkdwn(padded).startsWith("✓ 2026-09-28 · *T*\n")).toBe(true);
    expect(formatSlackMrkdwn(blank).startsWith("✓ 2026-09-28\n")).toBe(true);
    expect(formatEmailHtml(padded)).toContain(">✓ 2026-09-28 · T</div>");
    expect(formatEmailHtml(blank)).toContain(">✓ 2026-09-28</div>");
  });

  test("resolved= accepts a year below 100 (no 19xx rollover)", () =>
    expect(ast.parseResolvedDate("0099-01-01")).toBe("0099-01-01"));
});

// ── Nested lists ─────────────────────────────────────────────────────────────
// An item line indented to its parent item's child column is a CHILD list:
// nested <ul>/<ol> inside the parent <li> on web and email, two spaces per level
// with a `◦` bullet (numbers kept) on Telegram and Slack. Before this, the
// indented lines leaked as literal "  - b" text and split the parent list in two.

/** Email HTML with every inline style removed, so a test can compare structure.
 *  (`<p>` goes too: email wraps a paragraph where the web leaves bare text.) */
const unstyled = (html: string) => html.replace(/ style="[^"]*"/g, "").replace(/<\/?p>/g, "");

/** One shape through all four formatters. `text` is Telegram and Slack (the
 *  inputs carry no inline markup, so the two agree); `email` defaults to the web
 *  structure. */
interface ListCase {
  name: string;
  md: string;
  web: string;
  text: string;
  email?: string;
}

function listCases(title: string, cases: ListCase[]) {
  describe(title, () => {
    for (const c of cases) {
      describe(c.name, () => {
        test("web", () => expect(formatWebHtml(c.md)).toBe(c.web));
        test("telegram", () => expect(formatTelegramHtml(c.md)).toBe(c.text));
        test("slack", () => expect(formatSlackMrkdwn(c.md)).toBe(c.text));
        test("email: the web structure, every list and item carrying an inline style", () => {
          const out = formatEmailHtml(c.md);
          expect(unstyled(out)).toBe(c.email ?? c.web);
          for (const tag of out.match(/<(?:ul|ol|li)\b[^>]*>/g) ?? []) expect(tag).toContain(' style="');
        });
      });
    }
  });
}

listCases("nested lists", [
  {
    name: "ul in ul, with a sibling after the child list",
    md: "- a\n  - b\n  - c\n- d",
    web: "<ul><li>a<ul><li>b</li><li>c</li></ul></li><li>d</li></ul>",
    text: "- a\n  ◦ b\n  ◦ c\n- d",
  },
  {
    name: "ol in ul",
    md: "- a\n  1. x\n  2. y\n- b",
    web: "<ul><li>a<ol><li>x</li><li>y</li></ol></li><li>b</li></ul>",
    text: "- a\n  1. x\n  2. y\n- b",
  },
  {
    name: "ul in ol, at the ordered item's content column",
    md: "1. one\n   - sub\n2. two",
    web: "<ol><li>one<ul><li>sub</li></ul></li><li>two</li></ol>",
    text: "1. one\n  ◦ sub\n2. two",
  },
  {
    name: "three levels",
    md: "- a\n  - b\n    - c\n- d",
    web: "<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>",
    text: "- a\n  ◦ b\n    ◦ c\n- d",
  },
  {
    name: "a sibling after a deeper child returns to its own level",
    md: "- a\n  - b\n    - c\n  - d\n- e",
    web: "<ul><li>a<ul><li>b<ul><li>c</li></ul></li><li>d</li></ul></li><li>e</li></ul>",
    text: "- a\n  ◦ b\n    ◦ c\n  ◦ d\n- e",
  },
  {
    name: "depth cap: a fifth level joins the fourth list",
    md: "- 1\n  - 2\n    - 3\n      - 4\n        - 5",
    web: "<ul><li>1<ul><li>2<ul><li>3<ul><li>4</li><li>5</li></ul></li></ul></li></ul></li></ul>",
    text: "- 1\n  ◦ 2\n    ◦ 3\n      ◦ 4\n      ◦ 5",
  },
]);

// Review round 1 (R1): a blank line inside a list no longer ends it when the
// next line continues it, and an indented line that does not nest keeps its
// source indentation as text on Telegram/Slack.
listCases("loose lists and indentation that does not nest", [
  {
    name: "blank lines between an item and its children, and between items: one list",
    md: "1. Step one\n\n   - a\n   - b\n\n2. Step two\n\n   - c",
    web: "<ol><li>Step one<ul><li>a</li><li>b</li></ul></li><li>Step two<ul><li>c</li></ul></li></ol>",
    text: "1. Step one\n  ◦ a\n  ◦ b\n\n2. Step two\n  ◦ c",
  },
  {
    name: "a blank line between two items keeps one list, and a blank line on the text platforms",
    md: "- a\n\n- b",
    web: "<ul><li>a</li><li>b</li></ul>",
    text: "- a\n\n- b",
  },
  {
    name: "a 2-space bullet under `1.` does not nest and keeps its indent as text",
    md: "1. a\n  - b\n2. c",
    web: '<ol><li>a</li></ol>\n  - b\n<ol start="2"><li>c</li></ol>',
    text: "1. a\n  - b\n2. c",
  },
  {
    name: "a 3-space bullet under `10.` does not nest and keeps its indent as text",
    md: "10. a\n   - b\n11. c",
    web: '<ol start="10"><li>a</li></ol>\n   - b\n<ol start="11"><li>c</li></ol>',
    text: "10. a\n   - b\n11. c",
  },
]);

// R2: continuation lines, the paragraph-interruption rule, `+`, and an
// indented list under a line of text.
listCases("continuation lines and what may open a list", [
  {
    name: "an indented line under an item continues it, and a child after it nests",
    md: "- item\n  more\n  - child\n- next",
    web: "<ul><li>item\nmore<ul><li>child</li></ul></li><li>next</li></ul>",
    text: "- item\n  more\n  ◦ child\n- next",
    email: "<ul><li>item<br>more<ul><li>child</li></ul></li><li>next</li></ul>",
  },
  {
    name: "a wrapped `2024.` line under an item is its text, not a list starting at 2024",
    md: "- Set A overlapper\n  2024. Superset.\n- Set B",
    web: "<ul><li>Set A overlapper\n2024. Superset.</li><li>Set B</li></ul>",
    text: "- Set A overlapper\n  2024. Superset.\n- Set B",
    email: "<ul><li>Set A overlapper<br>2024. Superset.</li><li>Set B</li></ul>",
  },
  {
    name: "a wrapped `+` line under an item is its text; a `*` after it still nests",
    md: "* a\n  + b\n  * c",
    web: "<ul><li>a\n+ b<ul><li>c</li></ul></li></ul>",
    text: "- a\n  + b\n  ◦ c",
    email: "<ul><li>a<br>+ b<ul><li>c</li></ul></li></ul>",
  },
  {
    name: "`+` opens a child list after a blank line, and its siblings join it",
    md: "- a\n\n  + b\n  + c",
    web: "<ul><li>a<ul><li>b</li><li>c</li></ul></li></ul>",
    text: "- a\n  ◦ b\n  ◦ c",
  },
  {
    name: "a nested ordered list opens under item text only at 1; after a blank line it keeps its start",
    md: "3. three\n   5. five\n\n   5. five\n   6. six\n4. four",
    web: '<ol start="3"><li>three\n5. five<ol start="5"><li>five</li><li>six</li></ol></li><li>four</li></ol>',
    text: "3. three\n   5. five\n  5. five\n  6. six\n\n4. four",
    email: '<ol start="3"><li>three<br>5. five<ol start="5"><li>five</li><li>six</li></ol></li><li>four</li></ol>',
  },
]);

describe("an indented list under a line of prose stays text", () => {
  const same = (md: string) => {
    expect(formatWebHtml(md)).toBe(md);
    expect(formatTelegramHtml(md)).toBe(md);
    expect(formatSlackMrkdwn(md)).toBe(md);
  };
  test("unfenced YAML", () => same("config:\n  - name: foo\n    value: bar\n  - name: baz"));
  test("an indented `2024.` under prose", () => same("Price rose in\n   2024. That was big."));
});


// R3: Checklist children.
describe("a Checklist with nested rows", () => {
  const md = "<Checklist>\n- [ ] a\n  - [x] b\n  - plain\n  1. first\n  2. second\n- [x] c\n</Checklist>";

  test("web: a done child under a todo parent, a plain child, and a numbered sublist", () =>
    expect(formatWebHtml(md)).toBe(
      '<ul class="checklist">' +
        '<li class="check-item check-todo check-parent"><span class="check-mark">✗</span> <span class="check-text">a</span>' +
        '<ul class="checklist"><li class="check-item check-done"><span class="check-mark">✓</span> <span class="check-text">b</span></li>' +
        '<li class="check-plain">plain</li></ul>' +
        '<ol class="checklist check-ol"><li class="check-plain" value="1">first</li><li class="check-plain" value="2">second</li></ol></li>' +
        '<li class="check-item check-done"><span class="check-mark">✓</span> <span class="check-text">c</span></li>' +
        "</ul>",
    ));
  test("telegram and slack: a plain child is a bullet, numbers are kept", () => {
    const text = "☐ a\n  ☑ b\n  ◦ plain\n  1. first\n  2. second\n☑ c";
    expect(formatTelegramHtml(md)).toBe(text);
    expect(formatSlackMrkdwn(md)).toBe(text);
  });
  test("email: the plain child has no box, the numbered sublist is an <ol>", () => {
    const email = unstyled(formatEmailHtml(md));
    expect(email).toContain("<li>plain</li>");
    expect(email).toContain("<ol><li>first</li><li>second</li></ol>");
  });
  test("a continuation line keeps the row's task mark", () =>
    expect(formatTelegramHtml("<Checklist>\n- [x] done\n  more\n</Checklist>")).toBe("☑ done\n  more"));
});

// R4: the other marker kind at the same child depth is a second sublist.
listCases("mixed marker kinds under one item", [
  {
    name: "bullets then numbers",
    md: "- a\n  - b\n  1. c\n  2. d",
    web: "<ul><li>a<ul><li>b</li></ul><ol><li>c</li><li>d</li></ol></li></ul>",
    text: "- a\n  ◦ b\n  1. c\n  2. d",
  },
  {
    name: "numbers then a bullet",
    md: "1. a\n   1. b\n   - c",
    web: "<ol><li>a<ol><li>b</li></ol><ul><li>c</li></ul></li></ol>",
    text: "1. a\n  1. b\n  ◦ c",
  },
]);

// R5: tabs, wide marker gaps, `0.` and over-long numbers.
listCases("marker and indent parity with CommonMark", [
  {
    name: "a tab-indented item nests",
    md: "- a\n\t- b",
    web: "<ul><li>a<ul><li>b</li></ul></li></ul>",
    text: "- a\n  ◦ b",
  },
  {
    name: "a tab after `1.` puts the content column at 4, so a 3-space bullet does not nest",
    md: "1.\tx\n   - y",
    web: "<ol><li>x</li></ol>\n   - y",
    text: "1. x\n   - y",
  },
  {
    name: "5+ spaces after the marker: the content column is one past it",
    md: "1.      a\n   - b",
    web: "<ol><li>a<ul><li>b</li></ul></li></ol>",
    text: "1. a\n  ◦ b",
  },
  {
    name: "a list starting at 0 keeps its 0",
    md: "0. zero\n1. one",
    web: '<ol start="0"><li>zero</li><li>one</li></ol>',
    text: "0. zero\n1. one",
  },
]);

test("a number over 9 digits is not a list marker", () => {
  expect(formatWebHtml("1234567890. big")).toBe("1234567890. big");
  expect(formatTelegramHtml("1234567890. big")).toBe("1234567890. big");
});

describe("marker-spelled thematic breaks are not items", () => {
  test("an indented `* * *` under an item ends the list and is a rule", () =>
    expect(formatWebHtml("- a\n  * * *\n- b")).toBe("<ul><li>a</li></ul>\n<hr>\n<ul><li>b</li></ul>"));
  test("a column-0 `- - -` is a rule, not an item", () => expect(formatWebHtml("- - -")).toBe("<hr>"));
});

// Items keep their source number where the list used to split and restart.
listCases("ordered items that do not directly follow their previous item", [
  {
    name: "after a continuation line an item keeps its source number",
    md: "1. a\n   more\n3. c\n4. d",
    web: '<ol><li>a\nmore</li><li value="3">c</li><li>d</li></ol>',
    text: "1. a\n   more\n3. c\n4. d",
    email: '<ol><li>a<br>more</li><li value="3">c</li><li>d</li></ol>',
  },
  {
    name: "directly consecutive items still count on",
    md: "1. a\n1. b",
    web: "<ol><li>a</li><li>b</li></ol>",
    text: "1. a\n2. b",
  },
]);

// R6: fenced code inside an item.
describe("a fence inside a list item", () => {
  test("an item's fence and the child list after it stay inside the item; the list does not split", () => {
    const md = "1. Install\n   ```\n   npm i\n   ```\n   - note\n2. Run";
    expect(formatWebHtml(md)).toBe(
      "<ol><li>Install<pre><code>npm i</code></pre><ul><li>note</li></ul></li><li>Run</li></ol>",
    );
    expect(formatTelegramHtml(md)).toBe("1. Install\n<pre><code>npm i</code></pre>\n  ◦ note\n2. Run");
    expect(formatSlackMrkdwn(md)).toBe("1. Install\n```\nnpm i\n```\n  ◦ note\n2. Run");
  });

  test("a deeper item after the fence nests instead of leaking as text", () => {
    const md = "- a\n  - b\n  ```\n  x\n  ```\n    - d\n- e";
    expect(formatWebHtml(md)).toBe(
      "<ul><li>a<ul><li>b</li></ul><pre><code>x</code></pre><ul><li>d</li></ul></li><li>e</li></ul>",
    );
    expect(formatTelegramHtml(md)).toBe("- a\n  ◦ b\n<pre><code>x</code></pre>\n  ◦ d\n- e");
  });
});

// R7: Slack empty items.
describe("slack: empty items", () => {
  test("an empty child is blanked the way an empty top-level item is", () => {
    expect(formatSlackMrkdwn("- a\n- \n- c")).toBe("- a\n\n- c");
    expect(formatSlackMrkdwn("- a\n  - \n  - c")).toBe("- a\n\n  ◦ c");
  });
  test("an empty first parent does not take its child's indent with it", () =>
    expect(formatSlackMrkdwn("- \n  - child\n- b")).toBe("  ◦ child\n- b"));
});

test("inline formatting runs inside nested items", () => {
  expect(formatWebHtml("- a\n  - **b** `c`")).toBe(
    "<ul><li>a<ul><li><strong>b</strong> <code>c</code></li></ul></li></ul>",
  );
});

describe("unchanged: shapes that are not nested lists", () => {
  test("a dash inside prose is not a list", () =>
    expect(formatWebHtml("range 1 - 5\nfoo -bar")).toBe("range 1 - 5\nfoo -bar"));
  test("a top-level `+` line stays text", () => expect(formatWebHtml("+ plus")).toBe("+ plus"));
  test("4-space indented text with no list above stays a paragraph", () =>
    expect(formatWebHtml("para\n    - deep")).toBe("para\n    - deep"));
  test("an unindented line under an item still ends the list", () =>
    expect(formatWebHtml("- a\nmore")).toBe("<ul><li>a</li></ul>\nmore"));
  test("`***` stays text", () => expect(formatWebHtml("***")).toBe("***"));
  test("an indented table under an item is still a table", () =>
    expect(formatWebHtml("- a\n  | x | y |\n  |---|---|\n  | 1 | 2 |")).toContain("<table>"));
  test("a paragraph after a blank line, indented less than the item's content, still ends the list", () =>
    expect(formatWebHtml("- a\n\n para\n- b")).toBe("<ul><li>a</li></ul>\n para\n<ul><li>b</li></ul>"));
});

// Fix round 2 (D1a): after a blank line or a fence in an item, a non-item line
// indented to the item's content column is a further paragraph of THAT item,
// and the list goes on after it. Before, it ended the list and the next item
// (`3. third`) followed a line of prose, where it stayed literal text.
listCases("item paragraphs", [
  {
    name: "a paragraph after a blank line stays in its item; the next items and their children follow",
    md: "1. first\n2. second\n\n   more about second.\n3. third\n   - nested\n4. fourth",
    web: "<ol><li>first</li><li>second<p>more about second.</p></li><li>third<ul><li>nested</li></ul></li><li>fourth</li></ol>",
    text: "1. first\n\n2. second\n\n   more about second.\n\n3. third\n  ◦ nested\n\n4. fourth",
    email: "<ol><li>first</li><li>secondmore about second.</li><li>third<ul><li>nested</li></ul></li><li>fourth</li></ol>",
  },
  {
    name: "a paragraph after a nested list belongs to the parent item it is indented into",
    md: "- a\n  - b\n\n  more about a\n- c",
    web: "<ul><li>a<ul><li>b</li></ul><p>more about a</p></li><li>c</li></ul>",
    text: "- a\n  ◦ b\n\n  more about a\n\n- c",
    email: "<ul><li>a<ul><li>b</li></ul>more about a</li><li>c</li></ul>",
  },
  {
    name: "a line directly under an item paragraph continues the paragraph",
    md: "- a\n\n  p1\n  p2\n- b",
    web: "<ul><li>a<p>p1\np2</p></li><li>b</li></ul>",
    text: "- a\n\n  p1\n  p2\n\n- b",
    email: "<ul><li>ap1<br>p2</li><li>b</li></ul>",
  },
]);

describe("item paragraphs: a fence in the item, then text (the chat shape)", () => {
  const md = "1. Step one:\n   ```bash\n   cmd\n   ```\n   Then check output.\n2. Step two\n3. Step three";
  test("web: the text is a paragraph of item 1, and there are three items", () => {
    const out = stripTokenSpans(formatWebHtml(md));
    expect(out).toBe(
      '<ol><li>Step one:<pre><code class="language-bash">cmd</code></pre><p>Then check output.</p></li><li>Step two</li><li>Step three</li></ol>',
    );
  });
  test("telegram: a blank line, then the text at the item's hanging indent", () =>
    expect(formatTelegramHtml(md)).toBe(
      '1. Step one:\n<pre><code class="language-bash">cmd</code></pre>\n\n   Then check output.\n2. Step two\n3. Step three',
    ));
  test("slack", () =>
    expect(formatSlackMrkdwn(md)).toBe("1. Step one:\n```\ncmd\n```\n\n   Then check output.\n2. Step two\n3. Step three"));
  test("email: a styled <p> inside the <li>", () =>
    expect(formatEmailHtml(md)).toMatch(/<li style="[^"]*">Step one:<pre[^>]*><code>cmd<\/code><\/pre><p style="[^"]*">Then check output\.<\/p><\/li>/));
});

// Fix round 2 (D1b): the interruption rule is for CHILD lists only. A column-0
// ordered item under a line of prose opens a list whatever its number, as it
// did before nesting.
describe("a column-0 ordered item under prose opens a list", () => {
  const md = "**Next steps**\n4. four\n5. five";
  test("web", () => expect(formatWebHtml(md)).toBe('<strong>Next steps</strong>\n<ol start="4"><li>four</li><li>five</li></ol>'));
  test("a column-0 `2024.` under prose is a list too, as before nesting", () =>
    expect(formatWebHtml("Price rose in\n2024. That was big.")).toBe(
      'Price rose in\n<ol start="2024"><li>That was big.</li></ol>',
    ));
});

// Fix round 2 (D2): Slack's empty-item cleanup never reads code.
describe("slack: bare marker lines inside code are code", () => {
  test("a yaml fence keeps its bare `-` lines at every indent", () =>
    expect(formatSlackMrkdwn("```yaml\nsteps:\n  -\n    run: x\n-\n```")).toBe("```\nsteps:\n  -\n    run: x\n-\n```"));
  test("an item's fence keeps them too", () =>
    expect(formatSlackMrkdwn("- a\n  ```\n  -\n  ```")).toBe("- a\n```\n-\n```"));
  test("a bare `-` line of prose is still blanked", () => expect(formatSlackMrkdwn("a\n-\nb")).toBe("a\n\nb"));
});

// Fix round 2 (D3): a task row is a flex box and does not advance an <ol>'s
// counter, so on the web every row of an ordered checklist sublist carries its
// number — the plain rows after a task row show 2. and 3., as on the text
// platforms.
describe("an ordered checklist sublist numbers every row", () => {
  const md = "<Checklist>\n- [ ] parent\n  1. [x] done\n  2. plain\n  3. plain\n</Checklist>";
  test("web: value on the task row and on each plain row", () => {
    const out = formatWebHtml(md);
    expect(out).toContain('<li class="check-item check-done" value="1">');
    expect(out).toContain('<li class="check-plain" value="2">plain</li><li class="check-plain" value="3">plain</li>');
  });
  test("telegram shows the same numbers", () => expect(formatTelegramHtml(md)).toBe("☐ parent\n  ☑ done\n  2. plain\n  3. plain"));
  test("email: a plain row that keeps its source number carries it as value", () => {
    const email = unstyled(formatEmailHtml("<Checklist>\n- [ ] p\n  1. a\n     - x\n  5. b\n</Checklist>"));
    expect(email).toContain('<li value="5">b</li>');
  });
});

test("a Checklist row's further paragraph stays in the row on every platform", () => {
  const md = "<Checklist>\n- [ ] a\n\n  note\n- [x] b\n</Checklist>";
  expect(formatWebHtml(md)).toContain('<span class="check-text">a</span><p>note</p></li>');
  expect(formatTelegramHtml(md)).toBe("☐ a\n\n  note\n☑ b");
  expect(formatSlackMrkdwn(md)).toBe("☐ a\n\n  note\n☑ b");
  expect(unstyled(formatEmailHtml(md))).toContain("anote</li>");
});
