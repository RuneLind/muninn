import { describe, expect, test } from "bun:test";
import { HIGHLIGHT_TOKEN_CLASSES, highlightCode } from "./highlight.ts";
import { stripTokenSpans } from "../test/highlighted-code.ts";

/**
 * The rendered TEXT of a highlighted fence, i.e. what `code.textContent` gives
 * the reader (and gives the mermaid enhancer, and gives a copy-to-clipboard
 * button). Strips the spans and reverses `escapeHtml`.
 */
function renderedText(html: string): string {
  return stripTokenSpans(html)
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

const SAMPLES: Record<string, string> = {
  sql: [
    "-- Én diagnostisk spørring. Klassifiseringen gjøres på resultatet.",
    "SELECT b.saksnummer, ap.fom_dato",
    "FROM anmodningsperiode ap",
    "JOIN behandling b ON b.id = ap.beh_resultat_id",
    "WHERE ap.medlperiode_id IS \u0000L",
    "  AND (ap.tom_dato IS \u0000L OR ap.tom_dato >= ap.fom_dato)",
    "  AND p.prosess_type IN ('ANMODNING_OM_UNNTAK', 'O''BRIEN')",
    "ORDER BY ap.beh_resultat_id;",
  ].join("\n"),
  typescript: [
    "// src/web/web-format.ts",
    "const webRenderer: BlockRenderer = {",
    '  code_block(block) {',
    '    const lang = block.lang ? ` class="language-${block.lang}"` : "";',
    '    return "<pre><code" + lang + ">" + escapeHtml(block.code) + "</code></pre>";',
    "  },",
    "};",
  ].join("\n"),
  kotlin: [
    "@Column(name = \"medlperiode_id\")",
    "class Anmodningsperiode(private val id: Long?) {",
    "    fun utfør(): Sendestatus = if (id == null) IKKE_SENDT else SENDT",
    "    val sql = \"\"\"",
    "        select 1 from dual",
    "    \"\"\"",
    "}",
  ].join("\n"),
  java: [
    "public final class Sender {",
    "    private static final int MAX = 0x1F;",
    "    public boolean send(String key) { return key != null && MAX > 3; }",
    "}",
  ].join("\n"),
  bash: [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "# capture the transcript",
    'for f in "$DIR"/*.md; do',
    '  bun run db:migrate --file "${f}" | grep -c "ok" && echo done',
    "done",
  ].join("\n"),
  json: '{\n  "connector": "copilot-sdk",\n  "thinkingMaxTokens": 16000,\n  "showWaterfall": false,\n  "tags": [1, -2.5, null]\n}',
  yaml: [
    "# nais manifest",
    "spec:",
    "  image: europe-north1-docker.pkg.dev/x/y:v1",
    "  replicas:",
    "    min: 1",
    "  env:",
    "    - name: MUNINN_PROFILE",
    "      value: nais",
    "  enabled: true",
  ].join("\n"),
};

describe("highlightCode — the round-trip property", () => {
  // The one guarantee the whole module rests on: highlighting NEVER changes the
  // text. `textContent` feeds the copy button, the mermaid enhancer and anyone
  // selecting a query to paste into psql — a tokenizer that drops or duplicates
  // a character there is a data bug wearing a styling bug's clothes.
  for (const [lang, source] of Object.entries(SAMPLES)) {
    test(`${lang}: rendered text is byte-identical to the source`, () => {
      expect(renderedText(highlightCode(source, lang))).toBe(source);
    });
  }

  test("every grammar survives adversarial input without losing a character", () => {
    // Unterminated strings, lone comment openers, stray backslashes, CRLF,
    // astral characters — the shapes an unfinished paste actually has.
    const nasty = [
      '"unterminated',
      "'also unterminated",
      "/* never closed",
      "-- trailing comment",
      "#",
      "```",
      "a\\",
      '"""',
      "$",
      "${",
      "\r\n\t  ",
      "🧾 emoji & <tags> & \"quotes\"",
      "0x", "1e", "--", "//", "()[]{}<>",
      "",
      // Placeholder-sentinel shapes. The wiki renderers park constructs as
      // \u0000-delimited tokens and restore them over the RENDERED HTML, so a rule
      // that splits or drops one destroys page text — every malformed variant
      // has to round-trip too, not just the well-formed sentinel.
      "\u0000", "\u0000WIKIPAGELINK0\u0000", "\u0000ASKCITE1\u0000", "\u0000\u0000\u0000",
      "\u0000unclosed", "trailing\u0000", "\u0000with space\n\u0000",
    ];
    for (const lang of ["sql", "typescript", "kotlin", "bash", "json", "yaml"]) {
      for (const piece of nasty) {
        expect(renderedText(highlightCode(piece, lang))).toBe(piece);
      }
      // …and every concatenation of two of them, which is where a rule that
      // over-consumes shows up.
      for (const a of nasty) {
        for (const b of nasty) {
          const src = a + "\n" + b;
          expect(renderedText(highlightCode(src, lang))).toBe(src);
        }
      }
    }
  });

  test("random noise round-trips (total function, no infinite loop)", () => {
    const alphabet = "abzAZ09 \n\t\"'`\\/*-#$@{}()[]<>=;:,.|&!?~_+%^ø&<>";
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let n = 0; n < 400; n++) {
      let src = "";
      const len = Math.floor(rand() * 60);
      for (let k = 0; k < len; k++) src += alphabet[Math.floor(rand() * alphabet.length)];
      for (const lang of ["sql", "typescript", "bash", "json", "yaml"]) {
        expect(renderedText(highlightCode(src, lang))).toBe(src);
      }
    }
  });
});

describe("highlightCode — escaping", () => {
  test("HTML metacharacters are escaped inside and outside spans", () => {
    const html = highlightCode('const x = "<script>a && b</script>";', "typescript");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;&amp;");
    // …and the only tags in the output are our own spans.
    expect(html.replace(/<\/?span[^>]*>/g, "")).not.toContain("<");
  });

  test("a fence whose text is itself a tok-span markup string stays inert", () => {
    const src = '<span class="tok-kw">SELECT</span>';
    const html = highlightCode(src, "sql");
    expect(renderedText(html)).toBe(src);
    // Strip OUR spans; what is left must be fully escaped — no live tag and no
    // live class attribute smuggled in from the fence body.
    const rest = html.replace(/<\/?span[^>]*>/g, "");
    expect(rest).not.toContain("<");
    expect(rest).toContain("&lt;");
    expect(rest).toContain("&quot;tok-kw&quot;");
  });
});

describe("highlightCode — languages", () => {
  test("an unknown language renders plain, with no spans", () => {
    const src = "graph TD\n  A[<b>x</b>] --> B";
    expect(highlightCode(src, "mermaid")).toBe("graph TD\n  A[&lt;b&gt;x&lt;/b&gt;] --&gt; B");
    expect(highlightCode(src, "")).not.toContain("<span");
    expect(highlightCode(src, "html")).not.toContain("<span");
  });

  test("an oversized fence renders plain rather than spending the scan", () => {
    const huge = "select 1;\n".repeat(12_000); // > 100k chars
    expect(huge.length).toBeGreaterThan(100_000);
    expect(highlightCode(huge, "sql")).not.toContain("<span");
  });
});

describe("highlightCode — grammar behavior worth pinning", () => {
  test("SQL: a leading -- is a comment, never punctuation", () => {
    const html = highlightCode("-- note\nSELECT 1;", "sql");
    expect(html).toContain('<span class="tok-com">-- note</span>');
    expect(html).not.toContain('<span class="tok-pun">--</span>');
  });

  test("SQL: keywords are case-insensitive and whole-word only", () => {
    const html = highlightCode("select insert_id from t", "sql");
    expect(html).toContain('<span class="tok-kw">select</span>');
    // `insert_id` starts with a keyword but is an identifier.
    expect(html).not.toContain('<span class="tok-kw">insert</span>');
  });

  test("longest-first keyword ordering: `interface` is one keyword, not `in`", () => {
    const html = highlightCode("interface X {}", "typescript");
    expect(html).toContain('<span class="tok-kw">interface</span>');
    expect(html).not.toContain('<span class="tok-kw">in</span>');
  });

  test("Kotlin triple-quoted strings do not terminate on the first pair", () => {
    const html = highlightCode('val s = """a "b" c"""\nval n = 1', "kotlin");
    expect(html).toContain('<span class="tok-str">&quot;&quot;&quot;a &quot;b&quot; c&quot;&quot;&quot;</span>');
    expect(html).toContain('<span class="tok-kw">val</span>');
  });

  test("shell: the first word of a line is the command", () => {
    const html = highlightCode("bun run test\n# comment", "bash");
    expect(html).toContain('<span class="tok-fn">bun</span>');
    expect(html).toContain('<span class="tok-com"># comment</span>');
  });

  test("shell: a comment marker inside a string stays in the string", () => {
    const src = 'echo "a # b"';
    const html = highlightCode(src, "bash");
    expect(html).not.toContain("tok-com");
    expect(renderedText(html)).toBe(src);
  });

  test("json: a key is typed differently from a value", () => {
    const html = highlightCode('{"a": "b"}', "json");
    expect(html).toContain('<span class="tok-typ">&quot;a&quot;</span>');
    expect(html).toContain('<span class="tok-str">&quot;b&quot;</span>');
  });

  test("every token class has a colour in BOTH themes", async () => {
    // The union/array drift this replaced is a COMPILE error since TokenClass is
    // derived from TOKEN_CLASSES. What is still hand-kept is the CSS: a class
    // with a `--tok-*` in the dark block and none in the light one renders as
    // inherited grey in one theme only — this repo's classic unreadable-theme
    // bug, and invisible to anyone working in dark.
    const css = await Bun.file("src/dashboard/views/shared-styles.ts").text();
    // ⚠️ BOTH halves are bounded to their own template literal. Slicing the light
    // half to end-of-file made the check launderable: any `--tok-*` further down
    // — a scoped override, a print block, a comment — satisfied it while the
    // light palette was genuinely missing the token. Measured: deleting
    // `--tok-fn` from LIGHT_TOKENS and adding `@media print { :root { --tok-fn } }`
    // below it left this test green.
    const blockAt = (name: string): string => {
      const from = css.indexOf(`const ${name} = \``);
      expect(from).toBeGreaterThan(-1);
      const to = css.indexOf("`;", from);
      expect(to).toBeGreaterThan(from);
      return css.slice(from, to);
    };
    const dark = blockAt("DARK_TOKENS");
    const light = blockAt("LIGHT_TOKENS");
    // The rules live in SHARED_STYLES; bound the search there for the same reason.
    const rules = css.slice(css.indexOf("export const SHARED_STYLES"));
    for (const cls of HIGHLIGHT_TOKEN_CLASSES) {
      const varName = `--${cls}:`; // tok-kw -> --tok-kw:
      expect(dark).toContain(varName);
      expect(light).toContain(varName);
      // …and a rule that actually consumes it. (Whitespace-tolerant: the
      // stylesheet aligns the short selectors with an extra space.)
      expect(rules).toMatch(new RegExp(`\\.${cls}\\s*\\{\\s*color:\\s*var\\(--${cls}\\)`));
    }
  });
});


describe("highlightCode — \u0000 placeholder sentinels survive intact", () => {
  // `src/wiki/render.ts` and `src/wiki/ask-render.ts` park a wikilink / citation
  // marker as a \u0000-delimited sentinel BEFORE rendering and restore it with a
  // regex over the rendered HTML. A fence body can contain one — `arr[1]` inside
  // a citation range, `[[1,2,3]]` in a nested-array literal — and the C-family
  // `typ` rule matches the sentinel's uppercase word, so tokenizing SPLITS the
  // sentinel: the restore regex then misses, a raw U+0000 is served, and the
  // source text (`arr[1]`) is destroyed rather than merely mis-colored.
  const SENTINELS = ["\u0000WIKIPAGELINK0\u0000", "\u0000ASKCITE12\u0000"];

  for (const lang of ["typescript", "kotlin", "java", "sql", "bash", "json", "yaml"]) {
    test(`${lang}: a sentinel is left contiguous and unwrapped`, () => {
      for (const sentinel of SENTINELS) {
        const src = `const v = arr${sentinel};`;
        const html = highlightCode(src, lang);
        // The whole point: the restore regex must still find it.
        expect(html).toContain(sentinel);
        expect(renderedText(html)).toBe(src);
      }
    });
  }
});

/**
 * The performance CLASS, enumerated rather than patched rule by rule.
 *
 * Two separate quadratics shipped in this module before anyone measured: a lazy
 * `*/` search that re-scanned from every `/*`, and a variable-length lookbehind
 * that walked backwards from every offset inside a whitespace run (yaml: 6.8 s
 * for 32k of spaces, ~68 s at the 99k cap — 60x worse than the bug that was
 * found first). Both are the same shape: an unbounded quantifier evaluated at
 * every offset.
 *
 * So this is a table over EVERY grammar × every pathological body, not a case
 * per bug. A new rule with an unbounded quantifier fails here on the day it is
 * added, whichever grammar it lands in.
 */
describe("highlightCode — no grammar scans quadratically", () => {
  const BODIES: Record<string, string> = {
    "whitespace run": " ".repeat(32_000),
    "tab run": "\t".repeat(32_000),
    "indented lines then padding": "a: 1\nb: 2\n" + " ".repeat(20_000),
    "unterminated block comment": "/*a".repeat(11_000),
    "unterminated triple quote": '"""a'.repeat(8_000),
    "quote run": '"'.repeat(32_000),
    "dash run": "-".repeat(32_000),
    "brace run": "{".repeat(32_000),
  };

  for (const lang of ["typescript", "sql", "bash", "json", "yaml"]) {
    for (const [name, body] of Object.entries(BODIES)) {
      test(`${lang}: ${name} stays linear`, () => {
        const started = performance.now();
        const html = highlightCode(body, lang);
        const elapsed = performance.now() - started;
        expect(renderedText(html)).toBe(body);
        // Every linear case measures in single-digit ms; 150 ms is a wide
        // ceiling that still fails hard on anything quadratic.
        expect(elapsed).toBeLessThan(150);
      });
    }
  }
});

describe("highlightCode — no quadratic scan on unterminated block comments", () => {
  // The lazy `*/` search re-scans to end-of-input from EVERY opener when no
  // closer exists, which is O(n^2). muninn renders markdown synchronously inside
  // Bun.serve(), so a wiki page or a model answer carrying a large commented-out
  // block stalls the whole process — measured at ~1.1 s for one 99k fence, and
  // MAX_HIGHLIGHT_CHARS bounds a FENCE, not a page.
  for (const lang of ["typescript", "sql"]) {
    test(`${lang}: 99k of unterminated block-comment opener stays under a second`, () => {
      const src = "/*a".repeat(33_000);
      const started = performance.now();
      const html = highlightCode(src, lang);
      const elapsed = performance.now() - started;
      expect(renderedText(html)).toBe(src);
      // The linear path does this in single-digit ms; 250 ms is a generous
      // ceiling that still fails hard on the quadratic one.
      expect(elapsed).toBeLessThan(250);
    });
  }
});
