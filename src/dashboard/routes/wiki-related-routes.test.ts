/**
 * `GET /api/wiki/related` — the reader's second hop — and the `related[]` rows
 * `GET /api/wiki/page` ships, driven through the real routes over a temp wiki.
 *
 * What a unit test of `computeRelated` cannot see: the `exclude` cut (the open
 * page AND its own attachments, compared through `normalizeRelPath`), the
 * `limit` clamp, and that both routes ship `strength` and `signals` on a row.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { registerWikiRoutes } from "./wiki-routes.ts";
import { RELATED_HOP_LIMIT_DEFAULT, RELATED_HOP_LIMIT_MAX } from "../../wiki/related-constants.ts";
import { __resetWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";

function page(title: string, body: string): string {
  return ["---", `title: ${title}`, "---", "", body, ""].join("\n");
}

interface Row {
  relPath: string;
  why: string;
  strength: number;
  signals: { link: string | null; prs: string[]; sessions: string[] };
}

describe("GET /api/wiki/related", () => {
  let root = "";
  let app: Hono;
  let prevExtra: string | undefined;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-related-route-"));
    const files: Array<[string, string]> = [
      // The open page, with its own attachment (`<stem>-prototype.html`).
      ["plans/Open.md", page("Open", "Reads [[hop]].")],
      ["plans/Open-prototype.html", "<html><head><title>Open prototype</title></head><body>x</body></html>"],
      // The row the reader hops through: it links back to the open page, to
      // the open page's attachment, and to two pages of its own.
      [
        "plans/hop.md",
        page("Hop", "Reads [[Open]], [proto](./Open-prototype.html), [[side]] and [[other]]."),
      ],
      ["plans/side.md", page("Side", "Nothing.")],
      ["plans/other.md", page("Other", "Nothing.")],
      // A page with 25 neighbours, for the clamp.
      ["big/wide.md", page("Wide", Array.from({ length: 25 }, (_, i) => `[[w${i}]]`).join(" "))],
    ];
    for (let i = 0; i < 25; i++) files.push([`big/w${i}.md`, page(`W${i}`, "x")]);
    for (const [rel, body] of files) {
      await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
      await writeFile(path.join(root, rel), body, "utf8");
    }
    prevExtra = process.env.WIKI_EXTRA;
    process.env.WIKI_EXTRA = `relwiki=${root}`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    app = new Hono();
    app.onError((err, c) => c.json({ error: String(err) }, 500));
    registerWikiRoutes(app, {} as Parameters<typeof registerWikiRoutes>[1]);
  });

  afterAll(async () => {
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  const related = async (query: string): Promise<{ related: Row[]; total: number }> => {
    const res = await app.request(`/api/wiki/related?wiki=relwiki&${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as { related: Row[]; total: number };
  };

  test("without exclude, the hop page's block holds the open page and its attachment", async () => {
    // The control: both really ARE neighbours of `hop`, so their absence below
    // is the exclude cut and not a missing fixture.
    const { related: rows } = await related("relPath=plans/hop.md");
    const paths = rows.map((r) => r.relPath).sort();
    expect(paths).toEqual(["plans/Open-prototype.html", "plans/Open.md", "plans/other.md", "plans/side.md"]);
  });

  test("exclude drops the open page AND its own attachments, matched case-insensitively", async () => {
    for (const exclude of ["plans/Open.md", "plans/open.md", "PLANS/OPEN.MD"]) {
      const body = await related(`relPath=plans/hop.md&exclude=${encodeURIComponent(exclude)}`);
      expect(body.related.map((r) => r.relPath).sort(), exclude).toEqual(["plans/other.md", "plans/side.md"]);
      expect(body.total, exclude).toBe(2);
    }
  });

  test("rows carry strength and signals, in the /api/wiki/page row shape", async () => {
    const { related: rows } = await related("relPath=plans/hop.md&exclude=plans/Open.md");
    const side = rows.find((r) => r.relPath === "plans/side.md")!;
    expect(side.why).toBe("cited by this page");
    expect(side.strength).toBe(1);
    expect(side.signals).toEqual({ link: "out", prs: [], sessions: [] });

    const pageBody = (await (await app.request("/api/wiki/page?wiki=relwiki&relPath=plans/Open.md")).json()) as {
      related: Row[];
    };
    // `hop` links to Open and Open links to `hop`: both ways, 1.6.
    expect(pageBody.related.map((r) => [r.relPath, r.strength, r.signals.link])).toEqual([["plans/hop.md", 1.6, "both"]]);
    // Same row shape on both routes — a listing row plus the three fields.
    expect(Object.keys(pageBody.related[0]!).sort()).toEqual(Object.keys(side).sort());
  });

  test("limit: a plain integer clamped to 1–20; anything else is the default; total counts every row", async () => {
    expect(RELATED_HOP_LIMIT_DEFAULT).toBe(6);
    expect(RELATED_HOP_LIMIT_MAX).toBe(20);
    expect((await related("relPath=big/wide.md")).related).toHaveLength(RELATED_HOP_LIMIT_DEFAULT);
    const D = RELATED_HOP_LIMIT_DEFAULT;
    // A prefix parse read `1e3` and `0x10` as 1 and `5abc` as 5; a strict one
    // reads only digits.
    const table: Array<[string | null, number]> = [
      ["0", 1],
      ["3", 3],
      ["999", RELATED_HOP_LIMIT_MAX],
      ["-1", D],
      ["abc", D],
      ["", D],
      [null, D],
      ["1.9", D],
      ["1e3", D],
      ["0x10", D],
      ["5abc", D],
    ];
    for (const [limit, want] of table) {
      const q = limit === null ? "" : `&limit=${encodeURIComponent(limit)}`;
      const body = await related(`relPath=big/wide.md${q}`);
      expect(`${limit} → ${body.related.length}`).toBe(`${limit} → ${want}`);
      expect(body.total).toBe(25);
    }
  });

  test("exclude resolves like the target page: relPath with or without extension, or a unique stem", async () => {
    for (const exclude of ["plans/Open", "plans/open", "Open", "open"]) {
      const body = await related(`relPath=plans/hop.md&exclude=${encodeURIComponent(exclude)}`);
      expect(body.related.map((r) => r.relPath).sort(), exclude).toEqual(["plans/other.md", "plans/side.md"]);
    }
    // An unknown exclude cuts nothing.
    expect((await related("relPath=plans/hop.md&exclude=nope")).total).toBe(4);
  });

  test("the /api/wiki/page ladder: 400 with no page, 404 for an unknown one", async () => {
    expect((await app.request("/api/wiki/related?wiki=relwiki")).status).toBe(400);
    expect((await app.request("/api/wiki/related?wiki=relwiki&relPath=nope.md")).status).toBe(404);
    expect((await app.request("/api/wiki/related?wiki=__none__&relPath=plans/hop.md")).status).toBe(404);
  });
});

/**
 * `exclude` names a page the way the docs say — a relPath (case-insensitive),
 * the relPath without its extension, or a folder-less STEM exactly one
 * non-attachment page has — and nothing else: not a title, not an alias, not a
 * stem two pages share, not an attachment's own stem. One hub cites every
 * candidate, so a cut shows as a row missing from the hub's block.
 */
describe("GET /api/wiki/related — what `exclude` resolves", () => {
  let root = "";
  let app: Hono;
  let prevExtra: string | undefined;

  const ALL = [
    "a/x.md",
    "b/y.md",
    "c/aliased.md",
    "d/dup.md",
    "e/dup.md",
    "f/solo-prototype.html",
    "f/solo.md",
    "h/pair.html",
    "h/pair.md",
  ];

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wiki-related-exclude-"));
    const html = (t: string) => `<html><head><title>${t}</title></head><body>x</body></html>`;
    const files: Array<[string, string]> = [
      ["hub.md", page("Hub", ALL.map((rel, i) => `[l${i}](${rel})`).join(" "))],
      // Two pages sharing a TITLE, neither carrying it as a stem.
      ["a/x.md", page("Overview", "x")],
      ["b/y.md", page("Overview", "y")],
      // A page known by an alias.
      ["c/aliased.md", ["---", "title: Nicknamed page", "aliases: [Nick]", "---", "", "z", ""].join("\n")],
      // One stem, two pages.
      ["d/dup.md", page("Dup D", "d")],
      ["e/dup.md", page("Dup E", "e")],
      // A unique stem with a suffix attachment (`solo-prototype` is the
      // attachment's own stem, and no page's).
      ["f/solo.md", page("Solo", "s")],
      ["f/solo-prototype.html", html("Solo prototype")],
      // A same-stem attachment: `pair` is two files, one page.
      ["h/pair.md", page("Pair", "p")],
      ["h/pair.html", html("Pair diagram")],
    ];
    for (const [rel, body] of files) {
      await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
      await writeFile(path.join(root, rel), body, "utf8");
    }
    prevExtra = process.env.WIKI_EXTRA;
    process.env.WIKI_EXTRA = `exwiki=${root}`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    app = new Hono();
    app.onError((err, c) => c.json({ error: String(err) }, 500));
    registerWikiRoutes(app, {} as Parameters<typeof registerWikiRoutes>[1]);
  });

  afterAll(async () => {
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  /** The hub's rows with `exclude` applied, as sorted relPaths. */
  const kept = async (exclude: string | null): Promise<string[]> => {
    const q = exclude === null ? "" : `&exclude=${encodeURIComponent(exclude)}`;
    const res = await app.request(`/api/wiki/related?wiki=exwiki&relPath=hub.md&limit=20${q}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { related: Row[] };
    return body.related.map((r) => r.relPath).sort();
  };
  const without = (...cut: string[]) => ALL.filter((r) => !cut.includes(r));

  test("control: without exclude, the hub's block holds every candidate", async () => {
    expect(await kept(null)).toEqual(ALL);
  });

  test("a TITLE cuts nothing — a unique one, or one two pages share", async () => {
    for (const ref of ["Overview", "overview", "Nicknamed page"]) expect(await kept(ref), ref).toEqual(ALL);
  });

  test("an ALIAS cuts nothing", async () => {
    expect(await kept("Nick")).toEqual(ALL);
    expect(await kept("nick")).toEqual(ALL);
  });

  test("a stem two pages share cuts nothing", async () => {
    for (const ref of ["dup", "DUP"]) expect(await kept(ref), ref).toEqual(ALL);
  });

  test("a unique stem cuts its page and the page's attachments, in any case", async () => {
    for (const ref of ["solo", "SOLO", "Solo", " solo "]) {
      expect(await kept(ref), ref).toEqual(without("f/solo.md", "f/solo-prototype.html"));
    }
    // `pair` is two files — the page and its same-stem attachment — and one page.
    expect(await kept("pair")).toEqual(without("h/pair.md", "h/pair.html"));
  });

  test("an attachment's own stem names no page, so it cuts nothing", async () => {
    expect(await kept("solo-prototype")).toEqual(ALL);
  });

  test("a stem under a folder it is not in cuts nothing; relPaths cut in any case", async () => {
    expect(await kept("zz/solo")).toEqual(ALL);
    expect(await kept("D/DUP")).toEqual(without("d/dup.md"));
    expect(await kept("e/dup.md")).toEqual(without("e/dup.md"));
    expect(await kept("F/Solo-Prototype.HTML")).toEqual(without("f/solo-prototype.html"));
  });
});
