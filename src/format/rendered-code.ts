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
 *    brackets — an OVER-skip, the failure direction this guard must not have.
 *  - **A fence delimiter that starts or ends mid-line.** The renderer replaces
 *    the fence with a placeholder and joins the text either side onto ONE line,
 *    where two lone backticks then pair; a line-wise scanner sees neither.
 *
 * ⚠️ **What it costs to read the output instead: this module has to know EVERY
 * container the renderer uses for code, and there are two — not one.** The first
 * revision assumed `<code>`, which is wrong twice over, and both were found by
 * review rather than by reasoning:
 *
 *  - **`<Diff>` emits no `<code>` at all.** Its fence becomes
 *    `<div class="diff-line …">` per line (`web-format.ts`), so a `<code>`-only
 *    scan reported no code and a wikilink inside a diff came back as a live link
 *    — a REGRESSION against the markdown-side scanner, which matched the raw
 *    ```` ```diff ```` fence wherever it sat. `<Diff>` is live in mimir today.
 *  - **`<code>` NESTS.** `<FileRef>` wraps its already-rendered inline children
 *    in `<code class="fileref">`, so `` <FileRef>`a` [[P]]</FileRef> `` yields a
 *    `<code>` inside a `<code>` — and pairing an open tag with the NEXT `</code>`
 *    closed the outer region at the inner's close, leaving the rest of the
 *    FileRef outside every region. An earlier revision of this comment asserted
 *    non-nesting as "a property of the renderer rather than an assumption". It
 *    was neither; it was wrong.
 *
 * The container set is therefore pinned by a DERIVED test rather than by this
 * list being kept up to date by hand: `rendered-code.test.ts` renders a probe
 * inside a fence and inside a backtick span for EVERY name in `COMPONENT_NAMES`
 * and asserts the probe lands in a region, so a component that introduces a
 * third container fails there instead of silently in a reader's browser.
 */

/** A half-open `[start, end)` span of rendered HTML that is code. */
export interface RenderedCodeRegion {
  start: number;
  end: number;
}

/** `<code …>` and `</code>`, in one scan, so nesting can be tracked. */
const CODE_TAG_RE = /<code\b[^>]*>|<\/code>/g;

/**
 * `<Diff>`'s per-line container — the one code shape that is not a `<code>`.
 * Its body is `escapeHtml(line)`, so it holds no nested tags and the next
 * `</div>` is always its own.
 */
const DIFF_LINE_RE = /<div class="diff-line[^"]*">/g;

/**
 * The body of every code container in `html`, in document order, OUTERMOST only.
 *
 * Nesting is real (`<FileRef>` — see the header), so `<code>` is depth-tracked
 * and an inner span is simply inside its parent's region; emitting only the
 * outermost keeps `inRenderedCode` a plain containment test.
 *
 * An unclosed container (which the renderer does not produce) runs to the end of
 * the document: the conservative direction, since treating prose as code costs a
 * link that renders as its own brackets, while the reverse costs the source.
 */
export function renderedCodeRegions(html: string): RenderedCodeRegion[] {
  const regions: RenderedCodeRegion[] = [];

  let depth = 0;
  let start = -1;
  for (const m of html.matchAll(CODE_TAG_RE)) {
    if (m[0] === "</code>") {
      if (depth === 0) continue; // stray close — not ours to pair
      depth--;
      if (depth === 0) {
        regions.push({ start, end: m.index });
        start = -1;
      }
      continue;
    }
    if (depth === 0) start = m.index + m[0].length;
    depth++;
  }
  if (depth > 0 && start >= 0) regions.push({ start, end: html.length });

  for (const m of html.matchAll(DIFF_LINE_RE)) {
    const bodyStart = m.index + m[0].length;
    const close = html.indexOf("</div>", bodyStart);
    regions.push({ start: bodyStart, end: close === -1 ? html.length : close });
  }

  // `<code>` regions come out in document order and the diff pass appends its
  // own afterwards — sorted so `inRenderedCode` can binary-search.
  return regions.sort((a, b) => a.start - b.start);
}

/** Is `index` inside one of `regions`? Binary search; `regions` comes back
 *  sorted and non-overlapping from {@link renderedCodeRegions}. */
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
