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
import { frontmatterEndLine } from "../dashboard/views/components/wiki-integrate.ts";
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
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    const end = frontmatterEndLine(lines);
    return end === 0 ? null : new Frontmatter(lines.slice(1, end - 1));
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

// ── related: ───────────────────────────────────────────────────────────────

/** One `related:` entry before resolution: a wikilink target (from the scanner,
 *  from a string that is a wikilink, or from YAML's nested-list reading of an
 *  unquoted `[[a]]`), or any other string. */
export type RelatedEntry = { kind: "link"; target: string } | { kind: "text"; value: string };

export interface RelatedRead {
  present: boolean;
  entries: RelatedEntry[];
}

const NO_RELATED: RelatedRead = { present: false, entries: [] };

/**
 * A page's `related:` entries, read from the raw entry text (D18): every
 * `[[…]]` the wikilink scanner finds in the `related:` line and its
 * continuation lines, plus the strings a YAML parse yields — of the whole
 * frontmatter, else of that entry alone — with nested lists flattened. A YAML
 * reader alone loses the unquoted wikilink forms: `[[a]]` parses as a nested
 * list and `[[a]], [[b]]` does not parse at all.
 *
 * A scalar is a one-entry list and `[]` is none. A string that holds a
 * wikilink yields its link targets (the scanner's), and a string inside a
 * nested list is a link target (YAML's reading of `[[a]]`), `|label` and
 * `#fragment` stripped. Link targets dedupe case-insensitively, so
 * `["[[a]]"]` and an unquoted `[[a]]` are one entry each, not two.
 */
export function readRelated(content: string): RelatedRead {
  const fm = Frontmatter.of(content);
  return fm ? relatedFrom(fm) : NO_RELATED;
}

function relatedFrom(fm: Frontmatter): RelatedRead {
  const { at, lines: entry } = fm.entry(RELATED_LINE_RE);
  const whole = fm.whole();
  let value: unknown;
  if (whole) {
    if (!Object.hasOwn(whole, "related")) return NO_RELATED;
    value = whole.related;
  } else {
    if (at < 0) return NO_RELATED;
    value = yamlMap(entry.join("\n"))?.related;
  }
  const out: RelatedEntry[] = [];
  const seen = new Set<string>();
  const link = (target: string) => {
    const t = cleanLinkTarget(target);
    if (!t || seen.has(`l\u0000${t.toLowerCase()}`)) return;
    seen.add(`l\u0000${t.toLowerCase()}`);
    out.push({ kind: "link", target: t });
  };
  const text = (v: string) => {
    const t = v.trim();
    if (!t || seen.has(`t\u0000${t}`)) return;
    seen.add(`t\u0000${t}`);
    out.push({ kind: "text", value: t });
  };
  for (const t of extractWikilinks(entry.join("\n"))) link(t);
  const top = (v: unknown) => {
    if (v === null || v === undefined) return;
    if (typeof v === "string") {
      if (new RegExp(WIKILINK_RE.source).test(v)) for (const t of extractWikilinks(v)) link(t);
      else text(v);
    } else if (Array.isArray(v)) nested(v);
    else text(typeof v === "object" ? JSON.stringify(v) : String(v));
  };
  const nested = (list: readonly unknown[]) => {
    for (const v of list) {
      if (Array.isArray(v)) nested(v);
      else if (typeof v === "string") link(v);
      else top(v);
    }
  };
  if (Array.isArray(value)) for (const v of value) (Array.isArray(v) ? nested(v) : top(v));
  else top(value);
  return { present: true, entries: out };
}

/** A wikilink target as the scanner leaves it: `|label` and `#fragment`
 *  dropped, backslash escapes removed. */
function cleanLinkTarget(target: string): string {
  let t = target.replace(/\\/g, "").split("|")[0]!.trim();
  const hash = t.indexOf("#");
  if (hash === 0) return "";
  if (hash > 0) t = t.slice(0, hash).trim();
  return t;
}

/** Owns `owns:` and `related:` of one page with ONE whole-frontmatter parse —
 *  the index read pass. */
export function readFrontmatterLists(content: string): { owns: OwnsRead; related: RelatedRead } {
  const fm = Frontmatter.of(content);
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
 *  3. a filesystem-absolute path counts when it is under a root;
 *  4. otherwise a path resolves root-relative with the extension implied, and a
 *     bare name in the page's own folder first (`resolveSupersededBy`'s
 *     pattern), then root-level, then by stem, title or alias — only when it
 *     names one page, else it is ambiguous;
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
    if (e.kind === "link") {
      const t = e.target.replace(/\\/g, "/");
      hit = /^\.{1,2}\//.test(t) ? relative(t) : (ctx.byLink(e.target) ?? ctx.byPath(t));
    } else {
      const v = e.value.replace(/\\/g, "/").replace(/#[^\s/]*$/, "").trim();
      if (/^\.{1,2}\//.test(v)) hit = relative(v);
      else if (v.startsWith("/")) {
        const lower = v.normalize("NFC").toLowerCase();
        const root = roots.find((r) => lower.startsWith(r + "/"));
        hit = root ? byPathImplied(v.normalize("NFC").slice(root.length + 1)) : undefined;
      } else if (v.includes("/")) hit = byPathImplied(v);
      else if (v) {
        // A bare name: the page's own folder, then the root, then a name.
        const stem = v.replace(PAGE_EXT_RE, "");
        const inDir = (name: string) => (dir === "." ? name : `${dir}/${name}`);
        hit = byPathImplied(inDir(v)) ?? (stem !== v ? byPathImplied(inDir(stem)) : undefined) ?? byPathImplied(v);
        if (!hit && stem !== v) hit = byPathImplied(stem);
        if (!hit) {
          const named = new Set([...ctx.byName(v.toLowerCase()), ...(stem !== v ? ctx.byName(stem.toLowerCase()) : [])]);
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
