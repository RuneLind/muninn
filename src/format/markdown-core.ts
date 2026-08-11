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

// ── The strict word-flanking italics rule, in four named pieces ─────────────
// Spelled out rather than written as one opaque string: every widening below was
// argued case by case against two tables (must-emphasize / must-stay-inert), and
// a future widening has to be argued against the same two.

/** What may sit immediately BEFORE the opening `*`: start of text, whitespace, a
 *  placeholder sentinel (`\x00` — a parked link delimiter, so emphasis still
 *  renders inside a link LABEL), or an opening quote/bracket/hyphen. What is
 *  deliberately NOT here is the whole safety story: a `*` after `/`, `.`, `\` or
 *  another `*` never opens a span, which is what keeps a pair of path globs on
 *  one line, a double-star recursive glob, regexes (`^.` + star + `$`), escaped
 *  asterisks (`\*x\*`) and bare URLs with an asterisk pair in a path segment
 *  whole. All of them are pinned in `markdown-all-platforms.test.ts`. */
const ITALIC_PRECEDER = "(?<![^\\s\\x00«\"'([\\-])";

/** Content may OPEN on a letter, digit or emoji… */
const ITALIC_EDGE_WORD = "[\\p{L}\\p{N}\\p{Extended_Pictographic}]";
/** …or on an opening quote/bracket/`#`/`§` — `*"quoted phrase"*`,
 *  `*(parenthetical aside)*`, `*§4*`. Never on `.`, `/` or whitespace: that
 *  rejection is what protects a `cp` line whose glob opens on a dot, the
 *  `SELECT *, count(*) FROM t` opener, and the prose arithmetic
 *  `2 * 3 and 4 * 5` — each of whose "content" opens on `.`, `,` or a space.
 *
 *  `&` is in the set for the EMAIL column specifically: that renderer escapes
 *  before it emphasizes, so by the time this pattern runs `*"quoted phrase"*`
 *  reads `*&quot;quoted phrase&quot;*` and the content's real opening edge is the
 *  entity's `&` (its closing `;` is already a closing edge). Without it the
 *  quoted-phrase case emphasized on Slack and stayed literal on email — measured,
 *  and exactly the kind of silent divergence one shared source exists to stop. */
const ITALIC_EDGE_OPEN_PUNCT = "[\"'«([#§&]";
/** Content may CLOSE on a letter/digit/emoji or on trailing punctuation that
 *  belongs to the emphasized phrase — `*word,*`, `*important.*`, `*really!*`,
 *  `*C#*`, `*"quoted"*`. */
const ITALIC_EDGE_CLOSE = "[\\p{L}\\p{N}\\p{Extended_Pictographic}\"'»)\\].,!?;:#]";

/** What may sit immediately AFTER the closing `*`: end of text, whitespace, a
 *  sentinel, closing punctuation, `»`, or a hyphen (`*emphasis*-hyphenated`).
 *  Never a slash or a letter. */
const ITALIC_FOLLOWER = "(?![^\\s\\x00.,;:!?)\\]}'\"\\-»])";

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
 *  - opener flanking ({@link ITALIC_PRECEDER}).
 *  - content edges — the two-branch alternation below. A letter/digit/emoji
 *    opener may stand alone (`*a*`); a PUNCTUATION opener must be followed by a
 *    closing edge, so a lone `*(*` in prose is not a one-character emphasis span.
 *  - closer flanking ({@link ITALIC_FOLLOWER}).
 *  - `[^*\n]` — a span never crosses a line or swallows another delimiter, so a
 *    `**bold**` run and a double-star glob stay whole.
 *
 * Round-2 widening, every case executed against both tables before it landed:
 * quoted/parenthetical/`§`/`#`/emoji content, trailing `,.!?` inside the span,
 * a `-`/`»` follower and a `«"'([-` preceder. ONE knock-on flip came with it —
 * `a (*b*) in parens` now emphasizes, because `(` had to join the preceders.
 * That is what CommonMark does, and it is pinned as behaviour rather than left
 * as a surprise.
 *
 * KNOWN MISSES, left inert deliberately (the safe direction): raw-HTML-adjacent
 * italics (`<span>*i*</span>`) stay literal on both platforms — email escapes the
 * tags to `&lt;span&gt;` before this pass, so the flanks are `;` and `&`, and
 * Slack's tag-strip runs after it, so the flanks are `>` and `<`. Adding `>` to
 * the preceders alone would not close it (the FOLLOWER `<` still rejects), so it
 * buys nothing but surface. Equal to `origin/main`, which had no italics pass at
 * all here.
 */
export const FLANKING_ITALIC_SOURCE =
  ITALIC_PRECEDER +
  "\\*(" +
  ITALIC_EDGE_WORD + "(?:[^*\\n]*" + ITALIC_EDGE_CLOSE + ")?" +
  "|" +
  ITALIC_EDGE_OPEN_PUNCT + "[^*\\n]*" + ITALIC_EDGE_CLOSE +
  ")\\*" +
  ITALIC_FOLLOWER;

/**
 * Regex SOURCE for `***triple***` emphasis (bold + italic), which every platform
 * here rewrites in ONE step before its `**bold**` pass.
 *
 * Why it needs its own pass: the bold pattern `\*\*(.+?)\*\*` is non-greedy, so
 * on `***x***` it claims the FIRST two stars and stops at the next two, leaving
 * the third star dangling — email came out `<strong>*triple</strong>*`, a literal
 * asterisk in the rendered body. `[^*\n]+` keeps it from spanning a delimiter or
 * a line, exactly as the italics rule does.
 */
export const TRIPLE_EMPHASIS_SOURCE = "\\*\\*\\*([^*\\n]+)\\*\\*\\*";

/**
 * Link targets a formatter may turn into a REAL link. The ONE home for the gate,
 * compiled once and shared by `slack-format.ts` and `email-format.ts` — the two
 * had drifted (email accepted `https?://` only and case-sensitively, so a
 * `mailto:` address and a `HTTPS://X.COM` link both degraded to bare label text
 * on email while Slack linked them).
 *
 * Everything else degrades to its LABEL, deliberately: a `javascript:` target
 * must never become a live href, a relative wiki path has nothing to resolve
 * against in a mail client, and Slack renders a non-scheme `<…|…>` as something
 * between a broken link and raw text.
 *
 * No `g` flag — `.test` on a shared global regex carries `lastIndex` between
 * calls and would answer differently on alternate invocations.
 */
export const LINKABLE_TARGET_RE = /^(?:https?:\/\/|mailto:)/i;

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
