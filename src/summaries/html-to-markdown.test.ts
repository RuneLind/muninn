import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { htmlToMarkdown, type MarkdownSourceNode } from "./html-to-markdown.ts";
import { parseHtml } from "../test/mini-dom.ts";
import { testTempDirSync } from "../test/temp-dir.ts";
import { EXTENSION_OUTPUTS, buildExtensionOutput } from "../youtube/extension-build.ts";

const md = (html: string, options = {}) => htmlToMarkdown(parseHtml(html), options);

/**
 * Invented X article markup in the shape X renders a link: the anchor's href is
 * a `t.co` short link; its text is the expanded URL split across spans, the
 * scheme and the tail hidden, then a visible ellipsis. No real handle, no real
 * status id.
 */
const X_FIXTURE = `
<div data-testid="primaryColumn">
  <div><span>An invented article</span></div>
  <div>
    <div><span>We ship a harness first. The code is at </span><a href="https://t.co/InventedA1" rel="noopener"><span class="hide">https://</span><span>github.com/acme/agent-ha</span><span class="hide">rness</span><span>…</span></a><span>, and the design notes at </span><a href="https://t.co/InventedB2"><span>our write-up</span></a><span>.</span></div>
    <div><span>Thanks to </span><a href="/someone_invented"><span>@someone_invented</span></a><span> for review.</span></div>
  </div>
</div>`;

/** The page's CSS hides `.hide`; the walk is told so the way the content script tells it. */
const hideByClass = (el: MarkdownSourceNode) => /\bhide\b/.test(el.getAttribute?.("class") ?? "");

describe("htmlToMarkdown — X article markup", () => {
  test("a t.co anchor whose text spells the URL gets that URL; any other keeps its t.co href", () => {
    expect(md(X_FIXTURE, { isHidden: hideByClass })).toBe(
      [
        "An invented article",
        "We ship a harness first. The code is at https://github.com/acme/agent-harness, and the design notes at [our write-up](https://t.co/InventedB2).",
        "Thanks to @someone_invented for review.",
      ].join("\n\n"),
    );
  });

  test("hidden spans are skipped in visible text but still read for the expansion", () => {
    const out = md(
      '<p>See <a href="https://t.co/InventedC3"><span class="hide">https://</span>example.org/a-long-pa<span class="hide">th</span>…</a> now</p>',
      { isHidden: hideByClass },
    );
    expect(out).toBe("See https://example.org/a-long-path now");
  });

  test("an anchor text without a scheme is not trusted as the target", () => {
    expect(md('<p><a href="https://t.co/InventedD4">example.org/somewhere…</a></p>')).toBe(
      "[example.org/somewhere…](https://t.co/InventedD4)",
    );
  });

  test("a t.co text that spells t.co again is no expansion", () => {
    // The text spells ANOTHER t.co URL, so only the `isTco` guard keeps the
    // href: without it the text's t.co would replace the anchor's.
    expect(md('<p><a href="https://t.co/InventedE5">https://t.co/InventedF6</a></p>')).toBe(
      "[https://t.co/InventedF6](https://t.co/InventedE5)",
    );
  });
});

describe("htmlToMarkdown — page markup", () => {
  test("anchors, headings, emphasis and paragraphs", () => {
    expect(
      md(
        '<h2>Why <em>harnesses</em></h2><p>Read <a href="https://example.org/paper">the paper</a> and <strong>then</strong> <a href="https://github.com/example/harness">a harness</a>.</p>',
      ),
    ).toBe(
      "## Why *harnesses*\n\nRead [the paper](https://example.org/paper) and **then** [a harness](https://github.com/example/harness).",
    );
  });

  test("relative, fragment and javascript: hrefs keep only their text", () => {
    expect(md('<p><a href="/a">one</a> <a href="#b">two</a> <a href="javascript:void(0)">three</a></p>')).toBe(
      "one two three",
    );
  });

  test("brackets in the text and parens in the href cannot break the link", () => {
    expect(md('<p><a href="https://example.org/a_(b) c">Example [beta]</a></p>')).toBe(
      "[Example (beta)](https://example.org/a_%28b%29%20c)",
    );
  });

  test("an anchor whose text is its own URL is written bare", () => {
    expect(md('<p><a href="https://example.org/x">example.org/x</a></p>')).toBe("https://example.org/x");
  });

  test("nested lists, ordered lists and a code block keep their shape", () => {
    expect(
      md(
        "<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul><ol start=\"3\"><li>third</li></ol><pre><code>const x = 1;\n\tindented();</code></pre>",
      ),
    ).toBe("- one\n- two\n  - nested\n\n3. third\n\n```\nconst x = 1;\n\tindented();\n```");
  });

  test("quotes, rules, tables and inline code", () => {
    expect(
      md(
        "<blockquote><p>quoted</p><p>twice</p></blockquote><hr><table><tr><th>a</th><th>b|c</th></tr><tr><td>1</td><td>2</td></tr></table><p>run <code>bun test</code></p>",
      ),
    ).toBe("> quoted\n>\n> twice\n\n---\n\n| a | b\\|c |\n| --- | --- |\n| 1 | 2 |\n\nrun `bun test`");
  });

  test("scripts, styles, buttons and hidden elements are dropped", () => {
    expect(
      md(
        '<p>kept</p><script>alert(1)</script><style>p{}</style><button>Follow</button><p hidden>gone</p><p style="display: none">gone</p>',
      ),
    ).toBe("kept");
  });

  test("the function carries everything it needs: its source runs on its own", () => {
    const standalone = new Function(`${htmlToMarkdown.toString()}\nreturn htmlToMarkdown;`)() as typeof htmlToMarkdown;
    expect(standalone(parseHtml(X_FIXTURE), { isHidden: hideByClass })).toBe(md(X_FIXTURE, { isHidden: hideByClass }));
  });
});

describe("htmlToMarkdown — text fidelity (fix round 1, R1)", () => {
  test("a Google Docs `<b style=font-weight:normal>` wrapper is no emphasis", () => {
    expect(
      md(
        '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-x"><h2>Heading</h2><p>Para one with <a href="https://ex.com/a">a link</a></p><p>Para two</p></b>',
      ),
    ).toBe("## Heading\n\nPara one with [a link](https://ex.com/a)\n\nPara two");
    expect(md('<p><b>bold</b> <i style="font-style: normal">plain</i></p>')).toBe("**bold** plain");
    expect(md('<p>a <b style="font-weight: 400">plain</b> b</p>')).toBe("a plain b");
  });

  test("emphasis around block children is dropped, not wrapped across paragraphs", () => {
    expect(md("<strong><p>p1</p><p>p2</p></strong>")).toBe("p1\n\np2");
    expect(md("<p>one <em>inline</em> two</p>")).toBe("one *inline* two");
  });

  test("a word that is not the URL keeps its link", () => {
    expect(md('<p>Read more on <a href="https://medium.com/@x/post-123">medium</a> today</p>')).toBe(
      "Read more on [medium](https://medium.com/@x/post-123) today",
    );
    expect(md('<p><a href="https://docs.python.org/3/">docs</a> <a href="https://github.com/acme">GitHub</a></p>')).toBe(
      "[docs](https://docs.python.org/3/) [GitHub](https://github.com/acme)",
    );
    expect(md('<p><a href="https://other.org/x">example.org/x</a></p>')).toBe("[example.org/x](https://other.org/x)");
    expect(md('<p><a href="https://example.org/other">example.org/x</a></p>')).toBe(
      "[example.org/x](https://example.org/other)",
    );
    expect(md('<p><a href="https://example.org/x/yz">www.example.org/x/y…</a></p>')).toBe("https://example.org/x/yz");
  });

  test("the href is the parsed URL: no raw tab or newline reaches the output", () => {
    expect(md('<p><a href="https://ex.com/a&#9;b">tab</a></p>')).toBe("[tab](https://ex.com/ab)");
    expect(md('<p><a href="https://ex.com/a&#10;b">nl</a></p>')).toBe("[nl](https://ex.com/ab)");
    expect(md('<pre>KEEP</pre><a href="https://ex.com/a&#9;&#9;0&#9;&#9;b">s</a>')).toBe(
      "```\nKEEP\n```\n\n[s](https://ex.com/a0b)",
    );
  });

  test("an anchor with no visible text (an image link) writes nothing", () => {
    expect(md('<p>x <a href="https://cdn.example.org/image/fetch/a.png"><img src="a.png"></a> y</p>')).toBe("x y");
  });

  test("backslashes in the anchor text are escaped, so the link still parses", () => {
    expect(md('<p><a href="https://ex.com/p">path C:\\dir\\</a></p>')).toBe("[path C:\\\\dir\\\\](https://ex.com/p)");
  });
});

describe("htmlToMarkdown — code fidelity (fix round 1, R2)", () => {
  test("inline code delimiters outrun the backtick runs inside and pad an edge backtick", () => {
    expect(md("<p><code>a``b</code> <code>`x</code></p>")).toBe("```a``b``` `` `x ``");
  });

  test("an anchor inside code keeps its href; the code markup is dropped", () => {
    expect(md('<p><code>see <a href="https://ex.com/p">x</a></code></p>')).toBe("see [x](https://ex.com/p)");
  });

  test("block children inside pre start new lines", () => {
    expect(md("<pre><div>line1</div><div>line2</div></pre>")).toBe("```\nline1\nline2\n```");
  });

  test("a code block in a list item, a quote or a table cell keeps its container", () => {
    expect(md("<ul><li>item<pre>a\nb</pre></li></ul>")).toBe("- item\n  ```\n  a\n  b\n  ```");
    expect(md("<ol><li><pre>x\ny</pre></li></ol>")).toBe("1. ```\n   x\n   y\n   ```");
    expect(md("<blockquote><pre>a\n\nb</pre></blockquote>")).toBe("> ```\n> a\n>\n> b\n> ```");
    expect(md("<table><tr><td>h</td></tr><tr><td><pre>a\nb</pre></td></tr></table>")).toBe(
      "| h |\n| --- |\n| `a b` |",
    );
  });
});

describe("the X extension's emitted walk", () => {
  const spec = EXTENSION_OUTPUTS.find((o) => o.output.endsWith("extensions/x-article/html-to-markdown.js"))!;

  test("`bun run build:extension` reproduces extensions/x-article/html-to-markdown.js byte for byte", async () => {
    const dir = testTempDirSync(join(tmpdir(), "muninn-x-ext-build-"));
    try {
      const fresh = await buildExtensionOutput(spec, join(dir, "html-to-markdown.js"));
      expect(fresh).toBe(readFileSync(spec.output, "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("it is an IIFE that sets globalThis.muninnHtmlToMarkdown, as the content script reads it", () => {
    const text = readFileSync(spec.output, "utf8");
    expect(spec.format).toBe("iife");
    const scope: { muninnHtmlToMarkdown?: typeof htmlToMarkdown } = {};
    new Function("globalThis", text)(scope);
    expect(typeof scope.muninnHtmlToMarkdown).toBe("function");
    expect(scope.muninnHtmlToMarkdown!(parseHtml(X_FIXTURE), { isHidden: hideByClass })).toBe(
      md(X_FIXTURE, { isHidden: hideByClass }),
    );
  });
});
