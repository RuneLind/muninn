/**
 * Generic per-key serialization queue for wiki writers.
 *
 * Lifted out of `commit.ts` (where it was module-private) because two INDEPENDENT
 * queues now need the primitive:
 *
 *  - the COMMIT queue, keyed per git toplevel (`commit.ts`) — a commit and its
 *    dispatched push chain onto the same key so they can't interleave;
 *  - the WIKI-WRITE queue, keyed per resolved WIKI ROOT (`page-write.ts`) — the
 *    read→CAS→transform→write→log.md critical section of every programmatic page
 *    write. `log.md` is wiki-GLOBAL, so the key is the wiki root, never the page
 *    path: a page-keyed queue would let two writers interleave and lose a log entry.
 *
 * They MUST NOT share one chain map. `commitWikiChange` enqueues its own work on
 * the commit chain, so if a wiki root happened to equal its git toplevel (the
 * common standalone-wiki-repo layout) and both queues shared a map, awaiting a
 * commit from INSIDE a write critical section would self-deadlock — the commit
 * would be queued behind the very section awaiting it. Each queue therefore owns
 * a fresh `Map` via {@link createQueue}, and the write path awaits its commit
 * AFTER releasing (the commit is a best-effort tail, not part of the section).
 *
 * Semantics (unchanged from the original): unlike the gardener mutex (which SKIPS
 * when busy), a queued call is never dropped — it waits for the previous one, and
 * a rejection in the predecessor does not poison the chain.
 *
 * SCOPE NOTE: this queue serializes every programmatic `log.md` writer against
 * every other — the APPEND + INTEGRATE writers (`page-write.ts`) and, since
 * 2026-07-30, the gardener/source-drafter/consolidation apply path
 * (`applyWikiProposal`, which previously kept a private per-wikiDir chain map and
 * so raced the other two). Still not a global lock on the wiki: `writeWikiPage`
 * deliberately leaves its cache refresh / reindex / commit tail outside the
 * section, and the gardener's own per-BOT try-lock (`runExclusive` in
 * `backlog.ts`) is a different thing — "one gardener run per bot", not one writer
 * per wiki.
 */

import { realpathSync } from "node:fs";

export interface KeyedQueue {
  /** Run `work` after every previously-enqueued call for `key` has settled. */
  run<T>(key: string, work: () => Promise<T>): Promise<T>;
  /** Test-only: drop all chains. */
  reset(): void;
}

/** Create an independent per-key queue (its own chain map). */
export function createQueue(): KeyedQueue {
  const chains = new Map<string, Promise<unknown>>();
  return {
    run<T>(key: string, work: () => Promise<T>): Promise<T> {
      const prev = chains.get(key) ?? Promise.resolve();
      const started = prev.then(
        () => work(),
        () => work(),
      );
      chains.set(
        key,
        started.then(
          () => undefined,
          () => undefined,
        ),
      );
      return started;
    },
    reset(): void {
      chains.clear();
    },
  };
}

/**
 * The shared WIKI-WRITE queue — one chain per resolved wiki root, covering the
 * read→CAS→transform→write→log.md critical section of `writeWikiPage`. Distinct
 * from the commit queue by construction (see the module doc).
 */
const wikiWriteQueue = createQueue();

/** Memoized {@link wikiWriteQueueKey} results — the derivation is a syscall and
 *  the same handful of wiki roots recur for the process's lifetime. */
const queueKeyCache = new Map<string, string>();

/**
 * The chain key for a wiki root: its REALPATH, falling back to the raw path when
 * that throws (a not-yet-created dir, a test fixture path, a permission error).
 * The fallback is the RAW string, deliberately un-normalized — so on a root that
 * doesn't exist, `/wiki` and `/wiki/` get separate chains. Every real caller passes
 * an existing absolute root (bot discovery / the wiki registry), where realpath
 * normalizes both, so this only shows up in tests against phantom paths.
 *
 * ONLY successful resolutions are cached: a fallback answer is a statement about
 * a path that does not exist YET (a wiki dir created after boot, a fixture dir
 * made between calls), and caching it would pin that wiki to its raw path for the
 * process's lifetime while a later caller resolving the same wiki through a
 * symlink got the realpath — two chains on one log.md, exactly what the key
 * exists to prevent.
 *
 * Realpathing matters because `commit.ts` already canonicalizes its own keys, and
 * because two registry entries can name the same wiki through different paths (a
 * symlinked vault, macOS `/tmp` → `/private/tmp`, a trailing-slash variant). Keyed
 * verbatim, those would get INDEPENDENT chains and interleave on one real log.md —
 * exactly the race the queue exists to close. Synchronous on purpose: an `await`
 * before `run()` would let two callers reorder their own enqueue.
 */
export function wikiWriteQueueKey(wikiRoot: string): string {
  const cached = queueKeyCache.get(wikiRoot);
  if (cached !== undefined) return cached;
  let key: string;
  try {
    key = realpathSync(wikiRoot);
  } catch {
    return wikiRoot; // NOT cached — a later-created dir must converge on its realpath
  }
  queueKeyCache.set(wikiRoot, key);
  return key;
}

/** Serialize a wiki-write critical section on its wiki ROOT (realpath-keyed). */
export function runWikiWriteExclusive<T>(wikiRoot: string, work: () => Promise<T>): Promise<T> {
  return wikiWriteQueue.run(wikiWriteQueueKey(wikiRoot), work);
}

/** Test-only: clear the wiki-write queue between cases. */
export function __resetWikiWriteQueueForTest(): void {
  wikiWriteQueue.reset();
  queueKeyCache.clear();
}
