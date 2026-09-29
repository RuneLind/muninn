/**
 * Fix round 2 on the bucket mirror (#616): filesystem-truth aliasing (V1), lock
 * ownership on every exit (V2), a lost lock race is not terminal (V3), manifest
 * ↔ disk reconciliation (V4), the owed refresh on the guard path (V5), the
 * branches and checkpoints fix round 1 left unpinned (V7), the NUL prune key
 * (V8), skipped objects losing their old copy (R1) and the pinned bucket owner
 * (R2).
 *
 * Several cases depend on how the filesystem folds names. They branch on a
 * probe rather than on the platform, so running the file with TMPDIR on a
 * case-sensitive volume exercises the Linux half on a Mac.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { configure, reset, type LogRecord } from "@logtape/logtape";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GCS_DEFAULT_BASE, resolveWikiBucketMirrorConfig } from "../config.ts";
import { __setReadonlyWikiRootsForTest } from "./readonly.ts";
import {
  BucketMirror,
  MAX_OBJECT_BYTES,
  MIRROR_LOCK,
  MIRROR_MARKER,
  startWikiBucketMirrors,
  type TokenSource,
} from "./bucket-mirror.ts";

interface FakeObject { generation: number; body: string | Uint8Array; size?: number }

const objects = new Map<string, FakeObject>();
const hits = { list: 0, bucket: 0, media: 0 };
let projectNumber = "123";
let listOverride: (() => Response) | null = null;
let streamedBytes = 0;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/storage/v1/b/felles") {
        hits.bucket++;
        return Response.json({ projectNumber });
      }
      const m = /^\/storage\/v1\/b\/felles\/o(?:\/(.+))?$/.exec(url.pathname);
      if (!m) return new Response("no bucket", { status: 404 });
      if (!m[1]) {
        hits.list++;
        if (listOverride) return listOverride();
        const items = [...objects].map(([name, o]) => ({
          name,
          generation: String(o.generation),
          size: String(o.size ?? (typeof o.body === "string" ? Buffer.byteLength(o.body) : o.body.byteLength)),
        }));
        return Response.json({ items });
      }
      hits.media++;
      const o = objects.get(decodeURIComponent(m[1]));
      if (!o || url.searchParams.get("generation") !== String(o.generation)) return new Response("gone", { status: 404 });
      return new Response(typeof o.body === "string" ? o.body : new Blob([o.body as Uint8Array<ArrayBuffer>]));
    },
  });
});
afterAll(() => server.stop(true));

let base: string;
let root: string;
const live: BucketMirror[] = [];
const noTokens: TokenSource = { acquire: async () => null, invalidate: () => {} };
/** Case folding (`a.md` = `A.md`), and APFS's FULL folding (`ass.md` = `aß.md`). */
let foldsCase = false;
let foldsFull = false;

beforeAll(async () => {
  const probe = await mkdtemp(path.join(tmpdir(), "bm-probe-"));
  writeFileSync(path.join(probe, "Aa"), "");
  writeFileSync(path.join(probe, "ass"), "");
  foldsCase = existsSync(path.join(probe, "aa"));
  foldsFull = existsSync(path.join(probe, "aß"));
  await rm(probe, { recursive: true, force: true });
});

beforeEach(async () => {
  objects.clear();
  hits.list = hits.bucket = hits.media = 0;
  projectNumber = "123";
  listOverride = null;
  streamedBytes = 0;
  base = await mkdtemp(path.join(tmpdir(), "bm-r2-"));
  root = path.join(base, "wikis", "felles");
  __setReadonlyWikiRootsForTest([root]);
});
afterEach(async () => {
  await Promise.all(live.splice(0).map((m) => m.stop()));
  __setReadonlyWikiRootsForTest();
  await rm(base, { recursive: true, force: true });
});

function mirror(extra: Record<string, unknown> = {}): BucketMirror {
  const m = new BucketMirror({ bucket: "felles", prefix: "", root }, {
    gcsBase: `http://127.0.0.1:${server.port}`,
    intervalMs: 60_000,
    tokens: noTokens,
    registeredWikiRoot: (r: string) => r,
    refreshIndex: async () => {},
    ...extra,
  } as ConstructorParameters<typeof BucketMirror>[1]);
  live.push(m);
  return m;
}

async function captureLogs(run: () => Promise<void>): Promise<LogRecord[]> {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (r: LogRecord) => records.push(r) },
    loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }],
    reset: true,
  });
  try {
    await run();
  } finally {
    await reset();
  }
  return records;
}

const skippedLogs = (records: LogRecord[]) => records.filter((r) => String(r.rawMessage).includes("skipped"));
const pages = async () => (await readdir(root)).filter((f) => !f.startsWith(".")).sort();
const lockPid = async () => (await readFile(path.join(root, MIRROR_LOCK), "utf8")).trim();

/** A process that stays alive, whose pid is not ours. */
async function withLiveHolder(run: (pid: number) => Promise<void>): Promise<void> {
  const holder = Bun.spawn(["sleep", "30"]);
  try {
    await run(holder.pid);
  } finally {
    holder.kill();
    await holder.exited;
  }
}

// ── V1: aliases are decided by the filesystem, not by a fold ─────

describe("V1 filesystem-truth aliasing", () => {
  for (const [from, to] of [["ass.md", "aß.md"], ["aσ.md", "aς.md"], ["afi.md", "aﬁ.md"], ["aв.md", "aᲀ.md"]] as const) {
    test(`a rename ${from} → ${to} keeps the live page`, async () => {
      objects.set(from, { generation: 1, body: "v1" });
      objects.set("other.md", { generation: 1, body: "o" });
      const m = mirror();
      await m.pollOnce();
      objects.delete(from);
      objects.set(to, { generation: 2, body: "v2" });
      await m.pollOnce();
      expect(await readFile(path.join(root, to), "utf8")).toBe("v2");
      await m.pollOnce();
      expect(await readFile(path.join(root, to), "utf8")).toBe("v2");
      // Where the two names are one file, one entry; elsewhere the old one is gone.
      expect((await pages()).filter((f) => f !== "other.md")).toHaveLength(1);
      if (!foldsFull) expect(await pages()).toEqual(["other.md", to].sort());
    });
  }

  test("two listed names that are one file: the smaller is kept, the other skipped with a warn", async () => {
    // U+03C2 (ς) sorts before U+03C3 (σ).
    objects.set("aσ.md", { generation: 1, body: "sigma" });
    objects.set("aς.md", { generation: 1, body: "final" });
    const records = await captureLogs(async () => {
      const r = await mirror().pollOnce();
      expect(r).toMatchObject(foldsFull ? { downloaded: 1, skipped: 1 } : { downloaded: 2, skipped: 0 });
    });
    expect(await readFile(path.join(root, "aς.md"), "utf8")).toBe("final");
    if (foldsFull) {
      const warns = skippedLogs(records);
      expect(warns).toHaveLength(1);
      expect(String(warns[0]!.properties.reason)).toContain("same file");
    }
  });

  test("a smaller alias arriving later takes the file, and removing it leaves the other name served", async () => {
    objects.set("aσ.md", { generation: 1, body: "sigma" });
    const m = mirror();
    await m.pollOnce();
    objects.set("aς.md", { generation: 1, body: "final" });
    await m.pollOnce();
    expect(await readFile(path.join(root, "aς.md"), "utf8")).toBe("final");
    expect(await m.pollOnce()).toMatchObject({ downloaded: 0 });
    objects.delete("aς.md");
    await m.pollOnce();
    expect(await readFile(path.join(root, "aσ.md"), "utf8")).toBe("sigma");
  });

  test("a case-only rename leaves exactly one page entry", async () => {
    objects.set("page.md", { generation: 1, body: "v1" });
    objects.set("other.md", { generation: 1, body: "o" });
    const m = mirror();
    await m.pollOnce();
    objects.delete("page.md");
    objects.set("Page.md", { generation: 2, body: "v2" });
    await m.pollOnce();
    expect(await readFile(path.join(root, "Page.md"), "utf8")).toBe("v2");
    expect((await pages()).filter((f) => f !== "other.md")).toHaveLength(1);
    if (!foldsCase) expect(await pages()).toEqual(["Page.md", "other.md"]);
  });
});

// ── V2: the lock is released on every exit ───────────────────────

describe("V2 lock ownership", () => {
  test.skipIf(process.getuid?.() === 0)("an adopt walk that throws after the lock is taken releases it", async () => {
    await mkdir(path.join(root, "sealed"), { recursive: true });
    await writeFile(path.join(root, MIRROR_MARKER), "source: gs://felles/\n");
    chmodSync(path.join(root, "sealed"), 0o000);
    try {
      const first = mirror();
      await expect(first.pollOnce()).rejects.toThrow(/refused/);
      expect(first.state).toBe("refused");
      expect(existsSync(path.join(root, MIRROR_LOCK))).toBe(false);
    } finally {
      chmodSync(path.join(root, "sealed"), 0o755);
    }
    objects.set("a.md", { generation: 1, body: "a" });
    expect(await mirror().pollOnce()).toMatchObject({ downloaded: 1 });
  });

  test("a refusal after the root was claimed removes our lock file", async () => {
    objects.set("a.md", { generation: 1, body: "a" });
    const m = mirror();
    await m.pollOnce();
    await unlink(path.join(root, MIRROR_MARKER));
    objects.set("b.md", { generation: 1, body: "b" });
    await expect(m.pollOnce()).rejects.toThrow();
    expect(existsSync(path.join(root, MIRROR_LOCK))).toBe(false);
  });
});

// ── V3 + V7: every #verifyRoot branch, in both phases ────────────

describe("V3/V7 root re-verification", () => {
  const setup = async () => {
    objects.set("a.md", { generation: 1, body: "a" });
    objects.set("b.md", { generation: 1, body: "b" });
    const m = mirror();
    await m.pollOnce();
    return m;
  };
  const writePhase = () => objects.set("c.md", { generation: 1, body: "c" });
  const deletePhase = () => objects.delete("b.md");

  for (const [phase, change] of [["write", writePhase], ["delete", deletePhase]] as const) {
    test(`${phase} phase: a lock taken by another live process defers, then the mirror resumes`, async () => {
      const m = await setup();
      await withLiveHolder(async (pid) => {
        await writeFile(path.join(root, MIRROR_LOCK), `${pid}\n`);
        change();
        await expect(m.pollOnce()).rejects.toThrow(/retrying/);
        expect(m.state).not.toBe("refused");
        expect(await pages()).toEqual(["a.md", "b.md"]);
        expect(await lockPid()).toBe(String(pid));
        // While it lives, the next poll waits too.
        await expect(m.pollOnce()).rejects.toThrow(/locked/);
      });
      await m.pollOnce();
      expect(await lockPid()).toBe(String(process.pid));
      expect(await pages()).toEqual(phase === "write" ? ["a.md", "b.md", "c.md"] : ["a.md"]);
    });

    test(`${phase} phase: a gone marker stops the mirror, nothing touched`, async () => {
      const m = await setup();
      await unlink(path.join(root, MIRROR_MARKER));
      change();
      await expect(m.pollOnce()).rejects.toThrow(/marker/);
      expect(m.state).toBe("refused");
      expect(await pages()).toEqual(["a.md", "b.md"]);
    });

    test(`${phase} phase: a root that now resolves elsewhere stops the mirror, nothing touched there`, async () => {
      const m = await setup();
      // Swap a PARENT for a symlink: the root itself is still a plain directory.
      const elsewhere = path.join(base, "elsewhere", "felles");
      await mkdir(path.dirname(elsewhere), { recursive: true });
      await cp(root, elsewhere, { recursive: true });
      await writeFile(path.join(elsewhere, MIRROR_LOCK), `${process.pid}\n`);
      await rename(path.join(base, "wikis"), path.join(base, "wikis-old"));
      await symlink(path.dirname(elsewhere), path.join(base, "wikis"));
      change();
      await expect(m.pollOnce()).rejects.toThrow(/resolves/);
      expect(m.state).toBe("refused");
      expect((await readdir(elsewhere)).filter((f) => !f.startsWith(".")).sort()).toEqual(["a.md", "b.md"]);
    });
  }
});

// ── V4: the manifest follows the disk ────────────────────────────

describe("V4 manifest reconciliation", () => {
  test("a file deleted behind the mirror's back comes back on the next poll", async () => {
    objects.set("a.md", { generation: 1, body: "a" });
    objects.set("b.md", { generation: 1, body: "b" });
    const m = mirror();
    await m.pollOnce();
    await unlink(path.join(root, "a.md"));
    expect(await m.pollOnce()).toMatchObject({ downloaded: 1 });
    expect(await readFile(path.join(root, "a.md"), "utf8")).toBe("a");
  });

  test("the documented purge: all objects removed, page files removed by hand, the next poll is clean", async () => {
    objects.set("a.md", { generation: 1, body: "a" });
    objects.set("b.md", { generation: 1, body: "b" });
    const m = mirror();
    await m.pollOnce();
    objects.clear();
    await unlink(path.join(root, "a.md"));
    await unlink(path.join(root, "b.md"));
    const r = await m.pollOnce();
    expect(r.massDeleteRefused).toBeUndefined();
    expect(m.manifest.size).toBe(0);
    objects.set("c.md", { generation: 1, body: "c" });
    await m.pollOnce();
    expect(await pages()).toEqual(["c.md"]);
  });
});

// ── V5: the guard path still pays an owed refresh ────────────────

describe("V5 owed refresh on the guard path", () => {
  test("a refused mass delete still retries the index rebuild", async () => {
    let calls = 0;
    objects.set("a.md", { generation: 1, body: "a" });
    const m = mirror({ refreshIndex: async () => { if (++calls === 1) throw new Error("boom"); } });
    expect(await m.pollOnce()).toMatchObject({ refreshError: "boom" });
    objects.clear();
    expect(await m.pollOnce()).toMatchObject({ massDeleteRefused: true, refreshed: true });
    expect(calls).toBe(2);
  });
});

// ── R1: a skipped object's old copy is removed ───────────────────

describe("R1 skipped objects", () => {
  test("a republish that is now oversized removes the old local copy", async () => {
    objects.set("a.md", { generation: 1, body: "secret" });
    objects.set("b.md", { generation: 1, body: "b" });
    const m = mirror();
    await m.pollOnce();
    objects.set("a.md", { generation: 2, body: "x", size: MAX_OBJECT_BYTES + 1 });
    expect(await m.pollOnce()).toMatchObject({ skipped: 1, deleted: 1 });
    expect(await pages()).toEqual(["b.md"]);
  });

  test("a collision loser's old copy is removed where it is a file of its own, kept where it is the winner's", async () => {
    objects.set("a.md", { generation: 1, body: "lower" });
    objects.set("z.md", { generation: 1, body: "z" });
    const m = mirror();
    await m.pollOnce();
    objects.set("A.md", { generation: 1, body: "upper" }); // "A" < "a": A.md wins
    await m.pollOnce();
    expect(await readFile(path.join(root, "A.md"), "utf8")).toBe("upper");
    if (!foldsCase) expect(await pages()).toEqual(["A.md", "z.md"]);
  });
});

// ── R2: the bucket's owner is pinned ─────────────────────────────

describe("R2 pinned project number", () => {
  test("a bucket answering another project's number is not listed; the right number mirrors", async () => {
    objects.set("a.md", { generation: 1, body: "a" });
    projectNumber = "999";
    const m = mirror({ projectNumber: "123" });
    const records = await captureLogs(async () => {
      await expect(m.pollOnce()).rejects.toThrow(/999.*123/);
    });
    expect(hits.list).toBe(0);
    expect(m.state).not.toBe("refused");
    expect(existsSync(path.join(root, "a.md"))).toBe(false);
    const warn = records.find((r) => r.level === "warning" && String(r.rawMessage).includes("pinned"));
    expect(warn?.properties).toMatchObject({ actual: "\"999\"", expected: "123" });
    projectNumber = "123";
    expect(await m.pollOnce()).toMatchObject({ downloaded: 1 });
  });

  test("asked on the first poll, then at most hourly, and again after a failure", async () => {
    objects.set("a.md", { generation: 1, body: "a" });
    let now = 1_000_000;
    const m = mirror({ projectNumber: "123", now: () => now });
    await m.pollOnce();
    await m.pollOnce();
    expect(hits.bucket).toBe(1);
    now += 60 * 60_000; // one hour, the recheck interval
    await m.pollOnce();
    expect(hits.bucket).toBe(2);
    listOverride = () => new Response("down", { status: 503 });
    await expect(m.pollOnce()).rejects.toThrow(/503/);
    listOverride = null;
    await m.pollOnce();
    expect(hits.bucket).toBe(3);
  });

  test("the variable parses leniently: digits pin, anything else warns and leaves ownership unpinned", () => {
    const saved = process.env.WIKI_BUCKET_MIRROR_PROJECT_NUMBER;
    try {
      process.env.WIKI_BUCKET_MIRROR_PROJECT_NUMBER = " 123456789012 ";
      expect(resolveWikiBucketMirrorConfig()).toMatchObject({ projectNumber: "123456789012", projectNumberRefused: null });
      process.env.WIKI_BUCKET_MIRROR_PROJECT_NUMBER = "my-project";
      expect(resolveWikiBucketMirrorConfig()).toMatchObject({
        projectNumber: null,
        projectNumberRefused: { value: "my-project", reason: expect.stringMatching(/not pinned/) },
      });
    } finally {
      if (saved === undefined) delete process.env.WIKI_BUCKET_MIRROR_PROJECT_NUMBER; else process.env.WIKI_BUCKET_MIRROR_PROJECT_NUMBER = saved;
    }
  });

  test("unset against the real GCS host warns once at start; pinned or a test host does not", async () => {
    const start = (gcsBase: string, projectNumber: string | null) => captureLogs(async () => {
      const s = startWikiBucketMirrors(
        { mirrors: [{ bucket: "felles", prefix: "", root }], refused: [], intervalRefused: null, intervalMs: 60_000, gcsBase, projectNumber, projectNumberRefused: null },
        { autostart: false },
      );
      await s.stop();
    });
    const notPinned = (rs: LogRecord[]) => rs.filter((r) => r.level === "warning" && String(r.rawMessage).includes("not pinned"));
    expect(notPinned(await start(GCS_DEFAULT_BASE, null))).toHaveLength(1);
    expect(notPinned(await start(GCS_DEFAULT_BASE, "123"))).toHaveLength(0);
    expect(notPinned(await start(`http://127.0.0.1:${server.port}`, null))).toHaveLength(0);
  });
});

// ── V7: the lock, the marker, the checkpoints, the caps, the logs ─

describe("V7 lock reclaim", () => {
  test("a lock carrying this process's own pid, with no mirror here holding it, is reclaimed", async () => {
    // A container restart: the emptyDir survives and pid 1 repeats.
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, MIRROR_MARKER), "source: gs://felles/\n");
    await writeFile(path.join(root, MIRROR_LOCK), `${process.pid}\n`);
    objects.set("a.md", { generation: 1, body: "a" });
    expect(await mirror().pollOnce()).toMatchObject({ downloaded: 1 });
  });

  test.skipIf(process.getuid?.() === 0)("a pid we may not signal (EPERM) counts as alive", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, MIRROR_MARKER), "source: gs://felles/\n");
    await writeFile(path.join(root, MIRROR_LOCK), "1\n");
    objects.set("a.md", { generation: 1, body: "a" });
    await expect(mirror().pollOnce()).rejects.toThrow(/locked/);
    expect(await lockPid()).toBe("1");
  });
});

describe("V7 marker", () => {
  test("a marker naming no source is adopted and rewritten with ours", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, MIRROR_MARKER), "an older marker\n");
    await writeFile(path.join(root, "kept.md"), "k");
    objects.set("kept.md", { generation: 1, body: "k2" });
    await mirror().pollOnce();
    expect(await readFile(path.join(root, MIRROR_MARKER), "utf8")).toMatch(/^source: gs:\/\/felles\/$/m);
  });
});

describe("V7 abort checkpoints", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test("an abort that lands during a download is rethrown, not counted as a failed object", async () => {
    objects.set("a.md", { generation: 1, body: "a" });
    let acquired = 0;
    let m: BucketMirror;
    const tokens: TokenSource = {
      acquire: async () => { if (++acquired === 2) void m.stop(); return null; },
      invalidate: () => {},
    };
    m = mirror({ tokens });
    const records = await captureLogs(async () => {
      await expect(m.pollOnce()).rejects.toThrow();
    });
    expect(skippedLogs(records)).toEqual([]);
  });

  test("an abort that lands as a download completes writes nothing", async () => {
    objects.set("a.md", { generation: 1, body: "a" });
    const m = mirror();
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (!String(input).includes("alt=media")) return realFetch(input, init);
      let sent = false;
      return new Response(new ReadableStream({
        pull(c) {
          if (!sent) { sent = true; c.enqueue(new TextEncoder().encode("a")); return; }
          void m.stop();
          c.close();
        },
      }));
    }) as typeof fetch;
    await expect(m.pollOnce()).rejects.toThrow();
    expect(existsSync(path.join(root, "a.md"))).toBe(false);
  });

  test("an abort before an owed refresh skips the refresh", async () => {
    let calls = 0;
    objects.set("a.md", { generation: 1, body: "a" });
    const m = mirror({ refreshIndex: async () => { if (++calls === 1) throw new Error("boom"); } });
    await m.pollOnce();
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const text = await (await realFetch(input, init)).text();
      let sent = false;
      return new Response(new ReadableStream({
        pull(c) {
          if (!sent) { sent = true; c.enqueue(new TextEncoder().encode(text)); return; }
          void m.stop();
          c.close();
        },
      }));
    }) as typeof fetch;
    await expect(m.pollOnce()).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe("V7 caps", () => {
  test("an error body is read only up to its cap", async () => {
    const FIFTY_MB = 50 * 1024 * 1024;
    listOverride = () => {
      const chunk = new Uint8Array(64 * 1024).fill(69);
      let cancelled = false;
      return new Response(new ReadableStream({
        async pull(c) {
          await Bun.sleep(1);
          if (cancelled) return;
          if (streamedBytes >= FIFTY_MB) { c.close(); return; }
          streamedBytes += chunk.byteLength;
          c.enqueue(chunk);
        },
        cancel() { cancelled = true; },
      }), { status: 500 });
    };
    await expect(mirror().pollOnce()).rejects.toThrow(/500/);
    expect(streamedBytes).toBeLessThan(20 * 1024 * 1024);
  }, 20_000);

  test("MAX_OBJECT_BYTES is 2 MB: a 2.5 MB object is skipped, a 1.5 MB one mirrored", async () => {
    objects.set("big.md", { generation: 1, body: new Uint8Array(2.5 * 1024 * 1024) });
    objects.set("fits.md", { generation: 1, body: new Uint8Array(1.5 * 1024 * 1024) });
    expect(await mirror().pollOnce()).toMatchObject({ downloaded: 1, skipped: 1 });
    expect(await pages()).toEqual(["fits.md"]);
  });
});

describe("V7/V8 object logs", () => {
  test("a folder placeholder is logged at debug, not warn", async () => {
    objects.set("dir/", { generation: 1, body: "" });
    const records = await captureLogs(async () => { await mirror().pollOnce(); });
    expect(skippedLogs(records).map((r) => r.level)).toEqual(["debug"]);
  });

  test("a skipped object that leaves the listing and returns is warned about again", async () => {
    objects.set("x.png", { generation: 1, body: "p" });
    objects.set("a.md", { generation: 1, body: "a" });
    const m = mirror();
    const records = await captureLogs(async () => {
      await m.pollOnce();
      await m.pollOnce();
      objects.delete("x.png");
      await m.pollOnce();
      objects.set("x.png", { generation: 1, body: "p" });
      await m.pollOnce();
    });
    expect(skippedLogs(records)).toHaveLength(2);
  });

  test("a name carrying a NUL is warned about once while it stays listed", async () => {
    objects.set("a\u0000b.md", { generation: 1, body: "n" });
    objects.set("a.md", { generation: 1, body: "a" });
    const m = mirror();
    const records = await captureLogs(async () => {
      await m.pollOnce();
      await m.pollOnce();
      await m.pollOnce();
    });
    expect(skippedLogs(records)).toHaveLength(1);
  });

  for (const ch of ["\u0085", "‮"]) {
    test(`U+${ch.charCodeAt(0).toString(16).padStart(4, "0")} in a name reaches the log escaped`, async () => {
      objects.set(`a${ch}b.md`, { generation: 1, body: "x" });
      const records = await captureLogs(async () => { await mirror().pollOnce(); });
      const name = String(skippedLogs(records)[0]!.properties.name);
      expect(name).not.toContain(ch);
      expect(name).toContain(`\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
    });
  }
});
