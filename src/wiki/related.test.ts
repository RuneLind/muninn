/**
 * `computeRelated` — the three sources, the two cuts, the order and the
 * never-transitive rule.
 *
 * Driven against a REAL `buildWikiIndex` over a temp wiki rather than a
 * hand-built index: the rule reads `outgoing`, `backlinks` and `prRefs`, and all
 * three are things the index BUILDS — a fixture that fills them by hand would
 * pass while the wiring that produces them is broken.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildWikiIndex, type WikiIndex } from "./store.ts";
import {
  computeRelated,
  RELATED_DIGEST_PRS,
  RELATED_HUB_BACKLINKS,
  RELATED_SHARED_PRS_MIN,
} from "./related.ts";

/** A plan page: frontmatter lines, then the body. */
function page(title: string, fm: string[], body: string): string {
  return ["---", `title: ${title}`, ...fm, "---", "", body, ""].join("\n");
}

/** `relPath → why`, which is the whole decision this module makes. */
function whyByPath(index: WikiIndex, relPath: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of computeRelated(index, relPath)) out[r.relPath] = r.why;
  return out;
}

const OPEN = "plans/open.md";

/**
 * ONE wiki holding every source and every cut at once:
 *
 *  - `open` — the page under test. Declares `muninn#549` in `prs:` and names
 *    `muninn#550` in its body as a pull URL; links to `cited` and `both`.
 *  - `citer` — links to `open` (source 1).
 *  - `cited` — linked FROM `open` (source 2).
 *  - `both` — both, AND shares two PR refs (three reasons on one row).
 *  - `sharer` — shares both refs and links neither way (source 3).
 *  - `onepr` — shares ONE ref: under `RELATED_SHARED_PRS_MIN`, so not related.
 *  - `digest` — names 16 refs including both of `open`'s: cut from source 3.
 *  - `far` — linked from `cited` only: the transitive case.
 *  - `index.md` — bookkeeping, links to `open`.
 *  - `hub` — links to `open` and is linked from N fillers (written per test).
 */
const PAGES: Array<[string, string]> = [
  [
    OPEN,
    page(
      "Open",
      ["prs: [RuneLind/muninn#549]", "plan_status: in-flight", "status_date: 2026-09-20"],
      "Body links [[cited]] and [[both]], and names https://github.com/RuneLind/muninn/pull/550.",
    ),
  ],
  ["plans/citer.md", page("Citer", ["status_date: 2026-09-10"], "Reads [[open]].")],
  ["plans/cited.md", page("Cited", ["status_date: 2026-09-08"], "Links [[far]].")],
  [
    "plans/both.md",
    page(
      "Both",
      ["status_date: 2026-09-12"],
      "Cites [[open]] and names muninn #549 plus claude-usage#1 and muninn#550.",
    ),
  ],
  [
    "plans/sharer.md",
    page("Sharer", ["status_date: 2026-09-05"], "Names muninn#549 and muninn #550, links nothing."),
  ],
  ["plans/onepr.md", page("Onepr", ["status_date: 2026-09-04"], "Names muninn#549 alone.")],
  [
    "plans/digest.md",
    page(
      "Digest",
      ["status_date: 2026-09-19"],
      // 16 refs — one past RELATED_DIGEST_PRS — two of which are `open`'s.
      ["muninn#549", "muninn#550", ...Array.from({ length: 14 }, (_, i) => `huginn#${i + 1}`)].join(
        ", ",
      ),
    ),
  ],
  ["plans/far.md", page("Far", ["status_date: 2026-09-01"], "Nothing.")],
  ["index.md", page("Index", ["status_date: 2026-09-21"], "Catalog of [[open]].")],
  ["plans/hub.md", page("Hub", ["status_date: 2026-09-11"], "Everything, including [[open]].")],
];

let root = "";
/** Fillers 1..N each link to `hub` and nothing else, so `hub`'s backlink count
 *  is exactly the number of them on disk. The directory is REPLACED, not added
 *  to: a later `writeFillers(0)` must leave an earlier test's 26 behind, or the
 *  hub cut silently stays armed for the rest of the file. */
async function writeFillers(n: number): Promise<void> {
  await rm(path.join(root, "fill"), { recursive: true, force: true });
  await mkdir(path.join(root, "fill"), { recursive: true });
  for (let i = 1; i <= n; i++) {
    await writeFile(
      path.join(root, `fill/f${i}.md`),
      page(`Fill ${i}`, [], "Points at [[hub]]."),
      "utf8",
    );
  }
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "wiki-related-"));
  for (const [rel, body] of PAGES) {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), body, "utf8");
  }
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("computeRelated", () => {
  test("the three sources, with a multi-reason why on the page reached by all of them", async () => {
    await writeFillers(0);
    const why = whyByPath(await buildWikiIndex(root), OPEN);
    expect(why["plans/citer.md"]).toBe("cites this page");
    expect(why["plans/cited.md"]).toBe("cited by this page");
    expect(why["plans/sharer.md"]).toBe("shares RuneLind/muninn#549, RuneLind/muninn#550");
    // Reasons in the fixed source order, deduped, joined with ` · `.
    expect(why["plans/both.md"]).toBe(
      "cites this page · cited by this page · shares RuneLind/muninn#549, RuneLind/muninn#550",
    );
  });

  test("ONE shared PR ref is not enough", async () => {
    await writeFillers(0);
    expect(whyByPath(await buildWikiIndex(root), OPEN)["plans/onepr.md"]).toBeUndefined();
    expect(RELATED_SHARED_PRS_MIN).toBe(2);
  });

  test("NEVER transitive: a page two hops away is not related", async () => {
    await writeFillers(0);
    const index = await buildWikiIndex(root);
    // `open` → `cited` → `far` really is a path in the graph...
    expect(index.outgoing.get("plans/cited.md")).toContain("plans/far.md");
    // ...and `far` is still not a row.
    expect(whyByPath(index, OPEN)["plans/far.md"]).toBeUndefined();
  });

  test("the open page is never its own related row", async () => {
    await writeFillers(0);
    expect(whyByPath(await buildWikiIndex(root), OPEN)[OPEN]).toBeUndefined();
  });

  test("bookkeeping pages are cut whatever the link graph says", async () => {
    await writeFillers(0);
    const index = await buildWikiIndex(root);
    // It really does cite the open page, and its backlink count is far under
    // the hub threshold — the two facts that make this its own cut.
    expect(index.outgoing.get("index.md")).toContain(OPEN);
    expect((index.backlinks.get("index.md") ?? []).length).toBeLessThan(RELATED_HUB_BACKLINKS);
    expect(whyByPath(index, OPEN)["index.md"]).toBeUndefined();
  });

  test("a DIGEST is cut from the PR-sharing source only", async () => {
    await writeFillers(0);
    const index = await buildWikiIndex(root);
    // It shares both of the open page's refs...
    expect(index.resolveRelPath("plans/digest.md")!.prRefs!.length).toBe(RELATED_DIGEST_PRS + 1);
    // ...and is still not a row, because it names nothing else either.
    expect(whyByPath(index, OPEN)["plans/digest.md"]).toBeUndefined();
  });

  test("a digest that LINKS to the page still appears, with the link as its reason", async () => {
    await writeFillers(0);
    const linking = path.join(root, "plans/digest.md");
    const before = await Bun.file(linking).text();
    try {
      await writeFile(linking, before.replace("huginn#14", "huginn#14 — see [[open]]"), "utf8");
      expect(whyByPath(await buildWikiIndex(root), OPEN)["plans/digest.md"]).toBe(
        "cites this page",
      );
    } finally {
      await writeFile(linking, before, "utf8");
    }
  });

  test("the hub cut fires ABOVE the threshold, not at it", async () => {
    await writeFillers(RELATED_HUB_BACKLINKS);
    let index = await buildWikiIndex(root);
    expect((index.backlinks.get("plans/hub.md") ?? []).length).toBe(RELATED_HUB_BACKLINKS);
    expect(whyByPath(index, OPEN)["plans/hub.md"]).toBe("cites this page");

    await writeFillers(RELATED_HUB_BACKLINKS + 1);
    index = await buildWikiIndex(root);
    expect((index.backlinks.get("plans/hub.md") ?? []).length).toBe(RELATED_HUB_BACKLINKS + 1);
    expect(whyByPath(index, OPEN)["plans/hub.md"]).toBeUndefined();
  });

  test("rows come back NEWEST first", async () => {
    await writeFillers(0);
    expect(computeRelated(await buildWikiIndex(root), OPEN).map((r) => r.relPath)).toEqual([
      "plans/both.md", // 2026-09-12
      "plans/hub.md", // 2026-09-11
      "plans/citer.md", // 2026-09-10
      "plans/cited.md", // 2026-09-08
      "plans/sharer.md", // 2026-09-05
    ]);
  });

  test("an unknown relPath answers [] rather than throwing", async () => {
    await writeFillers(0);
    expect(computeRelated(await buildWikiIndex(root), "plans/nope.md")).toEqual([]);
  });

  test("a page with no neighbours answers [] — the reader renders no block", async () => {
    await writeFillers(0);
    expect(computeRelated(await buildWikiIndex(root), "plans/far.md").map((r) => r.relPath)).toEqual(
      ["plans/cited.md"],
    );
    expect(computeRelated(await buildWikiIndex(root), "plans/onepr.md")).toEqual([]);
  });

  test("a DIGEST open page pairs with nobody on PR refs — the cut is symmetric", async () => {
    await writeFillers(0);
    // `sharer` shares two of the digest's refs, so a candidate-only cut would
    // pair them. The inference "≥2 shared refs means one piece of work" is as
    // false in this direction as in the other.
    const index = await buildWikiIndex(root);
    expect(index.resolveRelPath("plans/sharer.md")!.prRefs).toEqual([
      "RuneLind/muninn#549",
      "RuneLind/muninn#550",
    ]);
    expect(computeRelated(index, "plans/digest.md")).toEqual([]);
  });
});
