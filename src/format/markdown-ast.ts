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
  | { type: "ol"; items: string[] }
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
] as const;
export type ComponentName = (typeof COMPONENT_NAMES)[number];

const COMPONENT_NAME_SET: ReadonlySet<string> = new Set(COMPONENT_NAMES);

/** Components allowed to appear self-closing (`<Name …/>`). */
const SELF_CLOSING_ALLOWED: ReadonlySet<ComponentName> = new Set<ComponentName>([
  "FileRef",
  "Verdict",
  "Pill",
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
};

/** Max nesting of component blocks. Bodies are parsed as blocks only while the
 *  current depth is below this; at the cap, inner tags degrade to plain text. */
const MAX_COMPONENT_DEPTH = 2;

// Anchored to the start of a (trimmed) line and gated on a leading `<`, so the
// common case (a line not starting with `<`) fails the match cheaply — the
// parser runs on every chat delta re-render, so this stays single-pass.
const COMPONENT_OPEN_RE = /^<([A-Za-z][A-Za-z0-9]*)((?:\s+[A-Za-z][\w-]*="[^"]*")*)\s*(\/?)>(.*)$/;
const ATTR_RE = /([A-Za-z][\w-]*)="([^"]*)"/g;

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

const CODE_BLOCK_RE = /```(\w*)\n([\s\S]*?)```/g;
const CODE_PLACEHOLDER_RE = /^\x00CB(\d+)\x00$/;
const HR_RE = /^---+$/;
const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const BLOCKQUOTE_RE = /^>\s?(.*)$/;
const UL_RE = /^[-*]\s+(.*)$/;
const OL_RE = /^\d+\.\s+(.*)$/;

export function parseBlocks(text: string): Block[] {
  const normalized = text.replace(/\r\n/g, "\n");

  // Extract code blocks first; their content must not be parsed as markdown.
  // The extraction happens ONCE against `codeBlocks`, before any line-splitting;
  // the array is then threaded through the recursive component-body parse so a
  // `\x00CB{idx}\x00` placeholder inside a component still derefs the same array.
  const codeBlocks: { lang: string; code: string }[] = [];
  const protectedText = normalized.replace(CODE_BLOCK_RE, (_match, lang: string, code: string) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang, code: code.trimEnd() });
    return `\x00CB${idx}\x00`;
  });

  return parseBlocksInner(protectedText, codeBlocks, 0);
}

/** Parse already-fence-extracted text into blocks. `codeBlocks` is the shared
 *  placeholder store; `depth` is the current component-nesting level. */
function parseBlocksInner(
  protectedText: string,
  codeBlocks: { lang: string; code: string }[],
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
      const comp = tryParseComponent(lines, i, codeBlocks, depth, noCloseFrom);
      if (comp) {
        flushText();
        blocks.push(comp.block);
        i = comp.next;
        continue;
      }
    }

    const cbMatch = line.match(CODE_PLACEHOLDER_RE);
    if (cbMatch) {
      flushText();
      const cb = codeBlocks[parseInt(cbMatch[1]!, 10)]!;
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
      while (i < lines.length) {
        const m = lines[i]!.match(OL_RE);
        if (!m) break;
        items.push(m[1]!);
        i++;
      }
      blocks.push({ type: "ol", items });
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
  codeBlocks: { lang: string; code: string }[],
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
    const children = parseBlocksInner(content, codeBlocks, depth + 1);
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

  const children = parseBlocksInner(body.join("\n"), codeBlocks, depth + 1);
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

export const INLINE_COMPONENT_NAMES = ["Verdict", "Pill"] as const;
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

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 1;
}

function isSeparatorRow(line: string): boolean {
  return /^\|[\s\-:|]+\|$/.test(line.trim());
}

function parsePipeCells(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const withoutEnd = inner.endsWith("|") ? inner.slice(0, -1) : inner;
  return withoutEnd.split("|");
}
