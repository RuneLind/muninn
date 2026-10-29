/**
 * The work map's write seam: `.work-map.json` at a wiki root.
 *
 * `writeWikiPage` admits `.md`/`.mdx` only, correctly, so this is a fixed-path
 * writer like `writePlanQueue` (`src/plans/write.ts`) that repeats the same
 * guarantees rather than routing around them:
 *
 *   - the **readonly refusals** first, before anything is opened — the
 *     instance flag (`MUNINN_WIKI_READONLY`) and the per-wiki root
 *     (`WIKI_READONLY_ROOTS`), injectable like page-write's;
 *   - the **per-wiki write queue**, then the cross-process `.wiki-write.lock`
 *     inside it, held for the read→write span only;
 *   - the **commit tail OUTSIDE** both, pushing where the repo has an upstream
 *     (`commitWikiChange`), since the write owner may run no sync loop — and
 *     skipped when the stop signal fired during the write: the landed file
 *     stays uncommitted until the next successful run commits it;
 *   - the write itself is a temp file in the root plus a rename, so a reader
 *     never sees a half-written map.
 *
 * **No `log.md` entry**: a nightly line would feed the next digest and What's
 * new. No reindex either: the map is not a page (the index skips dot files).
 */

import { rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { getLog } from "../../logging.ts";
import { commitWikiChange, type CommitWikiResult } from "../commit.ts";
import { takeWikiWriteLock, WORK_MAP_TMP_PREFIX } from "../lockfile.ts";
import { runWikiWriteExclusive } from "../queue.ts";
import { isReadonlyWikiRoot, isWikiReadonly, WIKI_READONLY_REASON, wikiReadonlyRootReason } from "../readonly.ts";

const log = getLog("wiki", "work-map");

/** The map's file name at a wiki root. A dot file, so the index never lists it. */
export const WORK_MAP_FILE = ".work-map.json";

export type WorkMapWriteOutcome =
  | { outcome: "written"; commit?: CommitWikiResult }
  /** The file already holds exactly these bytes. */
  | { outcome: "noop" }
  | { outcome: "forbidden"; reason: string }
  | { outcome: "locked"; reason: string }
  | { outcome: "error"; reason: string };

export interface WorkMapWriteOptions {
  wikiDir: string;
  content: string;
  commitMessage: string;
  /** Called inside the section, right before the write, and again before the
   *  commit tail; false skips what follows (the loop's stop hook fired). */
  proceed?: () => boolean;
  isReadonly?: () => boolean;
  isReadonlyRoot?: (root: string) => boolean;
  lockWaitMs?: number;
  readFile?: (absPath: string) => Promise<string | null>;
  writeFile?: (absPath: string, content: string) => Promise<void>;
  /** The commit tail; `null` commits nothing (tests). */
  commit?: ((wikiDir: string, paths: string[], message: string) => Promise<CommitWikiResult>) | null;
}

async function defaultRead(absPath: string): Promise<string | null> {
  try {
    return await Bun.file(absPath).text();
  } catch {
    return null;
  }
}

/** The temp file beside the map: a dot file, so the index never lists it, and a
 *  write artifact (`isWikiWriteArtifact`), so a crash's leftover is never committed. */
export function workMapTmpPath(wikiDir: string): string {
  return path.join(wikiDir, `${WORK_MAP_TMP_PREFIX}${process.pid}.${crypto.randomUUID()}.tmp`);
}

/** Write the temp file, then rename it over the map. */
async function atomicWrite(absPath: string, content: string): Promise<void> {
  const tmp = workMapTmpPath(path.dirname(absPath));
  try {
    await writeFile(tmp, content);
    await rename(tmp, absPath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Write the map. Never throws for a recoverable condition. */
export async function writeWorkMapFile(opts: WorkMapWriteOptions): Promise<WorkMapWriteOutcome> {
  if ((opts.isReadonly ?? isWikiReadonly)()) {
    log.warn("Work map write refused — instance is wiki-readonly: {root}", { root: opts.wikiDir });
    return { outcome: "forbidden", reason: WIKI_READONLY_REASON };
  }
  if ((opts.isReadonlyRoot ?? isReadonlyWikiRoot)(opts.wikiDir)) {
    log.warn("Work map write refused — wiki root is registered read-only: {root}", { root: opts.wikiDir });
    return { outcome: "forbidden", reason: wikiReadonlyRootReason(opts.wikiDir) };
  }
  const abs = path.join(opts.wikiDir, WORK_MAP_FILE);
  const section = await runWikiWriteExclusive(opts.wikiDir, async (): Promise<WorkMapWriteOutcome> => {
    const lock = await takeWikiWriteLock(opts.wikiDir, { waitMs: opts.lockWaitMs, op: "work-map" });
    if (!lock.ok) return { outcome: "locked", reason: lock.reason };
    try {
      if (opts.proceed && !opts.proceed()) return { outcome: "noop" };
      const current = await (opts.readFile ?? defaultRead)(abs);
      if (current === opts.content) return { outcome: "noop" };
      await (opts.writeFile ?? atomicWrite)(abs, opts.content);
      return { outcome: "written" };
    } catch (err) {
      return { outcome: "error", reason: `writing ${WORK_MAP_FILE} failed: ${errMsg(err)}` };
    } finally {
      lock.lock?.release();
    }
  });
  if (section.outcome !== "written") return section;
  const commit = opts.commit === undefined ? commitWikiChange : opts.commit;
  if (!commit) return section;
  if (opts.proceed && !opts.proceed()) {
    log.info("Work map for {root} written; commit skipped — the stop signal fired", { root: opts.wikiDir });
    return section;
  }
  try {
    return { outcome: "written", commit: await commit(opts.wikiDir, [WORK_MAP_FILE], opts.commitMessage) };
  } catch (err) {
    log.warn("Work map commit failed for {root}: {error}", { root: opts.wikiDir, error: errMsg(err) });
    return section;
  }
}
