/**
 * The ONE spelling of a wiki-relative path key.
 *
 * Its own module rather than a corner of `store.ts` because the worked-on ledger
 * (`worked-ledger.ts`) has to key its rows exactly as the index keys its pages,
 * and `store.ts` already imports that module — so reaching back into it for the
 * normalizer would make the two a cycle. `store.ts` re-exports this name, so
 * every existing importer is unchanged.
 */

import path from "node:path";

/** Canonical graph key for a page path: posix-normalized, lowercased relPath. */
export function normalizeRelPath(relPath: string): string {
  return path.posix.normalize(relPath).toLowerCase();
}
