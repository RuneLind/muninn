/**
 * Append (or replace) a sentinel-wrapped block on an EXISTING wiki markdown page —
 * the write path behind the fact-check reader's "➕ Add to article" action.
 *
 * Deliberately NOT the gardener `applyWikiProposal` path: that runs
 * `containDraftBodyLinks` + alias-strip over the WHOLE page and could rewrite
 * existing content. This helper only splices one block and never touches the rest
 * of the body. Steps, in order:
 *   1. Path confinement (defense in depth, via the shared `isPathConfined`).
 *   2. Content staleness — sha256 the current RAW on-disk bytes and compare to the
 *      `baseHash` captured at check time (same raw-bytes convention as the
 *      factcheck SSE route). A mismatch is a `stale` outcome (⇒ 409), NOT mtime.
 *   3. Splice the sentinel block: replace an existing
 *      `<!-- factcheck:start -->…<!-- factcheck:end -->` in place, else append
 *      before a trailing `## Sources` section if present, otherwise at end.
 *   4. Write → `insertLogEntry` into log.md → refresh the wiki index cache →
 *      fire-and-forget huginn reindex over the wiki's registry `collections`
 *      (NOT `reindexCollectionFor`, which is hardcoded to jarvis's wiki/wiki-life).
 *      No collections ⇒ skip reindex, still write + log.
 *
 * Filesystem/index/reindex seams are injected so the splice + staleness logic
 * unit-tests with in-memory fakes.
 */

import path from "node:path";
import { FACTCHECK_SENTINEL_START, FACTCHECK_SENTINEL_END } from "./factcheck-context.ts";
import { isPathConfined } from "../gardener/draft.ts";
import { insertLogEntry } from "../gardener/apply.ts";
import { sha256, todayOslo } from "../gardener/util.ts";
import { getLog } from "../logging.ts";

const log = getLog("wiki", "append-block");

export type AppendOutcome =
  | { outcome: "written"; writtenPath: string }
  | { outcome: "stale"; reason: string }
  | { outcome: "error"; reason: string };

export interface AppendBlockOptions {
  /** Absolute wiki root — the path-confinement anchor. */
  wikiDir: string;
  /** Wiki-relative path of the target page (from the resolved index entry). */
  relPath: string;
  /** The full sentinel-wrapped block to splice in (see `buildFactcheckBlock`). */
  block: string;
  /** sha256 of the page's raw on-disk content at check time. */
  baseHash: string;
  /** Huginn collections to reindex (the wiki registry entry's `collections`).
   *  Empty ⇒ reindex is skipped; the write + log still happen. */
  collections: string[];
  /** Title for the log.md entry. */
  logTitle: string;
  now: () => number;
  /** Read a file's text, or null when it doesn't exist / is unreadable. */
  readFile: (absPath: string) => Promise<string | null>;
  writeFile: (absPath: string, content: string) => Promise<void>;
  /** Refresh the wiki-store TTL cache for this root. */
  refreshIndex: () => Promise<void>;
  /** Best-effort huginn reindex for a collection; must never throw. */
  reindex: (collection: string) => Promise<void>;
  /**
   * Commit the just-written page + log.md into their git repo. Optional — absent
   * in tests that don't exercise the commit seam. Wired to `commitWikiChange` at
   * the route; never throws and (per the helper) awaits only the local commit —
   * the push is dispatched async, so the HTTP response isn't blocked on the network.
   */
  commit?: (paths: string[], message: string) => Promise<void>;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Ensure exactly one trailing newline. */
function withTrailingNewline(text: string): string {
  return `${text.replace(/\n+$/, "")}\n`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Splice a sentinel-wrapped `block` into `content`:
 *   - if a `<!-- factcheck:start -->…<!-- factcheck:end -->` block already exists,
 *     REPLACE it in place (a function replacer, so `$`-sequences in the block are
 *     literal);
 *   - else insert before a trailing `## Sources` heading if present;
 *   - else append at end of file.
 * Pure — no trailing-newline normalization (the caller does that).
 */
export function spliceSentinelBlock(content: string, block: string): string {
  const re = new RegExp(
    escapeRegExp(FACTCHECK_SENTINEL_START) + "[\\s\\S]*?" + escapeRegExp(FACTCHECK_SENTINEL_END),
  );
  if (re.test(content)) {
    return content.replace(re, () => block);
  }
  const lines = content.split("\n");
  const sourcesIdx = lines.findIndex((l) => /^##\s+Sources\b/i.test(l));
  if (sourcesIdx !== -1) {
    const before = lines.slice(0, sourcesIdx).join("\n").replace(/\n+$/, "");
    const after = lines.slice(sourcesIdx).join("\n");
    return `${before}\n\n${block}\n\n${after}`;
  }
  const trimmed = content.replace(/\n+$/, "");
  return `${trimmed}\n\n${block}`;
}

/**
 * Append/replace one sentinel-wrapped block on an existing wiki markdown page.
 * Returns the outcome; the caller maps it to an HTTP status (written→200,
 * stale→409, error→400/500). Never throws for a recoverable condition.
 */
export async function appendBlockToPage(opts: AppendBlockOptions): Promise<AppendOutcome> {
  const { wikiDir, relPath, block, baseHash } = opts;

  // 1. Path confinement (defense in depth). `existingRelPath: relPath` runs the
  //    exists-page confinement branch (relative, `..`-free, .md/.mdx, not a
  //    reserved infra basename, inside root) — domain/kind are unused here.
  if (
    !isPathConfined({ targetPath: relPath, wikiDir, domain: "ai", kind: "concept", existingRelPath: relPath })
  ) {
    return { outcome: "error", reason: `path confinement failed for "${relPath}"` };
  }

  const absTarget = path.join(wikiDir, relPath);
  const current = await opts.readFile(absTarget);
  if (current === null) {
    return { outcome: "stale", reason: "target file no longer exists" };
  }

  // 2. Staleness — raw-bytes hash must match the check-time hash. After an append
  //    the raw content changes, so any older turn's baseHash correctly goes stale.
  if (!baseHash || sha256(current) !== baseHash) {
    return { outcome: "stale", reason: "page changed since the fact check" };
  }

  // 3. Splice + write.
  const updated = withTrailingNewline(spliceSentinelBlock(current, block));
  try {
    await opts.writeFile(absTarget, updated);
  } catch (err) {
    return { outcome: "error", reason: `write failed: ${errMsg(err)}` };
  }

  // 4. log.md entry (reverse-chron). A log hiccup must not undo the page write.
  try {
    const logPath = path.join(wikiDir, "log.md");
    const existingLog = await opts.readFile(logPath);
    const entry = `## [${todayOslo(opts.now())}] factcheck | ${opts.logTitle}\n- fact-check block added via the wiki reader`;
    await opts.writeFile(logPath, insertLogEntry(existingLog, entry));
  } catch (err) {
    log.warn("Fact-check append: log.md update failed for {path}: {error}", {
      path: relPath,
      error: errMsg(err),
    });
  }

  // 5. Refresh the read cache so /wiki sees the write.
  try {
    await opts.refreshIndex();
  } catch (err) {
    log.warn("Fact-check append: cache refresh failed: {error}", { error: errMsg(err) });
  }

  // 6. Fire-and-forget huginn reindex over the wiki's registry collections. No
  //    collections ⇒ nothing to reindex (still a successful write + log).
  for (const collection of new Set(opts.collections)) {
    opts.reindex(collection).catch((err) => {
      log.warn("Fact-check append: reindex failed for {collection}: {error}", {
        collection,
        error: errMsg(err),
      });
    });
  }

  // 7. Commit the page + log.md into the wiki repo (last step; the helper awaits
  //    only the local commit, dispatching the push async, so the HTTP response is
  //    never blocked on the network). Non-fatal — a commit failure never undoes
  //    the applied write. No-op when no commit seam is wired (unit tests).
  if (opts.commit) {
    try {
      await opts.commit([relPath, "log.md"], `[fact-check] annotate: ${relPath}`);
    } catch (err) {
      log.warn("Fact-check append: commit failed for {path}: {error}", {
        path: relPath,
        error: errMsg(err),
      });
    }
  }

  return { outcome: "written", writtenPath: relPath };
}
