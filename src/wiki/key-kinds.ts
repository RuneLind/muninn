/**
 * `keys` in `.wiki-reader.json` (Discuss v2, mimir plan muninn-wiki-discuss-v2):
 * key kinds the wiki's `trackers` cannot express, such as the kode-wiki's case
 * numbers.
 *
 * ```json
 * "keys": [{ "name": "case", "pattern": "MEL-\\d+" }]
 * ```
 *
 * A pattern only classifies a key's `kind` (the mentions route) and finds keys
 * to mark (the Trace view). It never gates a search: the mentions route greps
 * any literal key whatever its kind.
 *
 * The key comes from a request and the Trace view runs the patterns over page
 * bodies, so a pattern must be in a grammar whose anchored match cannot
 * backtrack without bound ({@link grammarReason}); any other is dropped with a
 * warning. The grammar: a sequence of atoms, each a literal character (a
 * metacharacter escaped), `\d`, or a class `[...]` of literal characters,
 * ranges and `\d` (no negation); each optionally followed by `?`, `{m}` or
 * `{m,n}` with m, n ≤ 32, and only the last by `+`, `*` or `{m,}`. No group,
 * alternation, anchor, lookaround, backreference, other escape, flag or lazy
 * quantifier. Every atom matches one character from an exact set of code
 * points, so one more rule is checked exactly, not sampled: an atom with a
 * variable count can share no character with the atoms after it up to and
 * including the first that must match one. Without it, eight `\d{0,32}` before
 * an `x` took 49.9 s on an 80-character key. With it, a count given back can
 * only fail at once, so a match costs O(key × pattern).
 * `MEL-\d+`, `[A-Z]{2,10}-\d+` and `MELOSYS-\d+` are in it.
 *
 * Anchored-safe is not scan-safe: an unanchored scan of a line tries every
 * start, so a caller marking keys in page text bounds the line length too.
 */

import type { TrackerConfig } from "./trackers/types.ts";

export const KEY_PATTERN_MAX = 200;
const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

export interface KeyKind {
  name: string;
  pattern: string;
  /** The pattern anchored at both ends: does a whole key belong to this kind? */
  whole: RegExp;
}

/** Validate a `keys` value. Absent ⇒ `[]` with no warning; a bad entry warns
 *  and is dropped, the rest stand; a value that is not an array ⇒ `[]`. Each
 *  pattern is compiled here, once. */
export function parseKeyKinds(raw: unknown): { kinds: KeyKind[]; warnings: string[] } {
  if (raw === undefined || raw === null) return { kinds: [], warnings: [] };
  if (!Array.isArray(raw)) return { kinds: [], warnings: ["is not an array of {name, pattern} — ignoring it"] };
  const kinds: KeyKind[] = [];
  const warnings: string[] = [];
  raw.forEach((entry, i) => {
    const e = entry as { name?: unknown; pattern?: unknown } | null;
    if (!e || typeof e !== "object" || Array.isArray(e)) return void warnings.push(`entry ${i} is not an object {name, pattern} — dropping it`);
    if (typeof e.name !== "string" || !NAME_RE.test(e.name)) return void warnings.push(`entry ${i}: name must be a lower-case word (a-z, digits, "-", at most 32) — dropping it`);
    if (kinds.some((k) => k.name === e.name)) return void warnings.push(`entry ${i}: name ${JSON.stringify(e.name)} is listed twice — dropping it`);
    if (typeof e.pattern !== "string" || e.pattern === "") return void warnings.push(`entry ${i} (${e.name}): pattern is not a non-empty string — dropping it`);
    if (e.pattern.length > KEY_PATTERN_MAX) return void warnings.push(`entry ${i} (${e.name}): pattern is longer than ${KEY_PATTERN_MAX} characters — dropping it`);
    let whole: RegExp;
    try {
      whole = new RegExp(`^(?:${e.pattern})$`, "u");
    } catch (err) {
      return void warnings.push(`entry ${i} (${e.name}): pattern does not compile (${err instanceof Error ? err.message : String(err)}) — dropping it`);
    }
    const outside = grammarReason(e.pattern);
    if (outside) return void warnings.push(`entry ${i} (${e.name}): pattern is outside the key grammar (${outside}) — dropping it`);
    kinds.push({ name: e.name, pattern: e.pattern, whole });
  });
  return { kinds, warnings };
}

/**
 * The kind of `key`: a Jira tracker's id when the key is `PROJECT-n` for one of
 * its projects, else the first `keys` entry whose pattern matches the whole key,
 * else null. Trackers first, so a `keys` entry cannot rename a Jira key.
 */
export function classifyKey(key: string, trackers: readonly Pick<TrackerConfig, "id" | "projects">[], kinds: readonly Pick<KeyKind, "whole" | "name">[]): string | null {
  const m = /^([A-Z][A-Z0-9]{1,15})-\d{1,8}$/.exec(key);
  if (m) for (const t of trackers) if (t.projects.includes(m[1]!)) return t.id;
  for (const k of kinds) if (k.whole.test(key)) return k.name;
  return null;
}

// ── The key grammar ────────────────────────────────────────────────────
// It runs on a pattern that already compiled with the `u` flag.

/** Counts above this are refused: a bounded count is still tried count by count. */
export const KEY_COUNT_MAX = 32;
/** Characters an escape outside a class may stand for: the metacharacters, and `/`. */
const ESCAPABLE = new Set([..."^$\\.*+?()[]{}|/"]);
const META = new Set([..."^$\\.*+?()[]{}|"]);
const DIGITS: [number, number] = [0x30, 0x39];

interface Atom {
  /** The code points it matches, as inclusive ranges. */
  set: [number, number][];
  min: number;
  max: number;
}

const overlaps = (a: Atom, b: Atom): boolean => a.set.some(([lo, hi]) => b.set.some(([lo2, hi2]) => lo <= hi2 && lo2 <= hi));

/** Why `pattern` is outside the key grammar, or null when it is in it. */
export function grammarReason(pattern: string): string | null {
  const cps = [...pattern];
  const atoms: Atom[] = [];
  let i = 0;
  while (i < cps.length) {
    const c = cps[i]!;
    let set: [number, number][];
    if (c === "\\") {
      const e = cps[i + 1];
      if (e === "d") set = [DIGITS];
      else if (e !== undefined && ESCAPABLE.has(e)) set = [[e.codePointAt(0)!, e.codePointAt(0)!]];
      else return `the escape \\${e ?? ""}`;
      i += 2;
    } else if (c === "[") {
      i++;
      if (cps[i] === "^") return "a negated class";
      set = [];
      while (i < cps.length && cps[i] !== "]") {
        if (cps[i] === "[") return "a nested class";
        if (cps[i] === "\\") {
          if (cps[i + 1] !== "d") return `the class escape \\${cps[i + 1] ?? ""}`;
          set.push(DIGITS);
          i += 2;
          continue;
        }
        const lo = cps[i]!.codePointAt(0)!;
        if (cps[i + 1] === "-" && cps[i + 2] !== undefined && cps[i + 2] !== "]") {
          if (cps[i + 2] === "\\" || cps[i + 2] === "[") return "a class range that ends in an escape";
          set.push([lo, cps[i + 2]!.codePointAt(0)!]);
          i += 3;
        } else {
          set.push([lo, lo]);
          i++;
        }
      }
      if (cps[i] !== "]" || set.length === 0) return "an empty or unclosed class";
      i++;
    } else if (META.has(c)) {
      return `the metacharacter ${c}`;
    } else {
      set = [[c.codePointAt(0)!, c.codePointAt(0)!]];
      i++;
    }
    let min = 1;
    let max = 1;
    const q = cps[i];
    if (q === "?") (min = 0), i++;
    else if (q === "*") (min = 0), (max = Infinity), i++;
    else if (q === "+") (max = Infinity), i++;
    else if (q === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(cps.slice(i).join(""));
      if (!m) return "a malformed count";
      min = Number(m[1]);
      max = m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]);
      if (min > KEY_COUNT_MAX || (max !== Infinity && max > KEY_COUNT_MAX)) return `a count over ${KEY_COUNT_MAX}`;
      i += m[0].length;
    }
    if (cps[i] === "?" && q !== undefined && "?*+{".includes(q)) return "a lazy quantifier";
    atoms.push({ set, min, max });
  }
  for (let a = 0; a < atoms.length; a++) {
    if (atoms[a]!.max === Infinity && a < atoms.length - 1) return "an unbounded atom that is not the last";
    if (atoms[a]!.min === atoms[a]!.max) continue;
    for (let b = a + 1; b < atoms.length; b++) {
      if (overlaps(atoms[a]!, atoms[b]!)) return "an atom with a variable count next to one that can match the same character";
      if (atoms[b]!.min > 0) break;
    }
  }
  return null;
}

// ── Marking keys in page text (Discuss v2 PR 6) ─────────────────────────

/**
 * Lines longer than this are not scanned for `keys` kinds. Measured
 * 2026-11-26 in UTF-16 units over the tracked pages: the longest lines are
 * tables (kode-wiki `index.md` 30,208, mimir `projects/muninn/dashboard.md`
 * 25,804), and 4 kode-wiki and 13 mimir lines pass 4,000. A worst
 * grammar-legal line (`[-A]+` over `-A` repeated, then a letter) costs ~2 ms
 * per kind at 4,000: quadratic, since each start runs to the same letter.
 */
export const KEY_SCAN_LINE_MAX = 4000;

/**
 * Characters × kinds one page may scan; the lines after the budget is spent
 * are skipped and counted. Measured 2026-11-26: the worst line above costs
 * ~0.5 µs per character per kind (515 ms for 250 such lines, one kind), so
 * this caps a page near 0.5 s whatever its kinds; the largest kode-wiki page
 * (`log.md`, 738,635 scannable characters, one kind) still scans whole.
 */
export const KEY_SCAN_PAGE_MAX = 1_000_000;

/** A key's own character: a Unicode letter or digit, the mentions route's
 *  whole-key rule (`wholeKeyCount`); `_` and `-` do not continue a key. */
const KEY_CHAR = /^[\p{L}\p{N}]$/u;

/** The code point that ends right before `i` / starts at `i`, as a string. */
function charBefore(text: string, i: number): string {
  const lo = text.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = text.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return text.slice(i - 2, i);
  }
  return text[i - 1]!;
}
const charAt = (text: string, i: number): string => String.fromCodePoint(text.codePointAt(i)!);

/**
 * Every whole-key match of a `keys` kind in `text`, with its kind: a match
 * starts where no Unicode letter or digit comes before it and ends where none
 * comes after (the mentions route's rule, so the peek counts what is marked),
 * and is a key the mentions route searches (3–80 characters).
 * Tried only at such starts, with a sticky copy of each pattern, so a run of
 * letters is tried once, not at each of its offsets. Overlaps keep the
 * earlier match (then the longer). Lines over `lineMax` are skipped, and so
 * is every line once `pageMax` characters × kinds are spent: both counted in
 * `skippedLines` (and their characters in `skippedChars`).
 */
export function scanKeyKinds(
  text: string,
  kinds: readonly Pick<KeyKind, "name" | "pattern">[],
  lineMax = KEY_SCAN_LINE_MAX,
  pageMax = KEY_SCAN_PAGE_MAX,
): { matches: { key: string; kind: string; start: number; end: number }[]; skippedLines: number; skippedChars: number } {
  if (kinds.length === 0) return { matches: [], skippedLines: 0, skippedChars: 0 };
  const sticky = kinds.map((k) => ({ name: k.name, re: new RegExp(k.pattern, "uy") }));
  const out: { key: string; kind: string; start: number; end: number }[] = [];
  let skippedLines = 0;
  let skippedChars = 0;
  let spent = 0;
  let lineStart = 0;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd < 0) lineEnd = text.length;
    const cost = (lineEnd - lineStart) * sticky.length;
    if (lineEnd - lineStart > lineMax || spent + cost > pageMax) {
      skippedLines++;
      skippedChars += lineEnd - lineStart;
      // Once over the page budget, every later line is skipped too.
      if (lineEnd - lineStart <= lineMax) spent = pageMax + 1;
    } else {
      spent += cost;
      for (let i = lineStart; i < lineEnd; i++) {
        if (i > lineStart && KEY_CHAR.test(charBefore(text, i))) continue;
        let best: { key: string; kind: string; start: number; end: number } | null = null;
        for (const k of sticky) {
          k.re.lastIndex = i;
          const m = k.re.exec(text);
          if (!m) continue;
          const end = i + m[0].length;
          if (end > lineEnd || m[0].length < 3 || m[0].length > 80) continue;
          if (end < lineEnd && KEY_CHAR.test(charAt(text, end))) continue;
          if (!best || end > best.end) best = { key: m[0], kind: k.name, start: i, end };
        }
        if (best) {
          out.push(best);
          i = best.end - 1;
        }
      }
    }
    lineStart = lineEnd + 1;
  }
  return { matches: out, skippedLines, skippedChars };
}
