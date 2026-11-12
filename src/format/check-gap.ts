/**
 * The spacing around an inline `<Check …/>`, shared by every renderer: the tag
 * prints nothing on a text surface and a zero-width slot in the reader, so the
 * words around it keep the spacing they would have without it. Browser-safe
 * (the reader's `web-format.ts` runs it); the typed read of the tag stays in
 * the server-only `check-tag.ts`. Run it on code-parked text, before
 * `scanInlineComponents`.
 */

/** A run of self-closing `<Check>` tags, the spaces before and after it, and
 *  a newline just before. (`(^|\n)?` would not do: an optional group that
 *  matches empty does not take part, so `^` never captured.) */
const CHECK_RUN_RE = /(\n)?([ \t]*)((?:<Check(?:\s+[A-Za-z][\w-]*="[^"]*")*\s*\/>[ \t]*)+)/g;

/**
 * `text` with the spaces around each run of `<Check>` tags moved behind it:
 * none at a line start or end or before punctuation, else one space if either
 * side had one. Dropping the tags then leaves the line as if they were absent.
 */
export function spaceCheckTags(text: string): string {
  return text.replace(CHECK_RUN_RE, (m, nl: string | undefined, before: string, run: string, at: number) => {
    const tags = run.replace(/\/>[ \t]+/g, "/>");
    const next = text[at + m.length];
    const space = !nl && at > 0 && (before || tags !== run) && next && !/[\n.,;:!?)\]}]/.test(next);
    return (nl ?? "") + tags + (space ? " " : "");
  });
}
