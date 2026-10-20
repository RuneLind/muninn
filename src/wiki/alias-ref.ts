/**
 * How an `aliases:` entry is read: as a page's old PATH, as a bare STEM, or
 * not at all.
 *
 * IO-free, and the one reading both sides use: the server's worked date and
 * work facts and the browser's boundary resolver (`wiki-work-boundaries.ts`)
 * both take a path alias's keys from `aliasWorkedPaths`, normalized by
 * `normalizeWorkedPath` (posix normalize, leading-slash strip, lower case,
 * NFC), and look a stored path up in that same spelling — so given the same
 * top-level folders they fold an alias onto the same paths, whatever the
 * spelling (`plans//old`, `plans/./old`, an NFD name; arch review 2026-10,
 * findings 74/85). Both build the folder set with `aliasTopDirs`: the server
 * from the root's directories, the resolver from the first segments of its
 * page list, so the two differ only on a folder that holds no listed page.
 * A bare STEM is the resolver's alone: the server folds no stem.
 */

import { normalizeWorkedPath } from "./rel-path.ts";

/** Top-level folder names as `classifyAliasRef` compares them: lower case, NFC. */
export function aliasTopDirs(names: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const n of names) if (n) out.add(n.toLowerCase().normalize("NFC"));
  return out;
}

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
 * (`topDirs`, from `aliasTopDirs`), or a name spelling `.md`/`.mdx`/`.html` — the only
 * way a root-level move (`old-plan.md`) names itself. A `/`-holding alias that
 * is not path-shaped (`/goal`, `openai/math Repository`, `ω ≤ 9/4`) is a
 * title, and reads as nothing: no stem candidate either.
 */
export function classifyAliasRef(alias: string, topDirs: ReadonlySet<string>): AliasRef {
  const v = unwrapAliasRef(alias);
  if (!v) return { kind: "none" };
  const ext = /\.(?:mdx?|html)$/i.test(v);
  const slash = v.indexOf("/");
  if (slash !== -1) return topDirs.has(v.slice(0, slash).toLowerCase().normalize("NFC")) ? { kind: "path", path: v, ext } : { kind: "none" };
  return ext ? { kind: "path", path: v, ext } : { kind: "stem", stem: v };
}

/**
 * The worked-ledger keys an `aliases:` entry can stand for — the page's OLD
 * path, when it was moved — in `normalizeWorkedPath`'s spelling: a path alias
 * with no extension tries `.md` then `.mdx`; a spelled extension is used as
 * written; a stem or a title answers nothing. The server folds these keys
 * into a page's worked date and work facts, and the boundary resolver looks a
 * stored path up among them.
 */
export function aliasWorkedPaths(alias: string, topDirs: ReadonlySet<string>): string[] {
  const ref = classifyAliasRef(alias, topDirs);
  if (ref.kind !== "path") return [];
  if (ref.ext) return [normalizeWorkedPath(ref.path)];
  return [normalizeWorkedPath(`${ref.path}.md`), normalizeWorkedPath(`${ref.path}.mdx`)];
}
