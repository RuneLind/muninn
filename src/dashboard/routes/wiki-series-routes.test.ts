/**
 * `POST /api/wiki/series` — the series editor's one write.
 *
 * Every case drives a REAL temp wiki through the real `writeWikiPage`, because
 * the contract this route has is a contract about BYTES: which line moved, which
 * other byte did not, and which status a refusal answers with. A mocked write
 * seam would pass with the frontmatter writer wired to the wrong key.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import {
  __resetWikiRegistryForTest,
  __setWikiRegistryForTest,
} from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import {
  __setReadonlyWikiRootsForTest,
  __setWikiReadonlyForTest,
} from "../../wiki/readonly.ts";
import { sha256 } from "../../gardener/util.ts";
import { registerWikiSeriesRoutes } from "./wiki-series-routes.ts";

const PLAN = "plans/alpha.mdx";
const SHIPPED = "plans/beta.mdx";
const BLOG = "blogs/gamma.mdx";
const LONE = "plans/lone.mdx";
const EXPLAINER = "blogs/report.html";

/** A page with the frontmatter shape the reader parses. */
function md(title: string, extra: string[] = []): string {
  return ["---", `title: ${title}`, ...extra, "---", "", "Body.", ""].join("\n");
}

const PAGES: Array<[string, string]> = [
  [PLAN, md("Alpha plan", ["series: prov", "series_label: Wiki provenance", "plan_status: in-flight", "status_date: 2026-09-02"])],
  [SHIPPED, md("Beta plan", ["series: Prov", "plan_status: shipped", "status_date: 2026-09-01"])],
  [BLOG, md("Gamma blog", ["status_date: 2026-08-01"])],
  [LONE, md("Lone plan", ["plan_status: proposed"])],
  [EXPLAINER, "<html><body><h1>Report</h1></body></html>\n"],
];

let root = "";

function app(): Hono {
  const a = new Hono();
  // A short lock wait keeps the `locked` case (which no test drives today) from
  // costing two seconds if one is ever added.
  registerWikiSeriesRoutes(a, { lockWaitMs: 50 });
  return a;
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  app().request("/api/wiki/series", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

async function read(rel: string): Promise<string> {
  return readFile(path.join(root, rel), "utf8");
}

async function hashOf(rel: string): Promise<string> {
  return sha256(await read(rel));
}

/** The page, as a set of frontmatter lines — what the assertions are about. */
async function fence(rel: string): Promise<string[]> {
  const text = await read(rel);
  const lines = text.split("\n");
  const close = lines.indexOf("---", 1);
  return lines.slice(1, close === -1 ? 1 : close);
}

async function seed(): Promise<void> {
  for (const [rel, body] of PAGES) {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), body, "utf8");
  }
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-series-route-"));
  await seed();
  __setWikiRegistryForTest([{ name: "w", root, source: "extra" }]);
});

afterEach(async () => {
  __setWikiReadonlyForTest(undefined);
  __setReadonlyWikiRootsForTest(undefined);
  await seed();
  __resetWikiCacheForTest();
});

afterAll(async () => {
  __resetWikiRegistryForTest();
  __resetWikiCacheForTest();
  __setWikiReadonlyForTest(undefined);
  __setReadonlyWikiRootsForTest(undefined);
  await rm(root, { recursive: true, force: true });
});

describe("the body contract", () => {
  test("415s anything but application/json", async () => {
    const res = await post({ wiki: "w", relPath: LONE, baseHash: "x", series: "prov" }, {
      "content-type": "text/plain",
    });
    expect(res.status).toBe(415);
  });

  test("403s a cross-site POST", async () => {
    const res = await post(
      { wiki: "w", relPath: LONE, baseHash: "x", series: "prov" },
      { "sec-fetch-site": "cross-site" },
    );
    expect(res.status).toBe(403);
  });

  test("400s a missing relPath, a missing baseHash and a missing series key", async () => {
    for (const body of [
      { wiki: "w", baseHash: "x", series: "prov" },
      { wiki: "w", relPath: LONE, series: "prov" },
      { wiki: "w", relPath: LONE, baseHash: "x" },
    ]) {
      expect((await post(body)).status).toBe(400);
    }
  });

  test("400s a blank series and a non-string one — `null` is the only clear", async () => {
    for (const series of ["   ", 3, {}]) {
      const res = await post({ wiki: "w", relPath: LONE, baseHash: "x", series });
      expect(res.status).toBe(400);
    }
  });

  test("400s an over-long value", async () => {
    const res = await post({
      wiki: "w",
      relPath: LONE,
      baseHash: "x",
      series: "a".repeat(201),
    });
    expect(res.status).toBe(400);
  });

  test("404s an unknown wiki and an unknown page", async () => {
    expect(
      (await post({ wiki: "nope", relPath: LONE, baseHash: "x", series: "prov" })).status,
    ).toBe(404);
    expect(
      (await post({ wiki: "w", relPath: "plans/ghost.mdx", baseHash: "x", series: "prov" }))
        .status,
    ).toBe(404);
  });

  test("400s an html page — a series member is a markdown page", async () => {
    const res = await post({
      wiki: "w",
      relPath: EXPLAINER,
      baseHash: await hashOf(EXPLAINER),
      series: "prov",
    });
    expect(res.status).toBe(400);
    expect(await read(EXPLAINER)).not.toContain("series");
  });
});

describe("the write", () => {
  test("adds exactly one `series:` line and leaves every other byte alone", async () => {
    const before = await read(LONE);
    const res = await post({
      wiki: "w",
      relPath: LONE,
      baseHash: sha256(before),
      series: "prov",
    });
    expect(res.status).toBe(200);
    const after = await read(LONE);
    const added = after.split("\n").filter((l) => !before.split("\n").includes(l));
    expect(added).toEqual(["series: prov"]);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ relPath: LONE, written: true, series: "prov" });
    // The 200's hash is the hash of what is ON DISK.
    expect(body.hash).toBe(sha256(after));
  });

  test("normalizes a new key to an existing member's SPELLING", async () => {
    // The wiki holds `prov` and `Prov`; `PROV` folds onto whichever the head
    // carries, and the rail would otherwise fold the page in while the lint
    // gained a third variant nobody chose.
    const res = await post({
      wiki: "w",
      relPath: LONE,
      baseHash: await hashOf(LONE),
      series: "PROV",
    });
    expect(res.status).toBe(200);
    const written = (await fence(LONE)).find((l) => l.startsWith("series:")) ?? "";
    expect(["series: prov", "series: Prov"]).toContain(written);
    expect(written).not.toBe("series: PROV");
  });

  test("sets both lines in one write", async () => {
    const res = await post({
      wiki: "w",
      relPath: LONE,
      baseHash: await hashOf(LONE),
      series: "fresh",
      seriesLabel: "Fresh work",
    });
    expect(res.status).toBe(200);
    expect(await fence(LONE)).toContain("series: fresh");
    expect(await fence(LONE)).toContain("series_label: Fresh work");
    expect(await res.json()).toMatchObject({ series: "fresh", seriesLabel: "Fresh work" });
  });

  test("clearing the key clears the label with it", async () => {
    const res = await post({
      wiki: "w",
      relPath: PLAN,
      baseHash: await hashOf(PLAN),
      series: null,
    });
    expect(res.status).toBe(200);
    const lines = await fence(PLAN);
    expect(lines.some((l) => l.startsWith("series:"))).toBe(false);
    expect(lines.some((l) => l.startsWith("series_label:"))).toBe(false);
    // Everything else survives.
    expect(lines).toContain("plan_status: in-flight");
    expect(await res.json()).toMatchObject({ series: null, seriesLabel: null });
  });

  test("an omitted seriesLabel leaves the line alone; null removes it", async () => {
    const keep = await post({
      wiki: "w",
      relPath: PLAN,
      baseHash: await hashOf(PLAN),
      series: "other",
    });
    expect(keep.status).toBe(200);
    expect(await fence(PLAN)).toContain("series_label: Wiki provenance");

    const drop = await post({
      wiki: "w",
      relPath: PLAN,
      baseHash: await hashOf(PLAN),
      series: "other",
      seriesLabel: null,
    });
    expect(drop.status).toBe(200);
    expect((await fence(PLAN)).some((l) => l.startsWith("series_label:"))).toBe(false);
    expect(await fence(PLAN)).toContain("series: other");
  });

  test("re-setting the same key is an honest noop: 200, written false, same hash", async () => {
    const base = await hashOf(PLAN);
    const res = await post({ wiki: "w", relPath: PLAN, baseHash: base, series: "prov" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ written: false, hash: base, series: "prov" });
    expect(await hashOf(PLAN)).toBe(base);
  });

  test("409s a stale baseHash and writes nothing", async () => {
    const before = await read(LONE);
    const res = await post({
      wiki: "w",
      relPath: LONE,
      baseHash: sha256("something else"),
      series: "prov",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ stale: true });
    expect(await read(LONE)).toBe(before);
  });

  test("422s a page with no frontmatter fence", async () => {
    const rel = "plans/fenceless.md";
    await writeFile(path.join(root, rel), "# No fence here\n", "utf8");
    __resetWikiCacheForTest();
    const res = await post({
      wiki: "w",
      relPath: rel,
      baseHash: sha256("# No fence here\n"),
      series: "prov",
    });
    expect(res.status).toBe(422);
    expect(await read(rel)).toBe("# No fence here\n");
    await rm(path.join(root, rel), { force: true });
    __resetWikiCacheForTest();
  });

  test("422s a key whose current value is a LIST", async () => {
    const rel = "plans/listy.md";
    const body = ["---", "title: Listy", "series:", "  - one", "  - two", "---", "", "Body.", ""].join("\n");
    await writeFile(path.join(root, rel), body, "utf8");
    __resetWikiCacheForTest();
    const res = await post({ wiki: "w", relPath: rel, baseHash: sha256(body), series: "prov" });
    expect(res.status).toBe(422);
    expect(await read(rel)).toBe(body);
    await rm(path.join(root, rel), { force: true });
    __resetWikiCacheForTest();
  });
});

describe("read-only", () => {
  test("403s on a read-only INSTANCE, before the file is opened", async () => {
    const before = await read(LONE);
    __setWikiReadonlyForTest(true);
    const res = await post({
      wiki: "w",
      relPath: LONE,
      baseHash: sha256(before),
      series: "prov",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ readonly: true });
    expect(await read(LONE)).toBe(before);
  });

  test("403s on a read-only ROOT, with the instance writable", async () => {
    const before = await read(LONE);
    __setWikiReadonlyForTest(false);
    __setReadonlyWikiRootsForTest([root]);
    const res = await post({
      wiki: "w",
      relPath: LONE,
      baseHash: sha256(before),
      series: "prov",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ readonly: true });
    expect(await read(LONE)).toBe(before);
  });
});

describe("the head move, as the two calls it is", () => {
  test("clearing the old head then setting the new one moves the label", async () => {
    const clear = await post({
      wiki: "w",
      relPath: PLAN,
      baseHash: await hashOf(PLAN),
      series: "prov",
      seriesLabel: null,
    });
    expect(clear.status).toBe(200);
    // Between the two calls the series is label-less — the state the lint's 8.3
    // reports, and the reason the clear runs FIRST.
    expect((await fence(PLAN)).some((l) => l.startsWith("series_label:"))).toBe(false);
    expect((await fence(SHIPPED)).some((l) => l.startsWith("series_label:"))).toBe(false);

    const set = await post({
      wiki: "w",
      relPath: SHIPPED,
      baseHash: await hashOf(SHIPPED),
      series: "Prov",
      seriesLabel: "Wiki provenance",
    });
    expect(set.status).toBe(200);
    expect(await fence(SHIPPED)).toContain("series_label: Wiki provenance");
    // `Prov` was posted and `prov` is what landed: the normalization heals the
    // page's own case variant on any write that touches its `series:` line, so
    // an edit of a variant member retires the lint's 8.3(b) finding rather than
    // preserving it. The store still reports whatever a HAND edit leaves.
    expect(await fence(SHIPPED)).toContain("series: prov");
    expect(await fence(PLAN)).toContain("series: prov");
  });
});
