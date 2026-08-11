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

// ── The strict word-flanking emphasis rule, in five named pieces ────────────
// Spelled out rather than written as one opaque string: every widening below was
// argued case by case against two tables (must-emphasize / must-stay-inert), and
// a future widening has to be argued against the same two. ONE set of pieces
// builds ALL FOUR guarded rules — `*italic*`, `***triple***` and the two
// composition shapes (`**bold *italic***`, `***italic* bold**`) — so they cannot
// protect different things.

/** What may sit immediately BEFORE the opening `*`: start of text, whitespace, a
 *  placeholder sentinel (`\x00` — a parked link delimiter, so emphasis still
 *  renders inside a link LABEL), or an opening bracket/`«`/hyphen. What is
 *  deliberately NOT here is the whole safety story: a `*` after `/`, `.`, `\` or
 *  another `*` never opens a span, which is what keeps a pair of path globs on
 *  one line, a double-star recursive glob, regexes (`^.` + star + `$`), escaped
 *  asterisks (`\*x\*`) and bare URLs with an asterisk pair in a path segment
 *  whole. All of them are pinned in `markdown-all-platforms.test.ts`.
 *
 *  Round 3 REMOVED `"` and `'` from this set, and it removed two defect classes
 *  at once. A quote immediately before the opening star means the star is quoted
 *  — a literal, not a delimiter: `use "*" and "*" as wildcards`,
 *  `SELECT "*" , count("*") FROM t`, `sep='*' and end='*'` and `('*', '*')` all
 *  paired their two quoted literals into one emphasis span (measured on both
 *  platforms). It also removed a silent DIVERGENCE: `he said "*hi*" loudly`
 *  italicized on Slack and stayed literal on email, because only the email column
 *  had escaped its `"` to `&quot;` by the time the pattern ran. Quotes stay in the
 *  CONTENT-edge sets, so `*"quoted phrase"*` still emphasizes on both. */
const ITALIC_PRECEDER = "(?<![^\\s\\x00«([\\-])";

/** Content may OPEN on a letter, digit or emoji… */
const ITALIC_EDGE_WORD = "[\\p{L}\\p{N}\\p{Extended_Pictographic}]";
/** …or on an opening quote/bracket/`#`/`§` — `*"quoted phrase"*`,
 *  `*(parenthetical aside)*`, `*§4*`. Never on `.`, `/` or whitespace: that
 *  rejection is what protects a `cp` line whose glob opens on a dot, the
 *  `SELECT *, count(*) FROM t` opener, and the prose arithmetic
 *  `2 * 3 and 4 * 5` — each of whose "content" opens on `.`, `,` or a space. */
const ITALIC_EDGE_OPEN_PUNCT = "[\"'«([#§]";
/** Content may CLOSE on a letter/digit/emoji or on trailing punctuation that
 *  belongs to the emphasized phrase — `*word,*`, `*important.*`, `*really!*`,
 *  `*C#*`, `*"quoted"*`. */
const ITALIC_EDGE_CLOSE = "[\\p{L}\\p{N}\\p{Extended_Pictographic}\"'»)\\].,!?;:#]";

/** What may sit immediately AFTER the closing `*`: end of text, whitespace, a
 *  sentinel, closing punctuation, `»`, or a hyphen (`*emphasis*-hyphenated`).
 *  Never a slash or a letter. Spelled as the DISALLOWED class plus a wrapper, so
 *  the entity-aware variant below can punch a hole in it without restating it. */
const ITALIC_FOLLOWER_DISALLOWED = "[^\\s\\x00.,;:!?)\\]}'\"\\-»]";

/**
 * Extra content-OPENING edges for a renderer that HTML-escapes BEFORE it
 * emphasizes. Email does, so `*"quoted phrase"*` reaches its pattern as
 * `*&quot;quoted phrase&quot;*` and the opening edge is an entity, not a `"`.
 *
 * These are whole ENTITIES, not a bare `&`. Round 2 admitted `&` and bought three
 * divergences with it, all measured: `escape *&* alone` rendered `<em>&amp;</em>`
 * on email while Slack left it alone, and `x *<b>* y` / `tag *<Callout>* here`
 * italicized their escaped tag text on email while Slack stripped the tag. A bare
 * `&` opens EVERY entity; only the two quote entities are real quote edges.
 */
const ENTITY_QUOTE_OPEN_EDGES = ["&quot;", "&#39;"];

/**
 * The same asymmetry on the FOLLOWER side. A raw `"` is an allowed follower
 * ({@link ITALIC_FOLLOWER_DISALLOWED}) — `he called it ***critical***"` — but here
 * the closing quote has already become `&quot;`, whose first character `&` is a
 * rejected follower — so the span emphasized on Slack and stayed literal on
 * email. Measured on 70 corpus rows; cosmetic, but a silent divergence.
 *
 * Only `&quot;` is listed: {@link escapeHtml} escapes `& < > "` and never emits
 * `&#39;`, so an apostrophe reaches the pattern as a raw `'` and is already
 * allowed. A bare `&` is deliberately NOT allowed — that would make every entity
 * a legal follower, the same over-reach {@link ENTITY_QUOTE_OPEN_EDGES} avoids.
 */
const ENTITY_QUOTE_FOLLOW_EDGES = ["&quot;"];

/**
 * Build both guarded emphasis rules for one renderer's edge vocabulary.
 *
 * Returns regex SOURCES, not compiled regexes — callers pick their own flags, and
 * the italics rule needs `"gu"` (its `\p{…}` classes require the unicode flag, so
 * `*økt*` emphasizes like `*item*` does).
 *
 * Four constraints, each closing a MEASURED failure. The safe direction is
 * "leave unchanged": anything short of a real emphasis span must not match.
 *  - opener flanking ({@link ITALIC_PRECEDER}).
 *  - content edges — the two-branch alternation below. A letter/digit/emoji
 *    opener may stand alone (`*a*`); a PUNCTUATION opener must be followed by a
 *    closing edge, so a lone `*(*` in prose is not a one-character emphasis span.
 *  - closer flanking ({@link ITALIC_FOLLOWER_DISALLOWED}).
 *  - `[^*\n]` — a span never crosses a line or swallows another delimiter, so a
 *    `**bold**` run and a double-star glob stay whole.
 *
 * The `***triple***` rule is the SAME shape with a three-star delimiter, and that
 * is round 3's second fix. Round 2 spelled it as a bare
 * `\*\*\*([^*\n]+)\*\*\*`, which re-opened the entire protected class three stars
 * wide — a triple-star path glob pair on one line, a triple-star pair inside a
 * bare URL, prose arithmetic (`2 *** 3 and 4 *** 5`), escaped stars
 * (`\***escaped\***`), a `cp` glob and a mid-word pair (`x***mid***y`) were all
 * mangled (measured; the six literals are the inert table in
 * `markdown-all-platforms.test.ts` — they cannot be written here, since a
 * triple-star glob closes this comment). Sharing the guards fixes all six at once.
 *
 * Round 4 adds the two COMPOSITION shapes — `**bold *italic***` and
 * `***italic* bold**` — and they are not a nicety. Their closing/opening `***`
 * run is a real delimiter, but the triple rule cannot claim it (its other half is
 * a `**`), so it fell through to {@link parkLeftoverStarRuns}, which parked it and
 * orphaned the `**` opener — the orphan then paired with the NEXT `**` on the
 * line and INVERTED every bold after it. Measured on
 * `**bold with *italic*** then **second bold** and **third bold** end`: email
 * emitted `<strong>bold with *italic*** then </strong>second bold<strong> and …`,
 * swallowing an adjoining link into the inverted span. Three shapes of real wiki
 * prose hit this (`…as a *tool***`, `…that *naturally hill-climbs***`), so the
 * fix is to MATCH the composition rather than to park it: with these two rules
 * running first, the genuine shapes never reach the park and the park keeps
 * claiming only true leftovers.
 */
function buildEmphasisSources(
  entityOpenEdges: readonly string[],
  entityFollowEdges: readonly string[] = [],
) {
  const openPunct = `(?:${[ITALIC_EDGE_OPEN_PUNCT, ...entityOpenEdges].join("|")})`;
  const contentOpen = `(?:${ITALIC_EDGE_WORD}|${openPunct})`;
  const content =
    ITALIC_EDGE_WORD + "(?:[^*\\n]*" + ITALIC_EDGE_CLOSE + ")?" +
    "|" +
    openPunct + "[^*\\n]*" + ITALIC_EDGE_CLOSE;
  // The follower, with a hole punched in it for each allowed entity: reject the
  // next character only if it is disallowed AND does not start one of them.
  const follower = entityFollowEdges.length
    ? `(?!(?!${entityFollowEdges.join("|")})${ITALIC_FOLLOWER_DISALLOWED})`
    : `(?!${ITALIC_FOLLOWER_DISALLOWED})`;
  const guarded = (delimiter: string) =>
    ITALIC_PRECEDER + delimiter + "(" + content + ")" + delimiter + follower;

  // The two COMPOSITION shapes. Both carry the same three guards as the rules
  // above — preceder before the opening run, follower after the closing run, and
  // the full content edges on the ITALIC half — plus a one-sided edge on the
  // bold-only half (its opening edge for `boldThenItalic`, its closing edge for
  // `italicThenBold`); the other end of that half abuts the inner `*` and is
  // whatever the writer's phrase ends/starts with, typically a space.
  const boldThenItalic =
    ITALIC_PRECEDER + "\\*\\*((?:" + contentOpen + "[^*\\n]*)?)\\*(" + content + ")\\*\\*\\*" +
    follower;
  const italicThenBold =
    ITALIC_PRECEDER + "\\*\\*\\*(" + content + ")\\*((?:[^*\\n]*" + ITALIC_EDGE_CLOSE + ")?)\\*\\*" +
    follower;

  return {
    italic: guarded("\\*"),
    triple: guarded("\\*\\*\\*"),
    boldThenItalic,
    italicThenBold,
  } as const;
}

/**
 * The rules as compiled by a renderer that emphasizes RAW text — Slack, which
 * escapes nothing before its emphasis passes.
 *
 * Telegram and web deliberately keep their older, weaker
 * `(?<!\w)\*([^*]+?)\*(?!\w)` — changing those would move long-standing live
 * output; the four columns are pinned in `markdown-all-platforms.test.ts`.
 *
 * Round-2 widening, every case executed against both tables before it landed:
 * quoted/parenthetical/`§`/`#`/emoji content, trailing `,.!?` inside the span,
 * a `-`/`»` follower and a `«([-` preceder. ONE knock-on flip came with it —
 * `a (*b*) in parens` now emphasizes, because `(` had to join the preceders.
 * That is what CommonMark does, and it is pinned as behaviour rather than left
 * as a surprise.
 *
 * KNOWN MISSES, left inert deliberately (the safe direction), each pinned in
 * `markdown-all-platforms.test.ts` so it stays a known one:
 *  - Quotes INSIDE quotes: `he said "*hi*" loudly` stays literal on both. The
 *    opening `*` sits immediately inside a `"`, which round 3 made a rejection —
 *    the price of killing the quoted-literal-asterisk pairing above, and the
 *    trade is one-sided (that defect mangled real SQL and shell prose).
 *  - Raw-HTML-adjacent italics (`<span>*i*</span>`): email has escaped the tags
 *    to `&lt;span&gt;` before this pass, Slack's tag-strip runs after it. Equal to
 *    `origin/main`, which had no italics pass here at all.
 *  - Mixed nesting whose two delimiters do not compose into one span
 *    (`a ***b** c*`, `***a* and *b***`): a pre-existing class no rule here
 *    addresses — the delimiters are genuinely ambiguous and CommonMark's answer
 *    needs a real inline parser. Stays fully literal. The two shapes that DO
 *    compose (`**bold *italic***`, `***italic* bold**`) are handled by the
 *    composition rules and are no longer misses.
 *  - Four-or-more-star runs (`****four****`): see
 *    {@link parkLeftoverStarRuns} — literal, by construction.
 */
export const RAW_EMPHASIS_SOURCES = buildEmphasisSources([]);

/**
 * The same rules for a renderer that HTML-escapes BEFORE it emphasizes — email.
 * Identical except at the two edges a quote can occupy: the content-opening edge
 * also accepts the two quote ENTITIES ({@link ENTITY_QUOTE_OPEN_EDGES}), so
 * `*"quoted phrase"*` emphasizes on both columns instead of only on Slack, and
 * the follower accepts `&quot;` ({@link ENTITY_QUOTE_FOLLOW_EDGES}), so a span
 * that ends just before a closing quote does too.
 *
 * Residual, deliberately not chased: `;` is a content-CLOSING edge (for `*word;*`
 * on both columns), which also closes an entity — so `*x<*` stays literal on Slack
 * and emphasizes on email as `<em>x&lt;</em>`. Removing `;` would buy that back at
 * the cost of `*word;*` diverging instead. Same pre-existing raw-tag-handling
 * class as the `<span>*i*</span>` miss above: email escapes, Slack strips.
 */
export const ESCAPED_EMPHASIS_SOURCES = buildEmphasisSources(
  ENTITY_QUOTE_OPEN_EDGES,
  ENTITY_QUOTE_FOLLOW_EDGES,
);

/**
 * Park every run of THREE OR MORE asterisks that the guarded emphasis rules did
 * not claim, so it survives to the output verbatim.
 *
 * Call it AFTER the composition + triple passes and BEFORE the `**bold**` pass.
 * The ordering is load-bearing in BOTH directions. Late enough, and the invariant
 * it buys is the whole point: a 3+ star run is claimed by an emphasis rule or it
 * is literal — never chewed on by the non-greedy `\*\*(.+?)\*\*` bold pattern, which
 * has no flanking guards at all and cannot grow any (it must keep matching
 * `**bold**` anywhere). Without this the guarded triple rule merely hands its
 * rejects to the bold pass, which mangles them just as badly: measured, the
 * triple-star path-glob pair lost two of its six stars, and `****four****` came
 * out as a six-star run (two gone).
 *
 * Early enough, and it does not park a run that is HALF of a real span. Round 4:
 * the closing `***` of `**bold *italic***` is a genuine delimiter the triple rule
 * cannot claim, and parking it orphaned the `**` opener, which then paired with
 * the next `**` on the line and inverted every bold after it (see
 * {@link buildEmphasisSources}). The composition rules now run first, so what
 * reaches this function is a true leftover.
 *
 * The cost, pinned as behaviour: `**bold*** trailing` no longer renders bold with
 * a stray star, it stays literal. That is the safe direction — the input is
 * malformed, and dropping a star the writer typed is the one outcome this whole
 * rule set exists to prevent.
 */
export function parkLeftoverStarRuns(text: string, ph: Placeholders): string {
  return text.replace(/\*{3,}/g, (run) => ph.add("STARRUN", run));
}

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
