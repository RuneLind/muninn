/**
 * Shared utilities for the platform-specific markdown formatters
 * (web, telegram, slack). Each platform still owns its conversion logic;
 * this module consolidates the duplicated escape + placeholder mechanics.
 */

/** Escape HTML entities: & < > and ". Safe for both attribute values and text. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Regex SOURCE (not a compiled regex — callers pick their own flags) for a
 * markdown `*italic*` span under a STRICT word-flanking rule. The ONE home for
 * the rule: `slack-format.ts` and `email-format.ts` both compile it, so the two
 * cannot drift. Telegram and web deliberately keep their older, weaker
 * `(?<!\w)\*([^*]+?)\*(?!\w)` — changing those would move long-standing live
 * output; the four columns are pinned in `markdown-all-platforms.test.ts`.
 *
 * Compile with `"gu"` — the `\p{…}` classes require the unicode flag (so `*økt*`
 * emphasizes like `*item*` does).
 *
 * Four constraints, each closing a MEASURED failure. The safe direction is
 * "leave unchanged": anything short of a real emphasis span must not match.
 *  - opener flanking `(?<![^\s\x00])` — the `*` must sit at the start of the
 *    text, after whitespace, or after a placeholder sentinel (a parked link
 *    delimiter, so emphasis still renders inside a link LABEL). Without it a `*`
 *    after `/`, `(`, `.` or `\` opens a span: a pair of path globs on one line,
 *    `SELECT *, count(*) FROM t`, a `^.*$` regex, a bare URL with an asterisk
 *    pair in a path segment, and an escaped `\*not italic\*` all came out
 *    mangled. All are pinned in `markdown-all-platforms.test.ts`.
 *  - content starts AND ends with a letter/digit — this is what rejects the
 *    prose-arithmetic span (`2 * 3 and 4 * 5`) and the `SELECT *,` opener.
 *  - closer flanking — the `*` must be followed by whitespace, end of text, a
 *    sentinel, or closing punctuation; never by a slash or a letter.
 *  - `[^*\n]` — a span never crosses a line or swallows another delimiter, so a
 *    `**bold**` run and a double-star glob stay whole.
 */
export const FLANKING_ITALIC_SOURCE =
  "(?<![^\\s\\x00])\\*([\\p{L}\\p{N}](?:[^*\\n]*[\\p{L}\\p{N}])?)\\*(?![^\\s\\x00.,;:!?)\\]}'\"])";

/**
 * Placeholder store using `\x00<MARKER><idx>\x00` sentinels. Use to protect
 * regions (code blocks, inline code, links) from further markdown processing,
 * then restore them at the end.
 */
export class Placeholders {
  private stores = new Map<string, string[]>();

  /** Reserve a placeholder slot; returns the sentinel to embed in the text. */
  add(marker: string, rendered: string): string {
    let arr = this.stores.get(marker);
    if (!arr) {
      arr = [];
      this.stores.set(marker, arr);
    }
    const idx = arr.length;
    arr.push(rendered);
    return `\x00${marker}${idx}\x00`;
  }

  /**
   * Replace all sentinels in `text` with their rendered values. A single sweep
   * visits each marker once in insertion order, but a restored value may itself
   * re-introduce a sentinel for a marker that was already visited — e.g. web
   * parks an inline component, then parks an inline-code span whose value wraps
   * that component's sentinel (or the reverse nesting: a component whose label
   * contained backticks). A single pass would leave the re-introduced sentinel
   * unresolved and leak a raw NUL byte into served output. Loop the whole sweep
   * to a fixed point; bound the iterations so a (never legitimately produced)
   * self-referential value can't spin forever.
   */
  restore(text: string): string {
    let result = text;
    for (let iter = 0; iter < 10; iter++) {
      let changed = false;
      for (const [marker, items] of this.stores) {
        result = result.replace(restoreRegex(marker), (_m, idx) => {
          changed = true;
          return items[parseInt(idx, 10)] ?? "";
        });
      }
      if (!changed) break;
    }
    return result;
  }
}

const restoreRegexCache = new Map<string, RegExp>();
function restoreRegex(marker: string): RegExp {
  let re = restoreRegexCache.get(marker);
  if (!re) {
    re = new RegExp(`\\x00${marker}(\\d+)\\x00`, "g");
    restoreRegexCache.set(marker, re);
  }
  return re;
}
