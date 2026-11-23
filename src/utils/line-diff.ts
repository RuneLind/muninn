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

/** The `…` line a trimmed run of context collapses to. Deliberately a `ctx`
 *  line, so the renderer needs no fourth type and the elision is VISIBLE — a
 *  silently shortened diff is a diff nobody can trust. */
export const DIFF_ELISION = "…";

/**
 * Keep every changed line plus `radius` context lines around it, collapsing the
 * runs in between to one {@link DIFF_ELISION} line.
 *
 * `lineDiff` emits FULL context — every unchanged line of the file — which is
 * right for a drafted page, where the reviewer is reading a new document. A
 * `lint` row is one frontmatter line on a page that is already in the wiki, and
 * the gate ships one of these per touched page: measured on a 547-page mimir
 * clone, 153 lint rows shipped **4.66 MB**, of which **4.47 MB** was context
 * lines for pages the reviewer can open in the reader.
 *
 * A diff with no changed line at all is returned unchanged — that is the
 * "no diff" state the card renders its own sentence for, and trimming it to a
 * lone `…` would replace one honest empty state with a misleading one.
 */
export function trimDiffContext(lines: readonly DiffLine[], radius = 3): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.type === "ctx") continue;
    changed = true;
    for (let j = Math.max(0, i - radius); j <= Math.min(lines.length - 1, i + radius); j++) {
      keep[j] = true;
    }
  }
  if (!changed) return [...lines];

  const out: DiffLine[] = [];
  let elided = false;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      out.push(lines[i]!);
      elided = false;
      continue;
    }
    if (!elided) {
      out.push({ type: "ctx", text: DIFF_ELISION });
      elided = true;
    }
  }
  return out;
}
