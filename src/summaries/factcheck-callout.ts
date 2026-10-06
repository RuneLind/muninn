/**
 * How a summary's fact-check block READS: the two sentinel lines dropped and the
 * `> [!factcheck]` callout styled. The one helper every surface that renders
 * summary markdown calls — the `/summaries` reader and library (`sum-job-card.ts`'s
 * `renderMarkdown`), the doc panel on the search, research and chat pages
 * (`doc-panel.ts`'s, which `search-document-page.ts` uses too), and the export
 * (`export.ts`).
 *
 * The page renderers escape raw HTML, so a sentinel comment would otherwise show
 * as literal `<!-- factcheck:start -->` text.
 *
 * Both functions are dependency-free and reach the inline page scripts as
 * `.toString()` source ({@link factcheckCalloutScript}), so they must not call
 * anything outside their own bodies.
 */

/** `markdown` without the whole-line sentinel lines (indented ≤ 3 spaces),
 *  outside fenced code — a fenced example of the markers is content. */
export function dropFactcheckSentinelLines(markdown: string): string {
  let fence: string | null = null;
  return String(markdown)
    .split("\n")
    .filter(function (line) {
      const m = /^\s*(`{3,}|~{3,})/.exec(line);
      if (m) {
        if (fence === null) {
          fence = m[1]!;
          return true;
        }
        if (m[1]!.charAt(0) === fence.charAt(0) && m[1]!.length >= fence.length) {
          fence = null;
          return true;
        }
      }
      if (fence !== null) return true;
      // Compared without a literal "<!--" in the source: this body is inlined
      // into a <script>, where that sequence changes how HTML parses the rest.
      const t = line.trim();
      const tail = t.charAt(0) === "<" ? t.slice(1) : "";
      return !(/^ {0,3}\S/.test(line) && (tail === "!-- factcheck:start -->" || tail === "!-- factcheck:end -->"));
    })
    .join("\n");
}

/** Rendered HTML with every `<blockquote>` that opens on `[!factcheck] …` marked
 *  as the styled callout, its first paragraph as the title. The title text is
 *  the renderer's own (already escaped) output. */
export function styleFactcheckCallouts(html: string): string {
  return String(html).replace(/<blockquote>\s*<p>\[!factcheck\][ \t]*([^<\n]*)<\/p>/g, function (_whole, title: string) {
    return (
      '<blockquote class="sum-fc-callout" data-callout="factcheck">' +
      '<p class="sum-fc-callout-title">✓ ' + (title || "Fact check") + "</p>"
    );
  });
}

export const FACTCHECK_CALLOUT_FUNCTIONS = [dropFactcheckSentinelLines, styleFactcheckCallouts] as const;

/** The two functions as page-script declarations. */
export function factcheckCalloutScript(): string {
  return FACTCHECK_CALLOUT_FUNCTIONS.map((f) => `var ${f.name} = ${f.toString()};`).join("\n");
}

/** The callout's styles, scoped like `markdownContentStyles`. */
export function factcheckCalloutStyles(prefix: string): string {
  return `
    ${prefix} blockquote.sum-fc-callout {
      border-left-color: var(--status-success);
      background: color-mix(in srgb, var(--status-success) 7%, transparent);
      color: var(--text-secondary);
    }
    ${prefix} blockquote.sum-fc-callout .sum-fc-callout-title {
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 8px;
    }
    ${prefix} blockquote.sum-fc-callout a { color: var(--accent-light); }`;
}
