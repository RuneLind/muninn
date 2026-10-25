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
    expect(md('<p><a href="https://t.co/InventedE5">https://t.co/InventedE5</a></p>')).toBe("https://t.co/InventedE5");
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
