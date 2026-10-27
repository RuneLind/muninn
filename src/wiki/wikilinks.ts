/**
 * The `[[wikilink]]` scanner, in a module with no IO and no imports, so the
 * index (`store.ts`) and the frontmatter list readers (`frontmatter-lists.ts`)
 * share one scanner without importing each other.
 */

/**
 * A `[[wikilink]]`, target and alias both NEWLINE-FREE. Obsidian has no
 * multi-line wikilink, and without the `\n` exclusion an unclosed `[[` (an
 * index one-liner truncated mid-link, say) matched across the line break and
 * consumed the NEXT line's link. Measurements: `src/watchers/CLAUDE.md`
 * (`index-truncation`) owns those numbers.
 *
 * FIVE sibling copies of this shape carry the same exclusion, each for its own
 * consumer: `render.ts`, `digest.ts`, `graph-routes.ts`, `draft.ts`'s
 * `CONTAIN_BODY_RE`, and the two flatteners in `store.ts` (which share one). The sixth was
 * the fact-check annotate pass, and it is now the exported SOURCE
 * `WIKILINK_SPAN_SOURCE` (`dashboard/views/components/wiki-integrate.ts`) — the
 * side of the split that has to answer "is this a link?" rather than "which pages
 * does this page name", so it also rejects a candidate spanning a dangling `[[`
 * (`store.ts`'s `firstDanglingWikilinkOpen` rule) and scans a code-span-masked line.
 * This copy stays a copy: the index must not import a dashboard module.
 */
export const WIKILINK_RE = /\[\[([^\]|\n]+?)(?:\|[^\]\n]*?)?\]\]/g;

/**
 * Extract deduped [[wikilink]] targets from raw file content (frontmatter
 * included). Obsidian-style `#anchor` fragments are stripped — `[[Page#Section]]`
 * targets the page (mirroring extractMarkdownLinks' anchor handling), and a bare
 * `[[#anchor]]` is a same-page reference, not a link. Backslash escapes that
 * markdown processors leave in the raw text (e.g. `Page\` from an escaped `\]]`)
 * are dropped so the target matches the page name it refers to.
 */
export function extractWikilinks(content: string): string[] {
  const targets = new Set<string>();
  for (const m of content.matchAll(WIKILINK_RE)) {
    const target = wikilinkTarget(m[1]!);
    if (target) targets.add(target);
  }
  return [...targets];
}

/** One {@link WIKILINK_RE} capture as {@link extractWikilinks} reads it:
 *  escapes and `#anchor` dropped; undefined for a bare `[[#anchor]]` (a
 *  same-page reference) or an empty target. */
export function wikilinkTarget(raw: string): string | undefined {
  let target = raw.replace(/\\/g, "").trim();
  const hash = target.indexOf("#");
  if (hash === 0) return undefined;
  if (hash > 0) target = target.slice(0, hash).trim();
  return target || undefined;
}
