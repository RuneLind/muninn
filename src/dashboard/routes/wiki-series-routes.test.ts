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
import { registerWikiSeriesRoutes, type WikiSeriesRouteDeps } from "./wiki-series-routes.ts";
import { WIKI_LOCK_BASENAME } from "../../wiki/lockfile.ts";

const PLAN = "plans/alpha.mdx";
const SHIPPED = "plans/beta.mdx";
const BLOG = "blogs/gamma.mdx";
const LONE = "plans/lone.mdx";
const EXPLAINER = "blogs/report.html";
/** The wiki's own bookkeeping pages — markdown, and never series members. */
const META_PAGES = ["index.md", "log.md", "CLAUDE.md", "plans/index.md"];

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
  ...META_PAGES.map((rel): [string, string] => [rel, md(`Meta ${rel}`)]),
];

let root = "";

function app(deps: WikiSeriesRouteDeps = {}): Hono {
  const a = new Hono();
  // A short lock wait keeps the `locked` case in milliseconds rather than the
  // two seconds a human click would wait.
  registerWikiSeriesRoutes(a, { lockWaitMs: 50, ...deps });
  return a;
}

const post = (
  body: unknown,
  headers: Record<string, string> = {},
  deps: WikiSeriesRouteDeps = {},
) =>
  app(deps).request("/api/wiki/series", {
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

  test("400s the wiki's own bookkeeping pages, before the writer can 500", async () => {
    // `writeWikiPage`'s confinement refuses these too, but as an `error` ⇒ 500
    // plus a `log.error` — measured. They are markdown, so only the reserved
    // BASENAME rule tells them from a page: the same rule that keeps the opener
    // off their rows.
    for (const rel of META_PAGES) {
      const before = await read(rel);
      const res = await post({
        wiki: "w",
        relPath: rel,
        baseHash: sha256(before),
        series: "prov",
      });
      expect([rel, res.status]).toEqual([rel, 400]);
      expect([rel, await read(rel)]).toEqual([rel, before]);
    }
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

  test("an omitted seriesLabel leaves the line alone WITHIN the same series", async () => {
    const res = await post({
      wiki: "w",
      relPath: PLAN,
      baseHash: await hashOf(PLAN),
      series: "prov",
    });
    expect(res.status).toBe(200);
    expect(await fence(PLAN)).toContain("series_label: Wiki provenance");
    expect(await res.json()).toMatchObject({ seriesLabel: "Wiki provenance" });
  });

  test("an explicit null removes the label and keeps the key", async () => {
    const res = await post({
      wiki: "w",
      relPath: PLAN,
      baseHash: await hashOf(PLAN),
      series: "other",
      seriesLabel: null,
    });
    expect(res.status).toBe(200);
    expect((await fence(PLAN)).some((l) => l.startsWith("series_label:"))).toBe(false);
    expect(await fence(PLAN)).toContain("series: other");
    // An explicit clear is the caller's own decision, so nothing is reported
    // back about it — `clearedLabel` is for the label this route took off by
    // itself.
    expect(await res.json()).not.toHaveProperty("clearedLabel");
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

describe("what the 200 reports, and the two races the write can lose", () => {
  test("reports the FILE, not the wiki index the request opened with", async () => {
    // Warm the index (any request that resolves a page builds it), then move the
    // page's frontmatter behind it — a hand edit, another muninn, a `git pull`.
    // The index is a 5-minute TTL cache, so a body echoing `meta.series`
    // reported the value from before that edit; the CAS meanwhile proves the
    // caller is holding the CURRENT bytes, which is the only thing this route
    // can honestly report.
    await post({ wiki: "w", relPath: LONE, baseHash: "x", series: "prov" });
    const edited = md("Alpha plan", [
      "series: renamed",
      "series_label: Renamed by hand",
      "plan_status: in-flight",
    ]);
    await writeFile(path.join(root, PLAN), edited, "utf8");

    const res = await post({
      wiki: "w",
      relPath: PLAN,
      baseHash: sha256(edited),
      series: "renamed",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      written: false,
      series: "renamed",
      seriesLabel: "Renamed by hand",
    });
  });

  test("reports the bytes the CAS proved, even when the index cannot have seen them", async () => {
    // The same fact isolated from the index refresh: the write reads a file
    // whose series the index (fresh, built this request) does not carry, which
    // is the race the byte-read defends. The body must describe the file.
    const raced = md("Lone plan", ["series: prov", "series_label: From the race"]);
    const res = await post(
      { wiki: "w", relPath: LONE, baseHash: sha256(raced), series: "prov" },
      {},
      { readFile: async () => raced },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      written: false,
      series: "prov",
      seriesLabel: "From the race",
    });
  });

  test("normalizes against the wiki as it is NOW, not as the TTL cache remembers it", async () => {
    // The key's spelling is a decision made off the index, and the index behind
    // `/api/wiki/pages` is a 5-minute cache. Warm it, move a member's key on
    // disk, and the next join must fold onto the spelling that is really there —
    // otherwise the editor mints the very case variant the fold exists to avoid.
    await post({ wiki: "w", relPath: LONE, baseHash: "x", series: "prov" });
    const moved = md("Beta plan", ["series: Zeta", "plan_status: shipped"]);
    await writeFile(path.join(root, SHIPPED), moved, "utf8");

    const res = await post({
      wiki: "w",
      relPath: LONE,
      baseHash: await hashOf(LONE),
      series: "ZETA",
    });
    expect(res.status).toBe(200);
    expect(await fence(LONE)).toContain("series: Zeta");
  });

  test("a target that VANISHED between the index read and the write is a 404, not a 409", async () => {
    // Both are `stale` to `writeWikiPage`, and the recoveries are opposite: 409
    // says reload and retry, which on a page that no longer exists is a loop.
    const res = await post(
      { wiki: "w", relPath: LONE, baseHash: await hashOf(LONE), series: "prov" },
      {},
      { readFile: async () => null },
    );
    expect(res.status).toBe(404);
    expect(await read(LONE)).not.toContain("series:");
  });

  test("a target that CHANGED between the index read and the write is still a 409", async () => {
    const res = await post(
      { wiki: "w", relPath: LONE, baseHash: await hashOf(LONE), series: "prov" },
      {},
      { readFile: async () => "---\ntitle: Moved on\n---\n\nBody.\n" },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ stale: true });
  });

  test("409s while another process holds the wiki's write lock", async () => {
    // The cross-process lockfile claude-usage's `wiki-stamp` is the other holder
    // of. Nothing is written, and the recovery is a retry — hence 409 beside
    // `stale` rather than a 5xx.
    const lock = path.join(root, WIKI_LOCK_BASENAME);
    await writeFile(lock, `${JSON.stringify({ pid: process.pid, op: "test" })}\n`, "utf8");
    try {
      const before = await read(LONE);
      const res = await post({
        wiki: "w",
        relPath: LONE,
        baseHash: sha256(before),
        series: "prov",
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ locked: true });
      expect(await read(LONE)).toBe(before);
    } finally {
      await rm(lock, { force: true });
    }
  });
});

describe("one labelled member per series", () => {
  test("409s a label on a series another member already names", async () => {
    // The rail reads the label off a MEMBER and silently picks one when two
    // carry it, so a second `series_label:` is an invisible fork of what the
    // series is called.
    const before = await read(SHIPPED);
    const res = await post({
      wiki: "w",
      relPath: SHIPPED,
      baseHash: sha256(before),
      series: "prov",
      seriesLabel: "A second name",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ twoHeaded: true, headRelPath: PLAN });
    expect(await read(SHIPPED)).toBe(before);
  });

  test("the editor's own head move is unaffected — the old head is cleared first", async () => {
    const clear = await post({
      wiki: "w",
      relPath: PLAN,
      baseHash: await hashOf(PLAN),
      series: "prov",
      seriesLabel: null,
    });
    expect(clear.status).toBe(200);
    const set = await post({
      wiki: "w",
      relPath: SHIPPED,
      baseHash: await hashOf(SHIPPED),
      series: "prov",
      seriesLabel: "Wiki provenance",
    });
    expect(set.status).toBe(200);
    expect(await fence(SHIPPED)).toContain("series_label: Wiki provenance");
  });

  test("renaming the label on the page that already carries it is not a fork", async () => {
    const res = await post({
      wiki: "w",
      relPath: PLAN,
      baseHash: await hashOf(PLAN),
      series: "prov",
      seriesLabel: "Renamed",
    });
    expect(res.status).toBe(200);
    expect(await fence(PLAN)).toContain("series_label: Renamed");
  });

  test("finds the other head through the FOLD, not the spelling", async () => {
    // The rail folds `cases` and `Cases` into one series, so the labelled member
    // this must find is exactly the one spelling the key the other way. The two
    // fixture pages are named so the SORTED index hands `normalizeSeriesKey` the
    // lower-case spelling first — the write's key is then `cases` while the head
    // on disk says `Cases`, which a spelling compare misses.
    const lower = "plans/case-a.mdx";
    const upper = "plans/case-z.mdx";
    await writeFile(path.join(root, lower), md("Case A", ["series: cases"]), "utf8");
    await writeFile(
      path.join(root, upper),
      md("Case Z", ["series: Cases", "series_label: Case series"]),
      "utf8",
    );
    try {
      const before = await read(LONE);
      const res = await post({
        wiki: "w",
        relPath: LONE,
        baseHash: sha256(before),
        series: "CASES",
        seriesLabel: "A second name",
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ twoHeaded: true, headRelPath: upper });
      expect(await read(LONE)).toBe(before);
    } finally {
      await rm(path.join(root, lower), { force: true });
      await rm(path.join(root, upper), { force: true });
      __resetWikiCacheForTest();
    }
  });
});

/**
 * A label belongs to a SERIES — the fix round 2 defect.
 *
 * The menu's join and new-key verbs send `{relPath, series}` and no
 * `seriesLabel`, so a page that was the HEAD of the series it is leaving used to
 * carry that name into the series it joins: two labelled members there, the
 * series it left silently un-named, and a 200 reporting the fork as success.
 *
 * The four cases below are {the request carries a label, it omits one} × {the
 * target series already has a labelled member, it has none}, all of them on a
 * page that is MOVING — which is the only shape where the request's label and
 * the one on disk can disagree.
 */
describe("moving to another series", () => {
  /** The target: a series whose head is somebody else. Written per test rather
   *  than seeded, so the shared fixture keeps its single series. */
  const TARGET = "plans/target.mdx";

  async function withTarget(labelled: boolean, run: () => Promise<void>): Promise<void> {
    await writeFile(
      path.join(root, TARGET),
      md("Target plan", ["series: tgt", ...(labelled ? ["series_label: Target series"] : [])]),
      "utf8",
    );
    try {
      await run();
    } finally {
      await rm(path.join(root, TARGET), { force: true });
      __resetWikiCacheForTest();
    }
  }

  test("an omitted label is CLEARED, and the 200 names the series left behind", async () => {
    await withTarget(false, async () => {
      const res = await post({
        wiki: "w",
        relPath: PLAN,
        baseHash: await hashOf(PLAN),
        series: "tgt",
      });
      expect(res.status).toBe(200);
      const lines = await fence(PLAN);
      expect(lines).toContain("series: tgt");
      expect(lines.some((l) => l.startsWith("series_label:"))).toBe(false);
      expect(await res.json()).toMatchObject({
        series: "tgt",
        seriesLabel: null,
        clearedLabel: { series: "prov", label: "Wiki provenance" },
      });
      // The series it left is label-less now and renders under its bare key; the
      // lint reports no finding for that state (measured: 8.3 stays at 0), so the
      // note on the 200 is the only thing that tells the reader.
      expect((await fence(SHIPPED)).some((l) => l.startsWith("series_label:"))).toBe(false);
    });
  });

  test("an omitted label is cleared even where the target already has a head", async () => {
    // The two-headed refusal must not fire here: the label is gone by the time
    // the write lands, so there is no fork to refuse — and refusing would leave
    // the reader unable to move a page into a named series at all.
    await withTarget(true, async () => {
      const res = await post({
        wiki: "w",
        relPath: PLAN,
        baseHash: await hashOf(PLAN),
        series: "tgt",
      });
      expect(res.status).toBe(200);
      const lines = await fence(PLAN);
      expect(lines).toContain("series: tgt");
      expect(lines.some((l) => l.startsWith("series_label:"))).toBe(false);
      // The target's own head is untouched — one labelled member, still.
      expect(await fence(TARGET)).toContain("series_label: Target series");
    });
  });

  test("a label the request CARRIES is written, when nothing else names the target", async () => {
    await withTarget(false, async () => {
      const res = await post({
        wiki: "w",
        relPath: PLAN,
        baseHash: await hashOf(PLAN),
        series: "tgt",
        seriesLabel: "Renamed on arrival",
      });
      expect(res.status).toBe(200);
      expect(await fence(PLAN)).toContain("series_label: Renamed on arrival");
      expect(await res.json()).not.toHaveProperty("clearedLabel");
    });
  });

  test("a label the request carries is a 409 when the target already has a head", async () => {
    await withTarget(true, async () => {
      const before = await read(PLAN);
      const res = await post({
        wiki: "w",
        relPath: PLAN,
        baseHash: sha256(before),
        series: "tgt",
        seriesLabel: "A second name",
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ twoHeaded: true, headRelPath: TARGET });
      expect(await read(PLAN)).toBe(before);
    });
  });

  test("a label IDENTICAL to the page's own is still a 409 when the target already has a head", async () => {
    // Rule 4's `|| foldChanged` clause. The page carries `series_label: Wiki
    // provenance` already, so a request naming that same label changes no
    // label line — and a guard that read only the label would wave it through,
    // landing a second head on the target. The MOVE is what creates the fork.
    await withTarget(true, async () => {
      const before = await read(PLAN);
      const res = await post({
        wiki: "w",
        relPath: PLAN,
        baseHash: sha256(before),
        series: "tgt",
        seriesLabel: "Wiki provenance",
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ twoHeaded: true, headRelPath: TARGET });
      expect(await read(PLAN)).toBe(before);
      expect(await fence(TARGET)).toContain("series_label: Target series");
    });
  });

  test("an orphan label on a page in NO series is cleared with no report", async () => {
    // A `series_label:` with no `series:` names nothing (no lint check reports
    // it either), so there is no series to tell the reader has lost its name.
    const rel = "plans/orphan.mdx";
    await writeFile(path.join(root, rel), md("Orphan", ["series_label: Names nothing"]), "utf8");
    try {
      const res = await post({
        wiki: "w",
        relPath: rel,
        baseHash: sha256(await read(rel)),
        series: "fresh",
      });
      expect(res.status).toBe(200);
      expect((await fence(rel)).some((l) => l.startsWith("series_label:"))).toBe(false);
      expect(await res.json()).not.toHaveProperty("clearedLabel");
    } finally {
      await rm(path.join(root, rel), { force: true });
      __resetWikiCacheForTest();
    }
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
    // Between the two calls the series is label-less: it renders under its bare
    // key and the lint reports nothing for it, which is why the clear runs FIRST
    // rather than leaving two labelled heads (8.3(b)) mid-sequence.
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
    // an edit of a variant member retires the lint's 8.3(a) finding rather than
    // preserving it. The store still reports whatever a HAND edit leaves.
    expect(await fence(SHIPPED)).toContain("series: prov");
    expect(await fence(PLAN)).toContain("series: prov");
  });

  test("the label lands beside the key, so the round trip re-orders nothing", async () => {
    // The two lines are one fact. Inserted at the fence's end instead, the label
    // left the pair on the old head and came back at the bottom of the new
    // head's frontmatter — a diff nobody asked for on every head move.
    const planBefore = await fence(PLAN);
    const set = await post({
      wiki: "w",
      relPath: SHIPPED,
      baseHash: await hashOf(SHIPPED),
      series: "prov",
      seriesLabel: null,
    });
    expect(set.status).toBe(200);
    const move = await post({
      wiki: "w",
      relPath: SHIPPED,
      baseHash: await hashOf(SHIPPED),
      series: "prov",
      seriesLabel: "Wiki provenance",
    });
    // The other member still carries the label, so this one is refused — clear
    // it the way the editor does, then move it.
    expect(move.status).toBe(409);
    await post({
      wiki: "w",
      relPath: PLAN,
      baseHash: await hashOf(PLAN),
      series: "prov",
      seriesLabel: null,
    });
    const moved = await post({
      wiki: "w",
      relPath: SHIPPED,
      baseHash: await hashOf(SHIPPED),
      series: "prov",
      seriesLabel: "Wiki provenance",
    });
    expect(moved.status).toBe(200);
    const lines = await fence(SHIPPED);
    expect(lines.indexOf("series_label: Wiki provenance")).toBe(
      lines.findIndex((l) => l.startsWith("series:")) + 1,
    );
    // And the old head kept its own order, minus the line that left.
    expect(await fence(PLAN)).toEqual(planBefore.filter((l) => !l.startsWith("series_label:")));
  });
});
