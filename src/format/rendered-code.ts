/**
 * Where the RENDERED HTML is code — the seam the wiki's two sentinel passes
 * decide against.
 *
 * `src/wiki/render.ts` and `src/wiki/ask-render.ts` park a `[[wikilink]]` / an
 * `[n]` citation as a `\x00`-delimited sentinel BEFORE `formatWebHtml` and
 * restore it by regex over the rendered HTML. That restore was not scoped to
 * prose, so a construct written inside a fence or inside backticks came back as
 * a live `<a>` INSIDE `<pre><code>` with the brackets deleted from the code's
 * own text — altered SOURCE, since `code.textContent` is what the copy button
 * hands over, what `wiki-mermaid.ts` reads and what the fact-check evidence card
 * clones.
 *
 * ⚠️ **The decision is made HERE, on the rendered output, and NOT by scanning
 * the markdown for fences.** A markdown-side scanner was written first and is
 * why this module exists: it cannot see the string the renderer actually parses,
 * because parking rewrites the body between the two. Four ways that diverged,
 * every one of them measured on the shipped renderer:
 *
 *  - **CRLF.** `parseBlocks` normalizes `\r\n` first, so a scanner reading the
 *    raw body finds no fence at all in a CRLF file and the original bug survives
 *    intact.
 *  - **A backtick inside a wikilink TARGET or LABEL** (`[[x`y]]` — the regex
 *    admits both). Parking removes that backtick, so every later backtick on the
 *    line re-pairs one position over: an inline span the scanner did not see
 *    appears, and a sentinel lands inside it.
 *  - **The same thing read backwards**: a link the scanner thought was in prose
 *    stops being parked, so a working link on that line renders as literal
 *    brackets — a regression, in the direction the guard exists to avoid.
 *  - **A fence delimiter that starts or ends mid-line.** The renderer replaces
 *    the fence with a placeholder and joins the text either side onto ONE line,
 *    where two lone backticks then pair; a line-wise scanner sees neither.
 *
 * None of that can happen here. The renderer has already decided what is code,
 * and this reads its answer.
 */

/** A half-open `[start, end)` span of rendered HTML that sits inside a `<code>`. */
export interface RenderedCodeRegion {
  start: number;
  end: number;
}

const CODE_OPEN_RE = /<code\b[^>]*>/g;

/**
 * The body of every `<code …>…</code>` in `html`, in document order.
 *
 * Both shapes the pipeline emits are covered by the one scan: a fenced block's
 * `<pre><code class="language-x">` and an inline span's bare `<code>`.
 *
 * **Non-nesting, and that is a property of the renderer rather than an
 * assumption.** `formatWebHtml` escapes everything it does not itself emit, so a
 * `<code>` written in a page's prose, quoted inside a fence, or put in a
 * component attribute arrives as `&lt;code&gt;` — measured on all four. A literal
 * `<code` in the output can therefore only be one the renderer wrote.
 *
 * An unclosed `<code>` (which the renderer does not produce) runs to the end of
 * the document: the conservative direction, since treating prose as code costs a
 * link that renders as its own brackets, while the reverse costs the source.
 */
export function renderedCodeRegions(html: string): RenderedCodeRegion[] {
  const regions: RenderedCodeRegion[] = [];
  for (const m of html.matchAll(CODE_OPEN_RE)) {
    const start = m.index + m[0].length;
    const close = html.indexOf("</code>", start);
    regions.push({ start, end: close === -1 ? html.length : close });
  }
  return regions;
}

/** Is `index` inside one of `regions`? Binary search; `regions` comes back in
 *  document order from {@link renderedCodeRegions}, which is what that needs. */
export function inRenderedCode(regions: readonly RenderedCodeRegion[], index: number): boolean {
  let lo = 0;
  let hi = regions.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = regions[mid]!;
    if (index < r.start) hi = mid - 1;
    else if (index >= r.end) lo = mid + 1;
    else return true;
  }
  return false;
}
