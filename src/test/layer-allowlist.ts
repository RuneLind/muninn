/**
 * The allowlist side of the import-direction ratchet (`src/test/layers.ts`), with no
 * imports, so CI's `--check-base` job runs it without `bun install`.
 */

export function parseAllowlist(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
}

/** Entries the head's allowlist has that the base's does not. */
export function addedAllowlistLines(baseText: string, headText: string): string[] {
  const base = new Set(parseAllowlist(baseText));
  return [...new Set(parseAllowlist(headText).filter((l) => !base.has(l)))].sort();
}

/** What `git` returned for the base: a missing commit, a commit without the list, or its text. */
export type BaseAllowlist = { kind: "bad-ref" } | { kind: "no-file" } | { kind: "text"; text: string };

export type GitRun = (args: string[]) => { exitCode: number; stdout: string };

export function readBaseAllowlist(ref: string, relPath: string, git: GitRun): BaseAllowlist {
  if (git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).exitCode !== 0) return { kind: "bad-ref" };
  const shown = git(["show", `${ref}:${relPath}`]);
  return shown.exitCode === 0 ? { kind: "text", text: shown.stdout } : { kind: "no-file" };
}

export interface Verdict {
  /** 0 pass, 1 the list grew, 2 the ref is not a commit. */
  code: 0 | 1 | 2;
  lines: string[];
}

export function baseCheckVerdict(ref: string, relPath: string, base: BaseAllowlist, headText: string): Verdict {
  if (base.kind === "bad-ref") return { code: 2, lines: [`--check-base: ${ref} is not a commit`] };
  // Only the PR that introduces the list meets this.
  if (base.kind === "no-file") return { code: 0, lines: [`--check-base: ${ref} has no ${relPath}; nothing to compare`] };
  const added = addedAllowlistLines(base.text, headText);
  if (added.length === 0) return { code: 0, lines: [`--check-base: ${relPath} adds no entry over ${ref}`] };
  return {
    code: 1,
    lines: [
      `::error::${relPath} adds ${added.length} upward import(s) over ${ref}. The list only shrinks: remove the import, or merge it as a reviewed exception whose reason the PR body states.`,
      ...added.map((l) => `  added: ${l}`),
    ],
  };
}
