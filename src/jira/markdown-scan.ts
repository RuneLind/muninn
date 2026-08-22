/**
 * The one fenced-code scanner both post-passes run on.
 *
 * `verify-keys.ts` and `markdown-check.ts` each walk the generated markdown
 * looking for things to flag, and both must ignore fenced code — a `MELOSYS-123`
 * in a code excerpt is not a citation, and a `<div>` in one is not raw HTML the
 * paste will mangle. Two independent fence walks would be two things to drift,
 * and the wiki side already learned what a fence-walk bug costs
 * (`scanClaimLines` in `wiki-integrate.ts`, whose whole layered contract exists
 * because "any line starting with ```" silently swallowed half a document).
 *
 * **Masking is SAME-LENGTH.** Every code unit inside a fenced region becomes a
 * space (newlines preserved), so offsets and line numbers computed on the mask
 * are valid on the original. Removing the regions instead would splice text into
 * adjacency and let a match span a seam that does not exist.
 */

/** The CommonMark fence shape, judged on the RAW line. */
interface FenceOpener {
  marker: "`" | "~";
  length: number;
  indent: number;
}

/**
 * Does this line OPEN a fence?
 *
 * ≤3 leading spaces, a run of ≥3 backticks or tildes, and — on a backtick fence —
 * an info string carrying no backtick. The last clause is what stops a prose line
 * of inline code (`` `code` ``, or ```` ```x``` ```` on one line) reading as an
 * opener that never closes.
 */
export function fenceOpener(line: string): FenceOpener | null {
  const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  const marker = m[2]![0] as "`" | "~";
  const info = m[3] ?? "";
  if (marker === "`" && info.includes("`")) return null;
  return { marker, length: m[2]!.length, indent: m[1]!.length };
}

/** Does this line CLOSE the given opener? Same marker, at least as long, nothing else. */
export function fenceCloser(line: string, opener: FenceOpener): boolean {
  const m = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(line);
  if (!m) return false;
  return m[2]![0] === opener.marker && m[2]!.length >= opener.length;
}

/**
 * Replace every fenced-code region with same-length blanks.
 *
 * An UNCLOSED fence at EOF is deliberately NOT believed to run to the end of the
 * document (CommonMark's rule, and precisely the runaway-masking failure): the
 * dangling opener is treated as ordinary text and the rest of the document stays
 * scannable. Under-masking costs one spurious flag the reader can dismiss;
 * over-masking silently hides every fabricated key below the stray backtick.
 */
export function maskFencedCode(markdown: string): string {
  const lines = markdown.split("\n");
  const out = lines.slice();
  let i = 0;
  while (i < lines.length) {
    const opener = fenceOpener(lines[i]!);
    if (!opener) { i++; continue; }
    // Find the closer before committing to the mask.
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (fenceCloser(lines[j]!, opener)) { close = j; break; }
    }
    if (close === -1) { i++; continue; }
    for (let j = i; j <= close; j++) out[j] = " ".repeat(lines[j]!.length);
    i = close + 1;
  }
  return out.join("\n");
}

/**
 * Replace every INLINE code span with same-length blanks.
 *
 * Same contract as {@link maskFencedCode} and the same reason: a reader who
 * writes `` `<div>` `` or `` `h2.` `` in prose is NAMING the construct, not
 * emitting it, and flagging that is the denylist-noise failure — a reader who
 * learns to ignore the flags is a reader the pass no longer protects.
 *
 * Deliberately LINE-SCOPED (`[^`\n]*`) where CommonMark allows a code span to
 * cross lines: an unbalanced backtick in prose would otherwise pair with one
 * paragraphs away and blank out everything between them. Under-masking costs one
 * spurious flag the reader dismisses; over-masking hides real breakage.
 *
 * Runs on the ALREADY fence-masked text in both callers, so a fence's own
 * backticks are gone by the time this sees them.
 */
export function maskInlineCode(text: string): string {
  const out = text.split("");
  for (const m of text.matchAll(/(`+)([^`\n]*)\1(?!`)/g)) {
    for (let i = m.index; i < m.index + m[0].length; i++) {
      if (out[i] !== "\n") out[i] = " ";
    }
  }
  return out.join("");
}

/** 1-based line number of a character offset. */
export function lineOfOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}
