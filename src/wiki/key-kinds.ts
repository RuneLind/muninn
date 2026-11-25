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
