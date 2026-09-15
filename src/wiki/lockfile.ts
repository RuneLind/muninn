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
 * cleanup on the happy path. The lock is taken on EVERY registered wiki root a
 * writer touches, so each of those roots has to ignore `.wiki-write.lock` and
 * `.wiki-stamp.*.tmp`; mimir's `.gitignore` names both, and the sweeper
 * (`src/watchers/wiki-committer.ts`) skips them by basename for the roots that
 * do not — see `listWikiSubtreeDirty`.
 *
 * ── The owner line, and what it buys ────────────────────────────────────────
 * On acquire muninn writes ONE JSON line into the file — `{pid, host, op, at}`.
 * It does two jobs. For an operator it answers "who is holding this and since
 * when" from a file that was otherwise zero bytes. For the code it is a FENCE:
 * `release()` unlinks only while the file still carries OUR line, so a lockfile
 * a third process took over as stale — and is now holding for its own write — is
 * never deleted by our late release. Acquire verifies the same way: the line is
 * read back after it is written, because a stale takeover elsewhere can unlink
 * and recreate the file in the window between our `O_EXCL` create and our write.
 *
 * ⚠️ The fence is ONE-SIDED today. `wiki-stamp` writes an empty lockfile and
 * unlinks unconditionally on release, so it can still drop a lock muninn holds
 * once muninn's has aged past its stale window. That is a follow-up in
 * claude-usage (write an owner line, verify before unlinking); until it lands,
 * this half stops muninn from being the one that does it.
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

import { openSync, closeSync, writeSync, statSync, unlinkSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getLog } from "../logging.ts";

const log = getLog("wiki", "lockfile");

/** The lockfile's name under the wiki root. Must match claude-usage's
 *  `LOCK_BASENAME` — the two processes name the same file or they share no lock. */
export const WIKI_LOCK_BASENAME = ".wiki-write.lock";

/** The stamper's temp file, written beside the page and renamed over it. Named
 *  here because everything that must ignore the lockfile must ignore this too. */
export const WIKI_STAMP_TMP_PREFIX = ".wiki-stamp.";

/**
 * Is this basename one of the two files the write interlock leaves in a wiki?
 *
 * Both are transient by construction and neither is content, so nothing that
 * enumerates a wiki's dirty files may treat them as work: the daily
 * `wiki-committer` sweeper would COMMIT a live lockfile (and then delete it on
 * the next sweep, twice a day, forever), the Index card's badge would report a
 * wiki as having uncommitted changes for the two seconds a write holds the lock,
 * and the repo-sync loop would stage it.
 *
 * mimir's `.gitignore` already names both, so on that root this is inert. The
 * jarvis wiki's repo (`huginn-jarvis`, which is its OWN git repo — the outer
 * `huginn` checkout's `huginn-` directory rule ignores a different repo and
 * answers a different question) ignores NEITHER, and muninn does not edit that
 * repo. Hence a basename skip here rather than a `.gitignore` line there — and
 * hence a skip that covers every root, since the lock is taken on every
 * registered wiki a writer touches, not on two named ones.
 */
export function isWikiWriteArtifact(basename: string): boolean {
  return (
    basename === WIKI_LOCK_BASENAME ||
    (basename.startsWith(WIKI_STAMP_TMP_PREFIX) && basename.endsWith(".tmp"))
  );
}

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

/** What muninn writes into the lockfile it holds. */
export interface WikiLockOwner {
  pid: number;
  host: string;
  /** What this holder is doing — `page-write`, `sync-rebase`, a log kind. */
  op: string;
  /** ISO timestamp of the acquire. */
  at: string;
}

export interface WikiLockHandle {
  /** Absolute path of the lockfile this handle holds. */
  path: string;
  /** The line this handle wrote — the fence `release` checks. */
  owner: WikiLockOwner;
  /** Remove the lockfile, but ONLY while it still carries our line. Idempotent —
   *  a stale sweep may have beaten us to it. */
  release: () => void;
}

export type WikiLockOutcome =
  /** Held by us, or never taken at all (see the errno degrade — the `lock: null`
   *  case, where the caller proceeds holding nothing). */
  | { ok: true; lock: WikiLockHandle | null }
  /** Someone else holds it and did not release inside the wait. */
  | { ok: false; reason: string };

export interface WikiLockOptions {
  /** How long to wait for a held lock. */
  waitMs?: number;
  /** What to record as this holder's `op`. */
  op?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function errnoOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "EUNKNOWN";
}

/** Roots already warned about for a given errno, so a fake-fs root under test
 *  (or a genuinely unwritable one in production) warns once, not per write. */
const warnedUnavailable = new Set<string>();

/** Test-only: forget which roots have already warned. */
export function __resetWikiLockWarnsForTest(): void {
  warnedUnavailable.clear();
}

/**
 * Take `<root>/.wiki-write.lock`, or report that another process holds it.
 *
 * Returns `{ ok: true, lock: null }` for the degrade path described in the
 * module header — the caller proceeds and holds nothing, so its `finally` must
 * tolerate a null handle.
 */
export async function takeWikiWriteLock(
  root: string,
  opts: WikiLockOptions = {},
): Promise<WikiLockOutcome> {
  const waitMs = opts.waitMs ?? WIKI_LOCK_WAIT_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const lockPath = path.join(root, WIKI_LOCK_BASENAME);
  const until = now() + waitMs;
  for (;;) {
    try {
      const owner: WikiLockOwner = {
        pid: process.pid,
        host: os.hostname(),
        op: opts.op ?? "wiki-write",
        at: new Date(now()).toISOString(),
      };
      const line = `${JSON.stringify(owner)}\n`;
      const fd = openSync(lockPath, "wx");
      try {
        writeSync(fd, line);
      } finally {
        closeSync(fd);
      }
      // Verify before proceeding. A third process running its own stale sweep
      // can unlink and recreate this file between our create and our write, and
      // then we would be "holding" a lock somebody else owns.
      if (readOwnerLine(lockPath) !== line) {
        if (now() >= until) return lockTimeout(lockPath, waitMs);
        await sleep(POLL_MS);
        continue;
      }
      return {
        ok: true,
        lock: {
          path: lockPath,
          owner,
          release: () => releaseIfOurs(lockPath, line),
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
        // SLEEPING first: without it this branch is a hot spin, and the file
        // vanishing is precisely the moment another process is doing fs work we
        // are competing for. (The stamper's copy of this loop has the same shape
        // and the same bug; it is bounded there by a 250 ms wait.)
        if (now() >= until) return lockTimeout(lockPath, waitMs);
        await sleep(POLL_MS);
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

/** The lockfile's current contents, or null when it is unreadable/gone. */
function readOwnerLine(lockPath: string): string | null {
  try {
    return readFileSync(lockPath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Unlink the lockfile only while it still carries `line`.
 *
 * The case this exists for: our hold ages past the stale window (a long write, a
 * suspended laptop), another process takes it over and starts its own write, and
 * our `finally` then runs. An unconditional `unlinkSync` there deletes a lock
 * that is actively held — and the next writer walks straight into the middle of
 * somebody's read-modify-write. A file that is empty or carries someone else's
 * line is left exactly where it is.
 */
function releaseIfOurs(lockPath: string, line: string): void {
  const held = readOwnerLine(lockPath);
  if (held === null) return; // already gone — a stale sweep beat us to it
  if (held !== line) {
    log.warn("Wiki write lock at {path} was taken over while we held it — not removing it", {
      path: lockPath,
    });
    return;
  }
  try {
    unlinkSync(lockPath);
  } catch {
    /* raced with a sweep between the read and the unlink */
  }
}

function lockTimeout(lockPath: string, waitMs: number): WikiLockOutcome {
  return {
    ok: false,
    reason: `another process holds the wiki write lock (${lockPath}) — gave up after ${waitMs} ms`,
  };
}
