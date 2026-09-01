/**
 * Block-level markdown lexer shared by all platform formatters.
 *
 * Each platform (web HTML, telegram HTML, slack mrkdwn) walks the same
 * `Block[]` and emits its target output. The lexer detects code blocks,
 * horizontal rules, headings, blockquotes, lists, and tables; everything
 * else lands in `text` blocks that the platform renders with its own
 * inline rules (bold, italic, strike, links, inline code).
 *
 * Inline content is preserved as raw strings — platforms differ enough on
 * inline rendering (Slack converts HTML tags, Telegram has a tag whitelist,
 * web HTML-escapes everything) that a shared inline AST would force every
 * platform through unwanted abstractions.
 */

export type Block =
  | { type: "code_block"; lang: string; code: string }
  | { type: "hr" }
  | { type: "heading"; level: number; content: string }
  | { type: "blockquote"; lines: string[] }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[]; start: number }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "component"; name: ComponentName; attrs: Record<string, string>; children: Block[] }
  | { type: "text"; lines: string[] };

// ── Component blocks ────────────────────────────────────────────────────────
// A small, whitelisted vocabulary of presentational block components shared with
// mimir's MDX explainer set (`scripts/mdx-explainer/components.tsx`). A
// line-anchored `<Name …>`/`</Name>` (or self-closing `<Name …/>`) opens a
// component whose body is parsed recursively as blocks. Tags outside the
// whitelist are NOT components — they fall through to `text` and get escaped by
// the platform renderer, exactly as before this variant existed.

export const COMPONENT_NAMES = [
  "Callout",
  "Verdict",
  "Pill",
  "Figure",
  "FileRef",
  "ComparisonTable",
  "Meter",
  "Diff",
  "FileTree",
  "Checklist",
  "AnnotatedCode",
  "CodeTabs",
  "Tab",
  "Fact",
  "FactCheck",
] as const;
export type ComponentName = (typeof COMPONENT_NAMES)[number];

const COMPONENT_NAME_SET: ReadonlySet<string> = new Set(COMPONENT_NAMES);

/** Components allowed to appear self-closing (`<Name …/>`). */
const SELF_CLOSING_ALLOWED: ReadonlySet<ComponentName> = new Set<ComponentName>([
  "FileRef",
  "Verdict",
  "Pill",
  "Fact",
]);

/** Attribute whitelist per component; any other attribute is dropped. */
const COMPONENT_ATTRS: Record<ComponentName, readonly string[]> = {
  Callout: ["tone", "title"],
  Verdict: ["value"],
  Pill: ["tone"],
  Figure: ["caption"],
  FileRef: ["path"],
  ComparisonTable: [],
  Meter: ["value", "max", "tone"],
  Diff: [],
  FileTree: [],
  Checklist: [],
  AnnotatedCode: ["file", "lang"],
  CodeTabs: [],
  Tab: ["label"],
  // Fact-check annotation pair. `Fact` wraps the checked passage inline and
  // carries its claim number + verdict (`v`: ok | warn | bad | unknown); the
  // verdict is DENORMALIZED onto the tag on purpose — a streaming block renderer
  // cannot look ahead to the `FactCheck` appendix to colour a chip, and one write
  // emits both sides so they cannot drift.
  Fact: ["n", "v"],
  // `unknown` counts the ❓ claims — the ones nothing verified. It exists so a
  // deadline-truncated fact check cannot render as a clean ✓/⚠/✗ page: those
  // claims get NO `<Fact>` wrapper and NO appendix section, so without a count
  // they would vanish from the page entirely.
  FactCheck: ["date", "ok", "warn", "bad", "unknown"],
};

/** Max nesting of component blocks. Bodies are parsed as blocks only while the
 *  current depth is below this; at the cap, inner tags degrade to plain text. */
const MAX_COMPONENT_DEPTH = 2;

// Anchored to the start of a (trimmed) line and gated on a leading `<`, so the
// common case (a line not starting with `<`) fails the match cheaply — the
// parser runs on every chat delta re-render, so this stays single-pass.
const COMPONENT_OPEN_RE = /^<([A-Za-z][A-Za-z0-9]*)((?:\s+[A-Za-z][\w-]*="[^"]*")*)\s*(\/?)>(.*)$/;
const ATTR_RE = /([A-Za-z][\w-]*)="([^"]*)"/g;

/**
 * Regex SOURCE (not a compiled regex — callers pick their own flags/anchors) for
 * ANY whitelisted component tag: opening, closing, or self-closing, with its
 * attributes. This is the ONE place the tag shape lives; `src/wiki/similar.ts`
 * (query stripping) and `src/wiki/integrate-edits.ts` (exclusion-zone masking)
 * both derive from it rather than hand-rolling a third variant that drifts.
 *
 * Attributes are matched loosely (`[^>]*`) on purpose. {@link COMPONENT_OPEN_RE}
 * requires DOUBLE-QUOTED attrs because it also has to parse them; a masker only
 * has to find the tag's extent, and a stricter pattern would half-match
 * `<Callout tone={x}>` — masking the name but leaving `tone={x}>` editable prose,
 * which is exactly the corruption the mask exists to prevent.
 */
export const COMPONENT_TAG_SOURCE = componentTagSource("[^>]*");

/**
 * Single-line variant of {@link COMPONENT_TAG_SOURCE}: the attribute tail may not
 * cross a newline. Required by any masker that must not let a MALFORMED tag (an
 * opening tag whose `>` is missing on its own line) swallow the prose below it up
 * to the next `>` anywhere in the document — `src/wiki/integrate-edits.ts` zones
 * whatever this matches, so a runaway match would silently mark editable prose
 * (and even a blockquote marker) uneditable.
 */
export const COMPONENT_TAG_SOURCE_SINGLE_LINE = componentTagSource("[^>\\n]*");

function componentTagSource(attrTail: string): string {
  return `</?(?:${COMPONENT_NAMES.join("|")})\\b${attrTail}>`;
}

/** Normalize an untrusted `tone` attr for Callout to the four known tones. */
export function normalizeCalloutTone(tone: string | undefined): "info" | "warn" | "good" | "bad" {
  return tone === "warn" || tone === "good" || tone === "bad" ? tone : "info";
}

/** Normalize an untrusted `tone` attr for Pill. */
export function normalizePillTone(tone: string | undefined): "default" | "rec" | "warn" {
  return tone === "rec" || tone === "warn" ? tone : "default";
}

/** Normalize an untrusted `value` attr for Verdict. */
export function normalizeVerdictValue(value: string | undefined): "yes" | "no" {
  return value === "no" ? "no" : "yes";
}

/**
 * Fact-check verdict vocabulary, normalized from an untrusted `v` attr.
 *
 * `unknown` is the fallback rather than `ok`: a malformed or absent verdict must
 * never render as a green "confirmed" chip on a passage nothing actually
 * confirmed. The emoji the verify prompt emits (✅/⚠️/❌/❓, with or without the
 * optional VS16) are accepted alongside the words, since the writer derives `v`
 * from those blocks and a stray emoji is more likely than a typo'd word.
 */
export type FactVerdict = "ok" | "warn" | "bad" | "unknown";

export function normalizeFactVerdict(value: string | undefined): FactVerdict {
  if (!value) return "unknown";
  const v = value.replace(/\uFE0F/g, "").trim().toLowerCase();
  if (v === "ok" || v === "✅") return "ok";
  if (v === "warn" || v === "⚠") return "warn";
  if (v === "bad" || v === "❌") return "bad";
  return "unknown";
}

/** Display vocabulary for a {@link FactVerdict} — the chip glyph and the word
 *  used in tooltips, the appendix summary strip and every plain-text fallback. */
export const FACT_VERDICT_MARK: Record<FactVerdict, string> = {
  ok: "✓",
  warn: "⚠",
  bad: "✗",
  unknown: "?",
};
export const FACT_VERDICT_WORD: Record<FactVerdict, string> = {
  ok: "confirmed",
  warn: "needs care",
  bad: "corrected",
  unknown: "unverified",
};

/**
 * Wording for the `FactCheck` appendix's COUNT strip, which reads as a tally of
 * claims rather than a label on one passage. Only `unknown` differs from
 * {@link FACT_VERDICT_WORD}: "3 unverified" reads as a judgement the checker made,
 * while "3 not checked" is what actually happened (the run hit its deadline).
 */
export const FACT_COUNT_WORD: Record<FactVerdict, string> = {
  ok: "confirmed",
  warn: "needs care",
  bad: "corrected",
  unknown: "not checked",
};

/**
 * Regex SOURCE for a `Fact` tag alone (opening / closing / self-closing), the
 * newline-free attribute-tail variant for the same reason
 * {@link COMPONENT_TAG_SOURCE_SINGLE_LINE} exists.
 */
const FACT_TAG_SOURCE = `</?Fact\\b[^>\\n]*>`;
/** The OPENING tag alone — what {@link countFactWrappers} tallies. */
const FACT_OPEN_TAG_SOURCE = `<Fact\\b[^>\\n]*>`;

/**
 * ONE authority on "is this text a whole `<Fact>` wrapper?" — an opening tag at
 * the very start and a closing tag at the very end (an optional trailing newline
 * tolerated), covering both legal spellings from `factWrapperForms`.
 *
 * A bare `/^<Fact\b/` prefix test is NOT enough: prose that merely BEGINS with the
 * literal tag (a page documenting this feature, a model quoting the markup) would
 * then be classed as an annotation, forcing the apply route's mandatory-appendix
 * path — and its answer-or-400 — onto an ordinary edit.
 */
const FACT_WRAPPER_SHAPE_RE = new RegExp(
  `^${FACT_OPEN_TAG_SOURCE}[\\s\\S]*</Fact>\\r?\\n?$`,
);

/** Does `text` have the full shape of a `<Fact>` wrapper (open tag first, close tag
 *  last)? The shared predicate behind the payload-shape gates on the write path. */
export function isFactWrapperText(text: unknown): boolean {
  return typeof text === "string" && FACT_WRAPPER_SHAPE_RE.test(text);
}

/** A line whose ENTIRE content is one `Fact` tag — the legal BLOCK form emitted
 *  when a wrapped span covers a whole paragraph. Matched (and removed) with its
 *  newline: leaving the blank line behind would split the paragraph it wrapped.
 *
 *  Alternation, ONE pass: the line form is tried first at every line start (it
 *  swallows the newline), a bare tag anywhere else second. Two sequential
 *  `replace` passes would invalidate the protected-region offsets for the second.
 */
const FACT_TAG_SCAN_RE = new RegExp(
  `^[ \\t]*(?:${FACT_TAG_SOURCE})[ \\t]*\\r?\\n?|${FACT_TAG_SOURCE}`,
  "gm",
);
const FACT_OPEN_TAG_SCAN_RE = new RegExp(FACT_OPEN_TAG_SOURCE, "g");

interface ProtectedRegion {
  start: number;
  end: number;
}

const FRONTMATTER_BLOCK_RE = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** Push every inline code span (`` `x` ``, matched backtick runs) on one line. */
function pushInlineCodeSpans(line: string, base: number, out: ProtectedRegion[]): void {
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      i++;
      continue;
    }
    let j = i;
    while (j < line.length && line[j] === "`") j++;
    const runLen = j - i;
    let k = j;
    let closeEnd = -1;
    while (k < line.length) {
      if (line[k] !== "`") {
        k++;
        continue;
      }
      let e = k;
      while (e < line.length && line[e] === "`") e++;
      if (e - k === runLen) {
        closeEnd = e;
        break;
      }
      k = e;
    }
    // An UNCLOSED run is not a code span — resume scanning after it.
    if (closeEnd === -1) {
      i = j;
      continue;
    }
    out.push({ start: base + i, end: base + closeEnd });
    i = closeEnd;
  }
}

/**
 * The regions of a page body where a `<Fact …>` tag is CONTENT, not markup:
 * frontmatter, fenced code blocks, and inline backtick spans.
 *
 * Load-bearing, not cosmetic. The integrate apply transform WRITES the stripped
 * body back to disk, so a flat scan silently deletes the tags out of any page that
 * documents this very feature (mimir's plan page carries 26 of them) — the exact
 * corruption the strip exists to prevent on the prose side.
 *
 * Fence scanning mirrors `findExclusionZones` in `src/wiki/integrate-edits.ts`
 * (marker-matched, CommonMark closer-length rule, unterminated fence runs to EOF)
 * but stays here: `markdown-ast.ts` is the import-safe module every platform
 * formatter and the bundled reader client already depend on.
 */
function factProtectedRegions(body: string): ProtectedRegion[] {
  const regions: ProtectedRegion[] = [];
  const fm = FRONTMATTER_BLOCK_RE.exec(body);
  const fmEnd = fm && fm.index === 0 ? fm[0].length : 0;
  if (fmEnd > 0) regions.push({ start: 0, end: fmEnd });

  let offset = 0;
  let fenceStart = -1;
  let fenceMarker = "";
  let fenceRun = 0;
  for (const line of body.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    if (lineStart < fmEnd) continue;
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m) {
      const run = m[1]!;
      const marker = run[0]!;
      if (fenceStart < 0) {
        fenceStart = lineStart;
        fenceMarker = marker;
        fenceRun = run.length;
        continue;
      }
      if (marker === fenceMarker && run.length >= fenceRun) {
        regions.push({ start: fenceStart, end: lineStart + line.length });
        fenceStart = -1;
        fenceMarker = "";
        fenceRun = 0;
      }
      continue;
    }
    // Inline code spans matter only OUTSIDE a fence (inside, the whole block is
    // already protected) — and a fence line itself can carry no code span.
    if (fenceStart < 0) pushInlineCodeSpans(line, lineStart, regions);
  }
  if (fenceStart >= 0) regions.push({ start: fenceStart, end: body.length });
  return regions;
}

function inProtectedRegion(pos: number, regions: ProtectedRegion[]): boolean {
  return regions.some((r) => pos >= r.start && pos < r.end);
}

/**
 * Drop every `<Fact …>` / `</Fact>` wrapper from a page body, keeping the wrapped
 * prose byte-for-byte.
 *
 * This is the **strip** of the fact-check annotation write path's
 * strip → resolve → splice shape, and it is what makes the write IDEMPOTENT: a
 * re-annotation resolves its anchors against a body with no wrappers in it, so
 * offsets agree with the prompt the model saw and a second run cannot nest
 * `<Fact>` inside `<Fact>`. Every consumer that reads a page body as PROSE —
 * claim extraction, the selection locator, the integrate resolver — strips first.
 *
 * BOTH forms are handled, and the block form's tag LINES are removed whole (tag
 * plus its newline). Removing only the tag would leave an empty line where the
 * opening tag stood, splitting the wrapped paragraph in two.
 *
 * ZONE-AWARE: a tag inside frontmatter, a fenced code block or an inline backtick
 * span is DOCUMENTATION and survives untouched (see {@link factProtectedRegions}).
 */
export function stripFactWrappers(body: string): string {
  // Bare-name scan, not `"<Fact"`: an orphan `</Fact>` (a hand-edit, a truncated
  // write) must still strip, and `</Fact>` does not contain `<Fact`.
  if (!body || body.indexOf("Fact") === -1) return body;
  const regions = factProtectedRegions(body);
  return body.replace(FACT_TAG_SCAN_RE, (match, offset: number) =>
    inProtectedRegion(offset, regions) ? match : "",
  );
}

/** How many `<Fact …>` OPENING tags a body carries — i.e. how many inline marks a
 *  re-annotation is about to supersede. Reported to the reviewer rather than left
 *  as a silent deletion. Counts only what {@link stripFactWrappers} would remove,
 *  so a page documenting the tag doesn't report phantom marks. */
export function countFactWrappers(body: string): number {
  if (!body || body.indexOf("<Fact") === -1) return 0;
  const regions = factProtectedRegions(body);
  let n = 0;
  for (const m of body.matchAll(FACT_OPEN_TAG_SCAN_RE)) {
    if (m.index !== undefined && !inProtectedRegion(m.index, regions)) n++;
  }
  return n;
}

/**
 * A `Fact`/claim index from an untrusted attr — a positive integer, or null.
 * Null is a legitimate outcome (an anchor whose claim number was lost), and
 * renders a verdict chip with no claim link rather than `data-fact="NaN"`.
 *
 * DIGITS-ONLY on purpose: `Number` accepts JS numeric literals, so a bare
 * `Number()` read `n="0x10"` as 16 and `n="1e2"` as 100 — a chip silently linked
 * to someone else's claim section. Only a plain decimal string is a claim index.
 */
export function factClaimIndex(value: string | undefined): number | null {
  if (!value) return null;
  const raw = value.trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 1000 ? n : null;
}

/**
 * The claim number in a `FactCheck` appendix heading (`### ✅ Claim 4/8 — …`), or
 * null when the heading is not a claim heading.
 *
 * Deliberately LOOSER than `CLAIM_HEADING_RE` in
 * `dashboard/views/components/wiki-integrate.ts` (which owns the strict prompt
 * contract used to derive edits): this one only decides whether to open a
 * `<section id="fc-claim-N">` wrapper, so over-matching costs an unused id and
 * under-matching costs a card the client can't find. A shared strict regex would
 * mean importing a dashboard view into the platform formatter — an inverted
 * layering for no benefit.
 */
export function factClaimNumberFromHeading(content: string): number | null {
  const m = content.match(/\bClaim\s+(\d+)\s*(?:\/\s*\d+)?/i);
  return m ? factClaimIndex(m[1]) : null;
}

/** Normalize an untrusted `tone` attr for Meter (good/warn/bad → green/amber/red). */
export function normalizeMeterTone(tone: string | undefined): "default" | "good" | "warn" | "bad" {
  return tone === "good" || tone === "warn" || tone === "bad" ? tone : "default";
}

/**
 * Parse + clamp + default the Meter component's attrs, shared by every platform
 * so the value/max/tone logic lives in exactly one place. Returns `null` when
 * `value` is missing or non-numeric — the identical-degrade contract: every
 * platform then renders the children (the label) as plain text. Out-of-range
 * `value` is clamped into `[0, max]`; a missing/non-positive/non-numeric `max`
 * falls back to the default of 5.
 */
export function parseMeterAttrs(
  attrs: Record<string, string>,
): { value: number; max: number; tone: "default" | "good" | "warn" | "bad" } | null {
  const raw = attrs.value;
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;

  let max = Number(attrs.max);
  if (!Number.isFinite(max) || max <= 0) max = 5;

  const clamped = Math.min(Math.max(value, 0), max);
  return { value: clamped, max, tone: normalizeMeterTone(attrs.tone) };
}

/**
 * First fenced code block among a component's raw children, or `null`. Shared by
 * the blocks whose body is "one fence" (Diff, FileTree, AnnotatedCode) — they
 * introspect the fence's raw source rather than its already-escaped render.
 */
export function firstCodeBlock(children: Block[]): { lang: string; code: string } | null {
  for (const c of children) {
    if (c.type === "code_block") return { lang: c.lang, code: c.code };
  }
  return null;
}

/** Classify one line of a unified diff for per-line styling. Linear, no regex:
 *  a leading `+`/`-` (but not the `+++`/`---` file headers) marks add/del; every
 *  other line — context, `@@` hunks, headers — is context. */
export function diffLineClass(line: string): "add" | "del" | "ctx" {
  if (line.startsWith("+") && !line.startsWith("+++")) return "add";
  if (line.startsWith("-") && !line.startsWith("---")) return "del";
  return "ctx";
}

/** Parse one Checklist list item's leading `[x]`/`[ ]` marker. Anchored, linear:
 *  an unmarked item is treated as unchecked with its full text. */
export function parseChecklistItem(item: string): { checked: boolean; text: string } {
  const m = item.match(/^\[([ xX])\]\s*(.*)$/);
  if (m) return { checked: m[1] !== " ", text: m[2]! };
  return { checked: false, text: item };
}

/** Extract a Checklist's rows from its raw children — the first `ul` block's
 *  items, each parsed for its task marker. Empty when the body has no list. */
export function parseChecklist(children: Block[]): { checked: boolean; text: string }[] {
  const ul = children.find((c) => c.type === "ul");
  if (!ul || ul.type !== "ul") return [];
  return ul.items.map(parseChecklistItem);
}

/**
 * A fenced-code DELIMITER line: up to 3 leading spaces, a run of >= 3 backticks,
 * then the rest of the line (an info string on an opener, nothing on a closer).
 *
 * The 0-3 space bound is CommonMark's, and is the same bound
 * `dashboard/views/components/wiki-integrate.ts` uses in its own
 * `FENCE_SHAPE_RE`. The two agree on INDENT and disagree on MARKER: that file
 * accepts `~~~` and this parser does not, so a tilde block is code to the
 * fact-check line mask and markdown here. Narrower than the earlier spelling of
 * this sentence, which claimed the two "agree about which lines are delimiters"
 * — refuted by the tilde row in the `extractFences` docblock below it.
 *
 * Where this parser diverges from CommonMark is a >= 4-space-indented
 * ```` ``` ````: CommonMark calls it indented code, and this AST has no
 * indented-code block at all, so it degrades to a paragraph. Every such
 * property is TABULATED rather than described — "the fence grammar, tabulated"
 * in markdown-ast.test.ts is the authority this comment defers to.
 */
const FENCE_LINE_RE = /^( {0,3})(`{3,})(.*)$/;

/**
 * The language taken off a fence's info string: its leading run of characters
 * that are safe in an HTML attribute and a CSS class.
 *
 * Narrow ON PURPOSE, and the narrowness is load-bearing rather than tidy:
 * `telegram-format.ts` interpolates `block.lang` into `class="language-${lang}"`
 * with NO escaping, so a lang that could contain a quote would be an injection
 * through every Telegram message. Pinned from the other end by the
 * "lang can never break an HTML attribute" test, which runs hostile info
 * strings through `parseBlocks` and checks the rendered Telegram output.
 *
 * It is wider than the `\w*` this replaced (which matched `objective` out of
 * ```` ```objective-c ````) and, unlike it, a NON-matching info string no longer
 * disqualifies the fence: ```` ```ts title="x" ```` is a `ts` fence now, where
 * before it was not a fence at all and its body rendered as prose.
 *
 * Read off the TRIMMED info string, per CommonMark — ```` ``` ts ```` names `ts`,
 * and without the trim it silently named nothing, losing the highlight and the
 * `language-*` class the mermaid enhancer selects on.
 */
const FENCE_LANG_RE = /^[A-Za-z0-9_+#.-]*/;

/**
 * A placeholder, ANYWHERE in the text — used to read the ids the input already
 * spells, so this parse can avoid them.
 *
 * ⚠️ **The scan does NOT see every occurrence, and the anchored restore is what
 * makes that safe.** `matchAll` consumes each match's trailing `\x00`, so an
 * occurrence starting on it is skipped: `\x00CB1\x00CB2\x00` yields id 1 alone,
 * while `\x00CB2\x00` really does occur at offset 4 — and id 2 is then handed to
 * a fence. (An earlier revision of this comment claimed the scan and the anchor
 * were "individually redundant", i.e. that every occurrence lands in `taken`.
 * That is false, and it is the third stated reason in this file's history to be
 * wrong; measured, not argued.)
 *
 * The property that actually holds is narrower: **the LEFTMOST
 * placeholder-shaped occurrence on a line is always in `taken`** — nothing
 * starts earlier, so nothing can have consumed its opening `\x00` — and the
 * restore uses `String.match` with no `/g`, which returns the leftmost. An
 * overlap-hidden occurrence therefore always has the previous match's digits
 * immediately before it, is never leftmost on its line, and is never restored.
 *
 * So the two are JOINTLY load-bearing, not redundant: unanchor the restore and
 * the overlap case becomes live forgery. Pinned by "an OVERLAPPING placeholder
 * pair cannot forge a block", and the pair-mutant is killed by the suite even
 * though each half survives alone.
 */
const CODE_ID_SCAN_RE = /\x00CB(\d+)\x00/g;

/** A placeholder that is the WHOLE line — the only shape the walker restores.
 *  See the note on {@link CODE_ID_SCAN_RE} for why the anchors stay. */
const CODE_PLACEHOLDER_RE = /^\x00CB(\d+)\x00$/;

/**
 * The ids a placeholder in THIS input already spells, by VALUE.
 *
 * By value, not by spelling: the restore reads the digits with `parseInt`, so a
 * forged `\x00CB007\x00` and an allocated `\x00CB7\x00` are the same slot.
 * Comparing the strings would let the leading-zero form through.
 */
function takenCodeIds(text: string): Set<number> {
  const taken = new Set<number>();
  for (const m of text.matchAll(CODE_ID_SCAN_RE)) taken.add(parseInt(m[1]!, 10));
  return taken;
}

/**
 * The store threaded through the recursive parse: the extracted blocks, keyed by
 * the id their placeholder carries, plus the allocator that skips ids the input
 * already spells.
 *
 * ⚠️ **This is the fourth design for one problem, and the first three are the
 * reason it looks like this.** U+0000 is not typable prose, but a page's bytes
 * can hold it — the live jarvis `log.md` does — and a `\x00CB<n>\x00` in the
 * INPUT used to deref slot `n` no fence ever wrote and THROW, taking down the
 * shared renderer for chat, Telegram, Slack and email at once. Then:
 *
 *  1. a one-pass sanitiser — a NESTED spelling reassembles a live placeholder
 *     out of what is left either side of the removal (`\x00C` + `\x00CB0\x00` +
 *     `B0\x00` strips to `\x00CB0\x00`), so the pass MANUFACTURED the thing it
 *     existed to remove, and threw;
 *  2. the same loop, bounded at 10 — at nesting depth 10 it stops early and
 *     leaves a raw NUL, or, beside any real fence, a FORGED DUPLICATE of that
 *     fence's block;
 *  3. unbounded — terminates, but each pass is a full scan and the nesting peels
 *     one level per pass, so it is quadratic in TIME (4.8 s on 320 KB, blocking
 *     the process, per streaming delta);
 *  4. a per-parse MARKER (one more `~` than the longest run the input carried)
 *     compiled into a per-parse regex — unforgeable, but the pattern grew with
 *     the input and JavaScriptCore caps a pattern at 2^20: a 1.05 MB page threw
 *     `regular expression too large` out of ALL SIX entry points -- web, wiki,
 *     ask, Telegram, Slack and EMAIL (`format/email-format.ts`, the one an
 *     earlier count of "five renderers" left out, and it threw like the rest).
 *     Measured to the character: 1 048 558 tildes parse, 1 048 559 throw.
 *
 * Every one of those defends a FORGEABLE namespace, three by rewriting the input
 * and one by growing the pattern. This design makes the namespace disjoint
 * instead: one linear scan reads the ids the input already spells, and the
 * allocator never issues one of them. So a forged placeholder names a slot that
 * was never filled, `store.blocks.get(id)` is `undefined`, and the walker leaves
 * the line as the text it always was. Nothing is rewritten, no pattern is built
 * from input, the placeholder is a constant six-or-so characters, and the total
 * deref below is no longer defensive — it is the mechanism, and it is reachable
 * from a one-line page.
 */
interface FenceStore {
  blocks: Map<number, { lang: string; code: string }>;
  /** Ids the input already spells; never allocated. */
  taken: Set<number>;
  /** Next candidate id. Monotone, so allocation is amortised O(1). */
  next: number;
}

/**
 * Reserve the next id no placeholder in the input spells.
 *
 * `next` is monotone across the whole parse, so the skip loop costs O(taken) in
 * total, not per fence. Measured residual, stated because the round-4 commit
 * claimed the design was "flat in input size" and that is only true of the
 * shapes it measured: on NUL-DENSE input this is the slowest of the three
 * designs — 200 000 placeholder-shaped ids plus a fence cost 0.41 ms before this
 * PR and 19.2 ms now. Linear in input, no cliff, and 130 NULs across the two
 * wikis' 1571 pages, so it is a residual and not a regression worth a mechanism.
 */
function allocateCodeId(store: FenceStore): number {
  while (store.taken.has(store.next)) store.next++;
  return store.next++;
}

const HR_RE = /^---+$/;
const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const BLOCKQUOTE_RE = /^>\s?(.*)$/;
const UL_RE = /^[-*]\s+(.*)$/;
const OL_RE = /^(\d+)\.\s+(.*)$/;

export function parseBlocks(text: string): Block[] {
  const normalized = text.replace(/\r\n/g, "\n");

  // Extract code blocks first; their content must not be parsed as markdown.
  // The extraction happens ONCE against `store`, before any further
  // line-splitting; the SAME store is threaded through the recursive
  // component-body parse, so a placeholder inside a component derefs the slots
  // this parse filled and no other. `taken` is read from the NORMALIZED text,
  // which is the text the extractor also scans — CRLF collapse only deletes
  // `\r` and leaves the `\n`, so it can neither create nor destroy a
  // placeholder-shaped run between the two.
  const store: FenceStore = { blocks: new Map(), taken: takenCodeIds(normalized), next: 0 };
  const protectedText = extractFences(normalized, store);

  return parseBlocksInner(protectedText, store, 0);
}

/**
 * Replace every fenced code block in `text` with a `\x00CB{idx}\x00` placeholder
 * ON A LINE OF ITS OWN, filing the block in `store.blocks` under the id the
 * placeholder carries.
 *
 * This is a LINE WALKER, and that is the whole fix. The regex it replaced --
 * ```` /```(\w*)\n([\s\S]*?)```/g ```` -- matched a fence opener ANYWHERE,
 * while the restore that turns a placeholder back into a block is anchored
 * (`CODE_PLACEHOLDER_RE`). Anything left on the placeholder's line therefore
 * broke the restore and served the raw U+0000 to the browser, losing the code
 * block outright. Two shapes did that, both ordinary and both measured across
 * the two wikis on 2026-08-30: every `.md`/`.mdx` under `mimir/` and under
 * `huginn/huginn-jarvis/data/wiki/`, excluding `.git` and `node_modules`, is
 * 1571 pages, 42 of them leaking 130 NULs. Both are LIVE working trees and most
 * of the jarvis wiki is untracked, so the count drifts by a page or two a day —
 * mimir `d7b6cdb` / huginn `7d69031` name the moment, not a checkout anyone can
 * restore:
 *
 *  - **An indented fence** -- the "code block inside a numbered list" shape.
 *    The opener's leading spaces stayed on the placeholder's line.
 *  - **A fence delimiter starting mid-line** -- ``` text ```ts ``` --  which
 *    joined the prose either side onto the placeholder's line AND, in the wiki
 *    reader, silently ate a `[[wikilink]]` in the fence body.
 *
 * So CommonMark's fence grammar is what is implemented here, not just a laxer
 * placeholder test: an opener owns its line (<= 3 spaces of indent), a closer is
 * a bare run of the same character at least as long, and the body is dedented by
 * the opener's own indent. Four deliberate consequences, each with a row in the
 * grammar table:
 *
 *  - A ```` ```` ````-long fence closes only on >= 4 backticks, so a 4-backtick
 *    fence is a real block instead of the `<code>`-wrapped placeholder it used
 *    to render as (the old regex started its match one backtick in).
 *  - A closer may not carry trailing text, per CommonMark. ```` ```js ````
 *    ... ```` ``` and more ```` is now an UNCLOSED fence.
 *  - A closer obeys the opener's <= 3-space indent bound too, so a closer
 *    indented 4+ spaces closes nothing.
 *  - An unclosed fence is not extracted, which is the pre-existing behaviour
 *    (the old regex needed a closer to match at all). Note what that does NOT
 *    mean: an earlier spelling of this line said "stays literal text" and
 *    claimed it stopped a half-streamed chat delta flickering into a code
 *    block. Both false. The lines go to the ordinary block parser, so a
 *    heading, a list or a `<Callout>` inside an unclosed fence RENDERS -- and
 *    a streaming delta therefore flickers as headings and callouts instead.
 *    Pinned by "what an UNCLOSED fence actually does". CommonMark would run it
 *    to EOF as code; that is a separate change with its own corpus diff, and
 *    exactly one page in 1571 carries an unclosed fence.
 *
 * Tildes (`~~~`) are NOT fences here. They were not before either, and neither
 * wiki contains one (measured, same sweep) -- adding them is a separate change
 * with its own corpus diff, not a free ride on this one.
 */
function extractFences(text: string, store: FenceStore): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;

  // Memo of scan futility, the same idiom `parseBlocksInner` uses for component
  // opens and for the same reason: this parser re-runs on every streaming chat
  // delta, so an opener that re-scans the tail is a hot-path cost. Once a scan
  // for a closer of run length >= r finds nothing, no LATER opener whose run is
  // >= r can find one either — the search range only shrinks, and a closer long
  // enough for the longer run would have been long enough for r. So one scalar
  // suffices: no position is needed, and openers with a SHORTER run still scan
  // (a 3-backtick closer can close them while it could not close the 5-backtick
  // opener that failed). Without it, 24k lines of never-closing fences took
  // 9.8 s; the test that pins this carries the whole measured curve.
  //
  // One scalar is not the same as "linear in every case": k openers with
  // STRICTLY DECREASING run lengths still cost k full scans (measured, 4k such
  // lines: 3.1 s). Writing that input costs O(n^2) bytes and no real document
  // has it — runs are 3 to 5 — so it is a stated residual, not a fix.
  let noCloserAtRunAtLeast = Number.POSITIVE_INFINITY;

  while (i < lines.length) {
    const open = lines[i]!.match(FENCE_LINE_RE);
    const info = open?.[3] ?? "";
    // A BACKTICK in the info string refuses the opener, per CommonMark: an
    // ordinary prose line that opens with inline code -- ```` ```x``` ```` -- is
    // not a fence. Without this, such a line opened a fence that swallowed the
    // page up to the next bare delimiter.
    //
    // ⚠️ Refusing is EXPENSIVE, which is why nothing else refuses here. A
    // refused opener does not leave "just that line as prose": the fence's own
    // CLOSING delimiter stays in the line stream, and a lone ```` ``` ```` line
    // is itself an opener, so the rest of the document re-pairs one delimiter
    // over. Round 1 of review on this change added a second refusal -- an info
    // string holding a parked `\x00` wikilink sentinel, to save the link from
    // being discarded with the rest of the info string -- and that is exactly
    // what happened: the following prose and the NEXT code block were swallowed
    // into one lang-less block. Reverted. Everything past the lang token is
    // discarded, sentinel included; that is CommonMark's rule, the same one
    // that drops `title="x"` from ```` ```ts title="x" ````. Both halves are
    // pinned in `wiki/render.test.ts` -- the discard, and the swallowing not
    // coming back.
    if (!open || info.includes("`")) {
      out.push(lines[i]!);
      i++;
      continue;
    }

    const indent = open[1]!.length;
    const runLen = open[2]!.length;
    let close = -1;
    if (runLen < noCloserAtRunAtLeast) {
      for (let j = i + 1; j < lines.length; j++) {
        const c = lines[j]!.match(FENCE_LINE_RE);
        if (c && c[2]!.length >= runLen && c[3]!.trim() === "") {
          close = j;
          break;
        }
      }
    }
    if (close === -1) {
      noCloserAtRunAtLeast = Math.min(noCloserAtRunAtLeast, runLen);
      out.push(lines[i]!);
      i++;
      continue;
    }

    const body = lines.slice(i + 1, close).map((l) => dedentFenceLine(l, indent));
    const id = allocateCodeId(store);
    store.blocks.set(id, {
      lang: info.trim().match(FENCE_LANG_RE)![0],
      code: body.join("\n").trimEnd(),
    });
    out.push(`\x00CB${id}\x00`);
    i = close + 1;
  }

  return out.join("\n");
}

/** Strip up to `indent` leading SPACES from a fence body line -- CommonMark's
 *  rule, so an indented fence's code is not shifted right by its own indent.
 *  Up to, not exactly: a body line indented less than its opener keeps what it
 *  has rather than losing a non-space character. */
function dedentFenceLine(line: string, indent: number): string {
  let n = 0;
  while (n < indent && line[n] === " ") n++;
  return line.slice(n);
}

/** Parse already-fence-extracted text into blocks. `store` is the shared
 *  placeholder store; `depth` is the current component-nesting level. */
function parseBlocksInner(
  protectedText: string,
  store: FenceStore,
  depth: number,
): Block[] {
  const lines = protectedText.split("\n");
  const blocks: Block[] = [];
  let textBuffer: string[] = [];
  let i = 0;

  // Per-parse memo of scan futility: once a multi-line scan for `<Name>` runs to
  // EOF without seeing a single `</Name>` line, no close can exist at or after
  // that point, so every later open of the same name skips the (identical,
  // futile) EOF scan. Without this, a page of thousands of bare open tags is
  // O(n²) — each open re-scans the whole tail — which this parser can't afford
  // since it re-runs on every streaming chat/wiki-Ask delta. Keyed to THIS
  // `lines` array; recursion into component bodies gets its own memo.
  const noCloseFrom = new Map<string, number>();

  function flushText() {
    if (textBuffer.length > 0) {
      blocks.push({ type: "text", lines: textBuffer });
      textBuffer = [];
    }
  }

  while (i < lines.length) {
    const line = lines[i]!;

    if (depth < MAX_COMPONENT_DEPTH) {
      const comp = tryParseComponent(lines, i, store, depth, noCloseFrom);
      if (comp) {
        flushText();
        blocks.push(comp.block);
        i = comp.next;
        continue;
      }
    }

    const cbMatch = line.match(CODE_PLACEHOLDER_RE);
    // Total, not `store.blocks.get(n)!`: a slot that was never filled falls
    // through to text instead of throwing.
    //
    // This is the MECHANISM, not a backstop, and it is reachable from a one-line
    // page: the allocator never issues an id the input already spells, so a
    // forged `\x00CB0\x00` names an empty slot and lands here. Two earlier
    // revisions of this comment argued it was unreachable-by-construction — from
    // a sanitiser's fixed point, and then from a per-parse marker. The first of
    // those was false when written (depth-10 nesting reached this deref and
    // threw) and the second was true only until the pattern hit JavaScriptCore's
    // size cap. Pinned by "an id the input spells is never allocated" and the
    // leading-zero case beside it.
    const cb = cbMatch ? store.blocks.get(parseInt(cbMatch[1]!, 10)) : undefined;
    if (cb) {
      flushText();
      blocks.push({ type: "code_block", lang: cb.lang, code: cb.code });
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      flushText();
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    const hMatch = line.match(HEADING_RE);
    if (hMatch) {
      flushText();
      blocks.push({ type: "heading", level: hMatch[1]!.length, content: hMatch[2]! });
      i++;
      continue;
    }

    if (BLOCKQUOTE_RE.test(line)) {
      flushText();
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const m = lines[i]!.match(BLOCKQUOTE_RE);
        if (!m) break;
        quoteLines.push(m[1]!);
        i++;
      }
      blocks.push({ type: "blockquote", lines: quoteLines });
      continue;
    }

    if (UL_RE.test(line)) {
      flushText();
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i]!.match(UL_RE);
        if (!m) break;
        items.push(m[1]!);
        i++;
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    if (OL_RE.test(line)) {
      flushText();
      const items: string[] = [];
      let start = 1;
      while (i < lines.length) {
        const m = lines[i]!.match(OL_RE);
        if (!m) break;
        if (items.length === 0) start = parseInt(m[1]!, 10) || 1;
        items.push(m[2]!);
        i++;
      }
      blocks.push({ type: "ol", items, start });
      continue;
    }

    if (isTableRow(line)) {
      const tableLines: string[] = [];
      let j = i;
      while (j < lines.length && isTableRow(lines[j]!)) {
        tableLines.push(lines[j]!);
        j++;
      }
      if (tableLines.length >= 3 && isSeparatorRow(tableLines[1]!)) {
        flushText();
        const headers = parsePipeCells(tableLines[0]!).map((c) => c.trim());
        const rows = tableLines
          .slice(2)
          .filter((l) => !isSeparatorRow(l))
          .map((l) => parsePipeCells(l).map((c) => c.trim()));
        blocks.push({ type: "table", headers, rows });
        i = j;
        continue;
      }
    }

    textBuffer.push(line);
    i++;
  }
  flushText();

  return blocks;
}

/**
 * Attempt to parse a component block starting at `lines[i]`. Returns the parsed
 * block plus the index of the first unconsumed line, or `null` when the line is
 * not a clean, whitelisted, closed component (in which case the caller lets it
 * fall through to normal block/text handling — today's behavior for `<foo>`).
 */
function tryParseComponent(
  lines: string[],
  i: number,
  store: FenceStore,
  depth: number,
  noCloseFrom: Map<string, number>,
): { block: Block; next: number } | null {
  const m = lines[i]!.trim().match(COMPONENT_OPEN_RE);
  if (!m) return null;

  const name = m[1]!;
  if (!COMPONENT_NAME_SET.has(name)) return null; // unknown tag → not a component
  const cname = name as ComponentName;
  const attrs = parseAttrs(m[2]!, cname);
  const selfClosing = m[3] === "/";
  const rest = m[4]!;
  const closeTag = `</${name}>`;

  if (selfClosing) {
    // Only a subset may self-close, and the tag must own the whole line.
    if (!SELF_CLOSING_ALLOWED.has(cname) || rest.trim() !== "") return null;
    return { block: { type: "component", name: cname, attrs, children: [] }, next: i + 1 };
  }

  // Single-line form: `<Name …>content</Name>` all on one line.
  const inlineClose = rest.indexOf(closeTag);
  if (inlineClose !== -1) {
    if (rest.slice(inlineClose + closeTag.length).trim() !== "") return null; // trailing junk
    const content = rest.slice(0, inlineClose);
    const children = parseBlocksInner(content, store, depth + 1);
    return { block: { type: "component", name: cname, attrs, children }, next: i + 1 };
  }

  // Multi-line form: the open tag must own its line, then scan for the matching
  // close, honoring same-name nesting so an inner `<Callout>` doesn't close the
  // outer one early.
  if (rest.trim() !== "") return null;

  // Known-futile: a prior scan already proved no `</name>` line exists at or
  // after `known`, so this open (at index >= known - 1) can never close. Skip
  // the identical EOF scan — same null result, but O(1) instead of O(tail).
  const known = noCloseFrom.get(name);
  if (known !== undefined && i + 1 >= known) return null;

  let nesting = 1;
  let j = i + 1;
  let sawClose = false;
  const body: string[] = [];
  while (j < lines.length) {
    const trimmed = lines[j]!.trim();
    if (trimmed === closeTag) {
      sawClose = true;
      nesting--;
      if (nesting === 0) break;
      body.push(lines[j]!);
    } else {
      if (isUnclosedComponentOpenOf(trimmed, name)) nesting++;
      body.push(lines[j]!);
    }
    j++;
  }
  if (nesting !== 0) {
    // Reached EOF unclosed. If we never saw a single `</name>` line, then no
    // close exists anywhere in [i+1, EOF) — record it so later same-name opens
    // (all at a >= index) skip this scan. Only safe when sawClose is false: a
    // seen-but-unbalanced close means a later open could still match it.
    if (!sawClose) noCloseFrom.set(name, i + 1);
    return null; // unclosed → fall through as text
  }

  const children = parseBlocksInner(body.join("\n"), store, depth + 1);
  return { block: { type: "component", name: cname, attrs, children }, next: j + 1 };
}

// ── Inline components ───────────────────────────────────────────────────────
// A strict subset of the block vocabulary may ALSO appear inline — embedded
// mid-sentence, mid-heading, in a list item, blockquote line, or table cell —
// not just as an own-line block. `scanInlineComponents` splits one inline string
// into literal text runs and component tokens for exactly these names, using the
// same attr whitelist + escape contract as the block parser. Each platform's
// `renderInline` calls it at its top and routes component tokens through the
// renderer's `inlineComponent` method.
//
// Dual behavior is deliberate: a component that owns its whole (trimmed) line is
// still claimed by the BLOCK parser first (`tryParseComponent` runs before any
// line-render), so a `<Verdict>` alone on a line is a block; only leftover
// mid-text occurrences ever reach a `renderInline` string and take this path.
// Unclosed / malformed tags stay literal text — the same degradation contract as
// blocks (the platform renderer then escapes them).

export const INLINE_COMPONENT_NAMES = ["Verdict", "Pill", "Fact"] as const;
export type InlineComponentName = (typeof INLINE_COMPONENT_NAMES)[number];

export type InlineSegment =
  | { kind: "text"; text: string }
  | { kind: "component"; name: InlineComponentName; attrs: Record<string, string>; text: string };

// `<Name …>text</Name>` or `<Name …/>` for the inline whitelist only. Attr shape
// mirrors COMPONENT_OPEN_RE (double-quoted values); the paired form's inner text
// is captured non-greedily so the FIRST matching close wins. Built from the name
// list so the whitelist lives in one place. Global — callers reset lastIndex.
const INLINE_COMPONENT_RE = new RegExp(
  `<(${INLINE_COMPONENT_NAMES.join("|")})((?:\\s+[A-Za-z][\\w-]*="[^"]*")*)\\s*(?:/>|>([\\s\\S]*?)</\\1>)`,
  "g",
);

/**
 * Split an inline string into literal-text runs and inline-component tokens.
 * Linear in input length (one global-regex sweep), so a page of thousands of
 * inline components stays single-pass — this runs on every streaming delta the
 * same way the block parser does. A string with no `<` short-circuits to a
 * single text run.
 */
export function scanInlineComponents(text: string): InlineSegment[] {
  if (text.indexOf("<") === -1) return [{ kind: "text", text }];

  const segments: InlineSegment[] = [];
  INLINE_COMPONENT_RE.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_COMPONENT_RE.exec(text)) !== null) {
    if (m.index > last) segments.push({ kind: "text", text: text.slice(last, m.index) });
    const name = m[1] as InlineComponentName;
    const attrs = parseAttrs(m[2] ?? "", name);
    // Self-closing → group 3 is undefined; treat as empty inner text.
    segments.push({ kind: "component", name, attrs, text: m[3] ?? "" });
    last = INLINE_COMPONENT_RE.lastIndex;
  }
  if (segments.length === 0) return [{ kind: "text", text }];
  if (last < text.length) segments.push({ kind: "text", text: text.slice(last) });
  return segments;
}

/** Extract whitelisted double-quoted attributes for `name`; drop the rest. */
function parseAttrs(attrStr: string, name: ComponentName): Record<string, string> {
  const allowed = COMPONENT_ATTRS[name];
  const out: Record<string, string> = {};
  if (allowed.length === 0) return out;
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(attrStr)) !== null) {
    const key = m[1]!;
    if (allowed.includes(key)) out[key] = m[2]!;
  }
  return out;
}

/** True when `line` opens a component named `name` that is neither self-closing
 *  nor closed inline on the same line (i.e. it increases nesting depth). */
function isUnclosedComponentOpenOf(line: string, name: string): boolean {
  const m = line.match(COMPONENT_OPEN_RE);
  if (!m || m[1] !== name) return false;
  if (m[3] === "/") return false; // self-closing
  return !m[4]!.includes(`</${name}>`); // inline-closed opens don't nest
}

/**
 * The block parser's own table-row test, EXPORTED so the fact-check annotator can
 * ask which lines it must trim to a cell rather than re-spell the predicate.
 *
 * It is deliberately the loose one the parser uses: a lone `| a | b |` line with no
 * delimiter row under it answers `true` here and renders as ordinary text, because
 * the real table test also needs `tableLines.length >= 3` and `isSeparatorRow` on
 * the second line — state a single line does not carry. For the annotator that
 * over-reach is the safe direction (it trims a mark that could have been wider),
 * and it is strictly narrower than the `body[s] === "|"` test it replaced.
 */
export function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 1;
}

/**
 * The block parser's delimiter-row test, EXPORTED beside {@link isTableRow} for the
 * same reason: `isTableRow` alone answers `true` for a LONE `| a | b |` line, which
 * this parser renders as an ordinary paragraph. A caller that needs "is this line
 * part of a rendered TABLE" needs both — a run of row lines, length ≥ 3, whose
 * SECOND line is a separator. That is the rule `parseBlocks` applies a few lines
 * above; exporting the two predicates is what keeps a caller from re-spelling it.
 */
export function isSeparatorRow(line: string): boolean {
  return /^\|[\s\-:|]+\|$/.test(line.trim());
}

function parsePipeCells(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const withoutEnd = inner.endsWith("|") ? inner.slice(0, -1) : inner;
  return withoutEnd.split("|");
}
