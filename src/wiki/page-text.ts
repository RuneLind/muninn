/**
 * The two primitives a wiki page's BYTES are read with, in a module that imports
 * nothing — so both sides of the `store.ts` ↔ `git-dates.ts` edge can use them.
 *
 * `store.ts` imports `git-dates.ts` (the index build asks for a page's git
 * dates), so `git-dates.ts` importing `store.ts` back for its frontmatter split
 * would be a cycle. The split is the one rule that must not be spelled twice —
 * "where does this page's frontmatter end" decides both what `parseFrontmatter`
 * reads and which changed lines the metadata-only rule is allowed to forgive, and
 * two copies would drift on exactly the pages where it matters. Same precedent as
 * `src/dashboard/route-groups.ts`, which exists because a view importing the route
 * factory would be a cycle.
 *
 * Both functions are re-exported from `store.ts`, so its importers are untouched.
 */

/** A page split at its frontmatter fence. `frontmatter` is `null` for a page that
 *  has none — there is no fence, so there is nothing to have been written into —
 *  and `body` is then the whole content. */
export interface FrontmatterSplit {
  /** The frontmatter block's own lines, between the two `---` fences, fences
   *  excluded and no trailing newline. `null` when the page has no fence. */
  frontmatter: string | null;
  /** Everything after the closing fence line. The whole content when there is no
   *  fence; `""` when the closing fence is the last line of the file. */
  body: string;
}

/**
 * Split a page at its frontmatter fence: a leading `---` and a closing `---` at
 * column 0. The same fence detection `parseFrontmatter` has always used — it is
 * that function's own first two statements, hoisted — so a page the parser reads
 * as having frontmatter is exactly a page this reports a block for.
 *
 * Not a YAML parse and deliberately not one: the callers are a key-shape parser
 * and a line comparison, and both want the block's raw bytes.
 */
export function splitFrontmatter(content: string): FrontmatterSplit {
  if (!content.startsWith("---")) return { frontmatter: null, body: content };
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: null, body: content };
  const frontmatter = content.slice(content.indexOf("\n") + 1, end);
  // `end` points at the `\n` before the closing `---`; skip to the newline that
  // ends the closing fence line, and the body is everything after it.
  const afterFence = content.indexOf("\n", end + 1);
  return { frontmatter, body: afterFence === -1 ? "" : content.slice(afterFence + 1) };
}

/**
 * Is this a MARKDOWN wiki page (`.md` or `.mdx`) rather than a standalone `.html`
 * explainer? The one spelling of that test, so "which pages share one title
 * namespace" cannot be answered two ways. Callers: `store.ts`'s `resolve()` and
 * the display-title pass, the linter's `stem-collision` check, and the
 * metadata-only rule in `git-dates.ts` (nothing but a markdown page carries
 * frontmatter, so nothing else can be a metadata write).
 *
 * **The case fold is defensive and currently unreachable**, which is worth stating
 * because the name invites the opposite reading. `resolve()` lowercases its target
 * before calling; the linter passes a raw on-disk relPath, but that path reached
 * the index through the case-SENSITIVE discovery glob (`**​/*.{md,mdx,html}`), so no
 * indexed page carries an uppercase extension in the first place. It is kept so the
 * predicate answers the question its name asks for any path a future caller hands
 * it, and pinned in `store.test.ts` / `lint.test.ts` so that stays deliberate.
 */
export function isMarkdownWikiPath(relPath: string): boolean {
  const l = relPath.toLowerCase();
  return l.endsWith(".md") || l.endsWith(".mdx");
}
