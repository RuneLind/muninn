/**
 * Dependency-free line diff for the wiki-gardener review gate — shows what an
 * `update`-mode proposal changes about the current page. A classic LCS line diff
 * (Myers is overkill for two small markdown files); good enough to eyeball a draft.
 */

export type DiffLineType = "ctx" | "add" | "del";

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

/**
 * Compute a line-level diff of `oldText` → `newText`. Returns an ordered list of
 * lines tagged context / added / deleted. Trailing newlines are normalized away
 * so a file with/without a final newline doesn't produce a spurious blank line.
 */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  // LCS length table (a.length+1 × b.length+1).
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "ctx", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ type: "del", text: a[i]! });
      i++;
    } else {
      out.push({ type: "add", text: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++]! });
  while (j < m) out.push({ type: "add", text: b[j++]! });
  return out;
}

function splitLines(text: string): string[] {
  const t = text.replace(/\n+$/, "");
  return t === "" ? [] : t.split("\n");
}
