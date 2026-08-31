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
 *  - **A line SHAPED like a fence delimiter that is not one.** A run of
 *    backticks that does not start its line, or whose info string holds a
 *    backtick, opens no fenced block (CommonMark), so the line stays PROSE and
 *    its own backticks pair into an inline span. A line-wise scanner reads the
 *    same line as a delimiter and puts the region somewhere else entirely.
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
 * The code in `html`, as MAXIMAL DISJOINT spans in document order.
 *
 * ⚠️ **Disjoint by CONSTRUCTION, not by assumption.** `inRenderedCode` binary-
 * searches this, which is only sound on non-overlapping intervals — and the two
 * containers really do overlap: a `<Diff>` inside a `<FileRef>` puts several
 * `diff-line` regions inside one `<code>` region, and with them left in, the
 * search walked straight past the containing outer span and answered FALSE for a
 * position plainly inside it (measured). So the halves are collected separately
 * and then MERGED. An earlier revision documented "outermost only, sorted and
 * non-overlapping" and simply pushed both lists — the same unearned-invariant
 * mistake this module's header was already corrected for once.
 *
 * `<code>` nesting is handled by depth-tracking (a `<FileRef>` wraps rendered
 * children, so an inline span inside it is a `<code>` in a `<code>`); the merge
 * then absorbs anything the diff pass adds inside one.
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

  return mergeRegions(regions);
}

/**
 * Sort and merge into maximal disjoint spans.
 *
 * Both steps are load-bearing and both are PINNED, each by a test that fails
 * when it is removed: without the SORT, a `<Diff>` followed by an ordinary fence
 * leaves the fence's region ahead of the diff's in the array, the merge folds
 * them into the LATER span and the diff is silently dropped. Without the MERGE,
 * a `diff-line` inside a `<code>` sits inside its parent and the binary search
 * walks past the parent.
 *
 * TWO clauses here are DEFENSIVE rather than load-bearing, and both say so
 * rather than being justified by a scenario. Measured over 1562 corpus pages —
 * 72 043 raw regions — the adjacent-pair classes are `disjoint` and `nested`
 * only: **zero** touching and **zero** partially-overlapping pairs, because two
 * container bodies are always separated by at least a closing plus an opening
 * tag. So:
 *   · `start <= last.end` rather than `<` covers TOUCHING spans — unreachable
 *     here. An earlier spelling justified it with "adjacent code with nothing
 *     between it", a shape this renderer cannot emit.
 *   · `Math.max(last.end, r.end)` rather than `r.end` covers a PARTIAL overlap,
 *     where the absorbed span ends first — equally unreachable. Only the other
 *     direction is pinned: `→ r.end` truncates a NESTED span's parent and
 *     reddens the `<Diff>`-inside-`<FileRef>` test; `→ last.end` leaves the
 *     suite green. A round-4 commit message claimed both directions redden;
 *     they do not.
 * Both are kept because merging touching and overlapping intervals is what makes
 * the output disjoint for ANY input, which is the property `inRenderedCode`'s
 * binary search actually needs — and an unreachable branch that upholds a stated
 * invariant is cheaper than a reachable one that quietly does not.
 *
 * ⚠️ MUTATES the region objects it is given (`last.end = …`), and returns the
 * caller's OWN array when handed fewer than two regions — the `length < 2`
 * guard, not "when nothing merged". A fully disjoint input of two or more still
 * returns a FRESH array holding the caller's objects, so identity is not a
 * did-anything-change signal. (The first spelling of this line said "when there
 * is nothing to merge", which is exactly the reuse a future caller would branch
 * on and exactly the case where it is false.) Contained today — the one caller
 * builds the array locally and hands it over.
 */
function mergeRegions(regions: RenderedCodeRegion[]): RenderedCodeRegion[] {
  if (regions.length < 2) return regions;
  // No tiebreak on `end`: `Math.max` below makes the result order-independent
  // for two regions sharing a `start`, so a second comparator was inert — a
  // clause with no test and no effect, on a module whose whole subject is not
  // asserting what has not been earned.
  const sorted = regions.slice().sort((a, b) => a.start - b.start);
  const out: RenderedCodeRegion[] = [sorted[0]!];
  for (const r of sorted.slice(1)) {
    const last = out[out.length - 1]!;
    if (r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push(r);
  }
  return out;
}

/** Is `index` inside one of `regions`? Binary search — sound because
 *  {@link renderedCodeRegions} returns maximal DISJOINT spans; see the merge
 *  there for why that is a construction rather than a claim. */
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
