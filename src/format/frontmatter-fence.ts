/**
 * Where a page's frontmatter ends, moved down from `src/wiki/page-text.ts`
 * (architecture review 2026-11, B2) so `question-close.ts` reads it without
 * importing wiki code. `page-text.ts` re-exports `frontmatterBodyLine` and its
 * `splitFrontmatter` reads the same fence through `closingFenceAt`.
 */

/** The offset of the `\n` before the closing fence, or -1 for a page with no
 *  frontmatter. A closing fence starts at column 0, so an indented `---` inside
 *  a block scalar does not end the block. */
export function closingFenceAt(content: string): number {
  return content.startsWith("---") ? content.indexOf("\n---", 3) : -1;
}

/**
 * The 0-based line the body starts on — the line after the closing fence
 * `splitFrontmatter` (`src/wiki/page-text.ts`) finds — or 0 for a page with no
 * frontmatter. The line-indexed form of the same boundary, for readers that walk
 * lines: the `owns:`/`related:` readers and lint check 14. `frontmatterEndLine`
 * (`wiki-integrate.ts`) is an older rule that also ends at an indented `---`;
 * the fact-check paths and the other line-walking lint checks (9, 10, 11, 12,
 * 16 and the index-truncation and fact-mark checks) still read it, so the
 * linter has two frontmatter boundaries.
 */
export function frontmatterBodyLine(content: string): number {
  const end = closingFenceAt(content);
  if (end === -1) return 0;
  let closer = 0;
  for (let i = content.indexOf("\n"); i !== -1 && i <= end; i = content.indexOf("\n", i + 1)) closer++;
  return closer + 1;
}
