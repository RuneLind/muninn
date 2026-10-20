/**
 * A bucket-mirrored wiki's health, read-only, for the listing payload
 * (architecture review 2026-10, finding 32). A leaf module: the routes import
 * it without pulling in the mirror's GCS and token code.
 *
 * The mirror reports here; nothing else writes. The status carries no object
 * name, path or error text: a count and a timestamp say the copy is stale
 * without saying what the bucket holds.
 */
import { sameWikiRoot } from "./readonly.ts";

/**
 * - `starting` — no poll has finished cleanly yet; the copy may be empty.
 * - `ok` — the last poll listed the bucket and wrote or kept every object.
 * - `degraded` — the last poll listed the bucket but did not bring every
 *   object in (a download failed, the index rebuild failed, or the listing
 *   would have deleted everything and was refused).
 * - `failing` — the listing or the ownership check fails; nothing is updated.
 * - `refused` — the mirror stopped for good; the copy is not updated again.
 */
export type BucketMirrorHealth = "starting" | "ok" | "degraded" | "failing" | "refused";

export interface BucketMirrorStatus {
  health: BucketMirrorHealth;
  /** Epoch ms of the last poll with nothing failed, or null. */
  lastSuccessAt: number | null;
  /** Polls in a row that threw (listing, ownership). */
  consecutiveFailures: number;
  /** Objects the last completed poll failed to download. */
  failedObjects: number;
}

export interface BucketMirrorStatusSource {
  /** The mirror's root as configured. */
  readonly root: string;
  status(): BucketMirrorStatus;
}

const sources = new Set<BucketMirrorStatusSource>();

/** Called by the mirror boot; the returned function unregisters. */
export function registerBucketMirrorStatus(source: BucketMirrorStatusSource): () => void {
  sources.add(source);
  return () => {
    sources.delete(source);
  };
}

/** The status of the mirror whose root is `root`, or undefined when no mirror
 *  feeds it (every wiki on a laptop). */
export function bucketMirrorStatusFor(root: string | undefined): BucketMirrorStatus | undefined {
  if (!root || sources.size === 0) return undefined;
  for (const s of sources) {
    if (sameWikiRoot(s.root, root)) return s.status();
  }
  return undefined;
}

/** The `/api/wiki/pages` field: present only while the mirror is not `ok`, so
 *  a healthy mirror's listing and every unmirrored wiki's are unchanged. */
export function bucketMirrorPayloadField(root: string | undefined): { mirror?: BucketMirrorStatus } {
  const status = bucketMirrorStatusFor(root);
  return status && status.health !== "ok" ? { mirror: status } : {};
}
