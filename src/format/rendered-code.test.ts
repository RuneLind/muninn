import { test, expect, describe } from "bun:test";
import { renderedCodeRegions, inRenderedCode } from "./rendered-code.ts";
import { formatWebHtml } from "../web/web-format.ts";
import { COMPONENT_NAMES } from "./markdown-ast.ts";

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

/**
 * The container set, DERIVED over the component vocabulary.
 *
 * ⚠️ This is the test that was missing, and its absence cost a regression. The
 * first cut of this module assumed one container, `<code>`, and pinned that with
 * hand-picked cases — none of which was a component whose fence does NOT render
 * a `<code>`. `<Diff>` is exactly that: its fence becomes
 * `<div class="diff-line …">` per line, so a wikilink inside a diff came back as
 * a live link, which the markdown-side scanner it replaced had got right.
 *
 * So the check is over `COMPONENT_NAMES`, not over a list of components someone
 * thought of: a component that introduces a THIRD container fails here rather
 * than silently in a reader's browser. Same default-deny reason
 * `COMPONENT_FENCE_CHROME` is a `Record` and not a list.
 *
 * A component that cannot hold the probe at all (its parser drops the body) is
 * skipped by the `probe MISSING` guard rather than asserted on — the point is
 * that anything the renderer DOES show as code is covered.
 */
describe("every component's code lands in a region", () => {
  const PROBE = "ZZPROBEZZ";

  for (const name of COMPONENT_NAMES) {
    for (const [kind, inner] of [
      ["fenced", "```ts\n" + PROBE + "\n```"],
      ["inline", "`" + PROBE + "`"],
    ] as [string, string][]) {
      test(`${name}: a ${kind} probe is inside a code region`, () => {
        const html = formatWebHtml(`<${name}>\n\n${inner}\n\n</${name}>`);
        const at = html.indexOf(PROBE);
        // The component's parser dropped the body — nothing to assert about.
        if (at === -1) return;
        expect(
          `${name}/${kind}: ${inRenderedCode(renderedCodeRegions(html), at)}`,
        ).toBe(`${name}/${kind}: true`);
      });
    }
  }

  test("…and a BARE fence and inline span, with no component around them", () => {
    for (const src of ["```ts\n" + PROBE + "\n```", "`" + PROBE + "`"]) {
      const html = formatWebHtml(src);
      expect(inRenderedCode(renderedCodeRegions(html), html.indexOf(PROBE))).toBe(true);
    }
  });

  test("prose is NOT a region — the guard is not an off switch", () => {
    const html = formatWebHtml(`Some ${PROBE} prose.`);
    expect(inRenderedCode(renderedCodeRegions(html), html.indexOf(PROBE))).toBe(false);
  });
});

describe("nesting — <FileRef> wraps already-rendered children in <code>", () => {
  test("the OUTER region spans the whole FileRef, not just up to the inner close", () => {
    // Pairing an open tag with the NEXT `</code>` closed the outer region at the
    // INNER one, leaving everything after it outside every region — a live link
    // inside a `<code>`, the exact failure this module exists to prevent.
    const html = formatWebHtml("<FileRef>`a` MIDDLE `b`</FileRef>");
    expect(html).toContain('<code class="fileref"><code>a</code>');
    const regions = renderedCodeRegions(html);
    expect(inRenderedCode(regions, html.indexOf("MIDDLE"))).toBe(true);
    // Outermost only: one region for the whole FileRef, not three.
    expect(regions).toHaveLength(1);
  });

  test("a stray </code> with nothing open is ignored, not paired backwards", () => {
    expect(renderedCodeRegions("prose </code> more")).toEqual([]);
  });
});
