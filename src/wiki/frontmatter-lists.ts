/**
 * Two frontmatter list readers with no IO: `owns:` (lint check 14's homes) and
 * `related:` (work-thread grouping, plan `muninn-wiki-work-thread-grouping`
 * D18), plus the resolver that turns `related:` entries into pages.
 *
 * Its own module so `store.ts` and `lint-state.ts` both import it and
 * `store.ts → lint-state.ts → lint-drift.ts → store.ts` never becomes a cycle.
 *
 * Both readers parse the frontmatter with `Bun.YAML`. When the whole
 * frontmatter does not parse (a hand-written page may break it anywhere), they
 * parse their own entry alone: the key's line and its continuation lines up to
 * the next top-level key.
 */

import path from "node:path";
import { frontmatterBodyLine } from "./page-text.ts";
import { JIRA_KEY_DENYLIST } from "../jira/key-scan.ts";
import { stampedKeys } from "./trackers/jira.ts";
import { extractWikilinks, WIKILINK_RE } from "./wikilinks.ts";

/** A page's `owns:` as read: whether the frontmatter has the key, the keys it
 *  names, the entry as written (after `owns:`, whitespace collapsed) and the
 *  0-based line of the key. */
export interface OwnsRead {
  present: boolean;
  keys: string[];
  raw: string;
  line: number;
}

const NO_OWNS: OwnsRead = { present: false, keys: [], raw: "", line: 0 };
const OWNS_LINE_RE = /^owns\s*:/;
const RELATED_LINE_RE = /^related\s*:/;
/** A line that starts a new top-level key: column 0, not a comment or a list item. */
const TOP_LEVEL_RE = /^[^\s#-]/;

/** A YAML mapping, or `null` when the text does not parse to one. */
function yamlMap(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = Bun.YAML.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The frontmatter lines (fences excluded), with the whole-block YAML parse
 *  done once and only when a reader asks for it. */
class Frontmatter {
  private parsed: Record<string, unknown> | null | undefined;
  constructor(readonly lines: readonly string[]) {}

  static of(content: string): Frontmatter | null {
    const folded = content.replace(/\r\n/g, "\n");
    const end = frontmatterBodyLine(folded);
    return end === 0 ? null : new Frontmatter(folded.split("\n", end).slice(1, end - 1));
  }

  whole(): Record<string, unknown> | null {
    if (this.parsed === undefined) this.parsed = yamlMap(this.lines.join("\n"));
    return this.parsed;
  }

  /** The LAST line matching `keyRe` and its continuation lines; `at` is -1
   *  when no line matches. */
  entry(keyRe: RegExp): { at: number; lines: string[] } {
    let at = -1;
    for (let i = 0; i < this.lines.length; i++) if (keyRe.test(this.lines[i]!)) at = i;
    if (at < 0) return { at, lines: [] };
    let stop = at + 1;
    while (stop < this.lines.length && !TOP_LEVEL_RE.test(this.lines[stop]!)) stop++;
    return { at, lines: this.lines.slice(at, stop) };
  }
}

/** The Jira keys in an `owns:` value: a string is one entry, a list's strings are
 *  its entries (anything else is ignored), each through `stampedKeys`, with
 *  denylisted prefixes (`UTF-8`) dropped even when the entry is exactly key-shaped. */
export function ownsKeys(value: unknown): string[] {
  const entries =
    typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  const keys = stampedKeys(entries).filter((k) => !JIRA_KEY_DENYLIST.has(k.slice(0, k.indexOf("-"))));
  return [...new Set(keys)];
}

/**
 * A page's `owns:`, read by a YAML parser (`Bun.YAML`), so every YAML form reads
 * as YAML reads it: an inline or multi-line flow list, a block list indented or
 * not, a scalar, comments anywhere. When the whole frontmatter is not valid YAML
 * (a hand-written page may break it elsewhere), only the `owns:` entry is parsed:
 * the `owns:` line and its continuation lines, up to the next top-level key; if
 * that fails too, the value is unreadable and names no key. The sweep reads
 * `owns:` the same way (claude-skills `plan-status-sweep/scripts/sweep-lib.ts`).
 */
export function readOwns(content: string): OwnsRead {
  const fm = Frontmatter.of(content);
  return fm ? ownsFrom(fm) : NO_OWNS;
}

function ownsFrom(fm: Frontmatter): OwnsRead {
  const { at, lines: entry } = fm.entry(OWNS_LINE_RE);
  const raw = entry.join(" ").replace(OWNS_LINE_RE, "").replace(/\s+/g, " ").trim();
  const line = at < 0 ? 1 : at + 1;
  const whole = fm.whole();
  if (whole) {
    if (!Object.hasOwn(whole, "owns")) return NO_OWNS;
    return { present: true, keys: ownsKeys(whole.owns), raw, line };
  }
  if (at < 0) return NO_OWNS;
  const part = yamlMap(entry.join("\n"));
  return { present: true, keys: part ? ownsKeys(part.owns) : [], raw, line };
}

/**
 * Reserved wiki-infrastructure basenames, any folder, any case — never real
 * content pages. Matches the gardener's `FORBIDDEN_BASENAMES`
 * (`src/gardener/draft.ts`), `.mdx` twins included (the source-page drafter
 * writes native `.mdx`).
 */
const RESERVED_BASENAMES = new Set(["log.md", "index.md", "claude.md", "log.mdx", "index.mdx", "claude.mdx"]);

export function isReservedBasename(relPathOrKey: string): boolean {
  return RESERVED_BASENAMES.has(path.posix.basename(relPathOrKey).toLowerCase());
}

/**
 * The wiki-wide `owns:` census (lint check 14's): key → the pages whose `owns:`
 * lists it, in input order. Reserved and culled pages own nothing. Lint's
 * `stateOwners` and the work-thread evidence both read it.
 */
export function ownerCensus(
  pages: Iterable<{ relPath: string; owns: readonly string[]; culled?: boolean }>,
): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const { relPath, owns, culled } of pages) {
    if (culled || isReservedBasename(relPath)) continue;
    for (const key of owns) {
      const list = owners.get(key) ?? [];
      if (!list.includes(relPath)) list.push(relPath);
      owners.set(key, list);
    }
  }
  return owners;
}

// ── related: ───────────────────────────────────────────────────────────────

/** One `related:` entry before resolution: a wikilink target, any other
 *  string, or an item that names no page — a number, a map, or what lies past
 *  the walk's bounds — which is counted as skipped. */
export type RelatedEntry = { kind: "link"; target: string } | { kind: "text"; value: string } | { kind: "unread" };

export interface RelatedRead {
  present: boolean;
  entries: RelatedEntry[];
}

const NO_RELATED: RelatedRead = { present: false, entries: [] };

/** How deep the walk reads nested lists (no list a page writes runs deeper);
 *  what lies deeper is skipped and counted, once, as one `unread`. */
const RELATED_WALK_DEPTH_MAX = 8;
/** The walk's work budget, per character of the parsed text: a step per node
 *  and per character of a string or a map key. Without aliases a value
 *  costs at most about one step per character, so it is read whole; `Bun.YAML`
 *  shares an alias by reference, so an aliased value can be exponentially
 *  larger than its text, and past the budget the walk stops (one `unread`). */
const RELATED_WALK_STEPS_PER_CHAR = 4;

const HAS_WIKILINK_RE = new RegExp(WIKILINK_RE.source);
/** A `:` after a span, past any whitespace: the span is a map key. */
const KEY_AFTER_RE = /\s*:/y;

/** A `[[…]]` the wikilink scanner finds: `start`–`end` covers its `[[inner]]`
 *  (a `[[[a]]]` span's extra `[` excluded), `inner` what lies between. */
interface Span {
  start: number;
  end: number;
  inner: string;
}

function scanSpans(text: string): Span[] {
  return [...text.matchAll(new RegExp(WIKILINK_RE.source, "g"))].map((m) => {
    const inner = m[0].slice(2, -2).replace(/^\[+/, "");
    const end = m.index + m[0].length;
    return { start: end - inner.length - 4, end, inner };
  });
}

/**
 * A page's `related:` entries, read from the raw entry text (D18): the
 * `related:` line and its continuation lines up to the next top-level key.
 *
 * When YAML parses the frontmatter (else the entry alone), YAML decides:
 * 1. A `[[…]]` the wikilink scanner finds there that YAML reads as a sequence
 *    node (an unquoted `[[a]]` is `[["a"]]`) is a link, its target the span's
 *    own text: `[[1.10]]` stays `1.10` and `[[Foo, Bar]]` one link
 *    ({@link markedValue} tells which spans are nodes).
 * 2. The value is walked, nested lists flattened: a string holding a wikilink
 *    yields its links, as YAML spells them (`'[[O''Brien]]'` is `O'Brien`),
 *    any other string is a text entry, a null names nothing, and any other
 *    item is one `unread` entry. A map is one `unread` entry and is read for
 *    links only, keys and values. A span in a comment, or one YAML reads as
 *    part of a string, adds nothing of its own.
 * When neither parses, every span outside a YAML comment, as
 * {@link uncommentedSpans} judges it, is a link.
 *
 * A scalar is a one-entry list and `[]` is none. Link targets dedupe
 * case-insensitively and text exactly, so each target is read once; links come
 * first.
 */
export function readRelated(content: string): RelatedRead {
  const fm = Frontmatter.of(content);
  return fm ? relatedFrom(fm) : NO_RELATED;
}

function relatedFrom(fm: Frontmatter): RelatedRead {
  const { at, lines: entry } = fm.entry(RELATED_LINE_RE);
  const entryText = entry.join("\n");
  // The text YAML parsed, the value it read, and where the entry starts in it.
  let parsed: { text: string; offset: number; value: unknown } | undefined;
  const whole = fm.whole();
  if (whole) {
    if (!Object.hasOwn(whole, "related")) return NO_RELATED;
    const offset = at < 0 ? 0 : fm.lines.slice(0, at).join("\n").length + (at > 0 ? 1 : 0);
    parsed = { text: fm.lines.join("\n"), offset, value: whole.related };
  } else {
    if (at < 0) return NO_RELATED;
    const part = yamlMap(entryText);
    if (part) parsed = { text: entryText, offset: 0, value: part.related };
  }
  const spans = scanSpans(entryText);
  const links: string[] = [];
  const rest: RelatedEntry[] = [];
  const seen = new Set<string>();
  const link = (target: string) => {
    const t = cleanLinkTarget(target);
    if (!t || seen.has(`l\u0000${t.toLowerCase()}`)) return;
    seen.add(`l\u0000${t.toLowerCase()}`);
    links.push(t);
  };
  if (!parsed) {
    for (const s of uncommentedSpans(entryText, spans)) link(s.inner);
    return { present: true, entries: links.map((target) => ({ kind: "link", target })) };
  }
  const text = (v: string) => {
    const t = v.trim();
    if (!t || seen.has(`t\u0000${t}`)) return;
    seen.add(`t\u0000${t}`);
    rest.push({ kind: "text", value: t });
  };
  const linksOf = (v: string) => {
    if (!HAS_WIKILINK_RE.test(v)) return false;
    for (const t of extractWikilinks(v)) link(t);
    return true;
  };

  const marked = markedValue(parsed, spans);
  let steps = RELATED_WALK_STEPS_PER_CHAR * parsed.text.length;
  let skipped = false;
  let stopped = false;
  const skip = () => {
    if (!skipped) rest.push({ kind: "unread" });
    skipped = true;
  };
  const spend = (n: number) => {
    steps -= n;
    if (steps < 0) stopped = true;
    if (stopped) skip();
    return !stopped;
  };
  // A map's links are the same however often an alias repeats it.
  const mapsRead = new Set<object>();
  const walk = (v: unknown, m: unknown, depth: number, inList: boolean): void => {
    if (stopped || !spend(1)) return;
    if (depth > RELATED_WALK_DEPTH_MAX) return skip();
    if (Array.isArray(v)) {
      const span = markedSpan(v, m, spans);
      if (span) return link(span.inner);
      const ms = Array.isArray(m) ? m : undefined;
      for (let i = 0; i < v.length && !stopped; i++) walk(v[i], ms?.[i], depth + 1, inList);
    } else if (typeof v === "string") {
      if (spend(v.length) && !linksOf(v) && inList) text(v);
    } else if (v !== null && typeof v === "object") {
      if (inList) rest.push({ kind: "unread" });
      if (mapsRead.has(v)) return;
      mapsRead.add(v);
      const o = v as Record<string, unknown>;
      const mo = m !== null && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : undefined;
      const keys = Object.keys(o);
      // A key holding a marked span is renamed by its mark (`"x [[a]]"` to
      // `"x [0]"`): the renamed keys pair up in order.
      const renamed = mo ? Object.keys(mo).filter((k) => !Object.hasOwn(o, k)) : [];
      for (let i = 0, r = 0; i < keys.length && !stopped; i++) {
        const k = keys[i]!;
        if (spend(k.length)) linksOf(k);
        const mk = mo && Object.hasOwn(mo, k) ? k : renamed[r++];
        walk(o[k], mo && mk !== undefined ? mo[mk] : undefined, depth + 1, false);
      }
    } else if (v !== null && v !== undefined && inList) rest.push({ kind: "unread" });
  };
  walk(parsed.value, marked, 0, true);
  return { present: true, entries: [...links.map((target): RelatedEntry => ({ kind: "link", target })), ...rest] };
}

/**
 * The `related` value of `parsed.text` re-parsed with every span YAML reads
 * alone as a sequence overwritten by a mark: its index in the span's own
 * brackets (`[[a]]` to `[7]`), so the mark sits wherever the span sat, flow
 * context included, and starts no comment. Where the value held the span's
 * `[[…]]` and this holds `[7]`, span 7 was that node; a span in a comment or
 * inside a string changes no node. Left as written: a span YAML cannot read
 * alone (an unclosed quote, a ` #`), which is no node and whose overwrite
 * could move a quote or a comment, and a span a `:` follows, a map key and no
 * node — so a key a mark renames still holds a `[`, as before, and both keys
 * keep their place in insertion order. Undefined when no span is overwritten
 * or the text does not re-parse.
 */
function markedValue(parsed: { text: string; offset: number }, spans: readonly Span[]): unknown {
  const parts: string[] = [];
  let from = 0;
  spans.forEach((s, i) => {
    KEY_AFTER_RE.lastIndex = parsed.offset + s.end;
    if (KEY_AFTER_RE.test(parsed.text) || !readsAlone(s.inner)) return;
    parts.push(parsed.text.slice(from, parsed.offset + s.start), `[${i}]`);
    from = parsed.offset + s.end;
  });
  return parts.length ? yamlMap(parts.join("") + parsed.text.slice(from))?.related : undefined;
}

/** The span `v` is: the marked value holds a mark (`[n]`) where the value
 *  holds a list of a list. An unmarked list reads alike in both values, so a
 *  number first in it here is a number there too. */
function markedSpan(v: readonly unknown[], m: unknown, spans: readonly Span[]): Span | undefined {
  return Array.isArray(m) && typeof m[0] === "number" && Array.isArray(v[0]) ? spans[m[0]] : undefined;
}

/** Whether YAML reads `[[inner]]` alone as a flow sequence. */
function readsAlone(inner: string): boolean {
  try {
    Bun.YAML.parse(`[[${inner}]]`);
    return true;
  } catch {
    return false;
  }
}

/** The spans of `text` outside its YAML comments — the reader's own judgement,
 *  used only where YAML refuses the entry. A comment is a `#` at a line's
 *  start or after whitespace, to the line's end, outside a quoted scalar and
 *  outside a `[[…]]` span (a span holds no comment, so a `#`, a quote or a
 *  bracket inside one is inert). A quote opens a scalar only where YAML starts
 *  one — a line's start or after `:`, `-`, `[`, `{` or `,` — and only when it
 *  closes later in the entry (`''` and `\"` are escapes); a quoted scalar may
 *  span lines. */
function uncommentedSpans(text: string, spans: readonly Span[]): Span[] {
  // Spans masked to a neutral character: nothing inside one opens a quote or a comment.
  let masked = text;
  if (spans.length) {
    const buf = text.split("");
    for (const s of spans) for (let i = s.start; i < s.end; i++) buf[i] = "x";
    masked = buf.join("");
  }
  const comments: [number, number][] = [];
  let prev = ""; // last non-space character outside quotes on this line
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i]!;
    if (ch === "\n") {
      prev = "";
      continue;
    }
    // The entry starts with `related:`, so a `#` always has a character before it.
    if (ch === "#" && /\s/.test(masked[i - 1]!)) {
      const end = masked.indexOf("\n", i);
      comments.push([i, end < 0 ? masked.length : end]);
      i = end < 0 ? masked.length : end - 1;
      continue;
    }
    if ((ch === "'" || ch === '"') && (prev === "" || ":-[{,".includes(prev))) {
      // A quote that never closes is a literal character, not a scalar.
      const close = closingQuote(masked, i, ch);
      if (close >= 0) {
        i = close;
        prev = ch;
        continue;
      }
    }
    if (!/\s/.test(ch)) prev = ch;
  }
  // Both lists ascend, and a span lies wholly inside or outside a comment.
  let c = 0;
  return spans.filter((s) => {
    while (c < comments.length && comments[c]![1] <= s.start) c++;
    return !(c < comments.length && comments[c]![0] <= s.start);
  });
}

/** The index of the quote that closes the scalar `quote` opens at `open`, or
 *  -1: `''` is an escaped quote in a single-quoted scalar, `\` escapes the next
 *  character in a double-quoted one. A scan that fails leaves every later quote
 *  of its kind paired, so at most one fails per kind: linear overall. */
function closingQuote(text: string, open: number, quote: "'" | '"'): number {
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (quote === '"' && ch === "\\") i++;
    else if (ch === quote) {
      if (quote === "'" && text[i + 1] === "'") i++;
      else return i;
    }
  }
  return -1;
}

/** A wikilink target as the scanner leaves it: `|label` and `#fragment`
 *  dropped, backslash escapes removed, and the leading `[` a `[[[a]]]` span
 *  carries (the scanner reads it as `[a`). */
function cleanLinkTarget(target: string): string {
  let t = target.replace(/\\/g, "").split("|")[0]!.replace(/^\[+/, "").trim();
  const hash = t.indexOf("#");
  if (hash === 0) return "";
  if (hash > 0) t = t.slice(0, hash).trim();
  return t;
}

/** A frontmatter line that may spell an `owns` or `related` key. A YAML key's
 *  letters are written out (any quoting, anchor, tag or flow form) or come
 *  from a double-quoted escape — `\x`, `\u`, `\U`, or a `\` that ends the
 *  line and joins it to the next — and an alias key repeats an anchored node
 *  spelled one of those two ways. So the substring or a backslash is a
 *  superset of what the readers read: a false hit costs one YAML parse, a
 *  miss drops a key. */
const LISTS_KEY_RE = /owns|related|\\/;

/** The frontmatter as {@link Frontmatter.of} would read it — the same
 *  `frontmatterBodyLine` boundary — when a line of it matches
 *  {@link LISTS_KEY_RE}, else `null`. Splits only the frontmatter's lines.
 *  Every line before the closing fence ended in `\n`, so dropping its one
 *  trailing `\r` is what `Frontmatter.of`'s CRLF fold does to it; a quoted
 *  scalar spanning lines reads differently with the `\r` left in. */
function listsFrontmatter(content: string): Frontmatter | null {
  const end = frontmatterBodyLine(content);
  if (end === 0) return null;
  const fm = content.split("\n", end).slice(1, end - 1);
  if (!fm.some((l) => LISTS_KEY_RE.test(l))) return null;
  return new Frontmatter(fm.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l)));
}

/** Owns `owns:` and `related:` of one page with ONE whole-frontmatter parse —
 *  the index read pass. Most pages carry neither key, so a line scan over the
 *  same frontmatter lines skips the parse (measured 2026-10-18: the read pass
 *  over mimir and melosys-kode-wiki takes ~0.9–1.7 ms gated, ~5 ms ungated). */
export function readFrontmatterLists(content: string): { owns: OwnsRead; related: RelatedRead } {
  const fm = listsFrontmatter(content);
  if (!fm) return { owns: NO_OWNS, related: NO_RELATED };
  return { owns: ownsFrom(fm), related: relatedFrom(fm) };
}

// ── resolving related: ─────────────────────────────────────────────────────

/** What the resolver may ask the index. Every answer is a page's relPath as the
 *  listing spells it. */
export interface RelatedResolveContext {
  /** The page whose `related:` this is. */
  fromRelPath: string;
  /** The filesystem roots this wiki answers to (its root and the registered
   *  spellings), for an absolute path. */
  roots: readonly string[];
  /** Exact relPath lookup (case-folded like the index's `resolveRelPath`). */
  byPath(relPath: string): string | undefined;
  /** Every page a lowercased stem, title or alias names. */
  byName(key: string): readonly string[];
  /** The link graph's wikilink resolution (`index.resolve`). */
  byLink(target: string): string | undefined;
}

export interface RelatedResolved {
  /** Distinct target relPaths, the page itself excluded, in entry order. */
  targets: string[];
  /** Entries that name no page: prose, Jira keys, a dangling link, a path
   *  outside the root. A count, never incompleteness. */
  skipped: number;
  /** Entries whose stem, title or alias names more than one page. */
  ambiguous: number;
}

const PAGE_EXT_RE = /\.(?:mdx?|html)$/i;

/**
 * Resolve `related:` entries, each in this order, deduping targets across all
 * steps:
 *  1. a link target goes to the wikilink path (`index.resolve`, the graph's
 *     rule), else to an exact relPath (an `.html` page);
 *  2. `./` or `../` resolves against the page's folder;
 *  3. a filesystem-absolute path counts when it is under a root; a `/…` path
 *     that is not goes on to step 4;
 *  4. otherwise a path resolves root-relative with the extension implied; a
 *     bare name resolves in the page's own folder as spelled, then by its stem
 *     (`foo.html` → `foo`), then at the root the same two ways — `.md`, then
 *     `.mdx` implied where the name spells no page extension — then by stem,
 *     title or alias, only when that names one page, else it is ambiguous;
 *  5. anything else is skipped.
 */
export function resolveRelatedEntries(entries: readonly RelatedEntry[], ctx: RelatedResolveContext): RelatedResolved {
  const self = ctx.byPath(ctx.fromRelPath);
  const targets: string[] = [];
  let skipped = 0;
  let ambiguous = 0;
  const add = (rel: string) => {
    if (rel !== self && !targets.includes(rel)) targets.push(rel);
  };
  const dir = path.posix.dirname(ctx.fromRelPath);
  const byPathImplied = (rel: string): string | undefined => {
    const r = rel.replace(/^\/+/, "");
    if (!r || r === ".." || r.startsWith("../")) return undefined;
    return ctx.byPath(r) ?? (PAGE_EXT_RE.test(r) ? undefined : (ctx.byPath(`${r}.md`) ?? ctx.byPath(`${r}.mdx`)));
  };
  const relative = (v: string) => byPathImplied(path.posix.normalize(path.posix.join(dir, v)));
  const roots = ctx.roots.map((r) => r.replace(/\\/g, "/").replace(/\/+$/, "").normalize("NFC").toLowerCase());

  for (const e of entries) {
    let hit: string | undefined;
    let isAmbiguous = false;
    if (e.kind === "unread") {
      // A number or a map names no page.
    } else if (e.kind === "link") {
      const t = e.target.replace(/\\/g, "/");
      hit = /^\.{1,2}\//.test(t) ? relative(t) : (ctx.byLink(e.target) ?? ctx.byPath(t));
    } else {
      const v = e.value.replace(/\\/g, "/").replace(/#[^\s/]*$/, "").trim();
      if (/^\.{1,2}\//.test(v)) hit = relative(v);
      else if (v.startsWith("/")) {
        // Under a root it is filesystem-absolute; otherwise (or when that
        // names no page) `/plans/a.md` is root-relative, step 4.
        const lower = v.normalize("NFC").toLowerCase();
        const root = roots.find((r) => lower.startsWith(r + "/"));
        hit = (root ? byPathImplied(v.normalize("NFC").slice(root.length + 1)) : undefined) ?? byPathImplied(v);
      } else if (v.includes("/")) hit = byPathImplied(v);
      else if (v) {
        // A bare name: the page's own folder, then the root — each as
        // spelled, then by its stem — then a stem, title or alias.
        const stem = v.replace(PAGE_EXT_RE, "");
        const inDir = (name: string) => (dir === "." ? name : `${dir}/${name}`);
        hit = byPathImplied(inDir(v)) ?? byPathImplied(inDir(stem)) ?? byPathImplied(v) ?? byPathImplied(stem);
        if (!hit) {
          const named = new Set([...ctx.byName(v.toLowerCase()), ...ctx.byName(stem.toLowerCase())]);
          if (named.size === 1) hit = [...named][0];
          else if (named.size > 1) isAmbiguous = true;
        }
      }
    }
    if (hit) add(hit);
    else if (isAmbiguous) ambiguous++;
    else skipped++;
  }
  return { targets, skipped, ambiguous };
}
