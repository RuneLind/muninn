/**
 * Wiki index-coverage computation (read-only overview).
 *
 * Huginn search collections are rebuilt daily by launchd jobs, but nothing
 * compares a wiki's on-disk pages against what is actually indexed. A page added
 * outside the gardener, a failed nightly reindex, or a renamed file silently
 * drops out of Ask/search with no signal. This module measures that drift:
 *
 *  - **missing** — wiki `.md` pages absent from EVERY backing collection;
 *  - **ghosts**  — indexed doc ids with no matching file on disk (a rename /
 *    delete the reindex hasn't caught up with, or a stale document);
 *  - **htmlPages** — `.html` explainers in the wiki. Informational only: HTML
 *    explainers are effectively NOT indexed (huginn indexes `.md`), so they are
 *    NEVER counted as missing.
 *
 * LOAD-BEARING — key normalization. Huginn's doc `id` IS the wiki-relative path
 * (e.g. `life/concepts/Chronotypes.md`). We compare pages to ids on a normalized
 * key: `path.posix.normalize` + Unicode **NFC** + lowercase (the same lowercasing
 * rule as `normalizeRelPath`). macOS file APIs return NFD for composed characters
 * while huginn's ids may be NFC — without the NFC fold, Norwegian page names
 * (æ/ø/å, common in melosys-kode-wiki) would show as false missing+ghost pairs.
 * Membership is computed against the deduped UNION of a wiki's collections, so a
 * page present in two collections (the jarvis `wiki` superset of `wiki-life`) is
 * never double-counted. Output reports ORIGINAL (un-normalized) relPaths/ids,
 * matching on normalized keys internally.
 */

import path from "node:path";
import type { StatsError } from "../summaries/stats.ts";

export interface IndexCoverage {
  /** Wiki `.md` pages (deduped by normalized key). */
  totalMd: number;
  /** `.md` pages present in the union of collection listings. */
  indexed: number;
  /** `.md` relPaths absent from every collection (sorted, original casing). */
  missing: string[];
  /** Indexed doc ids with no matching file (sorted, original casing). */
  ghosts: string[];
  /** `.html` explainers in the wiki — informational, never counted as missing. */
  htmlPages: number;
}

/**
 * Canonical comparison key for a wiki relPath / huginn doc id: posix-normalize
 * (collapses `./` and `a/../b`), Unicode NFC (macOS NFD ↔ huginn NFC), lowercase.
 */
function coverageKey(p: string): string {
  return path.posix.normalize(p).normalize("NFC").toLowerCase();
}

/** Case-insensitive `.html` test on the ORIGINAL relPath (extension only). */
function isHtml(relPath: string): boolean {
  return relPath.toLowerCase().endsWith(".html");
}

/**
 * Compute coverage of a wiki's pages against its backing search collections.
 *
 * @param pageRelPaths          every page's relPath from `getWikiIndex` (md + html mixed)
 * @param indexedIdsByCollection one array of doc ids per wiki collection
 */
export function computeIndexCoverage(
  pageRelPaths: string[],
  indexedIdsByCollection: string[][],
): IndexCoverage {
  // Deduped union of every collection's ids, normalized-key → first-seen original.
  const indexedByKey = new Map<string, string>();
  for (const ids of indexedIdsByCollection) {
    for (const id of ids) {
      const key = coverageKey(id);
      if (!indexedByKey.has(key)) indexedByKey.set(key, id);
    }
  }

  // Wiki pages: md keyed for membership, plus a set of ALL page keys (md + html)
  // for ghost detection so a stray indexed `.html` whose file still exists is not
  // flagged as a ghost.
  const mdByKey = new Map<string, string>();
  const allPageKeys = new Set<string>();
  let htmlPages = 0;
  for (const relPath of pageRelPaths) {
    const key = coverageKey(relPath);
    allPageKeys.add(key);
    if (isHtml(relPath)) {
      htmlPages += 1;
    } else if (!mdByKey.has(key)) {
      mdByKey.set(key, relPath);
    }
  }

  const missing: string[] = [];
  let indexed = 0;
  for (const [key, original] of mdByKey) {
    if (indexedByKey.has(key)) indexed += 1;
    else missing.push(original);
  }

  const ghosts: string[] = [];
  for (const [key, original] of indexedByKey) {
    if (!allPageKeys.has(key)) ghosts.push(original);
  }

  missing.sort();
  ghosts.sort();
  return { totalMd: mdByKey.size, indexed, missing, ghosts, htmlPages };
}

/** One collection's fetched listing (ids) or the error that replaced it. */
export interface CoverageListing {
  ids: string[];
  error?: StatsError;
}

/** The `/api/wiki/index-coverage` payload. Coverage fields are `null` when any
 *  collection listing failed (a partial union would report false missing/ghosts). */
export interface IndexCoverageResponse {
  /** The wiki's backing search collections (labels the card). */
  collections: string[];
  totalMd: number | null;
  indexed: number | null;
  missing: string[] | null;
  ghosts: string[] | null;
  /** Always populated (derived from the page index alone, independent of collections). */
  htmlPages: number;
  generatedAt: number;
  /** Present only when ≥1 collection listing failed (partial data, non-fatal). */
  errors?: StatsError[];
}

/**
 * Assemble the coverage response, applying the degrade contract: if ANY
 * collection listing failed, SUPPRESS the coverage fields (`totalMd`/`indexed`/
 * `missing`/`ghosts` → null) because a partial union would flag really-indexed
 * pages as missing. `htmlPages` stays (page-index fact, unaffected by a failed
 * collection). Pure so the suppress rule is unit-testable without a real fetch.
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
      ghosts: null,
      htmlPages,
      generatedAt,
      errors,
    };
  }

  const cov = computeIndexCoverage(pageRelPaths, listings.map((l) => l.ids));
  return {
    collections,
    totalMd: cov.totalMd,
    indexed: cov.indexed,
    missing: cov.missing,
    ghosts: cov.ghosts,
    htmlPages: cov.htmlPages,
    generatedAt,
  };
}
