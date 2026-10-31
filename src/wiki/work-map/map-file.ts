/**
 * `.work-map.json` read by its `kind`: a `themes` map parses through
 * `parseThemeMap`, anything else (a work map carries no `kind`) through
 * `parseWorkMap`, unchanged. The listing field, the GET and the run's previous
 * map read through here; lint check 25 keeps `parseWorkMap`, so it skips a
 * themes map.
 */

import { parseWorkMap, type WorkMap } from "./schema.ts";
import { parseThemeMap, type ThemeMap } from "./theme-schema.ts";
import type { WorkMapKind } from "./kind.ts";

export type StoredMap = { kind: "work"; map: WorkMap } | { kind: "themes"; map: ThemeMap };

/** Parse stored text by its `kind`; null on malformed JSON or a mismatch. */
export function readMapFile(text: string): StoredMap | null {
  let kind: unknown;
  try {
    const raw = JSON.parse(text) as unknown;
    kind = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).kind : undefined;
  } catch {
    return null;
  }
  if (kind === "themes") {
    const map = parseThemeMap(text);
    return map ? { kind: "themes", map } : null;
  }
  if (kind !== undefined && kind !== "work") return null;
  const map = parseWorkMap(text);
  return map ? { kind: "work", map } : null;
}

/** The previous map for a run of `kind`: a map of the other kind reads as none. */
export function previousMapOf(text: string | null, kind: "work"): WorkMap | null;
export function previousMapOf(text: string | null, kind: "themes"): ThemeMap | null;
export function previousMapOf(text: string | null, kind: WorkMapKind): WorkMap | ThemeMap | null {
  if (text === null) return null;
  const stored = readMapFile(text);
  return stored && stored.kind === kind ? stored.map : null;
}
