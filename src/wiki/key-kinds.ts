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
 * bodies, so a pattern that can backtrack without bound (`MEL-(\d+)+` took
 * 256 ms on a 31-character near miss, doubling per digit) is dropped when the
 * config is read ({@link backtrackReason}). Accepted: quantifiers on single
 * characters and classes (`MEL-\d+`, `[A-Z]{2,10}-\d+`), alternation, and
 * groups repeated with fixed-length contents (`(?:-[a-z]{2})+`).
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
    const slow = backtrackReason(e.pattern);
    if (slow) return void warnings.push(`entry ${i} (${e.name}): pattern can backtrack without bound (${slow}) — dropping it`);
    kinds.push({ name: e.name, pattern: e.pattern, whole });
  });
  return { kinds, warnings };
}

/**
 * The kind of `key`: a Jira tracker's id when the key is `PROJECT-n` for one of
 * its projects, else the first `keys` entry whose pattern matches the whole key,
 * else null. Trackers first, so a `keys` entry cannot rename a Jira key.
 */
export function classifyKey(key: string, trackers: readonly TrackerConfig[], kinds: readonly KeyKind[]): string | null {
  const m = /^([A-Z][A-Z0-9]{1,15})-\d{1,8}$/.exec(key);
  if (m) for (const t of trackers) if (t.projects.includes(m[1]!)) return t.id;
  for (const k of kinds) if (k.whole.test(key)) return k.name;
  return null;
}

// ── The backtracking check ─────────────────────────────────────────────
// A conservative screen, not a proof: it refuses some patterns that are safe
// (`(?:\d+a)\d+`) to be sure of refusing the shapes that are not. It runs on a
// pattern that already compiled with the `u` flag, so the syntax is valid.

interface Quant {
  min: number;
  max: number;
}
type Node =
  | { kind: "char"; src: string; q: Quant }
  | { kind: "assert" }
  | { kind: "backref" }
  | { kind: "group"; alts: Node[][]; look: boolean; q: Quant };

const ONE: Quant = { min: 1, max: 1 };

function parsePattern(src: string): Node[][] {
  const cps = [...src];
  let i = 0;
  const readTo = (end: string): string => {
    let out = "";
    while (i < cps.length && cps[i] !== end) out += cps[i++];
    i++;
    return out + end;
  };
  const quant = (): Quant => {
    const c = cps[i];
    let q: Quant | null = null;
    if (c === "*") q = { min: 0, max: Infinity };
    else if (c === "+") q = { min: 1, max: Infinity };
    else if (c === "?") q = { min: 0, max: 1 };
    if (q) i++;
    else if (c === "{") {
      i++;
      const body = readTo("}").slice(0, -1);
      const [lo, hi] = body.split(",");
      q = { min: Number(lo), max: hi === undefined ? Number(lo) : hi === "" ? Infinity : Number(hi) };
    }
    if (q && cps[i] === "?") i++; // lazy: the same cost
    return q ?? ONE;
  };
  const alts = (): Node[][] => {
    const out: Node[][] = [[]];
    while (i < cps.length) {
      const c = cps[i]!;
      if (c === ")") return out;
      if (c === "|") {
        i++;
        out.push([]);
        continue;
      }
      const seq = out[out.length - 1]!;
      if (c === "^" || c === "$") {
        i++;
        seq.push({ kind: "assert" });
      } else if (c === "(") {
        i++;
        let look = false;
        if (cps[i] === "?") {
          const next = cps[i + 1];
          if (next === "=" || next === "!") (look = true), (i += 2);
          else if (next === "<" && (cps[i + 2] === "=" || cps[i + 2] === "!")) (look = true), (i += 3);
          else if (next === "<") (i += 2), readTo(">");
          else readTo(":"); // `(?:`, or a modifier group such as `(?i:`
        }
        const inner = alts();
        i++; // the `)`
        seq.push({ kind: "group", alts: inner, look, q: look ? ONE : quant() });
      } else if (c === "[") {
        let cls = "";
        while (i < cps.length && cps[i] !== "]") {
          if (cps[i] === "\\") cls += cps[i++];
          cls += cps[i++];
        }
        i++;
        seq.push({ kind: "char", src: `${cls}]`, q: quant() });
      } else if (c === "\\") {
        i++;
        const e = cps[i++]!;
        if (e === "b" || e === "B") seq.push({ kind: "assert" });
        else if (/[1-9]/.test(e) || e === "k") {
          if (e === "k") readTo(">");
          else while (/[0-9]/.test(cps[i] ?? "")) i++;
          seq.push({ kind: "backref" });
          quant();
        } else {
          let esc = `\\${e}`;
          if ((e === "p" || e === "P" || e === "u") && cps[i] === "{") esc += readTo("}");
          else if (e === "u") esc += cps.slice(i, (i += 4)).join("");
          else if (e === "x") esc += cps.slice(i, (i += 2)).join("");
          else if (e === "c") esc += cps[i++];
          seq.push({ kind: "char", src: esc, q: quant() });
        }
      } else {
        i++;
        seq.push({ kind: "char", src: c === "." ? "." : c.replace(/[$()*+.?[\\\]^{|}]/, "\\$&"), q: quant() });
      }
    }
    return out;
  };
  return alts();
}

/** Code points a character set is sampled over: ASCII, Latin, and one of each common script, so `\p{L}` and `[^x]` meet what they should. */
const SAMPLE: string[] = [
  ...Array.from({ length: 0x250 }, (_, n) => String.fromCodePoint(n)),
  ...[0x391, 0x3b1, 0x410, 0x430, 0x5d0, 0x627, 0x905, 0x2028, 0x3042, 0x4e00, 0xac00, 0xfeff, 0x10000, 0x1d400, 0x1f600].map((n) => String.fromCodePoint(n)),
];

const sampled = new Map<string, Set<number>>();

/** The sample indices one character matcher accepts. */
function sampleSet(src: string): Set<number> {
  let out = sampled.get(src);
  if (out) return out;
  const re = new RegExp(`^(?:${src})$`, "u");
  out = new Set<number>();
  for (let n = 0; n < SAMPLE.length; n++) if (re.test(SAMPLE[n]!)) out.add(n);
  sampled.set(src, out);
  return out;
}

const union = (sets: Iterable<Set<number>>): Set<number> => {
  const out = new Set<number>();
  for (const s of sets) for (const n of s) out.add(n);
  return out;
};
const meet = (a: Set<number>, b: Set<number>): Set<number> => new Set([...a].filter((n) => b.has(n)));

function nullable(node: Node): boolean {
  if (node.kind === "assert" || node.kind === "backref") return true;
  if (node.kind === "group" && node.look) return true;
  if (node.q.min === 0) return true;
  return node.kind === "group" && node.alts.some((seq) => seq.every(nullable));
}

/** Every character a node can consume, anywhere in it. */
function chars(node: Node): Set<number> {
  if (node.kind === "char") return sampleSet(node.src);
  if (node.kind === "group" && !node.look) return union(node.alts.flat().map(chars));
  return new Set();
}

/** The characters a sequence can start (`edge` "first") or end (`"last"`) with. */
function edgeOf(seq: readonly Node[], edge: "first" | "last"): Set<number> {
  const ordered = edge === "first" ? seq : [...seq].reverse();
  const out: Set<number>[] = [];
  for (const node of ordered) {
    if (node.kind === "char") out.push(sampleSet(node.src));
    else if (node.kind === "group" && !node.look) out.push(union(node.alts.map((s) => edgeOf(s, edge))));
    if (!nullable(node)) break;
  }
  return union(out);
}

/** A node that can consume input without bound. */
function unbounded(node: Node): boolean {
  if (node.kind === "char") return node.q.max === Infinity;
  if (node.kind !== "group" || node.look) return false;
  return node.q.max === Infinity || node.alts.some((seq) => seq.some(unbounded));
}

const variable = (q: Quant): boolean => q.min !== q.max;

/** Why matching `pattern` can backtrack without bound, or null when the screen finds no reason. */
export function backtrackReason(pattern: string): string | null {
  const walk = (alts: readonly Node[][], inRepeat: boolean): string | null => {
    if (inRepeat && alts.length > 1) {
      // Each round of a repeat must pick its alternative by its first character.
      const firsts: Set<number>[] = [];
      for (const seq of alts) {
        if (seq.every(nullable)) return "an alternative inside a repeat can match nothing";
        const first = edgeOf(seq, "first");
        if (firsts.some((f) => meet(f, first).size)) return "alternatives inside a repeat can start with the same character";
        firsts.push(first);
      }
    }
    for (const seq of alts) {
      for (const node of seq) {
        if (node.kind === "backref") return "a backreference";
        if (node.kind === "assert") continue;
        if (inRepeat && variable(node.q)) return "a quantifier inside a repeated group";
        if (node.kind === "group") {
          const why = walk(node.alts, inRepeat || node.q.max > 1);
          if (why) return why;
        }
      }
      // Two unbounded atoms that can trade the same characters, with nothing
      // between them that only one side could take: every split is tried.
      for (let a = 0; a < seq.length; a++) {
        if (!unbounded(seq[a]!)) continue;
        for (let b = a + 1; b < seq.length; b++) {
          if (!unbounded(seq[b]!)) continue;
          const shared = meet(edgeOf([seq[a]!], "last"), edgeOf([seq[b]!], "first"));
          if (!shared.size) continue;
          if (seq.slice(a + 1, b).every((n) => nullable(n) || meet(chars(n), shared).size)) return "adjacent unbounded repeats that can match the same characters";
        }
      }
    }
    return null;
  };
  return walk(parsePattern(pattern), false);
}
