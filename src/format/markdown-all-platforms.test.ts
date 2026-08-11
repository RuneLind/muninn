import { test, expect, describe } from "bun:test";
import { formatWebHtml } from "../web/web-format.ts";
import { formatTelegramHtml } from "../bot/telegram-format.ts";
import { formatSlackMrkdwn } from "../slack/slack-format.ts";
import { formatEmailHtml } from "./email-format.ts";
import { RAW_EMPHASIS_SOURCES } from "./markdown-core.ts";

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
    expect(formatWebHtml(md)).toBe('<pre><code class="language-ts">const x = 1;</code></pre>'));
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
