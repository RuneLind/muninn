/**
 * The `[n]` REPAIR — a deterministic post-pass over the GENERATED draft.
 *
 * **Why it exists.** The prompt used to instruct the model to mark claims with
 * `[n]`, while `## Referanser` is appended server-side as an unnumbered,
 * key-deduped list over the depth slice. The two never met: measured on a real
 * `Skisse` draft, the body carried `[5]`, `[4]`, `[6]` and `[7]` and the paste
 * had nothing to resolve them against — a Jira description shipping dangling
 * footnote numbers. The instruction is gone (`prompt.ts` now asks for the key or
 * the title in prose), and this is the backstop for a model that emits them
 * anyway.
 *
 * **A safety net over MODEL output, and nothing else.** It runs on exactly one
 * path — `finalizeJiraDraft`, over the text the draft turn just produced — and
 * nothing else in the feature may adopt it: a pass that silently edits text a
 * HUMAN wrote is a bug however careful it is. (The reader-edit route that once
 * ran it, `PUT /api/jira/draft/:id`, was wrong in a second way too: it bounded
 * the strip by the STORED hit set — up to 24 — while generation bounds it by
 * `citationsUsed`, 6–8 on this corpus, so saving deleted `[9]`–`[23]` the reader
 * had been reading all along. The route is gone; the rule outlives it.)
 *
 * **A repair, not a lint.** It flags nothing and reports nothing: unlike
 * `markdown-check.ts`, whose whole point is that a construct Jira will not
 * convert must be seen by a human, a dangling marker has exactly one correct
 * resolution — delete it — and there is nothing for the reader to decide.
 *
 * **Only markers it can PROVE are markers.** The proof obligations below were
 * each written from a measured corruption on a real Norwegian draft (the cases
 * are the `citation-markers.test.ts` corruption set, verbatim):
 *
 *   · `n` between 1 and the number of citations the model was actually GIVEN
 *     (`citationsUsed`) — what keeps `artikkel [13] i forordning 883/2004` and a
 *     literal `[2024]` in the text;
 *   · never inside code — fenced or inline — which is what stopped
 *     ` ```kotlin val navn = deler[1]``` ` and `` `args[1]` `` coming back
 *     mangled. The masking is `markdown-scan.ts`'s, the same same-length maskers
 *     `verify-keys.ts` and `markdown-check.ts` run;
 *   · never glued to a word on its left (`liste[2]`, `lovvalg[1]`) — that is an
 *     index expression, not a citation;
 *   · never followed directly by `(` or `:` — `[1](https://x.no)` is a link and
 *     `[1]: https://x.no` is its reference definition, and eating the `[1]` left
 *     a bare `(https://x.no)`;
 *   · never preceded by `[`, `]`, `!` or `^` — the other halves of the same
 *     markdown constructs (`[lenke][1]`, `![1](…)`, `[^1]`);
 *   · never alone on its line — removing it leaves a blank line where the source
 *     had a paragraph, and the only alternative is collapsing a newline, which
 *     this pass never does.
 *
 * The residual is accepted: a hallucinated `[7]` over 6 citations survives,
 * because from here it is indistinguishable from an ordinary bracketed number,
 * and the instruction change is what stops it being produced.
 *
 * Pure and IO-free, like its `src/jira/` siblings.
 */

import { maskFencedCode, maskInlineCode } from "./markdown-scan.ts";

/** One `[n]`, found on the MASKED text so code can never supply one. */
const ONE_MARKER_RE = /\[(\d+)\]/g;

/** Horizontal whitespace only — a newline is never consumed by the repair. */
const HSPACE = /[ \t]/;

/**
 * A character that, sitting immediately before a `[`, proves the bracket is part
 * of something else — ANY non-whitespace: a word (`liste[2]`), the second half
 * of a reference link (`[lenke][1]`), an image (`![1](…)`), a footnote (`[^1]`),
 * an emphasis closer (`**viktig**[1]`) or an opening bracket (`([1])`, `«[1]»`).
 * A citation marker the model writes in prose is always preceded by a space or
 * a line start; an allow-list of letters left `**viktig**[1] og` → `**viktig**og`.
 */
const GLUED_LEFT = /[^ \t\r\n]/u;

interface Marker {
  start: number;
  end: number;
  n: number;
}

export function stripCitationMarkers(markdown: string, citationsUsed: number): string {
  if (citationsUsed <= 0) return markdown;

  // Same-length masking, so every offset found here is valid in the original.
  const masked = maskInlineCode(maskFencedCode(markdown));

  const markers: Marker[] = [];
  ONE_MARKER_RE.lastIndex = 0;
  for (let m = ONE_MARKER_RE.exec(masked); m; m = ONE_MARKER_RE.exec(masked)) {
    markers.push({ start: m.index, end: m.index + m[0].length, n: Number(m[1]) });
  }
  if (markers.length === 0) return markdown;

  // ── Group into RUNS (`[1][2][3]`, or `[1] [2]`) ───────────────────────────
  // A run is judged as a unit: only its FIRST marker can be "glued left" and only
  // its LAST can be followed by a link paren, and a per-marker pass would strip
  // `[1]` first and then find `[2]` glued to the `t` of `grunnlaget`.
  const runs: Marker[][] = [];
  for (const marker of markers) {
    const current = runs[runs.length - 1];
    const previous = current?.[current.length - 1];
    if (previous && isAllHSpace(markdown, previous.end, marker.start)) current!.push(marker);
    else runs.push([marker]);
  }

  const out: string[] = [];
  let cursor = 0;
  for (const run of runs) {
    const first = run[0]!;
    const last = run[run.length - 1]!;

    // How much horizontal whitespace hugs the run, in the ORIGINAL text.
    let beforeStart = first.start;
    while (beforeStart > 0 && HSPACE.test(markdown[beforeStart - 1]!)) beforeStart--;
    let afterEnd = last.end;
    while (afterEnd < markdown.length && HSPACE.test(markdown[afterEnd]!)) afterEnd++;

    if (!isRemovableRun(markdown, run, beforeStart, afterEnd)) continue;

    const kept = run.filter((mk) => !(mk.n >= 1 && mk.n <= citationsUsed));
    if (kept.length === run.length) continue; // nothing in the run is ours

    if (kept.length > 0) {
      // A partial run keeps its own whitespace and drops only our markers.
      out.push(markdown.slice(cursor, first.start));
      out.push(kept.map((mk) => markdown.slice(mk.start, mk.end)).join(""));
      cursor = last.end;
      continue;
    }
    // Whole run goes, plus AT MOST one adjacent space — from the left when there
    // is one, so two words can never end up joined and a lone trailing space is
    // not left dangling either.
    const hadBefore = beforeStart < first.start;
    const hadAfter = afterEnd > last.end;
    out.push(markdown.slice(cursor, hadBefore ? first.start - 1 : first.start));
    cursor = !hadBefore && hadAfter ? last.end + 1 : last.end;
  }
  if (cursor === 0) return markdown;
  out.push(markdown.slice(cursor));
  return out.join("");
}

/** Is `[from, to)` nothing but spaces and tabs? */
function isAllHSpace(text: string, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (!HSPACE.test(text[i]!)) return false;
  return true;
}

/**
 * The proof obligations, judged on the ORIGINAL text around one run.
 *
 * Every `false` here is a measured corruption this pass used to ship; the
 * reasoning for each lives in the module header.
 */
function isRemovableRun(
  markdown: string,
  run: Marker[],
  beforeStart: number,
  afterEnd: number,
): boolean {
  const first = run[0]!;
  const last = run[run.length - 1]!;

  // Glued to a word / another bracket construct on the left.
  if (beforeStart === first.start && first.start > 0 && GLUED_LEFT.test(markdown[first.start - 1]!)) {
    return false;
  }
  // A link or a reference definition — `(` / `:` DIRECTLY after the `]`.
  const nextDirect = markdown[last.end];
  if (nextDirect === "(" || nextDirect === ":") return false;

  // Alone on its line: removing it leaves a blank line mid-paragraph.
  const lineStart = markdown.lastIndexOf("\n", beforeStart - 1) + 1;
  const lineEnd = markdown.indexOf("\n", afterEnd);
  const head = markdown.slice(lineStart, beforeStart);
  const tail = markdown.slice(afterEnd, lineEnd === -1 ? markdown.length : lineEnd);
  if (!head.trim() && !tail.trim()) return false;

  return true;
}
