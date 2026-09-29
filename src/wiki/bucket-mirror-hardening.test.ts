/**
 * Fix round 1 on the bucket mirror (#616): one test per defect the review
 * reproduced — root identity (D1), the owed refresh (D2), bounded reads (D3),
 * overlapping roots and the marker's source (D4), the per-poll root re-check
 * (D5), log injection (D6), the lenient interval (D7), the backoff cap (D8),
 * stop() aborting the poll (D9), the segment limit (D10), case/NFC collisions
 * (D11), the mass-delete guard (C1), page dates (C2) and the root lock (C4).
 *
 * Read-only roots are set through `__setReadonlyWikiRootsForTest` and the
 * registry through `WIKI_EXTRA`, the paths production takes.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { configure, reset, type LogRecord } from "@logtape/logtape";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { parseWikiBucketMirrors, resolveWikiBucketMirrorConfig } from "../config.ts";
import { __setReadonlyWikiRootsForTest, isReadonlyWikiRoot } from "./readonly.ts";
import { __resetWikiRegistryForTest } from "./registry-memo.ts";
import { __resetWikiCacheForTest, getWikiIndex } from "./store.ts";
import * as mirrorModule from "./bucket-mirror.ts";
import { BucketMirror, MIRROR_MARKER, objectRelPath, startWikiBucketMirrors, type TokenSource } from "./bucket-mirror.ts";

interface FakeObject { generation: number; body: string | Uint8Array; updated?: string; size?: number }

const objects = new Map<string, FakeObject>();
const mediaRequests: { name: string; acceptEncoding: string | null }[] = [];
/** name → how to answer the media GET instead of the stored body. */
const special = new Map<string, "chunked-50mb" | "gzip-50mb" | "hang">();
let streamedBytes = 0;
let releaseHang: (() => void) | null = null;
let listOverride: (() => Response) | null = null;
let server: ReturnType<typeof Bun.serve>;
const FIFTY_MB = 50 * 1024 * 1024;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const m = /^\/storage\/v1\/b\/felles\/o(?:\/(.+))?$/.exec(url.pathname);
      if (!m) return new Response("no bucket", { status: 404 });
      if (!m[1]) {
        if (listOverride) return listOverride();
        const prefix = url.searchParams.get("prefix") ?? "";
        const items = [...objects].filter(([n]) => n.startsWith(prefix)).map(([name, o]) => ({
          name,
          generation: String(o.generation),
          size: String(o.size ?? (typeof o.body === "string" ? Buffer.byteLength(o.body) : o.body.byteLength)),
          ...(o.updated ? { updated: o.updated } : {}),
        }));
        return Response.json({ items });
      }
      const name = decodeURIComponent(m[1]);
      mediaRequests.push({ name, acceptEncoding: req.headers.get("accept-encoding") });
      const mode = special.get(name);
      if (mode === "hang") {
        return new Promise<Response>((resolve) => {
          releaseHang = () => resolve(new Response("late body"));
        });
      }
      if (mode === "chunked-50mb" || mode === "gzip-50mb") {
        const wantsGzip = (req.headers.get("accept-encoding") ?? "").includes("gzip");
        if (mode === "gzip-50mb" && wantsGzip) {
          // `gcloud storage cp -Z`: the stored bytes are gzip, served as such.
          return new Response(gzipSync(new Uint8Array(FIFTY_MB)), { headers: { "content-encoding": "gzip" } });
        }
        // Decompressive transcoding / a chunked body with no length.
        // Paced, so the count reflects what the client kept reading rather
        // than how fast the server can fill its own buffer.
        const chunk = new Uint8Array(64 * 1024);
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
        }));
      }
      const o = objects.get(name);
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
const SAVED_EXTRA = process.env.WIKI_EXTRA;

beforeEach(async () => {
  objects.clear();
  mediaRequests.length = 0;
  special.clear();
  streamedBytes = 0;
  releaseHang = null;
  listOverride = null;
  __resetWikiCacheForTest();
  base = await mkdtemp(path.join(tmpdir(), "bm-hard-"));
  root = path.join(base, "wikis", "felles");
  __setReadonlyWikiRootsForTest([root]);
});
afterEach(async () => {
  releaseHang?.();
  await Promise.all(live.splice(0).map((m) => m.stop()));
  __setReadonlyWikiRootsForTest();
  if (SAVED_EXTRA === undefined) delete process.env.WIKI_EXTRA; else process.env.WIKI_EXTRA = SAVED_EXTRA;
  __resetWikiRegistryForTest();
  __resetWikiCacheForTest();
  await rm(base, { recursive: true, force: true });
});

function mirror(opts: { root?: string; extra?: Record<string, unknown> } = {}): BucketMirror {
  const m = new BucketMirror({ bucket: "felles", prefix: "", root: opts.root ?? root }, {
    gcsBase: `http://127.0.0.1:${server.port}`,
    intervalMs: 60_000,
    tokens: noTokens,
    registeredWikiRoot: (r: string) => r,
    refreshIndex: async () => {},
    ...opts.extra,
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

// ── D1: root identity ────────────────────────────────────────────

describe("D1 root identity", () => {
  test("a changed poll refreshes the index under the REGISTRY's spelling of the root", async () => {
    const real = path.join(base, "real");
    await mkdir(real);
    await symlink(real, path.join(base, "alias"));
    const mirrorRoot = path.join(real, "felles");
    const wikiRoot = path.join(base, "alias", "felles");
    process.env.WIKI_EXTRA = `felles-mirror=${wikiRoot}`;
    __resetWikiRegistryForTest();
    __setReadonlyWikiRootsForTest([wikiRoot]);
    objects.set("a.md", { generation: 1, body: "# A\n" });
    const m = new BucketMirror({ bucket: "felles", prefix: "", root: mirrorRoot }, {
      gcsBase: `http://127.0.0.1:${server.port}`, intervalMs: 60_000, tokens: noTokens,
    });
    live.push(m);
    await m.pollOnce();
    // The reader asks under the registry's spelling and caches that answer.
    expect((await getWikiIndex({ root: wikiRoot }))!.pages.map((p) => p.relPath)).toEqual(["a.md"]);
    objects.set("b.md", { generation: 1, body: "# B\n" });
    await m.pollOnce();
    expect((await getWikiIndex({ root: wikiRoot }))!.pages.map((p) => p.relPath).sort()).toEqual(["a.md", "b.md"]);
  });

  test("a root registered as no wiki is refused before the bucket is listed", async () => {
    delete process.env.WIKI_EXTRA;
    __resetWikiRegistryForTest();
    objects.set("a.md", { generation: 1, body: "a" });
    const m = new BucketMirror({ bucket: "felles", prefix: "", root }, {
      gcsBase: `http://127.0.0.1:${server.port}`, intervalMs: 60_000, tokens: noTokens,
    });
    live.push(m);
    const records = await captureLogs(async () => {
      await expect(m.pollOnce()).rejects.toThrow(/refused/);
    });
    expect(m.state).toBe("refused");
    expect(records.some((r) => String(r.properties.reason).includes("WIKI_EXTRA"))).toBe(true);
    expect(existsSync(path.join(root, "a.md"))).toBe(false);
  });

  test("isReadonlyWikiRoot matches a root created AFTER its first call, through a symlinked spelling", async () => {
    const real = path.join(base, "real");
    await mkdir(real);
    await symlink(real, path.join(base, "alias"));
    const saved = process.env.WIKI_READONLY_ROOTS;
    try {
      process.env.WIKI_READONLY_ROOTS = path.join(base, "alias", "zz");
      __setReadonlyWikiRootsForTest(); // env resolution, memo dropped
      // First call memoizes the roots while `zz` does not exist yet.
      expect(isReadonlyWikiRoot(path.join(real, "zz"))).toBe(true);
      await mkdir(path.join(real, "zz"));
      expect(isReadonlyWikiRoot(path.join(real, "zz"))).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.WIKI_READONLY_ROOTS; else process.env.WIKI_READONLY_ROOTS = saved;
    }
  });
});

// ── D2: a failed refresh stays owed ──────────────────────────────

describe("D2 owed refresh", () => {
  test("a throwing refresh is reported, not thrown, and retried by the next unchanged poll", async () => {
    let calls = 0;
    objects.set("a.md", { generation: 1, body: "a" });
    const m = mirror({ extra: { refreshIndex: async () => { if (++calls === 1) throw new Error("index boom"); } } });
    const first = await m.pollOnce();
    expect(first).toMatchObject({ downloaded: 1, refreshed: false, refreshError: "index boom" });
    const second = await m.pollOnce();
    expect(second).toMatchObject({ downloaded: 0, refreshed: true });
    expect(calls).toBe(2);
    const third = await m.pollOnce();
    expect(third.refreshed).toBe(false);
    expect(calls).toBe(2);
  });
});

// ── D3: bounded reads ────────────────────────────────────────────

describe("D3 bounded reads", () => {
  test("downloads ask for identity encoding", async () => {
    objects.set("a.md", { generation: 1, body: "a" });
    await mirror().pollOnce();
    expect(mediaRequests.map((r) => r.acceptEncoding)).toEqual(["identity"]);
  });

  test("a chunked body with a false listed size stops being read past the cap", async () => {
    objects.set("big.md", { generation: 1, body: "x", size: 60_000 });
    special.set("big.md", "chunked-50mb");
    const r = await mirror().pollOnce();
    expect(r).toMatchObject({ downloaded: 0, failed: 1 });
    expect(existsSync(path.join(root, "big.md"))).toBe(false);
    // Read when the poll returns: Bun's server keeps pulling for a while after
    // the client cancels (measured ~21 MB 300 ms later), which says nothing
    // about how much THIS process buffered.
    expect(streamedBytes).toBeLessThan(20 * 1024 * 1024);
  }, 20_000);

  test("a gzip-stored object that inflates past the cap is refused and not written", async () => {
    objects.set("z.md", { generation: 1, body: "x", size: 60_000 });
    special.set("z.md", "gzip-50mb");
    const r = await mirror().pollOnce();
    expect(r).toMatchObject({ downloaded: 0, failed: 1 });
    expect(existsSync(path.join(root, "z.md"))).toBe(false);
    // identity made the server transcode, and the stream was cut at the cap
    // rather than inflated whole in memory.
    expect(streamedBytes).toBeGreaterThan(0);
    expect(streamedBytes).toBeLessThan(20 * 1024 * 1024);
  }, 20_000);

  test("an oversized list page is refused before it is parsed", async () => {
    objects.set("a.md", { generation: 1, body: "a" });
    listOverride = () => Response.json({ items: [{ name: "a.md", generation: "1", size: "1" }], pad: "x".repeat(9 * 1024 * 1024) });
    await expect(mirror().pollOnce()).rejects.toThrow(/cap/);
    expect(existsSync(path.join(root, "a.md"))).toBe(false);
  });
});

// ── D4: overlapping roots, and the marker's source ───────────────

describe("D4 overlapping roots and marker source", () => {
  test("nested and aliased roots: only the first of each clashing pair is started", async () => {
    const real = path.join(base, "real");
    await mkdir(real);
    await symlink(real, path.join(base, "alias"));
    const { mirrors: kept } = parseWikiBucketMirrors(
      `gs://aaa=${path.join(base, "w")},gs://bbb=${path.join(base, "w", "sub")},` +
      `gs://ccc=${path.join(real, "x")},gs://ddd=${path.join(base, "alias", "x")}`,
    );
    expect(kept).toHaveLength(4); // the exact-string check passes all four
    const started = startWikiBucketMirrors(
      { mirrors: kept, refused: [], intervalRefused: null, intervalMs: 60_000, gcsBase: `http://127.0.0.1:${server.port}`, projectNumber: null, projectNumberRefused: null } as Parameters<typeof startWikiBucketMirrors>[0],
      { autostart: false } as Parameters<typeof startWikiBucketMirrors>[1],
    );
    try {
      expect(started.mirrors.map((m) => m.entry.bucket)).toEqual(["aaa", "ccc"]);
    } finally {
      await started.stop();
    }
  });

  test("a directory marked for another source is refused and left untouched", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, MIRROR_MARKER), "source: gs://someone-else/\n");
    await writeFile(path.join(root, "theirs.md"), "keep");
    objects.set("mine.md", { generation: 1, body: "m" });
    const m = mirror();
    await expect(m.pollOnce()).rejects.toThrow(/refused/);
    expect(m.state).toBe("refused");
    expect((await readdir(root)).sort()).toEqual([MIRROR_MARKER, "theirs.md"]);
  });
});

// ── D5: the root is re-verified before every poll's writes ───────

describe("D5 root re-verification", () => {
  test("a root swapped for a symlink mid-run stops the mirror; nothing outside is written or deleted", async () => {
    objects.set("a.md", { generation: 1, body: "a" });
    const m = mirror();
    await m.pollOnce();
    const outside = path.join(base, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "a.md"), "someone else's");
    await writeFile(path.join(outside, MIRROR_MARKER), await readFile(path.join(root, MIRROR_MARKER)));
    await writeFile(path.join(outside, ".bucket-mirror.lock"), `${process.pid}\n`);
    await rename(root, path.join(base, "moved"));
    await symlink(outside, root);
    objects.delete("a.md");
    objects.set("b.md", { generation: 1, body: "b" });
    await expect(m.pollOnce()).rejects.toThrow();
    expect(m.state).toBe("refused");
    expect(await readFile(path.join(outside, "a.md"), "utf8")).toBe("someone else's");
    expect(existsSync(path.join(outside, "b.md"))).toBe(false);
  });
});

// ── D6: names in logs, and the widened control set ───────────────

describe("D6 control characters and log escaping", () => {
  for (const ch of ["\u2028", "\u2029", "\u202e", "\u2066", "\u0085", "\u009b"]) {
    test(`refuses a name carrying U+${ch.charCodeAt(0).toString(16).padStart(4, "0")}`, () => {
      expect(objectRelPath(`a${ch}b.md`, "")).toEqual({ refused: expect.stringMatching(/control/) });
    });
  }

  test("a prefix carrying a line separator is refused at parse time", () => {
    expect(parseWikiBucketMirrors("gs://felles/a\u2028b=/tmp/x").refused).toHaveLength(1);
  });

  test("a refused object name reaches the log escaped, never with a raw newline", async () => {
    const records = await captureLogs(async () => {
      objects.set("x\nERROR [auth/guard] forged.md", { generation: 1, body: "x" });
      objects.set("ok.md", { generation: 1, body: "ok" });
      await mirror().pollOnce();
    });
    const skipped = records.filter((r) => String(r.rawMessage).includes("skipped"));
    expect(skipped).toHaveLength(1);
    expect(String(skipped[0]!.properties.name)).not.toContain("\n");
    expect(String(skipped[0]!.properties.name)).toContain("\\n");
  });
});

// ── D7: a bad interval is a warn, not a crashloop ────────────────

describe("D7 lenient interval", () => {
  const withInterval = (value: string) => {
    const saved = process.env.WIKI_BUCKET_MIRROR_INTERVAL_MS;
    process.env.WIKI_BUCKET_MIRROR_INTERVAL_MS = value;
    try {
      return resolveWikiBucketMirrorConfig() as ReturnType<typeof resolveWikiBucketMirrorConfig> & {
        intervalRefused?: { value: string; reason: string } | null;
      };
    } finally {
      if (saved === undefined) delete process.env.WIKI_BUCKET_MIRROR_INTERVAL_MS; else process.env.WIKI_BUCKET_MIRROR_INTERVAL_MS = saved;
    }
  };

  test("a non-number falls back to the default and is carried under its own variable", () => {
    const c = withInterval("abc");
    expect(c.intervalMs).toBe(120_000);
    expect(c.intervalRefused).toEqual({ value: "abc", reason: expect.stringMatching(/whole number/) });
    expect(c.refused).toEqual([]);
  });

  test("a value past setTimeout's range falls back to the default", () => {
    const c = withInterval("99999999999");
    expect(c.intervalMs).toBe(120_000);
    expect(c.intervalRefused?.reason).toMatch(/above/);
  });
});

// ── D8: backoff stays inside the 5-minute acceptance ─────────────

describe("D8 backoff cap", () => {
  test("never past max(interval, 5 min), and no overflow on a long outage", () => {
    const backoff = (mirrorModule as unknown as { backoffDelayMs: (i: number, f: number) => number }).backoffDelayMs;
    expect(backoff(120_000, 0)).toBe(120_000);
    expect(backoff(120_000, 1)).toBe(240_000);
    expect(backoff(120_000, 3)).toBe(300_000);
    expect(backoff(1_000, 5000)).toBe(300_000);
    expect(backoff(3_600_000, 4)).toBe(3_600_000);
  });
});

// ── D9: stop() aborts the in-flight poll ─────────────────────────

describe("D9 stop aborts", () => {
  test("stop() returns promptly and the abandoned poll writes nothing and refreshes nothing", async () => {
    objects.set("slow.md", { generation: 1, body: "s" });
    special.set("slow.md", "hang");
    const refreshes: string[] = [];
    const m = mirror({ extra: { refreshIndex: async (r: string) => { refreshes.push(r); } } });
    m.start();
    for (let i = 0; i < 100 && mediaRequests.length === 0; i++) await Bun.sleep(10);
    expect(mediaRequests).toHaveLength(1);
    const t0 = performance.now();
    await m.stop();
    expect(performance.now() - t0).toBeLessThan(2_000);
    releaseHang?.();
    await Bun.sleep(200);
    expect(existsSync(path.join(root, "slow.md"))).toBe(false);
    expect(refreshes).toEqual([]);
  }, 20_000);
});

// ── D10: the segment limit leaves room for the temp name ─────────

describe("D10 segment length", () => {
  test("a 212-byte segment is refused; a 211-byte one is mirrored", async () => {
    const at = (n: number) => `${"a".repeat(n - 3)}.md`;
    expect(objectRelPath(at(212), "")).toEqual({ refused: expect.stringMatching(/211 bytes/) });
    objects.set(at(212), { generation: 1, body: "long" });
    objects.set(at(211), { generation: 1, body: "fits" });
    expect(await mirror().pollOnce()).toMatchObject({ downloaded: 1, skipped: 1, failed: 0 });
    expect(await readFile(path.join(root, at(211)), "utf8")).toBe("fits");
  });
});

// ── D11: names one filesystem stores as one file ─────────────────

describe("D11 case and normalization collisions", () => {
  test("two names differing only in case: one is mirrored, the other skipped", async () => {
    objects.set("a.md", { generation: 1, body: "lower" });
    objects.set("A.md", { generation: 1, body: "upper" });
    expect(await mirror().pollOnce()).toMatchObject({ downloaded: 1, skipped: 1 });
  });

  test("NFC and NFD spellings of one name: one is mirrored, the other skipped", async () => {
    objects.set("å.md", { generation: 1, body: "nfc" });
    objects.set("å.md", { generation: 1, body: "nfd" });
    expect(await mirror().pollOnce()).toMatchObject({ downloaded: 1, skipped: 1 });
  });

  test("a case-only rename keeps the page on disk across polls", async () => {
    objects.set("page.md", { generation: 1, body: "v1" });
    const m = mirror();
    await m.pollOnce();
    objects.delete("page.md");
    objects.set("Page.md", { generation: 2, body: "v2" });
    await m.pollOnce();
    expect(await readFile(path.join(root, "Page.md"), "utf8")).toBe("v2");
    await m.pollOnce();
    expect(await readFile(path.join(root, "Page.md"), "utf8")).toBe("v2");
  });
});

// ── C1: an empty listing never empties the wiki ──────────────────

describe("C1 mass-delete guard", () => {
  test("a listing with no objects while files are mirrored deletes nothing", async () => {
    objects.set("a.md", { generation: 1, body: "a" });
    objects.set("b.md", { generation: 1, body: "b" });
    const m = mirror();
    await m.pollOnce();
    objects.clear();
    expect(await m.pollOnce()).toMatchObject({ deleted: 0, massDeleteRefused: true });
    expect(existsSync(path.join(root, "a.md"))).toBe(true);
    expect(existsSync(path.join(root, "b.md"))).toBe(true);
  });

  test("a proxy answering {} deletes nothing", async () => {
    objects.set("a.md", { generation: 1, body: "a" });
    const m = mirror();
    await m.pollOnce();
    listOverride = () => Response.json({});
    expect(await m.pollOnce()).toMatchObject({ deleted: 0, massDeleteRefused: true });
    expect(existsSync(path.join(root, "a.md"))).toBe(true);
  });

  test("deleting some but not all files still works", async () => {
    objects.set("a.md", { generation: 1, body: "a" });
    objects.set("b.md", { generation: 1, body: "b" });
    const m = mirror();
    await m.pollOnce();
    objects.delete("b.md");
    expect(await m.pollOnce()).toMatchObject({ deleted: 1 });
    expect(existsSync(path.join(root, "b.md"))).toBe(false);
  });
});

// ── C2: page dates are the upload time ───────────────────────────

describe("C2 page dates", () => {
  test("a mirrored file's mtime is the object's updated time", async () => {
    const updated = "2026-01-02T03:04:05.000Z";
    objects.set("dated.md", { generation: 1, body: "d", updated });
    await mirror().pollOnce();
    expect((await stat(path.join(root, "dated.md"))).mtimeMs).toBe(Date.parse(updated));
  });
});

// ── C4: one writer per root ──────────────────────────────────────

describe("C4 root lock", () => {
  test("a root locked by another live process is skipped, nothing written", async () => {
    const holder = Bun.spawn(["sleep", "30"]);
    try {
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, MIRROR_MARKER), "source: gs://felles/\n");
      await writeFile(path.join(root, ".bucket-mirror.lock"), `${holder.pid}\n`);
      objects.set("a.md", { generation: 1, body: "a" });
      const m = mirror();
      await expect(m.pollOnce()).rejects.toThrow(/locked/);
      expect(existsSync(path.join(root, "a.md"))).toBe(false);
    } finally {
      holder.kill();
      await holder.exited;
    }
  });

  test("a lock whose pid is gone is reclaimed and rewritten with ours", async () => {
    const gone = Bun.spawn(["true"]);
    await gone.exited;
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, MIRROR_MARKER), "source: gs://felles/\n");
    await writeFile(path.join(root, ".bucket-mirror.lock"), `${gone.pid}\n`);
    objects.set("a.md", { generation: 1, body: "a" });
    expect(await mirror().pollOnce()).toMatchObject({ downloaded: 1 });
    expect((await readFile(path.join(root, ".bucket-mirror.lock"), "utf8")).trim()).toBe(String(process.pid));
  });

  test("a second mirror of the same root in this process is skipped while the first holds it", async () => {
    objects.set("a.md", { generation: 1, body: "a" });
    const first = mirror();
    await first.pollOnce();
    objects.set("b.md", { generation: 1, body: "b" });
    const second = mirror();
    await expect(second.pollOnce()).rejects.toThrow(/locked/);
    expect(existsSync(path.join(root, "b.md"))).toBe(false);
    await first.stop();
    await second.pollOnce();
    expect(await readFile(path.join(root, "b.md"), "utf8")).toBe("b");
  });
});
