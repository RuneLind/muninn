/**
 * The shared write tail for muninn's programmatic wiki-page writers — extracted
 * from `appendBlockToPage` when the fact-check **Integrate into article** path
 * needed the identical sequence with different strings.
 *
 * One page write is always the same seven steps, in this order:
 *   1. Path confinement (defense in depth, via the shared `isPathConfined`).
 *   2. Read the CURRENT raw bytes.
 *   3. Content staleness — sha256 of those raw bytes vs the `baseHash` captured
 *      at check time (NOT mtime). A mismatch is a `stale` outcome (⇒ 409).
 *   4. `transform` the body (splice a block / apply an edit list). Returning
 *      `null` short-circuits to `noop` — no write, no log, no reindex, no commit.
 *   5. Write the page → insert a `log.md` entry (best effort — a log hiccup must
 *      never undo the page write).
 *   6. Refresh the wiki-store TTL cache; fire-and-forget huginn reindex over the
 *      wiki registry entry's collections (none ⇒ skip, still a successful write).
 *   7. Commit page + log.md (best effort, never fatal, awaited so the caller can
 *      report `committed` truthfully).
 *
 * ── Why steps 2–5 run inside a per-WIKI queue ────────────────────────────────
 * The queue key is the resolved WIKI ROOT (realpathed — see `queue.ts`), never the
 * page path: `log.md` is wiki-GLOBAL, so a page-keyed queue would let two writers
 * on different pages interleave read→write on log.md and lose an entry. The
 * critical section must span read → CAS → transform → write → log.md, not just the
 * post-write steps — a queue entered AFTER the CAS compare cannot close the race it
 * exists for, and a "➕ Add to article" click in a second tab is the realistic
 * concurrent writer.
 *
 * The queue serializes these writers (append + integrate) against each other AND
 * against the gardener apply path (`applyWikiProposal`), which joined the same
 * chain on 2026-07-30 — it is the third read-modify-writer of the one wiki-global
 * log.md. Steps 6–7 still run after the section releases (see below).
 *
 * ── Why the commit is OUTSIDE that section ───────────────────────────────────
 * `commitWikiChange` enqueues its work on the per-git-toplevel COMMIT queue. On a
 * wiki whose root IS its git toplevel, awaiting the commit from inside a critical
 * section held on a shared chain map would self-deadlock. The two queues already
 * have separate maps (`queue.ts`), and the commit is a best-effort tail that the
 * plan's required critical section deliberately excludes — so it runs after the
 * section releases. Belt and suspenders, both.
 *
 * Filesystem / index / reindex / commit seams are injected, so the whole sequence
 * unit-tests with in-memory fakes.
 */

import path from "node:path";
import { isPathConfined } from "../gardener/draft.ts";
import { insertLogEntry } from "../gardener/apply.ts";
import { sha256, todayOslo } from "../gardener/util.ts";
import { runWikiWriteExclusive } from "./queue.ts";
import { isWikiReadonly, WIKI_READONLY_REASON } from "./readonly.ts";
import type { CommitWikiResult } from "./commit.ts";
import { getLog } from "../logging.ts";

const log = getLog("wiki", "page-write");

export type PageWriteOutcome =
  | { outcome: "written"; writtenPath: string; commit?: CommitWikiResult }
  /** `transform` declined to change anything — nothing was written or logged. */
  | { outcome: "noop" }
  | { outcome: "stale"; reason: string }
  /**
   * This instance is wiki-readonly (`MUNINN_WIKI_READONLY=1`). A REFUSAL, not a
   * failure: its own variant so the route maps it to 403 instead of the 500 a
   * generic `error` earns. Nothing was read, written or logged.
   */
  | { outcome: "forbidden"; reason: string }
  | { outcome: "error"; reason: string };

export interface PageWriteOptions {
  /** Absolute wiki root — the path-confinement anchor AND the queue key. */
  wikiDir: string;
  /** Wiki-relative path of the target page (from the resolved index entry). */
  relPath: string;
  /** sha256 of the page's raw on-disk content at check time. */
  baseHash: string;
  /**
   * Produce the new page content from the current content. Runs INSIDE the
   * critical section, after the CAS passes, so it may re-resolve offsets against
   * the freshly-read body. Return `null` to abort cleanly (a `noop` outcome).
   */
  transform: (current: string) => string | null;
  /** Huginn collections to reindex. Empty ⇒ reindex skipped; write + log still happen. */
  collections: string[];
  /** Log entry kind, rendered as `## [date] <logKind> | <logTitle>`. */
  logKind: string;
  /** Title for the log.md entry. */
  logTitle: string;
  /** The log entry's single bullet line (without the leading `- `). */
  logLine: string;
  /** Commit subject, e.g. `[fact-check] annotate: <relPath>`. */
  commitMessage: string;
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
   * the route. Returns the truthful `CommitWikiResult` where the caller wants to
   * report it; a `void`-returning stub stays assignable.
   */
  commit?: (paths: string[], message: string) => Promise<CommitWikiResult | void>;
  /**
   * Is this instance forbidden from writing wiki page content? Injectable so a
   * test drives the refusal without touching the process env; defaults to the
   * shared `isWikiReadonly` (`MUNINN_WIKI_READONLY`). Callers do NOT pass it —
   * the default is what makes the guard fail-closed for every call site,
   * including ones added later.
   */
  isReadonly?: () => boolean;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run one page write through the shared sequence above. Returns the outcome; the
 * caller maps it to an HTTP status (written→200, noop→200-with-0-applied,
 * stale→409, error→400/500). Never throws for a recoverable condition.
 */
export async function writeWikiPage(opts: PageWriteOptions): Promise<PageWriteOutcome> {
  const { wikiDir, relPath, baseHash } = opts;

  // 0. Readonly instance: refuse BEFORE the read, so nothing is even opened.
  //    A refusal, not an error — the route answers 403.
  if ((opts.isReadonly ?? isWikiReadonly)()) {
    log.warn("Wiki page write refused — instance is wiki-readonly: {path}", {
      kind: opts.logKind,
      path: relPath,
    });
    return { outcome: "forbidden", reason: WIKI_READONLY_REASON };
  }

  // 1. Path confinement — pure and cheap, so it runs BEFORE the queue.
  //    `existingRelPath: relPath` selects the exists-page confinement branch
  //    (relative, `..`-free, .md/.mdx, not a reserved infra basename, inside
  //    root); domain/kind are unused there.
  if (
    !isPathConfined({ targetPath: relPath, wikiDir, domain: "ai", kind: "concept", existingRelPath: relPath })
  ) {
    return { outcome: "error", reason: `path confinement failed for "${relPath}"` };
  }

  const absTarget = path.join(wikiDir, relPath);

  // 2–5. read → CAS → transform → write → log.md, serialized per WIKI ROOT.
  const sectionResult = await runWikiWriteExclusive(
    wikiDir,
    async (): Promise<PageWriteOutcome> => {
      const current = await opts.readFile(absTarget);
      if (current === null) return { outcome: "stale", reason: "target file no longer exists" };
      if (!baseHash || sha256(current) !== baseHash) {
        return { outcome: "stale", reason: "page changed since the fact check" };
      }

      let updated: string | null;
      try {
        updated = opts.transform(current);
      } catch (err) {
        return { outcome: "error", reason: `transform failed: ${errMsg(err)}` };
      }
      if (updated === null) return { outcome: "noop" };

      try {
        await opts.writeFile(absTarget, updated);
      } catch (err) {
        return { outcome: "error", reason: `write failed: ${errMsg(err)}` };
      }

      // log.md entry (reverse-chron). A log hiccup must not undo the page write.
      try {
        const logPath = path.join(wikiDir, "log.md");
        const existingLog = await opts.readFile(logPath);
        const entry = `## [${todayOslo(opts.now())}] ${opts.logKind} | ${opts.logTitle}\n- ${opts.logLine}`;
        await opts.writeFile(logPath, insertLogEntry(existingLog, entry));
      } catch (err) {
        log.warn("Wiki page write: log.md update failed for {path}: {error}", {
          kind: opts.logKind,
          path: relPath,
          error: errMsg(err),
        });
      }

      return { outcome: "written", writtenPath: relPath };
    },
  );

  if (sectionResult.outcome !== "written") return sectionResult;

  // 6. Refresh the read cache so /wiki sees the write.
  try {
    await opts.refreshIndex();
  } catch (err) {
    log.warn("Wiki page write: cache refresh failed: {error}", {
      kind: opts.logKind,
      error: errMsg(err),
    });
  }

  // Fire-and-forget huginn reindex over the wiki's registry collections.
  for (const collection of new Set(opts.collections)) {
    opts.reindex(collection).catch((err) => {
      log.warn("Wiki page write: reindex failed for {collection}: {error}", {
        kind: opts.logKind,
        collection,
        error: errMsg(err),
      });
    });
  }

  // 7. Commit the page + log.md — OUTSIDE the critical section (see module doc).
  //    Non-fatal: a commit failure never undoes the applied write.
  let commit: CommitWikiResult | undefined;
  if (opts.commit) {
    try {
      const res = await opts.commit([relPath, "log.md"], opts.commitMessage);
      if (res && typeof res === "object" && "committed" in res) commit = res;
    } catch (err) {
      log.warn("Wiki page write: commit failed for {path}: {error}", {
        kind: opts.logKind,
        path: relPath,
        error: errMsg(err),
      });
    }
  }

  return { outcome: "written", writtenPath: relPath, ...(commit ? { commit } : {}) };
}
