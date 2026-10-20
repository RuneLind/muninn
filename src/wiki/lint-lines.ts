/**
 * The line search the page-text lint checks share (11, 16, 17): a finding is
 * placed on the first line outside a code fence that its test accepts.
 */

/** The 1-based line of the first unfenced line at or after `from` (0-based)
 *  that `test` accepts; undefined when none does. */
export function findUnfencedLine(
  lines: readonly string[],
  fenced: readonly boolean[],
  from: number,
  test: (line: string) => boolean,
): number | undefined {
  for (let i = from; i < lines.length; i++) if (!fenced[i] && test(lines[i]!)) return i + 1;
  return undefined;
}
