/**
 * The `/plans` board's second write: `plans/queue.yaml`, the hand-ranked column
 * order.
 *
 * `writeWikiPage` cannot carry this file — its path confinement admits `.md` and
 * `.mdx` only, correctly, since it exists to stop a page writer from reaching
 * infrastructure. So this is a small dedicated writer that repeats the same
 * guarantees rather than routing around them:
 *
 *   - the **readonly refusal** first, before anything is opened
 *     (`MUNINN_WIKI_READONLY`, injectable seam like page-write's);
 *   - the **per-wiki write queue** (`runWikiWriteExclusive`) on the mimir root —
 *     the same chain page writes and the sync loop's staging join, so a triage
 *     click cannot interleave with either;
 *   - a **sha256 compare-and-swap** spanning read → compare → write ONLY.
 *     Nothing that talks to git or the network is inside the section.
 *
 * There is no `log.md` entry, no reindex and no commit: an ordering is metadata,
 * and mimir is in the repo-sync loop in `wiki` mode — the sync loop is the
 * committer, behind its 5-minute quiet period. A drag session is a burst; 60
 * drops must not be 60 pushes.
 *
 * **The base hash has three states, and two of them are not hashes** — the
 * distinction `PlanQueue.hash` in `source.ts` makes, honored here because the
 * writer must treat them oppositely:
 *
 *   - `""` — the file does NOT exist. The bootstrap sentinel: accepted ONLY
 *     against an absent file, which is how the first-ever drag has a base to
 *     send, and which resolves two tabs racing to create it into one winner and
 *     one 409.
 *   - a real hash — the file exists and must still hash to it.
 *   - the reader's `null` — the file exists but could NOT be read. There is no
 *     base, so this writer REFUSES: writing against `""` would clobber an
 *     ordering that is still on disk.
 */

import path from "node:path";
import { unlink } from "node:fs/promises";
import { sha256 } from "../gardener/util.ts";
import { runWikiWriteExclusive } from "../wiki/queue.ts";
import { isWikiReadonly, WIKI_READONLY_REASON } from "../wiki/readonly.ts";
import { QUEUE_REL_PATH } from "./constants.ts";

/** What is at `plans/queue.yaml` right now. `absent` and `unreadable` are
 *  deliberately distinct — see the module doc. */
export type QueueReadState =
  | { state: "absent" }
  | { state: "present"; content: string }
  | { state: "unreadable"; reason: string };

export type QueueWriteOutcome =
  /** `hash` is of the bytes actually written — `""` when the file was deleted. */
  | { outcome: "written"; hash: string }
  | { outcome: "deleted"; hash: "" }
  /** Already exactly these bytes. Echoes the unchanged hash so the caller's next
   *  edit has a valid base. */
  | { outcome: "noop"; hash: string }
  | { outcome: "stale"; reason: string }
  | { outcome: "forbidden"; reason: string }
  | { outcome: "error"; reason: string };

export interface QueueWriteOptions {
  /** Absolute wiki root — the queue key, and the only path input. The target is
   *  a fixed constant under it, so nothing here takes a path from a request. */
  wikiDir: string;
  /** sha256 of the file at read time, or `""` meaning "it was absent". */
  baseHash: string;
  /** The canonical bytes from `serializeQueue`. `""` (a fully empty order) means
   *  DELETE — the file and its absence are the same state to the reader, and a
   *  stub of nothing but a trailing newline is not a shape the grammar has. */
  content: string;
  readQueue?: (absPath: string) => Promise<QueueReadState>;
  writeFile?: (absPath: string, content: string) => Promise<void>;
  deleteFile?: (absPath: string) => Promise<void>;
  /** Injectable so a test drives the refusal without touching the process env;
   *  defaults to the shared `isWikiReadonly` so a later caller is guarded too. */
  isReadonly?: () => boolean;
}

async function defaultReadQueue(absPath: string): Promise<QueueReadState> {
  try {
    return { state: "present", content: await Bun.file(absPath).text() };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return { state: "absent" };
    return { state: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Write (or delete) `plans/queue.yaml` under a compare-and-swap. Never throws
 *  for a recoverable condition; the caller maps the outcome to a status. */
export async function writePlanQueue(opts: QueueWriteOptions): Promise<QueueWriteOutcome> {
  if ((opts.isReadonly ?? isWikiReadonly)()) {
    return { outcome: "forbidden", reason: WIKI_READONLY_REASON };
  }
  const read = opts.readQueue ?? defaultReadQueue;
  const absPath = path.join(opts.wikiDir, QUEUE_REL_PATH);

  return runWikiWriteExclusive(opts.wikiDir, async (): Promise<QueueWriteOutcome> => {
    let current: QueueReadState;
    try {
      current = await read(absPath);
    } catch (err) {
      return { outcome: "error", reason: `reading ${QUEUE_REL_PATH} failed: ${errMsg(err)}` };
    }

    if (current.state === "unreadable") {
      return {
        outcome: "stale",
        reason: `${QUEUE_REL_PATH} exists but could not be read (${current.reason}) — refusing to overwrite an ordering that is still on disk`,
      };
    }
    if (current.state === "absent") {
      if (opts.baseHash !== "") {
        return { outcome: "stale", reason: `${QUEUE_REL_PATH} does not exist yet — the order was written or removed since it was read` };
      }
      if (opts.content === "") return { outcome: "noop", hash: "" };
    } else {
      if (opts.baseHash === "" || sha256(current.content) !== opts.baseHash) {
        return { outcome: "stale", reason: `${QUEUE_REL_PATH} changed since the board was loaded` };
      }
      if (current.content === opts.content) return { outcome: "noop", hash: opts.baseHash };
      if (opts.content === "") {
        try {
          await (opts.deleteFile ?? unlink)(absPath);
        } catch (err) {
          return { outcome: "error", reason: `deleting ${QUEUE_REL_PATH} failed: ${errMsg(err)}` };
        }
        return { outcome: "deleted", hash: "" };
      }
    }

    try {
      await (opts.writeFile ?? ((p: string, c: string) => Bun.write(p, c).then(() => undefined)))(
        absPath,
        opts.content,
      );
    } catch (err) {
      return { outcome: "error", reason: `writing ${QUEUE_REL_PATH} failed: ${errMsg(err)}` };
    }
    // Hashed from the string we wrote, never by re-reading: the section is about
    // to release, and a concurrent writer's bytes handed back as "your new base"
    // would arm the next edit to overwrite them.
    return { outcome: "written", hash: sha256(opts.content) };
  });
}
