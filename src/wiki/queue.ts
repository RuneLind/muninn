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
 */

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

/** Serialize a wiki-write critical section on its wiki ROOT. */
export function runWikiWriteExclusive<T>(wikiRoot: string, work: () => Promise<T>): Promise<T> {
  return wikiWriteQueue.run(wikiRoot, work);
}

/** Test-only: clear the wiki-write queue between cases. */
export function __resetWikiWriteQueueForTest(): void {
  wikiWriteQueue.reset();
}
