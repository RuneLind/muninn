import { test, expect, describe } from "bun:test";
import { renderedCodeRegions, inRenderedCode } from "./rendered-code.ts";
import { formatWebHtml } from "../web/web-format.ts";

describe("renderedCodeRegions / inRenderedCode", () => {
  /** Offset of `needle` in `html`, so a case names what it probes. */
  const at = (html: string, needle: string) => html.indexOf(needle);

  test("a fenced block's body is a region; the prose around it is not", () => {
    const html = formatWebHtml("before\n\n```ts\nconst x = 1;\n```\n\nafter");
    const regions = renderedCodeRegions(html);
    expect(regions).toHaveLength(1);
    expect(inRenderedCode(regions, at(html, "const"))).toBe(true);
    expect(inRenderedCode(regions, at(html, "before"))).toBe(false);
    expect(inRenderedCode(regions, at(html, "after"))).toBe(false);
  });

  test("an inline span's body is a region too — both shapes, one scan", () => {
    const html = formatWebHtml("say `hi` here");
    expect(inRenderedCode(renderedCodeRegions(html), at(html, "hi"))).toBe(true);
    expect(inRenderedCode(renderedCodeRegions(html), at(html, "here"))).toBe(false);
  });

  test("the OPEN TAG is not in the region — only the body is", () => {
    // The restore replaces text inside the body; counting the tag would make an
    // offset in `class="language-ts"` read as code and is simply wrong.
    const html = formatWebHtml("```ts\nx\n```");
    const r = renderedCodeRegions(html)[0]!;
    expect(html.slice(r.start, r.end)).toBe("x");
  });

  test("the BOUNDARIES: end is exclusive, end-1 is inside", () => {
    // `index >= r.end` is the half of the comparison a suite can pass without —
    // mutate it to `>` and the first character AFTER a code region reads as code,
    // which is exactly `` `a`[[Page]] `` with no space between them.
    const html = formatWebHtml("`ab` tail");
    const r = renderedCodeRegions(html)[0]!;
    expect(inRenderedCode([r], r.start)).toBe(true);
    expect(inRenderedCode([r], r.end - 1)).toBe(true);
    expect(inRenderedCode([r], r.end)).toBe(false);
    expect(inRenderedCode([r], r.start - 1)).toBe(false);
  });

  test("a <code> the PAGE wrote is escaped, so it opens no phantom region", () => {
    // The non-nesting property this module relies on is the renderer's, not an
    // assumption: prose, a fence body and a component attribute all arrive
    // escaped, so a literal `<code` in the output is always one the renderer
    // emitted.
    for (const src of [
      "I wrote <code>x</code> in prose",
      '<Callout tone="info" title="<code>t</code>">\n\nbody\n\n</Callout>',
    ]) {
      expect(renderedCodeRegions(formatWebHtml(src))).toEqual([]);
    }
    // …and one quoted INSIDE a fence does not close its own region early.
    const fenced = formatWebHtml("```html\n<code>x</code>\n```");
    const r = renderedCodeRegions(fenced);
    expect(r).toHaveLength(1);
    expect(fenced.slice(r[0]!.start, r[0]!.end)).toBe("&lt;code&gt;x&lt;/code&gt;");
  });

  test("an unclosed <code> runs to the end — the conservative direction", () => {
    // Not something the renderer emits; if it ever did, treating the tail as code
    // costs a link rendered as its own brackets, while the reverse costs source.
    const html = "prose <code>never closed";
    const r = renderedCodeRegions(html);
    expect(r).toHaveLength(1);
    expect(r[0]!.end).toBe(html.length);
  });

  test("no code, no regions", () => {
    expect(renderedCodeRegions(formatWebHtml("just prose"))).toEqual([]);
    expect(inRenderedCode([], 0)).toBe(false);
  });
});
