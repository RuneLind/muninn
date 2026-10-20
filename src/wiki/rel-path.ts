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

/**
 * A wiki-relative path in the spelling both sides compare on.
 *
 * The index's own `normalizeRelPath` does the work — posix-normalize (which
 * collapses `..` and `//`, neither of which a hand-rolled prefix strip sees) and
 * lower-case — with a LEADING-SLASH strip layered on top, because this side's
 * rows come from a tool that may have spelled the path `/plans/a.md` while the
 * index stores `plans/a.md`. One normalizer, so a key the store looks up is the
 * key the ledger stored.
 *
 * Lower-cased unlike the git date walk's raw-relPath keying, and deliberately:
 * that walk and the index read one filesystem through one tool, so a case
 * difference there IS a bug worth missing on. This map comes from a SECOND
 * process reading a case-insensitive filesystem through whatever spelling an
 * agent typed, so a case-only difference is noise — and the match rate is the
 * guard that a real mismatch still fires.
 *
 * NFC-folded too: macOS hands back an NFD name while claude-usage reports
 * NFC, and `workPathKey` (the work facts' key) is this function, so a page
 * never gets work events without its `workedMs` (arch review 2026-10, 83).
 */
export function normalizeWorkedPath(p: string): string {
  // Empty stays empty: `posix.normalize("")` is ".", which a caller testing
  // for "no path" (`findPageByRelPath`, `workGroupPagePath`) would read as one.
  if (!p) return "";
  return normalizeRelPath(p.replace(/\\/g, "/")).replace(/^\/+/, "").normalize("NFC");
}
