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
import { existsSync } from "node:fs";
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
    const res = await takeWikiWriteLock(root, 50);
    expect(res.ok).toBe(true);
    expect(res.ok && res.lock?.path).toBe(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    if (res.ok) res.lock?.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test("a lock held by another process times out rather than proceeding unlocked", async () => {
    await writeFile(lockPath, "");
    const started = Date.now();
    const res = await takeWikiWriteLock(root, 60);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain(lockPath);
    // It really waited — a bounded wait, not an instant refusal.
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(existsSync(lockPath)).toBe(true); // the other holder's file is untouched
  });

  test("a lock older than the stale window is taken over", async () => {
    await writeFile(lockPath, "");
    const old = new Date(Date.now() - WIKI_LOCK_STALE_MS - 5_000);
    await utimes(lockPath, old, old);
    const res = await takeWikiWriteLock(root, 50);
    expect(res.ok).toBe(true);
    // Taken over means a FRESH file, not the abandoned one.
    expect((await stat(lockPath)).mtimeMs).toBeGreaterThan(old.getTime());
    if (res.ok) res.lock?.release();
  });

  test("a lock released mid-wait is acquired without waiting the full budget", async () => {
    await writeFile(lockPath, "");
    setTimeout(() => rm(lockPath, { force: true }), 20);
    const res = await takeWikiWriteLock(root, 2_000);
    expect(res.ok).toBe(true);
    if (res.ok) res.lock?.release();
  });

  test("a root whose lockfile cannot be created is written UNLOCKED, never refused", async () => {
    // ENOENT: the errno class that means "waiting cannot help". The caller
    // proceeds holding nothing, so its `finally` must tolerate a null handle.
    const res = await takeWikiWriteLock(path.join(root, "does-not-exist"), 50);
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
