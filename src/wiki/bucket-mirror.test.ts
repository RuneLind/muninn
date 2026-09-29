import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GCS_DEFAULT_BASE, parseWikiBucketMirrors, resolveWikiBucketMirrorConfig } from "../config.ts";
import { GcpTokenProvider } from "../gcp/access-token.ts";
import {
  atomicWrite,
  BucketMirror,
  checkMirrorRoot,
  MAX_OBJECT_BYTES,
  MIRROR_LOCK,
  MIRROR_MARKER,
  objectRelPath,
  prepareMirrorRoot,
  tokenSourceFor,
  type BucketMirrorDeps,
  type TokenSource,
} from "./bucket-mirror.ts";

// ── Config parse ─────────────────────────────────────────────────

describe("parseWikiBucketMirrors", () => {
  test("valid entries: bucket only, bucket + prefix (slashes normalized), several", () => {
    const { mirrors, refused } = parseWikiBucketMirrors(
      " gs://felles-wiki=/tmp/wikis/a/ , gs://felles_wiki.b/plans/=/tmp/wikis/b,gs://c-1//x/y//=/tmp/./wikis/c ,",
    );
    expect(refused).toEqual([]);
    expect(mirrors).toEqual([
      { bucket: "felles-wiki", prefix: "", root: "/tmp/wikis/a" },
      { bucket: "felles_wiki.b", prefix: "plans/", root: "/tmp/wikis/b" },
      { bucket: "c-1", prefix: "x/y/", root: "/tmp/wikis/c" },
    ]);
  });

  test("unset or blank is no mirrors", () => {
    expect(parseWikiBucketMirrors(undefined)).toEqual({ mirrors: [], refused: [] });
    expect(parseWikiBucketMirrors("  ,  ")).toEqual({ mirrors: [], refused: [] });
  });

  const bad: [string, RegExp][] = [
    ["gs://bucket", /expected/],
    ["s3://bucket=/tmp/x", /gs:\/\//],
    ["gs://Bucket=/tmp/x", /bucket name/],
    ["gs://b=/tmp/x", /bucket name/],
    ["gs://bucket/a/../b=/tmp/x", /prefix/],
    ["gs://bucket/a\\b=/tmp/x", /prefix/],
    ["gs://bucket=relative/x", /absolute/],
    ["gs://bucket=/", /not be \//],
    ["gs://bucket=/tmp/..", /not be \//],
  ];
  for (const [entry, reason] of bad) {
    test(`refuses ${entry}`, () => {
      const { mirrors, refused } = parseWikiBucketMirrors(entry);
      expect(mirrors).toEqual([]);
      expect(refused).toHaveLength(1);
      expect(refused[0]!.reason).toMatch(reason);
    });
  }

  test("resolveWikiBucketMirrorConfig carries refusals (logging is not up yet at loadConfig time) and defaults", () => {
    const keys = ["WIKI_BUCKET_MIRRORS", "WIKI_BUCKET_MIRROR_INTERVAL_MS", "WIKI_BUCKET_MIRROR_GCS_BASE"] as const;
    const saved = keys.map((k) => process.env[k]);
    try {
      process.env.WIKI_BUCKET_MIRRORS = "gs://ok-bucket=/tmp/w,gs://Bad=/tmp/v";
      process.env.WIKI_BUCKET_MIRROR_INTERVAL_MS = "10";
      process.env.WIKI_BUCKET_MIRROR_GCS_BASE = "http://127.0.0.1:1234/";
      const c = resolveWikiBucketMirrorConfig();
      expect(c.mirrors).toEqual([{ bucket: "ok-bucket", prefix: "", root: "/tmp/w" }]);
      expect(c.refused.map((r) => r.entry)).toEqual(["gs://Bad=/tmp/v"]);
      expect(c.intervalRefused).toEqual({ value: "10", reason: expect.stringMatching(/below 1000/) });
      expect(c.intervalMs).toBe(120_000);
      expect(c.gcsBase).toBe("http://127.0.0.1:1234");
      for (const k of keys) delete process.env[k];
      expect(resolveWikiBucketMirrorConfig()).toEqual({ mirrors: [], refused: [], intervalRefused: null, intervalMs: 120_000, gcsBase: GCS_DEFAULT_BASE });
    } finally {
      keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
    }
  });

  test("a second mirror on the same root is refused, the first kept", () => {
    const { mirrors, refused } = parseWikiBucketMirrors("gs://aaa=/tmp/w,gs://bbb=/tmp/w/");
    expect(mirrors.map((m) => m.bucket)).toEqual(["aaa"]);
    expect(refused[0]!.reason).toMatch(/already used/);
  });
});

// ── Name validation ──────────────────────────────────────────────

describe("objectRelPath", () => {
  const ok: [string, string, string][] = [
    ["plans/side.mdx", "", "plans/side.mdx"],
    ["felles/plans/side.md", "felles/", "plans/side.md"],
    ["a/b/c.HTML", "", "a/b/c.HTML"],
    [".wiki-reader.json", "", ".wiki-reader.json"],
    ["p/.wiki-reader.json", "p/", ".wiki-reader.json"],
    ["norsk/æøå side.mdx", "", "norsk/æøå side.mdx"],
  ];
  for (const [name, prefix, rel] of ok) {
    test(`admits ${JSON.stringify(name)} under ${JSON.stringify(prefix)}`, () => {
      expect(objectRelPath(name, prefix)).toEqual({ relPath: rel });
    });
  }

  const refused: [string, string, RegExp][] = [
    ["felles/", "felles/", /empty name/],
    ["plans/", "", /folder placeholder/],
    ["/etc/passwd.md", "", /absolute/],
    ["a/../../x.md", "", /'\.' or '\.\.'/],
    ["../x.md", "", /'\.' or '\.\.'/],
    ["./x.md", "", /'\.' or '\.\.'/],
    ["a//b.md", "", /empty path segment/],
    ["a\\b.md", "", /backslash/],
    ["a\u0000b.md", "", /control/],
    ["a\nb.md", "", /control/],
    [".git/config.md", "", /hidden/],
    ["plans/.secret.md", "", /hidden/],
    ["plans/.wiki-reader.json", "", /hidden/],
    [".bucket-mirror", "", /hidden/],
    ["data.json", "", /extension/],
    ["run.sh", "", /extension/],
    ["README", "", /extension/],
    ["other/x.md", "felles/", /outside the prefix/],
    [`${"a".repeat(256)}.md`, "", /211 bytes/],
    ["img/x.png", "", /extension/],
    ["img/x.svg", "", /extension/],
  ];
  for (const [name, prefix, reason] of refused) {
    test(`refuses ${JSON.stringify(name).slice(0, 40)}`, () => {
      const r = objectRelPath(name, prefix);
      expect("refused" in r && r.refused).toMatch(reason);
    });
  }
});

// ── Root safety + ownership ──────────────────────────────────────

const SRC = "gs://felles/";

describe("checkMirrorRoot / prepareMirrorRoot", () => {
  let base: string;
  beforeEach(async () => { base = await mkdtemp(path.join(tmpdir(), "bm-root-")); });
  afterEach(async () => { await rm(base, { recursive: true, force: true }); });

  test("a root inside tmpdir passes, even before it exists", () => {
    const root = path.join(base, "wikis/felles");
    const r = checkMirrorRoot(root, tmpdir());
    expect("realRoot" in r).toBe(true);
  });

  test("refuses: outside tmpdir, the tmpdir itself, /, relative", () => {
    const home = path.join(process.env.HOME ?? "/Users/x", "wiki-mirror-test");
    expect(checkMirrorRoot(home, tmpdir())).toEqual({ refused: expect.stringMatching(/outside the temp/) });
    expect(checkMirrorRoot(tmpdir(), tmpdir())).toEqual({ refused: expect.stringMatching(/temp directory itself/) });
    expect(checkMirrorRoot("/", tmpdir())).toEqual({ refused: expect.stringMatching(/filesystem root/) });
    expect(checkMirrorRoot("rel/x", tmpdir())).toEqual({ refused: expect.stringMatching(/absolute/) });
  });

  test("refuses a root that escapes tmpdir through a symlink", async () => {
    const outside = await mkdtemp(path.join(process.cwd(), ".bm-outside-"));
    try {
      const link = path.join(base, "link");
      await symlink(outside, link);
      const root = path.join(link, "felles");
      expect(checkMirrorRoot(root, tmpdir())).toEqual({ refused: expect.stringMatching(/outside the temp/) });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("missing dir: created and marked", async () => {
    const root = path.join(base, "new/felles");
    expect(await prepareMirrorRoot(root, SRC)).toEqual({ files: [] });
    expect(existsSync(path.join(root, MIRROR_MARKER))).toBe(true);
  });

  test("existing EMPTY dir: adopted and marked", async () => {
    expect(await prepareMirrorRoot(base, SRC)).toEqual({ files: [] });
    expect(existsSync(path.join(base, MIRROR_MARKER))).toBe(true);
  });

  test("non-empty dir without the marker: refused, nothing touched", async () => {
    await writeFile(path.join(base, "keep.md"), "mine");
    const r = await prepareMirrorRoot(base, SRC);
    expect(r).toEqual({ refused: expect.stringMatching(/not empty/) });
    expect(await readdir(base)).toEqual(["keep.md"]);
  });

  test("marked dir: manifest rebuilt from valid files; temp leftovers removed; others ignored", async () => {
    await writeFile(path.join(base, MIRROR_MARKER), "");
    await mkdir(path.join(base, "plans"));
    await writeFile(path.join(base, "plans/a.mdx"), "a");
    await writeFile(path.join(base, ".wiki-reader.json"), "{}");
    await writeFile(path.join(base, "plans/.a.mdx.bmtmp-123"), "partial");
    await writeFile(path.join(base, "notes.txt"), "not managed");
    const r = await prepareMirrorRoot(base, SRC);
    expect("files" in r && r.files.sort()).toEqual([".wiki-reader.json", "plans/a.mdx"]);
    expect(existsSync(path.join(base, "plans/.a.mdx.bmtmp-123"))).toBe(false);
    expect(existsSync(path.join(base, "notes.txt"))).toBe(true);
  });

  test("atomicWrite leaves no temp file and replaces in place", async () => {
    await atomicWrite(base, "a/b/c.md", new TextEncoder().encode("one"));
    await atomicWrite(base, "a/b/c.md", new TextEncoder().encode("two"));
    expect(await readFile(path.join(base, "a/b/c.md"), "utf8")).toBe("two");
    expect(await readdir(path.join(base, "a/b"))).toEqual(["c.md"]);
  });

  test("atomicWrite refuses to write through a symlinked directory", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "bm-elsewhere-"));
    try {
      await symlink(outside, path.join(base, "plans"));
      await expect(atomicWrite(base, "plans/x.md", new Uint8Array([1]))).rejects.toThrow(/not a plain directory/);
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

// ── The poll against a fake GCS ──────────────────────────────────

interface FakeObject { generation: number; body: string | Uint8Array; size?: number }

describe("BucketMirror.pollOnce against a fake GCS", () => {
  const objects = new Map<string, FakeObject>();
  const requests: { url: URL; auth: string | null }[] = [];
  let listStatus = 200;
  let mediaStatus = new Map<string, number>();
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  let root: string;
  let refreshes: string[];

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        requests.push({ url, auth: req.headers.get("authorization") });
        const m = /^\/storage\/v1\/b\/([^/]+)\/o(?:\/(.+))?$/.exec(url.pathname);
        if (!m || decodeURIComponent(m[1]!) !== "felles") return new Response("no bucket", { status: 404 });
        if (!m[2]) {
          if (listStatus !== 200) return new Response("denied", { status: listStatus });
          const prefix = url.searchParams.get("prefix") ?? "";
          const names = [...objects.keys()].filter((n) => n.startsWith(prefix)).sort();
          const start = Number(url.searchParams.get("pageToken") ?? "0");
          const page = names.slice(start, start + 2); // page size 2 forces paging
          const next = start + 2 < names.length ? String(start + 2) : undefined;
          return Response.json({
            items: page.map((name) => {
              const o = objects.get(name)!;
              return { name, generation: String(o.generation), size: String(o.size ?? (typeof o.body === "string" ? Buffer.byteLength(o.body) : o.body.byteLength)) };
            }),
            ...(next ? { nextPageToken: next } : {}),
          });
        }
        const name = decodeURIComponent(m[2]);
        const forced = mediaStatus.get(name);
        if (forced) return new Response("nope", { status: forced });
        const o = objects.get(name);
        if (!o || url.searchParams.get("alt") !== "media" || url.searchParams.get("generation") !== String(o.generation)) {
          return new Response("not found", { status: 404 });
        }
        return new Response(typeof o.body === "string" ? o.body : new Blob([o.body as Uint8Array<ArrayBuffer>]));
      },
    });
  });
  afterAll(() => server.stop(true));

  beforeEach(async () => {
    objects.clear();
    requests.length = 0;
    listStatus = 200;
    mediaStatus = new Map();
    refreshes = [];
    base = await mkdtemp(path.join(tmpdir(), "bm-poll-"));
    root = path.join(base, "wikis/felles");
  });
  afterEach(async () => {
    await Promise.all(live.splice(0).map((m) => m.stop()));
    await rm(base, { recursive: true, force: true });
  });

  const live: BucketMirror[] = [];
  const noTokens: TokenSource = { acquire: async () => null, invalidate: () => {} };
  function mirror(prefix = "", tokens: TokenSource = noTokens, extra: Partial<BucketMirrorDeps> = {}) {
    const m = new BucketMirror({ bucket: "felles", prefix, root }, {
      gcsBase: `http://127.0.0.1:${server.port}`,
      intervalMs: 60_000,
      tokens,
      registeredWikiRoot: (r) => r,
      isReadonlyRoot: () => true,
      refreshIndex: async (r) => { refreshes.push(r); },
      ...extra,
    });
    live.push(m);
    return m;
  }
  const read = (rel: string) => readFile(path.join(root, rel), "utf8");

  test("first poll downloads every page across list pages; an unchanged poll does nothing", async () => {
    objects.set("plans/a.mdx", { generation: 1, body: "# A" });
    objects.set("plans/b.md", { generation: 1, body: "# B" });
    objects.set("index.md", { generation: 1, body: "# Index" });
    objects.set(".wiki-reader.json", { generation: 1, body: "{}" });
    objects.set("guide.html", { generation: 1, body: new Uint8Array([60, 112, 62]) });
    const m = mirror();
    expect(await m.pollOnce()).toEqual({ listed: 5, downloaded: 5, deleted: 0, skipped: 0, failed: 0, refreshed: true });
    expect(await read("plans/a.mdx")).toBe("# A");
    expect(await read(".wiki-reader.json")).toBe("{}");
    expect(requests.filter((r) => !r.url.searchParams.has("alt")).length).toBe(3); // 5 objects / page size 2
    expect(refreshes).toEqual([root]);

    requests.length = 0;
    expect(await m.pollOnce()).toEqual({ listed: 5, downloaded: 0, deleted: 0, skipped: 0, failed: 0, refreshed: false });
    expect(requests.every((r) => !r.url.searchParams.has("alt"))).toBe(true);
    expect(refreshes).toEqual([root]); // no second refresh
  });

  test("a changed generation re-downloads; a deleted object is deleted and its emptied dir pruned", async () => {
    objects.set("plans/a.mdx", { generation: 1, body: "v1" });
    objects.set("deep/x/y.md", { generation: 1, body: "y" });
    const m = mirror();
    await m.pollOnce();
    objects.set("plans/a.mdx", { generation: 2, body: "v2" });
    objects.delete("deep/x/y.md");
    expect(await m.pollOnce()).toMatchObject({ downloaded: 1, deleted: 1 });
    expect(await read("plans/a.mdx")).toBe("v2");
    expect(existsSync(path.join(root, "deep"))).toBe(false);
    expect((await readdir(root)).sort()).toEqual([MIRROR_MARKER, MIRROR_LOCK, "plans"]);
    expect(refreshes.length).toBe(2);
  });

  test("a 403 on the listing throws and deletes nothing", async () => {
    objects.set("plans/a.mdx", { generation: 1, body: "v1" });
    const m = mirror();
    await m.pollOnce();
    listStatus = 403;
    objects.clear();
    await expect(m.pollOnce()).rejects.toThrow(/list gs:\/\/felles answered 403/);
    expect(await read("plans/a.mdx")).toBe("v1");
    expect(m.manifest.has("plans/a.mdx")).toBe(true);
  });

  test("an oversized object is skipped, and an existing copy of it kept", async () => {
    objects.set("big.md", { generation: 1, body: "small" });
    const m = mirror();
    await m.pollOnce();
    objects.set("big.md", { generation: 2, body: "x", size: MAX_OBJECT_BYTES + 1 });
    expect(await m.pollOnce()).toMatchObject({ downloaded: 0, deleted: 0, skipped: 1 });
    expect(await read("big.md")).toBe("small");
  });

  test("refused names are skipped, never written outside the root", async () => {
    objects.set("../escape.md", { generation: 1, body: "x" });
    objects.set("a/../../escape2.md", { generation: 1, body: "x" });
    objects.set("plans/", { generation: 1, body: "" });
    objects.set("run.sh", { generation: 1, body: "x" });
    objects.set("ok.md", { generation: 1, body: "ok" });
    expect(await mirror().pollOnce()).toMatchObject({ listed: 5, downloaded: 1, skipped: 4 });
    expect(existsSync(path.join(base, "wikis/escape.md"))).toBe(false);
    expect(existsSync(path.join(base, "escape2.md"))).toBe(false);
    expect((await readdir(root)).sort()).toEqual([MIRROR_MARKER, MIRROR_LOCK, "ok.md"]);
  });

  test("a failed download keeps the old copy and is retried on the next poll", async () => {
    objects.set("a.md", { generation: 1, body: "v1" });
    const m = mirror();
    await m.pollOnce();
    objects.set("a.md", { generation: 2, body: "v2" });
    mediaStatus.set("a.md", 500);
    expect(await m.pollOnce()).toMatchObject({ downloaded: 0, failed: 1 });
    expect(await read("a.md")).toBe("v1");
    mediaStatus.clear();
    expect(await m.pollOnce()).toMatchObject({ downloaded: 1 });
    expect(await read("a.md")).toBe("v2");
  });

  test("a prefix mirror maps names under it and ignores the rest", async () => {
    objects.set("felles/plans/a.mdx", { generation: 1, body: "a" });
    objects.set("private/b.md", { generation: 1, body: "b" });
    expect(await mirror("felles/").pollOnce()).toMatchObject({ listed: 1, downloaded: 1 });
    expect(await read("plans/a.mdx")).toBe("a");
  });

  test("restart over a marked dir adopts its files and deletes the ones gone from the bucket", async () => {
    objects.set("a.md", { generation: 1, body: "a" });
    objects.set("b.md", { generation: 1, body: "b" });
    const first = mirror();
    await first.pollOnce();
    await first.stop();
    objects.delete("b.md");
    const restarted = mirror();
    expect(await restarted.pollOnce()).toMatchObject({ downloaded: 1, deleted: 1 });
    expect(existsSync(path.join(root, "b.md"))).toBe(false);
  });

  test("a refused root never lists the bucket", async () => {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "precious.md"), "keep");
    objects.set("a.md", { generation: 1, body: "a" });
    const m = mirror();
    await expect(m.pollOnce()).rejects.toThrow(/refused/);
    expect(m.state).toBe("refused");
    expect(requests.length).toBe(0);
    expect(await readdir(root)).toEqual(["precious.md"]);
  });

  test("a 401 invalidates the token and retries once with a fresh one", async () => {
    objects.set("a.md", { generation: 1, body: "a" });
    let n = 0;
    const invalidated: number[] = [];
    const tokens: TokenSource = {
      acquire: async () => ({ token: `t${++n}`, generation: n }),
      invalidate: (g) => invalidated.push(g),
    };
    // First list request with t1 answers 401; the fake reads auth from `requests`.
    const realFetch = globalThis.fetch;
    let first = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (first) { first = false; return new Response("expired", { status: 401 }); }
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      expect(await mirror("", tokens).pollOnce()).toMatchObject({ downloaded: 1 });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(invalidated).toEqual([1]);
    expect(requests[0]!.auth).toBe("Bearer t2");
  });

  test("start() polls immediately and stop() ends the loop", async () => {
    objects.set("a.md", { generation: 1, body: "a" });
    const m = mirror();
    m.start();
    for (let i = 0; i < 50 && !existsSync(path.join(root, "a.md")); i++) await Bun.sleep(20);
    expect(await read("a.md")).toBe("a");
    await m.stop();
  });
});

describe("tokenSourceFor", () => {
  test("never hands a token to a non-Google base; uses the provider for the real one", async () => {
    let fetched = 0;
    const provider = new GcpTokenProvider(async () => {
      fetched++;
      return { token: "adc", expiresAtMs: Date.now() + 3_600_000, source: "metadata-server" };
    }, "GCS");
    expect(await tokenSourceFor("http://127.0.0.1:9999", provider).acquire()).toBeNull();
    expect(fetched).toBe(0);
    expect((await tokenSourceFor(GCS_DEFAULT_BASE, provider).acquire())?.token).toBe("adc");
    expect(fetched).toBe(1);
  });
});
