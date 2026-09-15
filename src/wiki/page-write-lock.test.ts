/**
 * The cross-process wiki write lock — `lockfile.ts` on its own, and
 * `writeWikiPage`'s use of it.
 *
 * Driven against a REAL temp directory, because the lock IS a file: an
 * in-memory filesystem would prove nothing about the mechanism claude-usage's
 * `wiki-stamp` shares (`openSync(path, "wx")` on `<root>/.wiki-write.lock`).
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, stat, utimes } from "node:fs/promises";
import { existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  takeWikiWriteLock,
  WIKI_LOCK_BASENAME,
  WIKI_LOCK_STALE_MS,
  WIKI_LOCK_WAIT_MS,
} from "./lockfile.ts";
import { writeWikiPage, type PageWriteOptions } from "./page-write.ts";
import { __resetWikiWriteQueueForTest } from "./queue.ts";
import { sha256 } from "../gardener/util.ts";

let root = "";
let lockPath = "";

beforeEach(async () => {
  __resetWikiWriteQueueForTest();
  root = await mkdtemp(path.join(tmpdir(), "wiki-lock-"));
  lockPath = path.join(root, WIKI_LOCK_BASENAME);
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

describe("takeWikiWriteLock", () => {
  test("takes the lock, names the shared file, and releases it", async () => {
    const res = await takeWikiWriteLock(root, { waitMs: 50 });
    expect(res.ok).toBe(true);
    expect(res.ok && res.lock?.path).toBe(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    if (res.ok) res.lock?.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test("a lock held by another process times out rather than proceeding unlocked", async () => {
    await writeFile(lockPath, "");
    const started = Date.now();
    const res = await takeWikiWriteLock(root, { waitMs: 60 });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain(lockPath);
    // It really waited — a bounded wait, not an instant refusal.
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(existsSync(lockPath)).toBe(true); // the other holder's file is untouched
  });

  /**
   * Fix round 2. `waitMs` becomes a deadline (`now() + waitMs`), and every
   * `now() >= until` comparison against a NaN deadline is FALSE — so a held
   * lock is polled forever, holding whatever the caller holds. It is not
   * hypothetical: round 1 changed this function's second argument from a
   * positional `waitMs` to an options object and one call site kept passing the
   * object positionally. The symptom was a test that hung, not an error naming
   * the argument.
   */
  test("a non-numeric wait is REFUSED, never polled — a NaN deadline cannot end", async () => {
    await writeFile(lockPath, ""); // held, so the wait is the thing under test
    let polls = 0;
    const sleep = async () => {
      polls += 1;
      if (polls > 20) throw new Error("SPUN: the NaN deadline polled without end");
    };
    await expect(
      takeWikiWriteLock(root, { waitMs: Number.NaN, sleep }),
    ).rejects.toThrow(/waitMs/);
    // Refused at the door: not one poll, so nothing can have spun.
    expect(polls).toBe(0);
    // The object-passed-positionally shape, which is what actually happened.
    await expect(
      takeWikiWriteLock(root, { waitMs: { waitMs: 60 } as unknown as number, sleep }),
    ).rejects.toThrow(/waitMs/);
    await expect(takeWikiWriteLock(root, { waitMs: -1, sleep })).rejects.toThrow(/waitMs/);
    expect(polls).toBe(0);
    expect(existsSync(lockPath)).toBe(true); // the other holder's file is untouched
  });

  test("a lock older than the stale window is taken over", async () => {
    await writeFile(lockPath, "");
    const old = new Date(Date.now() - WIKI_LOCK_STALE_MS - 5_000);
    await utimes(lockPath, old, old);
    const res = await takeWikiWriteLock(root, { waitMs: 50 });
    expect(res.ok).toBe(true);
    // Taken over means a FRESH file, not the abandoned one.
    expect((await stat(lockPath)).mtimeMs).toBeGreaterThan(old.getTime());
    if (res.ok) res.lock?.release();
  });

  test("a lock released mid-wait is acquired without waiting the full budget", async () => {
    await writeFile(lockPath, "");
    setTimeout(() => rm(lockPath, { force: true }), 20);
    const res = await takeWikiWriteLock(root, { waitMs: 2_000 });
    expect(res.ok).toBe(true);
    if (res.ok) res.lock?.release();
  });

  test("a root whose lockfile cannot be created is written UNLOCKED, never refused", async () => {
    // ENOENT: the errno class that means "waiting cannot help". The caller
    // proceeds holding nothing, so its `finally` must tolerate a null handle.
    const res = await takeWikiWriteLock(path.join(root, "does-not-exist"), { waitMs: 50 });
    expect(res.ok).toBe(true);
    expect(res.ok && res.lock).toBeNull();
  });

  test("the muninn wait is the LONGER of the two holders' budgets", () => {
    // wiki-stamp waits 250 ms (it is synchronous on a tool call); muninn's
    // section spans read→CAS→write→log.md, so it is the long holder and waits.
    expect(WIKI_LOCK_WAIT_MS).toBeGreaterThan(250);
  });
});

describe("writeWikiPage under the lock", () => {
  async function opts(over: Partial<PageWriteOptions> = {}): Promise<PageWriteOptions> {
    const rel = "page.md";
    const abs = path.join(root, rel);
    await writeFile(abs, "# Page\n\nBody.\n");
    return {
      wikiDir: root,
      relPath: rel,
      baseHash: sha256(await Bun.file(abs).text()),
      transform: (current) => `${current}appended\n`,
      collections: [],
      logKind: "factcheck",
      logTitle: "Page",
      logLine: "line",
      now: () => Date.UTC(2026, 6, 29, 12, 0, 0),
      readFile: async (p) => (existsSync(p) ? await Bun.file(p).text() : null),
      writeFile: async (p, content) => {
        await Bun.write(p, content);
      },
      refreshIndex: async () => {},
      reindex: async () => {},
      lockWaitMs: 60,
      ...over,
    } as PageWriteOptions;
  }

  test("a held lock answers `locked` and the page is NOT touched", async () => {
    const o = await opts();
    const before = await Bun.file(path.join(root, "page.md")).text();
    await writeFile(lockPath, ""); // another process is mid-write
    const res = await writeWikiPage(o);
    expect(res.outcome).toBe("locked");
    expect(res.outcome === "locked" && res.reason).toContain(WIKI_LOCK_BASENAME);
    expect(await Bun.file(path.join(root, "page.md")).text()).toBe(before);
    expect(existsSync(path.join(root, "log.md"))).toBe(false);
  });

  test("a stale lock is taken over and the write goes through", async () => {
    const o = await opts();
    await writeFile(lockPath, "");
    const old = new Date(Date.now() - WIKI_LOCK_STALE_MS - 5_000);
    await utimes(lockPath, old, old);
    const res = await writeWikiPage(o);
    expect(res.outcome).toBe("written");
    expect(await Bun.file(path.join(root, "page.md")).text()).toContain("appended");
  });

  test("the happy path leaves no lockfile behind", async () => {
    const res = await writeWikiPage(await opts());
    expect(res.outcome).toBe("written");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("the lock is released even when the transform throws", async () => {
    const res = await writeWikiPage(
      await opts({
        transform: () => {
          throw new Error("boom");
        },
      }),
    );
    expect(res.outcome).toBe("error");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("a refusal that precedes the section never creates the lockfile", async () => {
    const res = await writeWikiPage(await opts({ isReadonly: () => true }));
    expect(res.outcome).toBe("forbidden");
    expect(existsSync(lockPath)).toBe(false);
  });
});

// ── The owner line (fix round 1) ────────────────────────────────────────────

describe("the lockfile's owner line", () => {
  test("acquire writes one JSON line naming who holds it and since when", async () => {
    const res = await takeWikiWriteLock(root, { waitMs: 50, op: "page-write:factcheck" });
    expect(res.ok).toBe(true);
    try {
      // The file was zero bytes before this, so an operator finding a wedged
      // wiki had nothing to go on — not even which process to look for.
      const raw = await Bun.file(lockPath).text();
      expect(raw.endsWith("\n")).toBe(true);
      const owner = JSON.parse(raw.trim());
      expect(owner.pid).toBe(process.pid);
      expect(owner.op).toBe("page-write:factcheck");
      expect(typeof owner.host).toBe("string");
      expect(Number.isFinite(Date.parse(owner.at))).toBe(true);
    } finally {
      if (res.ok) res.lock?.release();
    }
  });

  test("release LEAVES a lockfile that another process has taken over", async () => {
    const res = await takeWikiWriteLock(root, { waitMs: 50 });
    expect(res.ok).toBe(true);
    // Our hold aged past the stale window, someone else took it over, and their
    // write is in flight. An unconditional unlink here deletes a LIVE lock.
    await writeFile(lockPath, '{"pid":999999,"host":"other","op":"wiki-stamp","at":"x"}\n');
    if (res.ok) res.lock?.release();
    expect(existsSync(lockPath)).toBe(true);
    expect(await Bun.file(lockPath).text()).toContain("999999");
  });

  test("release still removes OUR own lockfile, and is idempotent", async () => {
    const res = await takeWikiWriteLock(root, { waitMs: 50 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      res.lock?.release();
      expect(existsSync(lockPath)).toBe(false);
      res.lock?.release(); // a second release must not throw
    }
    expect(existsSync(lockPath)).toBe(false);
  });

  test("the empty lockfile wiki-stamp writes is left alone too", async () => {
    // The stamper's release is still unconditional (a follow-up in that repo),
    // but muninn must not be the process that drops a lock it does not hold.
    const res = await takeWikiWriteLock(root, { waitMs: 50 });
    expect(res.ok).toBe(true);
    await writeFile(lockPath, "");
    if (res.ok) res.lock?.release();
    expect(existsSync(lockPath)).toBe(true);
  });

  test("the vanished-lockfile retry SLEEPS rather than spinning", async () => {
    // The branch: the lockfile EXISTS at `openSync` and is gone by the
    // `statSync`. A dangling symlink is that state deterministically —
    // `O_CREAT|O_EXCL` refuses it with EEXIST (it will not follow the link),
    // while `statSync` follows it and throws ENOENT. Before the fix this branch
    // `continue`d with no sleep: a hot loop for the whole wait, at exactly the
    // moment another process is doing filesystem work we are competing for.
    symlinkSync(path.join(root, "nothing-here"), lockPath);
    let slept = 0;
    // A REAL clock, so the loop terminates either way: without the sleep it
    // spins the whole deadline out and reports zero sleeps, which is the
    // failure. A stubbed clock that only advances inside `sleep` would hang
    // instead of failing, and a hanging test proves nothing.
    const res = await takeWikiWriteLock(root, {
      waitMs: 50,
      sleep: async (ms) => {
        slept += 1;
        await Bun.sleep(ms);
      },
    });
    expect(res.ok).toBe(false);
    expect(slept).toBeGreaterThan(0);
  });
});

// ── The HOLD WINDOW ────────────────────────────────────────────────────────

describe("the lock is held across the write, not merely acquired", () => {
  test("the lockfile exists at the moment `writeFile` runs", async () => {
    // Moving `release()` to right after the acquire passes every other test in
    // this file: the outcome is the same, the file is gone at the end, and the
    // window nobody looks at is exactly the window the lock exists for.
    const seen: boolean[] = [];
    const rel = "page.md";
    const abs = path.join(root, rel);
    await writeFile(abs, "# Page\n\nBody.\n");
    const res = await writeWikiPage({
      wikiDir: root,
      relPath: rel,
      baseHash: sha256(await Bun.file(abs).text()),
      transform: (current) => `${current}appended\n`,
      collections: [],
      logKind: "factcheck",
      logTitle: "Page",
      logLine: "line",
      now: () => Date.UTC(2026, 6, 29, 12, 0, 0),
      readFile: async (p) => (existsSync(p) ? await Bun.file(p).text() : null),
      writeFile: async (p, content) => {
        seen.push(existsSync(lockPath));
        await Bun.write(p, content);
      },
      refreshIndex: async () => {},
      reindex: async () => {},
      lockWaitMs: 60,
    } as PageWriteOptions);
    expect(res.outcome).toBe("written");
    // Both writes — the page and `log.md` — happen inside the section.
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.every((held) => held)).toBe(true);
  });

  test("a write that THROWS still releases the lock", async () => {
    const rel = "page.md";
    const abs = path.join(root, rel);
    await writeFile(abs, "# Page\n\nBody.\n");
    const res = await writeWikiPage({
      wikiDir: root,
      relPath: rel,
      baseHash: sha256(await Bun.file(abs).text()),
      transform: (current) => `${current}appended\n`,
      collections: [],
      logKind: "factcheck",
      logTitle: "Page",
      logLine: "line",
      now: () => Date.UTC(2026, 6, 29, 12, 0, 0),
      readFile: async (p) => (existsSync(p) ? await Bun.file(p).text() : null),
      writeFile: async () => {
        throw new Error("EIO");
      },
      refreshIndex: async () => {},
      reindex: async () => {},
      lockWaitMs: 60,
    } as PageWriteOptions);
    expect(res.outcome).toBe("error");
    expect(existsSync(lockPath)).toBe(false);
  });
});
