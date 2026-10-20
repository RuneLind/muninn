/**
 * How an `aliases:` entry is read: as a page's old PATH, as a bare STEM, or
 * not at all.
 *
 * IO-free, and the one reading both sides use: the server
 * (`aliasWorkedPaths` in `store.ts`) and the browser's boundary resolver
 * (`wiki-work-boundaries.ts`) call `classifyAliasRef`, so given the same
 * top-level folders they cannot read an alias differently (arch review
 * 2026-10, finding 85). The folder set is each side's own: the server reads
 * the root's directories, the resolver the first segments of its page list,
 * so the two differ only on a folder that holds no listed page.
 */

/** `[[plans/old|Label]]`, `[[plans/old#x]]`, ` ./plans\old ` → `plans/old`.
 *  Only a `[[…]]` wikilink has a `|label` and a `#anchor` to drop; a plain
 *  alias keeps `#` and `|` as text (`The #1 Mistake` stays whole).
 *  Backslashes become `/` and a leading `./` goes. Empty when nothing is left. */
export function unwrapAliasRef(alias: string): string {
  let v = alias.trim();
  if (v.startsWith("[[") && v.endsWith("]]")) v = v.slice(2, -2).split("|")[0]!.split("#")[0]!;
  return v.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

export type AliasRef =
  /** An old path, as unwrapped (case kept). `ext`: it spells `.md`/`.mdx`/`.html`. */
  | { kind: "path"; path: string; ext: boolean }
  /** A bare name with no slash and no page extension. */
  | { kind: "stem"; stem: string }
  /** Empty, or a title holding a `/` whose first segment is no top-level folder. */
  | { kind: "none" };

/**
 * Path-shaped: a `/`-holding alias whose first segment is a top-level folder
 * (`topDirs`, lower-cased), or a name spelling `.md`/`.mdx`/`.html` — the only
 * way a root-level move (`old-plan.md`) names itself. A `/`-holding alias that
 * is not path-shaped (`/goal`, `openai/math Repository`, `ω ≤ 9/4`) is a
 * title, and reads as nothing: no stem candidate either.
 */
export function classifyAliasRef(alias: string, topDirs: ReadonlySet<string>): AliasRef {
  const v = unwrapAliasRef(alias);
  if (!v) return { kind: "none" };
  const ext = /\.(?:mdx?|html)$/i.test(v);
  const slash = v.indexOf("/");
  if (slash !== -1) return topDirs.has(v.slice(0, slash).toLowerCase()) ? { kind: "path", path: v, ext } : { kind: "none" };
  return ext ? { kind: "path", path: v, ext } : { kind: "stem", stem: v };
}
