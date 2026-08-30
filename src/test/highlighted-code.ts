import { HIGHLIGHT_TOKEN_CLASSES } from "../format/highlight.ts";

/**
 * Test helper: undo syntax highlighting so a fence assertion can talk about the
 * code again.
 *
 * `src/format/highlight.ts` turns a fence body into a token stream, so a fence
 * containing `const x = 1;` no longer contains that STRING — it contains six
 * spans. Every assertion that wants "the code came through" (including the
 * component-fuzz cases that want "…and it came through ESCAPED") goes through
 * this first.
 *
 * ⚠️ **It removes a `</span>` only when that tag closes a span this helper
 * opened.** A depth COUNTER is not enough and was measurably wrong: with
 * `<span class="tok-pun"><span class="wiki-link-missing">x</span></span>` a
 * counter removes the FIRST `</span>` it sees after a tok open — the inner,
 * foreign one — and re-emits the outer, so the output is byte-identical to the
 * un-wrapped case. That laundered exactly the difference `render.test.ts`'s
 * parity assertion exists to measure: classing the sentinel rule (the fix under
 * test) left every wiki test green. The stack below closes the tag that was
 * actually opened, so foreign markup keeps its own tags and its own position.
 *
 * The strip is narrow in the other direction too — only the exact opens this
 * module's own emitter produces are matched, so it cannot launder an injected
 * tag: content-borne markup is escaped to `&lt;span class=&quot;…`, which is
 * not a tag at all.
 *
 * ⚠️ The tag scanner assumes no `>` inside a foreign span's attribute values
 * (`<span title="a > b">` would split at the first `>`). Nothing can produce one
 * today — `render.ts`'s `wiki-link-missing` title goes through `escapeHtml` and
 * fence content is escaped — so this is a constraint on future span emitters,
 * not a live defect. A self-closing `<span/>` would likewise push an unpaired
 * stack entry; nothing emits one.
 *
 * ⚠️ Entities are NOT decoded. `not.toContain("<img")` and `toContain("&lt;img")`
 * must both stay meaningful on the result.
 */

/** The exact opening tags `highlightCode` emits, derived from its own export so
 *  a new token class cannot leave this helper silently not-stripping. */
const TOKEN_OPEN_TAGS = new Set(HIGHLIGHT_TOKEN_CLASSES.map((c) => `<span class="${c}">`));

export function stripTokenSpans(html: string): string {
  /** One entry per open `<span>`: true when this helper opened it. */
  const opened: boolean[] = [];
  return html.replace(/<span\b[^>]*>|<\/span>/g, (tag) => {
    if (tag !== "</span>") {
      const mine = TOKEN_OPEN_TAGS.has(tag);
      opened.push(mine);
      return mine ? "" : tag;
    }
    // An unbalanced `</span>` (none of ours is) is left exactly where it is.
    return opened.pop() === true ? "" : tag;
  });
}
