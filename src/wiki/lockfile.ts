/**
 * The CROSS-PROCESS wiki write lock — `<root>/.wiki-write.lock`.
 *
 * `runWikiWriteExclusive` (queue.ts) serializes muninn's own writers against
 * each other. It cannot serialize muninn against ANOTHER PROCESS, and there is
 * one: claude-usage's `wiki-stamp` CLI, spawned from a Claude Code `PostToolUse`
 * hook and from the opencode plugin, appends a session id to a page's
 * `sessions:` frontmatter line while the model is mid-turn on that same page.
 * Two writers appending to one file lose one of the two writes, and the one lost
 * is whichever read first.
 *
 * So both sides take the SAME lockfile, with the same mechanism and the same
 * stale rule, and the numbers are deliberately asymmetric:
 *
 * | | wiki-stamp | muninn |
 * |---|---|---|
 * | wait | 250 ms | {@link WIKI_LOCK_WAIT_MS} (2 s) |
 * | stale takeover | 10 s | {@link WIKI_LOCK_STALE_MS} (10 s, the same) |
 * | on timeout | skip the stamp, record it | `locked` outcome, nothing written |
 *
 * muninn waits eight times longer because it is the LONG holder: its section
 * spans read → CAS → transform → write → log.md, while the stamp is a
 * read-modify-write of four frontmatter lines. The hook is synchronous on a tool
 * call, so it may not wait for us; a human clicking ➕ can.
 *
 * `openSync(path, "wx")` (`O_CREAT|O_EXCL`) is the whole of the mutual
 * exclusion — atomic on every filesystem either wiki lives on, no daemon, no
 * cleanup on the happy path. `.wiki-write.lock` is gitignored in both wikis.
 *
 * ── Only a HELD lock refuses a write ────────────────────────────────────────
 * EEXIST means someone holds it: wait, poll, take it over once it is stale.
 * ANY OTHER errno — ENOENT on a root that does not exist, EACCES on a 0555
 * checkout, EROFS on a read-only mount — means this process can never create the
 * file however long it waits, and we PROCEED with a warn rather than refusing.
 * That direction is deliberate: the lock is an advisory interlock with a
 * best-effort stamper (which records `lock-unavailable` and skips on the same
 * errnos), and the alternative would be muninn refusing every write on a root
 * whose lockfile it cannot create — including the in-memory roots the page
 * writer's own seams are tested against, where the write itself is a fake and
 * succeeds. A root we genuinely cannot write to fails at the write, which is
 * where that failure belongs.
 */

import { openSync, closeSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { getLog } from "../logging.ts";

const log = getLog("wiki", "lockfile");

/** The lockfile's name under the wiki root. Must match claude-usage's
 *  `LOCK_BASENAME` — the two processes name the same file or they share no lock. */
export const WIKI_LOCK_BASENAME = ".wiki-write.lock";

/** How long muninn waits for a held lock before giving up on the write. */
export const WIKI_LOCK_WAIT_MS = 2_000;

/**
 * A lockfile older than this is abandoned and taken over. The SAME 10 s
 * `wiki-stamp` uses: a shorter value here would let muninn seize a lock the
 * stamper still holds, and a longer one would leave muninn wedged behind an
 * interrupted stamp for longer than the stamper would wait for itself.
 */
export const WIKI_LOCK_STALE_MS = 10_000;

/** Poll interval while waiting for a held lock. */
const POLL_MS = 10;

export interface WikiLockHandle {
  /** Absolute path of the lockfile this handle holds. */
  path: string;
  /** Remove the lockfile. Idempotent — a stale sweep may have beaten us to it. */
  release: () => void;
}

export type WikiLockOutcome =
  /** Held by us, or never taken at all (see `degraded` — the errno case). */
  | { ok: true; lock: WikiLockHandle | null }
  /** Someone else holds it and did not release inside the wait. */
  | { ok: false; reason: string };

function errnoOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "EUNKNOWN";
}

/** Roots already warned about for a given errno, so a fake-fs root under test
 *  (or a genuinely unwritable one in production) warns once, not per write. */
const warnedUnavailable = new Set<string>();

/**
 * Take `<root>/.wiki-write.lock`, or report that another process holds it.
 *
 * Returns `{ ok: true, lock: null }` for the degrade path described in the
 * module header — the caller proceeds and holds nothing, so its `finally` must
 * tolerate a null handle.
 */
export async function takeWikiWriteLock(
  root: string,
  waitMs: number = WIKI_LOCK_WAIT_MS,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Promise<WikiLockOutcome> {
  const lockPath = path.join(root, WIKI_LOCK_BASENAME);
  const until = now() + waitMs;
  for (;;) {
    try {
      closeSync(openSync(lockPath, "wx"));
      return {
        ok: true,
        lock: {
          path: lockPath,
          release: () => {
            try {
              unlinkSync(lockPath);
            } catch {
              /* already gone — a stale sweep beat us to it */
            }
          },
        },
      };
    } catch (err) {
      const code = errnoOf(err);
      if (code !== "EEXIST") {
        const key = `${lockPath}\0${code}`;
        if (!warnedUnavailable.has(key)) {
          if (warnedUnavailable.size > 100) warnedUnavailable.clear();
          warnedUnavailable.add(key);
          log.warn("Wiki write lock unavailable ({code}) at {path} — writing unlocked", {
            code,
            path: lockPath,
          });
        }
        return { ok: true, lock: null };
      }
      // Held. Take it over if it is old enough to be abandoned.
      let stale = false;
      try {
        stale = now() - statSync(lockPath).mtimeMs > WIKI_LOCK_STALE_MS;
      } catch {
        // Vanished between the open and the stat — retry, deadline permitting.
        if (now() >= until) return lockTimeout(lockPath, waitMs);
        continue;
      }
      if (stale) {
        try {
          unlinkSync(lockPath);
          log.warn("Wiki write lock at {path} was stale (> {staleMs} ms) — taken over", {
            path: lockPath,
            staleMs: WIKI_LOCK_STALE_MS,
          });
        } catch (unlinkErr) {
          // ENOENT means the holder released it first, which is the outcome we
          // wanted; anything else means we cannot clear it, so stop waiting.
          if (errnoOf(unlinkErr) !== "ENOENT") return lockTimeout(lockPath, waitMs);
        }
        if (now() >= until) return lockTimeout(lockPath, waitMs);
        continue;
      }
      if (now() >= until) return lockTimeout(lockPath, waitMs);
      await sleep(POLL_MS);
    }
  }
}

function lockTimeout(lockPath: string, waitMs: number): WikiLockOutcome {
  return {
    ok: false,
    reason: `another process holds the wiki write lock (${lockPath}) — gave up after ${waitMs} ms`,
  };
}
