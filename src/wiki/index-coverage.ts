/**
 * Wiki index-coverage computation (read-only overview).
 *
 * Huginn search collections are rebuilt daily by launchd jobs, but nothing
 * compares a wiki's on-disk pages against what is actually indexed. A page added
 * outside the gardener, a failed nightly reindex, or a renamed file silently
 * drops out of Ask/search with no signal. This module measures that drift:
 *
 *  - **missing** — wiki `.md` pages absent from EVERY backing collection that
 *    huginn's manifests SAY should index them (actionable gaps only);
 *  - **excludedByRule** — wiki `.md` pages that no backing collection would ever
 *    index by design: excluded by a collection's `excludePatterns` (the meta
 *    denylist — `index.md`, `log.md`, `CLAUDE.md`, `plans/*`, dotfiles) or out of
 *    scope of its `includePatterns` (e.g. a `^life/.*`-scoped collection). Purely
 *    informational — NOT counted as missing (it's permanent, expected noise);
 *  - **ghosts**  — indexed doc ids with no matching file on disk (a rename /
 *    delete the reindex hasn't caught up with, or a stale document). Only `.md`/
 *    `.html` ids count — collections that also index `.gitignore`/`.txt`/`.json`
 *    files (e.g. mimir) would otherwise show those as false ghosts;
 *  - **htmlPages** — `.html` explainers in the wiki. Informational only: HTML
 *    explainers are effectively NOT indexed (huginn indexes `.md`), so they are
 *    NEVER counted as missing.
 *
 * LOAD-BEARING — key normalization. Huginn's doc `id` IS the wiki-relative path
 * (e.g. `life/concepts/Chronotypes.md`). We compare pages to ids on a normalized
 * key: posix-normalize + lowercase (`normalizeRelPath`) + Unicode **NFC**. macOS
 * file APIs return NFD for composed characters while huginn's ids may be NFC —
 * without the NFC fold, Norwegian page names (æ/ø/å, common in melosys-kode-wiki)
 * would show as false missing+ghost pairs. Membership is computed against the
 * deduped UNION of a wiki's collections, so a page present in two collections
 * (the jarvis `wiki` superset of `wiki-life`) is never double-counted. Output
 * reports ORIGINAL (un-normalized) relPaths/ids, matching on normalized keys.
 *
 * LOAD-BEARING — pattern semantics. The exclude/include partition mirrors
 * huginn's `FilesDocumentReader` (`main/sources/files/files_document_reader.py`):
 * BOTH include and exclude patterns are applied with Python `re.fullmatch`
 * (`__is_file_included` / `__is_file_excluded` use `pattern.fullmatch(path)`), so
 * we anchor each pattern as `^(?:<pat>)$`. Patterns match the posix wiki-relative
 * path in ORIGINAL case (huginn's regexes are case-sensitive — `^index\.md$`).
 * Membership counting stays per-page (a case-only-distinct `Foo.md` + `foo.md`
 * pair on a case-sensitive checkout both count) so the invariant holds:
 *   indexed + missing.length + excludedByRule.length === totalMd
 */

import { normalizeRelPath } from "./store.ts";
import type { StatsError } from "../summaries/stats.ts";

export interface IndexCoverage {
  /** Wiki `.md` page count (per file — case-only-distinct pages each count). */
  totalMd: number;
  /** `.md` pages present in the union of collection listings. */
  indexed: number;
  /** `.md` relPaths absent from every collection that SHOULD index them (sorted). */
  missing: string[];
  /** `.md` relPaths no collection would ever index by rule — informational (sorted). */
  excludedByRule: string[];
  /** Indexed `.md`/`.html` doc ids with no matching file (sorted, original casing). */
  ghosts: string[];
  /** `.html` explainers in the wiki — informational, never counted as missing. */
  htmlPages: number;
}

/** A collection's reader include/exclude regex strings (from huginn `/api/collections`). */
export interface CollectionPatterns {
  includePatterns: string[];
  excludePatterns: string[];
}

/**
 * Canonical comparison key for a wiki relPath / huginn doc id: posix-normalize +
 * lowercase (`normalizeRelPath`) then Unicode NFC (macOS NFD ↔ huginn NFC). The
 * lowercase-then-NFC order is equivalent to NFC-then-lowercase for the wiki's
 * Latin+diacritic character set.
 */
export function coverageKey(p: string): string {
  return normalizeRelPath(p).normalize("NFC");
}

/** Case-insensitive `.html` test on the ORIGINAL relPath (extension only). */
function isHtml(relPath: string): boolean {
  return relPath.toLowerCase().endsWith(".html");
}

/** A doc id is "indexable" (comparable to a wiki page file) only when it names a
 *  `.md`, `.mdx`, or `.html` file. Native `.mdx` pages are first-class markdown in
 *  the store's page walk, so their ids must count here too — without this, every
 *  huginn-indexed `.mdx` doc id is dropped from `indexedByKey` and the page shows
 *  `missing` forever. Collections may also index `.gitignore`/`.txt`/`.json`/`.sh`
 *  files (mimir) — the store's page walk is md/mdx/html only, so those ids would
 *  otherwise show as false ghosts. Ignore them everywhere. */
function isIndexableId(id: string): boolean {
  const l = id.toLowerCase();
  return l.endsWith(".md") || l.endsWith(".mdx") || l.endsWith(".html");
}

/** Compiled fullmatch rules for one collection. `usable` is false when the
 *  patterns are absent/empty (or every include failed to compile) — an empty
 *  include is never a legitimate huginn config (the reader defaults to `[".*"]`),
 *  so we treat it as "unknown" and never demote a page via it. */
interface CollectionRules {
  include: RegExp[];
  exclude: RegExp[];
  usable: boolean;
}

/** Mirror `re.fullmatch(pattern, s)` by anchoring the pattern as `^(?:pat)$`.
 *  Invalid regexes are skipped (null) rather than crashing the whole overview. */
function anchor(pattern: string): RegExp | null {
  try {
    return new RegExp(`^(?:${pattern})$`);
  } catch {
    return null;
  }
}

function compileRules(patterns: CollectionPatterns | undefined): CollectionRules {
  if (!patterns) return { include: [], exclude: [], usable: false };
  const include = (patterns.includePatterns ?? [])
    .map(anchor)
    .filter((r): r is RegExp => r !== null);
  const exclude = (patterns.excludePatterns ?? [])
    .map(anchor)
    .filter((r): r is RegExp => r !== null);
  // Usable only with a non-empty include set (empty ⇒ treat as unknown, above).
  return { include, exclude, usable: include.length > 0 };
}

/** Posix-separator wiki-relative path in ORIGINAL case, for pattern matching
 *  (huginn walks `os.path.relpath`, `/`-separated on the index host). */
function posixRel(relPath: string): string {
  return relPath.replace(/\\/g, "/");
}

/** True when THIS collection, per its rules, would never index the page:
 *  not matched by any include pattern, or matched by an exclude pattern. */
function wouldNeverIndex(posixPath: string, rules: CollectionRules): boolean {
  const included = rules.include.some((re) => re.test(posixPath));
  if (!included) return true;
  return rules.exclude.some((re) => re.test(posixPath));
}

/**
 * Compute coverage of a wiki's pages against its backing search collections.
 *
 * @param pageRelPaths           every page's relPath from `getWikiIndex` (md + html mixed)
 * @param indexedIdsByCollection one array of doc ids per wiki collection
 * @param patternsByCollection   optional per-collection reader patterns, ALIGNED to
 *                               `indexedIdsByCollection`. Absent (older huginn) ⇒ no
 *                               excludedByRule partition — meta pages stay in missing.
 */
export function computeIndexCoverage(
  pageRelPaths: string[],
  indexedIdsByCollection: string[][],
  patternsByCollection?: (CollectionPatterns | undefined)[],
): IndexCoverage {
  // Deduped union of every collection's INDEXABLE ids, normalized-key → first-seen
  // original. Non-md/html ids (mimir's .gitignore/.txt/.json) are ignored entirely.
  const indexedByKey = new Map<string, string>();
  for (const ids of indexedIdsByCollection) {
    for (const id of ids) {
      if (!isIndexableId(id)) continue;
      const key = coverageKey(id);
      if (!indexedByKey.has(key)) indexedByKey.set(key, id);
    }
  }

  // Per-collection rules, aligned to indexedIdsByCollection order. The
  // excludedByRule partition only runs when EVERY collection has usable rules —
  // otherwise a page we can't confidently rule out stays in `missing` (this is
  // also the graceful-degrade path for an older huginn that sends no patterns).
  const rules = indexedIdsByCollection.map((_, i) => compileRules(patternsByCollection?.[i]));
  const canPartition = rules.length > 0 && rules.every((r) => r.usable);

  // Page-level classification (per FILE, not per unique key) so case-only-distinct
  // pages both count and the invariant indexed+missing+excludedByRule === totalMd
  // holds. `allPageKeys` (md + html) drives ghost detection.
  const allPageKeys = new Set<string>();
  let htmlPages = 0;
  let indexed = 0;
  let totalMd = 0;
  const missing: string[] = [];
  const excludedByRule: string[] = [];
  for (const relPath of pageRelPaths) {
    const key = coverageKey(relPath);
    allPageKeys.add(key);
    if (isHtml(relPath)) {
      htmlPages += 1;
      continue;
    }
    totalMd += 1;
    if (indexedByKey.has(key)) {
      indexed += 1;
      continue;
    }
    // Not indexed. Demote to excludedByRule only when every collection has usable
    // rules AND every collection would never index this page by design.
    const pp = posixRel(relPath);
    if (canPartition && rules.every((r) => wouldNeverIndex(pp, r))) {
      excludedByRule.push(relPath);
    } else {
      missing.push(relPath);
    }
  }

  const ghosts: string[] = [];
  for (const [key, original] of indexedByKey) {
    if (!allPageKeys.has(key)) ghosts.push(original);
  }

  missing.sort();
  excludedByRule.sort();
  ghosts.sort();
  return { totalMd, indexed, missing, excludedByRule, ghosts, htmlPages };
}

/** One collection's fetched listing (ids + reader patterns) or the error that
 *  replaced it. `patterns` is absent for an older huginn (no `/api/collections`
 *  pattern fields) — the pure layer then skips the excludedByRule partition. */
export interface CoverageListing {
  ids: string[];
  error?: StatsError;
  patterns?: CollectionPatterns;
}

/** The `/api/wiki/index-coverage` payload. Coverage fields are `null` when any
 *  collection listing failed (a partial union would report false missing/ghosts). */
export interface IndexCoverageResponse {
  /** The wiki's backing search collections (labels the card). */
  collections: string[];
  totalMd: number | null;
  indexed: number | null;
  missing: string[] | null;
  excludedByRule: string[] | null;
  ghosts: string[] | null;
  /** Always populated (derived from the page index alone, independent of collections). */
  htmlPages: number;
  generatedAt: number;
  /** Uncommitted-file count in the wiki's git subtree (independent of collections;
   *  0 when the wiki is not a git repo or the tree is clean). Backs the Index
   *  card's "uncommitted changes: N" badge. Attached by the route (a git probe),
   *  not the pure builder — optional so builder-only callers/tests stay valid. */
  dirtyCount?: number;
  /** Oldest dirty file's mtime (epoch ms) — the staleness signal (red past 24h in
   *  the UI). `null` when clean or every dirty path is a deletion. */
  oldestDirtyMtimeMs?: number | null;
  /** Present only when ≥1 collection listing failed (partial data, non-fatal). */
  errors?: StatsError[];
}

/**
 * Assemble the coverage response, applying the degrade contract: if ANY
 * collection listing failed, SUPPRESS the coverage fields (`totalMd`/`indexed`/
 * `missing`/`excludedByRule`/`ghosts` → null) because a partial union would flag
 * really-indexed pages as missing. `htmlPages` stays (page-index fact, unaffected
 * by a failed collection). Pure so the suppress rule is unit-testable without a
 * real fetch.
 */
export function buildIndexCoverageResponse(
  collections: string[],
  pageRelPaths: string[],
  listings: CoverageListing[],
): IndexCoverageResponse {
  const errors = listings.map((l) => l.error).filter((e): e is StatsError => e !== undefined);
  const htmlPages = pageRelPaths.filter(isHtml).length;
  const generatedAt = Date.now();

  if (errors.length > 0) {
    return {
      collections,
      totalMd: null,
      indexed: null,
      missing: null,
      excludedByRule: null,
      ghosts: null,
      htmlPages,
      generatedAt,
      errors,
    };
  }

  const cov = computeIndexCoverage(
    pageRelPaths,
    listings.map((l) => l.ids),
    listings.map((l) => l.patterns),
  );
  return {
    collections,
    totalMd: cov.totalMd,
    indexed: cov.indexed,
    missing: cov.missing,
    excludedByRule: cov.excludedByRule,
    ghosts: cov.ghosts,
    htmlPages: cov.htmlPages,
    generatedAt,
  };
}
